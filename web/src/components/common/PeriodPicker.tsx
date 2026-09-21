import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { thisYearStr } from "@/lib/orgDay";
import { periodRange, type PeriodType } from "@/lib/budgetPeriod";

/** Picks a budget period key ("2026" | "2026-Q3" | "2026-07") with the control that fits its granularity: a
 *  native month input for monthly, a year select for yearly, year + quarter for quarterly. Shared by every
 *  budget dialog so the same key format is entered the same way wherever a cap is created. */
export function PeriodPicker({ type, value, onChange }: { type: PeriodType; value: string; onChange: (key: string) => void }) {
  const thisYear = Number(thisYearStr()); // the org's year, not the browser's
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 2 + i);
  const parsed = periodRange(type, value);
  const year = parsed ? new Date(parsed.start).getUTCFullYear() : thisYear;
  const quarter = parsed ? Math.floor(new Date(parsed.start).getUTCMonth() / 3) + 1 : 1;

  if (type === "monthly") {
    return <Input type="month" value={/^\d{4}-\d{2}$/.test(value) ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
  const yearSelect = (
    <Select value={String(year)} onValueChange={(y) => onChange(type === "yearly" ? y : `${y}-Q${quarter}`)}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
    </Select>
  );
  if (type === "yearly") return yearSelect;
  return (
    <div className="flex gap-2">
      {yearSelect}
      <Select value={String(quarter)} onValueChange={(q) => onChange(`${year}-Q${q}`)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{[1, 2, 3, 4].map((q) => <SelectItem key={q} value={String(q)}>Q{q}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
