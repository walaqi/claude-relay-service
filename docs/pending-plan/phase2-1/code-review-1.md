代码审核报告 — Phase 2.1

  整体实现与设计方案高度一致，6 个文件改动均符合预期。下面按方案逐项核对。

  ✅ 符合方案

  ┌──────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │             优化             │                                                       落实情况                                                        │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 优化 1 (可选 accountData)    │ 5 个 check 方法签名加 existingAccountData = null，写操作策略与方案表格完全一致：isAccountRateLimited (Claude/Console) │
  │                              │  跳过写；isAccountOpusRateLimited/isAccountBlocked 保留写 ✓                                                           │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 优化 2 (batch                │ upstreamErrorHelper.batchCheckTempUnavailable 实现正确，getClientSafe() null fallback、ttl > 0                        │
  │ temp_unavailable)            │ 判定、accountType:accountId mapKey 一致 ✓                                                                             │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 优化 3 (限流 pipeline)       │ auth.js:1088-1126 pipeline 化正确：1 读 pipeline + 条件 1 写 pipeline + 末尾 INCR；needsReset 合并了首次和过期分支 ✓  │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 优化 4 (跳过                 │ scheduler 在 Console 循环内 WORKER_MODE !== 'true' 守卫 ✓                                                             │
  │ checkQuotaUsage)             │                                                                                                                       │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 优化 5 (轮询上限)            │ auth.js:294-307 + 821-829 实现 worker_poll_limit reason + Retry-After: 2 ✓                                            │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Console getAllAccounts       │ 默认 null、调度器传 true ✓                                                                                            │
  │ skipConcurrency              │                                                                                                                       │
  ├──────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ batchGetConcurrency          │ 仅在 redis-upstash.js 实现，调度器调用处有 WORKER_MODE === 'true' && redis.batchGetConcurrency 双重守卫，回退到       │
  │                              │ Promise.all ✓                                                                                                         │
  └──────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  ⚠️ 需要关注的点

  1. scheduler 把所有 Console / Bedrock 账户都加入 temp_unavailable 检查列表（src/services/scheduler/unifiedClaudeScheduler.js:633-647）
  Claude 走的是两阶段（先过滤 eligibleClaudeAccounts，只检查合格者），但 Console/Bedrock 把全部账户（含未激活/非 shared）都丢进 pipeline。功能正确（同一
  pipeline = 1 子请求），但 pipeline 命令数会比必要值大。如果未来 Workers 限制 pipeline 内命令数，需要收紧。当前方案下不影响子请求预算。
  2. Bedrock 日志/load 路径变化（unifiedClaudeScheduler.js:638-645 vs 883-885）
  原代码 bedrockAccountsResult.success === false 时不会进入循环也不会打日志；新代码把 bedrockAccounts 提前到顶部加载，if (bedrockAccounts.length > 0)
  门控日志和后续处理。success: false + data 不存在的情况下，bedrockAccounts = []，循环跳过、日志缺失。功能等价，仅日志缺一条 "Found 0" 信息。可接受。
  3. batchCheckTempUnavailable 对 pipeline 部分失败不健壮（src/utils/upstreamErrorHelper.js:521）
  results[i][1] 若某条命令异常导致 results[i] 为 undefined 会抛错。当前 codebase 内同模式（如 batchGetConcurrency 的
  r[1]）也未做防御，保持一致即可，但值得记一笔。
  4. TTL === -1 的清理被跳过：方案已声明由 cron 兜底，确认实现一致。✓
  5. isAccountQuotaExceeded 仅改读取（claudeConsoleAccountService.js:668）
  方案标记为"纯读取判断 N/A"。已确认内部无写操作。✓

  风格 / 小项

  - auth.js pipeline 解构 [[, rawWindowStart], ...] 假设 ioredis/upstash 都返回 [err, value] 元组——与 batchGetConcurrency 中 r[1] 模式一��，安全。
  - WORKER_MAX_POLL_ITERATIONS = 5 硬编码；方案中提及，可后续抽到配置。非阻塞。

  结论

  实现忠实于方案，所有关键约束（写操作分类、activeTaskCount: null、WORKER_MODE 守卫、可选参数向后兼容）均已落实。建议合并前确认 npm run lint 与 npm test
  通过。