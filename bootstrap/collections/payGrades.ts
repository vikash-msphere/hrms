// Pay grades: annual CTC bands (INR). level orders them; band_min/mid/max bound the range for compa-ratio.
import { Ctx, T0, q, code2, rows } from "../lib";

type PayGradeSeed = { name: string; level: number; min: number; mid: number; max: number; description: string };

const PAY_GRADES: PayGradeSeed[] = [
  { name: "L1 - Associate", level: 1, min: 300000, mid: 450000, max: 600000, description: "Entry level / fresher" },
  { name: "L2 - Executive", level: 2, min: 600000, mid: 800000, max: 1000000, description: "Individual contributor" },
  { name: "L3 - Senior Executive", level: 3, min: 1000000, mid: 1300000, max: 1600000, description: "Experienced IC" },
  { name: "L4 - Lead / Manager", level: 4, min: 1600000, mid: 2200000, max: 2800000, description: "Team lead / first-line manager" },
  { name: "L5 - Senior Manager", level: 5, min: 2800000, mid: 3800000, max: 4800000, description: "Manager of managers" },
  { name: "L6 - Director", level: 6, min: 4800000, mid: 6500000, max: 8500000, description: "Function / department head" },
];

export function payGrades(ctx: Ctx): string {
  return rows(
    "INSERT INTO pay_grades (uuid,code,name,level,band_min,band_mid,band_max,currency,description,created_at,updated_at) VALUES",
    PAY_GRADES.map((g, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(g.name)},${g.level},${g.min},${g.mid},${g.max},'INR',${q(g.description)},${T0},${T0})`,
    ),
  );
}
