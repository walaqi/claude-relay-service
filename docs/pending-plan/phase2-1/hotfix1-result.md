**6 files modified, 252 tests passing, 0 new lint errors.**

### 修改内容

**[claudeAccountService.js]** — 4 个方法添加 `existingAccountData` 可选参数：

*   `clearAccountOpusRateLimit` — 底层清理，返回 `{ success, accountData }`
*   `clearExpiredOpusRateLimit` — 使用底层返回值，避免重复浅拷贝
*   `getAccountRateLimitInfo` — 跳过 re-fetch
*   `getValidAccessToken` — 跳过 re-fetch（保留写操作）
*   `isAccountOpusRateLimited` 内部 clear 调用传入 accountData

**[claudeConsoleAccountService.js]** — `isAccountOverloaded` 添加可选参数

**[unifiedClaudeScheduler.js]** — 绑定账户路径传入已有 `boundAccount` 数据

**[claudeRelayService.js]** — 流式和非流式路径：通过 `options.preSelectedAccount` 消除双重调度，链式传递 account 数据

**[claudeConsoleRelayService.js]** — 流式和非流式路径：通过 `options.accountData` 接收预获取数据

**[api.js]** — `account` 变量作用域从 if 块内提升到块外，传递给所有 relay 调用

### 预期效果

Official 绑定账户 + Opus + 流式：从 ~27-35 个子请求降至 ~8-12 个，安全在 50 限制内。