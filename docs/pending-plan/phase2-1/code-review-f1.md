### 来源

合并自 [code-review-1.md](code-review-1.md)、[code-review-2.md](code-review-2.md)、[code-review-3.md](code-review-3.md) 中对当前代码仍然有效的问题。已根据现状剔除的项目见末尾"已解决/不再适用"。

---

## 一、待处理 / 建议修复

### 🟡 P2-A：Console `_isAccountAvailable` 中 `checkQuotaUsage` 后未刷新 account 快照

来源：code-review-3 P2。当前代码仍存在（`src/services/scheduler/unifiedClaudeScheduler.js:1114-1136`）。

非 Workers 模式下：
```
checkQuotaUsage(accountId)            // 可能写入 status=quota_exceeded、quotaStoppedAt
isAccountQuotaExceeded(accountId, account)   // account 为调用前快照，最新字段缺失
```

刚被 `checkQuotaUsage` 标记为 quota_exceeded 的账户，本轮判断仍可能返回 false。

**建议**：非 Workers 路径下，`checkQuotaUsage` 之后重新 `getAccount`，或让 `checkQuotaUsage` 返回最新 account 供后续复用。

---

### 🟡 P2-B：`batchCheckTempUnavailable` 与 `isTempUnavailable` 在 ttl=-1 场景下行为不一致

来源：code-review-1 #3 + code-review-3 P1。

- `isTempUnavailable`（`upstreamErrorHelper.js:367-395`）：ttl=-1 时**自动 `del(key)`** 并返回 false（清理无 TTL 的脏数据）。
- `batchCheckTempUnavailable`（`upstreamErrorHelper.js:496-528`）：ttl=-1 时直接返回 false，**不清理**。

功能正确但失去懒清理能力。另外 `results[i][1]` 假设每条命令成功；若 pipeline 部分失败 `results[i]` 为 `undefined` 会抛错。与 `batchGetConcurrency` 同模式，保持一致即可，但建议：
- 加防御：`const ttl = results[i]?.[1]`
- 可选：批量发现 ttl=-1 时追加一次 `pipeline.del()` 兜底

---

### 🟢 P3-A：Console / Bedrock 账户全量进入 temp_unavailable 批量列表

来源：code-review-1 #1。`unifiedClaudeScheduler.js:647-664` 把所有 Console / Bedrock 账户（含未激活、非 shared、不可调度）都丢进 pipeline。

Claude Official 走两阶段过滤（先 `eligibleClaudeAccounts`），Console/Bedrock 未做。功能正确（同 pipeline = 1 子请求），仅命令数偏大。Workers 当前无 pipeline 命令数硬限制，**暂不影响**子请求预算。

**建议**：与 Claude 路径对称化，先过滤再入队。非紧急。

---

### 🟢 P3-B：Bedrock 0 账户时缺失 "Found 0 total Bedrock accounts" 日志

来源：code-review-1 #2 + code-review-2 #3。`unifiedClaudeScheduler.js:660-665` 用 `if (bedrockAccounts.length > 0)` 门控，0 账户时无日志。功能等价，仅日志少一条。

**建议**：把 `logger.info(...)` 移出 `if`，与 Claude/Console 一致。

---

### 🟢 P3-C：`isAccountRateLimited` 传入 `existingAccountData` 时跳过过期清理

来源：code-review-3 P3。`claudeAccountService.js` / `claudeConsoleAccountService.js` 中调度路径不再"懒清理"过期 rate-limit 标记，依赖 cron 兜底。判断结果正确，仅 Redis stale 标记残留更久。

**建议**：在两个 `isAccountRateLimited` 函数顶部加注释说明该行为及 cron 兜底依赖，避免后续改动者误以为是 bug。

---

## 二、已确认接受 / 仅记录

| 项 | 来源 | 状态 |
|----|------|------|
| `getValidAccessToken` mutate 传入对象 | review-2 #4 | 设计如此（relay 中是最后使用点，且内部会持久化）。后续若有调用方在其后读旧字段需注意。 |
| `clearExpiredOpusRateLimit` 返回 `{success, accountData, cleared}` | review-2 #5 + review-3 P4 | 调用方均未依赖旧形态，已正确处理 `accountData: null`。无需改动；新增调用方时注意 contract。 |
| `batchGetConcurrency` 仅 `WORKER_MODE === 'true'` 启用 | review-3 P5 | 设计如此，Node.js 模式回退 `Promise.all`，无破坏。 |
| `api.js` warmup 路径无条件预取 account | review-2 #2 | 后续 relay 层复用 `preSelectedAccount.accountData`，整体子请求数不增反减。可接受。 |
| `WORKER_MAX_POLL_ITERATIONS = 5` 硬编码（auth.js） | review-1 风格 | 后续可抽到配置，非阻塞。 |

---

## 三、文档建议

- `hotfix2-result.md` 中 Official `_isAccountAvailable` 子请求数应从 "= 2" 更新为 "= 3"（`isAccountOverloaded` 走独立 key 无法复用 account），与 code-review-3 第五节一致。

---

## 四、已解决 / 不再适用

- ✅ **review-2 #1（非流式 `_makeClaudeRequest` 仍独立 fetch account）** — 已修复。`claudeRelayService.js:1639` 现为 `requestOptions?.account || (await claudeAccountService.getAccount(accountId))`，与流式路径（line 2067）对称。
- ✅ **review-1 #4（TTL=-1 cron 兜底）** — 与方案一致。
- ✅ **review-1 #5（`isAccountQuotaExceeded` 仅读取）** — 确认无写操作。
- ✅ **review-2 #6（`;({ ... } = options.preSelectedAccount)` 前置分号）** — 已正确添加。

---

## 五、合并前建议

- 优先处理 **P2-A**（正确性影响）、**P2-B**（健壮性）。
- P3 系列均为可维护性 / 日志一致性，可与本批合并或后续单独提交。
- 跑 `npx prettier --write` + `npm run lint` + `npm test`。
- 回归：非 Workers 模式 Console 账户在 `checkQuotaUsage` 触发 quota 标记时能否在本轮正确排除（验证 P2-A）。
