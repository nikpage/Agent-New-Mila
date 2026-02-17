#!/bin/bash

# Bulk Ingest — backfill historical emails
# Usage: ./scripts/bulk-ingest.sh [user-id] [since] [until] [max-total]
# Reads API key and base URL from .env.local

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.local not found at ${ENV_FILE}"
  exit 1
fi

# Source env vars
export $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs)

USER_ID="${1:-${MILA_USER_ID:-}}"
BASE_URL="${APP_BASE_URL:-http://localhost:3000}"
API_KEY="${MILA_USER_API_KEY:?MILA_USER_API_KEY not set in .env.local}"

if [ -z "$USER_ID" ]; then
  echo "Usage: ./scripts/bulk-ingest.sh <user-id>"
  echo "Or set MILA_USER_ID in .env.local"
  exit 1
fi

# Defaults — override via args or edit here
SINCE="${2:-2025-08-01T00:00:00Z}"
UNTIL="${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
MAX_TOTAL="${4:-50}"

echo "Bulk ingesting emails for user ${USER_ID}..."
echo "Endpoint: ${BASE_URL}/api/ingest/bulk"
echo "Range: ${SINCE} → ${UNTIL} (max ${MAX_TOTAL})"

curl -s -X POST "${BASE_URL}/api/ingest/bulk" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"${USER_ID}\",\"since\":\"${SINCE}\",\"until\":\"${UNTIL}\",\"maxTotal\":${MAX_TOTAL}}" | python3 -m json.tool

echo ""
echo "Done."
