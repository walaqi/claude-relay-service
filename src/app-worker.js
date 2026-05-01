const express = require('express')
const cors = require('cors')
const helmet = (() => {
  const m = require('helmet')
  return typeof m === 'function' ? m : m.default
})()

const config = require('../config/config')
const logger = require('./utils/logger')
const redis = require('./models/redis')
const pricingService = require('./services/pricingService')
const { getSafeMessage } = require('./utils/errorSanitizer')

// Import routes
const apiRoutes = require('./routes/api')
const unifiedRoutes = require('./routes/unified')
const adminRoutes = require('./routes/admin')
const webRoutes = require('./routes/web')
const apiStatsRoutes = require('./routes/apiStats')
const geminiRoutes = require('./routes/geminiRoutes')
const openaiGeminiRoutes = require('./routes/openaiGeminiRoutes')
const standardGeminiRoutes = require('./routes/standardGeminiRoutes')
const openaiClaudeRoutes = require('./routes/openaiClaudeRoutes')
const openaiRoutes = require('./routes/openaiRoutes')
const droidRoutes = require('./routes/droidRoutes')
const userRoutes = require('./routes/userRoutes')
const azureOpenaiRoutes = require('./routes/azureOpenaiRoutes')
const webhookRoutes = require('./routes/webhook')

// Import middleware
const {
  corsMiddleware,
  requestLogger,
  securityMiddleware,
  errorHandler,
  globalRateLimit,
  requestSizeLimit
} = require('./middleware/auth')
const { browserFallbackMiddleware } = require('./middleware/browserFallback')

const app = express()
let initialized = false

async function initialize() {
  if (initialized) return
  initialized = true

  try {
    // 连接 Redis
    logger.info('Connecting to Redis...')
    await redis.connect()
    logger.info('Redis connected')

    // 数据迁移检查
    const { getAppVersion, versionGt } = require('./utils/commonHelper')
    const currentVersion = getAppVersion()
    const migratedVersion = await redis.getMigratedVersion()
    if (versionGt(currentVersion, '1.1.250') && versionGt(currentVersion, migratedVersion)) {
      try {
        if (await redis.needsGlobalStatsMigration()) {
          await redis.migrateGlobalStats()
        }
        await redis.cleanupSystemMetrics()
      } catch (err) {
        logger.error('Data migration error:', err.message)
      }
      await redis.setMigratedVersion(currentVersion)
    }

    // 后台迁移（不阻塞启动）
    redis.ensureMonthlyMonthsIndex().catch(() => {})
    redis.migrateUsageIndex().catch(() => {})
    await redis.migrateAlltimeModelStats()

    // 初始化账户余额查询服务
    try {
      const accountBalanceService = require('./services/account/accountBalanceService')
      const { registerAllProviders } = require('./services/balanceProviders')
      registerAllProviders(accountBalanceService)
    } catch (_err) {
      // non-critical
    }

    // 初始化价格服务
    await pricingService.initialize()

    // 初始化模型服务
    const modelService = require('./services/modelService')
    await modelService.initialize()

    // 初始化管理员凭据
    await initializeAdmin()

    // 清理无效会话
    await cleanupInvalidSessions()

    // 初始化费用数据
    try {
      const costInitService = require('./services/costInitService')
      const needsInit = await costInitService.needsInitialization()
      if (needsInit) {
        const result = await costInitService.initializeAllCosts()
        logger.info(`Cost init: ${result.processed} processed, ${result.errors} errors`)
      }
    } catch (err) {
      logger.error(`Failed to initialize costs: ${err.message}`)
    }

    // 回填周费用
    try {
      const weeklyClaudeCostInitService = require('./services/weeklyClaudeCostInitService')
      await weeklyClaudeCostInitService.backfillCurrentWeekClaudeCosts()
    } catch (_err) {
      // non-critical
    }

    // 初始化会话窗口
    const claudeAccountService = require('./services/account/claudeAccountService')
    await claudeAccountService.initializeSessionWindows()

    // 初始化费用排序索引
    const costRankService = require('./services/costRankService')
    await costRankService.initialize()

    // 初始化 API Key 索引
    const apiKeyIndexService = require('./services/apiKeyIndexService')
    apiKeyIndexService.init(redis)
    await apiKeyIndexService.checkAndRebuild()

    // 账户分组反向索引
    const accountGroupService = require('./services/accountGroupService')
    accountGroupService.ensureReverseIndexes().catch(() => {})

    // 中间件
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false
      })
    )

    if (config.web.enableCors) {
      app.use(cors())
    } else {
      app.use(corsMiddleware)
    }

    app.use(browserFallbackMiddleware)

    // Workers 模式不使用 compression 中间件，依赖 Cloudflare 边缘自动压缩

    if (process.env.NODE_ENV === 'production') {
      app.use(globalRateLimit)
    }

    app.use(requestSizeLimit)
    app.use(requestLogger)

    app.use(
      express.json({
        limit: '100mb',
        verify: (req, _res, buf, encoding) => {
          if (buf && buf.length && !buf.toString(encoding || 'utf8').trim()) {
            throw new Error('Invalid JSON: empty body')
          }
        }
      })
    )
    app.use(express.urlencoded({ extended: true, limit: '100mb' }))
    app.use(securityMiddleware)

    if (config.server.trustProxy) {
      app.set('trust proxy', 1)
    }

    // 路由
    app.use('/api', apiRoutes)
    app.use('/api', unifiedRoutes)
    app.use('/claude', apiRoutes)
    app.use(
      '/antigravity/api',
      (req, _res, next) => {
        req._anthropicVendor = 'antigravity'
        next()
      },
      apiRoutes
    )
    app.use(
      '/gemini-cli/api',
      (req, _res, next) => {
        req._anthropicVendor = 'gemini-cli'
        next()
      },
      apiRoutes
    )
    app.use('/admin', adminRoutes)
    app.use('/users', userRoutes)
    app.use('/web', webRoutes)
    app.use('/apiStats', apiStatsRoutes)
    app.use('/gemini', standardGeminiRoutes)
    app.use('/gemini', geminiRoutes)
    app.use('/openai/gemini', openaiGeminiRoutes)
    app.use('/openai/claude', openaiClaudeRoutes)
    app.use('/openai', unifiedRoutes)
    app.use('/openai', openaiRoutes)
    app.use('/droid', droidRoutes)
    app.use('/azure', azureOpenaiRoutes)
    app.use('/admin/webhook', webhookRoutes)

    // 根路径
    app.get('/', (_req, res) => {
      res.redirect('/admin-next/api-stats')
    })

    // 健康检查
    app.get('/health', async (_req, res) => {
      try {
        let version = process.env.APP_VERSION || process.env.VERSION || '1.0.0'
        const memory = process.memoryUsage()
        res.json({
          status: 'healthy',
          service: 'claude-relay-service',
          runtime: 'cloudflare-workers',
          version,
          timestamp: new Date().toISOString(),
          memory: {
            used: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
            total: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`
          }
        })
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          error: getSafeMessage(error),
          timestamp: new Date().toISOString()
        })
      }
    })

    // 指标端点
    app.get('/metrics', async (_req, res) => {
      try {
        const stats = await redis.getSystemStats()
        res.json({
          ...stats,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString()
        })
      } catch (error) {
        res.status(500).json({ error: 'Failed to collect metrics' })
      }
    })

    // 404
    app.use('*', (_req, res) => {
      res.status(404).json({
        error: 'Not Found',
        timestamp: new Date().toISOString()
      })
    })

    // 错误处理
    app.use(errorHandler)

    logger.info('Workers application initialized')
  } catch (error) {
    logger.error('Workers application initialization failed:', error)
    throw error
  }
}

async function initializeAdmin() {
  try {
    const bcrypt = require('bcryptjs')
    const path = require('path')
    const fs = require('fs')
    const initFilePath = path.join(__dirname, '..', 'data', 'init.json')

    // Workers 模式下 init.json 不存在于虚拟 FS，跳过文件加载
    // 管理员凭据应已在 Redis 中（由 Node.js 部署初始化）
    if (!fs.existsSync(initFilePath)) {
      logger.info('No init.json found (expected in Workers mode), skipping admin init from file')
      return
    }

    const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))
    const passwordHash = await bcrypt.hash(initData.adminPassword, 10)
    await redis.setSession('admin_credentials', {
      username: initData.adminUsername,
      passwordHash,
      createdAt: initData.initializedAt || new Date().toISOString(),
      lastLogin: null,
      updatedAt: initData.updatedAt || null
    })
  } catch (error) {
    logger.error('Failed to initialize admin credentials:', error.message)
  }
}

async function cleanupInvalidSessions() {
  try {
    const client = redis.getClient()
    const sessionKeys = await redis.scanKeys('session:*')
    const dataList = await redis.batchHgetallChunked(sessionKeys)

    let invalidCount = 0
    for (let i = 0; i < sessionKeys.length; i++) {
      const key = sessionKeys[i]
      if (key === 'session:admin_credentials') continue
      const sessionData = dataList[i]
      if (!sessionData?.username || !sessionData?.loginTime) {
        invalidCount++
        await client.del(key)
      }
    }

    if (invalidCount > 0) {
      logger.info(`Removed ${invalidCount} invalid sessions`)
    }
  } catch (error) {
    logger.error('Session cleanup failed:', error.message)
  }
}

module.exports = { initialize, listen: (port) => app.listen(port), app }
