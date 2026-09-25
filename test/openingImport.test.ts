import { describe, it, expect } from "vitest";
import {
  historyItems, openingItems, openingTemplate, parseAmount, parseDate, parseDays, parseLeaveHistory, parseMonth, parseOpenings, parsePayOpenings,
  payOpeningItems, payOpeningTemplate, splitRow,
  type ImportEmployee, type ImportLeaveType,
} from "../web/src/lib/openingImport";

// Reading the old system's leave balances out of a sheet (the Opening balances page). The server previews and
// validates everything again; what is pinned here is the part only the browser does - which row is which
// person, which column is which leave type, and that a cell it cannot read is SAID rather than skipped.

const EMP: ImportEmployee[] = [
  { path: "employees/a", employee_number: "EMP-0001", work_email: "asha@x.test", first_name: "Asha", last_name: "Rao", tracked_from: "2026-09-24" },
  { path: "employees/b", employee_number: "EMP-0002", work_email: "bilal@x.test", first_name: "Bilal", last_name: "Khan", tracked_from: "2026-09-24" },
  { path: "employees/c", employee_number: "EMP-0003", work_email: "chen@x.test", first_name: "Chen", last_name: "Li", tracked_from: null },
];
const TYPES: ImportLeaveType[] = [
  { path: "leave-types/el", display_name: "Earned Leave", encashable: true },
  { path: "leave-types/sl", display_name: "Sick Leave", encashable: false },
  { path: "leave-types/lop", display_name: "Loss of Pay", paid: false },
];

describe("reading a sheet of opening balances", () => {
  it("matches people by employee ID or email and types by name, from a spreadsheet paste", () => {
    const paste = [
      "Employee ID\tName\tEarned Leave\tSick Leave\tEarned Leave encashed this year",
      "EMP-0001\tAsha Rao\t12.5\t4\t2",
      "bilal@x.test\tBilal Khan\t8\t\t",
    ].join("\n");
    const parsed = parseOpenings(paste, EMP, TYPES);
    expect(parsed.error).toBeUndefined();
    expect(parsed.lines[0]).toMatchObject({ employee: "employees/a", name: "Asha Rao", errors: [] });
    expect(parsed.lines[0]!.cells).toEqual([
      { leaveType: "leave-types/el", column: "Earned Leave", opening_days: 12.5, encashed_days: 2 },
      { leaveType: "leave-types/sl", column: "Sick Leave", opening_days: 4, encashed_days: null },
    ]);
    // A blank cell is "leave it as HRMS has it", not a zero.
    expect(parsed.lines[1]!.cells).toEqual([{ leaveType: "leave-types/el", column: "Earned Leave", opening_days: 8, encashed_days: null }]);
    expect(openingItems(parsed)).toEqual([
      { employee: "employees/a", leave_type: "leave-types/el", opening_days: 12.5, encashed_days: 2 },
      { employee: "employees/a", leave_type: "leave-types/sl", opening_days: 4, encashed_days: null },
      { employee: "employees/b", leave_type: "leave-types/el", opening_days: 8, encashed_days: null },
    ]);
  });

  it("reads a CSV, quoted commas included", () => {
    expect(splitRow('EMP-0001,"Rao, Asha",12')).toEqual(["EMP-0001", "Rao, Asha", "12"]);
    expect(splitRow('x,"say ""hi""",1')).toEqual(["x", 'say "hi"', "1"]);
    const parsed = parseOpenings('Employee ID,Name,Earned Leave\nEMP-0002,"Khan, Bilal",3', EMP, TYPES);
    expect(openingItems(parsed)).toEqual([{ employee: "employees/b", leave_type: "leave-types/el", opening_days: 3, encashed_days: null }]);
  });

  it("says what it could not read instead of skipping it", () => {
    const parsed = parseOpenings(
      ["Employee ID\tEarned Leave\tCasual Leav", "EMP-9999\t3\t1", "EMP-0001\tten\t1", "EMP-0003\t5\t1", "EMP-0002\t1\t1", "EMP-0002\t2\t1"].join("\n"),
      EMP,
      TYPES,
    );
    expect(parsed.unknownColumns).toEqual(["Casual Leav"]);
    expect(parsed.lines[0]!.errors[0]).toMatch(/No employee has the ID or work email "EMP-9999"/);
    expect(parsed.lines[1]!.errors[0]).toMatch(/not a number/);
    expect(parsed.lines[2]!.errors[0]).toMatch(/HRMS records start is not set/);
    expect(parsed.lines[3]!.errors).toEqual([]);
    expect(parsed.lines[4]!.errors[0]).toMatch(/earlier line/);
    // Only the clean line becomes an item.
    expect(openingItems(parsed)).toEqual([{ employee: "employees/b", leave_type: "leave-types/el", opening_days: 1, encashed_days: null }]);
  });

  it("refuses a sheet whose header names no leave type", () => {
    expect(parseOpenings("Employee ID\tAnnual\nEMP-0001\t3", EMP, TYPES).error).toMatch(/No column is named after a leave type/);
    expect(parseOpenings("", EMP, TYPES).error).toMatch(/header row first/);
  });

  it("reads day counts the way a sheet writes them", () => {
    expect(parseDays("12")).toBe(12);
    expect(parseDays("12,5")).toBe(12.5);
    expect(parseDays(" ")).toBeNull();
    expect(parseDays("-")).toBeNull();
    expect(parseDays("-2")).toBe("invalid");
    expect(parseDays("x")).toBe("invalid");
  });
});

describe("the sheet to fill in", () => {
  it("lists everybody whose records start after they joined, a column per paid type, and encashed columns for encashable ones", () => {
    const t = openingTemplate(EMP, TYPES);
    expect(t.headers).toEqual(["Employee ID", "Name", "Earned Leave", "Sick Leave", "Earned Leave encashed this year"]);
    expect(t.rows).toEqual([
      ["EMP-0001", "Asha Rao", "", "", ""],
      ["EMP-0002", "Bilal Khan", "", "", ""],
    ]);
    // And it reads straight back in.
    const filled = [t.headers.join("\t"), ["EMP-0001", "Asha Rao", "5", "2", "1"].join("\t")].join("\n");
    expect(openingItems(parseOpenings(filled, EMP, TYPES))).toEqual([
      { employee: "employees/a", leave_type: "leave-types/el", opening_days: 5, encashed_days: 1 },
      { employee: "employees/a", leave_type: "leave-types/sl", opening_days: 2, encashed_days: null },
    ]);
  });
});

describe("reading a sheet of pay and tax so far", () => {
  it("reads the figures by column name, in the shapes a sheet writes them", () => {
    const paste = [
      "Employee ID\tName\tPaid through\tGross\tTaxable gross\tTDS\tPT\tESI contributing",
      "EMP-0001\tAsha Rao\tAug 2026\t5,00,000\t4,80,000.50\t20000\t1000\tyes",
      "bilal@x.test\tBilal Khan\t2026-08\t300000\t\t\t\t",
      "EMP-0003\tChen Li\tsoon\t1\t1\t1\t1\tmaybe",
      "EMP-9999\tNobody\t2026-08\t1",
    ].join("\n");
    const parsed = parsePayOpenings(paste, EMP, "2026-27");
    expect(parsed.error).toBeUndefined();
    expect(payOpeningItems(parsed)).toEqual([
      { employee: "employees/a", financial_year: "2026-27", paid_through: "2026-08", gross: 500000, taxable_gross: 480000.5, tds: 20000, pt: 1000, esi_contributing: true },
      // A blank taxable gross is the gross; blank amounts are zero.
      { employee: "employees/b", financial_year: "2026-27", paid_through: "2026-08", gross: 300000, taxable_gross: 300000, tds: 0, pt: 0, esi_contributing: false },
    ]);
    expect(parsed.lines[2]!.errors.join(" ")).toMatch(/Paid through.*ESI contributing/);
    expect(parsed.lines[3]!.errors[0]).toMatch(/No employee/);
  });

  it("needs a paid-through and a gross column", () => {
    expect(parsePayOpenings("Employee ID\tTDS\nEMP-0001\t1", EMP, "2026-27").error).toMatch(/Paid through/);
  });

  it("reads months and amounts", () => {
    expect(["2026-8", "08/2026", "August 2026", "aug-2026"].map(parseMonth)).toEqual(["2026-08", "2026-08", "2026-08", "2026-08"]);
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseAmount("₹ 1,23,456.789")).toBe(123456.79);
    expect(parseAmount("-")).toBe(0);
    expect(parseAmount("-5")).toBe("invalid");
  });

  it("lists the people whose records start after they joined, figures blank (pay)", () => {
    const t = payOpeningTemplate(EMP);
    expect(t.headers.slice(0, 3)).toEqual(["Employee ID", "Name", "Paid through"]);
    expect(t.rows.map((r) => r[0])).toEqual(["EMP-0001", "EMP-0002"]);
    expect(t.rows[0]!.slice(2).every((c) => c === "")).toBe(true);
  });
});

describe("reading a sheet of leave taken before HRMS", () => {
  it("reads one leave per line, dates day first, days and half days optional", () => {
    const paste = [
      "Employee ID\tName\tLeave type\tFrom\tTo\tDays\tStart session\tEnd session\tReason",
      "EMP-0001\tAsha Rao\tEarned Leave\t02/03/2026\t06/03/2026\t5\t\t\tHoliday",
      "EMP-0001\tAsha Rao\tsick leave\t2026-04-10\t2026-04-10\t\tPM\t",
      "EMP-0002\tBilal Khan\tCasual\t31/02/2026\t01/03/2026\tx\tnoon",
    ].join("\n");
    const parsed = parseLeaveHistory(paste, EMP, TYPES);
    expect(parsed.error).toBeUndefined();
    expect(historyItems(parsed)).toEqual([
      { employee: "employees/a", leave_type: "leave-types/el", start_date: "2026-03-02", end_date: "2026-03-06", days: 5, reason: "Holiday" },
      { employee: "employees/a", leave_type: "leave-types/sl", start_date: "2026-04-10", end_date: "2026-04-10", start_session: 2, days: null },
    ]);
    const bad = parsed.lines[2]!.errors.join(" ");
    expect(bad).toMatch(/"Casual" is not a leave type/);
    expect(bad).toMatch(/"From" is not a date/);
    expect(bad).toMatch(/"Days" is not a number/);
    expect(bad).toMatch(/AM or PM/);
  });

  it("needs the type and both dates", () => {
    expect(parseLeaveHistory("Employee ID\tFrom\tTo\nEMP-0001\t2026-01-01\t2026-01-02", EMP, TYPES).error).toMatch(/Leave type/);
  });

  it("reads dates the ways a sheet writes them, and refuses ones that are not days", () => {
    expect(["2026-03-02", "02/03/2026", "2-3-2026", "2.3.2026", "2 Mar 2026", "02-march-2026"].map(parseDate)).toEqual(Array(6).fill("2026-03-02"));
    expect(parseDate("30/02/2026")).toBeNull();
    expect(parseDate("March 2026")).toBeNull();
  });
});
