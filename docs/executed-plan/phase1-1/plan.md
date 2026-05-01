# Cloudflare 部署方案

## Context

用户希望将 Claude Relay Service 部署到 Cloudflare。Cloudflare 近期发布了 `node:http` / `node:https` 兼容层（需 `nodejs_compat` flag + compatibility_date > 2025-08-15），使 Express 应用可以直接运行在 Workers 上。

本方案采用**分阶段混合部署**策略：管理前端上 Pages，核心 API 中转上 Workers，后台任务保留 Node.js。

## 方案概览

```
管理员 → Cloudflare Pages (Vue SPA 静态托管)
              ↓ API 请求通过 _redirects 代理
客户端 → Cloudflare Workers (API 中转)
              ↓
         Upstash Redis (HTTP)
              ↓
         上游 AI API (Claude/Gemini/OpenAI)

后台任务 → 原 Node.js 服务器
              ↓
         同一个 Upstash Redis
```

## 已知限制

### 代理能力（SOCKS5/HTTPS Proxy）不可用

Workers 的 `node:http` 兼容层中 `Agent` API 为 no-op（连接池由 Cloudflare 基础设施自动管理）。这意味着 `https-proxy-agent` 和 `socks-proxy-agent` 通过继承 `http.Agent` 重写 `createConnection()` 建立代理隧道的方式**在 Workers 上静默失效**——请求直接从 Cloudflare 边缘节点发出，不经过用户配置的代理。

`src/utils/proxyHelper.js`（272 行）的全部功能在 Workers 上失效：SOCKS5 代理、HTTPS 代理、连接池配置。

**处置**：
- `proxyHelper.js` 中添加 Workers 模式检测，跳过代理配置并记录警告
- 对于不依赖代理的用户，Workers 部署可正常工作
- 依赖代理出站的用户应继续使用 Node.js 部署

---

## Node.js 兼容性验证矩阵

方案中每项 Node.js 兼容性声明均需提供依据、Setup 方案和验证手段。

### C1. Express 桥接（`handleAsNodeRequest`）

- **依据**：[Bringing Node.js HTTP servers to Workers](https://blog.cloudflare.com/bringing-node-js-http-servers-to-cloudflare-workers/) — 需 `nodejs_compat` + `compatibility_date > 2025-08-15`。Express、Koa 已验证。`Agent` 为 no-op；TLS 由 Workers 自动处理；Trailers / 1xx 不支持。
- **Setup**：`wrangler.toml` 设置 `compatibility_date = "2025-08-16"` + `compatibility_flags = ["nodejs_compat"]`。`worker.js` 使用 `handleAsNodeRequest`（而非 `httpServerHandler`），以便同时挂载 `scheduled` handler 处理 Cron Triggers。
- **验证**：创建最小 Express app（3 路由：健康检查、echo JSON、SSE 流式响应），`wrangler dev` 本地运行，curl 验证三个路由均正常。

### C2. `node:https` 出站请求

- **依据**：[A year of improving Node.js compatibility (2025-09)](https://blog.cloudflare.com/nodejs-workers-2025/) — `node:https` 客户端基于 Fetch API 构建。`Agent` 为 no-op。
- **Setup**：`claudeRelayService.js` 和 `droidRelayService.js` 的 `https.request()` 调用无需重写。`agent` 参数会被静默忽略（关联代理限制）。需验证 `timeout` / `socket` 事件差异。
- **验证**：`wrangler dev` 下发起 `https.request()` 到 `https://httpbin.org/post`，验证请求成功、响应体正确解析、SSE 流式 chunk 逐块到达。

### C3. `node:zlib` 压缩/解压

- **依据**：[Cloudflare Docs: node:zlib](https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/) — 完整 API 支持（gzip、deflate、brotli），需 `nodejs_compat` + `compatibility_date >= 2024-09-23`。
- **Setup**：`claudeRelayService.js` 使用 `gunzipSync`、`inflateSync`、`createGunzip`、`createInflate`，均已获原生支持，无需改动。
- **验证**：最小脚本验证：(1) `zlib.gzipSync` + `zlib.gunzipSync` 往返；(2) `https.request()` 请求 gzip 编码端点，通过 `zlib.createGunzip()` 管道解压，验证输出完整。

### C4. `process.env` + `dotenv` 静默降级

- **依据**：[A year of improving Node.js compatibility (2025-09)](https://blog.cloudflare.com/nodejs-workers-2025/) — `process.env` 在任意作用域可用，值从 Workers env 绑定填充。虚拟文件系统中无 `.env` 文件。
- **Setup**：非敏感变量通过 `wrangler.toml` 的 `[vars]` 设置；敏感变量通过 `wrangler secret put`。`dotenv.config()` 无需移除，会因虚拟 FS 中无 `.env` 文件而静默跳过。`config/config.js` 中 `path.join(__dirname, '..', 'logs')` 等路径构造在虚拟 FS 下不会崩溃，但目录不存在。
- **验证**：`wrangler dev` 下：(1) `wrangler.toml` 设置 `[vars] TEST_VAR = "hello"`，验证 `process.env.TEST_VAR === 'hello'`；(2) `require('dotenv').config()` 不抛异常；(3) `process.env.WORKER_MODE` 可在模块顶层赋值并被后续模块读取。

### C5. `node:fs` 虚拟文件系统

- **依据**：[A year of improving Node.js compatibility (2025-09)](https://blog.cloudflare.com/nodejs-workers-2025/) — 提供临时内存 FS，支持读写、目录操作。无状态 Worker 中文件不跨请求持久化。
- **Setup**：见下方"Workers 模式 fs 策略"章节，逐一处置所有 fs 调用点。
- **验证**：`wrangler dev` 下：(1) `fs.existsSync('/nonexistent')` 返回 `false` 而非抛异常；(2) `fs.mkdirSync` + `fs.writeFileSync` + `fs.readFileSync` 在同一请求内往返成功；(3) 确认跨请求文件不持久化。

### C6. `compression` 中间件

- **依据**：`node:zlib` 已支持（C3），但 `compression` npm 包还依赖 `node:stream` 的 Transform 流与 Express `res` 对象的交互。
- **Setup**：两个选项：(1) 保留 `compression`，依赖 Workers 的 node:stream 兼容层；(2) Workers 模式下移除，依赖 Cloudflare 边缘自动压缩。**推荐选项 2**——Cloudflare 边缘压缩更高效，减少一个兼容性风险点。
- **验证**：PoC Express app 中启用 `compression`，发送 `Accept-Encoding: gzip` 请求验证。如果失败，确认移除后 Cloudflare 边缘压缩自动生效。

### C7. SSE 流式响应完整性

- **依据**：[Bringing Node.js HTTP servers to Workers](https://blog.cloudflare.com/bringing-node-js-http-servers-to-cloudflare-workers/) 列出 "Streaming responses" 为已支持，但未详细说明 SSE + `res.write()` 逐块推送 + 长连接保持的具体行为。
- **Setup**：核心路径：上游 AI API → SSE chunk → `res.write(chunk)` → 客户端。需确认 Workers 桥接层不会缓冲整个响应后再发送。
- **验证**：创建 SSE 端点，每 100ms `res.write('data: ...\n\n')`，持续 5 秒后 `res.end()`。客户端验证：(1) 首个 chunk 在 200ms 内到达（非 5 秒后一次性到达）；(2) 所有 chunk 按序完整接收；(3) 客户端中途断开时服务端能感知（`req.on('close')`）。

---

## Phase 0: 管理后台部署到 Cloudflare Pages（可独立完成，半天工作量）

管理后台 `web/admin-spa/` 是纯 Vue 3 + Vite 5 SPA，无 SSR，构建产出静态文件，天然适合 Pages。

### 0.1 当前前端架构要点

- 路由模式：`createWebHistory` (HTML5 history mode)，需要 SPA fallback
- 生产环境 base path：`/admin-next/`（`.env.production` 中 `VITE_APP_BASE_URL=/admin-next/`）
- Fallback base path：`/web/admin/`（`tools.js` 行 3，当 `VITE_APP_BASE_URL` 未设置时）
- API 调用：生产环境 `baseURL` 为空字符串，即同源请求
- 构建命令：`cd web/admin-spa && npm install && npm run build`，产出 `dist/`

### 0.2 Pages 环境变量配置

**不使用 `.env.pages` 文件**（Vite 不会自动加载自定义 mode 文件，需要 `--mode pages` 参数且容易出错）。改为在 Cloudflare Pages Dashboard 的环境变量中直接设置：

| 环境变量 | 值 |
|----------|-----|
| `VITE_APP_BASE_URL` | `/` |
| `VITE_APP_TITLE` | `Claude Relay Service - 管理后台` |
| `NODE_VERSION` | `18` |

构建命令中也显式传入作为双重保障（防止 Dashboard 配置丢失时 fallback 到 `/web/admin/`）：

```bash
cd web/admin-spa && npm install && VITE_APP_BASE_URL=/ npx vite build
```

### 0.3 创建 `web/admin-spa/public/_redirects`

处理 SPA history mode fallback + API 请求代理到后端。

管理后台 API 调用主要走 `/admin/*` 前缀。需确认是否有其他路径：

```
# 管理后台 API 代理到后端
/admin/*  https://YOUR_BACKEND_DOMAIN/admin/:splat  200
/api/*  https://YOUR_BACKEND_DOMAIN/api/:splat  200
/users/*  https://YOUR_BACKEND_DOMAIN/users/:splat  200

# SPA fallback — 所有未匹配路径返回 index.html
/*  /index.html  200
```

`YOUR_BACKEND_DOMAIN` 替换为实际的 API 后端地址（Workers 域名或 Node.js 服务器地址）。

> 注意：如果后续发现管理前端还调用了 `/apiStats/*`、`/webhook/*` 等路径，需要补充对应的代理规则。实施前应 grep `web/admin-spa/src/` 中所有 API 调用路径确认完整性。

### 0.4 Cloudflare Pages 项目配置

| 配置项 | 值 |
|--------|-----|
| 构建命令 | `cd web/admin-spa && npm install && VITE_APP_BASE_URL=/ npx vite build` |
| 构建输出目录 | `web/admin-spa/dist` |
| 根目录 | `/`（仓库根目录） |

### 0.5 manage.sh 集成

新增命令：
- `crs pages:deploy` — 构建并部署前端到 Cloudflare Pages
- `crs pages:setup` — 引导用户配置 Pages 项目和后端代理地址

### 0.6 CORS 注意事项

`_redirects` 的 200 代理规则对浏览器来说是同源的，**不需要额外 CORS 配置**。

---

## Phase 1: Workers 基础设施 + PoC 验证

### 1.1 创建 `wrangler.toml`

```toml
name = "claude-relay-service"
main = "src/worker.js"
compatibility_date = "2025-08-16"
compatibility_flags = ["nodejs_compat"]

[vars]
NODE_ENV = "production"
WORKER_MODE = "true"
# APP_VERSION 构建时注入，替代读取 VERSION 文件

# Secrets (通过 wrangler secret put 设置):
# JWT_SECRET, ENCRYPTION_KEY, REDIS_URL, REDIS_TOKEN

[triggers]
crons = [
  "*/1 * * * *",   # 并发计数器清理
  "0 * * * *",     # 过期 key 清理 + 每小时定价条件检查
  "*/5 * * * *",   # 速率限制清理 + 消息队列清理
  "*/10 * * * *",  # 定价哈希检查
  "0 0 * * *",     # 每日定价数据全量更新
]
# 账户测试调度的 cron 表达式需从 accountTestSchedulerService 的 node-cron 配置中提取
```

### 1.2 创建 Workers 入口 `src/worker.js`

使用 `handleAsNodeRequest`（而非 `httpServerHandler`），以便同时处理 `fetch` 和 `scheduled` 事件：

```js
import { handleAsNodeRequest } from 'cloudflare:node'
import { createRequire } from 'node:module'

// Workers 默认 ESM 模式，需要 createRequire 桥接 CJS 模块
const require = createRequire(import.meta.url)
const app = require('./app-worker')
app.listen(3000)

async function handleScheduledTask(cron) {
  const redis = require('./models/redis-factory')
  switch (cron) {
    case '*/1 * * * *':
      return require('./services/scheduler/concurrencyCleanup').run(redis)
    case '0 * * * *':
      return require('./services/scheduler/hourlyCleanup').run(redis)
    case '*/5 * * * *':
      await require('./services/rateLimitCleanupService').cleanup(redis)
      return require('./services/userMessageQueueService').cleanup(redis)
    case '*/10 * * * *':
      return require('./services/pricingService').checkHash()
    case '0 0 * * *':
      return require('./services/pricingService').updatePricing()
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleAsNodeRequest(3000, request)
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTask(event.cron))
  }
}
```

> **注意（D1）**：`worker.js` 为 ESM（使用 `import`），而 `app-worker.js` 及整个项目为 CJS（使用 `require`）。通过 `createRequire` 桥接。PoC 阶段需验证此混用模式可行（纳入 C1 验证）。

### 1.3 创建精简版入口 `src/app-worker.js`

从 `src/app.js` 派生，移除：
- 所有 `setInterval` / `setTimeout` 后台任务
- Winston 文件日志 → console（Phase 3）
- `fs.watchFile` / `fs.mkdirSync` 调用
- 静态文件服务（Vue SPA 已迁移到 Pages）
- LDAP 相关路由（`ldapjs` 依赖 `net`/`tls`，不兼容）
- Bedrock 相关路由（AWS SDK 兼容性待验证）
- `process.on('SIGTERM')` 优雅关闭
- `compression` 中间件（依赖 Cloudflare 边缘自动压缩）

保留：
- 核心 API 路由（Claude、Gemini、OpenAI 中转）
- Auth 中间件
- Redis 数据访问（通过适配层）

### 1.4 PoC 验证清单

在投入 Redis 适配等重工作前，先用最小 Express app 验证 C1-C7：

| 验证项 | 方法 | Pass 标准 |
|--------|------|-----------|
| Express 桥接 | 健康检查 + echo JSON 路由 | 200 响应，body 正确 |
| ESM/CJS 混用 | `import` + `createRequire` 加载 CJS 模块 | CJS 模块正常加载执行 |
| SSE 流式 | 每 100ms write chunk，持续 5s | 首 chunk < 200ms 到达，按序完整 |
| 客户端断开感知 | SSE 流中客户端 ctrl+c | `req.on('close')` 触发 |
| `https.request()` 出站 | 请求 httpbin.org | 响应正确解析 |
| zlib 管道 | gzip 请求 + `createGunzip()` 解压 | 输出完整 |
| `process.env` | `[vars]` 设置 + 读取 | 值正确 |
| `dotenv` 降级 | `require('dotenv').config()` | 不抛异常 |
| `fs` 虚拟 FS | `existsSync` / `mkdirSync` / `writeFileSync` | 行为符合预期 |
| `compression` 移除 | 不加中间件，发 gzip 请求 | Cloudflare 边缘自动压缩 |
| Upstash 基本连接 | `@upstash/redis` 的 `set` + `get` | 值正确往返 |
| Upstash pipeline | 3 个命令 pipeline 执行 | 返回值格式符合预期 |
| Upstash EVAL | 最简 Lua 脚本 `return 1` | 返回 1 |
| Upstash 延迟基准 | 10 次 `get` 平均耗时 | 记录基准值，评估 I2 优化需求 |

**如果 PoC 中 SSE 流式或 https.request() 出站失败，应停止 Workers 迁移，改用 Cloudflare Tunnel 方案。**

---

## Phase 2: Redis 适配层（关键路径，最大工作量）

### 2.1 架构设计：策略模式

不在 5304 行的 `redis.js` 内部做 if/else 分支，而是抽取接口，用策略模式提供两套实现：

```
src/models/
├── redis.js              # 现有文件，保持不变（ioredis 实现）
├── redis-upstash.js      # 新增：Upstash HTTP 实现，只实现 Workers 代码路径所需的方法子集
└── redis-factory.js      # 新增：根据 WORKER_MODE 选择实现并导出
```

**Import 路径变更策略（D4）**：选择 esbuild resolve plugin 方案——只在 Workers 构建时拦截所有 `models/redis` 结尾的 require 路径，重定向到 `redis-factory`。Node.js 模式完全不受影响，零改动现有 65+ 文件。

```toml
# wrangler.toml 追加
[build]
command = "node scripts/build-worker.js"
```

`scripts/build-worker.js` 使用 esbuild resolve plugin（M1：简单 alias 无法覆盖不同深度的相对路径如 `../models/redis`、`../../models/redis`、`./redis`）：

```js
const path = require('path')
require('esbuild').build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'redis-redirect',
    setup(build) {
      build.onResolve({ filter: /models\/redis$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path.replace(/models\/redis$/, 'models/redis-factory')),
      }))
    }
  }],
})
```

> 备选方案：如果 resolve plugin 过于复杂，可在构建前简单地 `cp redis-factory.js redis.js`（覆盖原文件），构建后 `git checkout redis.js` 恢复。PoC 阶段选择最可靠的方式。

**实现范围界定（D3）**：`redis-upstash.js` 不需要实现全部 143 个方法。实施前先确定 Workers 代码路径（核心 API 中转 + Auth）实际调用的 Redis 方法子集（预计 40-60 个）。未实现的方法抛出明确错误：

```js
throw new Error(`RedisUpstash: method '${name}' is not supported in Workers mode`)
```

确定子集的方法：从 `app-worker.js` 保留的路由和中间件出发，静态分析 require 链中所有 `redis.xxx()` 调用。

### 2.2 关键适配点

| 差异 | ioredis | @upstash/redis | 适配方案 |
|------|---------|----------------|----------|
| 连接方式 | TCP 持久连接 | HTTP 请求 | 策略模式切换 |
| `eval()` 参数 | `(script, numkeys, ...args)` | `(script, keys[], args[])` | 包装函数转换参数格式 |
| `pipeline().exec()` 返回值 | `[[err, result], ...]` | `result[]` | 归一化返回格式 |
| `scan()` MATCH/COUNT | 位置参数 | 命名参数 | 包装函数适配 |
| `hgetall()` 空值 | 返回 `{}` | 返回 `null` | 空值归一化为 `{}` |
| `set()` 选项 | `'EX', seconds` | `{ ex: seconds }` | 包装函数转换 |
| `multi()` 事务 | 完整 MULTI/EXEC | 支持但语义略有差异 | 逐一验证 |
| `client.duplicate()` | 创建新连接 | 不适用于 HTTP | Workers 模式下返回同一实例 |
| Pub/Sub | 支持 | 不支持 | Workers 模式下禁用 |

### 2.3 Lua 脚本处理

13 个 Lua 脚本（12 个在 `redis.js` + 1 个在 `app.js`）需逐一验证在 Upstash 上的兼容性。Upstash 支持 `EVAL`/`EVALSHA` 但有执行时间限制。

关键脚本：
- 并发控制（Sorted Set 原子操作）
- 使用量统计原子更新
- 速率限制计数器

### 2.4 认证热路径延迟优化

`src/middleware/auth.js` 单次请求最坏情况 15-20+ 次 Redis 调用。以 Upstash HTTP 延迟 5-15ms 计算，仅认证环节就需 75-300ms。

认证链中的调用存在依赖关系（先验证 Key → 检查权限 → 检查并发），无法简单 pipeline 化。

**优化策略**：
1. **请求级 Redis 结果缓存**：同一请求内对相同 key 的重复读取去重
2. **合并 Lua 脚本**：将 `apiKeyService.validateApiKey` 中的 4 个并行调用合并为单个 Lua 脚本
3. **Workers KV / Cache API 缓存**：API Key 验证结果短期缓存（TTL 30s），减少热路径 Redis 调用
4. **Pipeline 批量化**：对无依赖关系的并行调用使用 pipeline

---

## Phase 3: Workers 模式 fs 策略

核心原则：不需要任何外部文件存储方案（无 Google Drive、无远程磁盘 tunnel）。

### 3.1 日志写入 → console 输出

Workers 模式下 logger 切换为 console，跳过 `mkdirSync`。使用 Proxy 提供通用 fallback，覆盖所有 logger 方法（`info`、`error`、`warn`、`debug`、`success`、`start`、`request`、`api`、`database`、`performance`、`audit`、`authDetail` 等）：

```js
const isWorkerMode = () => process.env.WORKER_MODE === 'true'

if (isWorkerMode()) {
  const consoleLogger = (level) => (...args) => console.log(`[${level.toUpperCase()}]`, ...args)
  const handler = {
    get: (target, prop) => {
      if (prop in target) return target[prop]
      return consoleLogger(prop)
    }
  }
  module.exports = new Proxy({
    security: new Proxy({}, { get: (_, p) => consoleLogger(`SECURITY:${p}`) }),
    timer: () => ({ end: () => {} }),
    getStats: () => ({}),
    resetStats: () => {},
    healthCheck: () => ({ status: 'ok' }),
  }, handler)
} else {
  // 保持现有 Winston 逻辑不变
}
```

同样处理 `tokenRefreshLogger.js`。

### 3.2 数据持久化 → Redis/KV

| 数据 | 当前存储 | Workers 处置 |
|------|----------|-------------|
| 定价数据 | `data/model_pricing.json` + `.sha256` | 改存 Redis key 或 Cloudflare KV |
| 管理员凭据 | `data/init.json` | Redis 中已有副本，跳过 fs fallback |
| 版本号 | `VERSION` 文件 | 构建时注入 `wrangler.toml` 的 `[vars] APP_VERSION` |

`pricingService.js` 改动：
- Workers 模式下从 Redis/KV 读取定价数据
- 移除 `fs.watchFile()` 调用
- 定价更新改由 Cron Trigger 定期执行

### 3.3 调试 dump → 不设置环境变量即可

`anthropicGeminiBridgeService.js` 的 `appendFileSync` 仅当 `ANTHROPIC_DEBUG_TOOLS_DUMP` 环境变量启用时触发。Workers 模式不设置此变量，无需代码改动。

### 3.4 静态文件 / LDAP / 插件 → 构建排除或静默跳过

- Admin SPA 静态文件：Phase 0 已迁移到 Pages，Workers 构建移除此路由
- LDAP TLS 证书：Workers 构建排除 LDAP，不设置 `LDAP_TLS_*_FILE` 环境变量
- 运行时插件 `runtimeAddon.js`：目录不存在时已有 guard 静默跳过

---

## Phase 4: 后台任务完整映射

### 4.1 Cron Triggers 映射

| 原始任务 | 频率 | Cron 表达式 | 处理函数 |
|----------|------|-------------|----------|
| 并发计数器清理 (`app.js:712`) | 每 60s | `*/1 * * * *` | `cleanupConcurrency()` |
| 过期 key 清理 (`app.js:674`) | 每小时 | `0 * * * *` | `cleanupExpiredKeys()` |
| 速率限制清理 (`rateLimitCleanupService`) | 每 5 分钟 | `*/5 * * * *` | `cleanupRateLimits()` |
| 定价哈希检查 (`pricingService:137`) | 每 10 分钟 | `*/10 * * * *` | `checkPricingHash()` |
| 定价数据更新 (`pricingService:65`) | 每 24 小时 | `0 0 * * *` | `updatePricing()` |
| 消息队列清理 (`userMessageQueueService`) | 可配置 | `*/5 * * * *` | `cleanupMessageQueue()` |
| 账户测试调度 (`accountTestSchedulerService`) | node-cron 配置 | 按原配置转换 | `runAccountTests()` |

### 4.2 并发租约续期（特殊处理）

`auth.js` 行 935-969 的 `setInterval` 是请求生命周期内的定时器（每 N 秒续期并发租约），不能迁移到 Cron Trigger。

**替代方案**：使用 `ctx.waitUntil()` + TTL 自动过期机制：
- 并发租约 TTL 设为 **60-90s**（最大预期 chunk 间隔的 2-3 倍，AI 模型"思考"阶段可能有 10-30s 静默期，30s TTL 在极端情况下可能刚好过期）
- 每次 SSE chunk 到达时顺带续期（piggyback on I/O events）
- 兜底：在 `ctx.waitUntil()` 中启动定期续期 Promise（每 20s 续期一次），防止长静默期导致过期
- 如果请求异常中断，TTL 自动过期释放租约

---

## Phase 5: manage.sh 集成

### 5.1 新增 Cloudflare 命令

```
# Pages 命令
crs pages:setup    — 引导配置 Pages 项目和后端代理地址
crs pages:deploy   — 构建并部署前端到 Cloudflare Pages

# Workers 命令
crs cf:setup       — 安装 wrangler CLI，初始化配置
crs cf:deploy      — 部署到 Cloudflare Workers
crs cf:secret      — 设置 Workers secrets
crs cf:status      — 查看 Workers 部署状态
crs cf:logs        — 查看 Workers 实时日志（wrangler tail）
crs cf:delete      — 删除 Workers 部署
```

### 5.2 新增函数

- `cf_check_wrangler()` — 检查 wrangler CLI 是否安装
- `cf_setup()` — 引导用户配置 Cloudflare 账户和 Upstash Redis
- `cf_deploy()` — 执行 `wrangler deploy`
- `cf_set_secrets()` — 交互式设置 secrets
- `pages_setup()` — 引导 Pages 项目配置
- `pages_deploy()` — 构建并部署前端

---

## 需要修改的文件清单

### Phase 0 (Cloudflare Pages)
| 文件 | 操作 | 说明 |
|------|------|------|
| `web/admin-spa/public/_redirects` | 新建 | SPA fallback + API 代理规则 |
| `scripts/manage.sh` | 修改 | 添加 pages:* 命令 |
| `package.json` | 修改 | 添加 `pages:deploy` script |

### Phase 1-5 (Cloudflare Workers)
| 文件 | 操作 | 说明 |
|------|------|------|
| `wrangler.toml` | 新建 | Workers 配置 + Cron Triggers |
| `scripts/build-worker.js` | 新建 | esbuild 构建脚本（resolve plugin 重定向 redis） |
| `src/worker.js` | 新建 | Workers 入口（handleAsNodeRequest + scheduled） |
| `src/app-worker.js` | 新建 | 精简版 Application（从 app.js 派生） |
| `src/models/redis-upstash.js` | 新建 | Upstash HTTP Redis 实现 |
| `src/models/redis-factory.js` | 新建 | 运行时选择 Redis 实现 |
| `src/utils/logger.js` | 修改 | Workers 模式下用 console 替代 Winston |
| `src/utils/proxyHelper.js` | 修改 | Workers 模式检测，跳过代理配置 + 警告日志 |
| `src/services/pricingService.js` | 修改 | Workers 模式下从 Redis/KV 读取 |
| `src/middleware/auth.js` | 修改 | 并发租约续期改为 TTL 自动过期 |
| `scripts/manage.sh` | 修改 | 添加 cf:* 命令 |
| `package.json` | 修改 | 添加 @upstash/redis 依赖和 scripts |

---

## 风险和限制

1. **Upstash 延迟**：每次 Redis 操作 ~5-15ms HTTP 延迟，认证热路径累积可达 75-300ms。需通过 Phase 2.4 的优化策略缓解。
2. **CPU 时间限制**：Workers Paid 计划 30s CPU 时间。SSE 流式响应主要是 I/O 等待，CPU 占用低，但需实际负载测试验证。
3. **Lua 脚本兼容性**：Upstash 支持 EVAL 但有执行时间限制，13 个 Lua 脚本需逐一测试。
4. **AWS SDK 兼容性**：Bedrock 集成在 Workers 上未经验证，Phase 1 暂不迁移。
5. **代理不可用**：依赖 SOCKS5/HTTPS 代理出站的用户无法使用 Workers 部署（见"已知限制"章节）。
6. **需要 Cloudflare Workers Paid 计划**：Free 计划 CPU 时间限制 10ms，远不够用；Cron Triggers 数量限制也更严格（Free 5 个 vs Paid 更多）。本方案假设使用 Paid 计划。

---

## 验证策略

1. **Phase 1 PoC**：`wrangler dev` 验证 C1-C7 兼容性矩阵（见 1.4 清单）
2. **Redis 适配测试**：编写测试用例覆盖 13 个 Lua 脚本和关键操作在 Upstash 上的行为
3. **流式响应端到端**：向 Workers 发送实际 Claude API 中转请求，验证 SSE 完整性
4. **延迟基准测试**：测量认证热路径的 Redis 调用延迟，确认优化后可接受
5. **负载测试**：并发请求测试 CPU 时间消耗，确认不超限
6. **回归测试**：确保 Node.js 部署模式不受影响（`npm test`）

---

## 工作量估算

| 阶段 | 预估时间 |
|------|----------|
| Phase 0: Cloudflare Pages（管理前端） | 0.5 天 |
| Phase 1: Workers 基础设施 + PoC 验证 | 1-2 天 |
| Phase 2: Redis 适配层（策略模式 + 延迟优化） | 4-6 天 |
| Phase 3: fs 策略 + 日志适配 | 1-1.5 天 |
| Phase 4: 后台任务完整映射 | 1.5-2 天 |
| Phase 5: manage.sh 集成 | 1 天 |
| 测试和调试 | 2-3 天 |
| **总计** | **11.5-16 天** |

---

## 建议的执行顺序

1. **Phase 0 先行**（独立、低风险、立即收益）
2. **Phase 1 PoC 验证**（决定是否继续 Workers 路线）
3. 如果 PoC 通过 → Phase 2-5 按序执行
4. 如果 PoC 失败 → 转向 Cloudflare Tunnel 方案

**Cloudflare Tunnel 降级方案**：在 Node.js 服务器上运行 `cloudflared` 守护进程，将本地端口通过加密隧道暴露到 Cloudflare 边缘网络。无需任何代码改动，获得 DDoS 防护、CDN、自定义域名和自动 HTTPS。但服务器仍需自行维护，不享受 Workers 的无服务器弹性和全球边缘部署优势。适合作为 Workers 迁移不可行时的务实替代方案。
