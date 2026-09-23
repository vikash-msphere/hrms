// Shared helpers for the bootstrap generators. Each collections/*.ts module renders its own INSERT block;
// genBootstrap.ts wires them in a fixed order. The id counter is shared via a Ctx so ids stay deterministic
// (byte-identical re-runs) as long as the orchestrator invokes the modules in the same order.
import { bytesToBase32 } from "../src/lib/idCodec";

export const T0 = 1700000000000; // fixed created/updated stamp (matches scripts/seed.sql for consistency)
export const DAY = 86_400_000;

// Yearly knobs - bump these once a year and regenerate (festival dates shift; pay periods follow the FY).
export const HOLIDAY_YEAR = 2026; // calendar year the holiday list covers
export const FY_START_YEAR = 2026; // financial year 2026-27 = Apr 2026 .. Mar 2027 (pay periods + tax)

// Deterministic 13-char base32 id from a counter. Offset 30000 keeps these clear of genSeed (1000) and
// genTemplatesSeed (5000) id spaces, so a prod DB seeded from multiple generators never collides.
const idOf = (k: number) => {
  const bytes = new Uint8Array(8);
  let x = BigInt(k + 30000);
  for (let i = 7; i >= 0; i--) { bytes[i] = Number(x & 0xffn); x >>= 8n; }
  return bytesToBase32(bytes);
};

export type Ctx = { nid: () => string };

// One shared id counter per generator run. The orchestrator creates a single Ctx and threads it through the
// collection modules in a fixed order, so the id sequence is stable.
export function createCtx(): Ctx {
  let counter = 0;
  return { nid: () => idOf(counter++) };
}

// SQL literal helpers.
export const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
export const n = (v: number | null | undefined) => (v == null ? "NULL" : String(v));
export const b = (v: boolean) => (v ? 1 : 0);
export const j = (v: unknown) => q(JSON.stringify(v));
// 2-char per-collection code (unique within a table): "01".."09".."0a".. base36, fresh per collection.
export const code2 = (i: number) => i.toString(36).padStart(2, "0");
// Assemble an INSERT block from a header line + value-tuple lines.
export const rows = (header: string, lines: string[]) => header + "\n" + lines.join(",\n") + ";";
