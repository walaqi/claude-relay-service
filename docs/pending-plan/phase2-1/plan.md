# Phase 2.1: Cloudflare Workers Subrequest 优化

## Context

CRS 在 Cloudflare Workers 免费版运行时，频繁触发 "Too many subrequests" 错误。免费版限制每次 Worker 调用最多 50 个子请求，而每个 Upstash Redis HTTP 调用 = 1 个子请求。当前请求流程在典型场景下消耗 ~60-80 个子请求，超出限制。

**根本原因**：调度器的 `_getAllAvailableAccounts` 方法对每个账户做 2-7 次独立 Redis 调用来检查可用性状态，但这些状态数据大部分已经在 `getAllAccounts()` 的批量返回中包含了——代码在重复获取已有数据。

**部署架构前提**：Workers 部署配置了 5 个 Cron Triggers（见 wrangler.toml），包括每分钟并发清理、每 5 分钟限流清理等。因此 cron 任务在 Workers 模式下正常运行，可以依赖它们处理过期状态清理。

**Workers 模式检测**：统一使用 `process.env.WORKER_MODE === 'true'`，与现有代码一致（redis-factory.js、logger.js、proxyHelper.js 等）。

## 当前子请求消耗分析

| 阶段 | 操作 | 子请求数 |
|------|------|----------|
| Auth: API Key 验证 | validateApiKey | 1 |
| Auth: 并发控制 | incrConcurrency (Lua) | 1 |
| Auth: 排队健康检查 | getConcurrencyQueueCount + getQueueWaitTimes | 0-2 |
| Auth: 排队轮询 | 每次迭代 2 calls (incr + decr) | 0-40 |
| Auth: 限流检查 | 5-9 个独立 GET/SET | **5-9** |
| Scheduler: 绑定账户检查 | getAccount + isTempUnavailable + isRateLimited | 3-6 |
| Scheduler: 会话映射 | get + ttl + expire/setex | 2-3 |
| Scheduler: getAllClaudeAccounts | smembers(1) + pipeline hgetall(1) | **2** |
| Scheduler: 每个 Claude 账户检查 | isTempUnavailable(1) + isRateLimited(1, 重新获取!) + isOpusRateLimited(1, 重新获取!) | **2-3 × N** |
| Scheduler: getAllConsoleAccounts | getAllIdsByIndex(1-2) + pipeline hgetall(1) + 每账户 getConsoleAccountConcurrency(1) | **~2 + N** |
| Scheduler: 每个 Console 账户检查 | isBlocked(1) + checkQuotaUsage(2) + isTempUnavailable(1) + isRateLimited(1) + isQuotaExceeded(1) | **5-7 × N** |
| Scheduler: getAllBedrockAccounts | smembers(1) + pipeline hgetall(1) | **2** |
| Scheduler: 每个 Bedrock 账户检查 | isTempUnavailable(1) | **1 × N** |
| **典型场景 (5 Claude + 3 Console + 2 Bedrock)** | | **~60-80** |

> 注：getAllAccounts 的实际子请求数比初版分析更高。Upstash 模式下每种账户类型需要 smembers/getAllIdsByIndex(1-2) + batchHgetallChunked pipeline(1) = 2-3 个子请求，3 种类型合计 ~6-8 个子请求（非初版估计的 3 个）。Console 的 getAllAccounts 还额外对每个账户调用 getConsoleAccountConcurrency。

## 优化方案

### 定位：所有优化均针对 Workers 模式

所有 5 个优化的目标是解决 Workers 模式的子请求限制问题。Node.js 本地模式使用 ioredis TCP 连接，没有子请求限制，不需要这些优化。

- **优化 1、2、3**：代码改动碰巧向后兼容 Node.js 模式（可选参数不传入时行为不变，pipeline 在 ioredis 下也能工作），但不需要刻意为 Node.js 设计或验证
- **优化 4、5**：通过 `WORKER_MODE=true` 环境变量守卫，Node.js 模式下不触发
- **`batchGetConcurrency`**：仅在 `redis-upstash.js` 中实现，不需要在 `redis.js` 中实现。调度器调用时必须有 `WORKER_MODE` 守卫

---

### 优化 1: 消除重复账户数据获取（节省 ~25-35 子请求）

**问题**：`isAccountRateLimited(id)`、`isAccountOpusRateLimited(id)`、`isAccountBlocked(id)`、`isAccountQuotaExceeded(id)` 等方法内部都会重新调用 `getAccount(id)` 或 `redis.getClaudeAccount(id)` 获取账户数据，但调度器在循环开始前已经通过 `getAllClaudeAccounts()` / `getAllAccounts()` 拿到了完整数据。

**方案**：为现有 check 方法添加可选的 `accountData` 参数——如果传入则跳过 Redis 获取，不传则保持原行为。这样不破坏现有调用点，调度器传入已有数据即可。

**修改文件**：
- [claudeAccountService.js](src/services/account/claudeAccountService.js)
  - `isAccountRateLimited(accountId, accountData = null)` — 如果 accountData 传入，跳过 `redis.getClaudeAccount(accountId)`
  - `isAccountOpusRateLimited(accountId, accountData = null)` — 同上
- [claudeConsoleAccountService.js](src/services/account/claudeConsoleAccountService.js)
  - `isAccountRateLimited(accountId, accountData = null)` — 如果 accountData 传入，跳过 `this.getAccount(accountId)`
  - `isAccountQuotaExceeded(accountId, accountData = null)` — 同上
  - `isAccountBlocked(accountId, accountData = null)` — 同上
- [unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js) — 在 `_getAllAvailableAccounts` 中传入已有的 account 数据

**示例**（claudeAccountService.isAccountRateLimited）：
```javascript
async isAccountRateLimited(accountId, accountData = null) {
  try {
    const data = accountData || await redis.getClaudeAccount(accountId)
    if (!data || Object.keys(data).length === 0) {
      return false
    }
    // ... 原有判断逻辑完全保留，包括所有分支 ...
    // 注意：当 accountData 传入时，跳过 removeAccountRateLimit 的自动清理
    // 原因：自动清理需要额外 Redis 写入，在子请求受限场景下不值得
    // 过期限流由 cron 任务（*/5 * * * *）定期清理
  }
}
```

**关键约束**：
1. 判断逻辑必须从原方法完整提取，不能简化或重写（原方法可能有 `fiveHourAutoStopped`、不同时间窗口等分支）
2. 不传 `accountData` 时行为完全不变，保持向后兼容
3. **写操作策略按方法分类**（cron 覆盖分析）：

| 方法 | cron 覆盖 | accountData 传入时跳过写操作 |
|------|-----------|---------------------------|
| `claudeAccountService.isAccountRateLimited` | 是 (*/5 rateLimitCleanup) | **是**，cron 兜底清理 |
| `claudeAccountService.isAccountOpusRateLimited` | **否**，仅在此方法内调用 clearAccountOpusRateLimit | **否**，必须保留写操作 |
| `claudeConsoleAccountService.isAccountRateLimited` | 是 (*/5 rateLimitCleanup) | **是**，cron 兜底清理 |
| `claudeConsoleAccountService.isAccountBlocked` | **否**，仅在此方法内调用 removeAccountBlocked | **否**，必须保留写操作 |
| `claudeConsoleAccountService.isAccountQuotaExceeded` | N/A (纯读取判断) | N/A |

对于 `isAccountOpusRateLimited` 和 `isAccountBlocked`：传入 `accountData` 时跳过读取（节省 1 个子请求），但保留过期时的写操作（`clearAccountOpusRateLimit` / `removeAccountBlocked`）。这些写操作只在状态过期时触发（低频），每个过期账户最多 1 次，不会显著增加子请求消耗。

```javascript
// isAccountOpusRateLimited 示例：跳过读取，保留写操作
async isAccountOpusRateLimited(accountId, accountData = null) {
  const data = accountData || await redis.getClaudeAccount(accountId)
  if (!data || !data.opusRateLimitEndAt) return false
  const resetTime = new Date(data.opusRateLimitEndAt)
  if (Number.isNaN(resetTime.getTime())) {
    await this.clearAccountOpusRateLimit(accountId)  // 保留写操作
    return false
  }
  if (new Date() >= resetTime) {
    await this.clearAccountOpusRateLimit(accountId)  // 保留写操作
    return false
  }
  return true
}
```

---

### 优化 2: 批量 temp_unavailable 检查（节省 ~8-12 子请求）

**问题**：每个账户的 `isAccountTemporarilyUnavailable` 调用 `client.ttl(key)` 做独立 Redis 调用。10 个账户 = 10 个子请求。

**方案**：在 `_getAllAvailableAccounts` 中，先收集所有需要检查的账户 ID 和类型，然后用一个 pipeline 批量执行所有 TTL 检查。

**修改文件**：
- [upstreamErrorHelper.js](src/utils/upstreamErrorHelper.js) — 添加 `batchCheckTempUnavailable(accounts)` 方法
- [unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js) — 在 `_getAllAvailableAccounts` 中使用批量检查

**实现**：
```javascript
// upstreamErrorHelper.js
const batchCheckTempUnavailable = async (accounts) => {
  if (!accounts || accounts.length === 0) return new Map()

  const redis = getRedis()
  const client = redis.getClientSafe()
  if (!client) {
    // Redis 未连接时，默认所有账户可用
    return new Map(accounts.map(({ accountId, accountType }) =>
      [`${accountType}:${accountId}`, false]
    ))
  }

  const pipeline = client.pipeline()
  const entries = accounts.map(({ accountId, accountType }) => ({
    key: `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`,
    mapKey: `${accountType}:${accountId}`
  }))

  for (const { key } of entries) {
    pipeline.ttl(key)
  }

  const results = await pipeline.exec()
  const map = new Map()

  entries.forEach(({ mapKey }, i) => {
    const ttl = results[i][1]
    // ttl > 0: key 存在且有 TTL → 临时不可用
    // ttl === -2: key 不存在 → 可用
    // ttl === -1: key 存在但无 TTL → 异常情况，原代码会 del 清理
    //   批量模式下跳过清理（边缘情况，由 cron 处理），视为可用
    map.set(mapKey, ttl > 0)
  })

  return map
}
```

**注意**：
- pipeline 通过 `client.pipeline()` 获取（不是 `redis.pipeline()`）
- 处理 `getClientSafe()` 返回 null 的情况
- TTL === -1 的清理逻辑在批量模式下跳过（边缘情况，由 cron 处理）

---

### 优化 3: Pipeline 化限流检查（节省 ~3-6 子请求）

**问题**：auth.js 的限流检查函数（约 1077-1169 行）对 windowStart、requestCount、tokenCount、costCount 做独立 GET/SET 调用。

**方案**：用 pipeline 批量读取，条件写入也用 pipeline。最后的 INCR 保持独立（它在限流判断之后执行，依赖判断结果，无法合并到读取 pipeline）。

**修改文件**：
- [auth.js](src/middleware/auth.js) — 重构限流检查逻辑

**改造后**（2-3 个调用替代 5-9 个）：
```javascript
const client = redis.getClientSafe()

// Pipeline 1: 批量读取所有限流状态（1 个子请求）
const readPipeline = client.pipeline()
readPipeline.get(windowStartKey)
readPipeline.get(requestCountKey)
readPipeline.get(tokenCountKey)
readPipeline.get(costCountKey)
const [[, windowStart], [, reqCount], [, tokCount], [, costVal]] = await readPipeline.exec()

// 判断是否需要重置窗口...
const needsReset = !windowStart || (now - parseInt(windowStart)) >= windowDuration

if (needsReset) {
  // Pipeline 2: 批量重置窗口（1 个子请求，条件执行）
  const writePipeline = client.pipeline()
  writePipeline.set(windowStartKey, now, 'PX', windowDuration)
  writePipeline.set(requestCountKey, 0, 'PX', windowDuration)
  writePipeline.set(tokenCountKey, 0, 'PX', windowDuration)
  writePipeline.set(costCountKey, 0, 'PX', windowDuration)
  await writePipeline.exec()
}

// 使用已读取的值进行限流判断（0 个子请求）
const currentRequests = parseInt(needsReset ? '0' : (reqCount || '0'))
const currentTokens = parseInt(needsReset ? '0' : (tokCount || '0'))
const currentCost = parseFloat(needsReset ? '0' : (costVal || '0'))

// ... 限流判断逻辑 ...

// INCR 保持独立（1 个子请求，在判断通过后执行）
await client.incr(requestCountKey)
```

**竞态条件说明**：原代码的 GET → 判断 → SET 序列本身就不是原子的，pipeline 化不引入新的竞态问题，只是保持了现有特性。

**优化后子请求数**：2-3 个（读取 pipeline 1 + 条件写入 pipeline 0-1 + INCR 1）

---

### 优化 4: 消除 Console 账户的冗余 checkQuotaUsage（Workers 专属，节省 ~3-6 子请求）

**问题**：`_getAllAvailableAccounts` 中对每个 Console 账户调用 `checkQuotaUsage(accountId)`，该方法内部调用 `redis.getAccountUsageStats(accountId)` + `this.getAccount(accountId)` = 2+ 个 Redis 调用。而且 `checkQuotaUsage` 有副作用——当检测到配额超限时会标记账户状态（设置 quotaStoppedAt、schedulable=false）。

**分析**：`checkQuotaUsage` 的副作用是必要的（标记超限账户），但在调度器的 `_getAllAvailableAccounts` 循环中触发它是低效的。更好的触发点是：
1. 请求完成后的 usage 回调（已有）
2. Cron 任务定期检查（可添加）

**方案**：在 Workers 模式下（`WORKER_MODE=true`），跳过调度器中的主动 `checkQuotaUsage` 调用。改为使用优化 1 中的 `isAccountQuotaExceeded(accountId, accountData)` 做内存判断。配额超限的标记由请求完成后的 usage 回调和 cron 任务处理。

**修改文件**：
- [unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js) — 在 `_getAllAvailableAccounts` 的 Console 账户循环中，Workers 模式下跳过 `checkQuotaUsage`

```javascript
// Workers 模式下跳过主动配额检查（节省 2+ 子请求/账户）
// 配额超限标记由 usage 回调和 cron 任务处理
if (process.env.WORKER_MODE !== 'true') {
  try {
    await claudeConsoleAccountService.checkQuotaUsage(currentAccount.id)
  } catch (e) {
    logger.warn(`Failed to check quota: ${e.message}`)
  }
}
```

---

### 优化 5: Workers 模式下限制排队轮询次数（Workers 专属，节省 ~10-30 子请求）

**排队轮询机制说明**：

当一个 API Key 的并发请求数超过限制时，新请求不会立即返回 429，而是进入排队等待。排队机制通过 `waitForConcurrencySlot()` 函数（[auth.js:248](src/middleware/auth.js#L248)）实现：

1. 请求进入 while 循环，每次迭代调用 `redis.incrConcurrency()` 尝试获取并发槽位（1 个子请求）
2. 如果槽位已满，调用 `redis.decrConcurrency()` 释放刚占的位置（1 个子请求），然后 sleep 等待
3. 轮询间隔从 200ms 开始，按 1.5x 指数退避，最大 2000ms，加 ±20% 抖动
4. 超时时间由配置决定（通常 30-60 秒），超时后返回 429

每次轮询迭代消耗 2 个子请求（incr + decr），加上成功获取后的 3 个 fire-and-forget 统计调用。在 Node.js 模式下这不是问题（TCP 连接无子请求限制），但在 Workers 模式下，一个排队请求可能消耗 10-40 个子请求仅用于轮询。

**轮询上限推导**：优化 1-4 后，非排队阶段消耗约 15-20 个子请求。预算 50 - 20 = 30 个子请求留给排队。每次迭代 2 个子请求，理论上限 15 次。但考虑到：
- 成功获取槽位后还有 3 个 fire-and-forget 统计调用
- 需要留出安全余量应对账户数量波动
- Workers 免费版 CPU 时间限制（10ms），长时间轮询本身不现实

设定上限为 **5 次**（消耗 ~10 个子请求），在保守和实用之间取平衡。

**方案**：在 Workers 模式下，`waitForConcurrencySlot` 的 while 循环中添加迭代计数器，超过 5 次后返回 429 + `Retry-After: 2`（2 秒后重试，因为并发槽位通常很快释放）。

**修改文件**：
- [auth.js](src/middleware/auth.js) — 在 `waitForConcurrencySlot` 中添加 Workers 模式轮询上限

```javascript
const isWorkerMode = process.env.WORKER_MODE === 'true'
const WORKER_MAX_POLL_ITERATIONS = 5
let pollCount = 0

while (Date.now() - startTime < timeoutMs) {
  pollCount++
  if (isWorkerMode && pollCount > WORKER_MAX_POLL_ITERATIONS) {
    return {
      acquired: false,
      reason: 'worker_poll_limit',
      waitTimeMs: Date.now() - startTime
    }
  }
  // ... 原有轮询逻辑 ...
}
```

调用方处理新的 reason（`waitForConcurrencySlot` 仅在 [auth.js:779](src/middleware/auth.js#L779) 一处调用，无需修改其他文件）：
```javascript
if (slot.reason === 'worker_poll_limit') {
  res.set('Retry-After', '2')
  return res.status(429).json({
    error: 'Queue poll limit reached',
    message: 'Workers mode: concurrency slot not available after limited polling. Please retry.',
    retryAfterSeconds: 2
  })
}
```

---

## 优化后子请求预算

| 阶段 | 优化前 | 优化后 |
|------|--------|--------|
| Auth: API Key 验证 | 1 | 1 |
| Auth: 并发控制 | 1 | 1 |
| Auth: 排队健康检查 | 0-2 | 0-2 |
| Auth: 排队轮询 | 0-40 (每次2) | 0-10 (Workers: 最多5次×2) |
| Auth: 限流检查 | 5-9 | **2-3** (pipeline) |
| Scheduler: 绑定账户检查 | 3-6 | 2-4 (可选参数, opus/blocked 保留写操作时 +1-2) |
| Scheduler: 会话映射 | 2-3 | 2-3 |
| Scheduler: 获取所有账户 | ~6-8+N | ~6-8 (skipConcurrency) |
| Scheduler: 账户可用性检查 (10 accounts) | 25-40 | **1-3** (batch pipeline) + **0-1** (batch concurrency pipeline, Console only) |
| **总计 (典型场景，无排队)** | **~60-80** | **~15-22** |
| **总计 (有排队，Workers)** | **~70-120** | **~25-32** |

### Console getAllAccounts 的 per-account 并发查询

`claudeConsoleAccountService.getAllAccounts()` 内部对每个账户调用 `redis.getConsoleAccountConcurrency(accountData.id)`（Lua 脚本 ZREMRANGEBYSCORE + ZCARD），这是 N 个独立子请求。

**关键发现**：调度器从不使用 `getAllAccounts()` 返回的 `activeTaskCount` 字段——它在后续的批量并发检查中（[unifiedClaudeScheduler.js:810-817](src/services/scheduler/unifiedClaudeScheduler.js#L810-L817)）重新调用 `redis.getConsoleAccountConcurrency(account.id)`。所以 `getAllAccounts()` 中的 per-account 并发查询在调度器路径下完全是浪费。

**优化方案**（两步）：

**步骤 A**：为 `getAllAccounts()` 添加可选参数 `{ skipConcurrency: true }`，跳过 per-account 并发查询。调度器调用时传入此参数。`activeTaskCount` 字段在 `skipConcurrency` 时设为 `null`（表示"未查询"，区别于 `0` 的"当前无并发"语义）。其他调用点（如管理后台 API）保持原行为。

```javascript
// claudeConsoleAccountService.js
async getAllAccounts({ skipConcurrency = false } = {}) {
  // ...
  const activeTaskCount = skipConcurrency
    ? null
    : await redis.getConsoleAccountConcurrency(accountData.id)
  // ...
}
```

**节省**：N 个子请求（N = Console 账户数）

**步骤 B**：将调度器的并发批量检查从 `Promise.all`（N 个独立 Lua 调用）改为 pipeline。Upstash pipeline 支持 `eval` 命令，可以将 N 个 `getConcurrency` Lua 脚本合并为 1 个 HTTP 请求。

在 redis-upstash.js 中添加 `batchGetConcurrency(apiKeyIds)` 方法：
```javascript
async batchGetConcurrency(apiKeyIds) {
  if (apiKeyIds.length === 0) return []
  const now = Date.now()
  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
    return redis.call('ZCARD', key)
  `
  const p = this._pipeline()
  for (const id of apiKeyIds) {
    p.eval(script, [`concurrency:${id}`], [now])
  }
  const results = await p.exec()
  return results.map((r) => r[1])
}
```

调度器中使用（需要 `WORKER_MODE` 守卫，Node.js 模式下 `redis.js` 没有此方法）：
```javascript
if (process.env.WORKER_MODE === 'true' && redis.batchGetConcurrency) {
  const ids = accountsNeedingConcurrencyCheck.map((a) => `console_account:${a.id}`)
  const concurrencyCounts = await redis.batchGetConcurrency(ids)
  // ... 赋值到各账户 ...
} else {
  // 原有 Promise.all 路径
  const results = await Promise.all(
    accountsNeedingConcurrencyCheck.map((account) =>
      redis.getConsoleAccountConcurrency(account.id).then((count) => ({ id: account.id, count }))
    )
  )
  // ... 赋值到各账户 ...
}
```

**节省**：N-1 个子请求（N 个独立调用 → 1 个 pipeline）

**两步合计节省**：~2N-1 个子请求（典型 3 个 Console 账户 = 节省 5 个子请求）

## 绑定账户路径的优化

当请求命中粘性会话或绑定账户时，不走 `_getAllAvailableAccounts`，但仍有冗余调用：
- `getAccount(id)` — 必须保留（需要最新状态）= 1 个子请求
- `isAccountTemporarilyUnavailable(id)` — 无法避免单独调用 = 1 个子请求
- `isAccountRateLimited(id)` — 传入 getAccount 返回的数据 = 0 个子请求

优化后绑定路径：2 个子请求（原来 3-6 个）。

## 实施顺序

1. **优化 1 + 2**（一起做，调度器的 `_getAllAvailableAccounts` 需要同时改造）
   - 修改 claudeAccountService / claudeConsoleAccountService 的 check 方法（可选参数）
   - 添加 `batchCheckTempUnavailable` 到 upstreamErrorHelper
   - 改造 `_getAllAvailableAccounts` 使用新接口
   - 同时处理 Console per-account 并发查询优化：
     - `getAllAccounts({ skipConcurrency })` 参数
     - `batchGetConcurrency` pipeline 方法
     - 调度器使用 pipeline 批量并发检查
2. **优化 3**（auth.js 限流 pipeline 化，独立改动）
3. **优化 4**（Workers 模式跳过 checkQuotaUsage，简单条件分支）
4. **优化 5**（Workers 模式限制排队轮询，独立改动）

**修改文件汇总**：
- [claudeAccountService.js](src/services/account/claudeAccountService.js) — isAccountRateLimited、isAccountOpusRateLimited 可选参数
- [claudeConsoleAccountService.js](src/services/account/claudeConsoleAccountService.js) — isAccountRateLimited、isAccountBlocked、isAccountQuotaExceeded 可选参数 + getAllAccounts skipConcurrency
- [upstreamErrorHelper.js](src/utils/upstreamErrorHelper.js) — batchCheckTempUnavailable
- [redis-upstash.js](src/models/redis-upstash.js) — batchGetConcurrency（仅此文件，不修改 redis.js）
- [unifiedClaudeScheduler.js](src/services/scheduler/unifiedClaudeScheduler.js) — _getAllAvailableAccounts 全面改造（batchGetConcurrency 调用需 `WORKER_MODE` 守卫）
- [auth.js](src/middleware/auth.js) — 限流 pipeline 化 + 排队轮询上限

**不修改**：`redis.js`（Node.js 模式无子请求限制，不需要 batchGetConcurrency）

## 验证方案

1. `npm test` 确保现有测试通过（可选参数不传入时行为不变）
2. `npm run lint` + `npx prettier --write` 格式化
3. 本地 `npm run dev` 验证基本功能（Node.js 模式，确认改动不破坏行为）
4. `wrangler dev` 本地 Workers 模式测试，观察是否还有 "Too many subrequests" 错误
5. 部署后监控日志确认无 subrequest 错误
6. 建议：在实施前用 `wrangler dev` 验证 Upstash pipeline 确实只算 1 个子请求

**测试覆盖建议**（如果现有测试已覆盖方法行为，只需确认不传参时仍通过）：
- `batchCheckTempUnavailable`：空数组、null client、正常场景
- `batchGetConcurrency`：空数组、正常场景
- `isAccountRateLimited(id, accountData)` 可选参数：传入 vs 不传入行为一致性
- `getAllAccounts({ skipConcurrency: true })`：返回 `activeTaskCount: null`
- auth.js pipeline 限流：窗口重置 vs 正常路径

**实施 checklist**：
- [ ] `batchGetConcurrency` 调用处有 `WORKER_MODE` 守卫（遗漏会导致 Node.js 模式报 `is not a function`）
- [ ] `skipConcurrency` 时 `activeTaskCount` 为 `null`（非 `0`）
- [ ] `isAccountOpusRateLimited` 和 `isAccountBlocked` 保留写操作（cron 不覆盖）
- [ ] `isAccountRateLimited`（Claude/Console）跳过写操作（cron 覆盖）


## 实施报告
**Phase 2.1 实施完成** — 6 个文件修改，252 个测试全部通过。

**修改文件**：

*   [claudeAccountService.js] — `isAccountRateLimited`、`isAccountOpusRateLimited` 添加可选 `existingAccountData` 参数
*   [claudeConsoleAccountService.js] — `isAccountRateLimited`、`isAccountBlocked`、`isAccountQuotaExceeded` 添加可选参数 + `getAllAccounts({ skipConcurrency })`
*   [upstreamErrorHelper.js] - 新增 `batchCheckTempUnavailable` pipeline 批量检查
*   [redis-upstash.js] — 新增 `batchGetConcurrency` pipeline 方法
*   [unifiedClaudeScheduler.js] — `_getAllAvailableAccounts` 全面改造：批量 temp\_unavailable、传入 account data、skipConcurrency、batchGetConcurrency（WORKER\_MODE 守卫）、Workers 模式跳过 checkQuotaUsage
*   [auth.js] — 限流检查 pipeline 化（2-3 子请求替代 5-9）+ 排队轮询上限（Workers 模式 5 次）

**设计方案交叉验证**：所有要求、约束、建议均已覆盖，包括写操作策略按 cron 覆盖分类、`activeTaskCount` 默认 `null`、`batchGetConcurrency` 的 `WORKER_MODE` 守卫等。

**预期效果**：典型场景子请求从 ~60-80 降至 ~15-22（无排队），~25-32（有排队），安全在 50 限制内。