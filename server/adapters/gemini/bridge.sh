#!/bin/bash
# Reads JSON from stdin (Gemini hook protocol), POSTs to claw-tap server.
# IMPORTANT: Gemini hooks expect a JSON response on stdout.
# Must write response BEFORE backgrounding curl, or Gemini hangs.
#
# Usage: bridge.sh <endpoint> <port> <protocol>
# e.g.:  bridge.sh session-start 3456 https
ENDPOINT="$1"
PORT="${2:-3456}"
PROTOCOL="${3:-http}"
CURL_K=""
[ "$PROTOCOL" = "https" ] && CURL_K="-k"

input=$(cat)
printf '{}'

printf '%s' "$input" | curl -sf $CURL_K --connect-timeout 2 --max-time 5 \
  -X POST -H 'Content-Type:application/json' -d @- \
  "${PROTOCOL}://localhost:${PORT}/api/hooks/gemini/${ENDPOINT}" &>/dev/null &
