// Local email-provider smoke test. Reads .dev.vars, builds the real EmailSender, sends one message.
//   node --import ./scripts/tsResolve.mjs scripts/testEmail.ts you@example.com
// Overrides via env win over .dev.vars, e.g.:
//   EMAIL_PROVIDER=brevo EMAIL_API_KEY=xkeysib-... EMAIL_FROM="HR <hr@acme.com>" node --import ./scripts/tsResolve.mjs scripts/testEmail.ts you@example.com
import { readFileSync } from "node:fs";
import { makeEmailSender, EMAIL_PROVIDERS, type EmailProvider } from "../src/lib/email";

// Minimal .dev.vars parser (KEY="value" / KEY=value, ignores # comments).
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

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error("usage: node --import ./scripts/tsResolve.mjs scripts/testEmail.ts <recipient@example.com>");

  const dv = loadDevVars();
  const provider = (process.env.EMAIL_PROVIDER || dv.EMAIL_PROVIDER || "resend") as EmailProvider;
  const apiKey = process.env.EMAIL_API_KEY || dv.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM || dv.EMAIL_FROM;
  const region = process.env.EMAIL_REGION || dv.EMAIL_REGION;

  if (!EMAIL_PROVIDERS.includes(provider)) throw new Error(`EMAIL_PROVIDER must be one of ${EMAIL_PROVIDERS.join(", ")}`);
  if (!apiKey) throw new Error("EMAIL_API_KEY missing (.dev.vars or env)");
  if (!from) throw new Error("EMAIL_FROM missing (.dev.vars, wrangler.toml [vars], or env)");

  console.log(`provider=${provider} from=${from}${region ? ` region=${region}` : ""} -> ${to}`);
  const sender = makeEmailSender(provider, apiKey, from, region);
  await sender.send(to, "HRMS email test", `<p>HRMS email config works. provider=<b>${provider}</b>. ${new Date().toISOString()}</p>`);
  console.log("sent ok");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
