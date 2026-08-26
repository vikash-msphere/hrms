#!/usr/bin/env bash
#
# Local dev stack for manual testing (LOCAL ONLY - never used in production).
#
# Usage (from anywhere):
#   scripts/start.sh                 # act as the seeded super_admin (super@example.com)
#   scripts/start.sh hr@example.com         # act as another seeded role
#   scripts/start.sh --seed          # (re)create local D1 from migrations + seed DEMO data (role users), then run
#   scripts/start.sh --bootstrap     # (re)create local D1 from migrations + apply the PRODUCTION bootstrap
#                                     #   catalog (no demo people); mints the dev login as super_admin so the
#                                     #   local stack is usable. Pass an email to pick that login.
#   scripts/start.sh --demo          # --bootstrap, then overlay demo people + a populated kudos board
#                                     #   (bootstrap/demo.sql). Best way to see the recognition feature.
#
# Seeded role logins (email -> role):  super@example.com=super_admin  hr@example.com=hr_admin
#   mgr@example.com=manager  pay@example.com=payroll_admin  emp@example.com=employee
#
# All three processes bind 0.0.0.0, so the SPA is reachable from other devices on the LAN (phone testing).
# The dev fake-auth bypass is on, so ANYONE who can reach this port is the DEV_FAKE_EMAIL identity - only run
# this on a network you trust. Set BIND=127.0.0.1 to go back to localhost-only.
#
# Then open the SPA at:  http://localhost:5173    (Ctrl-C stops all three processes)
# Press 'r' in this terminal to rebuild the SPA + restart all three processes.
# Process output goes to ./tmp/{worker,prism,web}.log (blanked on each rebuild)
# Stop a detached run with:  scripts/stop.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # project root

SEED=0
BOOTSTRAP=0
DEMO=0
EMAIL="super@example.com"
BIND="${BIND:-0.0.0.0}"   # interface all three dev servers listen on; override with BIND=127.0.0.1
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --bootstrap) BOOTSTRAP=1 ;;
    --demo) BOOTSTRAP=1; DEMO=1 ;; # bootstrap, then overlay demo people + kudos
    *) EMAIL="$arg" ;;
  esac
done

if [ "$SEED" = "1" ] && [ "$BOOTSTRAP" = "1" ]; then
  echo "✗ --seed (demo data) and --bootstrap (production catalog) are mutually exclusive. Pick one." >&2
  exit 1
fi

# Point the worker's dev fake-auth at the chosen identity (portable sed for BSD/macOS + GNU).
if grep -q '^DEV_FAKE_EMAIL=' .dev.vars 2>/dev/null; then
  sed -i.bak "s/^DEV_FAKE_EMAIL=.*/DEV_FAKE_EMAIL=\"$EMAIL\"/" .dev.vars && rm -f .dev.vars.bak
else
  echo "DEV_FAKE_EMAIL=\"$EMAIL\"" >> .dev.vars
fi
# The dev bypass needs BOTH DEV_FAKE_EMAIL and ALLOW_DEV_AUTH=true (auth.ts). Ensure the flag is present.
if ! grep -q '^ALLOW_DEV_AUTH=' .dev.vars 2>/dev/null; then
  echo 'ALLOW_DEV_AUTH="true"' >> .dev.vars
fi

if [ "$SEED" = "1" ]; then
  echo "→ Resetting + migrating local D1 and seeding role users…"
  rm -rf .wrangler/state
  npm run db:migrate:local
  npx wrangler d1 execute hrms --local --file=scripts/seed.sql
  npx wrangler d1 execute hrms --local --file=scripts/templates.sql  # default HR letter templates (editable at runtime)
fi

if [ "$BOOTSTRAP" = "1" ]; then
  echo "→ Resetting + migrating local D1 and applying the production bootstrap catalog…"
  rm -rf .wrangler/state
  npm run db:migrate:local
  node --import ./scripts/tsResolve.mjs bootstrap/genBootstrap.ts > bootstrap/bootstrap.sql   # regenerate so it's never stale
  npx wrangler d1 execute hrms --local --file=bootstrap/bootstrap.sql
  # The bootstrap seeds NO users. Mint the dev login as super_admin so the local stack is usable (LOCAL ONLY -
  # start.sh never runs in production). Idempotent: insert, or promote an existing row to super_admin.
  echo "→ Minting $EMAIL as super_admin (dev login)…"
  npx wrangler d1 execute hrms --local --command="INSERT INTO users (uuid,email,role,status,created_at,updated_at) VALUES (lower(hex(randomblob(8))),'$EMAIL','super_admin','active',unixepoch()*1000,unixepoch()*1000) ON CONFLICT(email) DO UPDATE SET role='super_admin',updated_at=unixepoch()*1000;"
fi

if [ "$DEMO" = "1" ]; then
  echo "→ Applying demo overlay (people + a populated kudos board)…"
  node --import ./scripts/tsResolve.mjs bootstrap/genDemo.ts > bootstrap/demo.sql   # regenerate so it's never stale
  npx wrangler d1 execute hrms --local --file=bootstrap/demo.sql
fi

# LAN address to hand to other devices (first non-loopback IPv4; empty when offline or bound to loopback).
LAN_IP=""
if [ "$BIND" != "127.0.0.1" ] && [ "$BIND" != "localhost" ]; then
  for iface in en0 en1 en2 eth0; do
    LAN_IP=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    [ -n "$LAN_IP" ] && break
  done
fi

echo "→ DEV_FAKE_EMAIL=$EMAIL   SPA: http://localhost:5173   (worker :8787, prism :4010)"
if [ -n "$LAN_IP" ]; then
  echo "→ On the LAN: http://$LAN_IP:5173   (dev auth is ON - anyone reaching this port acts as $EMAIL)"
fi

# Process logs live under ./tmp in the project root.
LOG_DIR="tmp"
mkdir -p "$LOG_DIR"

# Stop everything we started. Kill tracked PIDs first, then sweep by name in case npm re-spawned.
PIDS=()
stop_stack() {
  [ ${#PIDS[@]} -gt 0 ] && kill "${PIDS[@]}" 2>/dev/null || true
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f "prism proxy" 2>/dev/null || true
  pkill -f "vite --config" 2>/dev/null || true
  PIDS=()
}

# Truncate the old logs (blank file) and (re)launch all three dev processes in the background.
start_stack() {
  npm run build
  : > "$LOG_DIR/worker.log"; : > "$LOG_DIR/prism.log"; : > "$LOG_DIR/web.log"
  # --ip / --host / --host put each server on $BIND (all interfaces by default) so a phone on the same
  # network can hit the SPA. Vite proxies /v1 to prism/worker over loopback, so only :5173 needs reaching.
  npm run dev       -- --ip "$BIND"   > "$LOG_DIR/worker.log" 2>&1 < /dev/null &  PIDS+=($!)  # Worker (Hono API)            :8787
  npm run dev:proxy -- --host "$BIND" > "$LOG_DIR/prism.log"  2>&1 < /dev/null &  PIDS+=($!)  # Prism contract proxy -> 8787 :4010
  npm run dev:web   -- --host "$BIND" > "$LOG_DIR/web.log"    2>&1 < /dev/null &  PIDS+=($!)  # Vite SPA                     :5173
}

hint() { echo "→ Press [r] to rebuild & restart · [Ctrl-C] to quit  (logs: $LOG_DIR/{worker,prism,web}.log)"; }

# Cleanup on Ctrl-C / exit: tear down once, then leave for good.
cleanup() { trap - EXIT INT TERM; stop_stack; exit 0; }
trap cleanup INT TERM EXIT

stop_stack
start_stack
hint

# Foreground control loop: 'r' tears the stack down, rebuilds, and brings it back up.
# No TTY (piped/detached) -> just wait on the children instead of busy-reading EOF.
if [ -t 0 ]; then
  while IFS= read -rsn1 key; do
    if [ "$key" = "r" ]; then
      echo "→ Rebuilding & restarting…"
      stop_stack
      start_stack
      hint
    fi
  done
else
  wait
fi
