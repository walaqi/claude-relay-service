const axios = require('axios')
const logger = require('../utils/logger')

const REDIS_CACHE_KEY = 'models:cache'
const REDIS_CACHE_TTL = 86400
const DEFAULT_REFRESH_INTERVAL = 6 * 60 * 60 * 1000
const GITHUB_MODELS_URL =
  'https://raw.githubusercontent.com/walaqi/claude-relay-service/refs/heads/plane/resources/models/models.json'

class ModelService {
  constructor() {
    this._cachedModels = null
    this._refreshTimer = null
    this._refreshing = false
  }

  async initialize() {
    await this._loadFromRedis()
    const count = this._cachedModels ? this._cachedModels.length : 0
    logger.success(`Model service initialized with ${count} cached models`)
  }

  startPeriodicRefresh(intervalMs) {
    const interval = intervalMs || DEFAULT_REFRESH_INTERVAL
    this.refreshModels().catch((err) => {
      logger.warn('⚠️ Initial model refresh failed (will retry):', err.message)
    })
    this._refreshTimer = setInterval(() => {
      this.refreshModels().catch((err) => {
        logger.warn('⚠️ Periodic model refresh failed:', err.message)
      })
    }, interval)
    if (this._refreshTimer.unref) {
      this._refreshTimer.unref()
    }
    logger.info(`📋 Model refresh scheduled every ${interval / 1000 / 3600}h`)
  }

  async refreshModels() {
    if (this._refreshing) {
      return
    }
    this._refreshing = true
    try {
      let models = await this._fetchFromAnthropicAPI()
      if (models && models.length > 0) {
        await this._saveToCache(models, 'anthropic-api')
        logger.info(`📋 Models refreshed from Anthropic API: ${models.length} models`)
        return
      }

      models = await this._fetchFromGitHub()
      if (models && models.length > 0) {
        await this._saveToCache(models, 'github')
        logger.info(`📋 Models refreshed from GitHub fallback: ${models.length} models`)
        return
      }

      logger.warn('⚠️ Failed to refresh models from all sources')
    } finally {
      this._refreshing = false
    }
  }

  async _fetchFromGitHub() {
    try {
      const response = await axios.get(GITHUB_MODELS_URL, { timeout: 15000 })
      const { data } = response
      if (!data || typeof data !== 'object') {
        return null
      }

      const models = []
      const now = Math.floor(Date.now() / 1000)
      const providers = { claude: 'anthropic', openai: 'openai', gemini: 'google' }

      for (const [key, provider] of Object.entries(providers)) {
        if (Array.isArray(data[key])) {
          for (const m of data[key]) {
            if (!m.id) {
              continue
            }
            models.push({
              id: m.id,
              object: 'model',
              created: now,
              owned_by: provider,
              display_name: m.display_name || m.id,
              max_input_tokens: m.max_input_tokens || undefined,
              max_tokens: m.max_tokens || undefined
            })
          }
        }
      }

      return models.length > 0 ? models : null
    } catch (error) {
      logger.debug(`📋 GitHub models fetch failed: ${error.message}`)
      return null
    }
  }

  getAllModels() {
    if (this._cachedModels && this._cachedModels.length > 0) {
      return [...this._cachedModels]
    }
    return []
  }

  getModelsByProvider(provider) {
    return this.getAllModels().filter((m) => m.owned_by === provider)
  }

  isModelSupported(modelId) {
    if (!modelId) {
      return false
    }
    return this.getAllModels().some((m) => m.id === modelId)
  }

  getModelProvider(modelId) {
    const model = this.getAllModels().find((m) => m.id === modelId)
    return model ? model.owned_by : null
  }

  async _fetchFromAnthropicAPI() {
    try {
      const claudeAccountService = require('./account/claudeAccountService')
      const redis = require('../models/redis')
      const client = redis.getClientSafe()

      const accountIds = await client.smembers('claude_accounts')
      if (!accountIds || accountIds.length === 0) {
        return null
      }

      let accessToken = null
      for (const id of accountIds) {
        try {
          const accountData = await client.hgetall(`claude_account:${id}`)
          if (accountData && accountData.status === 'active' && accountData.accessToken) {
            accessToken = await claudeAccountService.getValidAccessToken(id)
            if (accessToken) {
              break
            }
          }
        } catch (_e) {
          continue
        }
      }

      if (!accessToken) {
        return null
      }

      const allModels = []
      let afterId = null
      let hasMore = true

      while (hasMore) {
        const params = { limit: 1000 }
        if (afterId) {
          params.after_id = afterId
        }

        const response = await axios.get('https://api.anthropic.com/v1/models', {
          headers: {
            'anthropic-version': '2023-06-01',
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json'
          },
          params,
          timeout: 30000
        })

        const body = response.data
        if (!body || !Array.isArray(body.data)) {
          break
        }

        const now = Math.floor(Date.now() / 1000)
        for (const m of body.data) {
          allModels.push({
            id: m.id,
            object: 'model',
            created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : now,
            owned_by: 'anthropic',
            display_name: m.display_name || m.id,
            max_input_tokens: m.max_input_tokens || undefined,
            max_tokens: m.max_tokens || undefined
          })
        }

        hasMore = body.has_more === true
        afterId = body.last_id || null
        if (!afterId) {
          hasMore = false
        }
      }

      return allModels.length > 0 ? allModels : null
    } catch (error) {
      logger.debug(`📋 Anthropic API models fetch failed: ${error.message}`)
      return null
    }
  }

  async _saveToCache(models, source) {
    this._cachedModels = models
    try {
      const redis = require('../models/redis')
      const client = redis.getClientSafe()
      const cacheData = JSON.stringify({
        fetchedAt: new Date().toISOString(),
        source,
        models
      })
      await client.set(REDIS_CACHE_KEY, cacheData, 'EX', REDIS_CACHE_TTL)
    } catch (error) {
      logger.debug(`📋 Failed to save models to Redis: ${error.message}`)
    }
  }

  async _loadFromRedis() {
    try {
      const redis = require('../models/redis')
      const client = redis.getClientSafe()
      const cached = await client.get(REDIS_CACHE_KEY)
      if (cached) {
        const data = JSON.parse(cached)
        if (data && Array.isArray(data.models) && data.models.length > 0) {
          this._cachedModels = data.models
          logger.debug(
            `📋 Loaded ${data.models.length} models from Redis cache (source: ${data.source})`
          )
        }
      }
    } catch (error) {
      logger.debug(`📋 Failed to load models from Redis: ${error.message}`)
    }
  }

  getStatus() {
    return {
      initialized: true,
      totalModels: this._cachedModels ? this._cachedModels.length : 0,
      providers: this._cachedModels ? [...new Set(this._cachedModels.map((m) => m.owned_by))] : []
    }
  }

  cleanup() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = null
    }
    logger.debug('📋 Model service cleanup')
  }
}

module.exports = new ModelService()
