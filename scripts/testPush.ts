// Local web-push smoke test. Reads the VAPID keys from .dev.vars, pulls the device subscriptions the SPA
// registered into the LOCAL D1, and sends one real notification through the real sender.
//   node --import ./scripts/tsResolve.mjs scripts/testPush.ts [work@email]
//
// This is the deterministic way to prove the push path end to end: it exercises the same ES256 VAPID JWT,
// the same aes128gcm payload encryption and the same push service that production uses, without having to
// find a business action that happens to notify you. Anything it delivers, the app will deliver.
//
// What a failure means:
//   "no subscriptions"  nobody has enabled browser notifications in the local app yet - do that first
//                       (Settings -> Notifications), it is what writes the subscription into D1.
//   401 / 403           the VAPID keypair the browser subscribed against is not the pair signing this send.
//                       Re-check VITE_VAPID_PUBLIC_KEY in web/.env against VAPID_PUBLIC_KEY in .dev.vars,
//                       then unsubscribe and re-enable in the app (a subscription is bound to its key).
//   404 / 410           the subscription is dead; the app prunes these automatically on the next notify.
//
// Overrides via env win over .dev.vars, e.g. VAPID_PRIVATE_KEY=... node --import ... scripts/testPush.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { makePushSender } from "../src/lib/webPush";

// Minimal .dev.vars parser (KEY="value" / KEY=value, ignores # comments). Same shape as scripts/testEmail.ts.
function loadDevVars(path = ".dev.vars"): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// Read from the LOCAL miniflare D1 (the one `wrangler dev` uses), not the remote database.
function queryLocalD1<T>(sql: string): T[] {
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "hrms", "--local", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"], // wrangler writes progress chatter to stderr; only stdout is JSON
  });
  const parsed = JSON.parse(raw) as { results: T[] }[];
  return parsed.flatMap((r) => r.results ?? []);
}

type StoredSub = { endpoint: string; keys: { p256dh: string; auth: string } };

async function main() {
  const emailFilter = process.argv[2];

  const dv = loadDevVars();
  const publicKey = process.env.VAPID_PUBLIC_KEY || dv.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY || dv.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || dv.VAPID_SUBJECT || `mailto:${dv.EMAIL_FROM || "hr@example.com"}`;
  if (!publicKey || !privateKey) throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing (.dev.vars or env)");

  // Fail early and loudly on a malformed public key rather than letting the push service 401 about it.
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error(`VAPID_PUBLIC_KEY is ${raw.length} bytes starting 0x${(raw[0] ?? 0).toString(16)}; expected 65 starting 0x04`);

  const rows = queryLocalD1<{ email: string; value: string }>(
    `select u.email as email, p.value as value
       from preferences p join users u on u.uuid = p.user_id
      where p.key = 'push_subscriptions'` + (emailFilter ? ` and u.email = '${emailFilter.replace(/'/g, "''")}'` : ``)
  );
  if (!rows.length) {
    console.log(emailFilter ? `no subscriptions for ${emailFilter}.` : "no subscriptions in the local database.");
    console.log("Enable browser notifications in the running app first (Settings -> Notifications).");
    return;
  }

  const sender = makePushSender(publicKey, privateKey, subject);
  let ok = 0, failed = 0;
  for (const row of rows) {
    let subs: StoredSub[] = [];
    try { subs = (JSON.parse(row.value) as { subs?: StoredSub[] }).subs ?? []; } catch { /* malformed row */ }
    for (const sub of subs) {
      const result = await sender.send(sub, {
        title: "HRMS push test",
        body: `Web push is configured correctly. ${new Date().toISOString()}`,
        link: "#/notifications",
      });
      console.log(`  ${result === "ok" ? "ok  " : result === "gone" ? "gone"  : "FAIL"}  ${row.email}  ${new URL(sub.endpoint).origin}`);
      result === "ok" ? ok++ : failed++;
    }
  }
  console.log(`\n${ok} delivered, ${failed} failed. A delivered push should appear as a desktop notification.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
