# Phase 2-1 Hotfix2：优化 `_isAccountAvailable` 和 `validateApiKey` 路径

## Context

Hotfix1 优化了绑定账户路径和 relay 服务的冗余调用，但粘性会话验证路径 `_isAccountAvailable` 仍有大量冗余 Redis 调用。从日志看，错误仍在 `getValidAccessToken` → `setClaudeAccount` 处触发，说明到达 relay 服务时子请求预算已接近耗尽。

### 实际子请求消耗分析（绑定账户 + 粘性会话命中）

**Auth 中间件（5-9 个子请求）：**
1. `findApiKeyByHash` = 2（hget + hgetall）
2. `getUserById`（如有 userId）= 1
3. `getDailyCost`（如有 dailyCostLimit）= 1
4. `getCostStats`（如有 totalCostLimit）= 1（pipeline）
5. `getWeeklyOpusCost`（如有 weeklyOpusCostLimit）= 1
6. `incrConcurrency` = 1
7. Rate limit pipeline read = 1
8. Rate limit pipeline write（如需重置）= 0-1
9. Rate limit incr = 1

**调度器 — 绑定账户路径（行 259-287，已优化）：**
- 如果 `claudeAccountId` 存在且账户可用：`getClaudeAccount`(1) + `isAccountTemporarilyUnavailable`(1) + `isAccountRateLimited`(0, 传入数据) = 2 个子请求
- 然后返回，不走粘性会话路径

**调度器 — 粘性会话路径（行 386-407，未优化！）：**
- 如果没有绑定账户，走粘性会话：
10. `_getSessionMapping` = 1
11. `_isAccountAvailable` → `getClaudeAccount` = 1
12. `_isAccountAvailable` → `isAccountTemporarilyUnavailable` = 1
13. `_isAccountAvailable` → `isAccountRateLimited`（**重新获取！**）= 1
14. `_isAccountAvailable` → `isAccountOverloaded` = 1
15. `_isAccountAvailable` → `isAccountOpusRateLimited`（如 Opus，**重新获取！**）= 0-1
16. `_extendSessionMappingTTL` = 1-2

**api.js warmup + relay：**
17. `getAccount` = 1
18. `setClaudeAccount`（getValidAccessToken 写入）= 1
19. 上游 API 调用 = 1

**总计：~18-26 个子请求**

对于免费版 50 限制来说，18-26 看起来够用，但如果 API Key 配置了多个费用限制（dailyCost + totalCost + weeklyOpusCost），auth 阶段就是 9 个，加上粘性会话的 6-8 个，很容易到 20+。再加上排队轮询（每次 2 个），很快就超限。

## 修改方案

### 变更 A：`_isAccountAvailable` 传入已获取的 account 数据

**文件**：[unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js)，行 1019

`_isAccountAvailable` 内部先 `getClaudeAccount` 获取数据，然后调用 `isAccountRateLimited`、`isAccountOverloaded`、`isAccountOpusRateLimited` 时又各自重新获取。

**方案**：将已获取的 `account` 传入各 check 方法。

```javascript
// Official 路径（行 1021-1073）
async _isAccountAvailable(accountId, accountType, requestedModel = null) {
  if (accountType === 'claude-official') {
    const account = await redis.getClaudeAccount(accountId)
    // ... 基础检查不变 ...

    if (await this.isAccountTemporarilyUnavailable(accountId, 'claude-official')) {
      return false
    }

    // 传入 account 数据（行 1055-1056）
    const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId, account)
    const isOverloaded = await claudeAccountService.isAccountOverloaded(accountId)  // 这个用独立 key，不需要 account
    if (isRateLimited || isOverloaded) {
      return false
    }

    if (requestedModel?.toLowerCase().includes('opus')) {
      // 传入 account 数据（行 1066）
      const isOpusRateLimited = await claudeAccountService.isAccountOpusRateLimited(accountId, account)
      if (isOpusRateLimited) return false
    }
    return true
  }
```

注意：`claudeAccountService.isAccountOverloaded` 使用独立的 `account:overload:${accountId}` key（不是 account hash），所以不需要传入 account 数据。

**Console 路径（行 1074-1150）**：
```javascript
  } else if (accountType === 'claude-console') {
    const account = await claudeConsoleAccountService.getAccount(accountId)
    // ... 基础检查不变 ...

    // Workers 模式下跳过 checkQuotaUsage（与 _getAllAvailableAccounts 一致）
    if (process.env.WORKER_MODE !== 'true') {
      try {
        await claudeConsoleAccountService.checkQuotaUsage(accountId)
      } catch (e) {
        logger.warn(`Failed to check quota: ${e.message}`)
      }
    }

    if (await this.isAccountTemporarilyUnavailable(accountId, 'claude-console')) {
      return false
    }

    // 传入 account 数据（行 1124-1127）
    if (await claudeConsoleAccountService.isAccountRateLimited(accountId, account)) {
      return false
    }
    if (await claudeConsoleAccountService.isAccountQuotaExceeded(accountId, account)) {
      return false
    }
    // 传入 account 数据（行 1135）
    if (await claudeConsoleAccountService.isAccountOverloaded(accountId, account)) {
      return false
    }
    // ... 并发检查不变 ...
  }
```

**节省**：Official 路径 2-3 个子请求，Console 路径 3-5 个子请求

### 变更 B：`claudeAccountService.isAccountOverloaded` 添加可选参数

**文件**：[claudeAccountService.js](src/services/account/claudeAccountService.js)，行 3051

当前 `isAccountOverloaded` 使用独立 key `account:overload:${accountId}`（不是 account hash），所以传入 account 数据不能省掉这个 Redis 调用。**不需要修改**。

### 变更 C：`validateApiKey` 中的费用查询 pipeline 化

**文件**：[apiKeyService.js](src/services/apiKeyService.js)，行 436-450

当前 `getDailyCost`、`getCostStats`、`getWeeklyOpusCost` 用 `Promise.all` 并行执行，但每个都是独立 HTTP 请求。可以合并为一个 pipeline。

但这需要在 redis-upstash.js 中添加新的批量方法，改动较大。**暂不修改**，作为后续优化。

### 变更 D：`findApiKeyByHash` 优化

**文件**：[redis-upstash.js](src/models/redis-upstash.js)，行 445

当前 `findApiKeyByHash` 先 hget 查 hash_map，找到 keyId 后再 hgetall 获取完整数据 = 2 个子请求。可以用 pipeline 合并为 1 个，但需要知道 keyId 才能构造第二个命令，所以无法 pipeline。**无法优化**。

### 变更 E：`_isAccountAvailable` Console 路径 Workers 模式跳过 `checkQuotaUsage`

**文件**：[unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js)，行 1111-1116

与 `_getAllAvailableAccounts` 中的优化一致，Workers 模式下跳过 `checkQuotaUsage`（节省 2 个子请求/Console 账户）。

## 实施文件

- [unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js) — `_isAccountAvailable` 传入数据 + Workers 跳过 checkQuotaUsage
- 不需要修改其他文件（所有 check 方法的可选参数已在 hotfix1 中添加）

## 优化后预算

| 路径 | 优化前 | 优化后 |
|------|--------|--------|
| `_isAccountAvailable` Official | 4-5 | **2** (getClaudeAccount + isAccountTemporarilyUnavailable) |
| `_isAccountAvailable` Console | 6-8 | **2-3** (getAccount + isAccountTemporarilyUnavailable + 并发检查) |
| 总请求（绑定+粘性+Official） | ~18-26 | **~14-20** |

## 验证

1. `npx prettier --write` + `npm run lint` + `npm test`
2. 部署后监控日志确认 subrequest 错误消除
