const path = require('path')
const { build } = require('esbuild')

const nodeBuiltins = [
  'path',
  'crypto',
  'https',
  'http',
  'http2',
  'zlib',
  'stream',
  'buffer',
  'url',
  'util',
  'events',
  'os',
  'fs',
  'net',
  'tls',
  'assert',
  'process',
  'querystring',
  'child_process',
  'dns',
  'string_decoder',
  'constants',
  'module',
  'worker_threads',
  'perf_hooks',
  'async_hooks',
  'diagnostics_channel',
  'timers',
  'console',
  'vm',
  'cluster'
]

const subpathImports = [
  'fs/promises',
  'stream/web',
  'stream/promises',
  'util/types',
  'dns/promises',
  'timers/promises'
]

const allImports = [
  ...nodeBuiltins.map((m) => ({ id: `node:${m}`, varName: `__nb_${m.replace(/-/g, '_')}` })),
  ...subpathImports.map((m) => ({ id: `node:${m}`, varName: `__nb_${m.replace(/[/-]/g, '_')}` }))
]

const bannerLines = [
  ...allImports.map((i) => `import ${i.varName} from '${i.id}';`),
  'const require = /* @__PURE__ */ (() => {',
  `  const m = {${allImports.map((i) => `'${i.id}':${i.varName}`).join(',')}};`,
  '  return (id) => { if (m[id]) return m[id]; throw new Error("require: " + id + " not available in Workers"); };',
  '})();'
]

build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  format: 'esm',
  target: 'esnext',
  mainFields: ['module', 'main'],
  conditions: ['worker', 'node', 'import', 'require'],
  minify: false,
  sourcemap: true,
  banner: {
    js: bannerLines.join('\n')
  },
  define: {
    'process.env.WORKER_MODE': '"true"',
    __dirname: '"/worker"',
    __filename: '"/worker/worker.js"'
  },
  external: [
    'cloudflare:node',
    ...nodeBuiltins.map((m) => `node:${m}`),
    ...subpathImports.map((m) => `node:${m}`)
  ],
  alias: Object.fromEntries(nodeBuiltins.map((m) => [m, `node:${m}`])),
  plugins: [
    {
      name: 'redis-redirect',
      setup(build) {
        build.onResolve({ filter: /models\/redis(\.js)?$/ }, (args) => {
          const redirected = args.path.replace(/models\/redis(\.js)?$/, 'models/redis-factory.js')
          return {
            path: path.resolve(args.resolveDir, redirected)
          }
        })
      }
    },
    {
      name: 'workers-node-stubs',
      setup(build) {
        const stubs = {
          tty: `module.exports = { isatty: function() { return false }, ReadStream: class ReadStream {}, WriteStream: class WriteStream {} }`
        }
        for (const mod of Object.keys(stubs)) {
          build.onResolve({ filter: new RegExp(`^${mod}$`) }, () => ({
            path: mod,
            namespace: 'node-stub'
          }))
          build.onResolve({ filter: new RegExp(`^node:${mod}$`) }, () => ({
            path: mod,
            namespace: 'node-stub'
          }))
        }
        build.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js'
        }))
      }
    },
    {
      name: 'workers-incompatible-externals',
      setup(build) {
        const incompatible = [
          'ldapjs',
          'socks-proxy-agent',
          'https-proxy-agent',
          'winston',
          'winston-daily-rotate-file',
          'node-cron',
          'nodemailer',
          'ioredis',
          'impit'
        ]
        for (const mod of incompatible) {
          build.onResolve({ filter: new RegExp(`^${mod}$`) }, () => ({
            path: mod,
            namespace: 'workers-stub'
          }))
        }
        build.onLoad({ filter: /.*/, namespace: 'workers-stub' }, (args) => ({
          contents: `module.exports = new Proxy({}, {
            get(_, prop) {
              if (prop === '__esModule') return false
              if (prop === 'default') return module.exports
              return function() {
                throw new Error(\`Module '${args.path}' is not available in Workers mode\`)
              }
            }
          })`,
          loader: 'js'
        }))
      }
    }
  ]
})
  .then(() => {
    console.log('Workers build completed successfully')
  })
  .catch((err) => {
    console.error('Workers build failed:', err)
    process.exit(1)
  })
