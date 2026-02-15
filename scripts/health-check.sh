#!/bin/bash

# Health Check — verifies app, database, and WhatsApp daemon
# Usage: ./scripts/health-check.sh
# Reads base URL from .env.local

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.local not found at ${ENV_FILE}"
  exit 1
fi

export $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs)

BASE_URL="${APP_BASE_URL:-http://localhost:3000}"
WA_PORT="${WA_DAEMON_PORT:-3001}"
ERRORS=0

echo "=== Mila Health Check ==="
echo ""

# 1. App health
echo "--- App (${BASE_URL}/api/health) ---"
APP_RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/health" 2>/dev/null) || true
APP_HTTP=$(echo "$APP_RESPONSE" | tail -1)
APP_BODY=$(echo "$APP_RESPONSE" | sed '$d')

if [ "$APP_HTTP" = "200" ]; then
  echo "OK: App healthy"
  echo "$APP_BODY" | python3 -m json.tool 2>/dev/null || echo "$APP_BODY"
else
  echo "FAIL: App returned HTTP ${APP_HTTP:-unreachable}"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 2. WhatsApp daemon
echo "--- WhatsApp Daemon (localhost:${WA_PORT}/health) ---"
WA_RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${WA_PORT}/health" 2>/dev/null) || true
WA_HTTP=$(echo "$WA_RESPONSE" | tail -1)
WA_BODY=$(echo "$WA_RESPONSE" | sed '$d')

if [ "$WA_HTTP" = "200" ]; then
  echo "OK: Daemon alive"
  # Also check connection status
  WA_STATUS=$(curl -s "http://localhost:${WA_PORT}/status" 2>/dev/null)
  echo "$WA_STATUS" | python3 -m json.tool 2>/dev/null || echo "$WA_STATUS"
else
  echo "SKIP: WhatsApp daemon not running (optional)"
fi
echo ""

# 3. Summary
if [ "$ERRORS" -gt 0 ]; then
  echo "=== RESULT: ${ERRORS} check(s) failed ==="
  exit 1
else
  echo "=== RESULT: All checks passed ==="
  exit 0
fi
