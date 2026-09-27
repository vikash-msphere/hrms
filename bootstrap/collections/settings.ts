// Org settings: India statutory + lifecycle defaults. Reuses the canonical DEFAULT_* config objects the app
// reads at runtime, so the seeded values never drift from the code's fallbacks. `organization` is a
// placeholder the customer fills in. Fixed key/value rows, no Ctx needed.
import { T0, q, j } from "../lib";
import { DEFAULT_CTC_CONFIG, DEFAULT_OVERTIME_CONFIG } from "../../src/domain/payroll";
import { DEFAULT_GRATUITY_CONFIG } from "../../src/domain/settlement";
import { DEFAULT_LOAN_PERQUISITE_CONFIG } from "../../src/domain/loans";
import { DEFAULT_TAX_CONFIG } from "../../src/domain/incomeTax";
import { DEFAULT_PT_CONFIG } from "../../src/domain/statutory";
import { DEFAULT_ATTENDANCE } from "../../src/domain/attendance";
import { DEFAULT_TRANSITION_TEMPLATES } from "../../src/domain/transitions";
import { BRAND } from "../../src/domain/brand";
import { DEFAULT_ESIGN } from "../../src/domain/esign";
import { DEFAULT_TICKET_CATEGORIES } from "../../src/domain/tickets";

const ORGANIZATION = { name: "Your Company Pvt Ltd", address: "", logo: "", favicon: "", default_currency: "INR", letter_defaults: { hr_email: "" }, primary_color: BRAND.primary, email_logo_url: "" };

const SETTINGS: Array<[string, unknown]> = [
  ["organization", ORGANIZATION],
  ["probation", { default_months: 3 }],
  ["ctc", DEFAULT_CTC_CONFIG],
  ["tax-config", DEFAULT_TAX_CONFIG],
  ["professional-tax", DEFAULT_PT_CONFIG],
  // A FRESH org starts on resolved schedules, unlike an existing one. The "org" default in
  // DEFAULT_ATTENDANCE exists so that an org already keeping a roster as a planning grid does not find those
  // entries deciding pay the day schedules ship - a new database has no such roster to reinterpret, and
  // making it opt in would leave part-time weeks and rotations silently inert.
  ["attendance", { ...DEFAULT_ATTENDANCE, schedule_source: "resolved" }],
  ["overtime", DEFAULT_OVERTIME_CONFIG],
  // Statutory gratuity at exit (15 days' wages per completed year after 5 years, exempt to ₹20L). Enabled: the
  // entitlement is statutory. An org that settles gratuity through an LIC/trust policy instead sets enabled
  // false, so the full-and-final doesn't pay it a second time.
  ["gratuity", DEFAULT_GRATUITY_CONFIG],
  // Interest concession on an employer loan as a taxable perquisite (Rule 3(7)(i)). Off until HR sets the SBI
  // rate as on 1 April of the financial year - a guessed rate would silently over-withhold.
  ["loan-perquisite", DEFAULT_LOAN_PERQUISITE_CONFIG],
  ["transition-templates", DEFAULT_TRANSITION_TEMPLATES],
  // e-signature: ships on DEFAULT_ESIGN (enabled, no vendor config) so in-app signature signing works out of
  // the box with no external dependency. The signing METHOD is chosen per e-signature block on a template
  // (letters) or per document (org-documents): "in-app signature" or "Aadhaar e-Sign". To allow Aadhaar
  // (Cashfree), set the env secrets (ESIGN_CASHFREE_CLIENT_ID / ESIGN_CASHFREE_CLIENT_SECRET), register the
  // webhook POST /esign/callback/cashfree, and add the vendor config here, e.g.:
  //   { enabled: true, providers: { cashfree: { api_base: "https://api.cashfree.com/verification", expiry_days: 7 } } }
  // Choosing Aadhaar on a template/document without those secrets makes signing throw. See
  // docs/05-add-esign-provider.md.
  ["esign", DEFAULT_ESIGN],
  // Four-eyes on permission changes. OFF: most orgs want an access admin's edit to land immediately. Turned
  // on, every access-rule write queues as a pending change a SECOND access admin has to approve
  // (services/accessRules.ts) - the row carries the pending state, so nothing takes effect meanwhile.
  ["access-approval", { enabled: false }],
  // Four-eyes on the PAYROLL commit, the same shape one line up and off for the same reason. Turned on, the
  // person who submitted a run for review cannot also approve it (services/payroll.ts) - approve is the step
  // that consumes the period, unlocks the bank file and never rolls back. Off by default because a one-admin
  // org has nobody else to approve, and the way out of that is this switch.
  ["payroll-approval", { enabled: false }],
  // Help-desk categories. Seeded rather than left to the service's fallback because the two are not equivalent
  // from the browser: the server falls back when the row is missing, but the SPA reads the settings row
  // directly, so with no row every ticket dialog offered an empty category picker and a permanently disabled
  // submit - the whole feature looked broken on a fresh install. Same constant either way, so the seeded rows
  // and the fallback cannot disagree. Assignees, members and servicing departments stay unset: they are refs
  // to people and departments this database does not have yet, and HR fills them in from Settings.
  ["ticket-categories", DEFAULT_TICKET_CATEGORIES],
  // How many days ahead a birthday or work anniversary starts to show on the dashboard, the team timeline and
  // the sidebar's company-anniversary banner (0 = only on the day). A week, so a celebration is news in the
  // week it happens rather than a month before. Migration 0015 writes the same row into existing databases.
  ["celebrations", { lead_days: 7 }],
];

// OR IGNORE because a migration may already have written a row (0015 writes `celebrations` into every
// database, fresh ones included), and the bootstrap runs after the migrations.
export function settings(): string {
  return "INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES\n" +
    SETTINGS.map(([key, value]) => ` (${q(key)},${j(value)},${T0})`).join(",\n") + ";";
}
