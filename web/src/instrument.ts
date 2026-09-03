// Sentry bootstrap. Imported FIRST by main.tsx, before React and before any app module, because the SDK can
// only instrument what loads after it: a fetch wrapper or a global error handler installed later misses every
// error thrown while the bundle was still evaluating. Nothing in this file may import from the app - that
// would pull the app's module graph in ahead of init and defeat the ordering.
//
// The DSN is a BUILD-time value (Vite bakes VITE_* into the bundle), so a build made without it ships with
// Sentry inert rather than half-configured. That is the intended default for local development: no DSN, no
// init, no network calls, no cost. `npm run preflight` warns when a production build is missing it.
import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN;

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
// Add a route here only when masking the whole page loses nothing worth reading.
const SENSITIVE_PAGES = [
  "payslips", // a table of net pay, deductions and statutory contributions - values with labels around them
  "payroll-runs", // the same, per employee, for a whole company
  "documents", // scanned identity documents, contracts, insurance cards
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

      integrations: [
        Sentry.replayIntegration({
          ...REPLAY_PRIVACY,
          networkCaptureBodies: false,
          // A tab open across a deploy asks for a hashed chunk that no longer exists. The app already handles
          // that as an expected condition (ErrorBoundary shows "This tab is out of date" and offers a reload),
          // so the replay would be sixty seconds of someone clicking a nav link - no defect to see, and one
          // upload per stale tab after every deploy. The pattern is the one lib/lazyPage.tsx matches on;
          // it is restated because nothing in this file may import from the app.
          beforeErrorSampling: (event) => {
            const v = event.exception?.values?.[0];
            return !/ChunkLoadError|Loading chunk|dynamically imported module|module script failed|Importing a module/i.test(
              `${v?.type ?? ""}: ${v?.value ?? ""}`,
            );
          },
        }),
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

      // Full sampling locally (a handful of page loads), a fraction in production, where every user's every
      // navigation is a billable transaction.
      tracesSampleRate: import.meta.env.DEV ? 1 : 0.2,
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

if (client) {
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
  const replay = Sentry.getReplay();
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
  const replay = Sentry.getReplay();
  if (!replay) return;
  void (async () => {
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
  const replay = Sentry.getReplay();
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
