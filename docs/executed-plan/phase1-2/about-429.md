A 429 status code means "Too Many Requests" — you're being rate limited. For Claude Code login specifically, this could be a few different things. Let me check the current docs to give you the most accurate answer.Got it. A 429 during `claude login` specifically (the OAuth flow itself, not actual usage) is a different beast from the more common "I ran out of tokens" 429.

There are basically three things this could be:

**1. OAuth endpoint throttling on the login itself.** If the 429 is happening during the login/token-exchange step — before you've even started using Claude Code — this is a known issue where the OAuth code exchange step fails with 429 Too Many Requests from console.anthropic.com/v1/oauth/token. It tends to look like a flow-level or IP-level throttle rather than an account-specific limit. Common triggers: retrying login many times in quick succession, multiple machines/CLIs trying to authenticate, or being on a shared/VPN IP that's been hitting the endpoint a lot.

Fix: wait 10–15 minutes, switch off any VPN, then try once more. Don't keep mashing retry — that makes it worse.

**2. Backend desync / stuck rate-limit state.** Sometimes the account gets flagged as rate-limited even after quotas reset. People have reported the CLI throwing "API Error: Rate limit reached" immediately on launch even after waiting 12+ hours, with local cache wiped and fresh login attempts. If waiting doesn't help, you'd need to contact Anthropic support to manually reset the account state.

**3. Actual usage limit (less likely if it's purely on login).** If you're on Pro/Max and have been hammering Claude Code, you may have hit the rolling 5-hour window or weekly cap — though that usually shows up after login, not during it.

**What I'd try, in order:**
- Wait 10–15 min and retry once (don't loop).
- Disable VPN if you're on one.
- Run `claude` (or check `~/.claude/`) to clear stale auth state, then `claude login` fresh.
- If it persists past an hour, file a support ticket at support.anthropic.com with the request ID from the error — that's the fastest path to getting an account state reset.

Which step is throwing the 429 — the browser auth page, or after you paste back/return to the CLI?