import { gte, lte, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// A `?from=&to=` list window for the dated request collections (leave, remote work). OVERLAP, not containment:
// a request crossing the window's edge is part of that window's answer, which is what a calendar month means.
// Narrowing at the DB is the point - a client filtering cached rows can only ever window the 100 rows a page
// returned, so anything past that silently vanishes from the view.

const dayMs = (s?: string) => (s ? Date.parse(s.slice(0, 10) + "T00:00:00Z") : NaN);

export function dateWindow(startCol: AnySQLiteColumn, endCol: AnySQLiteColumn, fromYmd?: string, toYmd?: string): SQL[] {
  const conds: SQL[] = [];
  const from = dayMs(fromYmd);
  const to = dayMs(toYmd);
  // An unparseable bound is ignored rather than fatal: a filter is a narrowing, and a broken one narrows nothing.
  if (!Number.isNaN(to)) conds.push(lte(startCol, new Date(to)) as SQL);
  if (!Number.isNaN(from)) conds.push(gte(endCol, new Date(from)) as SQL);
  return conds;
}
