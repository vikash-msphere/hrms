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

const ORGANIZATION = { name: "Your Company Pvt Ltd", address: "", logo: "", favicon: "", default_currency: "INR", letter_defaults: { hr_email: "" }, primary_color: BRAND.primary, email_logo_url: "" };

const SETTINGS: Array<[string, unknown]> = [
  ["organization", ORGANIZATION],
  ["probation", { default_months: 3 }],
  ["ctc", DEFAULT_CTC_CONFIG],
  ["tax-config", DEFAULT_TAX_CONFIG],
  ["professional-tax", DEFAULT_PT_CONFIG],
  ["attendance", DEFAULT_ATTENDANCE],
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
];

export function settings(): string {
  return "INSERT INTO settings (key,value,updated_at) VALUES\n" +
    SETTINGS.map(([key, value]) => ` (${q(key)},${j(value)},${T0})`).join(",\n") + ";";
}
