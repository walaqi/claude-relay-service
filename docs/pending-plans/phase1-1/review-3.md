# 第三轮评审意见

## 评审摘要

第二轮提出的 D1-D8 全部得到回应，方案已接近实施就绪。本轮无严重或重要问题，仅剩少量实施细节需要在 PoC 阶段确认。

---

## 已确认解决的第二轮问题

| 编号 | 问题 | 处置 | 状态 |
|------|------|------|------|
| D1 | ESM/CJS 混用 | worker.js 改用 `createRequire(import.meta.url)` 桥接，纳入 PoC 验证 | ✅ |
| D2 | Logger 兼容接口不完整 | 改用 Proxy 通用 fallback + 显式实现 `timer`/`getStats`/`healthCheck` 等 | ✅ |
| D3 | redis-upstash.js 范围 | 明确只实现 Workers 代码路径子集，未实现方法抛明确错误，描述了静态分析方法 | ✅ |
| D4 | import 路径变更策略 | 选择 esbuild alias，添加 `[build]` 配置和 `build-worker.js` 示例 | ✅（有细节待验证，见 M1） |
| D5 | PoC 缺 Redis 测试 | 补充 4 项 Upstash 验证（set/get、pipeline、EVAL、延迟基准） | ✅ |
| D6 | 租约 TTL 值 | 调至 60-90s，增加 `ctx.waitUntil()` 定期续期兜底（每 20s） | ✅ |
| D7 | Cron Trigger 数量限制 | 风险 #6 补充 Paid 计划要求 | ✅ |
| D8 | Tunnel 降级方案 | 末尾补充完整说明 | ✅ |

---

## 剩余微调项

以下均为实施细节级别，可在 PoC 阶段顺带验证，不阻塞方案定稿。

### M1. esbuild alias 对相对路径 require 的适用性

方案中 esbuild alias 配置为：
```js
alias: { '../models/redis': '../models/redis-factory' }
```

esbuild 的 `alias` 选项匹配的是 import specifier 字符串。但项目中不同文件对 `redis.js` 的 require 路径不同（`../models/redis`、`../../models/redis`、`./redis` 等），单一 alias 无法覆盖所有变体。

**建议**：PoC 阶段验证 alias 是否生效。如果不行，改用 esbuild resolve plugin：
```js
plugins: [{
  name: 'redis-redirect',
  setup(build) {
    build.onResolve({ filter: /models\/redis$/ }, (args) => ({
      path: args.path.replace(/models\/redis$/, 'models/redis-factory'),
      ...
    }))
  }
}]
```
或者更简单的方案：将 `redis-factory.js` 的内容直接写入一个 `redis-worker.js`，构建时用文件替换（`cp redis-worker.js redis.js`）而非 alias。

### M2. wrangler.toml 的 cron 表达式与映射表不一致

wrangler.toml 中定义了 4 个 cron 表达式：
```
*/1, 0 *, */5, */10
```

但 Phase 4.1 映射表中还有：
- `0 0 * * *`（每日定价更新）
- 账户测试调度（"按原配置转换"，cron 表达式未确定）

wrangler.toml 缺少这两项。建议同步补齐，或在映射表中注明"定价数据更新合并到 `0 * * * *` 的每小时任务中按条件判断执行"。

### M3. `handleScheduledTask` 函数未定义

worker.js 中引用了 `handleScheduledTask(event.cron)` 但未给出定义或描述。建议补充调度逻辑的骨架，说明如何根据 `event.cron` 分发到对应任务函数，以及这些任务函数如何访问已初始化的服务实例（Redis、pricingService 等）。

示意：
```js
async function handleScheduledTask(cron) {
  // 服务实例通过 app-worker 模块加载时已初始化，可直接 require
  const redis = require('./models/redis-factory')
  switch (cron) {
    case '*/1 * * * *': return cleanupConcurrency(redis)
    case '0 * * * *': return cleanupExpiredKeys(redis)
    // ...
  }
}
```

### M4. `scripts/build-worker.js` 未列入文件清单

Phase 2.1 引入了 `scripts/build-worker.js` 作为自定义构建脚本，但"需要修改的文件清单"中未列出。

---

## 评审结论

经过三轮评审，方案已从最初的概要级设计演进为可执行的实施方案：

- 第一轮：识别了 4 个严重问题（其中 3 个经验证后撤销）、5 个重要问题、3 个 Phase 0 修正点
- 第二轮：确认所有第一轮问题已解决，补充了 8 个实施细节
- 第三轮：确认所有第二轮细节已解决，仅剩 4 个微调项（M1-M4），均可在 PoC 阶段顺带处理

**方案可以进入实施阶段。** 建议按方案的执行顺序推进：Phase 0 先行 → Phase 1 PoC 验证（同时验证 M1）→ 通过后 Phase 2-5 按序执行。
