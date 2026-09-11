// Sentry bootstrap. Imported FIRST by main.tsx, before React and before any app module, because the SDK can
// only instrument what loads after it: a fetch wrapper or a global error handler installed later misses every
// error thrown while the bundle was still evaluating. Nothing in this file may import from the app - that
// would pull the app's module graph in ahead of init and defeat the ordering.
//
// The DSN is a BUILD-time value (Vite bakes VITE_* into the bundle), so a build made without it ships with
// Sentry inert rather than half-configured. `npm run preflight` warns when a production build is missing it.
import * as Sentry from "@sentry/react";

// OFF IN DEV, whatever `web/.env` says.
//
// A DSN in `.env` is convenient for a production build and was quietly costly everywhere else: every error a
// developer causes on purpose, and every page the browser suite walks, was relayed into the same project
// people read when production breaks. It is noise in the place that must stay quiet, and with the suite
// running sixteen browsers at once it is a rate-limited flood of relayed subrequests through the Worker too.
//
// `VITE_SENTRY_IN_DEV=1` turns it back on for a dev server that means it.
//
// `VITE_SENTRY_IN_DEV=opt-in` is the browser suite's setting, and it is a THIRD state, not a synonym for on.
// Two specs (`reportProblem`, `replayMasking`) drive the real SDK and read the envelopes it produces, and both
// stub `/diag` in the page so nothing leaves the machine - but a server-wide `=1` armed the SDK in all ~350
// specs, and the other ~348 stub nothing: every error and trace they provoked was relayed through the Worker
// to the live Sentry project (569 envelopes in one run), which is both real telemetry from a test run and a
// few hundred outbound subrequests of load on the very Worker the suite is measuring. Under `opt-in` the SDK
// stays inert unless the page itself asks for it, which only those two specs do (`enableTelemetry` in
// e2e/fixtures.ts sets the flag before the app boots).
const pageOptIn = (globalThis as { __hrmsSentryOptIn?: boolean }).__hrmsSentryOptIn === true;
const inDev = import.meta.env.VITE_SENTRY_IN_DEV;
const devOptIn = inDev === "1" || (inDev === "opt-in" && pageOptIn);
const dsn = import.meta.env.DEV && !devOptIn ? undefined : import.meta.env.VITE_SENTRY_DSN;

// The few routes where practically EVERYTHING on screen is a value, masked whole by `[data-page="…"]`
// (App.tsx stamps the route key onto <main>).
//
// This list was fifteen routes and that was the mistake. Expenses, vendors, compliance, reimbursements,
// background checks, settings, the employee profile - masking those masked their headings, their hints, their
// statuses, their dates, their category names: ordinary business data that tells you what a person was
// looking at. The result was replays that were unreadable everywhere without being meaningfully safer, and
// route-level masking is simply the wrong instrument for a page that is mostly chrome around a few numbers.
//
// What replaced it is narrower and lives closer to the data: the seven profile panels and their editing
// dialogs carry `sentry-mask` themselves (test/replayMaskCoverage.test.ts holds them to it), and the
// `input[name*=…]` rules below catch account/PAN/Aadhaar/salary fields wherever in the app they appear.
//
// THE TEST FOR ADDING A ROUTE HERE, since "it feels sensitive" put fifteen of them on the list: the page's
// VALUES have to be something the app itself PROMISED would not be read by a bystander. Money and identity
// documents are the original three. The five below are the promises the rest of the product makes - an
// anonymous suggestion, a confidential appraisal, a private 1:1, a tax proof, a background report - and every
// one of them was being recorded in full while the payslip list next door was masked. "Ordinary business data
// on a page that happens to be about people" (expenses, compliance, a directory) still does not qualify: the
// `unmask` list below keeps headings, columns, tabs, labels, buttons and errors readable on a masked route, so
// what a route mask actually costs is the values - which is the whole point when the values are these.
const SENSITIVE_PAGES = [
  "payslips", // a table of net pay, deductions and statutory contributions - values with labels around them
  "payroll-runs", // the same, per employee, for a whole company
  "documents", // scanned identity documents, contracts, insurance cards
  // Performance. Ratings and written assessments, plus 360 feedback, whose whole design is that the subject
  // cannot attribute it - a replay of the calibration grid or a reviewer's draft undoes that from outside.
  "reviews",
  // The suggestion box. Anonymity is a PRODUCT PROMISE (services/suggestions.ts keeps the submitter off the
  // notification and out of the peer view); a replay records the body next to an identified session, which is
  // the one place that promise can be broken without anybody editing a line of server code.
  "suggestions",
  // Private 1:1s. The notes are written on the understanding that the two people in the room are the readers.
  "check-ins",
  // Tax declarations: PAN, regime, rent and investment proofs - identity numbers and financial detail.
  "tax-declarations",
  // Background verification results. What a check came back with about somebody's past is the most damaging
  // single field in the app, and unlike a salary it is about them rather than their employment.
  "background-checks",
] as const;

/**
 * What session replay may and may not see.
 *
 * The posture is UNMASK-BY-DEFAULT: text, inputs and media are recorded, and only what is listed here is
 * hidden. That is the opposite of the SDK's default and of what this file shipped with, and it is a deliberate
 * trade - a replay where every label reads `*****` shows you the shape of a page and nothing about what went
 * wrong on it, which is most of the reason to record at all.
 *
 * The cost is that the failure mode inverts too. Under mask-by-default, forgetting to tag something leaked
 * nothing; here, forgetting leaks it. So the list below leans on things that do not depend on anybody
 * remembering: whole ROUTES rather than individual fields, and ATTRIBUTE conventions rather than class names
 * that a restyle can rename. A new salary panel on the profile page is masked because the page is masked.
 *
 * Within a masked route, `unmask` puts the STRUCTURE back - headings, column names, tabs, buttons, errors -
 * because a replay in which every one of those reads `***` shows nothing at all. See the note on that list.
 *
 * When adding UI that shows money, an identity number, a bank account, a medical or a document, put
 * `data-sentry-mask` on it (or `data-sentry-block` to hide the element entirely) if it can appear outside
 * these routes - a dialog opened from the dashboard, a drawer on a board.
 */
const REPLAY_PRIVACY = {
  // Recorded, so a replay shows the page as the person saw it.
  maskAllText: false,
  maskAllInputs: false,
  blockAllMedia: false,

  mask: [
    // The opt-in conventions. Both spellings, because a component may carry either.
    ".sentry-mask",
    "[data-sentry-mask]",
    // Whole sensitive routes.
    ...SENSITIVE_PAGES.map((p) => `[data-page="${p}"]`),
    // A dialog renders through a PORTAL, as a child of <body>, so it sits outside `<main data-page="…">` and
    // the route mask above cannot reach it - the "edit bank details" form was recorded in full while the page
    // behind it was masked. The fix is the `.sentry-mask` convention on the SEVEN dialogs that actually edit
    // pay, identity or bank data (EmployeeBankDetails, EmployeeCompensation, EmployeeTaxDetails,
    // EmployeeSettlement, EmployeeBonuses, EmployeeIdentityDetails, EmployeePersonalDetails), not a blanket
    // rule on every overlay: masking every dialog on a sensitive route also took the confirm prompts, the
    // pickers and the report form itself, which is the over-masking this whole list exists to avoid.
    // test/replayMaskCoverage.test.ts holds those seven to it.
    // Fields that are sensitive wherever they appear, matched on what the BROWSER already knows about them
    // rather than on app markup: autocomplete hints and input types are set for the password manager's
    // benefit and are therefore both present and stable.
    'input[type="password"]', // masked by rrweb regardless; restated so the intent is legible
    'input[autocomplete*="cc-"]',
    // Identity and bank numbers: fixed-format identifiers that are worth something to whoever reads them, and
    // that a person cannot change if they leak.
    'input[name*="account" i]',
    'input[name*="ifsc" i]',
    'input[name*="pan" i]',
    'input[name*="aadhaar" i]',
    'input[name*="uan" i]',
    // NOT money. `amount`, `salary` and `ctc` were here and matched an input on nearly every form in the app -
    // expenses, reimbursements, loans, bonuses, budgets - so an ordinary expense form recorded as a row of
    // labels around one box of asterisks. Money on the pages where it IS the point (payslips, payroll runs) is
    // covered by masking those routes, and on the profile by the compensation panel; a figure somebody typed
    // into an expense claim is not the same class of secret as their PAN.
  ],

  // Punched back through the page-level mask above. rrweb decides per text node by DISTANCE - the nearer of a
  // matching `mask` ancestor and a matching `unmask` ancestor wins - so listing structure here makes a
  // sensitive page readable as a PAGE while its values stay hidden.
  //
  // Masking a whole route was too blunt: on payslips and payroll runs it hid the headings, the tab you were
  // on, the column names, the buttons and the error message, which is everything a bug report needs and none
  // of what it must not carry. A replay of `***` clicking `***` is not evidence of anything.
  //
  // Every entry is a container of LABELS rather than values: a heading names a section, a `th` names a column,
  // a tab names where you are, an alert says what went wrong. Amounts, names and identifiers live in the
  // cells, inputs and definition values that are deliberately absent from this list, so they stay masked.
  // `button` is the one judgement call - most are verbs ("Download", "Recalculate") and a masked action bar
  // makes a replay unreadable, but a button labelled with an amount would be exposed; tag that one
  // `data-sentry-mask` at the call site, which wins by being nearer.
  // Attribute masking OFF. The SDK's default is `["title", "placeholder", "aria-label"]`, and all three are
  // strings WE wrote - "e.g. 1234567890", "Search employees", "Remove attachment". Masking them turned every
  // empty field inside a masked panel into an unlabelled box and stripped the accessible names a replay needs
  // to make sense, while protecting nothing: no value of a person's is carried in a placeholder.
  maskAttributes: [],

  unmask: [
    "[data-sentry-unmask]",
    "dt", // a definition-list TERM is the label; the value beside it in the <dd> is what stays masked
    "h1",
    "h2",
    "h3",
    "h4",
    "th", // column names
    // In-page navigation: the workspace tab strip is <nav><a href="#/…">Reimbursements</a></nav>, so masking
    // it hid WHICH SECTION the person was in - the first thing anyone triaging asks. A nav holds labels of
    // places, never values.
    "nav",
    "#page-description", // PageHeader's standing description; static copy, and it names what the page is for
    "label", // field labels, not their values
    "button",
    '[role="tab"]',
    '[role="alert"]', // the error text, which is usually the whole point of the report
  ],

  // Replaced entirely rather than masked: these are not text, so masking would not touch them. An iframe here
  // is always a rendered PDF (payslip, letter, Form 16) and a canvas is a chart, a barcode or a signature pad.
  block: [".sentry-block", "[data-sentry-block]", "iframe", "canvas"],

  // Keystrokes are never recorded for these, even where the field itself is visible - what somebody TYPES into
  // a search box is often the thing they would never put in a ticket.
  ignore: [".sentry-ignore", "[data-sentry-ignore]", 'input[type="search"]', 'input[type="file"]'],
};

// Last-resort scrub on the way out. The masking policy above governs the SCREEN; this governs the TEXT of an
// event - a message, an exception's value, a breadcrumb - which masking never touches. An identity number
// reaches those places by ordinary accident: a validation error quoting the value it rejected, a fetch URL
// with an account number in it, a ticket subject somebody pasted a PAN into.
//
// Deliberately narrow. Each pattern is a format with a checkable shape, so it matches the thing and not prose:
// a greedy "looks like digits" rule would redact order counts and dates and make every issue unreadable, which
// is its own way of losing the data. This is a net under the deny-list, not a replacement for it.
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan]"], // Indian PAN: five letters, four digits, a letter
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, "[ifsc]"], // IFSC: four letters, a literal 0, six alphanumerics
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[aadhaar]"], // 12 digits, however they were spaced
  [/\b\d{9,18}\b/g, "[account]"], // a bare run of 9-18 digits is an account number, not a quantity
];

const scrub = (text: string): string => PII_PATTERNS.reduce((acc, [re, tag]) => acc.replace(re, tag), text);

// Not `Sentry.init({ dsn: undefined })`. An init with an empty DSN still installs the integrations and their
// global handlers, just to drop every event at the end - all of the overhead and none of the benefit.
const client = dsn
  ? Sentry.init({
      dsn,
      // Every envelope goes to our own origin, and the Worker forwards it (routes/diag.ts). Posting straight
      // to the vendor's ingest host meant ad and tracking blockers - which carry it on every default list -
      // killed the request, and a blocked cross-origin POST comes back with no CORS headers: "CORS Failed" in
      // the console, event dropped, nobody the wiser. Same-origin, nothing to match, and it keeps connect-src
      // at 'self'. The path is deliberately unremarkable: `/sentry-tunnel`, the documented name, is itself a
      // filter rule by now.
      tunnel: "/diag",
      environment: import.meta.env.MODE,
      // Set at build time (see web/.env.example). Without it every issue is tagged "unknown release" and the
      // regression/resolved-in-next-release machinery has nothing to key on.
      release: import.meta.env.VITE_APP_VERSION,

      // This is an HR system: the payloads flowing through it are salaries, bank accounts, personal documents
      // and identity numbers. None of that belongs in an error tracker, so the collection defaults - which
      // send request/response bodies, cookies and all headers - are narrowed rather than accepted.
      dataCollection: {
        // The session cookie (hrms_session) is a bearer credential. Never leaves the origin.
        cookies: false,
        // No request or response bodies: this is where the payroll and PII rows would ride along.
        httpBodies: [],
        httpHeaders: {
          request: { deny: ["authorization", "cookie", "cf-access-jwt-assertion"] },
          response: { deny: ["set-cookie"] },
        },
      },

      // Replay is NOT here. It is attached after first paint from web/src/sentryReplay.ts - see
      // REPLAY_OPTIONS and the installer below.
      integrations: [
        Sentry.browserTracingIntegration({
          // Both off, and driven by hand below. The app routes on the URL HASH (see router.ts), which the
          // automatic instrumentation cannot see: every route in the SPA is the same pathname, so every
          // pageload and navigation would arrive named "/" and the trace view would be one undifferentiated
          // blob. The manual spans below carry the real route pattern instead.
          instrumentPageLoad: false,
          instrumentNavigation: false,
        }),
      ],

      // Applied to every event and every breadcrumb, after everything else has had its say.
      beforeSend(event) {
        if (event.message) event.message = scrub(event.message);
        for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrub(ex.value);
        return event;
      },
      beforeBreadcrumb(crumb) {
        if (crumb.message) crumb.message = scrub(crumb.message);
        // Breadcrumbs for fetch/xhr carry the URL, and a record id in a path is fine - a number that looks
        // like an account is not.
        const url = crumb.data?.url;
        if (typeof url === "string") crumb.data!.url = scrub(url);
        return crumb;
      },

      // The long trail. Breadcrumbs are the only thing here that spans a WHOLE session - every click,
      // navigation, fetch and console line, timestamped, attached to the issue automatically - and they cost
      // nothing in quota or privacy beyond what is already collected. The replay covers at most the minute
      // before a report (see captureSessionReplay); this is what answers "what were they doing before that".
      // The default 100 is a few minutes on a busy page, which is shorter than the sessions people report from.
      maxBreadcrumbs: 300,

      // A fraction in production, where every user's every navigation is a billable transaction - and NONE in
      // dev, where a transaction per navigation buys nobody anything and costs plenty. "Full sampling locally"
      // sounded free and was not: it ships a trace for every page a developer opens and every page the browser
      // suite walks, into the same project people read when production breaks. Sixteen parallel browsers make
      // that a rate-limited flood of relayed subrequests through the Worker. Errors and the replay that
      // accompanies them are unaffected - those are the signals dev actually uses.
      tracesSampleRate: import.meta.env.DEV ? 0 : 0.2,
      // The API is same-origin (`fetch("/v1…")` - see api.ts), so trace headers go to it and nowhere else.
      // Left unset the SDK would still default to same-origin, but the Worker is the only thing on the other
      // end of a trace and saying so keeps a future absolute URL from silently leaking headers off-origin.
      tracePropagationTargets: [/^\/v1\//],

      // Errors-only replay. Nothing is uploaded while the app is behaving: the SDK keeps recent activity in
      // memory and discards it at session end. An error flushes that buffer, so what arrives is the run-up to
      // the bug and nothing else. NOTE the buffer is a SAWTOOTH, not a rolling window - see below. Recording a fraction of ALL sessions is the other common choice
      // and is rejected here on purpose - continuous screen capture of people doing their HR admin is a
      // surveillance question, not a debugging one, and it is not needed to reproduce a crash.
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1,
    })
  : undefined;

// The route PATTERN, not the URL: `#/employees/emp_01j…/documents` is `/employees/:id/documents`. Ids in a
// transaction name would give every employee their own "route" and make the slowest-page view useless.
// Parsed the same way router.ts parses it - page / id / sub, query discarded.
function routePattern(): string {
  const path = window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  const [page, id, sub] = path.split("/");
  return `/${page || "dashboard"}${id ? "/:id" : ""}${sub ? `/${sub}` : ""}`;
}

// Everything the recorder is configured with. Data only - the recorder itself is 39.9 kB gz and is fetched
// separately (web/src/sentryReplay.ts). The privacy policy stays HERE, next to the note explaining it and
// where test/replayMaskCoverage.test.ts reads it.
const REPLAY_OPTIONS = {
  ...REPLAY_PRIVACY,
  networkCaptureBodies: false,
  // A tab open across a deploy asks for a hashed chunk that no longer exists. The app already handles that as
  // an expected condition (ErrorBoundary shows "This tab is out of date" and offers a reload), so the replay
  // would be sixty seconds of someone clicking a nav link - no defect to see, and one upload per stale tab
  // after every deploy. The pattern is the one lib/lazyPage.tsx matches on; it is restated because nothing in
  // this file may import from the app.
  beforeErrorSampling: (event: { exception?: { values?: { type?: string; value?: string }[] } }) => {
    const v = event.exception?.values?.[0];
    return !/ChunkLoadError|Loading chunk|dynamically imported module|module script failed|Importing a module/i.test(
      `${v?.type ?? ""}: ${v?.value ?? ""}`,
    );
  },
};

type ReplayModule = typeof import("./sentryReplay");

/** The attached recorder module, or undefined if its chunk would not load. Never rejects - see loadReplay. */
let replayReady: Promise<ReplayModule | undefined> | undefined;

/**
 * Fetch the recorder chunk and attach it, once.
 *
 * NEVER REJECTS, and that is the point rather than tidiness. The recorder is a diagnostic, never a
 * dependency: a chunk that will not load - the browser is offline, or a tab open across a deploy is asking
 * for a hashed file that no longer exists, which this very file treats as routine in `beforeErrorSampling` -
 * has to leave the app working and every other Sentry signal (errors, breadcrumbs, traces) intact.
 *
 * A rejection here would surface in the worst possible place. `captureSessionReplay` is awaited by
 * ReportProblemDialog's submit BEFORE its try block, and that dialog throws-to-fail, so a rejected load would
 * pin an error in the form and stop the ticket being created at all - the person is reporting a fault and the
 * report is what breaks. So the failure resolves to `undefined` instead, and the memo is cleared so a later
 * report tries again rather than inheriting one bad moment for the rest of the session.
 */
function loadReplay(): Promise<ReplayModule | undefined> {
  return (replayReady ??= import("./sentryReplay").then(
    (m) => {
      // Guarded separately from the handler beside it, which only ever sees the IMPORT fail: a throw in here -
      // an SDK that refuses the integration - would reject the memo itself and be re-thrown to every later
      // awaiter of it, which is the one thing this function promises not to do. The module is still returned:
      // a recorder that would not attach is a recorder `activeReplay()` reports as absent.
      try {
        m.installReplay(REPLAY_OPTIONS);
      } catch {
        /* no recorder attached; every caller already treats that as "no replay to offer" */
      }
      return m;
    },
    () => {
      replayReady = undefined;
      return undefined;
    },
  ));
}

/**
 * The running recorder, loading it first if it is not attached yet. Undefined when there is none, never a
 * rejection - every caller below is documented as returning `undefined` rather than throwing.
 *
 * The wait matters for correctness, not just tidiness. Somebody who hits a fault in the first seconds and
 * opens the report dialog straight away would otherwise find no recorder at all and get a ticket with no
 * replay attached - the one report most worth having a film of. Awaiting the load means they get a recorder;
 * what it holds is whatever has accumulated since it started, which is the same "sawtooth" caveat the buffer
 * always had (see captureSessionReplay).
 */
async function currentReplay() {
  if (!client) return undefined;
  // The module the load resolved with, not a second `import()`. A second one would reject on a chunk that
  // failed, which is exactly what the handler above exists to prevent.
  return (await loadReplay())?.activeReplay();
}

if (client) {
  // Started NOW, not on an idle callback.
  //
  // What takes the recorder off the critical path is that it is a dynamically imported chunk of its own, so
  // index.html neither loads nor `modulepreload`s it and first paint never waits for it. WHEN the import
  // fires changes nothing about that - only how early the recorder begins buffering.
  //
  // So there is nothing to buy by waiting, and something real to lose. The SDK drops any replay shorter than
  // its 5s `minReplayDuration`, measured from when the recorder starts, so deferring the load to idle (~3s)
  // would leave the first ~8 seconds of every session unable to produce a replay at all - and the reports
  // worth the most are the ones somebody files the moment something breaks. A version of this that idled for
  // 3s also put the recorder under that floor for e2e/replayMasking.spec.ts, which flushes at 6s.
  void loadReplay();

  // Source "route" from the start, unlike the reference flow that opens on "url" and upgrades: the hash is
  // already in the address bar when this module runs, so the pattern is known before the first span exists
  // and there is nothing to wait for.
  Sentry.startBrowserTracingPageLoadSpan(client, {
    name: routePattern(),
    attributes: { [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: "route" },
  });

  // A dedicated listener rather than a hook inside useRoute: useRoute is mounted by several components at
  // once, so a span started there would be started several times per navigation. `hashchange` fires once.
  let last = routePattern();
  window.addEventListener("hashchange", () => {
    const next = routePattern();
    // Query-only writes (filters, an opened dialog, `?setting=`) fire hashchange without changing the route.
    // They are not navigations and must not open a transaction.
    if (next === last) return;
    last = next;
    Sentry.startBrowserTracingNavigationSpan(client, {
      op: "navigation",
      name: next,
      attributes: { [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: "route" },
    });
  });
}

/** Whether this build is reporting to Sentry at all. Lets a caller skip work that would only feed an inert SDK. */
export const sentryEnabled = Boolean(client);

/**
 * Raise an issue in the tracker for a problem a person reported by hand.
 *
 * Without this a reported problem exists only as a ticket, and the tracker - the place the people who fix the
 * app actually watch - never hears about it. Which is backwards: a user who took the trouble to describe a
 * fault is a better signal than most unhandled exceptions, and this is the only kind of report that comes
 * with a sentence explaining what the person was trying to do.
 *
 * Captured as a MESSAGE, not an exception: nothing threw, and dressing it as one would give the issue a
 * meaningless stack from inside this function and group unrelated reports together by it. The fingerprint is
 * the ticket id, so each report is its own issue rather than every report in history piling into one
 * "problem reported" group.
 *
 * At `error` level, though. This was `warning` on the reasoning that nothing crashed, and the result was that
 * reports arrived in the tracker and notified nobody - measured, not guessed: two events differing only in
 * level, and only the `error` one produced an alert. Notification rules key on level, and a fault a person
 * stopped to describe deserves at least the weight of an unhandled exception nobody noticed.
 */
export function reportProblemToSentry(
  subject: string,
  detail: string,
  ticket: { id: string; url: string },
  replayId?: string,
): void {
  if (!client) return;
  Sentry.withScope((scope) => {
    scope.setLevel("error");
    scope.setFingerprint(["user-reported-problem", ticket.id]);
    // The two ends of the same report: from the issue you can open the ticket and reply to the person, and
    // from the ticket you can watch what they did. Neither is much use alone.
    scope.setTag("reported_by_user", "true");
    scope.setTag("ticket", ticket.id);
    if (replayId) scope.setTag("replay_id", replayId);
    scope.setContext("report", {
      ticket: ticket.url,
      what_happened: detail || "(not described)",
      // Where they were when they hit it. The issue's own `url` is this too, but it is the first thing anyone
      // triaging asks and it belongs next to the description rather than in the request context.
      page: window.location.hash || "/",
    });
    Sentry.captureMessage(subject);
  });
}

/** The Sentry org slug, needed to turn a replay id into a console link. Absent = no linkable console. */
export const sentryOrg = import.meta.env.VITE_SENTRY_ORG;

/** Where a support agent watches one replay. Undefined when the build has no org configured. */
export const replayUrl = (id: string): string | undefined =>
  sentryOrg ? `https://${sentryOrg}.sentry.io/replays/${id}/` : undefined;

/**
 * Upload the 60 seconds BEFORE this call and return the replay's id, for attaching to a support ticket.
 *
 * Replay runs in buffer mode (see the sample rates above), so the last 60s are already being recorded in
 * memory on every page and simply discarded unless something asks for them. This does not start recording; it
 * decides to keep what is already there.
 *
 * WHEN it is called is the whole design. The buffer is NOT a rolling 60-second window, which is the easy
 * thing to assume and is wrong: rrweb takes a full snapshot every `BUFFER_CHECKOUT_TIME` (60s, a constant and
 * not an option) and the SDK CLEARS the buffer on each one (`if (isCheckout && isBufferMode) eventBuffer
 * .clear()`). So what is held is everything since the last snapshot - a sawtooth between 0 and 60 seconds,
 * averaging 30 - and a flush landing just after a checkout keeps only a few seconds however long the person
 * had been working. Nothing here can widen that; only session mode records continuously.
 *
 * What this timing CAN control is which seconds are spent on the fault rather than on the report. Called at submit, a person who opens the dialog, reads
 * it, types two sentences and presses Send has spent the entire window on the act of reporting, and what
 * arrives is a recording of them filling in a form. So it is called when the dialog OPENS: the window that
 * gets kept is the minute leading up to "something is wrong here", which is the only minute worth having.
 *
 * `continueRecording: false` is the other half, and it is what keeps this bounded. Left at its default the
 * flush converts the recorder to SESSION mode and never stops - the rest of that browser session is recorded
 * continuously, for someone whose only act was to report a bug. So the flush stops the recorder instead, and a
 * fresh buffer is started immediately after, which leaves the app exactly where it began: the last minute in
 * memory, nothing uploaded, waiting for the next error or report.
 *
 * Continuous recording exists in one place only - `startManualRecording()` / `finishManualRecording()` below
 * - for the two minutes of a demonstration the person explicitly started, and as a replay of its own.
 *
 * Returns undefined, never throws, when there is nothing to attach: no DSN in this build, replay not running,
 * or a session shorter than `minReplayDuration` (5s) - the SDK drops those, and a report must still be
 * possible when it does.
 */
export async function captureSessionReplay(): Promise<string | undefined> {
  const replay = await currentReplay();
  if (!replay) return undefined;
  try {
    await replay.flush({ continueRecording: false });
    // `true` = only report the id if the replay was actually sampled and sent. Without it a buffered replay
    // that never left the browser still hands back an id, and the ticket would link to a 404. Read before the
    // buffer is restarted below, which begins a new replay with a new id.
    const id = replay.getReplayId(true);
    replay.startBuffering();
    return id;
  } catch {
    return undefined;
  }
}

/**
 * Begin the manual "Record the problem" window as a REPLAY OF ITS OWN.
 *
 * `flush()` was wrong for this. It converts the existing buffered session to session mode and carries on under
 * the same id, so the demonstration was glued onto whatever came before it - the run-up, the dialog being
 * read - and support got one long replay with no boundary marking where the person started demonstrating.
 * `start()` "will always create a new session", which is the boundary: the replay begins when they press
 * Record and holds nothing else.
 *
 * The buffered session is stopped first, with `flush: false`, because its pending segment is somebody reading
 * a dialog. Nothing is lost - the run-up was already flushed and uploaded when the dialog opened.
 */
export function startManualRecording(): void {
  void (async () => {
    const replay = await currentReplay();
    if (!replay) return;
    try {
      await replay.stop({ flush: false });
      replay.start();
    } catch {
      /* the window is a convenience; a recorder that will not restart must not block the report */
    }
  })();
}

/**
 * End the manual window and return the replay id for the ticket.
 *
 * `stop()` flushes the pending segment in session mode, so the demonstration lands complete, and it ENDS the
 * replay - nothing is recorded after the countdown expires or Stop is pressed. Buffering restarts afterwards
 * to leave the app in its resting posture: the last minute in memory, nothing uploaded.
 */
export async function finishManualRecording(): Promise<string | undefined> {
  const replay = await currentReplay();
  if (!replay) return undefined;
  try {
    // Read BEFORE stopping: once the replay has ended there is no current session to report an id for.
    const id = replay.getReplayId(true);
    await replay.stop();
    replay.startBuffering();
    return id;
  } catch {
    return undefined;
  }
}
