// The one branded shell every outbound email is wrapped in, so a plain message body becomes an enterprise-grade,
// responsive HTML email. `renderEmail` is PURE (content + brand -> full HTML document); `loadEmailBrand` reads the
// org's identity from settings. Callers pass just the inner body (a few <p>s) and a heading - the shell supplies
// the header wordmark/logo, typography, an optional call-to-action button, the footer, and light/dark styling.
//
// Email HTML rules of the road baked in here: table-based layout, inline styles on structural cells (clients
// don't reliably honour <head> CSS - Gmail strips it), a system font stack, a 600px card, and a
// prefers-color-scheme block for the clients that do support it. No external assets except an optional https logo.
import type { Deps } from "../deps";
import { BRAND, BRAND_RADIUS } from "../domain/brand";
import { getSettingValue } from "../services/settings";

export type EmailBrand = {
  orgName: string;
  logoUrl?: string; // only used when it's an absolute http(s) URL (remote images); otherwise the wordmark shows
  address?: string;
  accent?: string; // hex accent for the header bar + button; falls back to a neutral enterprise indigo
};

export type EmailContent = {
  heading?: string; // the H1 - typically the email subject
  bodyHtml: string; // the message body (author-provided, already templated): one or more <p>…</p>
  cta?: { label: string; url: string }; // optional button; only rendered for an absolute http(s) URL
  preheader?: string; // hidden inbox-preview snippet
};

// Brand: a navy -> cyan gradient. The accent (links / buttons) is the deep navy end for legible contrast; the
// header uses the full gradient (clients that don't support it fall back to the solid accent). Both come from
// src/domain/brand.ts, the single palette file - an org can still override the accent in its settings.
const DEFAULT_ACCENT = BRAND.primary;
const BRAND_GRADIENT = BRAND.gradient;
const isHttpUrl = (s: string | undefined): s is string => !!s && /^https?:\/\//i.test(s);
/** Text -> HTML text. Exported because `bodyHtml` is raw by contract, so every caller that folds a VALUE into
 *  it (a name, a title, an author's prose) needs the same escaping the shell itself uses. */
// The APOSTROPHE is escaped too, and it is the one people leave out. Every attribute this module writes today
// is double-quoted, so `&quot;` is what actually closes the hole - but "safe as long as nobody writes
// `style='…'`" is a property of the current callers, not of the escaper, and the caller that breaks it is a
// one-character edit in a template nobody re-reads. An escaper whose guarantee depends on quoting style is
// not one, so both quote characters go.
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const esc = escapeHtml;

/**
 * Author-written PROSE as an email body: escaped, and split into paragraphs on blank lines with single
 * newlines kept as breaks.
 *
 * For the callers whose body is text rather than markup. `bodyHtml` is raw by contract, so handing it plain
 * text does two wrong things at once - HTML collapses the newlines, so the whole message arrives as one
 * run-on block, and anything angle-bracketed in what the author typed is markup by the time it is read.
 */
export function textParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Load the org's email brand from the organization settings row (name / address / logo / optional accent).
export async function loadEmailBrand(deps: Deps): Promise<EmailBrand> {
  const org = await getSettingValue<{ name?: string; address?: string; email_logo_url?: string; primary_color?: string }>(deps, "organization", {});
  // The uploaded `logo` is a data URL (email clients strip those), so email uses the org's public https
  // `email_logo_url` instead; when unset, the header falls back to the org name wordmark.
  return {
    orgName: org.name?.trim() || "Your Company",
    logoUrl: isHttpUrl(org.email_logo_url) ? org.email_logo_url : undefined,
    address: org.address?.trim() || undefined,
    accent: /^#[0-9a-f]{6}$/i.test(org.primary_color ?? "") ? org.primary_color : DEFAULT_ACCENT,
  };
}

// Render a full, self-contained HTML email around the given content.
export function renderEmail(content: EmailContent, brand: EmailBrand): string {
  const accent = brand.accent || DEFAULT_ACCENT;
  const orgName = esc(brand.orgName);
  const year = new Date().getUTCFullYear();

  const header = isHttpUrl(brand.logoUrl)
    ? `<img src="${esc(brand.logoUrl)}" alt="${orgName}" height="32" style="height:32px;max-height:32px;display:block;border:0;outline:none;text-decoration:none;">`
    : `<span style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#ffffff;">${orgName}</span>`;

  const headingHtml = content.heading
    ? `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${BRAND.ink};">${esc(content.heading)}</h1>`
    : "";

  const ctaHtml = isHttpUrl(content.cta?.url)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
         <tr><td style="border-radius:${BRAND_RADIUS.control}px;background:${accent};">
           <a href="${esc(content.cta!.url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:${BRAND_RADIUS.control}px;">${esc(content.cta!.label)}</a>
         </td></tr>
       </table>`
    : "";

  const preheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${esc(content.preheader)}</div>`
    : "";

  const footerAddress = brand.address ? `<div style="margin-top:4px;">${esc(brand.address)}</div>` : "";

  return `<!doctype html>
<html lang="en" style="margin:0;padding:0;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${orgName}</title>
<style>
  body { margin:0; padding:0; background:${BRAND.pageBg}; -webkit-font-smoothing:antialiased; }
  a { color:${accent}; }
  .email-body p { margin:0 0 14px; }
  .email-body p:last-child { margin-bottom:0; }
  .email-body ul, .email-body ol { margin:0 0 14px; padding-left:20px; }
  .email-body strong { color:${BRAND.ink}; }
  @media (max-width:620px){ .email-card { width:100% !important; border-radius:0 !important; } .email-pad { padding:24px !important; } }
  @media (prefers-color-scheme: dark){
    body, .email-bg { background:${BRAND.dark.pageBg} !important; }
    .email-card { background:${BRAND.dark.cardBg} !important; border-color:${BRAND.dark.cardBorder} !important; }
    .email-body, .email-body p { color:${BRAND.dark.body} !important; }
    .email-body h1 { color:${BRAND.dark.ink} !important; }
    .email-body strong { color:${BRAND.dark.ink} !important; }
    .email-footer, .email-footer a { color:${BRAND.dark.muted} !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};">
${preheader}
<table role="presentation" class="email-bg" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBg};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${BRAND.cardBg};border:1px solid ${BRAND.cardBorder};border-radius:${BRAND_RADIUS.card}px;overflow:hidden;">
      <tr><td style="background:${accent};background:${BRAND_GRADIENT};padding:22px 32px;">${header}</td></tr>
      <tr><td class="email-pad email-body" style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${BRAND.body};">
        ${headingHtml}${content.bodyHtml}${ctaHtml}
      </td></tr>
      <tr><td class="email-footer" style="padding:20px 32px 28px;border-top:1px solid ${BRAND.cardBorder};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${BRAND.label};">
        <div>This is an automated message from ${orgName}. Please do not reply to this email.</div>
        <div style="margin-top:6px;">&copy; ${year} ${orgName}.${footerAddress ? "" : ""}</div>
        ${footerAddress}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
