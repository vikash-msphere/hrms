# Money: how pay, payroll, compensation and tax behave

The monetary surface is `domain/{money,currency,payroll,incomeTax,statutory,settlement,encashment,loans,attendance}.ts`
plus `services/{payroll,taxProjection,compensation,settlements,leaveEncashments,loans,bonuses,reimbursements,statutoryReport,form16,bankFile,payComponents}.ts`
and the web mirrors (`EmployeeCompensation.tsx`, `PayComponents.tsx`, `Settings.tsx` payroll policy).

Invariants this surface holds:

- ONE rounding helper (`round2`/`sum2`, decimal-half-correct) server-side, mirrored by `round2` in `web/src/lib/utils.ts`
  so a previewed figure can't disagree with the stored one by a paise.
- Single-currency guards on every payable; a payable in another currency fails the build loudly.
- Exactly-once paid-by-run markers with checked flips; the whole build commits in one atomic batch and rolls back
  when a payable moved under it.
- Each period is priced at the compensation in force THEN; a backdated raise pays arrears only for published periods.
- The new-regime tax pipeline follows the government calculator: slab → 87A (with marginal relief) → surcharge
  (with marginal relief) → cess.
- ESI eligibility is sticky within a contribution period; employer contributions are frozen on the run item.

## Wage, tax and statutory bases

**Loss of pay is a NEGATIVE EARNING, never a deduction.** Docked pay is pay that was never earned, so it leaves
gross, the income-tax base and the PF/ESI bases together (`services/payroll.ts`, `domain/payroll.ts:computeRunItem`).
A manually keyed LOP one-off (a deduction line coded `LOP`) is normalised to the same shape. Automatic LOP is
clamped to the period's regular wage, so a full-month absence zeroes the salary instead of turning it negative.

**Each statutory head sits on its own wage, as actually paid:**

| Base | What it is |
| --- | --- |
| ESI wages | regular wage − loss of pay + arrears + overtime (bonus, leave encashment and reimbursements are not ESI wages) |
| PF wages | `pfWagesOf(basic, special, components, basis)` − loss of pay + the BASIC slice of arrears (`compensation.arrears_base_amount`) |
| PT slab | the full monthly wage BRACKET (unprorated), and nothing at all in a fully docked month |
| ESI eligibility | the full monthly wage rate, or sticky membership from earlier in the contribution period |
| Income tax | `computeRunItem().taxableGross`: taxable earnings (LOP netted out) + perquisite value |

**PF wage composition is org policy** (`settings/ctc.pf_wage_basis`): `basic` (default) or `basic_plus`, which adds
the Special Allowance plug and every earning component flagged `pf_wages` (the Vivekananda Vidyamandir line; HRA,
overtime and bonus stay out by statute). The basis feeds the CTC split solver, the letters annexure and the run, so
one figure everywhere.

**The employer's PF cost is complete:** employer EPF, plus EDLI (`edli`) and administration charges (`pf_admin`) as
their own pay-component methods on the same PF wages and ceiling. All three are gated on PF membership, ride in the
CTC build-up, and appear as their own heads in the statutory register and the PF challan view.

**Payout precision is reconciled at the source.** The run settles each item's net to the currency's payout precision
(whole rupees for INR) with an explicit non-taxable `ROUND` line, so the payslip, the stored item and the bank file
state the same number.

**A perquisite is taxable value the employee never receives.** `kind: "perquisite"` lifts `taxableGross` only. Today
the one producer is the interest concession on a cheap employer loan (Rule 3(7)(i)), off until HR sets the SBI rate
in `settings/loan-perquisite`.

## Full and final settlement

The FnF is the leaver's terminal payout and withholds like a payroll run:

- **Final-month salary** is priced on days actually employed (a mid-month joiner is not paid from the 1st) less the
  month's unexcused absence day-units, from the same attendance facts a run uses.
- **Leave encashment** uses the same basis + divisor as a mid-employment cashout (`settings/leave_encashment`), and
  only ENCASHABLE, non-disabled leave types are cashed out and debited.
- **Gratuity** (`settings/gratuity`, enabled by default): 15 days' last-drawn basic per completed year on a 26-day
  month once the qualifying service is served, exempt u/s 10(10) up to the ceiling. Disable it when gratuity is
  settled through an LIC/trust policy, or the FnF would pay it twice.
- **Withholding**: EPF on the final month's PF wages, ESI on the wages paid, PT for the month, and income tax for
  the whole remaining balance of the year - there is no later payroll to collect it in.
- **Exemptions** are carried per line (`taxable` on a settlement line): s.10(10) for gratuity, s.10(10AA) for exit
  encashment (least of received / ₹25L / ten months' salary / 30 days per completed year), 0 for reimbursements.
- `settlements.taxable_earnings` + `settlements.tds` are stored, and Form 16 and the year's projection read them -
  a leaver appears in no payroll run, so the certificate would otherwise omit the year's largest payment.

Recomputing a settlement still releases exactly what the previous one consumed (`settled_json`) before re-pricing.

## Tax projection

- A finalized run carries TWO month keys: `paidMonths` (pay-date - when tax was collected, feeding
  `collectibleMonths`) and `earnedMonths` (period - which month's salary is already priced, feeding
  `unpaidEarningMonths`). Conflating them mis-priced one month whenever pay lagged earning.
- VERIFIED investment declarations reduce withholding through `allowedDeductions`, which keeps only the sections the
  regime permits and caps each. The new regime allows 80CCD(2)/80CCH; an `old` regime block added to
  `settings/tax-config` (with `sectionCaps`) picks up the rest with no code change. A merely DECLARED row moves
  nothing - verification is the gate, same as prior-employer figures.
- `finalizedTotals` filters run items to the FY's finalized runs in SQL, and to a single employee when the caller
  wants one (the Tax page, Form 16, the FnF) - it is the app's hottest read path on D1.

## Payroll membership and recovery

- A run pays everyone NOT `terminated` and not soft-deleted (so `on_leave` is paid); leavers are paid by their FnF.
- A loan installment is collected only from the agreed `start_date` and only once per calendar month; run-driven
  ledger rows are dated by their pay period, so a late build or a rebuilt old period reads correctly. Recovery is
  still capped so net cannot go negative and never garnishes a reimbursement payout.

## Deliberately out of scope

- **Multi-currency / FX.** The app is single-currency by design (org `default_currency`); every payable is guarded.
- **24Q / TDS return files.** The statutory report is the contribution register plus a real PF ECR text file (UAN,
  PAN and ESI-IP come from the encrypted identity fields); the 24Q FVU itself is not generated.
- **Employer contributions on the FnF.** The exit payout states what is withheld from the employee; the employer's
  own PF/ESI cost for a final month is not carried on the settlement record.
- **s.16(iii) PT deduction from salary income.** Neither the run nor the FnF reduces taxable salary by the
  professional tax withheld; both treat chargeable pay as gross taxable earnings.
