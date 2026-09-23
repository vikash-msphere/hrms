// Leave types (India statutory shape). accrual = days credited per year (0 = entitlement granted by HR, not
// auto-accrued, e.g. maternity). Flags left unset fall back to the schema defaults (paid=true, no
// carry-forward, not encashable).
import { type Ctx, T0, q, n, b, code2, rows } from "../lib";

type LeaveTypeSeed = {
  name: string;
  accrual: number;
  paid?: boolean;
  color?: string;
  carryForward?: boolean;
  carryForwardCap?: number | null;
  encashable?: boolean;
  encashmentCap?: number | null;
  minBalanceRetained?: number;
  availableDuringProbation?: boolean;
  probationAccrual?: number;
};

const LEAVE_TYPES: LeaveTypeSeed[] = [
  // Earned / Privilege leave: accrues, carries forward (capped), and is encashable - the classic EL.
  { name: "Earned Leave", accrual: 18, color: "#8b5cf6", carryForward: true, carryForwardCap: 30, encashable: true, encashmentCap: 15, minBalanceRetained: 5, availableDuringProbation: false, probationAccrual: 0 },
  { name: "Sick Leave", accrual: 12, color: "#ef4444" },
  { name: "Casual Leave", accrual: 12, color: "#f59e0b", availableDuringProbation: true },
  // Statutory entitlements granted as a block by HR (Maternity Benefit Act = 26 weeks; paternity is policy).
  { name: "Maternity Leave", accrual: 0, color: "#ec4899" },
  { name: "Paternity Leave", accrual: 0, color: "#3b82f6" },
  { name: "Compensatory Off", accrual: 0, color: "#10b981" },
  { name: "Bereavement Leave", accrual: 0, color: "#6b7280" },
  { name: "Loss of Pay", accrual: 0, paid: false, color: "#9ca3af" },
];

export function leaveTypes(ctx: Ctx): string {
  return rows(
    "INSERT INTO leave_types (uuid,code,name,accrual_days_per_year,paid,color,available_during_probation,probation_accrual_days_per_year,encashable,encashment_cap_days_per_year,min_balance_retained_days,carry_forward,carry_forward_cap_days,created_at,updated_at) VALUES",
    LEAVE_TYPES.map((t, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(t.name)},${t.accrual},${b(t.paid ?? true)},${q(t.color)},${b(t.availableDuringProbation ?? true)},${t.probationAccrual ?? 0},${b(t.encashable ?? false)},${n(t.encashmentCap)},${t.minBalanceRetained ?? 0},${b(t.carryForward ?? false)},${n(t.carryForwardCap)},${T0},${T0})`,
    ),
  );
}
