// The one branded shell every outbound email is wrapped in, so a plain message body becomes an enterprise-grade,
// responsive HTML email. `renderEmail` is PURE (content + brand -> full HTML document); `loadEmailBrand` reads the
// org's identity from settings. Callers pass just the inner body (a few <p>s) and a heading - the shell supplies
// the header wordmark/logo, typography, an optional call-to-action button, the footer, and light/dark styling.
//
// Email HTML rules of the road baked in here: table-based layout, inline styles on structural cells (clients
// don't reliably honour <head> CSS - Gmail strips it), a system font stack, a 600px card, and a
// prefers-color-scheme block for the clients that do support it. No external assets except an optional https logo.
import type { Deps } from "../deps";
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

// Metasphere brand: a navy -> teal gradient (from Metasphere.svg). The accent (links / buttons) is the deep
// navy end for legible contrast; the header uses the full gradient (clients that don't support it fall back to
// the solid accent).
const DEFAULT_ACCENT = "#1A2980";
const BRAND_GRADIENT = "linear-gradient(135deg,#1A2980 0%,#1F699E 50%,#26D0CE 100%)";
const isHttpUrl = (s: string | undefined): s is string => !!s && /^https?:\/\//i.test(s);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    ? `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:#0f172a;">${esc(content.heading)}</h1>`
    : "";

  const ctaHtml = isHttpUrl(content.cta?.url)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
         <tr><td style="border-radius:8px;background:${accent};">
           <a href="${esc(content.cta!.url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(content.cta!.label)}</a>
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
  body { margin:0; padding:0; background:#f1f5f9; -webkit-font-smoothing:antialiased; }
  a { color:${accent}; }
  .email-body p { margin:0 0 14px; }
  .email-body p:last-child { margin-bottom:0; }
  .email-body ul, .email-body ol { margin:0 0 14px; padding-left:20px; }
  .email-body strong { color:#0f172a; }
  @media (max-width:620px){ .email-card { width:100% !important; border-radius:0 !important; } .email-pad { padding:24px !important; } }
  @media (prefers-color-scheme: dark){
    body, .email-bg { background:#0b1120 !important; }
    .email-card { background:#111827 !important; border-color:#1f2937 !important; }
    .email-body, .email-body p { color:#cbd5e1 !important; }
    .email-body h1 { color:#f8fafc !important; }
    .email-body strong { color:#f8fafc !important; }
    .email-footer, .email-footer a { color:#64748b !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
${preheader}
<table role="presentation" class="email-bg" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
      <tr><td style="background:${accent};background:${BRAND_GRADIENT};padding:22px 32px;">${header}</td></tr>
      <tr><td class="email-pad email-body" style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#334155;">
        ${headingHtml}${content.bodyHtml}${ctaHtml}
      </td></tr>
      <tr><td class="email-footer" style="padding:20px 32px 28px;border-top:1px solid #e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;">
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
