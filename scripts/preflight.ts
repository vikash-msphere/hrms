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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  if (!viteVar("VITE_APP_VERSION")) {
    // With no release every issue lands as "unknown release", so regression detection and "resolved in next
    // release" have nothing to key on - and the source maps upload against a release no event ever claims,
    // which is the same as not uploading them. It cannot be backfilled.
    warns.push("web/.env has VITE_SENTRY_DSN but no VITE_APP_VERSION - Sentry issues will be tagged 'unknown release' and the uploaded source maps will not match them. Set it in CI, e.g. VITE_APP_VERSION=$(git rev-parse --short HEAD).");
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
    warns.push(
      `src/domain/incomeTax.ts: the slab table is stamped FY ${loaded} but today falls in FY ${current}. TDS deducted now uses the FY ${loaded} rates, rebate and surcharge bands. Confirm the Budget figures for FY ${current}, then update the slabs together with DEFAULT_TAX_FY_START_YEAR (and re-seed the tax-config settings row, which overrides this fallback at runtime).`,
    );
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
