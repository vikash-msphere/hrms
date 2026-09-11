// The unit suite AS A GATE: run vitest, then prove a suite actually ran.
//
// WHY THIS EXISTS. `vitest run` can exit 0 having executed NO TESTS. It is not a hypothetical: when
// `@cloudflare/vitest-pool-workers` fails while building the pool's options - `parseProjectOptions` reads
// wrangler.toml and `.dev.vars` through wrangler, so an unreadable file, a malformed config or a wrangler
// version bump can throw there - it prints a serialized error, collects nothing, and the process still exits
// 0. A plain `--config` typo does exit 1, so this is the pool-load path specifically, which is exactly the
// path a CI runner exercises differently from a laptop.
//
// That matters because `npm run verify` is the ONLY gate this repo has, on every push (.github/workflows/
// verify.yml) and ahead of every production deploy (deploy.yml, which chains `preflight && verify`). A green
// `verify` over an unrun suite is worse than a red one: it is the specific failure that looks like success,
// on the check that stands between a payroll change and production.
//
// So the exit code is not trusted on its own. Vitest writes a JSON summary alongside its normal output, and
// this asserts what that summary must say: the run succeeded, and it contained tests.
//
// Used by `npm run verify`. `npm run test` stays the bare `vitest run` for the edit/run loop - passing `-t`,
// a file path or `--watch` there should not have to argue with a floor.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A FLOOR, not the expected count. Pinning the exact number would fail every commit that adds a test, which
// trains people to edit this line without reading it - and a gate nobody reads is not a gate. What this has
// to catch is the suite COLLAPSING (to zero, or to the handful of files that happen to load before a failure),
// so it sits far enough below the real total to be quiet during ordinary work and loud the moment a large part
// of the suite stops running. Raise it when the total has comfortably outgrown it; if it ever fails because
// tests were genuinely removed, that is a conversation worth having rather than a number worth editing.
const MIN_TESTS = 2000;
const MIN_FILES = 150;

const out = mkdtempSync(join(tmpdir(), "hrms-testgate-"));
const summaryPath = join(out, "summary.json");

// Both reporters: `default` so a human (and the CI log) sees the usual output live, `json` so there is
// something to assert against afterwards. `--outputFile.json` scopes the file to the json reporter - a bare
// `--outputFile` applies to whichever reporter claims it and silently swallowed the default one's output.
const args = ["run", "--reporter=default", "--reporter=json", `--outputFile.json=${summaryPath}`, ...process.argv.slice(2)];
const child = spawn("npx", ["vitest", ...args], { stdio: "inherit", shell: process.platform === "win32" });

const fail = (msg) => {
  console.error(`\n✘ test gate: ${msg}`);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
};

child.on("error", (e) => fail(`could not start vitest: ${e.message}`));

child.on("exit", (code, signal) => {
  if (signal) fail(`vitest was killed by ${signal}`);
  if (code !== 0) {
    // A real test failure. Vitest already printed it; do not bury that under gate output.
    rmSync(out, { recursive: true, force: true });
    process.exit(code ?? 1);
  }

  // Exit 0 is where the trust stops and the summary starts.
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    fail(
      "vitest exited 0 but wrote no JSON summary, so no test is known to have run. " +
        "That is the pool-startup failure this gate exists for - scroll up for the error vitest printed.",
    );
  }

  // PASSED, not TOTAL. `numTotalTests` counts skipped tests, so a run in which every single test was skipped
  // reports the full number and sails through a floor written against it - verified: a stray
  // `--testNamePattern` that matches nothing skips all 2744 and `numTotalTests` still says 2744. Skipped is
  // not tested, and the whole point of this file is to refuse "looks like it ran".
  const passed = summary.numPassedTests ?? 0;
  const total = summary.numTotalTests ?? 0;
  const failed = summary.numFailedTests ?? 0;
  const skipped = total - passed - failed;
  // `testResults` is one entry per test FILE, which is the number to floor and the number to print.
  // `numTotalTestSuites` counts `describe` blocks - it reads like a file count and is roughly 4x one, so
  // reporting it made the gate's own success line overstate what had run.
  const files = summary.testResults?.length ?? 0;

  if (failed > 0 || summary.success === false) fail(`${failed} test(s) failed despite a zero exit code`);
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

  console.log(`\n✓ test gate: ${passed} tests passed across ${files} files${skipped > 0 ? `, ${skipped} skipped` : ""}, 0 failures`);
  rmSync(out, { recursive: true, force: true });
});
