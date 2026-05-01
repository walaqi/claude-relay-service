const { Redis } = require('@upstash/redis')

// Timezone helpers (same as redis.js top-level functions)
const config = require('../../config/config')

const QUEUE_STATS_TTL_SECONDS = 86400 * 7
const WAIT_TIME_TTL_SECONDS = 86400
const WAIT_TIME_SAMPLES_PER_KEY = 500
const WAIT_TIME_SAMPLES_GLOBAL = 2000
const QUEUE_TTL_BUFFER_SECONDS = 30

function getDateInTimezone(date = new Date()) {
  const offset = config.system?.timezoneOffset ?? 8
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000
  return new Date(utcMs + offset * 3600000)
}

function getDateStringInTimezone(date = new Date()) {
  const d = getDateInTimezone(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getHourInTimezone(date = new Date()) {
  return getDateInTimezone(date).getHours()
}

function getWeekStringInTimezone(date = new Date()) {
  const d = getDateInTimezone(date)
  const jan1 = new Date(d.getFullYear(), 0, 1)
  const days = Math.floor((d - jan1) / 86400000)
  const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

function getPeriodString(resetDay = 1, resetHour = 0, date = new Date()) {
  const d = getDateInTimezone(date)
  const day = d.getDate()
  const hour = d.getHours()
  if (day < resetDay || (day === resetDay && hour < resetHour)) {
    d.setMonth(d.getMonth() - 1)
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(resetDay).padStart(2, '0')}T${String(resetHour).padStart(2, '0')}`
}

function getNextResetTime(resetDay = 1, resetHour = 0) {
  const offset = config.system?.timezoneOffset ?? 8
  const now = getDateInTimezone()
  const day = now.getDate()
  const hour = now.getHours()
  const target = new Date(now.getFullYear(), now.getMonth(), resetDay, resetHour, 0, 0, 0)
  if (day > resetDay || (day === resetDay && hour >= resetHour)) {
    target.setMonth(target.getMonth() + 1)
  }
  const utcTarget = new Date(target.getTime() - offset * 3600000)
  return utcTarget
}

function getPeriodStartDate(resetDay = 1, resetHour = 0, date = new Date()) {
  const d = getDateInTimezone(date)
  const day = d.getDate()
  const hour = d.getHours()
  if (day < resetDay || (day === resetDay && hour < resetHour)) {
    d.setMonth(d.getMonth() - 1)
  }
  return new Date(d.getFullYear(), d.getMonth(), resetDay, resetHour, 0, 0, 0)
}

class UpstashRedisClient {
  constructor() {
    this.client = null
    this.isConnected = false
  }

  async connect() {
    const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) {
      throw new Error('REDIS_URL and REDIS_TOKEN (or UPSTASH_REDIS_REST_*) are required')
    }
    this.client = new Redis({ url, token })
    this.isConnected = true
    return this.client
  }

  async disconnect() {
    this.isConnected = false
  }

  getClient() {
    if (!this.client) {
      throw new Error('Redis not connected')
    }
    return this._clientProxy()
  }

  getClientSafe() {
    if (!this.client) {
      return null
    }
    return this._clientProxy()
  }

  // Returns a proxy that maps raw ioredis-style calls to Upstash methods
  _clientProxy() {
    const self = this
    return new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'pipeline') {
            return () => self._createPipeline()
          }
          if (prop === 'multi') {
            return () => self._createPipeline()
          }
          return (...args) => self._execRawCommand(prop, args)
        }
      }
    )
  }

  // Execute a raw Redis command via Upstash
  async _execRawCommand(cmd, args) {
    const c = this.client
    const command = cmd.toLowerCase()

    switch (command) {
      case 'get':
        return c.get(args[0])
      case 'set': {
        const [key, value, ...rest] = args
        const opts = this._parseSetOptions(rest)
        return c.set(key, value, opts)
      }
      case 'setex':
        return c.setex(args[0], args[1], args[2])
      case 'incr':
        return c.incr(args[0])
      case 'incrby':
        return c.incrby(args[0], args[1])
      case 'incrbyfloat':
        return c.incrbyfloat(args[0], args[1])
      case 'decr':
        return c.decr(args[0])
      case 'del':
        return c.del(...args)
      case 'expire':
        return c.expire(args[0], args[1])
      case 'pexpire':
        return c.pexpire(args[0], args[1])
      case 'ttl':
        return c.ttl(args[0])
      case 'pttl':
        return c.pttl(args[0])
      case 'exists':
        return c.exists(args[0])
      case 'type':
        return c.type(args[0])
      case 'keys':
        return c.keys(args[0])
      case 'hset': {
        const [key, ...fields] = args
        if (typeof fields[0] === 'object' && !Array.isArray(fields[0])) {
          return c.hset(key, fields[0])
        }
        const obj = {}
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1]
        }
        return c.hset(key, obj)
      }
      case 'hget':
        return c.hget(args[0], args[1])
      case 'hgetall': {
        const result = await c.hgetall(args[0])
        return result || {}
      }
      case 'hdel':
        return c.hdel(args[0], ...args.slice(1))
      case 'hincrby':
        return c.hincrby(args[0], args[1], args[2])
      case 'sadd':
        return c.sadd(args[0], ...args.slice(1))
      case 'srem':
        return c.srem(args[0], ...args.slice(1))
      case 'smembers':
        return c.smembers(args[0])
      case 'sismember':
        return c.sismember(args[0], args[1])
      case 'lpush':
        return c.lpush(args[0], ...args.slice(1))
      case 'ltrim':
        return c.ltrim(args[0], args[1], args[2])
      case 'lrange':
        return c.lrange(args[0], args[1], args[2])
      case 'lindex':
        return c.lindex(args[0], args[1])
      case 'zadd': {
        const [key, ...rest] = args
        if (typeof rest[0] === 'number') {
          return c.zadd(key, { score: rest[0], member: rest[1] })
        }
        return c.zadd(key, ...rest)
      }
      case 'zrem':
        return c.zrem(args[0], ...args.slice(1))
      case 'zcard':
        return c.zcard(args[0])
      case 'zscore':
        return c.zscore(args[0], args[1])
      case 'zcount':
        return c.zcount(args[0], args[1], args[2])
      case 'zrange':
        return c.zrange(args[0], args[1], args[2])
      case 'zrangebyscore':
        return c.zrangebyscore(args[0], args[1], args[2])
      case 'zremrangebyscore':
        return c.zremrangebyscore(args[0], args[1], args[2])
      case 'ping':
        return c.ping()
      case 'scan': {
        return this._execScan(args)
      }
      case 'eval': {
        return this._execEval(args)
      }
      case 'hexists': {
        const [key, field] = args
        return this.client.hexists(key, field)
      }
      case 'rename': {
        return this.client.rename(args[0], args[1])
      }
      default:
        throw new Error(`UpstashRedis: raw command '${command}' is not implemented`)
    }
  }

  _parseSetOptions(rest) {
    const opts = {}
    for (let i = 0; i < rest.length; i++) {
      const arg = String(rest[i]).toUpperCase()
      if (arg === 'EX') {
        opts.ex = parseInt(rest[++i])
      } else if (arg === 'PX') {
        opts.px = parseInt(rest[++i])
      } else if (arg === 'NX') {
        opts.nx = true
      } else if (arg === 'XX') {
        opts.xx = true
      }
    }
    return Object.keys(opts).length > 0 ? opts : undefined
  }

  // SCAN: ioredis uses (cursor, 'MATCH', pattern, 'COUNT', count)
  // Upstash uses scan(cursor, { match, count })
  async _execScan(args) {
    const cursor = parseInt(args[0]) || 0
    let match = '*'
    let count = 100
    for (let i = 1; i < args.length; i++) {
      const arg = String(args[i]).toUpperCase()
      if (arg === 'MATCH') {
        match = args[++i]
      } else if (arg === 'COUNT') {
        count = parseInt(args[++i])
      }
    }
    const result = await this.client.scan(cursor, { match, count })
    // Upstash returns [cursor, keys] same as ioredis
    return result
  }

  // EVAL: ioredis uses (script, numkeys, ...keysAndArgs)
  // Upstash uses eval(script, keys[], args[])
  async _execEval(args) {
    const [script, numkeys, ...keysAndArgs] = args
    const keys = keysAndArgs.slice(0, numkeys)
    const evalArgs = keysAndArgs.slice(numkeys)
    return this.client.eval(script, keys, evalArgs)
  }

  // Wrap Upstash pipeline to normalize exec() results to ioredis format [[null, result], ...]
  _pipeline() {
    const p = this.client.pipeline()
    const origExec = p.exec.bind(p)
    p.exec = async () => {
      const results = await origExec()
      return results.map((r) => [null, r])
    }
    return p
  }

  // Pipeline: ioredis returns [[err, result], ...], Upstash returns result[]
  _createPipeline() {
    const commands = []
    const self = this
    const pipelineProxy = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'exec') {
            return async () => {
              if (commands.length === 0) {
                return []
              }
              const p = self.client.pipeline()
              for (const [cmd, args] of commands) {
                p[cmd](...args)
              }
              const results = await p.exec()
              // Normalize to ioredis format: [[null, result], ...]
              return results.map((r) => [null, r])
            }
          }
          return (...args) => {
            commands.push([prop, args])
            return pipelineProxy
          }
        }
      }
    )
    return pipelineProxy
  }

  // --- Migration methods (mostly no-ops or simple in Workers) ---

  async migrateUsageIndex() {
    const migrationKey = 'system:migration:usage_index_v2'
    const migrated = await this.client.get(migrationKey)
    if (migrated) {
      return
    }
    // In Workers mode, migration should have been done by Node.js deployment
    console.log('[INFO] Usage index migration skipped in Workers mode')
  }

  async migrateAlltimeModelStats() {
    // Migration should have been done by Node.js deployment
  }

  // --- API Key CRUD ---

  async setApiKey(keyId, keyData, hashedKey = null) {
    const key = `apikey:${keyId}`
    const data = {}
    for (const [k, v] of Object.entries(keyData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    await this.client.expire(key, 86400 * 365)
    if (hashedKey) {
      await this.client.hset('apikey:hash_map', { [hashedKey]: keyId })
    }
  }

  async getApiKey(keyId) {
    const data = await this.client.hgetall(`apikey:${keyId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return this._parseApiKeyData(data)
  }

  async deleteApiKey(keyId) {
    const keyData = await this.client.hgetall(`apikey:${keyId}`)
    if (keyData?.hashedKey) {
      await this.client.hdel('apikey:hash_map', keyData.hashedKey)
    }
    await this.client.del(`apikey:${keyId}`)
  }

  async getAllApiKeys() {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const keys = await this.scanKeys('apikey:*')
    const filtered = keys.filter((k) => uuidPattern.test(k.replace(/^apikey:/, '')))
    if (filtered.length === 0) {
      return []
    }
    const results = await this.batchHgetallChunked(filtered)
    return results.filter(Boolean).map((d) => this._parseApiKeyData(d))
  }

  async scanApiKeyIds() {
    const indexMembers = await this.client.smembers('apikey:idx:all')
    if (indexMembers && indexMembers.length > 0) {
      return indexMembers
    }
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const keys = await this.scanKeys('apikey:*')
    return keys.map((k) => k.replace(/^apikey:/, '')).filter((id) => uuidPattern.test(id))
  }

  // PLACEHOLDER_APIKEY_METHODS

  async batchGetApiKeys(keyIds) {
    const keys = keyIds.map((id) => `apikey:${id}`)
    const results = await this.batchHgetallChunked(keys)
    return results.map((d) => (d ? this._parseApiKeyData(d) : null))
  }

  async getApiKeysPaginated(options = {}) {
    const {
      page = 1,
      pageSize = 20,
      search = '',
      tag = '',
      isActive,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      excludeDeleted = true
    } = options
    const allIds = await this.scanApiKeyIds()
    const allKeys = await this.batchGetApiKeys(allIds)
    let filtered = allKeys.filter(Boolean)
    if (excludeDeleted) {
      filtered = filtered.filter((k) => !k.isDeleted)
    }
    if (search) {
      const s = search.toLowerCase()
      filtered = filtered.filter(
        (k) =>
          (k.name && k.name.toLowerCase().includes(s)) ||
          (k.keyId && k.keyId.toLowerCase().includes(s))
      )
    }
    if (tag) {
      filtered = filtered.filter((k) => k.tags && k.tags.includes(tag))
    }
    if (isActive !== undefined && isActive !== '') {
      filtered = filtered.filter((k) => (isActive ? k.isActive !== false : k.isActive === false))
    }
    filtered.sort((a, b) => {
      const aVal = a[sortBy] || ''
      const bVal = b[sortBy] || ''
      return sortOrder === 'asc' ? (aVal > bVal ? 1 : -1) : aVal < bVal ? 1 : -1
    })
    const total = filtered.length
    const start = (page - 1) * pageSize
    const items = filtered.slice(start, start + pageSize)
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  async findApiKeyByHash(hashedKey) {
    const keyId = await this.client.hget('apikey:hash_map', hashedKey)
    if (keyId) {
      return this.getApiKey(keyId)
    }
    const legacyData = await this.client.hgetall(`apikey_hash:${hashedKey}`)
    if (legacyData && Object.keys(legacyData).length > 0) {
      return this._parseApiKeyData(legacyData)
    }
    return null
  }

  // --- Tags ---

  async addTag(tagName) {
    return this.client.sadd('apikey:tags:all', tagName)
  }

  async removeTag(tagName) {
    return this.client.srem('apikey:tags:all', tagName)
  }

  async getGlobalTags() {
    const tags = await this.client.smembers('apikey:tags:all')
    return tags || []
  }

  async scanAllApiKeyTags() {
    const allIds = await this.scanApiKeyIds()
    const allKeys = await this.batchGetApiKeys(allIds)
    const tagSet = new Set()
    for (const k of allKeys) {
      if (k?.tags) {
        const tags = Array.isArray(k.tags) ? k.tags : JSON.parse(k.tags || '[]')
        tags.forEach((t) => tagSet.add(t))
      }
    }
    return [...tagSet]
  }

  _parseApiKeyData(data) {
    if (!data) {
      return null
    }
    const result = { ...data }
    const boolFields = ['isActive', 'isDeleted', 'enableStreaming']
    for (const f of boolFields) {
      if (f in result) {
        result[f] = result[f] === 'true' || result[f] === true
      }
    }
    const numFields = [
      'maxConcurrency',
      'rateLimit',
      'rateLimitWindow',
      'tokenLimit',
      'tokenLimitWindow',
      'costLimit',
      'costLimitWindow',
      'weeklyOpusCostLimit'
    ]
    for (const f of numFields) {
      if (f in result && result[f] !== '' && result[f] !== null) {
        result[f] = Number(result[f])
      }
    }
    const jsonFields = ['tags', 'allowedModels', 'blockedModels', 'allowedAccountTypes']
    for (const f of jsonFields) {
      if (f in result && typeof result[f] === 'string') {
        try {
          result[f] = JSON.parse(result[f])
        } catch (_e) {
          // keep as string
        }
      }
    }
    return result
  }

  _normalizeModelName(model) {
    if (!model) {
      return 'unknown'
    }
    return model
      .replace(/^(us\.|eu\.|ap\.)/, '')
      .replace(/@\d{8}$/, '')
      .replace(/:thinking$/, '')
  }

  // PLACEHOLDER_USAGE_METHODS

  // --- Usage Statistics ---

  async incrementTokenUsage(
    keyId,
    tokens,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    ephemeral5mTokens = 0,
    ephemeral1hTokens = 0,
    isLongContextRequest = false,
    realCost = 0,
    ratedCost = 0
  ) {
    const today = getDateStringInTimezone()
    const hour = getHourInTimezone()
    const month = today.substring(0, 7)
    const normalizedModel = this._normalizeModelName(model)

    const p = this._pipeline()

    // Total usage
    const totalKey = `usage:${keyId}`
    p.hincrby(totalKey, 'totalTokens', tokens)
    p.hincrby(totalKey, 'inputTokens', inputTokens)
    p.hincrby(totalKey, 'outputTokens', outputTokens)
    p.hincrby(totalKey, 'cacheCreateTokens', cacheCreateTokens)
    p.hincrby(totalKey, 'cacheReadTokens', cacheReadTokens)
    p.hincrby(totalKey, 'requestCount', 1)

    // Daily usage
    const dailyKey = `usage:daily:${keyId}:${today}`
    p.hincrby(dailyKey, 'totalTokens', tokens)
    p.hincrby(dailyKey, 'inputTokens', inputTokens)
    p.hincrby(dailyKey, 'outputTokens', outputTokens)
    p.hincrby(dailyKey, 'requestCount', 1)
    p.expire(dailyKey, 86400 * 31)

    // Daily index
    p.sadd(`usage:daily:index:${today}`, keyId)
    p.expire(`usage:daily:index:${today}`, 86400 * 32)

    // Hourly usage
    const hourlyKey = `usage:hourly:${keyId}:${today}:${String(hour).padStart(2, '0')}`
    p.hincrby(hourlyKey, 'totalTokens', tokens)
    p.hincrby(hourlyKey, 'requestCount', 1)
    p.expire(hourlyKey, 86400 * 7)

    // Monthly usage
    const monthlyKey = `usage:monthly:${keyId}:${month}`
    p.hincrby(monthlyKey, 'totalTokens', tokens)
    p.hincrby(monthlyKey, 'inputTokens', inputTokens)
    p.hincrby(monthlyKey, 'outputTokens', outputTokens)
    p.hincrby(monthlyKey, 'requestCount', 1)
    p.expire(monthlyKey, 86400 * 62)

    // Model daily usage
    const modelDailyKey = `usage:model:daily:${normalizedModel}:${today}`
    p.hincrby(modelDailyKey, 'totalTokens', tokens)
    p.hincrby(modelDailyKey, 'requestCount', 1)
    p.expire(modelDailyKey, 86400 * 31)

    // Per-key model daily
    const keyModelDailyKey = `usage:${keyId}:model:daily:${normalizedModel}:${today}`
    p.hincrby(keyModelDailyKey, 'totalTokens', tokens)
    p.hincrby(keyModelDailyKey, 'inputTokens', inputTokens)
    p.hincrby(keyModelDailyKey, 'outputTokens', outputTokens)
    p.hincrby(keyModelDailyKey, 'requestCount', 1)
    p.expire(keyModelDailyKey, 86400 * 31)

    // System metrics
    const minuteTs = Math.floor(Date.now() / 60000) * 60000
    const metricsKey = `system:metrics:minute:${minuteTs}`
    p.hincrby(metricsKey, 'requests', 1)
    p.hincrby(metricsKey, 'tokens', tokens)
    p.expire(metricsKey, 3600)

    // Global stats
    p.hincrby('usage:global:total', 'totalTokens', tokens)
    p.hincrby('usage:global:total', 'requestCount', 1)
    p.hincrby(`usage:global:daily:${today}`, 'totalTokens', tokens)
    p.hincrby(`usage:global:daily:${today}`, 'requestCount', 1)
    p.expire(`usage:global:daily:${today}`, 86400 * 31)
    p.hincrby(`usage:global:monthly:${month}`, 'totalTokens', tokens)
    p.hincrby(`usage:global:monthly:${month}`, 'requestCount', 1)
    p.expire(`usage:global:monthly:${month}`, 86400 * 62)

    // Months index
    p.sadd('usage:global:months', month)

    await p.exec()
  }

  async incrementAccountUsage(
    accountId,
    totalTokens,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    ephemeral5mTokens = 0,
    ephemeral1hTokens = 0,
    model = 'unknown',
    isLongContextRequest = false
  ) {
    const today = getDateStringInTimezone()
    const month = today.substring(0, 7)
    const normalizedModel = this._normalizeModelName(model)

    const p = this._pipeline()
    const totalKey = `account_usage:${accountId}`
    p.hincrby(totalKey, 'totalTokens', totalTokens)
    p.hincrby(totalKey, 'inputTokens', inputTokens)
    p.hincrby(totalKey, 'outputTokens', outputTokens)
    p.hincrby(totalKey, 'requestCount', 1)

    const dailyKey = `account_usage:daily:${accountId}:${today}`
    p.hincrby(dailyKey, 'totalTokens', totalTokens)
    p.hincrby(dailyKey, 'requestCount', 1)
    p.expire(dailyKey, 86400 * 31)

    const monthlyKey = `account_usage:monthly:${accountId}:${month}`
    p.hincrby(monthlyKey, 'totalTokens', totalTokens)
    p.hincrby(monthlyKey, 'requestCount', 1)
    p.expire(monthlyKey, 86400 * 62)

    // Last used time
    p.hset(totalKey, { lastUsedAt: new Date().toISOString(), lastModel: normalizedModel })

    await p.exec()
  }

  async getUsageStats(keyId) {
    const data = await this.client.hgetall(`usage:${keyId}`)
    if (!data || Object.keys(data).length === 0) {
      return { totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }
    }
    return {
      totalTokens: parseInt(data.totalTokens) || 0,
      inputTokens: parseInt(data.inputTokens) || 0,
      outputTokens: parseInt(data.outputTokens) || 0,
      cacheCreateTokens: parseInt(data.cacheCreateTokens) || 0,
      cacheReadTokens: parseInt(data.cacheReadTokens) || 0,
      requestCount: parseInt(data.requestCount) || 0
    }
  }

  async addUsageRecord(keyId, record, maxRecords = 200) {
    const key = `usage:records:${keyId}`
    const data = typeof record === 'string' ? record : JSON.stringify(record)
    const p = this._pipeline()
    p.lpush(key, data)
    p.ltrim(key, 0, maxRecords - 1)
    p.expire(key, 86400 * 31)
    await p.exec()
  }

  async getUsageRecords(keyId, limit = 50) {
    const records = await this.client.lrange(`usage:records:${keyId}`, 0, limit - 1)
    return (records || []).map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r
      } catch (_e) {
        return r
      }
    })
  }

  async getKeyIdsWithModels(keyIds, models) {
    // Simplified: return all keyIds (full implementation would check model usage)
    return keyIds
  }

  async getAllUsedModels() {
    const today = getDateStringInTimezone()
    const keys = await this.scanKeys(`usage:model:daily:*:${today}`)
    const models = new Set()
    for (const key of keys) {
      const match = key.match(/^usage:model:daily:(.+):\d{4}-\d{2}-\d{2}$/)
      if (match) {
        models.add(match[1])
      }
    }
    return [...models]
  }

  // PLACEHOLDER_COST_METHODS

  // --- Cost ---

  async getDailyCost(keyId) {
    const today = getDateStringInTimezone()
    const val = await this.client.get(`usage:cost:daily:${keyId}:${today}`)
    return parseFloat(val) || 0
  }

  async incrementDailyCost(keyId, amount, realAmount = null) {
    const today = getDateStringInTimezone()
    const month = today.substring(0, 7)
    const hour = `${today}:${String(getHourInTimezone()).padStart(2, '0')}`

    const p = this._pipeline()
    p.incrbyfloat(`usage:cost:daily:${keyId}:${today}`, amount)
    p.expire(`usage:cost:daily:${keyId}:${today}`, 86400 * 31)
    p.incrbyfloat(`usage:cost:monthly:${keyId}:${month}`, amount)
    p.expire(`usage:cost:monthly:${keyId}:${month}`, 86400 * 62)
    p.incrbyfloat(`usage:cost:hourly:${keyId}:${hour}`, amount)
    p.expire(`usage:cost:hourly:${keyId}:${hour}`, 86400 * 7)
    p.incrbyfloat(`usage:cost:total:${keyId}`, amount)

    if (realAmount !== null && realAmount !== undefined) {
      p.incrbyfloat(`usage:cost:real:daily:${keyId}:${today}`, realAmount)
      p.expire(`usage:cost:real:daily:${keyId}:${today}`, 86400 * 31)
      p.incrbyfloat(`usage:cost:real:monthly:${keyId}:${month}`, realAmount)
      p.expire(`usage:cost:real:monthly:${keyId}:${month}`, 86400 * 62)
      p.incrbyfloat(`usage:cost:real:total:${keyId}`, realAmount)
    }

    // Global cost
    p.incrbyfloat(`usage:cost:global:daily:${today}`, amount)
    p.expire(`usage:cost:global:daily:${today}`, 86400 * 31)
    p.incrbyfloat(`usage:cost:global:monthly:${month}`, amount)
    p.expire(`usage:cost:global:monthly:${month}`, 86400 * 62)

    await p.exec()
  }

  async getCostStats(keyId) {
    const today = getDateStringInTimezone()
    const month = today.substring(0, 7)
    const p = this._pipeline()
    p.get(`usage:cost:daily:${keyId}:${today}`)
    p.get(`usage:cost:monthly:${keyId}:${month}`)
    p.get(`usage:cost:total:${keyId}`)
    p.get(`usage:cost:real:daily:${keyId}:${today}`)
    p.get(`usage:cost:real:monthly:${keyId}:${month}`)
    p.get(`usage:cost:real:total:${keyId}`)
    const results = await p.exec()
    return {
      dailyCost: parseFloat(results[0][1]) || 0,
      monthlyCost: parseFloat(results[1][1]) || 0,
      totalCost: parseFloat(results[2][1]) || 0,
      realDailyCost: parseFloat(results[3][1]) || 0,
      realMonthlyCost: parseFloat(results[4][1]) || 0,
      realTotalCost: parseFloat(results[5][1]) || 0
    }
  }

  async getWeeklyOpusCost(keyId, resetDay = 1, resetHour = 0) {
    const period = getPeriodString(resetDay, resetHour)
    const val = await this.client.get(`usage:opus:weekly:${keyId}:${period}`)
    return parseFloat(val) || 0
  }

  async incrementWeeklyOpusCost(keyId, amount, realAmount = null, resetDay = 1, resetHour = 0) {
    const period = getPeriodString(resetDay, resetHour)
    const nextReset = getNextResetTime(resetDay, resetHour)
    const ttl = Math.max(Math.ceil((nextReset.getTime() - Date.now()) / 1000) + 3600, 3600)
    const p = this._pipeline()
    p.incrbyfloat(`usage:opus:weekly:${keyId}:${period}`, amount)
    p.expire(`usage:opus:weekly:${keyId}:${period}`, ttl)
    if (realAmount !== null) {
      p.incrbyfloat(`usage:opus:weekly:real:${keyId}:${period}`, realAmount)
      p.expire(`usage:opus:weekly:real:${keyId}:${period}`, ttl)
    }
    await p.exec()
  }

  async setWeeklyOpusCost(keyId, amount, periodString = null, resetDay = 1, resetHour = 0) {
    const period = periodString || getPeriodString(resetDay, resetHour)
    const nextReset = getNextResetTime(resetDay, resetHour)
    const ttl = Math.max(Math.ceil((nextReset.getTime() - Date.now()) / 1000) + 3600, 3600)
    await this.client.set(`usage:opus:weekly:${keyId}:${period}`, String(amount), { ex: ttl })
  }

  async getAccountDailyCost(accountId) {
    const today = getDateStringInTimezone()
    const val = await this.client.get(`account_usage:cost:daily:${accountId}:${today}`)
    return parseFloat(val) || 0
  }

  async batchGetAccountDailyCost(accountIds) {
    if (!accountIds || accountIds.length === 0) {
      return {}
    }
    const today = getDateStringInTimezone()
    const p = this._pipeline()
    for (const id of accountIds) {
      p.get(`account_usage:cost:daily:${id}:${today}`)
    }
    const results = await p.exec()
    const map = {}
    accountIds.forEach((id, i) => {
      map[id] = parseFloat(results[i][1]) || 0
    })
    return map
  }

  async getAccountDailyCostFallback(accountId, today, CostCalculator) {
    return 0
  }

  // --- Account Usage Stats ---

  async getAccountUsageStats(accountId, accountType = null) {
    const data = await this.client.hgetall(`account_usage:${accountId}`)
    if (!data || Object.keys(data).length === 0) {
      return { totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }
    }
    return {
      totalTokens: parseInt(data.totalTokens) || 0,
      inputTokens: parseInt(data.inputTokens) || 0,
      outputTokens: parseInt(data.outputTokens) || 0,
      requestCount: parseInt(data.requestCount) || 0,
      lastUsedAt: data.lastUsedAt || null,
      lastModel: data.lastModel || null
    }
  }

  async getAllAccountsUsageStats() {
    const keys = await this.scanKeys('account_usage:*')
    const filtered = keys.filter(
      (k) => !k.includes(':daily:') && !k.includes(':monthly:') && !k.includes(':cost:')
    )
    if (filtered.length === 0) {
      return {}
    }
    const results = await this.batchHgetallChunked(filtered)
    const stats = {}
    filtered.forEach((key, i) => {
      const accountId = key.replace('account_usage:', '')
      if (results[i]) {
        stats[accountId] = {
          totalTokens: parseInt(results[i].totalTokens) || 0,
          requestCount: parseInt(results[i].requestCount) || 0
        }
      }
    })
    return stats
  }

  async resetAllUsageStats() {
    const keys = await this.scanKeys('usage:*')
    if (keys.length > 0) {
      await this.batchDelChunked(keys)
    }
  }

  // PLACEHOLDER_ACCOUNT_CRUD

  // --- Account CRUD ---

  async setClaudeAccount(accountId, accountData) {
    const key = `claude:account:${accountId}`
    const data = {}
    for (const [k, v] of Object.entries(accountData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    await this.client.sadd('claude:account:index', accountId)
  }

  async getClaudeAccount(accountId) {
    const data = await this.client.hgetall(`claude:account:${accountId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return this._parseAccountData(data)
  }

  async getAllClaudeAccounts() {
    const ids = await this.client.smembers('claude:account:index')
    if (!ids || ids.length === 0) {
      return []
    }
    const keys = ids.map((id) => `claude:account:${id}`)
    const results = await this.batchHgetallChunked(keys)
    return results.filter(Boolean).map((d) => this._parseAccountData(d))
  }

  async deleteClaudeAccount(accountId) {
    await this.client.del(`claude:account:${accountId}`)
    await this.client.srem('claude:account:index', accountId)
  }

  async setDroidAccount(accountId, accountData) {
    const key = `droid:account:${accountId}`
    const data = {}
    for (const [k, v] of Object.entries(accountData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    await this.client.sadd('droid:account:index', accountId)
  }

  async getDroidAccount(accountId) {
    const data = await this.client.hgetall(`droid:account:${accountId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return this._parseAccountData(data)
  }

  async getAllDroidAccounts() {
    const ids = await this.client.smembers('droid:account:index')
    if (!ids || ids.length === 0) {
      return []
    }
    const keys = ids.map((id) => `droid:account:${id}`)
    const results = await this.batchHgetallChunked(keys)
    return results.filter(Boolean).map((d) => this._parseAccountData(d))
  }

  async deleteDroidAccount(accountId) {
    await this.client.del(`droid:account:${accountId}`)
    await this.client.srem('droid:account:index', accountId)
  }

  async setOpenAiAccount(accountId, accountData) {
    const key = `openai:account:${accountId}`
    const data = {}
    for (const [k, v] of Object.entries(accountData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    await this.client.sadd('openai:account:index', accountId)
  }

  async getOpenAiAccount(accountId) {
    const data = await this.client.hgetall(`openai:account:${accountId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return this._parseAccountData(data)
  }

  async deleteOpenAiAccount(accountId) {
    await this.client.del(`openai:account:${accountId}`)
    await this.client.srem('openai:account:index', accountId)
  }

  async getAllOpenAIAccounts() {
    const ids = await this.client.smembers('openai:account:index')
    if (!ids || ids.length === 0) {
      return []
    }
    const keys = ids.map((id) => `openai:account:${id}`)
    const results = await this.batchHgetallChunked(keys)
    return results.filter(Boolean).map((d) => this._parseAccountData(d))
  }

  _parseAccountData(data) {
    if (!data) {
      return null
    }
    const result = { ...data }
    const boolFields = ['isActive', 'isPro', 'isTeam', 'enableStreaming', 'disabled']
    for (const f of boolFields) {
      if (f in result) {
        result[f] = result[f] === 'true' || result[f] === true
      }
    }
    const numFields = ['maxConcurrency', 'weight', 'priority', 'dailyCostLimit']
    for (const f of numFields) {
      if (f in result && result[f] !== '' && result[f] !== null) {
        result[f] = Number(result[f])
      }
    }
    const jsonFields = ['supportedModels', 'blockedModels', 'metadata', 'proxyConfig']
    for (const f of jsonFields) {
      if (f in result && typeof result[f] === 'string') {
        try {
          result[f] = JSON.parse(result[f])
        } catch (_e) {
          // keep as string
        }
      }
    }
    return result
  }

  // PLACEHOLDER_SESSION_METHODS

  // --- Session Management ---

  async setSession(sessionId, sessionData, ttl = 86400) {
    const key = `session:${sessionId}`
    const data = {}
    for (const [k, v] of Object.entries(sessionData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    if (ttl > 0) {
      await this.client.expire(key, ttl)
    }
  }

  async getSession(sessionId) {
    const data = await this.client.hgetall(`session:${sessionId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return data
  }

  async deleteSession(sessionId) {
    return this.client.del(`session:${sessionId}`)
  }

  // --- API Key Hash Index ---

  async setApiKeyHash(hashedKey, keyData, ttl = 0) {
    const key = `apikey_hash:${hashedKey}`
    const data = {}
    for (const [k, v] of Object.entries(keyData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    if (ttl > 0) {
      await this.client.expire(key, ttl)
    }
  }

  async getApiKeyHash(hashedKey) {
    const data = await this.client.hgetall(`apikey_hash:${hashedKey}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return data
  }

  async deleteApiKeyHash(hashedKey) {
    return this.client.del(`apikey_hash:${hashedKey}`)
  }

  // --- OAuth Session ---

  async setOAuthSession(sessionId, sessionData, ttl = 600) {
    const key = `oauth:${sessionId}`
    const data = {}
    for (const [k, v] of Object.entries(sessionData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    if (ttl > 0) {
      await this.client.expire(key, ttl)
    }
  }

  async getOAuthSession(sessionId) {
    const data = await this.client.hgetall(`oauth:${sessionId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    // Parse JSON fields back
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
        try {
          data[k] = JSON.parse(v)
        } catch (_e) {
          // keep as string
        }
      }
    }
    return data
  }

  async deleteOAuthSession(sessionId) {
    return this.client.del(`oauth:${sessionId}`)
  }

  // --- Account Balance Cache ---

  async setAccountBalance(platform, accountId, balanceData, ttl = 3600) {
    const key = `account_balance:${platform}:${accountId}`
    const data = {}
    for (const [k, v] of Object.entries(balanceData)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
    if (ttl > 0) {
      await this.client.expire(key, ttl)
    }
  }

  async getAccountBalance(platform, accountId) {
    const data = await this.client.hgetall(`account_balance:${platform}:${accountId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    return data
  }

  async setLocalBalance(platform, accountId, statisticsData, ttl = 300) {
    const key = `account_local_balance:${platform}:${accountId}`
    await this.client.set(key, JSON.stringify(statisticsData), { ex: ttl })
  }

  async getLocalBalance(platform, accountId) {
    const val = await this.client.get(`account_local_balance:${platform}:${accountId}`)
    if (!val) {
      return null
    }
    try {
      return typeof val === 'string' ? JSON.parse(val) : val
    } catch (_e) {
      return null
    }
  }

  async deleteAccountBalance(platform, accountId) {
    await this.client.del(`account_balance:${platform}:${accountId}`)
    await this.client.del(`account_local_balance:${platform}:${accountId}`)
  }

  async setBalanceScriptConfig(platform, accountId, scriptConfig) {
    const key = `balance_script:${platform}:${accountId}`
    await this.client.set(key, JSON.stringify(scriptConfig))
  }

  async getBalanceScriptConfig(platform, accountId) {
    const val = await this.client.get(`balance_script:${platform}:${accountId}`)
    if (!val) {
      return null
    }
    try {
      return typeof val === 'string' ? JSON.parse(val) : val
    } catch (_e) {
      return null
    }
  }

  async deleteBalanceScriptConfig(platform, accountId) {
    return this.client.del(`balance_script:${platform}:${accountId}`)
  }

  // PLACEHOLDER_SYSTEM_STATS

  // --- System Stats ---

  async getSystemStats() {
    const today = getDateStringInTimezone()
    const month = today.substring(0, 7)
    const p = this._pipeline()
    p.hgetall('usage:global:total')
    p.hgetall(`usage:global:daily:${today}`)
    p.hgetall(`usage:global:monthly:${month}`)
    const results = await p.exec()
    const total = results[0][1] || {}
    const daily = results[1][1] || {}
    const monthly = results[2][1] || {}
    return {
      total: {
        totalTokens: parseInt(total.totalTokens) || 0,
        requestCount: parseInt(total.requestCount) || 0
      },
      daily: {
        totalTokens: parseInt(daily.totalTokens) || 0,
        requestCount: parseInt(daily.requestCount) || 0
      },
      monthly: {
        totalTokens: parseInt(monthly.totalTokens) || 0,
        requestCount: parseInt(monthly.requestCount) || 0
      }
    }
  }

  async getKeysByIndex(indexKey, keyPattern) {
    const ids = await this.client.smembers(indexKey)
    if (!ids || ids.length === 0) {
      return []
    }
    return ids.map((id) => keyPattern.replace('*', id))
  }

  async getDataByIndex(indexKey, keyPattern) {
    const keys = await this.getKeysByIndex(indexKey, keyPattern)
    if (keys.length === 0) {
      return []
    }
    return this.batchHgetallChunked(keys)
  }

  async getTodayStats() {
    const today = getDateStringInTimezone()
    const p = this._pipeline()
    p.hgetall(`usage:global:daily:${today}`)
    p.get(`usage:cost:global:daily:${today}`)
    const results = await p.exec()
    const daily = results[0][1] || {}
    return {
      totalTokens: parseInt(daily.totalTokens) || 0,
      requestCount: parseInt(daily.requestCount) || 0,
      totalCost: parseFloat(results[1][1]) || 0
    }
  }

  async getSystemAverages() {
    return { avgTokensPerRequest: 0, avgCostPerRequest: 0, avgRequestsPerDay: 0 }
  }

  async getRealtimeSystemMetrics() {
    const now = Date.now()
    const minuteTs = Math.floor(now / 60000) * 60000
    const keys = []
    for (let i = 0; i < 5; i++) {
      keys.push(`system:metrics:minute:${minuteTs - i * 60000}`)
    }
    const results = await this.batchHgetallChunked(keys)
    let totalRequests = 0
    let totalTokens = 0
    for (const r of results) {
      if (r) {
        totalRequests += parseInt(r.requests) || 0
        totalTokens += parseInt(r.tokens) || 0
      }
    }
    return {
      requestsPerMinute: Math.round(totalRequests / 5),
      tokensPerMinute: Math.round(totalTokens / 5)
    }
  }

  // --- Session-Account Sticky Mapping ---

  async setSessionAccountMapping(sessionHash, accountId, ttl = null) {
    const stickyTtl = ttl || Math.round((config.session?.stickyTtlHours || 1) * 3600)
    await this.client.set(`sticky_session:${sessionHash}`, accountId, { ex: stickyTtl })
  }

  async getSessionAccountMapping(sessionHash) {
    return this.client.get(`sticky_session:${sessionHash}`)
  }

  async extendSessionAccountMappingTTL(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    const thresholdMinutes = config.session?.renewalThresholdMinutes || 0
    if (thresholdMinutes <= 0) {
      return
    }
    const remainingTtl = await this.client.ttl(key)
    if (remainingTtl > 0 && remainingTtl < thresholdMinutes * 60) {
      const stickyTtl = Math.round((config.session?.stickyTtlHours || 1) * 3600)
      await this.client.expire(key, stickyTtl)
    }
  }

  async deleteSessionAccountMapping(sessionHash) {
    return this.client.del(`sticky_session:${sessionHash}`)
  }

  // --- Cleanup ---

  async cleanup() {
    // Minimal cleanup in Workers mode
  }

  // PLACEHOLDER_CONCURRENCY

  // --- Concurrency (Lua script-based, sorted set with lease expiry) ---

  _getConcurrencyConfig() {
    const leaseSeconds = parseInt(process.env.CONCURRENCY_LEASE_SECONDS) || 30
    const renewIntervalSeconds = Math.max(Math.floor(leaseSeconds / 2), 15)
    const cleanupGraceSeconds = parseInt(process.env.CONCURRENCY_CLEANUP_GRACE_SECONDS) || 5
    return { leaseSeconds, renewIntervalSeconds, cleanupGraceSeconds }
  }

  async incrConcurrency(apiKeyId, requestId, leaseSeconds = null) {
    const { leaseSeconds: defaultLease } = this._getConcurrencyConfig()
    const lease = leaseSeconds || defaultLease
    const now = Date.now()
    const expireAt = now + lease * 1000
    const key = `concurrency:${apiKeyId}`
    const ttlMs = lease * 2 * 1000

    const script = `
      local key = KEYS[1]
      local member = ARGV[1]
      local expireAt = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local ttlMs = tonumber(ARGV[4])
      redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
      redis.call('ZADD', key, expireAt, member)
      redis.call('PEXPIRE', key, ttlMs)
      return redis.call('ZCARD', key)
    `
    return this.client.eval(script, [key], [requestId, expireAt, now, ttlMs])
  }

  async refreshConcurrencyLease(apiKeyId, requestId, leaseSeconds = null) {
    const { leaseSeconds: defaultLease } = this._getConcurrencyConfig()
    const lease = leaseSeconds || defaultLease
    const now = Date.now()
    const newExpireAt = now + lease * 1000
    const key = `concurrency:${apiKeyId}`
    const ttlMs = lease * 2 * 1000

    const script = `
      local key = KEYS[1]
      local member = ARGV[1]
      local newExpireAt = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local ttlMs = tonumber(ARGV[4])
      redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
      local score = redis.call('ZSCORE', key, member)
      if not score then return 0 end
      redis.call('ZADD', key, newExpireAt, member)
      redis.call('PEXPIRE', key, ttlMs)
      return 1
    `
    return this.client.eval(script, [key], [requestId, newExpireAt, now, ttlMs])
  }

  async decrConcurrency(apiKeyId, requestId) {
    const now = Date.now()
    const key = `concurrency:${apiKeyId}`

    const script = `
      local key = KEYS[1]
      local member = ARGV[1]
      local now = tonumber(ARGV[2])
      redis.call('ZREM', key, member)
      redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
      local count = redis.call('ZCARD', key)
      if count <= 0 then
        redis.call('DEL', key)
        return 0
      end
      return count
    `
    return this.client.eval(script, [key], [requestId, now])
  }

  async getConcurrency(apiKeyId) {
    const now = Date.now()
    const key = `concurrency:${apiKeyId}`

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
      return redis.call('ZCARD', key)
    `
    return this.client.eval(script, [key], [now])
  }

  async incrConsoleAccountConcurrency(accountId, requestId, leaseSeconds = null) {
    return this.incrConcurrency(`console_account:${accountId}`, requestId, leaseSeconds)
  }

  async refreshConsoleAccountConcurrencyLease(accountId, requestId, leaseSeconds = null) {
    return this.refreshConcurrencyLease(`console_account:${accountId}`, requestId, leaseSeconds)
  }

  async decrConsoleAccountConcurrency(accountId, requestId) {
    return this.decrConcurrency(`console_account:${accountId}`, requestId)
  }

  async getConsoleAccountConcurrency(accountId) {
    return this.getConcurrency(`console_account:${accountId}`)
  }

  async getAllConcurrencyStatus() {
    const keys = await this.scanKeys('concurrency:*')
    const filtered = keys.filter(
      (k) =>
        !k.startsWith('concurrency:queue:') && !k.includes(':stats:') && !k.includes(':wait_times:')
    )
    const results = []
    const now = Date.now()
    for (const key of filtered) {
      try {
        const count = await this.client.zcard(key)
        const apiKeyId = key.replace('concurrency:', '')
        results.push({ apiKeyId, key, activeCount: count })
      } catch (_e) {
        // skip non-zset keys
      }
    }
    return results
  }

  async getConcurrencyStatus(apiKeyId) {
    const key = `concurrency:${apiKeyId}`
    const now = Date.now()
    try {
      await this.client.zremrangebyscore(key, '-inf', now)
      const count = await this.client.zcard(key)
      const members = await this.client.zrange(key, 0, -1, { withScores: true })
      return {
        apiKeyId,
        key,
        activeCount: count,
        activeRequests: members || [],
        exists: count > 0
      }
    } catch (_e) {
      return { apiKeyId, key, activeCount: 0, activeRequests: [], exists: false }
    }
  }

  async forceClearConcurrency(apiKeyId) {
    return this.client.del(`concurrency:${apiKeyId}`)
  }

  async forceClearAllConcurrency() {
    const keys = await this.scanKeys('concurrency:*')
    const filtered = keys.filter(
      (k) =>
        !k.startsWith('concurrency:queue:') && !k.includes(':stats:') && !k.includes(':wait_times:')
    )
    if (filtered.length > 0) {
      await this.batchDelChunked(filtered)
    }
    return filtered.length
  }

  async cleanupExpiredConcurrency(apiKeyId = null) {
    const now = Date.now()
    if (apiKeyId) {
      const key = `concurrency:${apiKeyId}`
      return this.client.zremrangebyscore(key, '-inf', now)
    }
    const keys = await this.scanKeys('concurrency:*')
    for (const key of keys) {
      if (key.startsWith('concurrency:queue:')) {
        continue
      }
      try {
        await this.client.zremrangebyscore(key, '-inf', now)
      } catch (_e) {
        // skip
      }
    }
  }

  // PLACEHOLDER_GENERIC_AND_LOCKS

  // --- Generic Redis Passthrough ---

  async get(key) {
    const val = await this.client.get(key)
    if (val === null || val === undefined) {
      return null
    }
    if (typeof val === 'string') {
      return val
    }
    return JSON.stringify(val)
  }

  async set(key, value, ...args) {
    const opts = this._parseSetOptions(args)
    return this.client.set(key, value, opts)
  }

  async setex(key, ttl, value) {
    return this.client.setex(key, ttl, value)
  }

  async del(...keys) {
    return this.client.del(...keys)
  }

  async keys(pattern) {
    return this.client.keys(pattern)
  }

  // --- Session Window Usage ---

  async getAccountSessionWindowUsage(accountId, windowStart, windowEnd) {
    const keys = await this.scanKeys(`account_usage:daily:${accountId}:*`)
    let totalTokens = 0
    let requestCount = 0
    for (const key of keys) {
      const dateMatch = key.match(/(\d{4}-\d{2}-\d{2})$/)
      if (dateMatch) {
        const date = dateMatch[1]
        if (date >= windowStart && date <= windowEnd) {
          const data = await this.client.hgetall(key)
          if (data) {
            totalTokens += parseInt(data.totalTokens) || 0
            requestCount += parseInt(data.requestCount) || 0
          }
        }
      }
    }
    return { totalTokens, requestCount }
  }

  // --- Distributed Locks ---

  async setAccountLock(lockKey, lockValue, ttlMs) {
    const result = await this.client.set(lockKey, lockValue, { px: ttlMs, nx: true })
    return result === 'OK'
  }

  async releaseAccountLock(lockKey, lockValue) {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `
    const result = await this.client.eval(script, [lockKey], [lockValue])
    return result === 1
  }

  // --- User Message Queue ---

  async acquireUserMessageLock(accountId, requestId, lockTtlMs, delayMs) {
    const lockKey = `user_msg_queue_lock:${accountId}`
    const lastKey = `user_msg_queue_last:${accountId}`

    const script = `
      local lockKey = KEYS[1]
      local lastKey = KEYS[2]
      local requestId = ARGV[1]
      local lockTtlMs = tonumber(ARGV[2])
      local delayMs = tonumber(ARGV[3])

      local currentLock = redis.call('GET', lockKey)
      if currentLock then
        return {0, 0}
      end

      local lastTime = redis.call('GET', lastKey)
      if lastTime and delayMs > 0 then
        local now = redis.call('TIME')
        local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
        local elapsed = nowMs - tonumber(lastTime)
        if elapsed < delayMs then
          local waitMs = delayMs - elapsed
          return {0, waitMs}
        end
      end

      redis.call('SET', lockKey, requestId, 'PX', lockTtlMs)
      return {1, 0}
    `
    const result = await this.client.eval(
      script,
      [lockKey, lastKey],
      [requestId, lockTtlMs, delayMs]
    )
    return { acquired: result[0] === 1, waitMs: result[1] || 0 }
  }

  async releaseUserMessageLock(accountId, requestId) {
    const lockKey = `user_msg_queue_lock:${accountId}`
    const lastKey = `user_msg_queue_last:${accountId}`

    const script = `
      local lockKey = KEYS[1]
      local lastKey = KEYS[2]
      local requestId = ARGV[1]

      local currentLock = redis.call('GET', lockKey)
      if currentLock ~= requestId then
        return 0
      end

      local now = redis.call('TIME')
      local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
      redis.call('SET', lastKey, nowMs, 'EX', 300)
      redis.call('DEL', lockKey)
      return 1
    `
    const result = await this.client.eval(script, [lockKey, lastKey], [requestId])
    return result === 1
  }

  async forceReleaseUserMessageLock(accountId) {
    const lockKey = `user_msg_queue_lock:${accountId}`
    const result = await this.client.del(lockKey)
    return result > 0
  }

  async getUserMessageQueueStats(accountId) {
    const lockKey = `user_msg_queue_lock:${accountId}`
    const lastKey = `user_msg_queue_last:${accountId}`
    const p = this._pipeline()
    p.get(lockKey)
    p.pttl(lockKey)
    p.get(lastKey)
    const results = await p.exec()
    return {
      accountId,
      isLocked: !!results[0][1],
      lockHolder: results[0][1] || null,
      lockTtlMs: results[1][1] > 0 ? results[1][1] : 0,
      lockTtlRaw: results[1][1],
      lastCompletedAt: results[2][1] ? parseInt(results[2][1]) : null
    }
  }

  async scanUserMessageQueueLocks() {
    const keys = await this.scanKeys('user_msg_queue_lock:*')
    return keys.map((k) => k.replace('user_msg_queue_lock:', ''))
  }

  // PLACEHOLDER_CONCURRENCY_QUEUE

  // --- Concurrency Queue ---

  async incrConcurrencyQueue(apiKeyId, timeoutMs = 60000) {
    const key = `concurrency:queue:${apiKeyId}`
    const ttl = Math.ceil(timeoutMs / 1000) + QUEUE_TTL_BUFFER_SECONDS

    const script = `
      local key = KEYS[1]
      local ttl = tonumber(ARGV[1])
      local count = redis.call('INCR', key)
      redis.call('EXPIRE', key, ttl)
      return count
    `
    return this.client.eval(script, [key], [ttl])
  }

  async decrConcurrencyQueue(apiKeyId) {
    const key = `concurrency:queue:${apiKeyId}`

    const script = `
      local key = KEYS[1]
      local count = redis.call('DECR', key)
      if count <= 0 then
        redis.call('DEL', key)
        return 0
      end
      return count
    `
    return this.client.eval(script, [key], [])
  }

  async getConcurrencyQueueCount(apiKeyId) {
    const val = await this.client.get(`concurrency:queue:${apiKeyId}`)
    return parseInt(val) || 0
  }

  async clearConcurrencyQueue(apiKeyId) {
    const result = await this.client.del(`concurrency:queue:${apiKeyId}`)
    return result > 0
  }

  async scanConcurrencyQueueKeys() {
    const keys = await this.scanKeys('concurrency:queue:*')
    return keys
      .filter((k) => !k.includes(':stats:') && !k.includes(':wait_times:'))
      .map((k) => k.replace('concurrency:queue:', ''))
  }

  async clearAllConcurrencyQueues() {
    const keys = await this.scanKeys('concurrency:queue:*')
    if (keys.length === 0) {
      return 0
    }
    await this.batchDelChunked(keys)
    return keys.length
  }

  // --- Concurrency Queue Stats & Wait Times ---

  async incrConcurrencyQueueStats(apiKeyId, field) {
    const key = `concurrency:queue:stats:${apiKeyId}`

    const script = `
      local key = KEYS[1]
      local field = ARGV[1]
      local ttl = tonumber(ARGV[2])
      local count = redis.call('HINCRBY', key, field, 1)
      redis.call('EXPIRE', key, ttl)
      return count
    `
    return this.client.eval(script, [key], [field, QUEUE_STATS_TTL_SECONDS])
  }

  async getConcurrencyQueueStats(apiKeyId) {
    const data = await this.client.hgetall(`concurrency:queue:stats:${apiKeyId}`)
    return data || {}
  }

  async recordQueueWaitTime(apiKeyId, waitTimeMs) {
    const key = `concurrency:queue:wait_times:${apiKeyId}`

    const script = `
      local key = KEYS[1]
      local value = ARGV[1]
      local maxSamples = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])
      redis.call('LPUSH', key, value)
      redis.call('LTRIM', key, 0, maxSamples - 1)
      redis.call('EXPIRE', key, ttl)
      return 1
    `
    return this.client.eval(
      script,
      [key],
      [waitTimeMs, WAIT_TIME_SAMPLES_PER_KEY, WAIT_TIME_TTL_SECONDS]
    )
  }

  async recordGlobalQueueWaitTime(waitTimeMs) {
    const key = 'concurrency:queue:wait_times:global'

    const script = `
      local key = KEYS[1]
      local value = ARGV[1]
      local maxSamples = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])
      redis.call('LPUSH', key, value)
      redis.call('LTRIM', key, 0, maxSamples - 1)
      redis.call('EXPIRE', key, ttl)
      return 1
    `
    return this.client.eval(
      script,
      [key],
      [waitTimeMs, WAIT_TIME_SAMPLES_GLOBAL, WAIT_TIME_TTL_SECONDS]
    )
  }

  async getGlobalQueueWaitTimes() {
    const vals = await this.client.lrange('concurrency:queue:wait_times:global', 0, -1)
    return (vals || []).map(Number)
  }

  async getQueueWaitTimes(apiKeyId) {
    const vals = await this.client.lrange(`concurrency:queue:wait_times:${apiKeyId}`, 0, -1)
    return (vals || []).map(Number)
  }

  async scanConcurrencyQueueStatsKeys() {
    const keys = await this.scanKeys('concurrency:queue:stats:*')
    return keys.map((k) => k.replace('concurrency:queue:stats:', ''))
  }

  // PLACEHOLDER_ACCOUNT_TEST

  // --- Account Test History ---

  async saveAccountTestResult(accountId, platform, testResult) {
    const key = `account:test_history:${platform}:${accountId}`
    const data = typeof testResult === 'string' ? testResult : JSON.stringify(testResult)
    const p = this._pipeline()
    p.lpush(key, data)
    p.ltrim(key, 0, 49)
    p.expire(key, 86400 * 30)
    await p.exec()
  }

  async getAccountTestHistory(accountId, platform) {
    const records = await this.client.lrange(`account:test_history:${platform}:${accountId}`, 0, -1)
    return (records || []).map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r
      } catch (_e) {
        return r
      }
    })
  }

  async getAccountLatestTestResult(accountId, platform) {
    const val = await this.client.lindex(`account:test_history:${platform}:${accountId}`, 0)
    if (!val) {
      return null
    }
    try {
      return typeof val === 'string' ? JSON.parse(val) : val
    } catch (_e) {
      return val
    }
  }

  async getAccountsTestHistory(accounts) {
    const results = {}
    const p = this._pipeline()
    for (const { accountId, platform } of accounts) {
      p.lrange(`account:test_history:${platform}:${accountId}`, 0, 9)
    }
    const pipeResults = await p.exec()
    accounts.forEach(({ accountId, platform }, i) => {
      const key = `${platform}:${accountId}`
      const records = pipeResults[i][1] || []
      results[key] = records.map((r) => {
        try {
          return typeof r === 'string' ? JSON.parse(r) : r
        } catch (_e) {
          return r
        }
      })
    })
    return results
  }

  async saveAccountTestConfig(accountId, platform, testConfig) {
    const key = `account:test_config:${platform}:${accountId}`
    const data = {}
    for (const [k, v] of Object.entries(testConfig)) {
      data[k] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    await this.client.hset(key, data)
  }

  async getAccountTestConfig(accountId, platform) {
    const data = await this.client.hgetall(`account:test_config:${platform}:${accountId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    const boolFields = ['enabled']
    for (const f of boolFields) {
      if (f in data) {
        data[f] = data[f] === 'true' || data[f] === true
      }
    }
    return data
  }

  async getEnabledTestAccounts(platform) {
    const keys = await this.scanKeys(`account:test_config:${platform}:*`)
    const results = []
    for (const key of keys) {
      const data = await this.client.hgetall(key)
      if (data && (data.enabled === 'true' || data.enabled === true)) {
        const accountId = key.replace(`account:test_config:${platform}:`, '')
        results.push({ accountId, platform, ...data })
      }
    }
    return results
  }

  async setAccountLastTestTime(accountId, platform) {
    const key = `account:last_test:${platform}:${accountId}`
    await this.client.set(key, Date.now().toString(), { ex: 86400 * 7 })
  }

  async getAccountLastTestTime(accountId, platform) {
    const val = await this.client.get(`account:last_test:${platform}:${accountId}`)
    return val ? parseInt(val) : null
  }

  // PLACEHOLDER_BATCH_UTILS

  // --- Batch Utilities ---

  async scanKeys(pattern, batchSize = 200) {
    const allKeys = []
    let cursor = 0
    do {
      const result = await this.client.scan(cursor, { match: pattern, count: batchSize })
      cursor = result[0]
      if (result[1] && result[1].length > 0) {
        allKeys.push(...result[1])
      }
    } while (cursor !== 0 && cursor !== '0')
    return allKeys
  }

  async batchHgetall(keys) {
    if (keys.length === 0) {
      return []
    }
    const p = this._pipeline()
    for (const key of keys) {
      p.hgetall(key)
    }
    try {
      const results = await p.exec()
      return results.map((r) => {
        const data = r[1]
        if (!data || Object.keys(data).length === 0) {
          return null
        }
        return data
      })
    } catch (_err) {
      const results = []
      for (const key of keys) {
        try {
          const data = await this.client.hgetall(key)
          results.push(data && Object.keys(data).length > 0 ? data : null)
        } catch (_e) {
          results.push(null)
        }
      }
      return results
    }
  }

  async scanAndGetAll(pattern, batchSize = 200) {
    const keys = await this.scanKeys(pattern, batchSize)
    if (keys.length === 0) {
      return []
    }
    return this.batchHgetall(keys)
  }

  async batchGetApiKeyStats(keyIds) {
    const today = getDateStringInTimezone()
    const month = today.substring(0, 7)
    const p = this._pipeline()
    for (const keyId of keyIds) {
      p.hgetall(`usage:${keyId}`)
      p.get(`usage:cost:daily:${keyId}:${today}`)
      p.get(`usage:cost:monthly:${keyId}:${month}`)
      p.get(`usage:cost:total:${keyId}`)
    }
    const results = await p.exec()
    const stats = {}
    keyIds.forEach((keyId, i) => {
      const base = i * 4
      const usage = results[base][1] || {}
      stats[keyId] = {
        totalTokens: parseInt(usage.totalTokens) || 0,
        requestCount: parseInt(usage.requestCount) || 0,
        dailyCost: parseFloat(results[base + 1][1]) || 0,
        monthlyCost: parseFloat(results[base + 2][1]) || 0,
        totalCost: parseFloat(results[base + 3][1]) || 0
      }
    })
    return stats
  }

  async batchHgetallChunked(keys, chunkSize = 500) {
    if (keys.length === 0) {
      return []
    }
    const results = []
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize)
      const chunkResults = await this.batchHgetall(chunk)
      results.push(...chunkResults)
    }
    return results
  }

  async batchGetChunked(keys, chunkSize = 500) {
    if (keys.length === 0) {
      return []
    }
    const results = []
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize)
      const p = this._pipeline()
      for (const key of chunk) {
        p.get(key)
      }
      const chunkResults = await p.exec()
      results.push(...chunkResults.map((r) => r[1]))
    }
    return results
  }

  async scanAndProcess(pattern, processor, options = {}) {
    const { scanBatchSize = 200, processBatchSize = 100, fetchType = 'hgetall' } = options
    const keys = await this.scanKeys(pattern, scanBatchSize)
    for (let i = 0; i < keys.length; i += processBatchSize) {
      const chunk = keys.slice(i, i + processBatchSize)
      let data
      if (fetchType === 'hgetall') {
        data = await this.batchHgetall(chunk)
      } else {
        const p = this._pipeline()
        for (const key of chunk) {
          p.get(key)
        }
        const results = await p.exec()
        data = results.map((r) => r[1])
      }
      await processor(chunk, data)
    }
  }

  async scanAndGetAllChunked(pattern, options = {}) {
    const { scanBatchSize = 200 } = options
    const keys = await this.scanKeys(pattern, scanBatchSize)
    if (keys.length === 0) {
      return []
    }
    return this.batchHgetallChunked(keys)
  }

  async batchDelChunked(keys, chunkSize = 500) {
    if (keys.length === 0) {
      return 0
    }
    let deleted = 0
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize)
      const p = this._pipeline()
      for (const key of chunk) {
        p.del(key)
      }
      await p.exec()
      deleted += chunk.length
    }
    return deleted
  }

  // PLACEHOLDER_INDEX_UTILS

  // --- Index Utilities ---

  async getAllIdsByIndex(indexKey, scanPattern, extractRegex) {
    const indexMembers = await this.client.smembers(indexKey)
    if (indexMembers && indexMembers.length > 0) {
      return indexMembers
    }
    if (!scanPattern) {
      return []
    }
    const keys = await this.scanKeys(scanPattern)
    const ids = []
    for (const key of keys) {
      if (extractRegex) {
        const match = key.match(extractRegex)
        if (match && match[1]) {
          ids.push(match[1])
        }
      } else {
        ids.push(key)
      }
    }
    return [...new Set(ids)]
  }

  async addToIndex(indexKey, id) {
    return this.client.sadd(indexKey, id)
  }

  async removeFromIndex(indexKey, id) {
    return this.client.srem(indexKey, id)
  }

  // --- Migration / Dashboard ---

  async migrateGlobalStats() {
    // Should have been done by Node.js deployment
  }

  async ensureMonthlyMonthsIndex() {
    // Should have been done by Node.js deployment
  }

  async needsGlobalStatsMigration() {
    return false
  }

  async getMigratedVersion() {
    return (await this.client.get('system:migrated_version')) || '0.0.0'
  }

  async setMigratedVersion(version) {
    await this.client.set('system:migrated_version', version)
  }

  async getGlobalStats() {
    return this.getSystemStats()
  }

  async getApiKeyCount() {
    const indexCount = await this.client.scard('apikey:idx:all')
    if (indexCount > 0) {
      return indexCount
    }
    const ids = await this.scanApiKeyIds()
    return ids.length
  }

  async cleanupSystemMetrics() {
    const cutoff = Date.now() - 3600 * 1000
    const keys = await this.scanKeys('system:metrics:minute:*')
    const toDelete = keys.filter((k) => {
      const ts = parseInt(k.replace('system:metrics:minute:', ''))
      return ts < cutoff
    })
    if (toDelete.length > 0) {
      await this.batchDelChunked(toDelete)
    }
  }
}

// --- Create singleton and attach timezone helpers + extra properties ---

const upstashClient = new UpstashRedisClient()

upstashClient.getDateInTimezone = getDateInTimezone
upstashClient.getDateStringInTimezone = getDateStringInTimezone
upstashClient.getHourInTimezone = getHourInTimezone
upstashClient.getWeekStringInTimezone = getWeekStringInTimezone
upstashClient.getPeriodString = getPeriodString
upstashClient.getNextResetTime = getNextResetTime
upstashClient.getPeriodStartDate = getPeriodStartDate

module.exports = upstashClient
