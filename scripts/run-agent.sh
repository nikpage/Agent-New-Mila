#!/bin/bash

# Run Agent Pipeline — triggers the 6-step agent for a given user
# Usage: ./scripts/run-agent.sh <user-id>
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
  echo "Usage: ./scripts/run-agent.sh <user-id>"
  echo "Or set MILA_USER_ID in .env.local"
  exit 1
fi

echo "Running agent pipeline for user ${USER_ID}..."
echo "Endpoint: ${BASE_URL}/api/agent/run"

curl -s -X POST "${BASE_URL}/api/agent/run" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"${USER_ID}\"}" | python3 -m json.tool

echo ""
echo "Done."
