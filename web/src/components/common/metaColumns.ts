import type { AepResource } from "@/api";
import { formatDate } from "@/lib/utils";
import type { Column } from "./DataTable";

// Created/Updated columns common to every resource. Hidden by default so they're
// available in the column selector (unchecked) without cluttering the table.
//
// Both filter as DATES - calendar windows rather than substring matching. "What changed this week", "what
// has been sitting here since last month" are the two questions every collection in the app gets asked, and
// they were unanswerable on a column whose filter matched "2026-09" against a formatted "19 Sep 2026".
export function metaColumns<T extends AepResource>(): Column<T>[] {
  return [
    {
      id: "created",
      header: "Created",
      defaultHidden: true,
      filter: "date",
      dateHint: "past",
      accessor: (r) => r.create_time ?? "",
      cell: (r) => (r.create_time ? formatDate(r.create_time) : "-"),
    },
    {
      id: "updated",
      header: "Updated",
      defaultHidden: true,
      filter: "date",
      dateHint: "past",
      accessor: (r) => r.update_time ?? "",
      cell: (r) => (r.update_time ? formatDate(r.update_time) : "-"),
    },
  ];
}
