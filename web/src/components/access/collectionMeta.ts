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
    note: "The Export button that appears on every table. Leave the collection blank to allow exporting from any table, or name one to allow just that table's data - so \"may export leave data\" can be granted without also meaning payroll. An export only ever contains the rows and columns the holder can already read, so it never widens access. Custom grids draw from several collections at once and need the any-table grant.",
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
  unmask: {
    label: "Unmasked values",
    singular: "unmasked value",
    plural: "unmasked values",
    kind: "virtual",
    allPhrase: "the real value behind any masked field",
    note: "Whether a custom grid serves the REAL PAN / account number instead of the masked form the profile shows. Leave the field blank to unmask everything, or name one (bank-account.account_number, identity.uan) to unmask just that - so payroll can read account numbers for a bank file without also reading everyone's statutory ids. It grants no access of its own: the per-field read on that employee's identity or bank details is still required.",
  },
  timeline: {
    label: "Team timeline",
    singular: "team timeline",
    plural: "team timelines",
    kind: "virtual",
    allPhrase: "the dashboard team timeline",
    note: "Who sees the team timeline widget on the dashboard. The rows inside it are still filtered by the viewer's access to each underlying record, so this only decides whether the widget appears at all.",
  },
  "tax-verifications": {
    label: "Tax verification queue",
    singular: "tax verification queue",
    plural: "tax verification queues",
    kind: "virtual",
    allPhrase: "the whole prior-employer verification queue",
    note: "The payroll queue of prior-employer tax declarations awaiting verification. It exposes declared prior salary for everyone in the queue, so it is sensitive on its own; the verify and reject actions ride the separate write on an employee's tax details.",
  },
  "access-rules": {
    label: "Access rules",
    singular: "access rule",
    plural: "access rules",
    allPhrase: "every access rule in the workspace",
    note: "Managing access itself. Write lets the holder grant and revoke anyone's permissions, including their own, so it is effectively the keys to the workspace. The preview, clone, approve and reject methods are separately grantable.",
  },
  roles: {
    label: "Roles",
    singular: "role",
    plural: "roles",
    note: "The role catalog - adding or removing the named roles users can hold. It does not grant the roles any authority; that is Access rules.",
  },
  policy: {
    label: "Policy manifest",
    singular: "policy manifest",
    plural: "policy manifests",
    note: "The global manifest: which fields are protected, which body references are checked, and which scope tiers each resource offers. Editing it changes how every access decision in the app is made.",
  },
  "api-keys": {
    label: "API keys",
    singular: "API key",
    plural: "API keys",
    note: "Machine credentials. A key acts AS the person who owns it and can only ever do less than they can, but minting one hands out long-lived access, so write here is a credential-issuing power.",
  },
  notifications: {
    label: "Notifications",
    singular: "notification",
    plural: "notifications",
    allPhrase: "everyone's notifications",
    note: "In-app notification rows. Own-only is the normal grant - a broader one exposes what other people are being told about.",
  },
  "table-views": {
    label: "Saved grids",
    singular: "saved grid",
    plural: "saved grids",
    note: "Saved definitions for the custom grid builder. Running a grid reads every source through the RUNNER's own access, so sharing one never carries the author's access with it.",
  },
  "payroll-debit-accounts": {
    label: "Debit accounts",
    singular: "debit account",
    plural: "debit accounts",
    note: "The employer bank accounts salary files are drawn on. Separate from Bank formats (the file layout) because the account numbers themselves are the sensitive half.",
  },
  positions: {
    label: "Positions",
    singular: "position",
    plural: "positions",
    note: "An employee's job title / grade history. Distinct from Compensation, which is the money on the same timeline.",
  },
  settlements: {
    label: "Full & final settlements",
    singular: "settlement",
    plural: "settlements",
    note: "A leaver's terminal payout. Each row carries their final salary, recoveries and dues, so it is as sensitive as a payslip.",
  },
  "goal-templates": {
    label: "Goal templates",
    singular: "goal template",
    plural: "goal templates",
    note: "Reusable goal blueprints. Read lets someone apply a template; write lets them author the catalogue.",
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
  attendance: { label: "Attendance", singular: "attendance record", plural: "attendance records" },
  "attendance-day-marks": {
    label: "Day marks",
    singular: "day mark",
    plural: "day marks",
    note: "What one person's day COUNTS AS - a full day, half a day, or absent - decided by HR instead of derived from their punches. A mark changes what the payroll run treats as unpaid absence, so write is a pay decision: the seeded grants give managers read (they see why a report's short day was counted the way it was) and leave the writing with HR. Self-scoped read is the employee's own: they are the person the decision is about.",
  },
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
  stocktakes: {
    label: "Stocktakes",
    singular: "stocktake",
    plural: "stocktakes",
    note: "Inventory counts run from the Assets page. Write starts and annotates a count; the close method freezes its result and raises the chase-up notices. Recording the sightings themselves is the assets verify method, not this one.",
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
