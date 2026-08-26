// Asset categories. tagCode is what the middle of a printed tag says (Laptop -> MS-LAP-014), and the tag
// sequence runs per code; requiresSerial marks the kinds whose serial number has to be on the record.
import { type Ctx, T0, q, b, code2, rows } from "../lib";

type AssetCategorySeed = { name: string; tagCode: string; requiresSerial: boolean };

const ASSET_CATEGORIES: AssetCategorySeed[] = [
  { name: "Laptop", tagCode: "LAP", requiresSerial: true },
  { name: "Desktop", tagCode: "DSK", requiresSerial: true },
  { name: "Phone", tagCode: "PHN", requiresSerial: true },
  { name: "Monitor", tagCode: "MON", requiresSerial: true },
  { name: "Peripheral", tagCode: "PER", requiresSerial: false },
  { name: "Networking", tagCode: "NET", requiresSerial: true },
  { name: "Furniture", tagCode: "FUR", requiresSerial: false },
  { name: "Access Card", tagCode: "ACC", requiresSerial: false },
  { name: "Other", tagCode: "OTH", requiresSerial: false },
];

export function assetCategories(ctx: Ctx): string {
  return rows(
    "INSERT INTO asset_categories (uuid,code,name,tag_code,requires_serial,created_at,updated_at) VALUES",
    ASSET_CATEGORIES.map((c, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(c.name)},${q(c.tagCode)},${b(c.requiresSerial)},${T0},${T0})`,
    ),
  );
}
