// Reading opening balances out of a spreadsheet (the Opening balances page).
//
// HR has the old system's figures in a sheet: one row per person, a column per leave type (or per pay figure).
// This turns a paste (tab-separated, the way a spreadsheet copies) or a CSV file into the items
// `leave-adjustments:importOpenings` and `payroll-openings:importOpenings` take, and says per line and per cell
// what it could not read - because the failure worth designing against
// is a row that silently landed on the wrong person or the wrong type. Nothing is written from here: the
// server previews every item first, and only a separate apply writes. Pure, so the rules are testable.

import { round2 } from "@/lib/utils";

/** The shape a row is matched against: people by their employee ID or work email, types by name. */
export type ImportEmployee = { path: string; employee_number?: string | null; work_email?: string | null; first_name?: string; last_name?: string; tracked_from?: string | null };
export type ImportLeaveType = { path: string; display_name?: string | null; encashable?: boolean | null; paid?: boolean | null };

export type OpeningCell = { leaveType: string; column: string; opening_days: number; encashed_days?: number | null };
export type OpeningLine = {
  line: number;
  /** What identified the person in the sheet (the first column). */
  key: string;
  employee?: string;
  name?: string;
  cells: OpeningCell[];
  errors: string[];
};
export type ParsedOpenings = {
  lines: OpeningLine[];
  /** Header cells that named no leave type, so their column is ignored. */
  unknownColumns: string[];
  /** A problem with the sheet as a whole (no header, no leave-type column). */
  error?: string;
};

// A column carrying days already encashed that year for the type it names: "<type> encashed", optionally
// followed by "this year" or "(days)".
const ENCASHED = /^(.*?)\s+encashed(\s+this\s+year)?(\s*\(days\))?$/i;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Split one line of a sheet into cells. Tab-separated when the line has a tab (a spreadsheet copy), otherwise
 * comma-separated with CSV quoting, so a name like "Rao, Priya" survives either way.
 */
export function splitRow(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** A day count as a sheet might write it: "12", "12.5", "12,5". Blank or "-" is "not given", not zero. */
export function parseDays(s: string): number | null | "invalid" {
  const t = s.trim();
  if (!t || t === "-") return null;
  const n = Number(t.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return round2(n);
}

/**
 * Parse a pasted sheet or CSV. The first non-blank line is the header: its first column identifies the person
 * (an employee ID or a work email - whichever the sheet uses), a column named after a leave type carries that
 * type's opening balance, and a "<type> encashed" column the days already encashed that year. Other columns
 * (a name column, notes) are ignored and listed, so a misspelt type is visible rather than quietly dropped.
 *
 * A blank cell means "leave this balance as HRMS has it" - a sheet may cover only some types or people.
 */
export function parseOpenings(text: string, employees: ImportEmployee[], leaveTypes: ImportLeaveType[]): ParsedOpenings {
  const rows = text.split(/\r?\n/).map((raw, i) => ({ raw, line: i + 1 })).filter((r) => r.raw.trim() && !r.raw.trim().startsWith("#"));
  if (!rows.length) return { lines: [], unknownColumns: [], error: "Paste the sheet, header row first." };
  const header = splitRow(rows[0]!.raw);
  const typeByName = new Map(leaveTypes.map((t) => [norm(t.display_name ?? ""), t]));
  const columns: ({ kind: "opening" | "encashed"; type: ImportLeaveType } | null)[] = header.map((h, i) => {
    if (i === 0) return null;
    const direct = typeByName.get(norm(h));
    if (direct) return { kind: "opening", type: direct };
    const m = ENCASHED.exec(h.trim());
    const enc = m ? typeByName.get(norm(m[1]!)) : undefined;
    return enc ? { kind: "encashed", type: enc } : null;
  });
  if (!columns.some((c) => c?.kind === "opening")) {
    return { lines: [], unknownColumns: header.slice(1).filter(Boolean), error: "No column is named after a leave type. The header must use the leave type names exactly as HRMS shows them." };
  }
  const unknownColumns = header.filter((h, i) => i > 0 && h && !columns[i] && !/^(name|employee|employee name|full name|notes?)$/i.test(h.trim()));

  const byNumber = new Map<string, ImportEmployee>();
  const byEmail = new Map<string, ImportEmployee>();
  for (const e of employees) {
    if (e.employee_number) byNumber.set(norm(e.employee_number), e);
    if (e.work_email) byEmail.set(norm(e.work_email), e);
  }
  const seen = new Set<string>();
  const lines: OpeningLine[] = rows.slice(1).map(({ raw, line }) => {
    const cells = splitRow(raw);
    const key = cells[0] ?? "";
    const out: OpeningLine = { line, key, cells: [], errors: [] };
    const emp = byNumber.get(norm(key)) ?? byEmail.get(norm(key));
    if (!key) { out.errors.push("No employee ID or email in the first column."); return out; }
    if (!emp) { out.errors.push(`No employee has the ID or work email "${key}".`); return out; }
    out.employee = emp.path;
    out.name = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || key;
    if (seen.has(emp.path)) { out.errors.push("This person is on an earlier line too."); return out; }
    seen.add(emp.path);
    if (!emp.tracked_from) out.errors.push("HRMS records start is not set for this person yet - set it first; HRMS accrual for this person counts from that day.");
    const encashedByType = new Map<string, number | null>();
    columns.forEach((c, i) => {
      if (c?.kind !== "encashed") return;
      const v = parseDays(cells[i] ?? "");
      if (v === "invalid") out.errors.push(`"${header[i]}" is not a number of days.`);
      else if (v !== null) encashedByType.set(c.type.path, v);
    });
    columns.forEach((c, i) => {
      if (c?.kind !== "opening") return;
      const v = parseDays(cells[i] ?? "");
      if (v === "invalid") { out.errors.push(`"${header[i]}" is not a number of days.`); return; }
      if (v === null) return;
      out.cells.push({ leaveType: c.type.path, column: header[i]!, opening_days: v, encashed_days: encashedByType.get(c.type.path) ?? null });
    });
    return out;
  });
  return { lines, unknownColumns };
}

/** The items the server takes, from the lines that read cleanly. */
export function openingItems(parsed: ParsedOpenings): { employee: string; leave_type: string; opening_days: number; encashed_days: number | null }[] {
  return parsed.lines
    .filter((l) => l.employee && !l.errors.length)
    .flatMap((l) => l.cells.map((c) => ({ employee: l.employee!, leave_type: c.leaveType, opening_days: c.opening_days, encashed_days: c.encashed_days ?? null })));
}

// ---- Pay and tax so far this year (`payroll-openings:importOpenings`) ------------------------------------------

export type PayOpeningItem = {
  employee: string;
  financial_year: string;
  paid_through: string;
  gross: number;
  taxable_gross: number;
  tds: number;
  pt: number;
  esi_contributing: boolean;
};
export type PayOpeningLine = { line: number; key: string; employee?: string; name?: string; item?: PayOpeningItem; errors: string[] };
export type ParsedPayOpenings = { lines: PayOpeningLine[]; unknownColumns: string[]; error?: string };

type PayColumn = "paid_through" | "gross" | "taxable_gross" | "tds" | "pt" | "esi";
const PAY_HEADERS: Record<string, PayColumn> = {
  "paid through": "paid_through", "last month paid": "paid_through", "paid up to": "paid_through",
  gross: "gross", "gross pay": "gross", "gross salary": "gross",
  "taxable gross": "taxable_gross", taxable: "taxable_gross", "taxable pay": "taxable_gross", "taxable income": "taxable_gross",
  tds: "tds", "income tax": "tds",
  pt: "pt", "professional tax": "pt",
  esi: "esi", "esi contributing": "esi", "esi deducted": "esi",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** An amount as a sheet might write it: "123456", "1,23,456.50", "₹ 12,000". Blank or "-" is zero. */
export function parseAmount(s: string): number | "invalid" {
  const t = s.trim().replace(/[₹\s,]/g, "");
  if (!t || t === "-") return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? round2(n) : "invalid";
}

/** A month as a sheet might write it - "2026-08", "08/2026", "Aug 2026", "August 2026" - as "YYYY-MM". */
export function parseMonth(s: string): string | null {
  const t = s.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return monthOf(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return monthOf(Number(m[2]), Number(m[1]));
  m = /^([a-z]+)[\s-]+(\d{4})$/.exec(t);
  if (m) {
    const i = MONTHS.indexOf(m[1]!.slice(0, 3));
    return i >= 0 ? monthOf(Number(m[2]), i + 1) : null;
  }
  return null;
}
const monthOf = (y: number, mo: number) => (mo >= 1 && mo <= 12 ? `${y}-${String(mo).padStart(2, "0")}` : null);

const parseYesNo = (s: string): boolean | "invalid" => {
  const t = s.trim().toLowerCase();
  if (!t || ["no", "n", "false", "0", "-"].includes(t)) return false;
  if (["yes", "y", "true", "1"].includes(t)) return true;
  return "invalid";
};

/**
 * Parse a pasted sheet or CSV of pay and tax so far in `financialYear`. The first non-blank line is the header:
 * its first column identifies the person (employee ID or work email), and the others are recognised by name -
 * "Paid through", "Gross", "Taxable gross" (defaults to gross), "TDS", "PT", "ESI contributing". A blank amount
 * is zero; a line with no "Paid through" is an error, because the months it covers are the whole point.
 */
export function parsePayOpenings(text: string, employees: ImportEmployee[], financialYear: string): ParsedPayOpenings {
  const rows = text.split(/\r?\n/).map((raw, i) => ({ raw, line: i + 1 })).filter((r) => r.raw.trim() && !r.raw.trim().startsWith("#"));
  if (!rows.length) return { lines: [], unknownColumns: [], error: "Paste the sheet, header row first." };
  const header = splitRow(rows[0]!.raw);
  const columns = header.map((h, i) => (i === 0 ? null : PAY_HEADERS[norm(h)] ?? null));
  if (!columns.includes("paid_through") || !columns.includes("gross")) {
    return { lines: [], unknownColumns: [], error: 'The header needs at least a "Paid through" and a "Gross" column.' };
  }
  const unknownColumns = header.filter((h, i) => i > 0 && h && !columns[i] && !/^(name|employee|employee name|full name|notes?)$/i.test(h.trim()));
  const col = (cells: string[], c: PayColumn) => {
    const i = columns.indexOf(c);
    return i < 0 ? undefined : cells[i] ?? "";
  };

  const byNumber = new Map<string, ImportEmployee>();
  const byEmail = new Map<string, ImportEmployee>();
  for (const e of employees) {
    if (e.employee_number) byNumber.set(norm(e.employee_number), e);
    if (e.work_email) byEmail.set(norm(e.work_email), e);
  }
  const seen = new Set<string>();
  const lines = rows.slice(1).map(({ raw, line }): PayOpeningLine => {
    const cells = splitRow(raw);
    const key = cells[0] ?? "";
    const out: PayOpeningLine = { line, key, errors: [] };
    if (!key) { out.errors.push("No employee ID or email in the first column."); return out; }
    const emp = byNumber.get(norm(key)) ?? byEmail.get(norm(key));
    if (!emp) { out.errors.push(`No employee has the ID or work email "${key}".`); return out; }
    out.employee = emp.path;
    out.name = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || key;
    if (seen.has(emp.path)) { out.errors.push("This person is on an earlier line too."); return out; }
    seen.add(emp.path);
    const through = parseMonth(col(cells, "paid_through") ?? "");
    if (!through) out.errors.push('"Paid through" is not a month (write it like 2026-08 or Aug 2026).');
    const amounts: Partial<Record<"gross" | "taxable_gross" | "tds" | "pt", number>> = {};
    for (const c of ["gross", "taxable_gross", "tds", "pt"] as const) {
      const cell = col(cells, c);
      if (cell === undefined || (c === "taxable_gross" && !cell.trim())) continue;
      const v = parseAmount(cell);
      if (v === "invalid") out.errors.push(`"${header[columns.indexOf(c)]}" is not an amount.`);
      else amounts[c] = v;
    }
    const esi = parseYesNo(col(cells, "esi") ?? "");
    if (esi === "invalid") out.errors.push('"ESI contributing" must be yes or no.');
    if (out.errors.length || !through) return out;
    const gross = amounts.gross ?? 0;
    out.item = {
      employee: emp.path, financial_year: financialYear, paid_through: through,
      gross, taxable_gross: amounts.taxable_gross ?? gross, tds: amounts.tds ?? 0, pt: amounts.pt ?? 0, esi_contributing: esi === true,
    };
    return out;
  });
  return { lines, unknownColumns };
}

/** The items the server takes, from the lines that read cleanly. */
export const payOpeningItems = (parsed: ParsedPayOpenings): PayOpeningItem[] => parsed.lines.flatMap((l) => (l.item ? [l.item] : []));

/** The pay sheet to fill in: everybody whose HRMS records start after they joined, figures left blank. */
export function payOpeningTemplate(employees: ImportEmployee[]): { headers: string[]; rows: string[][] } {
  const headers = ["Employee ID", "Name", "Paid through", "Gross", "Taxable gross", "TDS", "PT", "ESI contributing"];
  const rows = employees
    .filter((e) => e.tracked_from)
    .map((e) => ({ e, name: `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ e, name }) => [e.employee_number || e.work_email || "", name, "", "", "", "", "", ""]);
  return { headers, rows };
}

// ---- Leave taken before HRMS (`leave-requests:importHistory`) ---------------------------------------------------

export type HistoryItem = {
  employee: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  start_session?: 1 | 2;
  end_session?: 1 | 2;
  days?: number | null;
  reason?: string | null;
};
export type HistoryLine = { line: number; key: string; employee?: string; name?: string; item?: HistoryItem; errors: string[] };
export type ParsedHistory = { lines: HistoryLine[]; unknownColumns: string[]; error?: string };

type HistoryColumn = "type" | "from" | "to" | "days" | "start_session" | "end_session" | "reason";
const HISTORY_HEADERS: Record<string, HistoryColumn> = {
  "leave type": "type", type: "type", leave: "type",
  from: "from", "start date": "from", start: "from", "from date": "from",
  to: "to", "end date": "to", end: "to", "to date": "to",
  days: "days", "no. of days": "days", "number of days": "days",
  "start session": "start_session", "first day": "start_session",
  "end session": "end_session", "last day": "end_session",
  reason: "reason", notes: "reason", note: "reason",
};

/**
 * A date as a sheet might write it, as "YYYY-MM-DD": "2026-03-02", "02/03/2026" or "2-3-2026" (day first, the
 * way the rest of the app reads a date), "2 Mar 2026". Null when it is not one.
 */
export function parseDate(s: string): string | null {
  const t = s.trim().toLowerCase();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[\s-]+([a-z]+)[\s-]+(\d{4})$/.exec(t))) {
    const i = MONTHS.indexOf(m[2]!.slice(0, 3));
    if (i < 0) return null;
    [d, mo, y] = [Number(m[1]), i + 1, Number(m[3])];
  } else return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return !isNaN(+back) && back.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Which half of a day a leave starts or ends on: "AM"/"first half"/"1", "PM"/"second half"/"2". Blank = whole day. */
const parseSession = (s: string): 1 | 2 | null | "invalid" => {
  const t = norm(s);
  if (!t || t === "full" || t === "full day" || t === "-") return null;
  if (["am", "1", "first half", "morning"].includes(t)) return 1;
  if (["pm", "2", "second half", "afternoon"].includes(t)) return 2;
  return "invalid";
};

/**
 * Parse a pasted sheet or CSV of leave taken before HRMS: one leave per line. The first column identifies the
 * person (employee ID or work email); the others are recognised by name - "Leave type" (as HRMS names it),
 * "From", "To", and optionally "Days" (counted by the server when blank), "Start session" / "End session" for a
 * half day ("PM" on the first day, "AM" on the last), and "Reason".
 */
export function parseLeaveHistory(text: string, employees: ImportEmployee[], leaveTypes: ImportLeaveType[]): ParsedHistory {
  const rows = text.split(/\r?\n/).map((raw, i) => ({ raw, line: i + 1 })).filter((r) => r.raw.trim() && !r.raw.trim().startsWith("#"));
  if (!rows.length) return { lines: [], unknownColumns: [], error: "Paste the sheet, header row first." };
  const header = splitRow(rows[0]!.raw);
  const columns = header.map((h, i) => (i === 0 ? null : HISTORY_HEADERS[norm(h)] ?? null));
  if (!columns.includes("type") || !columns.includes("from") || !columns.includes("to")) {
    return { lines: [], unknownColumns: [], error: 'The header needs "Leave type", "From" and "To" columns.' };
  }
  const unknownColumns = header.filter((h, i) => i > 0 && h && !columns[i] && !/^(name|employee|employee name|full name)$/i.test(h.trim()));
  const col = (cells: string[], c: HistoryColumn) => {
    const i = columns.indexOf(c);
    return i < 0 ? "" : cells[i] ?? "";
  };
  const typeByName = new Map(leaveTypes.map((t) => [norm(t.display_name ?? ""), t]));
  const byNumber = new Map<string, ImportEmployee>();
  const byEmail = new Map<string, ImportEmployee>();
  for (const e of employees) {
    if (e.employee_number) byNumber.set(norm(e.employee_number), e);
    if (e.work_email) byEmail.set(norm(e.work_email), e);
  }
  const lines = rows.slice(1).map(({ raw, line }): HistoryLine => {
    const cells = splitRow(raw);
    const key = cells[0] ?? "";
    const out: HistoryLine = { line, key, errors: [] };
    if (!key) { out.errors.push("No employee ID or email in the first column."); return out; }
    const emp = byNumber.get(norm(key)) ?? byEmail.get(norm(key));
    if (!emp) { out.errors.push(`No employee has the ID or work email "${key}".`); return out; }
    out.employee = emp.path;
    out.name = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || key;
    const typeName = col(cells, "type");
    const lt = typeByName.get(norm(typeName));
    if (!lt) out.errors.push(`"${typeName}" is not a leave type HRMS has.`);
    const from = parseDate(col(cells, "from"));
    const to = parseDate(col(cells, "to"));
    if (!from) out.errors.push(`"From" is not a date (write it like 2026-03-02 or 02/03/2026).`);
    if (!to) out.errors.push(`"To" is not a date.`);
    const daysCell = col(cells, "days");
    const days = daysCell.trim() ? parseDays(daysCell) : null;
    if (days === "invalid") out.errors.push('"Days" is not a number of days.');
    const ss = parseSession(col(cells, "start_session"));
    const es = parseSession(col(cells, "end_session"));
    if (ss === "invalid" || es === "invalid") out.errors.push("A session must be AM or PM (or blank for the whole day).");
    if (out.errors.length || !lt || !from || !to || days === "invalid" || ss === "invalid" || es === "invalid") return out;
    const reason = col(cells, "reason").trim();
    out.item = {
      employee: emp.path, leave_type: lt.path, start_date: from, end_date: to,
      ...(ss ? { start_session: ss } : {}), ...(es ? { end_session: es } : {}),
      days, ...(reason ? { reason } : {}),
    };
    return out;
  });
  return { lines, unknownColumns };
}

export const historyItems = (parsed: ParsedHistory): HistoryItem[] => parsed.lines.flatMap((l) => (l.item ? [l.item] : []));

/** The leave history sheet: the header only, since it is one row per leave rather than one per person. */
export function historyTemplate(): { headers: string[]; rows: string[][] } {
  return {
    headers: ["Employee ID", "Name", "Leave type", "From", "To", "Days", "Start session", "End session", "Reason"],
    rows: [],
  };
}

/**
 * The sheet to fill in: everybody whose HRMS records start after they joined, one column per leave type that
 * holds a balance, and an "encashed this year" column for each type that can be encashed. An unpaid type
 * (Loss of Pay) holds no balance to open, so it has no column. Values are left blank on purpose - the figures
 * belong to the system before, and a prefilled HRMS number would be the very reading the opening replaces.
 */
export function openingTemplate(employees: ImportEmployee[], leaveTypes: ImportLeaveType[]): { headers: string[]; rows: string[][] } {
  const types = leaveTypes.filter((t) => t.display_name && t.paid !== false);
  const headers = ["Employee ID", "Name", ...types.map((t) => t.display_name!), ...types.filter((t) => t.encashable).map((t) => `${t.display_name} encashed this year`)];
  const rows = employees
    .filter((e) => e.tracked_from)
    .map((e) => ({ e, name: `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ e, name }) => [e.employee_number || e.work_email || "", name, ...headers.slice(2).map(() => "")]);
  return { headers, rows };
}
