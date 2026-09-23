// Generate the VAPID keypair that browser push notifications are signed with.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genVapidKeys.ts
//
// VAPID (RFC 8292) is how a push service - FCM for Chrome, Mozilla autopush, Apple - knows who is sending,
// without you pre-registering with each vendor. It is an ECDSA P-256 keypair:
//   public   given to the browser at subscribe time as `applicationServerKey`, and baked into the SPA as
//            VITE_VAPID_PUBLIC_KEY. Genuinely public - it ships inside the JS bundle by design.
//            Encoding: base64url of the 65-byte uncompressed EC point (0x04 || X || Y).
//   private  signs an ES256 JWT on every send; the push service verifies it against the public key recorded
//            in the subscription. A SECRET - `wrangler secret put`, never a [vars] entry, never committed.
//            Encoding: base64url of the 32-byte `d` scalar.
// Both encodings are what src/lib/webPush.ts -> @block65/webcrypto-web-push expects.
//
// GENERATE ONCE. Every subscription a browser creates is bound to the public key it was created with, so
// rotating the pair silently invalidates every device already enrolled: pushes start failing and each user
// has to toggle notifications off and on again. Treat it as permanent deployment identity, not a rotatable
// credential.
//
// The private key is written to .vapid.json (gitignored) rather than printed, so it does not end up in
// terminal scrollback, a screen share, or an AI assistant's transcript. Only the public half is displayed.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "..", ".vapid.json");

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

// "raw" for an EC public key is exactly the 65-byte uncompressed point the spec asks for.
const pub = b64url(await crypto.subtle.exportKey("raw", publicKey));
// The private scalar is the JWK `d` member, already base64url.
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const priv = jwk.d!;

writeFileSync(OUT, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2) + "\n", { mode: 0o600 });

console.log(`
VAPID keypair generated.  Private key written to .vapid.json (mode 0600, gitignored).

  PUBLIC KEY (safe to commit - it ships in the JS bundle anyway):

    ${pub}

Next steps:

  1. Put the public key in web/.env so the SPA is built with it. Without this the push toggle does not
     even render (pushSupported() is false), and no later secret can switch it on - Vite bakes build-time
     values into the bundle.

       echo 'VITE_VAPID_PUBLIC_KEY=${pub}' >> web/.env

  2. Give the Worker both halves as secrets. Absent either one, src/deps.ts builds no PushSender and
     notifications quietly skip the push channel.

       npx wrangler secret put VAPID_PUBLIC_KEY     # paste the public key above
       npx wrangler secret put VAPID_PRIVATE_KEY    # paste "privateKey" from .vapid.json
       npx wrangler secret put VAPID_SUBJECT        # optional; defaults to mailto:EMAIL_FROM

  3. Rebuild and redeploy - step 1 only takes effect in a NEW build.

  4. Store .vapid.json in your password manager, then delete it. Losing the private key means every
     enrolled device must re-subscribe.
`);
