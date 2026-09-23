#!/usr/bin/env bash
#
# Reap the workerd processes a vitest run leaves behind.
#
# WHY THIS EXISTS. `@cloudflare/vitest-pool-workers` starts one workerd per test file. A run that EXITS
# CLEANLY takes them with it - measured, a full green gate went from 311 processes to 0 on its own, and this
# script found nothing to do. A run that is interrupted, or that dies on a timeout, does not: 310 were left
# alive with their parent gone after a session of failing and abandoned runs.
#
# They are invisible in the obvious place. Each holds only ~14 MB resident, so nothing stands out in `ps` -
# but each also holds a far larger set of swapped-out pages, and the accumulated set had pushed swap to 32 GB
# of a 34 GB swap file. Reaping them took it to 2.8 GB. Nothing reclaims them on their own; they sit until
# somebody notices the RAM is gone, which is a bad way to find out.
#
# TWO FILTERS, EACH SPARING A DIFFERENT LIVE THING, because a blanket `pkill -f workerd` kills the dev stack
# out from under whoever is using it - and the browser lane, whose Worker is exactly that.
#
#   - THE PATH spares `wrangler dev`. Checked rather than assumed: a running stack's binary is
#     `node_modules/wrangler/node_modules/@cloudflare/workerd-*`, while vitest's pool runs miniflare's own copy
#     under `node_modules/miniflare/node_modules/...`. Two different files, so naming one cannot reach the
#     other.
#   - PPID 1 spares a vitest run happening RIGHT NOW, in another terminal. Those children have their vitest as
#     parent; only an abandoned one has been reparented to init. Without this, cleaning up after one run would
#     kill a colleague's.
#
# Neither is redundant: the path alone would kill a live suite's workers, and PPID alone would be one wrangler
# restart away from mattering.
#
# Wired to `posttest` / `posttest:gate` in package.json, so an ordinary run cleans up after itself and nobody
# has to remember. Safe to run by hand at any time - with nothing to reap it says so and exits 0.
set -euo pipefail

# BOTH copies of the binary: vitest's pool runs miniflare's, `wrangler dev` runs wrangler's own. PPID 1 is
# what makes covering the second one safe, and covering it matters because of how a dev stack is usually
# stopped. `pkill -f "wrangler dev"` MATCHES NOTHING - the process is
# `node --no-warnings .../wrangler/wrangler-dist/cli.js dev`, so the literal "wrangler dev" never appears in
# it. Whoever typed that believes they stopped the stack; the parent is untouched, or is killed some other
# way and leaves its workerd child holding port 8787 and answering requests. The next `npm run dev` then
# fails to bind and the stale one replies instead - which is the zombie the project notes warn about, and it
# reads as the app ignoring your changes.
PATTERN="node_modules/(miniflare|wrangler)/node_modules/@cloudflare/workerd"

orphans=()
while read -r pid ppid; do
  [ "$ppid" = "1" ] && orphans+=("$pid")
done < <(pgrep -fE "$PATTERN" 2>/dev/null | xargs -r ps -o pid=,ppid= -p 2>/dev/null || true)

if [ ${#orphans[@]} -eq 0 ]; then
  echo "→ [cleanup] no orphaned workerd processes"
  exit 0
fi

# SIGKILL rather than SIGTERM: these have no parent left to report to and nothing to flush - they are holding
# memory and a socket, and a graceful shutdown is a wait for no benefit.
kill -9 "${orphans[@]}" 2>/dev/null || true
echo "→ [cleanup] reaped ${#orphans[@]} orphaned workerd process(es)"
