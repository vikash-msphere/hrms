// Recurring statutory obligations. The daily cron rolls each active rule into dated compliance_events
// occurrences over a ~12-month horizon. dueDay = day of month; anchorMonth = quarterly cycle start / annual
// month (omit for monthly).
import { type Ctx, T0, q, n, code2, rows } from "../lib";

type ComplianceRuleSeed = {
  title: string;
  category: string;
  frequency: "monthly" | "quarterly" | "annual";
  dueDay: number;
  anchorMonth?: number;
  notes?: string;
};

const COMPLIANCE_RULES: ComplianceRuleSeed[] = [
  { title: "EPF contribution & ECR", category: "EPFO", frequency: "monthly", dueDay: 15, notes: "Deposit + electronic challan-cum-return for the previous month." },
  { title: "ESI contribution", category: "ESIC", frequency: "monthly", dueDay: 15, notes: "Deposit for the previous month." },
  { title: "TDS deposit", category: "Income Tax (TDS)", frequency: "monthly", dueDay: 7, notes: "Challan ITNS-281 for the previous month's TDS." },
  { title: "Professional Tax", category: "Professional Tax", frequency: "monthly", dueDay: 20, notes: "State PT remittance (due day varies by state)." },
  { title: "GST GSTR-1", category: "GST", frequency: "monthly", dueDay: 11, notes: "Outward supplies return." },
  { title: "GST GSTR-3B", category: "GST", frequency: "monthly", dueDay: 20, notes: "Summary return + tax payment." },
  { title: "TDS quarterly return (24Q/26Q)", category: "Income Tax (TDS)", frequency: "quarterly", dueDay: 31, anchorMonth: 1, notes: "Quarterly TDS statement." },
  { title: "PF annual return", category: "EPFO", frequency: "annual", dueDay: 30, anchorMonth: 4, notes: "Annual reconciliation." },
];

export function complianceRules(ctx: Ctx): string {
  return rows(
    "INSERT INTO compliance_rules (uuid,code,title,category,frequency,due_day,anchor_month,notes,active,created_at,updated_at) VALUES",
    COMPLIANCE_RULES.map((r, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(r.title)},${q(r.category)},${q(r.frequency)},${r.dueDay},${n(r.anchorMonth)},${q(r.notes ?? null)},1,${T0},${T0})`,
    ),
  );
}
