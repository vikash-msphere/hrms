// Builder metadata (PURE - no I/O). The single payload the no-code Workflow builder reads to populate every
// dropdown: the event catalog (triggers + their fields), the resource catalog (collections + their standard
// operations + custom verbs, for the apiCall cascade), and the enum vocabularies (action kinds, condition ops,
// recipient kinds). Assembled from the existing sources of truth so the UI can never drift from the backend:
// EVENT_TYPES (events), the per-collection verb registry (passed in, from http/accessHint ACCESS_VERBS), and the
// automations domain enums. See docs/workflow-builder-ui-plan.md.
import { EVENT_TYPES, fieldsForEventType, type EventFieldType } from "./events";
import { ACTION_KINDS, COMPARE_OPS, RECIPIENT_KINDS } from "./automations";

// "leave-requests" -> "Leave requests" (label only; the wire name stays kebab).
const humanize = (kebab: string): string => kebab.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export type MetaEventField = { name: string; type: EventFieldType };
export type MetaEvent = { type: string; label: string; module: string; fields: MetaEventField[] };
export type MetaResource = { name: string; label: string; standard: string[]; verbs: string[] };
export type WorkflowMeta = {
  events: MetaEvent[];
  resources: MetaResource[];
  recipientKinds: readonly string[];
  actionKinds: readonly string[];
  conditionOps: readonly string[];
};

// The two level-ladder methods; everything else in a resource's verb list is a custom method.
const STANDARD = new Set(["update", "delete"]);

export function buildWorkflowMeta(accessVerbs: Record<string, string[]>): WorkflowMeta {
  const events: MetaEvent[] = EVENT_TYPES.map((e) => ({
    type: e.type,
    label: e.label,
    module: e.module,
    fields: fieldsForEventType(e.type).map((f) => ({ name: f.name, type: f.type })),
  }));

  const resources: MetaResource[] = Object.entries(accessVerbs)
    .map(([name, verbs]) => ({
      name,
      label: humanize(name),
      standard: verbs.filter((v) => STANDARD.has(v)),
      verbs: verbs.filter((v) => !STANDARD.has(v)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { events, resources, recipientKinds: RECIPIENT_KINDS, actionKinds: ACTION_KINDS, conditionOps: COMPARE_OPS };
}
