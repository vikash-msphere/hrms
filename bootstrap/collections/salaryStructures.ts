// Salary structures: a per-structure selection of EARNING components (deductions/statutory always apply).
// linesJson is an ordered [{ component: <pay_components.uuid>, rate: null }]; rate null = use the component's
// own rate. References resolve via the key->uuid map from payComponents().
import { type Ctx, T0, q, j, code2, rows } from "../lib";

type SalaryStructureSeed = { name: string; description: string; componentKeys: string[] };

const SALARY_STRUCTURES: SalaryStructureSeed[] = [
  { name: "Standard", description: "Default earnings: HRA, conveyance, medical and a balancing special allowance.", componentKeys: ["hra", "conveyance", "medical", "special"] },
  { name: "Minimal", description: "Base pay plus HRA only (e.g. interns / consultants).", componentKeys: ["hra"] },
];

export function salaryStructures(ctx: Ctx, uuidByKey: Map<string, string>): string {
  return rows(
    "INSERT INTO salary_structures (uuid,code,name,description,lines_json,created_at,updated_at) VALUES",
    SALARY_STRUCTURES.map((s, i) => {
      const lines = s.componentKeys.map((k) => {
        const component = uuidByKey.get(k);
        if (!component) throw new Error(`salary structure "${s.name}" references unknown component key "${k}"`);
        return { component, rate: null };
      });
      return ` (${q(ctx.nid())},${q(code2(i + 1))},${q(s.name)},${q(s.description)},${j(lines)},${T0},${T0})`;
    }),
  );
}
