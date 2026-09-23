// "Whose rows am I looking at" - the identity presets a table offers, built once so four pages cannot write
// four different "Mine".
//
// A scope is nothing but a named set of COLUMN FILTERS (see DataTable's `scopes` prop). That is deliberate:
// it means a scope deep-links, saves into a view, shows up in the filter-chip row and narrows to exactly what
// its chip counted, all without a second filtering mechanism to keep in step with the first.
//
// IDENTITY IS DECIDED ON IDS, MATCHED ON A FIXED WORD. A filter runs over what a column RENDERS, so a scope
// built on a person's name would compare against a directory that loads a moment after the page - the chip
// then reads as "off" for that moment, and reads as off for good if two people share a name or one of them is
// renamed. So the page adds a hidden flag column whose accessor answers "is this mine?" from ids it already
// holds, and the scope filters on the one fixed word that column writes.
//
// THE CLIENT HOLDS NO POLICY (lib/perm.ts says it for access; the same applies here). Nothing here works out
// who somebody is or what they may see - the caller passes the predicate it already has, and a scope it
// cannot build is a scope it does not offer.
import type { ReactNode } from "react";
import { BLANK } from "./tableFilter";
import type { Column, TableScope } from "@/components/common/DataTable";

/** What a flag column writes for a row that is the reader's. The scope filters on exactly this. */
export const MINE = "Mine";

/**
 * The hidden column a "mine" scope filters on: one word when the row is the reader's, empty when it is not.
 *
 * A real column rather than a hidden mode, so it sorts, exports and can be shown - and so the chip above the
 * table narrows by something the reader can see the definition of.
 */
export function mineColumn<T>(id: string, header: string, isMine: (row: T) => boolean): Column<T> {
  return { id, header, filter: "select", defaultHidden: true, sortable: false, accessor: (r) => (isMine(r) ? MINE : "") };
}

/**
 * The unnarrowed table. Always last, and always present where the others are: a scope row with no way back to
 * everything is a filter people get stuck in.
 */
export const allScope = (label = "All", count?: number): TableScope => ({ id: "all", label, filters: {}, count });

/**
 * Rows a `mineColumn` flagged as the reader's. `null` when the caller has nobody to be (an account with no
 * employee record), so the chip is absent rather than matching everybody or nobody.
 */
export function mineScope(id: string, label: string, flagColumnId: string, enabled: boolean, opts?: { count?: number; badge?: ReactNode; title?: string; onSelect?: () => void }): TableScope | null {
  if (!enabled) return null;
  return { id, label, filters: { [flagColumnId]: MINE }, ...opts };
}

/** Rows where a person column is empty - the queue nobody owns, which is the one that goes missing. */
export const unassignedScope = (id: string, label: string, columnId: string, opts?: { count?: number; title?: string }): TableScope => ({
  id,
  label,
  filters: { [columnId]: BLANK },
  ...opts,
});

/**
 * Rows matching one named value of a column - a category, a queue, a column's own word for "nobody".
 *
 * Takes a value rather than a list because a filter value is one string: where "whose" is several people or
 * several categories, the page owes the table a flag column that says it in one word (`mineColumn` is that
 * shape). `null` when there is nothing to name.
 */
export function valueScope(id: string, label: string, columnId: string, value: string | undefined, opts?: { count?: number; badge?: ReactNode; title?: string }): TableScope | null {
  if (!value) return null;
  return { id, label, filters: { [columnId]: value }, ...opts };
}

/** Drop the scopes a page could not build, keeping the order it wrote them in. */
export const scopesOf = (...scopes: (TableScope | null | undefined)[]): TableScope[] => scopes.filter((s): s is TableScope => !!s);
