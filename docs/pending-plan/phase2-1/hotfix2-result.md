Prettier 无变更（已格式化），26 个 lint 错误全是预存的（不在修改文件中），252 个测试全部通过。

Hotfix2 完成。 修改了 unifiedClaudeScheduler.js 的 _isAccountAvailable 方法：

Official 路径：isAccountRateLimited 和 isAccountOpusRateLimited 传入已获取的 account 数据，节省 2-3 个子请求
Console 路径：isAccountRateLimited、isAccountQuotaExceeded、isAccountOverloaded 传入已获取的 account 数据，Workers 模式下跳过 checkQuotaUsage，节省 3-5 个子请求
这对所有 3 个调用点（主调度行 396、分组调度行 1529、CCR 调度行 1705）都生效，因为它们都调用同一个 _isAccountAvailable 方法。