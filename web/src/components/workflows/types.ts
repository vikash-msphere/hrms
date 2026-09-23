// Client mirror of the automation engine's rule shapes (src/domain/automations.ts). The builder edits these
// and serializes the exact JSON the API accepts, so the stepper is just a view over the same structure the
// "edit JSON" toggle shows. Kept in lockstep with the server by hand (the web bundle can't import from src/).

export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "exists" | "notExists";
export type Comparison = { field: string; op: CompareOp; value?: unknown };
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | Comparison;

export type RecipientSpec =
  | { of: "subject" | "actor" | "managerOf" | "ref"; field?: string }
  | { of: "address"; address: string };

// An email attachment: a stored document by templated wire path (e.g. "{{subject}}"), or a generated payroll
// bank-transfer file for a run + bank.
export type EmailAttachmentSpec =
  | { document: string; filename?: string }
  | { bankFile: { run: string; bank: string }; filename?: string };

export type WaitArm =
  | { event: string; match?: string; then: Action[] }
  | { timer: { days?: number; hours?: number }; then: Action[] };

export type Action =
  | { kind: "notify"; recipient: RecipientSpec; title: string; type?: string; body?: string; link?: string; action?: string }
  | { kind: "notifyManager"; noun: string; type?: string }
  | { kind: "notifyAudience"; audience: AudienceSpec; title: string; type?: string; body?: string; link?: string }
  | { kind: "apiCall"; method: string; path: string; body?: unknown; captureAs?: string }
  | { kind: "emitEvent"; type: string; payload?: Record<string, unknown> }
  | { kind: "wait"; delayDays?: number; delayHours?: number; then: Action[] }
  | { kind: "waitFor"; on: WaitArm[] }
  | { kind: "webhook"; url: string; includeFields?: string[] }
  | { kind: "email"; to: RecipientSpec; subject: string; html: string; attachments?: EmailAttachmentSpec[] }
  | { kind: "emailAudience"; audience: AudienceSpec; subject: string; html: string };

// Mirrors AudienceSpec in src/domain/automations.ts. `capability` addresses a job rather than a list of
// people: the server resolves it to whoever currently holds that capability, every time the rule runs.
export type AudienceSpec =
  | { kind: "everyone" }
  | { kind: "department"; department: string }
  | { kind: "employees"; employees: string[] }
  | { kind: "capability"; capability: string };

// Recurrence for a time-driven rule (trigger_type === SCHEDULE_TRIGGER). Mirrors src/domain/automations.ts.
export type ScheduleFreq = "daily" | "weekly" | "monthly";
export type ScheduleScope = "once" | "perEmployee";
export type Schedule = { freq: ScheduleFreq; day?: number; scope?: ScheduleScope };
export const SCHEDULE_TRIGGER = "schedule.recurring";

export type AutomationDraft = {
  name: string;
  description?: string;
  trigger_type: string;
  condition: Condition | null;
  actions: Action[];
  enabled?: boolean;
  schedule?: Schedule | null;
};

// ---- /v1/workflow-meta payload ----
export type MetaEventField = { name: string; type: "string" | "number" | "boolean" | "date" | "ref" };
export type MetaEvent = { type: string; label: string; module: string; fields: MetaEventField[] };
export type MetaResource = { name: string; label: string; standard: string[]; verbs: string[] };
export type WorkflowMeta = {
  events: MetaEvent[];
  resources: MetaResource[];
  recipientKinds: string[];
  actionKinds: string[];
  conditionOps: CompareOp[];
};

// A variable offered by the variable picker at a given step: a human label + the `{{token}}` it inserts.
export type Variable = { label: string; token: string; group: string };

export const isComparison = (c: Condition): c is Comparison => typeof (c as Comparison).field === "string";
