const isWorkerMode = () => process.env.WORKER_MODE === 'true'

if (isWorkerMode()) {
  module.exports = require('./redis-upstash')
} else {
  module.exports = require('./redis')
}
