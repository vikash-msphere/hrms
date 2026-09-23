// Which copy of the e2e stack this run owns.
//
// One run of the browser lane is four things that have to agree: a Vite port, a Worker port, a Prism port,
// and a database directory. They were four independent environment variables, so a SECOND run on the same
// machine (a full sweep in one terminal while a single spec is debugged in another) shared all four - two
// suites writing one D1 file, tearing down each other's Worker, and wiping each other's `test-results/`.
// Failures from that look exactly like flaky specs, and cost a day before anybody suspects the other window.
//
// So the four move together, off ONE knob: `E2E_LANE`. Lane 0 is the historical stack (5174 / 8788 / 4011,
// `.wrangler/e2e-state`, `test-results/`), so nothing anybody has typed before changes. Lane n is ten ports
// up with its own database and its own artifacts, and knows nothing about the others:
//
//   npm run test:e2e                      # lane 0, as always
//   E2E_LANE=1 npm run test:e2e           # a second, fully separate run alongside it
//
// The individual variables still win where one is set, for the odd case of pointing at a stack started by
// hand. scripts/e2eStack.sh does this same arithmetic in shell - keep the two in step.
const LANE = Number(process.env.E2E_LANE ?? 0);
if (!Number.isInteger(LANE) || LANE < 0 || LANE > 9) {
  throw new Error(`e2e: E2E_LANE must be a whole number 0-9 (got ${JSON.stringify(process.env.E2E_LANE)})`);
}

/** Ten ports per lane: enough room for the three this stack listens on, and no overlap with the next. */
const at = (base: number) => String(base + LANE * 10);

export const lane = {
  n: LANE,
  /** Vite, serving the SPA the specs drive. */
  webPort: process.env.E2E_PORT ?? at(5174),
  /** The Worker. Never 8787 - that is the dev stack, whose auth bypass collapses every role into one. */
  workerPort: process.env.E2E_WORKER_PORT ?? at(8788),
  /** The contract proxy `/v1` travels through. */
  prismPort: process.env.E2E_PRISM_PORT ?? at(4011),
  /** Traces, videos and error contexts. Playwright empties this at the START of a run, so two lanes sharing
   *  one directory means the second run deletes the first's evidence mid-flight. */
  outputDir: LANE ? `test-results-${LANE}` : "test-results",
};
