import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get } from "@/api";
import { APP_NAME } from "./brand";
import { formatMoney } from "./utils";

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
export type OrgSettings = { name: string; legal_name?: string; logo?: string; favicon?: string; logo_text?: string; name_font?: string; name_weight?: string; name_size?: string; address?: string; incorporation_date?: string; currencies?: string[]; default_currency?: string; currency_decimals?: Record<string, number>; default_department?: string | null; banks?: string[]; letter_defaults?: LetterDefaults; quick_actions?: { groups?: { id: string; label: string; items: string[] }[]; order?: string[] }; primary_color?: string; email_logo_url?: string };

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
// with the rest of the feed. Returns null when no valid date is set or the org isn't yet 1 year old.
// "This week" window shared by the dashboard's celebrations StatCard and the sidebar logo hat, so the hat
// appears exactly when the anniversary starts counting in that card.
export const CELEBRATION_WEEK_DAYS = 7;
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

// App default minor-unit digits by ISO code (mirror of the server's domain/currency.ts). Only exceptions to
// the 2dp norm are listed, plus INR (app convention 0). Everything else falls through to 2.
const BASE_DECIMALS: Record<string, number> = {
  INR: 0, JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0, TWD: 0, UGX: 0, XAF: 0, XOF: 0, XPF: 0, RWF: 0, PYG: 0, KMF: 0, DJF: 0, BIF: 0, GNF: 0, VUV: 0,
  BHD: 3, KWD: 3, OMR: 3, TND: 3, JOD: 3, IQD: 3, LYD: 3,
};

// Display precision for a currency: org override first, then the base table, then 2. Clamped to [0, 4].
export function currencyDecimals(code: string | null | undefined, org: OrgSettings): number {
  const c = (code || org.default_currency || "INR").toUpperCase();
  const cfg = org.currency_decimals;
  const raw = cfg && Object.prototype.hasOwnProperty.call(cfg, c) ? cfg[c] : (c in BASE_DECIMALS ? BASE_DECIMALS[c] : 2);
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(4, Math.max(0, Math.trunc(n))) : 2;
}

const Ctx = createContext<{ org: OrgSettings; reload: () => void }>({ org: DEFAULT_ORG, reload: () => {} });

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [org, setOrg] = useState<OrgSettings>(DEFAULT_ORG);
  const reload = useCallback(() => {
    get<{ value?: Partial<OrgSettings> }>("settings/organization")
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
