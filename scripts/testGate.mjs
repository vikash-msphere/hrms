// The unit suite AS A GATE: run vitest, then prove a suite actually ran.
//
// WHY THIS EXISTS. `vitest run` can exit 0 having executed NO TESTS. It is not a hypothetical: when
// `@cloudflare/vitest-pool-workers` fails while building the pool's options - `parseProjectOptions` reads
// wrangler.toml and `.dev.vars` through wrangler, so an unreadable file, a malformed config or a wrangler
// version bump can throw there - it prints a serialized error, collects nothing, and the process still exits
// 0. A plain `--config` typo does exit 1, so this is the pool-load path specifically, which is exactly the
// path a CI runner exercises differently from a laptop.
//
// That matters because `npm run verify` is the ONLY gate this repo has: ahead of every production deploy
// (deploy.yml, which chains `preflight && verify`) and whenever verify.yml is run by hand. A green
// `verify` over an unrun suite is worse than a red one: it is the specific failure that looks like success,
// on the check that stands between a payroll change and production.
//
// So the exit code is not trusted on its own. Vitest writes a JSON summary alongside its normal output, and
// this asserts what that summary must say: the run succeeded, and it contained tests.
//
// IN SHARDS, sized to the machine. With `isolatedStorage` on (vitest.config.ts - every file needs its own
// D1), the pool starts one Miniflare runtime PER TEST FILE, all of them at once, before any test runs, and
// `maxWorkers` does not limit that (pool/index.mjs `getProjectMiniflare`). Measured: 356 files put 356
// workerd processes up together, about 28GB resident. A laptop with 48GB never noticed; a GitHub runner with
// 7GB was killed outright, which Actions reports only as "The operation was canceled" straight after
// "Starting isolated runtimes". So the suite runs as sequential `vitest --shard` processes, each small enough
// that its runtimes fit in half the machine's memory, and each disposing of them before the next starts.
// Measured: about 170MB resident per file at a shard's peak; 200MB is budgeted.
//
// Used by `npm run verify`. `npm run test` stays the bare `vitest run` for the edit/run loop - passing `-t`,
// a file path or `--watch` there should not have to argue with a floor.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";

// A FLOOR, not the expected count. Pinning the exact number would fail every commit that adds a test, which
// trains people to edit this line without reading it - and a gate nobody reads is not a gate. What this has
// to catch is the suite COLLAPSING (to zero, or to the handful of files that happen to load before a failure),
// so it sits far enough below the real total to be quiet during ordinary work and loud the moment a large part
// of the suite stops running. Raise it when the total has comfortably outgrown it; if it ever fails because
// tests were genuinely removed, that is a conversation worth having rather than a number worth editing.
const MIN_TESTS = 2000;
const MIN_FILES = 150;

// Per test file, resident, at a shard's peak (see the header). The shard size is what half the machine holds.
const BYTES_PER_FILE = 200 * 2 ** 20;
const extra = process.argv.slice(2);
// The suite's size, to size the shards - vitest.config.ts's include and its one opt-in exclusion. Only a
// sizing input: what actually ran is read back from the summaries, and that is what the floor is checked on.
const fileCount = readdirSync("test", { recursive: true }).filter(
  (f) => String(f).endsWith(".test.ts") && (process.env.AI_LOCAL_TEST || !String(f).endsWith("aiLocalIntegration.test.ts")),
).length;
const perShard = Number(process.env.TEST_GATE_SHARD_FILES) || Math.max(10, Math.floor((totalmem() / 2) / BYTES_PER_FILE));
// Extra arguments narrow the run (a path, `-t`), and a narrowed run is small: one process, as before. Sharding a
// filtered set would also leave shards with nothing in them, which vitest treats as a failure.
const shards = extra.length ? 1 : Math.max(1, Math.ceil(fileCount / perShard));

const out = mkdtempSync(join(tmpdir(), "hrms-testgate-"));

const fail = (msg) => {
  console.error(`\n✘ test gate: ${msg}`);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
};

/** One vitest process over one shard. Resolves with its exit code; a signal or a spawn error fails the gate. */
function runShard(index) {
  const summaryPath = join(out, `summary-${index}.json`);
  // Both reporters: `default` so a human (and the CI log) sees the usual output live, `json` so there is
  // something to assert against afterwards. `--outputFile.json` scopes the file to the json reporter - a bare
  // `--outputFile` applies to whichever reporter claims it and silently swallowed the default one's output.
  const args = [
    "run", "--reporter=default", "--reporter=json", `--outputFile.json=${summaryPath}`,
    ...(shards > 1 ? [`--shard=${index}/${shards}`] : []),
    ...extra,
  ];
  if (shards > 1) console.log(`\n→ test gate: shard ${index}/${shards} (about ${perShard} files per shard)`);
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", ...args], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", (e) => fail(`could not start vitest: ${e.message}`));
    child.on("exit", (code, signal) => {
      if (signal) fail(`vitest was killed by ${signal}${shards > 1 ? ` in shard ${index}/${shards}` : ""}`);
      resolve({ code: code ?? 1, summaryPath });
    });
  });
}

// Every shard runs, even after one fails, so a single run reports every failing file - the way one `vitest run`
// did. The shards are sequential: running them side by side would put the whole suite's runtimes back up at once.
const runs = [];
for (let i = 1; i <= shards; i++) runs.push(await runShard(i));

const failedShard = runs.find((r) => r.code !== 0);
if (failedShard) {
  // A real test failure. Vitest already printed it; do not bury that under gate output.
  rmSync(out, { recursive: true, force: true });
  process.exit(failedShard.code);
}

// Exit 0 is where the trust stops and the summaries start - one per shard, and every one of them must exist.
let passed = 0, total = 0, failed = 0, files = 0, success = true;
for (const [i, run] of runs.entries()) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(run.summaryPath, "utf8"));
  } catch {
    fail(
      `vitest exited 0 but wrote no JSON summary${shards > 1 ? ` for shard ${i + 1}/${shards}` : ""}, so no test is known to have run. ` +
        "That is the pool-startup failure this gate exists for - scroll up for the error vitest printed.",
    );
  }
  // PASSED, not TOTAL. `numTotalTests` counts skipped tests, so a run in which every single test was skipped
  // reports the full number and sails through a floor written against it - verified: a stray
  // `--testNamePattern` that matches nothing skips all 2744 and `numTotalTests` still says 2744. Skipped is
  // not tested, and the whole point of this file is to refuse "looks like it ran".
  passed += summary.numPassedTests ?? 0;
  total += summary.numTotalTests ?? 0;
  failed += summary.numFailedTests ?? 0;
  // `testResults` is one entry per test FILE, which is the number to floor and the number to print.
  // `numTotalTestSuites` counts `describe` blocks - it reads like a file count and is roughly 4x one, so
  // reporting it made the gate's own success line overstate what had run.
  files += summary.testResults?.length ?? 0;
  if (summary.success === false) success = false;
}
const skipped = total - passed - failed;

if (failed > 0 || !success) fail(`${failed} test(s) failed despite a zero exit code`);
if (passed === 0) {
  fail(
    total > 0
      ? `vitest exited 0 with ${total} test(s) collected and NONE executed - the whole suite was skipped`
      : "vitest exited 0 having run ZERO tests - the suite did not start (see the error above)",
  );
}
if (passed < MIN_TESTS || files < MIN_FILES) {
  fail(
    `only ${passed} test(s) passed across ${files} file(s), below the floor of ${MIN_TESTS}/${MIN_FILES}` +
      (skipped > 0 ? ` (${skipped} skipped)` : "") +
      ". Most of the suite did not run. If tests were deliberately removed, lower the floor in scripts/testGate.mjs.",
  );
}

console.log(`\n✓ test gate: ${passed} tests passed across ${files} files${shards > 1 ? ` in ${shards} shards` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}, 0 failures`);
rmSync(out, { recursive: true, force: true });
