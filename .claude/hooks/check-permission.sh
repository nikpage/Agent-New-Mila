#!/usr/bin/env bash
# PreToolUse hook for Edit|Write|Bash.
# Denies if the last user message did not explicitly authorize action.
set -eu

input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')

if [ -z "$session" ]; then exit 0; fi

transcript=$(find "$HOME/.claude/projects" -name "${session}.jsonl" 2>/dev/null | head -n1)
if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then exit 0; fi

last_user=$(tac "$transcript" \
  | jq -r 'select(.type == "user") | .message.content | if type == "string" then . else (map(select(.type == "text") | .text) | join(" ")) end' 2>/dev/null \
  | grep -v '^$' \
  | head -n1)

if [ -z "$last_user" ]; then exit 0; fi

# Skip tool-result / system wrappers that appear as user-type records
if printf '%s' "$last_user" | grep -qE '^<(system-reminder|local-command|command-name|command-message|command-args|command-stdout|tool_use_error|user-prompt-submit-hook)'; then
  exit 0
fi

lower=$(printf '%s' "$last_user" | tr '[:upper:]' '[:lower:]')

# Authorization keywords / imperatives
if printf '%s' "$lower" | grep -qE '\b(go|do it|go ahead|apply|fix it|make it|implement|yes|proceed|commit|push|run it|run this|write it|edit it|create it|delete it|remove it|update it|change it|modify|build it|deploy|launch|start it|merge|add it|install|configure|set up|enable|disable|migrate|ok do|please do|approved|authorized|execute)\b'; then
  exit 0
fi

# Imperatives at sentence start ("fix X", "add Y", "remove Z", "update Q")
if printf '%s' "$lower" | grep -qE '(^|[.!?]\s+)(fix|add|remove|delete|update|change|write|edit|create|build|run|apply|implement|refactor|rename|move|replace|install|configure|set|enable|disable|migrate|commit|push|merge|revert)\b'; then
  exit 0
fi

reason="No explicit authorization in last user message. Propose the change and wait for 'go' / 'do it' / 'apply'. Last user message: \"$(printf '%s' "$last_user" | head -c 200)\""

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
