import { useEffect, useState } from "react";
import { get } from "@/api";
import type { WorkflowMeta } from "./types";

// Fetch the builder metadata once and cache it module-wide (it changes only on a deploy). Every dropdown in the
// builder reads from this, so the UI never drifts from the backend's event/resource/verb catalog.
let cached: WorkflowMeta | null = null;
let inflight: Promise<WorkflowMeta> | null = null;

export function useWorkflowMeta(): { meta: WorkflowMeta | null; error: string | null } {
  const [meta, setMeta] = useState<WorkflowMeta | null>(cached);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cached) { setMeta(cached); return; }
    inflight ??= get<WorkflowMeta>("workflow-meta").then((m) => (cached = m));
    inflight.then(setMeta).catch((e) => setError(String((e as Error).message)));
  }, []);
  return { meta, error };
}

// Variables available to a step: the trigger event's fields + the common context fields + every prior action's
// captured output (captureAs). Nested arms also expose `resumeEvent`. Powers the variable picker.
export function variablesFor(meta: WorkflowMeta | null, triggerType: string, priorCaptures: string[], inArm = false): import("./types").Variable[] {
  const out: import("./types").Variable[] = [
    { label: "This employee", token: "{{employeeId}}", group: "Trigger" },
    { label: "This record (subject)", token: "{{subject}}", group: "Trigger" },
    { label: "Who triggered it (actor)", token: "{{actorId}}", group: "Trigger" },
    // Execution-time clock (set by the engine when the step runs), for date fields like award/effective dates.
    { label: "Today (YYYY-MM-DD)", token: "{{today}}", group: "Context" },
    { label: "Now (timestamp)", token: "{{now}}", group: "Context" },
  ];
  const ev = meta?.events.find((e) => e.type === triggerType);
  for (const f of ev?.fields ?? []) if (!["employeeId", "actorId", "subject"].includes(f.name)) out.push({ label: f.name, token: `{{${f.name}}}`, group: "Trigger fields" });
  for (const c of priorCaptures) {
    out.push({ label: `${c} (result)`, token: `{{results.${c}}}`, group: "Earlier steps" });
    out.push({ label: `${c}.path`, token: `{{results.${c}.path}}`, group: "Earlier steps" });
  }
  if (inArm) out.push({ label: "The awaited event", token: "{{results.resumeEvent}}", group: "Resumed" });
  return out;
}
