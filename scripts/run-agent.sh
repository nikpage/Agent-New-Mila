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

# Source env vars (handles special characters in values)
set -a
while IFS='=' read -r key value; do
  # Skip comments, blank lines, and lines without =
  [[ -z "$key" || "$key" =~ ^# || -z "$value" ]] && continue
  # Skip lines that aren't valid variable names
  [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && continue
  # Strip surrounding quotes if present
  value="${value%\"}"
  value="${value#\"}"
  export "$key=$value"
done < "$ENV_FILE"
set +a

USER_ID="${1:-}"
BASE_URL="${APP_BASE_URL:-http://localhost:3000}"
API_KEY="${MILA_USER_API_KEY:?MILA_USER_API_KEY not set in .env.local}"

if [ -z "$USER_ID" ]; then
  echo "Usage: ./scripts/run-agent.sh <user-id>"
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
