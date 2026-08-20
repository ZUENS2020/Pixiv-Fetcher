#!/usr/bin/env bash
# Deploy the Pixiv Ajax / translation relay with Docker.
#
# On the relay host:
#   bash scripts/deploy-relay.sh
#
# From your laptop onto a remote Docker host:
#   SSH_HOST=myserver RELAY_PUBLIC_URL=https://relay.example.com bash scripts/deploy-relay.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/relay/.env"
REMOTE_DIR="${REMOTE_DIR:-~/pixiv-fetcher-relay}"
SSH_HOST="${SSH_HOST:-}"
RELAY_PUBLIC_URL="${RELAY_PUBLIC_URL:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  SECRET="$(openssl rand -hex 24 2>/dev/null || python -c 'import secrets; print(secrets.token_hex(24))')"
  echo "RELAY_SECRET=$SECRET" > "$ENV_FILE"
  echo "Created relay/.env (RELAY_SECRET)"
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
if [[ -z "${RELAY_SECRET:-}" || "$RELAY_SECRET" == "change-me-to-a-long-random-string" ]]; then
  echo "Set RELAY_SECRET in relay/.env" >&2
  exit 1
fi

if [[ -n "$SSH_HOST" ]]; then
  echo "==> sync to $SSH_HOST:$REMOTE_DIR"
  ssh "$SSH_HOST" "mkdir -p $REMOTE_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -avz \
      "$ROOT/relay/Dockerfile" \
      "$ROOT/relay/docker-compose.yml" \
      "$ROOT/relay/server.mjs" \
      "$ENV_FILE" \
      "$SSH_HOST:$REMOTE_DIR/"
  else
    scp "$ROOT/relay/Dockerfile" "$ROOT/relay/docker-compose.yml" "$ROOT/relay/server.mjs" "$ENV_FILE" "$SSH_HOST:$REMOTE_DIR/"
  fi
  echo "==> docker compose up"
  ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose up -d --build"
else
  echo "==> docker compose up (local relay/)"
  (cd "$ROOT/relay" && docker compose up -d --build)
fi

cat <<EOF

Relay is up (host port 127.0.0.1:8789).

Expose it with HTTPS (Cloudflare Tunnel or nginx — see docs/DEPLOY.md), then:

  npx wrangler secret put PIXIV_RELAY_URL
  npx wrangler secret put PIXIV_RELAY_SECRET

PIXIV_RELAY_SECRET must match relay/.env.
${RELAY_PUBLIC_URL:+Suggested PIXIV_RELAY_URL: $RELAY_PUBLIC_URL}
EOF
