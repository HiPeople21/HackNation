#!/bin/bash
# Watchdog: keeps the SSE server running, auto-restarts on crash.
# Usage: ./start-server.sh  (or: nohup ./start-server.sh &)

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/web-search-mcp-sse.log"
PIDFILE="/tmp/web-search-mcp-sse.pid"

cleanup() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

# Kill any existing instance
pkill -f "node.*dist/remote-sse" 2>/dev/null
sleep 1

while true; do
  echo "[watchdog] Starting SSE server at $(date)" >> "$LOG"
  cd "$DIR" && node dist/remote-sse.js >> "$LOG" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PIDFILE"
  echo "[watchdog] Server PID: $SERVER_PID" >> "$LOG"

  # Wait for the server process to exit
  wait "$SERVER_PID"
  EXIT_CODE=$?
  echo "[watchdog] Server exited with code $EXIT_CODE at $(date). Restarting in 2s..." >> "$LOG"
  # Kill any stale process holding the port before restarting
  pkill -f "node.*dist/remote-sse" 2>/dev/null
  sleep 2
done
