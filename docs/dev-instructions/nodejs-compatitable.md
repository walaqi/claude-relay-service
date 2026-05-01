# Cloudflare Workers Node.js 兼容性指南

本文档总结了本项目在 Cloudflare Workers 部署中关于 Node.js 兼容性的所有关键知识，供后续开发参考。

## 核心配置

```toml
# wrangler.toml
compatibility_date = "2025-09-21"
compatibility_flags = ["nodejs_compat"]
```

- `nodejs_compat` 是综合性标志，一次性启用所有 Node.js 兼容功能
- `compatibility_date` 控制可用的功能集，应保持更新以获取最新能力
- 启用额外功能不会带来性能损失

## Workers 运行时原生支持的 Node.js 模块

以下模块由 Workers 运行时原生实现（TypeScript + C++），无需 polyfill：

| 模块 | 实现方式 | 备注 |
|------|----------|------|
| `node:http` / `node:https` | 客户端基于 Fetch API，服务端基于 Workers 请求处理 | Express/Koa 可直接运行 |
| `node:fs` | 虚拟内存文件系统 | 临时性，不跨请求持久化（Durable Objects 中可跨请求共享） |
| `node:crypto` | 基于 ncrypto + BoringSSL | 与 Node.js (OpenSSL) 可能有细微差异 |
| `node:net` / `node:tls` | 基于 Workers Sockets API | 仅客户端；`net.createServer()` 尚不支持 |
| `node:dns` | 基于 Cloudflare 1.1.1.1 DoH | 无需配置 DNS 服务器 |
| `node:zlib` | 原生实现 | 包含 Brotli 支持 |
| `node:timers` | 原生实现 | 支持 Timeout 对象 |
| `node:process` | 原生实现 | `process.env` 可在顶层作用域访问 |
| `node:console` | 原生实现 | 对 `globalThis.console` 的轻量封装 |
| `node:stream` / `node:buffer` / `node:url` / `node:util` / `node:events` | 原生实现 | — |

### 未原生支持 / 状态不明的模块

| 模块 | 状态 | 本项目处理方式 |
|------|------|----------------|
| `node:tty` | **不支持** | esbuild 插件内联 stub（`isatty: () => false`） |
| `node:child_process` | 不适用 | 标记为 external，运行时提供 non-functional stub |
| `node:cluster` | 不适用 | 同上 |
| `node:vm` | 部分支持 | 同上 |
| `node:worker_threads` | 不适用 | 同上 |

## 构建架构（esbuild）

构建脚本：`scripts/build-worker.js`

### 为什么需要 banner require shim

**已验证结论：Workers 运行时的 `require()` 不在 ESM 模块作用域中可用。**

esbuild 以 `format: 'esm'` 输出 bundle，内部 CJS 代码（Express 及其依赖链）被转换为 `__require()` 调用。esbuild 生成的 `__require` helper 检查 `typeof require !== "undefined"`，在标准 ESM 作用域中 `require` 是 `undefined`，会 fallback 到抛异常。

banner shim 的作用：
1. 通过静态 ESM `import` 预加载所有 Node builtins（`import __nb_path from 'node:path'` 等）
2. 定义一个 `const require` 函数，将 `node:*` ID 映射到预加载的模块
3. esbuild 的 `__require` 检测到 `require` 存在，自动委托给它

```
__require("node:path") → Proxy → banner require("node:path") → __nb_path (ESM import)
```

**移除 banner 的尝试已失败**（2025-09-21 compat date 下测试），报错：
```
Error: Dynamic require of "node:path" is not supported
```

### esbuild 配置要点

```js
{
  platform: 'node',      // 让 esbuild 识别 Node.js 内置模块
  format: 'esm',         // Workers 要求 ESM 格式
  target: 'esnext',
  external: ['cloudflare:node', ...nodeBuiltins.map(m => `node:${m}`)],  // 不打包，由运行时提供
  alias: { fs: 'node:fs', ... },  // bare name → node: prefix 统一化
  banner: { js: requireShim },     // 必须：提供 require 函数
  define: {
    __dirname: '"/worker"',         // ESM 没有这些 CJS 全局变量
    __filename: '"/worker/worker.js"'
  }
}
```

### 三个 esbuild 插件

#### 1. `redis-redirect`
将 `require('./models/redis')` 重定向到 `./models/redis-factory.js`，实现 Workers 模式用 Upstash REST、Node.js 模式用 ioredis 的切换。

#### 2. `workers-node-stubs`
为 Workers 不支持的 Node 模块提供内联 stub。当前仅 `tty`：
```js
{ isatty: () => false, ReadStream: class {}, WriteStream: class {} }
```
`debug` 包（Express 依赖链）顶层调用 `require('tty').isatty()`，没有 stub 会崩溃。

如果未来遇到其他 `No such module "node:X"` 错误，用同样模式添加到 `stubs` 对象。

#### 3. `workers-incompatible-externals`
为依赖 TCP socket / 文件系统写入等 Workers 不支持能力的包提供 Proxy stub：
- `ioredis` — TCP socket（用 Upstash REST 替代）
- `winston` / `winston-daily-rotate-file` — 文件系统写入（用 console.log 替代）
- `ldapjs` — TCP/TLS socket
- `socks-proxy-agent` / `https-proxy-agent` — TCP socket
- `node-cron` — setInterval（用 Workers Cron Triggers 替代）
- `nodemailer` — SMTP socket

## Workers 运行时限制

### 全局作用域限制
- `setInterval` / `setTimeout` 在模块顶层作用域（全局作用域）中**禁止调用**
- 原因：Workers 是请求驱动模型，无持久进程
- 处理方式：所有 account service 中的 `setInterval` 已用 `if (process.env.WORKER_MODE !== 'true')` 包裹
- 定时任务改用 Workers Cron Triggers（`wrangler.toml` 中的 `[triggers].crons`）

### HTTP Server
- `http.createServer()` 需要 `compatibility_date >= 2025-09-01`（对应 `enable_nodejs_http_server_modules` 标志）
- 使用 `httpServerHandler()` from `cloudflare:node` 将 Express app 与 Workers fetch 事件集成：
```js
import { httpServerHandler } from 'cloudflare:node'
const handler = httpServerHandler({ port: 3000 })
export default {
  async fetch(request, env, ctx) {
    return handler.fetch(request, env, ctx)
  }
}
```

### CJS/ESM 互操作
- `helmet` 等包的 ESM default export 被 esbuild 包装为 `{ default: fn }` namespace 对象
- 需要手动处理：`const m = require('helmet'); return typeof m === 'function' ? m : m.default`

### Redis
- Workers 模式使用 Upstash REST API（`@upstash/redis`），不使用 ioredis（TCP socket）
- `redis-factory.js` 根据 `WORKER_MODE` 环境变量选择实现
- Upstash `hgetall` 返回值类型可能与 ioredis 不同（布尔值 vs 字符串），`_parseApiKeyData` 需保持返回字符串以兼容现有代码

### 文件系统
- `node:fs` 提供虚拟内存文件系统，临时性，不跨请求持久化
- 适合临时文件操作，不适合持久化存储

## 兼容性标志细粒度控制

可单独启用/禁用特定模块：

| 模块 | 启用标志 | 禁用标志 |
|------|----------|----------|
| `node:fs` | `enable_nodejs_fs_module` | `disable_nodejs_fs_module` |
| `node:http` (server) | `enable_nodejs_http_server_modules` | `disable_nodejs_http_server_modules` |
| `node:os` | `enable_nodejs_os_module` | `disable_nodejs_os_module` |
| `node:zlib` | `nodejs_zlib` | `no_nodejs_zlib` |
| `process.env` | `nodejs_compat_populate_process_env` | `nodejs_compat_do_not_populate_process_env` |
| `require()` 行为 | `require_returns_default_export` | `require_returns_namespace` |

通常不需要单独控制，`nodejs_compat` 综合标志已足够。

## 故障排查

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `No such module "node:tty"` | Workers 不提供 tty 模块 | 在 `workers-node-stubs` 插件中添加 stub |
| `Dynamic require of "node:X" is not supported` | banner require shim 缺失或未覆盖该模块 | 确保模块在 `nodeBuiltins` 数组和 `external` 中 |
| `Disallowed operation called within global scope` | 全局作用域调用了 setInterval 等 | 用 `if (WORKER_MODE !== 'true')` 包裹 |
| `http.createServer is not implemented` | compatibility_date 过旧 | 更新到 >= `2025-09-01` |
| `WRONGTYPE Operation against a key` | Upstash 与 ioredis 数据类型不一致 | 检查 Redis key 类型，确保 parse 函数返回正确类型 |
| `helmet is not a function` | CJS/ESM default export 互操作问题 | 使用 `typeof m === 'function' ? m : m.default` |

## 参考资料

- [Cloudflare 官方博客：A year of improving Node.js compatibility](https://blog.cloudflare.com/nodejs-workers-2025/)
- [Cloudflare Workers Node.js 兼容性文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [兼容性标志完整列表](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
