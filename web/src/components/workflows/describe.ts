// Turn a rule's raw trigger + action JSON into human sentences for the Workflows list. PURE (no React), so it
// reads the same way in a pill, a tooltip, or a test. The builder stores technical shapes (event ids like
// "employee.created", actions like { kind:"apiCall", method:"POST", path:"/v1/tickets" }); nobody scanning the
// list should have to decode those.
import { humanize } from "@/lib/utils";
import type { MetaEvent } from "./types";

export type Step = { kind: string; label: string };

// Naive singularizer for a collection token: tickets->ticket, bonuses->bonus, requisitions->requisition.
//
// One branch, not three replaces in sequence: chained, the `ses$` rule's output fed straight into the `s$`
// rule, which ate the `s` it had just produced - so `expenses` became "expen" and `bonuses` became "bonu",
// both of them real collections (src/domain/collections.ts). A label that is a truncated word is worse than
// the raw path, because it reads as a different collection.
const singular = (s: string) =>
  /ies$/.test(s) ? s.replace(/ies$/, "y")
  : /ses$/.test(s) ? s.replace(/es$/, "")
  : s.replace(/s$/, "");
const isTemplate = (s: string) => /\{\{/.test(s);
// camelCase verb -> spaced words so humanize can title-case it (enrollDefaultBenefits -> "Enroll Default Benefits").
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
// A dotted event id -> a lowercase phrase ("leave.approved" -> "leave approved").
const prettyEvent = (type: string) => humanize(String(type).replace(/\./g, " ")).toLowerCase();

function recipientLabel(r: { of?: string } | undefined): string {
  switch (r?.of) {
    case "subject": return "the employee";
    case "actor": return "whoever triggered it";
    case "managerOf": return "their manager";
    case "ref": return "a linked person";
    case "address": return "an address";
    default: return "someone";
  }
}

function audienceLabel(a: { kind?: string } | undefined): string {
  switch (a?.kind) {
    case "everyone": return "Announce to everyone";
    case "department": return "Notify a department";
    case "employees": return "Notify selected people";
    case "capability": return "Notify whoever holds an access right";
    default: return "Broadcast a notice";
  }
}

function delayLabel(a: { delayDays?: number; delayHours?: number }): string {
  const d = Number(a?.delayDays ?? 0);
  const h = Number(a?.delayHours ?? 0);
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  return parts.join(" ") || "a while";
}

function armsLabel(on: unknown): string {
  if (!Array.isArray(on)) return "a response";
  const events = on.filter((x) => x && typeof x === "object" && "event" in x).map((x) => prettyEvent((x as { event: string }).event));
  const hasTimer = on.some((x) => x && typeof x === "object" && "timer" in x);
  const bits = [...events];
  if (hasTimer) bits.push("a timeout");
  return bits.join(" or ") || "a response";
}

function apiCallLabel(a: { method?: string; path?: string }): string {
  const rest = String(a?.path ?? "").replace(/^\/v1\//, "").split("?")[0]!;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const verb = words(rest.slice(colon + 1));
    const coll = rest.slice(0, colon).split("/")[0] ?? "";
    return isTemplate(coll) ? humanize(verb) : `${humanize(verb)} ${humanize(singular(coll)).toLowerCase()}`;
  }
  const coll = rest.split("/")[0] ?? "";
  const m = String(a?.method ?? "GET").toUpperCase();
  const verb = m === "POST" ? "Create" : m === "PATCH" || m === "PUT" ? "Update" : m === "DELETE" ? "Delete" : "Fetch";
  return isTemplate(coll) ? `${verb} a record` : `${verb} ${humanize(singular(coll)).toLowerCase()}`;
}

// A single action -> { kind (for its icon), label (the sentence) }.
export function describeAction(a: unknown): Step {
  const act = (a ?? {}) as Record<string, unknown>;
  const kind = String(act.kind ?? "step");
  switch (kind) {
    case "notify": return { kind, label: `Notify ${recipientLabel(act.recipient as { of?: string })}` };
    case "notifyManager": return { kind, label: "Notify their manager" };
    case "notifyAudience": return { kind, label: audienceLabel(act.audience as { kind?: string }) };
    case "emitEvent": return { kind, label: `Trigger ${prettyEvent(String(act.type ?? ""))}` };
    case "wait": return { kind, label: `Wait ${delayLabel(act as { delayDays?: number; delayHours?: number })}` };
    case "waitFor": return { kind, label: `Wait for ${armsLabel(act.on)}` };
    case "webhook": return { kind, label: "Call a webhook" };
    case "email": return { kind, label: `Email ${recipientLabel(act.to as { of?: string })}` };
    case "emailAudience": return { kind, label: `Email ${audienceLabel(act.audience as { kind?: string }).replace(/^(Announce to|Notify)/, "").trim() || "an audience"}` };
    case "apiCall": return { kind, label: apiCallLabel(act as { method?: string; path?: string }) };
    default: return { kind, label: humanize(kind) };
  }
}

export function describeActions(actions: unknown): Step[] {
  return Array.isArray(actions) ? actions.map(describeAction) : [];
}

// The trigger's human label + owning module, from the workflow-meta event catalog (falls back to the id).
export function triggerInfo(events: MetaEvent[] | undefined, type: string): { label: string; module: string } {
  const ev = events?.find((e) => e.type === type);
  const head = type.split(".")[0] ?? "";
  return { label: ev?.label ?? humanize(type.replace(/\./g, " ")), module: ev?.module ?? (head ? humanize(head) : "Other") };
}
