// Vitest globalSetup: reap the pool's workerd processes when the vitest process dies without disposing them.
//
// WHY THIS EXISTS. With `isolatedStorage` on, `@cloudflare/vitest-pool-workers` starts one workerd PER TEST
// FILE, all at once, as children of the vitest process (see scripts/testGate.mjs). A run that exits cleanly
// disposes them. A run that is killed - Ctrl-C, a tool's command timeout, SIGKILL, a crashed shard - does
// not: every workerd is reparented to init and keeps its memory. One abandoned bare `vitest run` over 373
// files left 374 of them holding about 12GB, and the next abandoned run doubles that.
//
// `posttest` (scripts/cleanupWorkerd.sh) cannot cover this on its own. npm runs a post-hook only after the
// main script SUCCEEDS, so a failing or killed `npm test` - the only kind that leaves orphans - skips it,
// and `npx vitest` never runs npm hooks at all.
//
// HOW. Setup spawns this same file as a detached process (its own session, so a signal to vitest's process
// group does not reach it) that watches its parent. Once the parent is gone the kernel has already
// reparented every child of vitest to the same reaper as this watchdog, so the watchdog kills the pool's
// workerd processes that now share its parent, and exits. A workerd still owned by a LIVE vitest (another
// terminal's run) has that vitest as parent and is left alone; `wrangler dev` runs a different binary
// (node_modules/wrangler/...), which the path filter never matches.
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const POOL_WORKERD = "node_modules/miniflare/node_modules/@cloudflare/workerd";
const POLL_MS = 1000;

export default function setup() {
  if (process.platform === "win32") return;
  spawn(process.execPath, [SELF, String(process.pid)], { detached: true, stdio: "ignore" }).unref();
}

/** Pool workerd processes whose parent is `ppid`. */
function poolWorkerdsUnder(ppid) {
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return out.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m && Number(m[2]) === ppid && m[3].includes(POOL_WORKERD) ? [Number(m[1])] : [];
  });
}

if (process.argv[1] === SELF) {
  const vitestPid = Number(process.argv[2]);
  // `process.ppid` is read live, so it flips to the reaper the moment vitest exits. Comparing against the pid
  // this process was started under (rather than probing it with kill 0) cannot be fooled by pid reuse.
  const timer = setInterval(() => {
    const reaper = process.ppid;
    if (reaper === vitestPid) return;
    clearInterval(timer);
    // SIGKILL: nothing is left for them to report to or flush.
    for (const pid of poolWorkerdsUnder(reaper)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already exited */ }
    }
  }, POLL_MS);
}
