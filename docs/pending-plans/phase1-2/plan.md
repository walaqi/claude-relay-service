# Plan: 用 impit 替换 axios 绕过 Cloudflare TLS 指纹检测

## Context

项目中 OAuth token 交换、token 刷新、profile 获取等请求被 Cloudflare 拦截（HTTP 403，返回 challenge HTML）。根本原因是 Node.js 的 TLS 指纹（JA3/JA4）与真实浏览器差异大，被 Cloudflare bot management 识别。

方案：用 `impit`（Rust 原生绑定，模拟 Chrome TLS 指纹）替换这些调用中的 axios，其余 axios 用法不变。

---

## 1. 新建 `src/utils/tlsFetchClient.js`

封装 impit 的 fetch API 为 axios 兼容的 `get()`/`post()` 接口。

### impit 实际 API（fetch 风格，非 axios 风格）

```js
const { Impit } = require('impit')
const client = new Impit({ browser: 'chrome', proxyUrl: 'socks5://...', timeout: 30000 })
const response = await client.fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
  redirect: 'manual'  // 对应 maxRedirects: 0
})
// response.ok, response.status, response.headers (Headers 对象)
const json = await response.json()
```

关键差异：无 get/post 方法、body 需手动 JSON.stringify、非 2xx 不自动抛错、headers 是 Headers 对象。

### wrapper 设计

**`post(url, data, options)` / `get(url, options)`**

内部流程：
1. 将 `options.proxyConfig` 转为 proxyUrl 字符串（见代理转换）
2. 创建 `new Impit({ browser: 'chrome', proxyUrl, timeout: options.timeout })`
3. 构建 fetch init：
   - `method`: GET 或 POST
   - `headers`: options.headers（**不传 User-Agent**，让 impit 使用 Chrome UA）
   - `body`: POST 时 `JSON.stringify(data)`
   - `redirect`: options.maxRedirects === 0 时设为 `'manual'`，否则不传（默认 follow）
4. 调用 `client.fetch(url, init)`
5. 响应标准化：
   - 安全解析 body：`const text = await response.text()`，然后 `try { data = JSON.parse(text) } catch { data = text }`（避免 `response.json()` 失败后 body stream 已消费导致 `response.text()` 也失败）
   - `const headers = Object.fromEntries(response.headers.entries())` — 转为普通对象
   - 返回 `{ status: response.status, data, headers }`
6. 状态码检查：`!response.ok` 时构造 Error 并附加 `error.response = { status, data, headers, statusText }`
7. 网络错误捕获：impit 原生错误（无 response）构造 Error 并附加 `error.request = true`

### User-Agent 策略

**绕 Cloudflare 的请求不传自定义 UA**。impit `browser: 'chrome'` 会自动设置匹配 Chrome TLS 指纹的 UA。如果在 headers 中传 `claude-cli/1.0.56`，会覆盖 Chrome UA，导致 TLS 指纹与 UA 不匹配，反而更容易被检测。

调用方传入的 headers 中如果包含 `User-Agent`，wrapper 应自动移除它（case-insensitive 匹配，`k.toLowerCase() !== 'user-agent'`，避免遗漏大小写变体）。

### 代理 URL 转换 `buildProxyUrl(proxyConfig)`

输入可能是对象或 JSON 字符串（`typeof proxyConfig === 'string'` 时先 `JSON.parse`）。

| proxy.type | impit proxyUrl |
|---|---|
| `socks5` | `socks5://user:p%40ss@host:port` |
| `http` | `http://user:p%40ss@host:port` |
| `https` | `https://user:p%40ss@host:port` |

注意：项目 proxyHelper 使用 `socks5h://`（远端 DNS），但 impit 文档仅列出 SOCKS5 支持，未提及 `socks5h`。使用 `socks5://` — impit 底层 Rust 库（reqwest）的 SOCKS5 实现默认就是远端 DNS 解析，行为等同 `socks5h`。

username/password 用 `encodeURIComponent()` 编码。proxyConfig 为 null 或缺少必要字段时返回 undefined（直连）。

### Fallback 策略

三层 fallback：

1. **加载失败**：`require('impit')` 抛错 → 设 `impitAvailable = false`，log 一次警告，所有后续请求走 axios。fallback 路径调用 `ProxyHelper.createProxyAgent(proxyConfig)` 创建 agent，用 axios 发请求（恢复原有代理模式）。`tlsFetchClient.js` 顶层同时 import axios 和 ProxyHelper（不懒加载），确保 fallback 随时可用。`package.json` 中 axios 依赖保留（relay service 等仍在使用）。
2. **请求时非 HTTP 错误**：impit 加载成功但请求时原生崩溃（无 response 的异常）→ 该次请求 fallback 到 axios 并 log 警告。
3. **HTTP 错误不 fallback**：403 等正常抛出（axios 也会被拦截，fallback 无意义）。

---

## 2. 修改 `src/utils/oauthHelper.js`（4 处）

替换 import：`const axios = require('axios')` → `const tlsFetchClient = require('./tlsFetchClient')`。axios import 完全移除（4 处调用全在替换范围内，无其他 axios 用法）。

| 函数 | 方法 | URL | 特殊处理 |
|------|------|-----|----------|
| `exchangeCodeForTokens` | POST | `console.anthropic.com/v1/oauth/token` | — |
| `exchangeSetupTokenCode` | POST | `console.anthropic.com/v1/oauth/token` | — |
| `getOrganizationInfo` | GET | `claude.ai/api/organizations` | `maxRedirects: 0` |
| `authorizeWithCookie` | POST | `claude.ai/v1/oauth/{org}/authorize` | `maxRedirects: 0` |

每处改动：
- 移除 `const agent = createProxyAgent(proxyConfig)` 和 `if (agent) { httpAgent/httpsAgent/proxy }` 块
- 移除 headers 中的 `User-Agent`（让 impit 用 Chrome UA）
- `axios.post(url, data, config)` → `tlsFetchClient.post(url, data, { headers, timeout, proxyConfig })`
- `axios.get(url, config)` → `tlsFetchClient.get(url, { headers, timeout, proxyConfig, maxRedirects: 0 })`
- 错误处理不变（wrapper 保持 `error.response` / `error.request` 结构）

`createProxyAgent` 辅助函数保留导出（其他文件可能引用），但本文件不再调用。

**注意**: 经查无外部文件导入 `createProxyAgent`，可安全移除导出，但保留函数体也无害。

---

## 3. 修改 `src/services/account/claudeAccountService.js`（3 处）

替换 import：`const axios = require('axios')` → `const tlsFetchClient = require('../../utils/tlsFetchClient')`

该文件只有 3 处 axios 调用，全部是 OAuth 相关，可完全移除 axios import。

| 方法 | HTTP | URL |
|------|------|-----|
| `refreshAccountToken` | POST | `console.anthropic.com/v1/oauth/token` |
| `fetchOAuthUsage` | GET | `api.anthropic.com/api/oauth/usage` |
| `fetchAndUpdateAccountProfile` | GET | `api.anthropic.com/api/oauth/profile` |

### 接口变更：agent → proxyConfig

当前 `refreshAccountToken` 创建 agent 后传给 `fetchAndUpdateAccountProfile(accountId, accessToken, agent)`。替换后：

- `fetchAndUpdateAccountProfile` 签名保持 `(accountId, accessToken = null, agent = null)` 不变（向后兼容），但 `agent` 参数不再使用
- 方法内部改为从 `accountData.proxy` 读取代理配置，传给 `tlsFetchClient`
- `fetchOAuthUsage` 同理：忽略 agent 参数，从 accountData.proxy 读取
- `refreshAccountToken` 中移除 `_createProxyAgent` 调用，调用 `fetchAndUpdateAccountProfile(accountId, access_token)` 时不再传 agent
- `createAccount` 中同样移除 `_createProxyAgent` 调用（行 221-222），直接 `await this.fetchAndUpdateAccountProfile(accountId, claudeAiOauth.accessToken)`（不传 agent）

每处改动：
- 移除 `const agent = this._createProxyAgent(accountData.proxy)` 和 agent 赋值块
- 移除 headers 中的 `User-Agent`
- `axios.post/get(url, config)` → `tlsFetchClient.post/get(url, data, { headers, timeout, proxyConfig: accountData.proxy })`

`_createProxyAgent` 方法保留在类中（其他方法可能使用）。

---

## 4. 不修改的文件

- `src/services/relay/claudeConsoleRelayService.js` — 消息转发，保持 axios
- 其他所有 relay service、route、middleware — 不涉及

---

## 5. 安装依赖

```bash
npm install impit
```

impit 提供 linux-x64-gnu、linux-x64-musl（Alpine Docker）、darwin-arm64、win32-x64 预编译二进制，无需编译。

---

## 6. 实施顺序

1. `npm install impit`
2. 新建 `src/utils/tlsFetchClient.js`
3. 修改 `src/utils/oauthHelper.js` — 4 处 axios 调用
4. 修改 `src/services/account/claudeAccountService.js` — 3 处 axios 调用
5. 格式化：`npx prettier --write src/utils/tlsFetchClient.js src/utils/oauthHelper.js src/services/account/claudeAccountService.js`
6. `npm run lint` + `npm test`
7. 手动冒烟测试 OAuth 流程

---

## 7. 验证

- Cookie 授权流程（`oauthWithCookie`）
- OAuth 授权码交换（`exchangeCodeForTokens`）
- Token 刷新（`refreshAccountToken`）
- Profile 获取（`fetchAndUpdateAccountProfile`）
- 确认 relay 服务不受影响：`grep -n 'require.*axios' src/services/relay/`

---

## 关键文件

- `src/utils/tlsFetchClient.js` — **新建**，impit wrapper
- `src/utils/oauthHelper.js` — 修改 4 处 axios 调用
- `src/services/account/claudeAccountService.js` — 修改 3 处 axios 调用
- `src/utils/proxyHelper.js` — 参考代理格式，fallback 时复用 `createProxyAgent`
- `package.json` — 添加 impit 依赖


## 重点关注

impit 是 Rust 原生绑定（.node 二进制），无法在 Workers V8 isolate 中运行。但这不是问题：

Worker 模式下不需要 impit。 Cloudflare Workers 的 fetch() 是 Cloudflare 自己的实现，TLS 握手发生在 Cloudflare 边缘节点，JA3/JA4 指纹是 Cloudflare 的，不是 Node.js 的。导致 403 的根本原因（Node.js TLS 指纹被识别为非浏览器）在 Worker 环境中不存在。

所以当前的 fallback 设计恰好是正确的分工：

Node.js 模式：impit 加载成功 → 用 Chrome TLS 指纹绕过 Cloudflare 检测
Worker 模式：impit 加载失败 → fallback 到 axios → 但请求从 Cloudflare 边缘发出，本身就不会被 TLS 指纹拦截(**这一点需要重点关注并等待验证**)