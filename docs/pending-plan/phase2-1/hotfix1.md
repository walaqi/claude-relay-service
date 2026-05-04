# Phase 2-1 补丁：消除绑定账户路径和 Relay 服务的冗余 Redis 调用

## Context

Phase 2-1 优化了 `_getAllAvailableAccounts`（池选择路径），但**绑定账户路径**和 **Relay 服务**仍有大量冗余 `getClaudeAccount` 调用。从日志看，一个绑定 Official 账户的 Opus 流式请求仍触发 ~15+ 次 `getClaudeAccount`，加上调度器被调用两次，轻松超出 50 子请求限制。

### 三个结构性问题

1. **双重调度（仅 Official 路径）**：`api.js` 调用 `selectAccountForApiKey()` 选好账户，然后 `claudeRelayService` 内部再调一次
2. **数据不传递**：每个方法独立重新获取同一账户数据
3. **Console 路径同样冗余**：`claudeConsoleRelayService` 的 `getAccount`、`isAccountRateLimited`、`isAccountOverloaded` 也各自独立获取数据

## 修改方案（6 个文件）

---

### 变更 1：`clearAccountOpusRateLimit` 添加可选参数 + 返回清理后数据

**文件**：[claudeAccountService.js](src/services/account/claudeAccountService.js)，行 1524

这是底层清理方法，被 `clearExpiredOpusRateLimit`（行 1634）和 `isAccountOpusRateLimited`（行 1603）调用。当前内部总是 re-fetch account。改为返回清理后数据，避免上层再做浅拷贝。

```javascript
async clearAccountOpusRateLimit(accountId, existingAccountData = null) {
  try {
    const accountData = existingAccountData || await redis.getClaudeAccount(accountId)
    if (!accountData || Object.keys(accountData).length === 0) {
      return { success: true, accountData: null }
    }
    const updatedAccountData = { ...accountData }
    delete updatedAccountData.opusRateLimitedAt
    delete updatedAccountData.opusRateLimitEndAt
    await redis.setClaudeAccount(accountId, updatedAccountData)
    const redisKey = `claude:account:${accountId}`
    if (redis.client && typeof redis.client.hdel === 'function') {
      await redis.client.hdel(redisKey, 'opusRateLimitedAt', 'opusRateLimitEndAt')
    }
    logger.info(`✅ Cleared Opus rate limit state for account ${accountId}`)
    return { success: true, accountData: updatedAccountData }
  } catch (error) {
    logger.error(`❌ Failed to clear Opus rate limit for account: ${accountId}`, error)
    throw error
  }
}
```

向后兼容：原返回值是 `{ success: true }`，新增 `accountData` 字段。现有调用方只检查 `success`。

### 变更 2：`clearExpiredOpusRateLimit` 添加可选参数 + 返回清理后数据

**文件**：[claudeAccountService.js](src/services/account/claudeAccountService.js)，行 1634

直接使用底层方法返回的清理后数据，不再重复浅拷贝。

```javascript
async clearExpiredOpusRateLimit(accountId, existingAccountData = null) {
  try {
    const accountData = existingAccountData || await redis.getClaudeAccount(accountId)
    if (!accountData || Object.keys(accountData).length === 0) {
      return { success: true, accountData: null }
    }
    if (!accountData.opusRateLimitEndAt) {
      return { success: true, accountData }
    }
    const resetTime = new Date(accountData.opusRateLimitEndAt)
    if (Number.isNaN(resetTime.getTime()) || new Date() >= resetTime) {
      const clearResult = await this.clearAccountOpusRateLimit(accountId, accountData)
      return { success: true, accountData: clearResult.accountData, cleared: true }
    }
    return { success: true, accountData }
  } catch (error) {
    logger.error(`❌ Failed to clear expired Opus rate limit for account: ${accountId}`, error)
    throw error
  }
}
```

向后兼容：原返回值是 `{ success: true }`，新增字段不影响现有调用方。

### 变更 3：`isAccountOpusRateLimited` 传入数据给 `clearAccountOpusRateLimit`

**文件**：[claudeAccountService.js](src/services/account/claudeAccountService.js)，行 1603

当前行 1616 和 1622 调用 `this.clearAccountOpusRateLimit(accountId)` 不传数据。改为：

```javascript
// 行 1616
await this.clearAccountOpusRateLimit(accountId, accountData)
// 行 1622
await this.clearAccountOpusRateLimit(accountId, accountData)
```

### 变更 4：`getAccountRateLimitInfo` 和 `getValidAccessToken` 添加可选参数

**文件**：[claudeAccountService.js](src/services/account/claudeAccountService.js)

**4a. `getAccountRateLimitInfo`（行 1766）**
```javascript
async getAccountRateLimitInfo(accountId, existingAccountData = null) {
  try {
    const accountData = existingAccountData || await redis.getClaudeAccount(accountId)
    // ... 原有逻辑不变 ...
  }
}
```

**4b. `getValidAccessToken`（行 476）**
```javascript
async getValidAccessToken(accountId, existingAccountData = null) {
  try {
    const accountData = existingAccountData || await redis.getClaudeAccount(accountId)
    // ... 原有逻辑不变（包括 token 刷新、lastUsedAt 更新、setClaudeAccount 写入）...
  }
}
```

注意：`getValidAccessToken` 会 mutate 传入的对象（设置 `lastUsedAt`、session window 字段）。这在当前使用场景中是可接受的，因为它是 relay 流程中最后一个使用 account 的调用。

---

### 变更 5：`claudeConsoleAccountService.isAccountOverloaded` 添加可选参数

**文件**：[claudeConsoleAccountService.js](src/services/account/claudeConsoleAccountService.js)，行 1042

```javascript
async isAccountOverloaded(accountId, existingAccountData = null) {
  try {
    const account = existingAccountData || await this.getAccount(accountId)
    // ... 原有逻辑不变（包括 removeAccountOverload 写操作）...
  }
}
```

注意：`isAccountRateLimited`、`isAccountBlocked`、`isAccountQuotaExceeded` 在 phase 2-1 中已添加可选参数。

---

### 变更 6：调度器绑定账户路径传入已有数据

**文件**：[unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js)

**6a. Official 绑定路径（行 259-287）**

行 259 获取了 `boundAccount`，后续调用改为传入：

```javascript
// 行 271: 传入 boundAccount（phase 2-1 已添加参数但未使用！）
const isRateLimited = await claudeAccountService.isAccountRateLimited(boundAccount.id, boundAccount)

// 行 273: 传入 boundAccount（变更 4a）
const rateInfo = await claudeAccountService.getAccountRateLimitInfo(boundAccount.id, boundAccount)

// 行 287: 传入 boundAccount（变更 2）
await claudeAccountService.clearExpiredOpusRateLimit(boundAccount.id, boundAccount)
```

节省：3 个子请求

---

### 变更 7：api.js `account` 变量作用域提升 + 传递给 Relay

**文件**：[api.js](src/routes/api.js)

**问题**：warmup 检查中 `account` 是 `const` 声明在 `if` 块内，relay 调用处访问不到。

**7a. 流式路径（行 410-424）**

```javascript
// 改为：
let account = null
if (accountType === 'claude-official' || accountType === 'claude-console') {
  account =
    accountType === 'claude-official'
      ? await claudeAccountService.getAccount(accountId)
      : await claudeConsoleAccountService.getAccount(accountId)

  if (account?.interceptWarmup === 'true' && isWarmupRequest(req.body)) {
    // ... warmup 拦截逻辑不变 ...
  }
}
```

然后在 relay 调用处传入（行 436，Official 流式）：
```javascript
await claudeRelayService.relayStreamRequestWithUsageCapture(
  _requestBody, _apiKey, res, _headers, usageCallback, null,
  { preSelectedAccount: { accountId, accountType, accountData: account } }
)
```

Console 流式（行 570）：
```javascript
await claudeConsoleRelayService.relayStreamRequestWithUsageCapture(
  _requestBodyConsole, _apiKeyConsole, res, _headersConsole, usageCallback, accountId, null,
  { accountData: account }
)
```

**7b. 非流式路径（行 1115-1127）**

同样提升 `account` 作用域：
```javascript
let accountNonStream = null
if (accountType === 'claude-official' || accountType === 'claude-console') {
  accountNonStream =
    accountType === 'claude-official'
      ? await claudeAccountService.getAccount(accountId)
      : await claudeConsoleAccountService.getAccount(accountId)

  if (accountNonStream?.interceptWarmup === 'true' && isWarmupRequest(_requestBodyNonStream)) {
    // ... warmup 拦截逻辑不变 ...
  }
}
```

Official 非流式（行 1137）：
```javascript
response = await claudeRelayService.relayRequest(
  _requestBodyNonStream, _apiKeyNonStream, req, res, _headersNonStream,
  { preSelectedAccount: { accountId, accountType, accountData: accountNonStream } }
)
```

Console 非流式（行 1149）：
```javascript
response = await claudeConsoleRelayService.relayRequest(
  _requestBodyNonStream, _apiKeyNonStream, req, res, _headersNonStream, accountId,
  { accountData: accountNonStream }
)
```

---

### 变更 8：Official Relay 服务内部链式传递 + 消除双重调度

**文件**：[claudeRelayService.js](src/services/relay/claudeRelayService.js)

**8a. `relayStreamRequestWithUsageCapture`（行 1772，`options` 是第 7 个参数）**

```javascript
// 如果有预选账户，跳过重复调度
let accountId, accountType, account
if (options.preSelectedAccount) {
  ({ accountId, accountType, accountData: account } = options.preSelectedAccount)
  selectedAccountId = accountId
} else {
  // 原有调度逻辑（向后兼容）
  const accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(...)
  ;({ accountId } = accountSelection)
  ;({ accountType } = accountSelection)
  selectedAccountId = accountId
}

// 行 1838: 队列锁 — 用已有 account 数据
const accountForQueue = account || await claudeAccountService.getAccount(accountId)

// 行 1911: 只在没有预获取数据时才 fetch
if (!account) {
  account = await claudeAccountService.getAccount(accountId)
}

// 行 1914-1915: 传入 account，使用返回值（单一数据源）
if (isOpusModelRequest) {
  const clearResult = await claudeAccountService.clearExpiredOpusRateLimit(accountId, account)
  if (clearResult.accountData) {
    account = clearResult.accountData
  }
  // 删除原来的 re-fetch: account = await claudeAccountService.getAccount(accountId)
}

// 行 1926: 传入 account
opusRateLimitActive = await claudeAccountService.isAccountOpusRateLimited(accountId, account)

// 行 1946: 传入 account
const accessToken = await claudeAccountService.getValidAccessToken(accountId, account)

// 传入 account 给 _makeClaudeStreamRequestWithUsageCapture
await this._makeClaudeStreamRequestWithUsageCapture(
  ..., { ...requestOptions, account }, ...
)
```

注意：原来的 `const { accountId } = accountSelection` 和 `const { accountType } = accountSelection` 需要改为 `let` 声明。实施时搜索方法内所有 `accountId =` 赋值确认无意外重赋值。

**8b. `_makeClaudeStreamRequestWithUsageCapture`（搜索 `const account = await claudeAccountService.getAccount(accountId)`）**

```javascript
const account = requestOptions?.account || await claudeAccountService.getAccount(accountId)
```

**8c. `relayRequest` 非流式路径（行 405，`options` 是第 6 个参数）**

同样的模式：
- 通过 `options.preSelectedAccount` 接收预选账户
- 行 476（队列锁）：`const accountForQueue = account || await claudeAccountService.getAccount(accountId)`
- 行 537：`if (!account) { account = await claudeAccountService.getAccount(accountId) }`
- 行 540-541：`const clearResult = await claudeAccountService.clearExpiredOpusRateLimit(accountId, account); if (clearResult.accountData) account = clearResult.accountData`
- 行 553：`opusRateLimitActive = await claudeAccountService.isAccountOpusRateLimited(accountId, account)`
- 行 574：`const accessToken = await claudeAccountService.getValidAccessToken(accountId, account)`

---

### 变更 9：Console Relay 服务内部链式传递

**文件**：[claudeConsoleRelayService.js](src/services/relay/claudeConsoleRelayService.js)

Console relay 不存在双重调度问题（`accountId` 直接传入），只需传递 account 数据。

**9a. `relayRequest`（行 23，`options` 是第 7 个参数）**

```javascript
// 行 99: 用传入数据或 fetch
account = options.accountData || await claudeConsoleAccountService.getAccount(accountId)

// 行 393: 传入 account（phase 2-1 已添加参数）
const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(accountId, account)

// 行 397: 传入 account（变更 5）
const isOverloaded = await claudeConsoleAccountService.isAccountOverloaded(accountId, account)
```

**9b. `relayStreamRequestWithUsageCapture`（行 491，`options` 是第 8 个参数）**

```javascript
// 行 571: 用传入数据或 fetch
account = options.accountData || await claudeConsoleAccountService.getAccount(accountId)

// 行 964: 传入 account（fire-and-forget）
claudeConsoleAccountService.isAccountRateLimited(accountId, account).then(...)

// 行 969: 传入 account（fire-and-forget）
claudeConsoleAccountService.isAccountOverloaded(accountId, account).then(...)
```

注意：`_makeClaudeConsoleStreamRequest`（行 744）签名中已有 `account` 参数（第 2 个位置），由 `relayStreamRequestWithUsageCapture` 在行 571 获取后直接传入。变更 9b 替换行 571 的 fetch 后，内部方法自然获得预取数据，无需额外修改。

---

## 优化后子请求预算

### Official 绑定账户 + Opus + 流式

| 操作 | 优化前 | 优化后 |
|------|--------|--------|
| Auth 阶段 | 4-7 | 4-7 |
| Scheduler: getClaudeAccount (绑定) | 1 | 1 |
| Scheduler: isRateLimited | 1 | **0** |
| Scheduler: getAccountRateLimitInfo | 1 | **0** |
| Scheduler: clearExpiredOpusRateLimit | 1+1 (外层+内层) | **0** |
| Scheduler: 会话映射 | 2-3 | 2-3 |
| api.js: warmup 检查 getAccount | 1 | 1 |
| Relay: selectAccountForApiKey (重复!) | ~5-8 | **0** |
| Relay: getAccount (队列锁) | 1 | **0** |
| Relay: getAccount (初始) | 1 | **0** |
| Relay: clearExpiredOpusRateLimit (外层+内层) | 1+1 | **0** (传入数据，内层也传入) |
| Relay: getAccount (re-fetch after clear) | 1 | **0** |
| Relay: isAccountOpusRateLimited | 0 (传入) + 1 (内层 clear 时) | **0** |
| Relay: getValidAccessToken (读+写) | 2 | **1** (传入数据，保留写) |
| Relay: _makeStream getAccount | 1 | **0** |
| **总计** | **~27-35** | **~8-12** |

### Console 绑定账户 + 流式

| 操作 | 优化前 | 优化后 |
|------|--------|--------|
| Auth 阶段 | 4-7 | 4-7 |
| Scheduler: 会话映射 | 2-3 | 2-3 |
| api.js: warmup 检查 getAccount | 1 | 1 |
| Relay: getAccount (初始) | 1 | **0** |
| Relay: 并发控制 (incr) | 1 | 1 |
| Relay: isAccountRateLimited (成功后) | 1 | **0** |
| Relay: isAccountOverloaded (成功后) | 1 | **0** |
| **总计** | **~11-14** | **~8-12** |

---

## 实施顺序

1. **变更 1-4**：`claudeAccountService.js` — 底层方法签名扩展（纯向后兼容）
2. **变更 5**：`claudeConsoleAccountService.js` — `isAccountOverloaded` 可选参数
3. **变更 6**：`unifiedClaudeScheduler.js` — 绑定路径传入数据
4. **变更 8**：`claudeRelayService.js` — 内部链式传递 + 消除双重调度
5. **变更 9**：`claudeConsoleRelayService.js` — 内部链式传递
6. **变更 7**：`api.js` — 作用域提升 + 传递预选数据

## 验证

1. `npx prettier --write` 格式化所有修改文件
2. `npm run lint` 检查
3. `npm test` 确保所有测试通过
4. 针对性场景测试：
   - 绑定 Official 账户 + Opus + 流式
   - 绑定 Console 账户 + 流式
   - 池选择路径（确认不受影响）
   - 非流式路径（Official + Console）
5. 回归测试：不传 `preSelectedAccount`/`accountData` 时行为不变
6. Token 刷新场景：确认 `getValidAccessToken` 在 token 过期需刷新时仍正常

## 关键约束 / Checklist

- [ ] `clearAccountOpusRateLimit` 添加 `existingAccountData` 参数（否则内层仍 re-fetch）
- [ ] `isAccountOpusRateLimited` 内部调用 `clearAccountOpusRateLimit` 时传入 `accountData`
- [ ] `clearExpiredOpusRateLimit` 返回 `{ success, accountData, cleared }`（单一数据源）
- [ ] api.js 流式路径 `account` 从 `const`（if 块内）改为 `let`（if 块外）
- [ ] api.js 非流式路径同样提升 `account` 作用域
- [ ] relay 服务 `const { accountId }` 改为 `let accountId`（支持条件赋值）
- [ ] `getValidAccessToken` 会 mutate 传入对象——确认在 relay 流程中是最后使用 account 的调用
- [ ] 所有可选参数不传时行为完全不变（向后兼容）
- [ ] 以代码搜索定位为准，不依赖行号
