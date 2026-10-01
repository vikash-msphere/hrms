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
#   E2E_LANE=1 scripts/e2eStack.sh         # a SECOND stack alongside it: own ports, own database, own logs
set -euo pipefail
cd "$(dirname "$0")/.."   # project root

# The lane: which copy of this stack we are. Everything that must not be shared with a second run on the same
# machine - three ports, the database, the logs - comes off it, so `E2E_LANE=1` is a whole separate stack and
# lane 0 is exactly the historical one. e2e/lane.ts does this arithmetic for Playwright's half; keep them in
# step. Ten ports per lane, so the three below never reach into the next lane's range.
LANE="${E2E_LANE:-0}"
case "$LANE" in ([0-9]) ;; (*) echo "e2e: E2E_LANE must be a whole number 0-9 (got '$LANE')" >&2; exit 1 ;; esac
if [ "$LANE" = "0" ]; then SUFFIX=""; else SUFFIX="-$LANE"; fi

STATE="${E2E_STATE:-.wrangler/e2e-state$SUFFIX}"
# None of these are the dev stack's ports (8787 / 4010 / 5173). Playwright's `reuseExistingServer` would
# happily attach to a dev stack on the usual ports and hand every "role" the same dev-bypass identity, failing
# the specs for a reason that looks nothing like the cause.
WORKER_PORT="${E2E_WORKER_PORT:-$((8788 + LANE * 10))}"
PRISM_PORT="${E2E_PRISM_PORT:-$((4011 + LANE * 10))}"
WEB_PORT="${E2E_PORT:-$((5174 + LANE * 10))}"
VARS_FILE="e2e/e2e.vars"
LOG_DIR="tmp"
WORKER_LOG="$LOG_DIR/e2e-worker$SUFFIX.log"
PRISM_LOG="$LOG_DIR/e2e-prism$SUFFIX.log"
WEB_LOG="$LOG_DIR/e2e-web$SUFFIX.log"

if [ "${E2E_KEEP_DB:-0}" != "1" ]; then
  echo "→ [e2e] resetting $STATE and seeding demo data…"
  rm -rf "$STATE"
  npx wrangler d1 migrations apply hrms --local --persist-to "$STATE"
  # `migrations apply` reports success and exits while its miniflare still has the schema in the write-ahead
  # log, so the very next `d1 execute` occasionally opens the database before the tables are readable and the
  # seed dies on "no such table: departments" - which reads like a broken migration on a fresh checkout. The
  # retry is on the seed itself rather than a readiness probe: every `wrangler d1` call is a ~15s cold start,
  # and the whole reset has to fit inside Playwright's `webServer` timeout.
  for attempt in 1 2 3; do
    if npx wrangler d1 execute hrms --local --persist-to "$STATE" --file=scripts/seed.sql; then break; fi
    if [ "$attempt" = 3 ]; then echo "→ [e2e] seeding failed three times - see the error above"; exit 1; fi
    echo "→ [e2e] seeding failed (the migration is not readable yet); retrying…"
    sleep 2
  done
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

: > "$WORKER_LOG"; : > "$PRISM_LOG"; : > "$WEB_LOG"

# `--test-scheduled` serves the cron handler at `/__scheduled?cron=<expr>`, which is the only way a browser
# spec can drive the five-minute tick. Four AI features are fed by it and by nothing else - the embed drain
# that semantic search, ticket triage and suggestion clustering all read from, and the moderation scan - so
# without this they could not be covered at all, and waiting five real minutes per assertion is not a test.
#
# It adds one route to a stack that is already local-and-CI-only. Nothing else about the Worker changes, and
# `wrangler deploy` has no such flag to forget.
npx wrangler dev --persist-to "$STATE" --port "$WORKER_PORT" --ip 127.0.0.1 --test-scheduled "${VARS[@]}" \
  > "$WORKER_LOG" 2>&1 & PIDS+=($!)

# Wait for the Worker before starting Prism: Prism reads nothing from upstream at boot, but a proxy pointed at
# a dead port produces a confusing first page of 500s in the log.
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "http://127.0.0.1:$WORKER_PORT/v1/users/me" && break
  curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$WORKER_PORT/v1/users/me" 2>/dev/null | grep -q '^[45]' && break
  sleep 1
done

npx prism proxy openapi.yaml "http://127.0.0.1:$WORKER_PORT" --errors -p "$PRISM_PORT" \
  > "$PRISM_LOG" 2>&1 & PIDS+=($!)

# Vite starts LAST, and only once Prism answers. Playwright waits on the Vite port and nothing else, so if
# Vite came up first the specs would start against a proxy still parsing 600 kB of openapi.yaml - which is a
# page of 500s that looks like the app being broken. Prism takes ~10s.
for _ in $(seq 1 120); do
  [ -n "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PRISM_PORT/v1/users/me" 2>/dev/null | grep -v '^000$')" ] && break
  sleep 1
done

echo "→ [e2e] lane $LANE  ·  SPA http://127.0.0.1:$WEB_PORT  ·  Prism :$PRISM_PORT  ·  Worker :$WORKER_PORT  ·  db $STATE  (Google cookie mode, dev bypass off)"
# Sentry is off in a dev server by default (web/src/instrument.ts). `opt-in` makes it AVAILABLE without
# arming it: only a page that asks (`enableTelemetry` in e2e/fixtures.ts) boots the SDK, which is `reportProblem`
# and `replayMasking` and nothing else. Those two stub `/diag` in the page, so nothing is sent anywhere. Plain
# `=1` here would arm all ~350 specs, and the rest stub nothing - their errors would be relayed to the live
# Sentry project, and the outbound subrequests would load the Worker the suite is timing.
#
# Every API request is delayed at the dev server by 20-150ms, drawn per request (the `apiLatency` plugin in
# web/vite.config.ts), so the specs run against production-like round trips instead of localhost's instant,
# in-order answers - the setting that exposes a reload or navigation racing a write still in flight.
# `E2E_API_LATENCY_MS` overrides it ("80", or another range); set it to "0" to run without any delay.
API_LATENCY_MS="${E2E_API_LATENCY_MS:-20-150}"
VITE_SENTRY_IN_DEV=opt-in \
HRMS_WORKER_ORIGIN="http://127.0.0.1:$WORKER_PORT" \
HRMS_PRISM_ORIGIN="http://127.0.0.1:$PRISM_PORT" \
HRMS_API_LATENCY_MS="$API_LATENCY_MS" \
  npx vite --config web/vite.config.ts --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
  > "$WEB_LOG" 2>&1 & PIDS+=($!)

wait
