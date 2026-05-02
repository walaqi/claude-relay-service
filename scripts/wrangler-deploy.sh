#!/bin/bash
# 从 .prod.vars 读取 secrets 并部署到 Cloudflare Workers
# 用法: ./scripts/wrangler-deploy.sh [--secrets-only]

set -e

VARS_FILE=".prod.vars"

if [ ! -f "$VARS_FILE" ]; then
  echo "Error: $VARS_FILE not found"
  echo "Copy .dev.vars to .prod.vars and fill in production values"
  exit 1
fi

set_secrets() {
  echo "Setting secrets from $VARS_FILE..."
  local count=0
  while IFS= read -r line || [ -n "$line" ]; do
    # 跳过空行和注释行（行首 # 或空白+#）
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    # 提取 key=value（值中可能包含 = 和特殊字符）
    key="${line%%=*}"
    value="${line#*=}"
    key=$(echo "$key" | xargs)
    [ -z "$key" ] && continue
    echo "  Setting $key..."
    printf '%s' "$value" | npx wrangler secret put "$key" --name claude-relay-service
    count=$((count + 1))
  done < "$VARS_FILE"
  echo "Done. Set $count secrets."
}

set_secrets

if [ "$1" = "--secrets-only" ]; then
  exit 0
fi

echo ""
echo "Deploying..."
npx wrangler deploy
