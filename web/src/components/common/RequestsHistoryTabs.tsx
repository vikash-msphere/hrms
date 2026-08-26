import * as React from "react";
import { idOf } from "@/lib/utils";
import { useCollection, type LoadState } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { DataState } from "@/components/common/DataState";
import { AccessTab } from "@/components/common/AccessTab";
import { useRoutedTabs, TabBadge } from "@/lib/routedTabs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";

const upper = (s?: string) => (s ?? "").toUpperCase();

export type RequestsHistoryMode = "requests" | "history";

// An extra tab bolted onto the right of the standard Requests/History pair (e.g. Leaves' "Encashments").
// `accessTarget` makes it an AccessTab (the manage-permissions key sits on the tab); omit it for a plain tab.
export interface RequestsHistoryExtraTab {
  value: string;
  label: React.ReactNode;
  content: React.ReactNode;
  accessTarget?: AccessTargetRef;
  badge?: number;
}

interface Props<T extends { path: string }> {
  /** Wire collection these rows belong to (drives the Requests tab's access target). */
  collection: string;
  /**
   * The page/route key used for deep-linkable + notification-badged tabs (the first segment of a
   * notification `link`, e.g. "overtime" for the Overtime page). Defaults to `collection` - pass it
   * explicitly when the route key differs from the collection (overtime-requests -> "overtime").
   */
  pageKey?: string;
  rows: T[];
  state: LoadState;
  error?: string | null;
  reload: () => void;
  /** The caller's own employee id, to split their requests from everyone else's. */
  meEmployeeId?: string | null;
  /** True if the caller can decide (approve/reject) - they then see EVERY decided row in History, not just own. */
  canDecide: boolean;
  /** The owner reference on a row. Defaults to the standard `employee` field. */
  ownerRef?: (row: T) => string | undefined;
  /** Membership of the owner's "Requests" tab (live, still-actionable). Defaults to state === PENDING. */
  isLive?: (row: T) => boolean;
  /** Rows excluded from an approver's History (their decision still lives in the Approvals inbox). Defaults to `isLive`. */
  isPendingDecision?: (row: T) => boolean;
  /** Label for the Requests tab's access-management target. */
  accessLabel: string;
  /** Extra SERVER list filters (e.g. `{ leave_type }`) applied to the search read too, so searching inside a
   *  filtered view stays inside it instead of silently widening back to the whole collection. */
  listParams?: Record<string, string>;
  requestsLabel?: string;
  defaultTab?: string;
  extraTabs?: RequestsHistoryExtraTab[];
  /** Render the table (or any body) for a tab. `mode` lets the caller pick columns/empty copy per tab.
   *  `search` is the server-side search descriptor - forward it to DataTable's `search` prop so the box sits
   *  alongside the column filters and reaches records past the first page. */
  render: (items: T[], mode: RequestsHistoryMode, search: RequestsHistorySearch) => React.ReactNode;
}

// The shared "my requests vs. decided history" shell used by every approval-workflow page (leave, reimbursements,
// overtime, remote work). It owns the deep-linkable + notification-badged tabs, the own-active/decided partition,
// and the rule that an approver sees ALL decided rows in History while a plain employee sees only their own.
// Pending decisions are NOT shown here - they live in the unified Approvals inbox. The page supplies only the
// per-tab table via `render`, so columns and empty states stay page-specific.
export type RequestsHistorySearch = { value: string; onChange: (v: string) => void; placeholder?: string };

export function RequestsHistoryTabs<T extends { path: string }>({
  collection,
  pageKey,
  rows,
  state,
  error,
  reload,
  meEmployeeId,
  canDecide,
  ownerRef = (r) => (r as { employee?: string }).employee,
  isLive = (r) => upper((r as { state?: string }).state) === "PENDING",
  isPendingDecision,
  accessLabel,
  listParams,
  requestsLabel = "Requests",
  defaultTab = "requests",
  extraTabs = [],
  render,
}: Props<T>) {
  const pendingDecision = isPendingDecision ?? isLive;
  // Server-side search across the WHOLE collection. A list page caps at 100 rows, so filtering the cached
  // rows here would only ever search the slice already loaded; `?q=` pushes the match to the FTS index and
  // brings back rows this page never held. Below two characters it stays off and the ordinary rows are used.
  const [query, setQuery] = React.useState("");
  const debouncedQuery = useDebounced(query.trim(), 250);
  const searching = debouncedQuery.length >= 2;
  const { rows: searchRows } = useCollection<T>(collection, { q: debouncedQuery, params: listParams, enabled: searching });
  const source = searching ? searchRows : rows;
  const search: RequestsHistorySearch = { value: query, onChange: setQuery, placeholder: "Search all records…" };
  const tabKeys = React.useMemo(
    () => ["requests", "history", ...extraTabs.map((t) => t.value)],
    [extraTabs],
  );
  const tabs = useRoutedTabs(pageKey ?? collection, tabKeys, defaultTab);

  const isOwn = (r: T) => {
    const o = ownerRef(r);
    return !!(o && meEmployeeId && idOf(o) === meEmployeeId);
  };
  const myAll = source.filter(isOwn);
  const requests = myAll.filter(isLive);
  // Approvers see every decided row they can read (server-scoped: dept for a manager, all for HR); plain
  // employees see only their own settled rows - defence-in-depth on top of the server's list scoping.
  const history = canDecide ? source.filter((r) => !pendingDecision(r)) : myAll.filter((r) => !isLive(r));

  return (
    <DataState state={state} error={error} onRetry={reload}>
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList>
          {/* requests/history are scope filters of one collection (key on Requests); per-row keys live in the tables. */}
          <AccessTab value="requests" target={{ collection, label: accessLabel }}>
            {requestsLabel}{requests.length ? ` (${requests.length})` : ""}
          </AccessTab>
          <TabsTrigger value="history">History<TabBadge count={tabs.badge("history")} /></TabsTrigger>
          {extraTabs.map((t) =>
            t.accessTarget ? (
              <AccessTab key={t.value} value={t.value} target={t.accessTarget}>{t.label}</AccessTab>
            ) : (
              <TabsTrigger key={t.value} value={t.value}>{t.label}<TabBadge count={t.badge ?? 0} /></TabsTrigger>
            ),
          )}
        </TabsList>

        <TabsContent value="requests">{render(requests, "requests", search)}</TabsContent>
        <TabsContent value="history">{render(history, "history", search)}</TabsContent>
        {extraTabs.map((t) => (
          <TabsContent key={t.value} value={t.value}>{t.content}</TabsContent>
        ))}
      </Tabs>
    </DataState>
  );
}
