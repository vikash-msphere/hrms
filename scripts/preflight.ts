// Pre-deploy gate. Everything here is a mistake that a build cannot catch and that only shows up in
// production: a config value that is still a placeholder, an optional feature that will ship silently
// switched off, or a wrangler.toml block that does not match the Cloudflare plan being deployed to.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/preflight.ts [--env <name>]
//
// Wired into `npm run deploy`. ERRORs exit non-zero and stop the deploy; WARNs print and continue, because
// they describe features that are legitimately optional (push, staging) rather than broken ones.
//
// CF_PLAN selects the plan being deployed to: "paid" (Workers Standard, the default) or "free". It decides
// whether the `[limits]` block is valid - `[limits]` is a paid-plan feature and a free-plan deploy carrying
// it is rejected by Cloudflare, which is a confusing failure to hit for the first time mid-deploy.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
// Pure domain constants (no I/O, no bindings) - imported rather than regex-scraped so a rename breaks the
// build instead of silently disabling the check below.
import { DEFAULT_TAX_FY_START_YEAR, fyLabels } from "../src/domain/incomeTax";

const root = resolve(import.meta.dirname, "..");
const read = (p: string) => {
  try {
    return readFileSync(resolve(root, p), "utf8");
  } catch {
    return "";
  }
};

const errors: string[] = [];
const warns: string[] = [];

/** The short commit (with a `-dirty` suffix when the tree is not clean), or undefined without git. MUST match
 *  `resolveAppVersion` in web/vite.config.ts - this reports what that will stamp, so if the two drift the
 *  check describes a release the build does not claim. */
function gitRelease(): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!sha) return undefined;
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
}

const envFlag = process.argv.indexOf("--env");
const targetEnv = envFlag >= 0 ? process.argv[envFlag + 1] : undefined;
const plan = (process.env.CF_PLAN ?? "paid").toLowerCase();

const wrangler = read("wrangler.toml");
const webEnv = read("web/.env");

// --- 1. Placeholders that would deploy a broken binding -----------------------------------------------
// A literal REPLACE_WITH_* left in the target environment's config means the deploy points at nothing.
// Which environment a line belongs to is decided by the nearest preceding section header: anything under
// `[env.<name>...]` belongs to that named environment, anything else to the default (production) one.
{
  let section: string | undefined; // undefined = the default/top-level environment
  for (const line of wrangler.split("\n")) {
    const header = line.match(/^\s*\[+\s*(?:env\.([a-z0-9_-]+)|[a-z0-9_.]+)/i);
    if (header) section = header[1]; // a non-env header resets to the default environment
    const placeholder = line.match(/^\s*([a-z_]+)\s*=\s*"(REPLACE_WITH_[A-Z0-9_]+)"/);
    if (!placeholder) continue;
    const where = section ? `env.${section}` : "the default (production) environment";
    const msg = `wrangler.toml: ${placeholder[1]} is still the placeholder ${placeholder[2]} in ${where}.`;
    // Only fatal when deploying the environment that actually carries the placeholder.
    if (section === targetEnv || (!section && !targetEnv)) errors.push(msg);
    else warns.push(`${msg} Provision it before deploying that environment.`);
  }
}

// --- 2. Plan vs wrangler.toml -------------------------------------------------------------------------
const hasLimits = /^\s*\[limits\]/m.test(wrangler);
if (plan === "free" && hasLimits) {
  errors.push("wrangler.toml has a [limits] block, which is a paid-plan (Workers Standard) feature, but CF_PLAN=free. Comment the block out, or deploy on the paid plan.");
} else if (plan !== "free" && plan !== "paid") {
  errors.push(`CF_PLAN must be "paid" or "free" (got "${plan}").`);
} else if (plan === "paid" && !hasLimits) {
  warns.push("CF_PLAN=paid but wrangler.toml has no [limits] block - PDF/Form-16 rendering runs without an explicit CPU ceiling.");
}

// --- 2a. The local auth bypass must never reach a DEPLOYED environment --------------------------------
// `DEV_FAKE_EMAIL` + `ALLOW_DEV_AUTH="true"` together turn off authentication outright: middleware/auth.ts
// resolves EVERY request to that one identity with no token check of any kind, and deps.ts assertConfigured
// accepts the pair as a valid auth mode, so nothing else in the app objects. It is the single most severe
// misconfiguration this repo can carry, and until now it was the only one guarded by prose alone
// (docs/deploy.md, docs/deploy-security.md §3) while strictly milder ones - a staging placeholder, an email
// sink - were hard errors here.
//
// Fatal for EVERY environment in the file, not just the one being deployed, which is where this differs from
// the email checks below: a redirect sink is the right setting for a rehearsal environment, and an auth
// bypass is never the right setting for anything that is deployed at all. The bypass belongs in `.dev.vars`,
// which is local-only and git-ignored and is not read from here.
//
// What this cannot see: `wrangler deploy --var`, and a variable set by hand in the dashboard. The runbook
// covers both; this covers the file, which is the way one actually gets committed.
{
  let section: string | undefined;
  for (const line of wrangler.split("\n")) {
    const header = line.match(/^\s*\[+\s*(?:env\.([a-z0-9_-]+)|[a-z0-9_.]+)/i);
    if (header) section = header[1];
    const hit = line.match(/^\s*(ALLOW_DEV_AUTH|DEV_FAKE_EMAIL)\s*=/);
    if (!hit) continue;
    const where = section ? `env.${section}` : "the default (production) environment";
    errors.push(
      `wrangler.toml: ${hit[1]} is set in ${where} - with DEV_FAKE_EMAIL and ALLOW_DEV_AUTH="true" both present the Worker authenticates nobody and answers every request as that one identity (src/middleware/auth.ts). Remove it; the bypass belongs in .dev.vars, which is never deployed.`,
    );
  }
}

// --- 2b. The email sink must not reach production -----------------------------------------------------
// EMAIL_PROVIDER=console writes "would send to …" to the log and posts nothing (src/lib/email.ts). It is the
// right setting for the browser suite and for a preview stack, and a silent disaster in production: every
// offer letter, interview invite and payslip notification is accepted, recorded as sent, and thrown away.
// Nothing downstream can tell - the send resolves - so this is the only place it can be caught.
{
  let section: string | undefined;
  for (const line of wrangler.split("\n")) {
    const header = line.match(/^\s*\[+\s*(?:env\.([a-z0-9_-]+)|[a-z0-9_.]+)/i);
    if (header) section = header[1];
    if (!/^\s*EMAIL_PROVIDER\s*=\s*"console"/.test(line)) continue;
    const where = section ? `env.${section}` : "the default (production) environment";
    const msg = `wrangler.toml: EMAIL_PROVIDER = "console" in ${where} - that provider sends nothing, it only logs.`;
    if (section === targetEnv || (!section && !targetEnv)) errors.push(msg);
    else warns.push(`${msg} Fine for a preview environment; never deploy it as production.`);
  }
}

// --- 2b-ii. The local-model transport must not reach a deploy ------------------------------------------
// AI_LOCAL_URL replaces BOTH the `AI` binding and the Vectorize index with a model on the developer's own
// machine (src/lib/aiLocal.ts). Deployed, it would point the AI layer at the Worker's own loopback, where
// nothing answers: every feature would fall back silently, which is the shape of outage that gets noticed
// weeks later by somebody wondering why the draft button never appears.
//
// The var is already harmless in the sense that matters - `assertLoopback` refuses any host but this machine,
// so it cannot become an egress channel wherever it is set. This check is about INTENT rather than safety: it
// is a development setting, it belongs in .dev.vars and e2e/e2e.vars, and a deploy carrying it is a mistake
// whichever environment it lands in. Unscoped for that reason, unlike the email sinks below, which are right
// for a rehearsal environment and wrong only in production.
{
  let section: string | undefined;
  for (const line of wrangler.split("\n")) {
    const header = line.match(/^\s*\[+\s*(?:env\.([a-z0-9_-]+)|[a-z0-9_.]+)/i);
    if (header) section = header[1];
    if (!/^\s*AI_LOCAL_URL\s*=/.test(line)) continue;
    const where = section ? `env.${section}` : "the default (production) environment";
    errors.push(
      `wrangler.toml: AI_LOCAL_URL is set in ${where} - that redirects the whole AI layer at a model on the developer's machine (src/lib/aiLocal.ts), which no deployed Worker can reach. Remove it; it belongs in .dev.vars and e2e/e2e.vars, neither of which is deployed.`,
    );
  }
}

// --- 2c. ...and the redirect sink must not reach production either -------------------------------------
// EMAIL_REDIRECT_TO diverts every message to one address (src/lib/email.ts). In production that is the same
// class of silent failure as `console`: the vendor accepts, the send resolves, the trail says "sent", and the
// employee it was addressed to never hears. It is the RIGHT setting for a rehearsal environment, so this is
// scoped to the environment being deployed - and a preview environment on a real provider WITHOUT it is
// flagged the other way, because that one mails real people from a real sender.
{
  let section: string | undefined;
  const provider = new Map<string | undefined, string>();
  const redirect = new Set<string | undefined>();
  for (const line of wrangler.split("\n")) {
    const header = line.match(/^\s*\[+\s*(?:env\.([a-z0-9_-]+)|[a-z0-9_.]+)/i);
    if (header) section = header[1];
    const p = line.match(/^\s*EMAIL_PROVIDER\s*=\s*"([^"]+)"/);
    if (p) provider.set(section, p[1]!);
    if (/^\s*EMAIL_REDIRECT_TO\s*=\s*"\S/.test(line)) redirect.add(section);
  }
  const where = (s: string | undefined) => (s ? `env.${s}` : "the default (production) environment");
  for (const s of redirect) {
    if (s === targetEnv || (!s && !targetEnv)) {
      errors.push(`wrangler.toml: EMAIL_REDIRECT_TO is set in ${where(s)} - every message would be diverted to that one address instead of reaching the person it is addressed to.`);
    }
  }
  // The inverse, for the environment actually being deployed: a preview/staging target on a real vendor with
  // no sink and no redirect will mail whoever is in its database.
  const target = targetEnv;
  if (target && !redirect.has(target) && (provider.get(target) ?? "resend") !== "console") {
    warns.push(`wrangler.toml: env.${target} sends through a real email provider with no EMAIL_REDIRECT_TO - a rehearsal there (the nightly cron included) will mail the real addresses in that environment's database. Set EMAIL_REDIRECT_TO, or EMAIL_PROVIDER = "console".`);
  }
}

// --- 2d/2e. Edge controls a preflight cannot read for itself ------------------------------------------
// Two things this app depends on are configured in the Cloudflare dashboard, not in this repo: the WAF
// rate-limiting rules, and HSTS at the zone. Neither is readable from here - there is no binding for the
// zone config and no token to ask with - so what a preflight CAN require is an explicit, dated
// acknowledgement from whoever configured them.
//
// That is not security theatre. Both carried for months as prose in a runbook, which is the same as not
// having them: nothing failed, no deploy stopped, and whether they were actually configured was answerable
// only by opening the dashboard. This is the file that exists to catch "a config value that only shows up in
// production". Dating the answer is the other half - a rule deleted a year later must not stay covered by a
// claim made before it existed.
function datedAck(varName: string, missing: string, how: string, stale: string): void {
  const ack = (process.env[varName] ?? "").trim();
  if (!ack) {
    // Blocking for production, a warning for a named preview environment - a rehearsal stack behind an access
    // policy is not the surface these protect, and gating it would only teach people to set the variable blindly.
    const msg = `${missing} ${how}`;
    if (targetEnv) warns.push(msg);
    else errors.push(msg);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ack)) {
    errors.push(`${varName} must be the ISO date this was last verified (got "${ack}"). ${how}`);
    return;
  }
  // Stale is worse than absent, because it reads as answered. A year is generous for a control nobody
  // touches; it is short enough that something removed in a dashboard cleanup surfaces at the next deploy.
  const age = (Date.now() - Date.parse(`${ack}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(age)) errors.push(`${varName} is not a real date (got "${ack}").`);
  // A day of slack, because "today" is the deployer's local today and this compares against UTC midnight -
  // anyone east of Greenwich would otherwise have the date they just verified rejected as being the future.
  else if (age < -1) errors.push(`${varName} is dated in the future (${ack}).`);
  else if (age > 365) warns.push(`${varName} is ${Math.floor(age)} days old (${ack}) - ${stale}`);
}

{
  const target = targetEnv ?? "production";
  // All three unauthenticated lanes - /diag, /auth/* and the e-sign callback - now carry an isolate-local
  // ceiling of their own (lib/isolateRate.ts). That is a floor, NOT the control, and the message says so: a
  // Worker cannot see traffic an edge rule blocks, and a per-isolate counter is not a limit across a fleet of
  // them, so a caller spread over enough colos gets one allowance per isolate. The WAF rule is still required.
  datedAck(
    "WAF_RATE_LIMIT_CONFIRMED",
    `Cloudflare WAF rate-limiting rules are not confirmed for ${target}. /diag, /auth/* and the e-sign callback carry only an isolate-local floor, which is not a limit across a fleet of isolates. Configure the rules in docs/deploy-security.md §1, then say so:`,
    "Set WAF_RATE_LIMIT_CONFIRMED to the ISO date you last verified them, e.g. WAF_RATE_LIMIT_CONFIRMED=2026-09-10.",
    "re-check the rules in docs/deploy-security.md §1 and re-date it.",
  );

  // HSTS is deliberately NOT sent by the app. web/public/_headers cannot condition a header on the request
  // being HTTPS, so an STS header set there would also go out over plain HTTP - which RFC 6797 §7.2 forbids,
  // and which breaks `wrangler dev` concretely (Chrome pins localhost to HTTPS and the next service-worker
  // fetch is upgraded to a port nothing is listening on). The right place is the ZONE, where it applies only
  // to real HTTPS traffic and covers the /v1 API responses too rather than only the static assets.
  //
  // Which means the app ships with no transport pinning AT ALL unless someone turned it on in the dashboard,
  // and nothing in this repo could tell. That is the same gap the WAF check closes, and it is closed the same
  // way: the reasoning lives in _headers and docs/deploy-security.md, and the acknowledgement lives here.
  datedAck(
    "HSTS_CONFIRMED",
    `Zone-level HSTS is not confirmed for ${target}. The app deliberately sends no Strict-Transport-Security header of its own (see web/public/_headers), so until this is on at the zone there is no transport pinning anywhere. Enable it in Cloudflare (SSL/TLS -> Edge Certificates -> HSTS), then say so:`,
    "Set HSTS_CONFIRMED to the ISO date you last verified it, e.g. HSTS_CONFIRMED=2026-09-10.",
    "re-check it in Cloudflare (SSL/TLS -> Edge Certificates -> HSTS) and re-date it.",
  );
}

// --- 3. Optional SPA features that ship switched off --------------------------------------------------
// These are baked in at BUILD time by Vite, so an unset value cannot be fixed by a secret after the fact -
// it needs another build. Absent is a valid choice; shipping it unknowingly is not.
const viteVar = (name: string) => new RegExp(`^\\s*${name}\\s*=\\s*\\S`, "m").test(webEnv);
const viteValue = (name: string) => webEnv.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, "m"))?.[1];

// A VAPID public key that is present but malformed is worse than an absent one: the build succeeds, the
// toggle renders, and enrolment fails in the browser (or every send 401s) with nothing to show for it. The
// key is a raw P-256 point, so importing it proves both the encoding AND that the point is on the curve -
// which a length check alone would not. Catches the realistic failure: a truncated or half-pasted key.
const vapidPublic = viteValue("VITE_VAPID_PUBLIC_KEY");
if (vapidPublic) {
  const raw = Buffer.from(vapidPublic, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    errors.push(`web/.env: VITE_VAPID_PUBLIC_KEY decodes to ${raw.length} bytes starting 0x${(raw[0] ?? 0).toString(16)} - a VAPID public key is 65 bytes starting 0x04 (uncompressed P-256 point). Truncated or mis-pasted?`);
  } else {
    try {
      await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch {
      errors.push("web/.env: VITE_VAPID_PUBLIC_KEY is 65 bytes but is not a valid P-256 point - regenerate with scripts/genVapidKeys.ts.");
    }
    // The one thing that cannot be checked from here: whether this matches the Worker's VAPID_PUBLIC_KEY
    // secret (wrangler never reveals secret values). A mismatch is silent until src/lib/webPush.ts logs the
    // 401/403 - so after deploying, enable notifications on one device and watch `npx wrangler tail`.
  }
}
if (!viteVar("VITE_VAPID_PUBLIC_KEY")) {
  warns.push("web/.env has no VITE_VAPID_PUBLIC_KEY - browser push notifications will be inert in this build (pushSupported() returns false). Set it, together with the VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY secrets on the Worker, to enable push.");
}
if (!viteVar("VITE_SENTRY_DSN")) {
  warns.push("web/.env has no VITE_SENTRY_DSN - this build reports no errors to Sentry (instrument.ts skips Sentry.init). Set it to see what breaks for real users.");
} else {
  // Independent checks, not a chain: each names a different thing that will be missing in production, and
  // reporting only the first would send someone round the loop once per deploy.
  if (!process.env.SENTRY_AUTH_TOKEN) {
    // Said here rather than at build time because this is the gate `npm run deploy` runs, and a build without
    // the token produces no source maps at all (web/vite.config.ts ties the two together deliberately, so that
    // maps are never left sitting in web/dist to be uploaded as public assets). The failure is invisible until
    // the first production issue arrives as `index-a1b2c3.js:1:48213`.
    warns.push("SENTRY_AUTH_TOKEN is not set - this build uploads no source maps, so production stack traces will be minified and unreadable. Set it (with SENTRY_ORG/SENTRY_PROJECT) in the deploy environment.");
  }
  if (!viteVar("VITE_SENTRY_ORG")) {
    warns.push("web/.env has VITE_SENTRY_DSN but no VITE_SENTRY_ORG - a session recording attached to a support ticket will show as a bare id instead of a link support can click.");
  }
  // The release the SPA will actually claim. web/vite.config.ts falls back to the short commit SHA when
  // VITE_APP_VERSION is unset (resolveAppVersion), so an unset variable is no longer "unknown release" - it
  // is the commit. This mirrors that resolution so the check reports the string the build will really stamp,
  // and warns only in the one case where there is still nothing to stamp.
  const spaRelease = viteVar("VITE_APP_VERSION") || process.env.VITE_APP_VERSION || gitRelease();
  if (!spaRelease) {
    // With no release every issue lands as "unknown release", so regression detection and "resolved in next
    // release" have nothing to key on - and the source maps upload against a release no event ever claims,
    // which is the same as not uploading them. It cannot be backfilled.
    warns.push("no VITE_APP_VERSION and no git commit to fall back on - Sentry issues will be tagged 'unknown release' and the uploaded source maps will not match them. Set VITE_APP_VERSION in the deploy environment.");
  } else if (spaRelease.endsWith("-dirty")) {
    warns.push(`the SPA will report release '${spaRelease}': the working tree has uncommitted changes, so this build is not reproducible from any commit. Commit (or set VITE_APP_VERSION) before a release build.`);
  }
  // The Worker half of the same release. Both halves of a distributed trace have to claim ONE release or the
  // SPA's span and the Worker's span land on two, and only one of them has maps. This is checked against the
  // environment rather than wrangler.toml on purpose: a literal in that file is the same string for every
  // deploy, which is how every release ended up tagged "0.1.0".
  //
  // The Worker gets NO fallback of its own: it is a Worker secret, set at deploy time, and guessing it here
  // would tell the operator a release is configured when nothing set it. So the check is that it matches the
  // release the SPA resolved, which is the whole point of having both.
  if (!process.env.SENTRY_RELEASE) {
    warns.push(`SENTRY_RELEASE is not set - the Worker's own issues will be tagged 'unknown release' while the SPA's claim '${spaRelease ?? "unknown release"}', so the two halves of a trace land on different releases. Set SENTRY_RELEASE=${spaRelease ?? "$(git rev-parse --short HEAD)"} in the deploy environment.`);
  } else if (spaRelease && process.env.SENTRY_RELEASE !== spaRelease) {
    warns.push(`SENTRY_RELEASE (${process.env.SENTRY_RELEASE}) and the SPA's release (${spaRelease}) disagree - the Worker and the SPA will report into two different releases for one deploy. Set them to the same value.`);
  }
}
if (viteVar("VITE_ESIGN_ALLOW_SANDBOX")) {
  errors.push("web/.env sets VITE_ESIGN_ALLOW_SANDBOX - a production build must never trust the eSign SANDBOX certificate roots.");
}

// --- 4. eSign trust anchors ---------------------------------------------------------------------------
// An empty PROD_ROOT_PEMS is fail-closed and safe, but it means every genuinely signed document displays as
// amber "validity unknown" - worth knowing before users see it, not after.
const ccaRoots = read("web/src/lib/ccaRoots.ts");
// Strip comments first: the empty array carries a commented-out example PEM, which would otherwise read as
// a populated trust store.
const prodBlock = (ccaRoots.match(/const PROD_ROOT_PEMS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
if (!prodBlock.includes("BEGIN CERTIFICATE")) {
  warns.push("web/src/lib/ccaRoots.ts: PROD_ROOT_PEMS is empty - every production-signed eSign document will verify as amber \"validity unknown\" (tamper detection still works; signer identity cannot be attested). Run `node --import ./scripts/tsResolve.mjs scripts/esignChain.ts <signed.pdf>` on a real signed document to learn which CCA root to add.");
}

// --- 5. Income-tax slab vintage -----------------------------------------------------------------------
// The seeded/fallback slab table carries a stamp saying which Budget it encodes. Withholding itself is safe
// when that stamp is behind - the FY window comes from the payroll period's own dates, never from the stamp
// - but the RATES applied are then last year's, which is a wrong number on a real payslip that no test can
// catch, because only the Finance Act knows the right one. Warn rather than fail: an org deploying in
// (say) April, before that year's Budget is even passed, legitimately runs on the previous table.
{
  const now = new Date();
  const currentFyStart = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // Apr = month 3
  if (DEFAULT_TAX_FY_START_YEAR < currentFyStart) {
    const loaded = fyLabels(DEFAULT_TAX_FY_START_YEAR).financialYear;
    const current = fyLabels(currentFyStart).financialYear;
    // BLOCKING, not a warning. The runtime deliberately tolerates a stale vintage - the withholding WINDOW comes
    // from the payroll period's own dates, so the year being withheld against is always right and only the RATES
    // are last Budget's (see the TaxConfig header). That separation is what keeps a config edit from being a
    // code change, and it means nothing downstream can refuse: the build succeeds, the payslip looks ordinary,
    // and every employee's TDS is computed from the wrong table.
    //
    // So this gate is the only thing standing between a stale table and a year of wrong Form 16s, and it spent
    // its life as warning number five in a list of five - which is to say it was read past. A deploy that would
    // withhold statutory tax at superseded rates is not a deploy anyone means to make; requiring the Budget
    // figures to be entered first costs one edit a year, in April, when it is already known.
    errors.push(
      `src/domain/incomeTax.ts: the slab table is stamped FY ${loaded} but today falls in FY ${current}. Deploying now would withhold TDS from every employee using the FY ${loaded} rates, rebate and surcharge bands. Enter the Budget figures for FY ${current}: update the slabs, rebate87A and surcharge in DEFAULT_TAX_CONFIG together with DEFAULT_TAX_FY_START_YEAR, and re-seed the tax-config settings row (which overrides that fallback at runtime).`,
    );
  }
}

// --- 6. Migrations already applied to a live database must never be rewritten -------------------------
// `wrangler d1 migrations apply` records what it has run BY TAG, in the remote `d1_migrations` table. It
// compares nothing about the file's contents. So a migration whose tag the target database has already seen
// is SKIPPED, whatever is inside it now.
//
// That collides head-on with how this repo has been developed: nothing is deployed anywhere, so the schema is
// kept as exactly ONE migration and `npm run db:generate` re-squashes it in place, keeping the same
// `0000_*` tag. Perfectly correct pre-launch, and silently wrong for every schema change after the first
// production deploy - the file changes, the deploy is green, `d1_migrations` already lists the tag, and the
// remote schema simply never moves. The failure surfaces later as a query against a column that does not
// exist, with nothing pointing back at the deploy that did it.
//
// So the freeze is made explicit rather than remembered. `src/db/migrations/meta/_frozen.json` maps a tag to
// the sha256 of the file that was applied under it. While it is absent or empty, nothing is frozen and the
// squash workflow is untouched (a warning names the launch step). Once it lists a tag, changing that file
// fails the deploy here - the fix being to restore it and add a NEW numbered migration.
//
// Written by `node --import ./scripts/tsResolve.mjs scripts/freezeMigrations.ts`, which is step 7a of
// docs/deploy.md - run once, immediately after bootstrap.sql goes onto the production database.
{
  const dir = resolve(root, "src/db/migrations");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    errors.push("src/db/migrations does not exist - `npm run db:generate` has never been run.");
  }
  const frozen: Record<string, string> = (() => {
    const raw = read("src/db/migrations/meta/_frozen.json");
    if (!raw.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      errors.push("src/db/migrations/meta/_frozen.json is not valid JSON.");
      return {};
    }
  })();

  const tags = Object.keys(frozen);
  if (!tags.length) {
    warns.push(
      `no migration is frozen yet (src/db/migrations/meta/_frozen.json is absent or empty), so nothing stops the next \`npm run db:generate\` from rewriting ${files[0] ?? "the migration"} under a tag the database has already applied - which wrangler would then SKIP, leaving the remote schema behind with a green deploy. Harmless until the first production deploy; run \`node --import ./scripts/tsResolve.mjs scripts/freezeMigrations.ts\` as part of it (docs/deploy.md step 7a).`,
    );
  }
  for (const tag of tags) {
    const file = `${tag}.sql`;
    const body = read(`src/db/migrations/${file}`);
    if (!body) {
      errors.push(`src/db/migrations/${file} is frozen (it has been applied to a live database) but is missing. Restore it - a tag the database has already run cannot be withdrawn; supersede it with a new migration instead.`);
      continue;
    }
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== frozen[tag]) {
      errors.push(
        `src/db/migrations/${file} has changed since it was applied to a live database (sha256 ${actual.slice(0, 12)}, frozen as ${String(frozen[tag]).slice(0, 12)}). wrangler records migrations by TAG and skips one it has already run, so this edit would never reach the remote schema and the deploy would still pass. Restore the file and put the change in a NEW numbered migration.`,
      );
    }
  }
  // A migration that exists but is not frozen is either the next one to be applied (fine) or, if the frozen
  // set is non-empty and this file sorts BEFORE a frozen one, a file inserted into history - which renumbers
  // nothing but does change what a fresh database gets versus what production has.
  if (tags.length) {
    const highestFrozen = tags.sort().at(-1)!;
    for (const f of files) {
      const tag = f.replace(/\.sql$/, "");
      if (!frozen[tag] && tag < highestFrozen) {
        errors.push(`src/db/migrations/${f} sorts before the frozen migration ${highestFrozen}.sql, so a fresh database would get it and production never will. Give it a tag after ${highestFrozen}.`);
      }
    }
  }
}

// --- report -------------------------------------------------------------------------------------------
for (const w of warns) console.warn(`  WARN  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);
if (errors.length) {
  console.error(`\npreflight failed: ${errors.length} blocking issue(s).`);
  process.exit(1);
}
console.log(`preflight ok${warns.length ? ` (${warns.length} warning(s))` : ""} - plan=${plan}, env=${targetEnv ?? "production"}`);
