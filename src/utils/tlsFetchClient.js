const axios = require('axios')
const ProxyHelper = require('./proxyHelper')
const logger = require('./logger')

let Impit = null
let impitAvailable = false
try {
  ;({ Impit } = require('impit'))
  impitAvailable = true
} catch (_e) {
  logger.warn('impit not available, falling back to axios for all TLS-sensitive requests')
}

function buildProxyUrl(proxyConfig) {
  if (!proxyConfig) {
    return undefined
  }

  try {
    const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig
    if (!proxy.type || !proxy.host || !proxy.port) {
      return undefined
    }

    const auth =
      proxy.username && proxy.password
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
        : ''

    const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type
    return `${scheme}://${auth}${proxy.host}:${proxy.port}`
  } catch (_e) {
    return undefined
  }
}

function stripUserAgent(headers) {
  if (!headers) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'user-agent')
  )
}

async function impitRequest(method, url, data, options = {}) {
  const proxyUrl = buildProxyUrl(options.proxyConfig)
  const client = new Impit({
    browser: 'chrome',
    proxyUrl,
    timeout: options.timeout || 30000
  })

  const init = {
    method,
    headers: stripUserAgent(options.headers)
  }
  if (method === 'POST' && data !== undefined) {
    init.body = JSON.stringify(data)
  }

  if (options.maxRedirects === 0) {
    init.redirect = 'manual'
  }

  const response = await client.fetch(url, init)

  const text = await response.text()
  let parsedData
  try {
    parsedData = JSON.parse(text)
  } catch (_e) {
    parsedData = text
  }

  const responseHeaders = Object.fromEntries(response.headers.entries())
  const result = {
    status: response.status,
    data: parsedData,
    headers: responseHeaders,
    statusText: response.statusText || ''
  }

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`)
    error.response = result
    throw error
  }

  return result
}

async function axiosFallback(method, url, data, options = {}) {
  const agent = ProxyHelper.createProxyAgent(options.proxyConfig)

  const axiosConfig = {
    headers: options.headers || {},
    timeout: options.timeout || 30000
  }

  if (options.maxRedirects === 0) {
    axiosConfig.maxRedirects = 0
  }

  if (agent) {
    axiosConfig.httpAgent = agent
    axiosConfig.httpsAgent = agent
    axiosConfig.proxy = false
  }

  if (method === 'POST') {
    return axios.post(url, data, axiosConfig)
  }
  return axios.get(url, axiosConfig)
}

async function request(method, url, data, options = {}) {
  if (impitAvailable) {
    try {
      return await impitRequest(method, url, data, options)
    } catch (error) {
      if (error.response) {
        throw error
      }
      logger.warn(`impit request failed, falling back to axios: ${error.message}`)
      try {
        return await axiosFallback(method, url, data, options)
      } catch (fallbackError) {
        if (fallbackError.response) {
          throw fallbackError
        }
        const networkError = new Error(fallbackError.message)
        networkError.request = true
        throw networkError
      }
    }
  }

  try {
    return await axiosFallback(method, url, data, options)
  } catch (error) {
    if (error.response) {
      throw error
    }
    if (error.request) {
      const networkError = new Error(error.message)
      networkError.request = true
      throw networkError
    }
    throw error
  }
}

module.exports = {
  async post(url, data, options = {}) {
    return request('POST', url, data, options)
  },
  async get(url, options = {}) {
    return request('GET', url, undefined, options)
  },
  buildProxyUrl
}
