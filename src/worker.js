import { httpServerHandler } from 'cloudflare:node'
import appWorker from './app-worker'
import redis from './models/redis-factory'
import apiKeyService from './services/apiKeyService'
import claudeAccountService from './services/account/claudeAccountService'
import rateLimitCleanupService from './services/rateLimitCleanupService'
import userMessageQueueService from './services/userMessageQueueService'
import pricingService from './services/pricingService'

let appInitialized = false

async function ensureApp() {
  if (!appInitialized) {
    await appWorker.initialize()
    appWorker.listen(3000)
    appInitialized = true
  }
}

async function handleScheduledTask(cron) {
  switch (cron) {
    case '*/1 * * * *': {
      const keys = await redis.scanKeys('concurrency:*')
      if (keys.length === 0) return
      const now = Date.now()
      for (const key of keys) {
        if (
          key.startsWith('concurrency:queue:stats:') ||
          key.startsWith('concurrency:queue:wait_times:') ||
          (key.startsWith('concurrency:queue:') &&
            !key.includes(':stats:') &&
            !key.includes(':wait_times:'))
        ) {
          continue
        }
        try {
          const client = redis.getClientSafe()
          if (client) {
            await client.eval(
              `
              local key = KEYS[1]
              local now = tonumber(ARGV[1])
              local keyType = redis.call('TYPE', key)
              if keyType.ok ~= 'zset' then
                redis.call('DEL', key)
                return -1
              end
              redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
              local count = redis.call('ZCARD', key)
              if count <= 0 then
                redis.call('DEL', key)
                return 1
              end
              return 0
            `,
              1,
              key,
              now
            )
          }
        } catch (_err) {
          console.log(`[WARN] Failed to clean concurrency key ${key}`)
        }
      }
      return
    }

    case '0 * * * *': {
      try {
        await Promise.all([
          apiKeyService.cleanupExpiredKeys(),
          claudeAccountService.cleanupErrorAccounts(),
          claudeAccountService.cleanupTempErrorAccounts()
        ])
        await redis.cleanup()
      } catch (err) {
        console.log('[ERROR] Hourly cleanup failed:', err.message)
      }
      return
    }

    case '*/5 * * * *': {
      try {
        await rateLimitCleanupService.runOnce()
      } catch (_err) {
        // rateLimitCleanupService may not expose runOnce yet
      }
      try {
        await userMessageQueueService.cleanupStaleLocks()
      } catch (_err) {
        // ignore
      }
      return
    }

    case '*/10 * * * *': {
      try {
        await pricingService.syncWithRemoteHash()
      } catch (err) {
        console.log('[ERROR] Pricing hash check failed:', err.message)
      }
      return
    }

    case '0 0 * * *': {
      try {
        await pricingService.checkAndUpdatePricing()
      } catch (err) {
        console.log('[ERROR] Daily pricing update failed:', err.message)
      }
      return
    }
  }
}

const handler = httpServerHandler({ port: 3000 })

export default {
  async fetch(request, env, ctx) {
    await ensureApp()
    return handler.fetch(request, env, ctx)
  },
  async scheduled(event, env, ctx) {
    await ensureApp()
    ctx.waitUntil(handleScheduledTask(event.cron))
  }
}
