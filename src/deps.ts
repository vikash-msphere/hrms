import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Bindings } from "./env";
import { makeEncryptor } from "./lib/crypto";
import { parseIpAllowList } from "./lib/ipAllow";
import { makeIdCodec, type IdCodec } from "./lib/idCodec";
import { makeApiKeySigner, type ApiKeySigner } from "./lib/apiKeyToken";
import { makeEmailSender, EMAIL_PROVIDERS, type EmailProvider } from "./lib/email";
import { makeDocumentStore } from "./lib/docstore";
import type { Clock, Encryptor, EmailSender, DocumentStore, WebhookSender, PushSender } from "./ports";
import { makePushSender } from "./lib/webPush";
import type { EsignSecrets } from "./domain/esign";
import { makeDispatch, type Dispatch } from "./services/internalDispatch";

export type DB = ReturnType<typeof drizzle<typeof schema>>;
// `webhook` is optional: automation egress is OFF unless an operator wires a sender (allowlisted destinations).
// `dispatch` runs an automation `apiCall` action through the app's own middleware as the system principal.
// `automationBudget` bounds the TOTAL automation dispatches per originating action - a request, or one cron
// subtask (which re-arms it via automationEngine.withDispatchBudget; without that the nightly tick's single
// Deps made 50 the budget for the whole night). `dropped` counts what the ceiling refused, so a caller can
// report it instead of leaving it in the logs. It is a mutable counter
// shared across the request's Deps; because an automation `apiCall` re-dispatches through the app reusing this
// same Deps (env.__sharedCtx.deps), a rule whose action re-triggers its own event cannot loop unbounded.
// `refCache` memoizes the small reference tables for ONE request (lib/refData.ts); it is set by the request
// middleware, so Deps built outside a request read those tables fresh every time.
// `trace` is the correlation id of the workflow execution currently running on this Deps. emitEvent mints it at
// the ROOT emission and every event/run/instance in the synchronous fan-out (incl. apiCall re-dispatch, which
// reuses this Deps) records it - so the UI can group one workflow's events/runs/waits together and show cause.
export type Deps = { db: DB; refCache?: Map<string, Promise<unknown>>; clock: Clock; encryptor: Encryptor; idCodec: IdCodec; apiKeySigner: ApiKeySigner; email: EmailSender; docs: DocumentStore; webhook?: WebhookSender; push?: PushSender; dispatch?: Dispatch; esignSecrets?: Record<string, EsignSecrets>; automationBudget?: { n: number; dropped: number }; trace?: string; actingAs?: ActingAs };

/**
 * WHAT is acting, when the actor is not a person at the keyboard.
 *
 * Automation actions and internal dispatch run as `systemActor()`, which is honest about authority and useless
 * as attribution: an audit entry reading "System" tells the person whose leave was auto-approved nothing about
 * why. Parked on Deps for the duration of the rule (or the cron tick) exactly as `trace` is, so it survives the
 * apiCall re-dispatch that reuses this Deps and reaches every audit entry the action writes.
 */
export type ActingAs = { kind: "automation" | "cron"; name: string; ref?: string };

// Route the request's reads to the nearest D1 read replica when the runtime supports Sessions
// (production); fall back to the plain binding where it doesn't (miniflare, the local/test runtime,
// lacks `withSession`). `first-unconstrained` lets the first query hit any replica, while the session's
// sequential consistency keeps read-your-writes intact for the rest of the request. Behavior-neutral
// otherwise: a D1DatabaseSession exposes the same prepare/batch the drizzle D1 driver uses (it just
// lacks exec/dump, hence the cast).
export function sessionBinding(d1: D1Database): D1Database {
  return typeof d1.withSession === "function"
    ? (d1.withSession("first-unconstrained") as unknown as D1Database)
    : d1;
}

// Fail fast on misconfiguration. A missing/short crypto key otherwise surfaces as a generic per-request 500
// deep inside Web Crypto with no hint; these checks turn that into one clear error at Deps construction.
function assertConfigured(env: Bindings): void {
  const b64len = (s: string | undefined): number => {
    if (!s) return -1;
    try { return Buffer.from(s, "base64").length; } catch { return -1; }
  };
  // AES-256-GCM master key MUST decode to exactly 32 bytes.
  if (b64len(env.FIELD_ENCRYPTION_KEY) !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  // Wire-id master feeds HKDF; require >=32 bytes of base64 entropy.
  if (b64len(env.WIRE_ID_KEY) < 32) throw new Error("WIRE_ID_KEY must be a base64-encoded key of at least 32 bytes");
  // Other required strings: absence here also produces opaque downstream failures.
  for (const k of ["EMAIL_API_KEY", "EMAIL_FROM"] as const) {
    if (!env[k]) throw new Error(`${k} is not configured`);
  }
  // One auth mode must be fully configured (see routes/authRoutes.ts for the mode split). The dev bypass
  // (local/tests only - both flags, never set in production) needs neither.
  if (env.GOOGLE_CLIENT_ID) {
    if (!env.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET is required with GOOGLE_CLIENT_ID");
    if (b64len(env.AUTH_SESSION_KEY) < 32) throw new Error("AUTH_SESSION_KEY must be a base64-encoded key of at least 32 bytes (required in Google sign-in mode)");
    // In Google mode there is no Access policy in front of the Worker, so the domain allow-list IS the org
    // perimeter: unset, ANY Google account on the internet completes /auth/callback and is auto-provisioned
    // as an `employee` (auth.ts). Both gates are `if (allowed.length)`, so an empty list is not a narrow
    // perimeter - it is no perimeter. Require it here rather than fail open at sign-in.
    if (!(env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").some((d) => d.trim())) {
      throw new Error("ALLOWED_EMAIL_DOMAINS must list at least one domain in Google sign-in mode (it is the org perimeter for who may sign in)");
    }
  } else if (!(env.DEV_FAKE_EMAIL && env.ALLOW_DEV_AUTH === "true")) {
    for (const k of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"] as const) {
      if (!env[k]) throw new Error(`${k} is not configured (or set GOOGLE_CLIENT_ID for Google sign-in)`);
    }
  }
  if (env.EMAIL_PROVIDER && !EMAIL_PROVIDERS.includes(env.EMAIL_PROVIDER as EmailProvider)) {
    throw new Error(`EMAIL_PROVIDER must be one of ${EMAIL_PROVIDERS.join(", ")}`);
  }
  // Parse the clock fence here purely to validate it. A typo in one entry would otherwise narrow the fence
  // silently (the bad entry matching nothing) and lock the whole office out of punching, discovered only by
  // the first employee to try - so it is a startup error instead.
  try {
    parseIpAllowList(env.ATTENDANCE_ALLOWED_IPS);
  } catch (e) {
    throw new Error(`ATTENDANCE_ALLOWED_IPS is malformed: ${(e as Error).message}`);
  }
}

export function makeDeps(env: Bindings): Deps {
  assertConfigured(env);
  const encryptor = makeEncryptor(env.FIELD_ENCRYPTION_KEY);
  const deps: Deps = {
    db: drizzle(sessionBinding(env.DB), { schema }),
    clock: { now: () => new Date() },
    encryptor,
    idCodec: makeIdCodec(env.WIRE_ID_KEY),
    // API-key verifier. Derives its own HMAC subkey from the field master via HKDF, so no new deploy secret.
    apiKeySigner: makeApiKeySigner(env.FIELD_ENCRYPTION_KEY),
    email: makeEmailSender((env.EMAIL_PROVIDER as EmailProvider) || "resend", env.EMAIL_API_KEY, env.EMAIL_FROM, env.EMAIL_REGION),
    docs: makeDocumentStore(env.DOCS, encryptor), // R2 objects are encrypted app-side
    // E-sign vendor secrets, keyed by provider id (never sourced from the settings blob). For Cashfree,
    // apiKey = x-client-id, apiSecret = x-client-secret (also the webhook HMAC key).
    esignSecrets: {
      cashfree: { apiKey: env.ESIGN_CASHFREE_CLIENT_ID, apiSecret: env.ESIGN_CASHFREE_CLIENT_SECRET, publicKey: env.ESIGN_CASHFREE_PUBLIC_KEY },
    },
    // Browser push is opt-in per deployment: absent VAPID keys = no sender = notify() skips push entirely.
    ...(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? { push: makePushSender(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT || `mailto:${env.EMAIL_FROM}`) }
      : {}),
  };
  // Internal API dispatch for automation `apiCall` actions (re-dispatches through app.fetch as system).
  deps.dispatch = makeDispatch(env, deps);
  return deps;
}
