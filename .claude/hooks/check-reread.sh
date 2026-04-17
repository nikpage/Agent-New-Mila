#!/usr/bin/env bash
# PreToolUse hook for Read. Denies if the same file (with same offset/limit)
# was already read this session — forces checking conversation context first.
set -euo pipefail

input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
offset=$(printf '%s' "$input" | jq -r '.tool_input.offset // ""')
limit=$(printf '%s' "$input" | jq -r '.tool_input.limit // ""')

if [ -z "$session" ] || [ -z "$file" ]; then exit 0; fi

key="${file}|${offset}|${limit}"
log="/tmp/claude-read-log-${session}.txt"

if [ -f "$log" ] && grep -Fxq "$key" "$log"; then
  reason="Already read ${file} (offset=${offset} limit=${limit}) this session. Check conversation context first; only re-read if the file changed."
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
fi

printf '%s\n' "$key" >> "$log"
exit 0
