import type { AepResource } from "@/api";
import { formatDate } from "@/lib/utils";
import type { Column } from "./DataTable";

// Created/Updated columns common to every resource. Hidden by default so they're
// available in the column selector (unchecked) without cluttering the table.
export function metaColumns<T extends AepResource>(): Column<T>[] {
  return [
    {
      id: "created",
      header: "Created",
      defaultHidden: true,
      filter: "none",
      accessor: (r) => r.create_time ?? "",
      cell: (r) => (r.create_time ? formatDate(r.create_time) : "-"),
    },
    {
      id: "updated",
      header: "Updated",
      defaultHidden: true,
      filter: "none",
      accessor: (r) => r.update_time ?? "",
      cell: (r) => (r.update_time ? formatDate(r.update_time) : "-"),
    },
  ];
}
