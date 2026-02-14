#!/bin/bash

# Bulk Ingest — backfill historical emails
# Usage: ./scripts/bulk-ingest.sh

API_KEY="569e7912-06a9-4f0b-89fb-6318c8802e9e"
USER_ID="d1a403fd-121b-4dcc-96aa-0efa3af114a8"
BASE_URL="http://localhost:3000"

# Defaults — edit these as needed
SINCE="2025-08-01T00:00:00Z"
UNTIL="2026-02-14T00:00:00Z"
MAX_TOTAL=50

curl -s -X POST "${BASE_URL}/api/ingest/bulk" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"${USER_ID}\",\"since\":\"${SINCE}\",\"until\":\"${UNTIL}\",\"maxTotal\":${MAX_TOTAL}}" | python3 -m json.tool
