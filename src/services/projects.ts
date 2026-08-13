// Projects: what a timesheet entry is booked against. Flat reference; `billable` and `status` drive the
// timesheet + utilization views.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec } from "./crud";

export type ProjectInput = {
  name?: string;
  client?: string | null;
  code?: string | null;
  billable?: boolean;
  status?: "active" | "archived";
};

export const projectSpec: CrudSpec<ProjectInput> = {
  table: schema.projects,
  collection: "projects",
  auditName: "project",
  notFound: "project not found",
  // A picker reads alphabetically, not by when someone happened to create the project.
  sort: (a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.uuid.localeCompare(b.uuid),
  insert: (input) => {
    if (!input.name?.trim()) throw invalidArgument("name is required");
    return {
      name: input.name.trim(),
      client: input.client?.trim() || null,
      projectCode: input.code?.trim() || null,
      billable: input.billable ?? true,
      status: input.status === "archived" ? "archived" : "active",
    };
  },
  patch: (patch) => {
    const set: Record<string, unknown> = {};
    if (has(patch, "name")) {
      if (!patch.name?.trim()) throw invalidArgument("name is required");
      set.name = patch.name.trim();
    }
    if (has(patch, "client")) set.client = patch.client?.trim() || null;
    if (has(patch, "code")) set.projectCode = patch.code?.trim() || null;
    if (has(patch, "billable")) set.billable = !!patch.billable;
    if (has(patch, "status")) set.status = patch.status === "archived" ? "archived" : "active";
    return set;
  },
};

