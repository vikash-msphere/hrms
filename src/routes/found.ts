import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { getSettingValue } from "../services/settings";

// PUBLIC lost-and-found lookup for printed asset tags: the sticker's QR can encode
// `<origin>/found/<wire-id>` so a stranger who finds the hardware sees who to return it to -
// no login. Deliberately minimal and OPT-IN:
//   - 404 unless the org enabled it (settings/asset-tags `found_page.enabled`).
//   - The token is the authenticated wire id (AES+HMAC, see idCodec) - unguessable and unforgeable,
//     so the page cannot be enumerated.
//   - Shows ONLY: org name, the tag, the return contact, and (opt-in) the asset's display name.
//     Never the assignee, serial, notes or anything else.
// NOTE for Cloudflare Access deployments: CF sits in front of the whole worker, so `/found/*`
// needs a bypass rule in the CF Access app config before the QR works for outsiders.
type FoundPage = { enabled?: boolean; contact?: string; show_name?: boolean };

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f4f6f9;color:#1a2233;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #e3e8ef;border-radius:12px;box-shadow:0 2px 10px rgba(16,24,40,.06);padding:32px;max-width:420px;width:100%;text-align:center}
  .org{font-size:13px;color:#5b6472;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
  .tag{font-family:ui-monospace,monospace;font-size:22px;font-weight:700;margin:4px 0 2px}
  .name{font-size:14px;color:#39424e;margin-bottom:16px}
  .msg{font-size:14px;color:#39424e;line-height:1.5}
  .contact{display:inline-block;margin-top:14px;font-size:15px;font-weight:600;color:#1d4c91;word-break:break-all}
  </style></head><body><div class="card">${body}</div></body></html>`;
}

export const found = new Hono<AppEnv>()
  // Own security headers (not the /v1 set): this route serves HTML with an inline <style>, so the
  // API's `default-src 'none'` CSP would strip it - allow inline styles and nothing else.
  .use("*", async (c, next) => {
    try {
      await next();
    } finally {
      const h = c.res?.headers;
      if (h) {
        h.set("Referrer-Policy", "no-referrer");
        h.set("X-Content-Type-Options", "nosniff");
        h.set("X-Frame-Options", "DENY");
        h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      }
    }
  })
  .get("/:token", async (c) => {
  const deps = c.get("deps");
  // Decode BEFORE reading anything. This route is unauthenticated and unrated by nature (a stranger returning
  // hardware has no session), and token validation is pure compute with zero DB reads - so checking it first
  // means a forged or scanned-at-random token costs nothing, instead of a settings read per attempt.
  const uuid = await deps.idCodec.decode("assets", c.req.param("token"));
  if (!uuid) return c.notFound();
  const cfg = await getSettingValue<{ found_page?: FoundPage }>(deps, "asset-tags", {});
  const fp = cfg.found_page;
  if (!fp?.enabled) return c.notFound();
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, uuid)).limit(1))[0];
  // A RETIRED asset is no longer ours, and this page is the one surface that answers without a session.
  // Retiring is what the app records when hardware is sold, scrapped or handed on - and the sticker goes with
  // it. Left unfiltered, that sticker kept resolving to a live page publishing the org's name and a return
  // address for a machine somebody else now owns, indefinitely and to anyone who scanned it. `retired` is the
  // terminal state in the status enum (assets are hard-deleted, so there is no delete_time to check).
  if (!row || row.status === "retired") return c.notFound();
  const org = await getSettingValue<{ name?: string }>(deps, "organization", {});
  const contact = fp.contact?.trim();
  const body =
    `<div class="org">${esc(org.name ?? "")}</div>` +
    `<div class="tag">${esc(row.assetTag ?? "")}</div>` +
    (fp.show_name ? `<div class="name">${esc(row.name)}</div>` : "") +
    `<div class="msg">This item is company property. If you've found it, please help it get home.</div>` +
    (contact ? (contact.includes("@") ? `<a class="contact" href="mailto:${esc(contact)}">${esc(contact)}</a>` : `<span class="contact">${esc(contact)}</span>`) : "");
  return c.html(page(`Found: ${row.assetTag ?? "asset"}`, body));
});
