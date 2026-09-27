import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get } from "@/api";
import { APP_NAME } from "./brand";
import { formatMoney } from "./utils";
import { getSetting } from "@/lib/settingsStore";
import { decimalsFor } from "../../../src/domain/currency";

// Organization branding (name + logo), stored as a single `settings/organization` JSON row (logo is a small
// data URL, so no binary/R2 plumbing). Loaded once at the app root and shared so the sidebar brand, the tax
// page, payslips etc. all read the same org identity. Read is open; writing needs settings.write.
// Values HR letters need that aren't on the employee/compensation record (signatory, HR contact, working
// pattern, offer validity). Edited in Settings → Organization; read server-side when rendering letters.
export type LetterDefaults = {
  signatory_name?: string;
  signatory_title?: string;
  signatory_signature?: string; // authorized-signatory signature image (data URL) - the employer's e-signature
  company_stamp?: string; // company seal/stamp image (data URL) - overlaid beside the signatory on generated letters

  hr_name?: string;
  hr_email?: string;
  hr_phone?: string;
  working_hours?: string;
  working_days?: string;
  work_mode?: string;
  work_location?: string;
  offer_validity_days?: number;
};
// `quick_actions.groups` = the org's custom "+" (quick-create) menu: ordered named sections, each with an
// ordered list of enabled action ids. Undefined = not configured -> built-in default sections. An id absent
// from every section is disabled org-wide. `order` is the legacy flat shape, still read for migration. Per-user
// capability gating still applies on top, so an enabled action a person can't perform won't show. See
// lib/quickActions.ts (normalizeQuickMenu / resolveQuickMenu).
// `logo_dark` is the optional dark-theme variant of `logo`. Both are data URLs rendered in an <img>, and an
// <img>-embedded SVG cannot see the app's `.dark` class (nor can `prefers-color-scheme` inside it, which
// follows the OS, not the in-app theme) - so the swap happens in React, at the call site. Unset = use `logo`.
// `wordmark`/`wordmark_dark` are the wide logo-plus-name artwork. When set, the sidebar renders it across its
// full width INSTEAD of the square `logo` + the name text (name_font/weight/size then style nothing). The
// collapsed icon rail still shows `logo`, since a wordmark can't fit it.
export type OrgSettings = { name: string; legal_name?: string; logo?: string; logo_dark?: string; wordmark?: string; wordmark_dark?: string; favicon?: string; logo_text?: string; name_font?: string; name_weight?: string; name_size?: string; address?: string; incorporation_date?: string; currencies?: string[]; default_currency?: string; currency_decimals?: Record<string, number>; default_department?: string | null; banks?: string[]; letter_defaults?: LetterDefaults; quick_actions?: { groups?: { id: string; label: string; items: string[] }[]; order?: string[] }; primary_color?: string; email_logo_url?: string; document_logos?: Record<string, string> };

// The wordmark's typeface list lives in lib/fonts.ts, shared with the typeface control on a board post; it is
// re-exported here so the settings/sidebar call sites keep importing it from the module they always have.
export { NAME_FONTS, orgNameFontStack } from "./fonts";

// Weight and size for the wordmark. Like the font, these style the SIDEBAR LOGO only - everywhere else the
// org name renders in the default body style. Defaults match the original brand (bold, 15px).
export const NAME_WEIGHTS: { value: string; label: string; weight: number }[] = [
  { value: "regular", label: "Regular", weight: 400 },
  { value: "medium", label: "Medium", weight: 500 },
  { value: "semibold", label: "Semibold", weight: 600 },
  { value: "bold", label: "Bold", weight: 700 },
  { value: "extrabold", label: "Extra bold", weight: 800 },
];
export const NAME_SIZES: { value: string; label: string; px: number }[] = [
  { value: "small", label: "Small", px: 13 },
  { value: "medium", label: "Medium", px: 15 },
  { value: "large", label: "Large", px: 18 },
  { value: "xlarge", label: "Extra large", px: 22 },
];
export function orgNameWeight(weight?: string): number {
  return NAME_WEIGHTS.find((w) => w.value === weight)?.weight ?? 700;
}
export function orgNameSizePx(size?: string): number {
  return NAME_SIZES.find((s) => s.value === size)?.px ?? 15;
}

// The org's next incorporation anniversary, computed from `incorporation_date` ("YYYY-MM-DD"). Mirrors the
// server's per-employee celebrations math (UTC midnight; 0 = today) so the dashboard hat and widget line up
// with the rest of the feed. Returns null when no valid date is set or the org isn't yet 1 year old. Callers
// show it inside the org's celebration lead time (hooks/useCelebrations.ts#useCelebrationLeadDays).
export type OrgAnniversary = { in_days: number; years: number };
export function orgAnniversary(incorporationDate: string | undefined, now = new Date()): OrgAnniversary | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((incorporationDate ?? "").trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let occ = Date.UTC(now.getUTCFullYear(), month - 1, day);
  if (occ < todayMs) occ = Date.UTC(now.getUTCFullYear() + 1, month - 1, day);
  const in_days = Math.round((occ - todayMs) / 86_400_000);
  const years = new Date(occ).getUTCFullYear() - year;
  return years >= 1 ? { in_days, years } : null;
}
// Starter allowed lists; the admin trims/extends them in Settings → Organization.
const DEFAULT_ORG: OrgSettings = {
  name: APP_NAME,
  currencies: ["INR", "USD", "EUR", "GBP", "AED", "SGD"],
  default_currency: "INR",
  currency_decimals: { INR: 0 }, // whole rupees by default (override per currency in Settings -> Organization)
  banks: ["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank", "Kotak Mahindra Bank", "Punjab National Bank"],
};

/**
 * Display precision for a currency: the org's override first, then the server's own base table, then 2.
 *
 * `decimalsFor` IS THE SERVER'S FUNCTION (src/domain/currency.ts), not a mirror of it. It used to restate the
 * 26-entry base table and the [0, 4] clamp here, declaring itself a mirror in the comment - and the two had
 * already parted company on the no-code fallback (the server falls back to INR, this fell back to the org's
 * default currency). That divergence was unreachable, since every server call site passes an explicit code;
 * the reachable one is adding a zero-decimal currency to the server table, which would render a figure at 2dp
 * in the UI and 0dp on the payslip with nothing failing. `currency.ts` imports nothing, so the SPA takes it
 * directly, the way it already takes domain/money.ts and domain/leave.ts.
 *
 * The org's default currency is applied HERE rather than inside the shared function, because "which currency
 * did the caller mean" is a question about this app's org context and not about ISO 4217.
 */
export function currencyDecimals(code: string | null | undefined, org: OrgSettings): number {
  return decimalsFor(code || org.default_currency || "INR", org.currency_decimals);
}

const Ctx = createContext<{ org: OrgSettings; reload: () => void }>({ org: DEFAULT_ORG, reload: () => {} });

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [org, setOrg] = useState<OrgSettings>(DEFAULT_ORG);
  const reload = useCallback(() => {
    getSetting<Partial<OrgSettings>>("organization")
      .then((s) => setOrg({ ...DEFAULT_ORG, ...(s.value ?? {}) }))
      .catch(() => setOrg(DEFAULT_ORG)); // no row yet -> defaults
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  // Browser-tab icon follows the org's uploaded favicon (a small data URL, like the logo). With nothing
  // configured, the shipped default (index.html's /favicon.svg) is restored.
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (org.favicon) {
      link.removeAttribute("type"); // uploaded icon's format lives in the data URL itself
      link.href = org.favicon;
    } else {
      link.type = "image/svg+xml";
      link.href = "/favicon.svg";
    }
  }, [org.favicon]);
  return <Ctx.Provider value={{ org, reload }}>{children}</Ctx.Provider>;
}

export const useOrg = () => useContext(Ctx);

// The one money formatter for the app: resolves the currency's configured display precision (currencyDecimals)
// so every screen renders the same digits (INR in whole rupees by default). Pass a currency code to override
// the org default per record (e.g. a comp row's own currency). Storage stays full precision; this rounds for
// display only.
export function useMoney(): (n: number | null | undefined, code?: string) => string {
  const { org } = useOrg();
  return (n, code) => (n == null ? "" : formatMoney(n, code || org.default_currency, currencyDecimals(code, org)));
}
