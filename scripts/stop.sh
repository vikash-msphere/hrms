#!/usr/bin/env bash
#
# Stop the local dev stack started by scripts/start.sh (worker + prism + vite).
# Useful when start.sh was detached/backgrounded; a foreground start.sh stops on Ctrl-C.
set -uo pipefail

stop() { # name, pattern
  if pkill -f "$2" 2>/dev/null; then echo "stopped $1"; else echo "$1 not running"; fi
}

stop "vite (SPA)"     "vite"
stop "prism (proxy)"  "prism proxy"
stop "worker"         "wrangler dev"
pkill -f workerd 2>/dev/null || true
echo "done."
