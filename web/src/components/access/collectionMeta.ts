// Human context for grantable resources - how access UI names each collection and what granting it MEANS.
// The engine treats every collection alike; this layer is presentation only, and it exists because the
// auto-derived nouns ("all export") answer none of the questions a grantor actually has: does this apply
// to every table or this one? why is there no narrower scope? An entry is needed only where the derived
// name is wrong (bonuses -> "bonuse") or where a `note` preempts a real ambiguity; everything else falls
// through to the kebab->words default.
export type CollectionMeta = {
  label: string; // display name ("Data export")
  singular: string; // "data export"
  plural: string; // "data exports"
  // The phrase for the org-wide scope tier - what "all" actually covers. Defaults to `all <plural>`.
  allPhrase?: string;
  // One- or two-sentence answer to "what does granting this do?", shown in the modal under the target.
  note?: string;
  // "virtual" = an app-wide capability, not a row collection; "settings" = config blobs. Drives the
  // single-scope explanation wording.
  kind?: "data" | "virtual" | "settings";
};

export const COLLECTION_META: Record<string, CollectionMeta> = {
  export: {
    label: "Data export",
    singular: "data export",
    plural: "data exports",
    kind: "virtual",
    allPhrase: "exporting from any table",
    note: "One app-wide switch for the Export button that appears on every table - it is not per-table. Holders can export any list they open, and an export only ever contains the rows and columns they can already read, so it never widens access.",
  },
  activity: {
    label: "Activity trail",
    singular: "activity trail",
    plural: "activity trails",
    kind: "virtual",
    allPhrase: "the activity of any record they can read",
    note: "Who may open the per-record activity feed (the clock icon on rows and profiles). It combines with record access: holders only ever see activity for records they can already read. Scope narrows whose records; the optional Field pins it to one record type.",
  },
  audit: {
    label: "Org-wide activity",
    singular: "audit trail",
    plural: "audit trails",
    kind: "virtual",
    allPhrase: "the org-wide audit trail",
    note: "The admin Activity page: every change, sensitive-data view, and denied attempt across the whole workspace, all record types at once.",
  },
  settings: {
    label: "Settings",
    singular: "settings section",
    plural: "settings sections",
    kind: "settings",
    note: "Org configuration. A rule on one section (this gear) governs exactly that section's editor; a collection-wide rule governs every settings screen at once.",
  },
  operations: {
    label: "Operations",
    singular: "operation",
    plural: "operations",
    note: "Maintenance and data jobs on the Operations screen. Read shows the catalog; the run method executes a job.",
  },
  "cron-runs": {
    label: "Scheduled runs",
    singular: "scheduled run",
    plural: "scheduled runs",
    note: "The history of scheduled background ticks. The run method fires a tick on demand.",
  },
  users: {
    label: "Users",
    singular: "user account",
    plural: "user accounts",
    note: "Sign-in accounts and their roles - not the employee HR records (those are Employees).",
  },
  bonuses: { label: "Bonuses", singular: "bonus", plural: "bonuses" },
  kudos: { label: "Kudos", singular: "kudos", plural: "kudos" },
  attendance: { label: "Attendance", singular: "attendance record", plural: "attendance records" },
  compensation: { label: "Compensation", singular: "compensation record", plural: "compensation records" },
  "leave-balances": {
    label: "Leave balances",
    singular: "leave balance",
    plural: "leave balances",
    note: "Balances are maintained by the system (accruals, approvals, encashments). Write allows manual adjustment.",
  },
  announcements: {
    label: "Announcements",
    singular: "announcement",
    plural: "announcements",
    note: "Board posts - plain announcements, kudos, and polls are all posts here; the custom methods cover the social actions (react, reply, vote, …).",
  },
  tickets: {
    label: "Tickets",
    singular: "ticket",
    plural: "tickets",
    note: "Helpdesk tickets. Each ticket action (start, resolve, comment, …) is managed from that action's own key icon rather than method chips here.",
  },
  payslips: {
    label: "Payslips",
    singular: "payslip",
    plural: "payslips",
    note: "Read covers seeing a payslip exists; the preview and download methods control actually opening or keeping a copy.",
  },
};

const titleCase = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());

export function metaFor(collection: string): CollectionMeta {
  const m = COLLECTION_META[collection];
  if (m) return m;
  const plural = collection.replace(/-/g, " ");
  return {
    label: titleCase(plural),
    singular: plural.endsWith("s") ? plural.slice(0, -1) : plural,
    plural,
    kind: "data",
  };
}
