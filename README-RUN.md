# 本地运行

## 启动命令
 npm run dev
## 访问地址 
http://localhost:3000 (管理端)
http://localhost:3000 (api端)

# cloudflare worker运行

## 启动命令

- **api端**
npx wrangler dev --port 8787

- **管理端**
cd web/admin-spa && npm run dev 
访问地址: http://localhost:3001


# 配置选项
.env 是给 Node.js 模式（npm run dev / node src/app.js）用的 — 通过 dotenv 加载环境变量（config.js 第 2 行 require('dotenv').config()）。

设置 JWT_SECRET、ENCRYPTION_KEY、REDIS_HOST、REDIS_PASSWORD 这些。

Wrangler 模式的环境变量走不同的路径：

非敏感的放 wrangler.toml 的 [vars]
敏感的用 wrangler secret put 或 .dev.vars 文件（本地开发）