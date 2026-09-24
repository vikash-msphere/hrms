// Mint the edge (WAF) media key and build the Cloudflare custom rule that checks it.
//
//   Run:  npm run edge:rule -- --host <app hostname> [--host <another>] [--target staging] [--rotate | --drop-previous]
//
// WHAT THIS IS FOR. The app's media - fonts, images, icons, pdf.js data (EDGE_PATHS in src/http/assetPaths.ts)
// - is served by the asset layer without invoking the Worker, so it costs nothing against the daily request
// quota. Nothing checks a session there. A WAF custom rule does the guarding instead: it blocks those paths
// unless the request carries the `hrms_edge` cookie, whose value is this key. The Worker hands the cookie to
// every signed-in browser (src/http/staticSite.ts). It is a shared value, not a signature - the free plan's rule
// language cannot verify one - which is the deliberate trade for files that carry nothing of the app.
//
// THE KEY IS A SECRET, so it is written to a gitignored file rather than printed, the same way
// scripts/genVapidKeys.ts treats its private key: printed, it lands in terminal scrollback, a screen share or an
// AI assistant's transcript. The rule text contains the key too, so it goes to a file as well.
//
//   .edge-key.<target>.json   { current, previous? } - mode 600
//   .edge-rule.<target>.txt   the rule expression, to paste into the dashboard - mode 600
//
// FIRST RUN mints a key. The WORKER gets it first (`wrangler secret put EDGE_KEY`), and the rule is switched
// on only after that, once browsers have loaded a page and been handed the cookie - the other way round, every
// open tab's images and fonts would be blocked until it reloads. After that the same key is reused, so re-running
// (a new hostname, a changed EDGE_PATHS) rebuilds the rule without logging anyone's media out.
//
// ROTATION, e.g. after someone leaves who should lose it - here the order is the reverse:
//   1. `--rotate`: the current key becomes `previous`, a new one is minted, and the rule accepts BOTH.
//   2. Update the dashboard rule FIRST, then `wrangler secret put EDGE_KEY` with the new key, so no moment
//      exists where the Worker hands out a key the rule does not yet accept.
//   3. Browsers pick up the new key at the next page load (the gate re-issues a stale cookie).
//   4. A few days later, `--drop-previous`, and update the rule once more.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { edgeRuleExpression, isEdgeKey } from "../src/http/assetPaths";

const { values } = parseArgs({
  options: {
    host: { type: "string", multiple: true },
    target: { type: "string", default: "production" },
    rotate: { type: "boolean", default: false },
    "drop-previous": { type: "boolean", default: false },
  },
});

const target = values.target!;
if (target !== "production" && target !== "staging") {
  console.error(`--target must be "production" or "staging", not ${JSON.stringify(target)}`);
  process.exit(1);
}
const hosts = (values.host ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
if (!hosts.length) {
  console.error("at least one --host is required: the hostname(s) the app is served on, e.g. --host hrms.example.com");
  process.exit(1);
}
if (values.rotate && values["drop-previous"]) {
  console.error("--rotate and --drop-previous are two separate steps, days apart - run one at a time");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const keyFile = resolve(root, `.edge-key.${target}.json`);
const ruleFile = resolve(root, `.edge-rule.${target}.txt`);

// 32 random bytes, base64url: 43 characters, well inside the 32-128 the Worker and the rule builder accept.
const mint = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

type Keys = { current: string; previous?: string };
let keys: Keys;
const firstRun = !existsSync(keyFile);
if (!firstRun) {
  keys = JSON.parse(readFileSync(keyFile, "utf8")) as Keys;
  if (!isEdgeKey(keys.current) || (keys.previous !== undefined && !isEdgeKey(keys.previous))) {
    console.error(`${keyFile} holds a malformed key - fix or delete it (deleting mints a fresh one)`);
    process.exit(1);
  }
} else {
  keys = { current: mint() };
}
if (values.rotate) keys = { current: mint(), previous: keys.current };
if (values["drop-previous"]) keys = { current: keys.current };

// Build first: a rule that cannot be built must not leave a rotated key file behind that nothing accepts.
let expression: string;
try {
  expression = edgeRuleExpression(hosts, keys.previous ? [keys.current, keys.previous] : [keys.current]);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
writeFileSync(keyFile, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
writeFileSync(ruleFile, expression + "\n", { mode: 0o600 });

const configFlag = target === "staging" ? " --config wrangler.staging.toml" : "";
// Read from the file and piped, never typed or echoed.
const secretPut = `node -p "require('./.edge-key.${target}.json').current" | npx wrangler secret put EDGE_KEY${configFlag}`;
// Named per target: staging and production can share a zone, and each has its own key and hostnames.
const rule =
  `Cloudflare dashboard -> the zone -> Security -> WAF -> Custom rules. Create (or edit) the rule\n` +
  `   "hrms media: edge cookie (${target})", choose "Edit expression", paste the contents of the rule file, action Block.`;
// Worker first on a first run (so browsers hold the cookie before anything checks it); rule first on a
// rotation (so the rule accepts the new key before any browser is handed it). A plain rebuild changes no key,
// so only the rule needs replacing.
const steps = firstRun
  ? [`Hand the Worker the key:\n     ${secretPut}`, `Wait a day, so signed-in browsers have loaded a page and been given the cookie.`, rule]
  : values.rotate
    ? [rule, `Then hand the Worker the NEW key:\n     ${secretPut}`, `A few days later: npm run edge:rule -- ${hosts.map((h) => `--host ${h}`).join(" ")}${target === "staging" ? " --target staging" : ""} --drop-previous`]
    : [`${rule.replace("Create (or edit)", "Edit")}\n   The key is unchanged, so the Worker needs nothing.`];
console.log(`
Edge media rule for ${target} (${hosts.join(", ")}): ${expression.length} of 4096 characters.
${keys.previous ? "Accepts the current AND the previous key (rotation in progress).\n" : ""}
  key   ${keyFile}
  rule  ${ruleFile}

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Check, signed out: a font or icon URL answers 403. Signed in: the app's images and fonts load.
The rule only reaches hostnames in a Cloudflare zone - on *.workers.dev nothing enforces it.
`);
