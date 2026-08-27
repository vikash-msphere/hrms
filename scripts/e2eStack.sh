#!/usr/bin/env bash
#
# The stack the browser tests run against (LOCAL + CI ONLY - never production).
#
# It is the DEV stack's shape - Worker, Prism contract proxy, Vite - on its own ports and its own database, so
# the specs exercise what a developer actually runs. Two deliberate differences from `scripts/start.sh`:
#
#   - **Auth.** The dev bypass resolves EVERY request to the single DEV_FAKE_EMAIL identity
#     (src/middleware/auth.ts), so a two-role test is impossible under it. Here the Worker runs in Google
#     sign-in mode instead and each test mints its own `hrms_session` cookie (e2e/fixtures.ts), so one stack
#     serves five roles at once.
#   - **The database.** A test run resets it, so it must never touch `.wrangler/state`, where your own local
#     data lives. The e2e database is a separate persistence directory.
#
# `/v1` goes through Prism (`--errors`), so every request and response the specs provoke is validated against
# openapi.yaml as it happens: a route that drifts from the contract fails the browser test, not just the
# drift gates in `npm test`. Binary custom methods (`:download`, `:previewLetter`, …) bypass it - Prism
# re-encodes a binary body and corrupts the file - and so do the Worker's non-`/v1` routes, which are not in
# the contract at all. Both lists live in web/vite.config.ts.
#
# Playwright starts this itself (`webServer` in playwright.config.ts). Run it by hand to poke at the same
# stack the specs see:
#   scripts/e2eStack.sh                    # reset + seed the e2e DB, then serve on :5174
#   E2E_KEEP_DB=1 scripts/e2eStack.sh      # keep the DB as the last run left it (faster)
set -euo pipefail
cd "$(dirname "$0")/.."   # project root

STATE="${E2E_STATE:-.wrangler/e2e-state}"
# None of these are the dev stack's ports (8787 / 4010 / 5173). Playwright's `reuseExistingServer` would
# happily attach to a dev stack on the usual ports and hand every "role" the same dev-bypass identity, failing
# the specs for a reason that looks nothing like the cause.
WORKER_PORT="${E2E_WORKER_PORT:-8788}"
PRISM_PORT="${E2E_PRISM_PORT:-4011}"
WEB_PORT="${E2E_PORT:-5174}"
VARS_FILE="e2e/e2e.vars"
LOG_DIR="tmp"

if [ "${E2E_KEEP_DB:-0}" != "1" ]; then
  echo "→ [e2e] resetting $STATE and seeding demo data…"
  rm -rf "$STATE"
  npx wrangler d1 migrations apply hrms --local --persist-to "$STATE"
  npx wrangler d1 execute hrms --local --persist-to "$STATE" --file=scripts/seed.sql
  npx wrangler d1 execute hrms --local --persist-to "$STATE" --file=scripts/templates.sql
fi

# Vite serves the SPA from source, so there is no bundle to build - but wrangler validates `[assets].directory`
# on every subcommand, and on a fresh clone web/dist does not exist yet.
mkdir -p web/dist
mkdir -p "$LOG_DIR"

# Every var in e2e/e2e.vars becomes a `--var` override. `--var` beats `.dev.vars`, which is what puts the
# Worker in Google sign-in mode and turns the dev bypass OFF without editing anybody's `.dev.vars` (start.sh
# rewrites that file; a test run must not). e2e/globalSetup.ts proves the bypass really is off before any
# spec runs, so a precedence change cannot silently collapse the roles into one.
VARS=()
while IFS='=' read -r key value; do
  case "$key" in ""|\#*) continue ;; esac
  value="${value%\"}"; value="${value#\"}"   # tolerate quoted values
  VARS+=(--var "$key:$value")
done < "$VARS_FILE"

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  [ ${#PIDS[@]} -gt 0 ] && kill "${PIDS[@]}" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

: > "$LOG_DIR/e2e-worker.log"; : > "$LOG_DIR/e2e-prism.log"; : > "$LOG_DIR/e2e-web.log"

npx wrangler dev --persist-to "$STATE" --port "$WORKER_PORT" --ip 127.0.0.1 "${VARS[@]}" \
  > "$LOG_DIR/e2e-worker.log" 2>&1 & PIDS+=($!)

# Wait for the Worker before starting Prism: Prism reads nothing from upstream at boot, but a proxy pointed at
# a dead port produces a confusing first page of 500s in the log.
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "http://127.0.0.1:$WORKER_PORT/v1/users/me" && break
  curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$WORKER_PORT/v1/users/me" 2>/dev/null | grep -q '^[45]' && break
  sleep 1
done

npx prism proxy openapi.yaml "http://127.0.0.1:$WORKER_PORT" --errors -p "$PRISM_PORT" \
  > "$LOG_DIR/e2e-prism.log" 2>&1 & PIDS+=($!)

# Vite starts LAST, and only once Prism answers. Playwright waits on the Vite port and nothing else, so if
# Vite came up first the specs would start against a proxy still parsing 600 kB of openapi.yaml - which is a
# page of 500s that looks like the app being broken. Prism takes ~10s.
for _ in $(seq 1 120); do
  [ -n "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PRISM_PORT/v1/users/me" 2>/dev/null | grep -v '^000$')" ] && break
  sleep 1
done

echo "→ [e2e] SPA http://127.0.0.1:$WEB_PORT  ·  Prism :$PRISM_PORT  ·  Worker :$WORKER_PORT  (Google cookie mode, dev bypass off)"
HRMS_WORKER_ORIGIN="http://127.0.0.1:$WORKER_PORT" \
HRMS_PRISM_ORIGIN="http://127.0.0.1:$PRISM_PORT" \
  npx vite --config web/vite.config.ts --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
  > "$LOG_DIR/e2e-web.log" 2>&1 & PIDS+=($!)

wait
