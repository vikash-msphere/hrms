import { useRef, useState, type ReactNode } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown, Bell, Clock, Hourglass, Zap, Globe, Boxes, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field } from "@/components/common/Field";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Department } from "@/types";
import { TemplatedInput } from "./TemplatedInput";
import type { Action, WaitArm, WorkflowMeta, Variable } from "./types";
import { variablesFor } from "./useWorkflowMeta";

// ---- Add-action intent menu (leads with WHAT you want to do, not HTTP) ----
const INTENTS: { kind: Action["kind"]; label: string; icon: typeof Bell; make: () => Action }[] = [
  { kind: "notify", label: "Notify someone", icon: Bell, make: () => ({ kind: "notify", recipient: { of: "subject" }, title: "" }) },
  { kind: "notifyManager", label: "Notify the manager", icon: Bell, make: () => ({ kind: "notifyManager", noun: "" }) },
  { kind: "notifyAudience", label: "Broadcast to an audience", icon: Bell, make: () => ({ kind: "notifyAudience", audience: { kind: "everyone" }, title: "" }) },
  { kind: "email", label: "Send an email", icon: Mail, make: () => ({ kind: "email", to: { of: "subject" }, subject: "", html: "" }) },
  { kind: "emailAudience", label: "Email an audience", icon: Mail, make: () => ({ kind: "emailAudience", audience: { kind: "everyone" }, subject: "", html: "" }) },
  { kind: "apiCall", label: "Create / update a record", icon: Boxes, make: () => ({ kind: "apiCall", method: "POST", path: "/v1/" }) },
  { kind: "waitFor", label: "Wait for an event", icon: Hourglass, make: () => ({ kind: "waitFor", on: [{ event: "", then: [] }] }) },
  { kind: "wait", label: "Wait a while", icon: Clock, make: () => ({ kind: "wait", delayDays: 1, then: [] }) },
  { kind: "emitEvent", label: "Emit an event", icon: Zap, make: () => ({ kind: "emitEvent", type: "" }) },
  { kind: "webhook", label: "Send a webhook", icon: Globe, make: () => ({ kind: "webhook", url: "" }) },
];

const LABEL: Record<Action["kind"], string> = {
  notify: "Notify", notifyManager: "Notify manager", notifyAudience: "Broadcast", apiCall: "API call",
  emitEvent: "Emit event", wait: "Wait", waitFor: "Wait for", webhook: "Webhook", email: "Email", emailAudience: "Email audience",
};

// The department a "broadcast to an audience" action targets. Stored as a `departments/<id>` ref, like every
// other resource reference on the wire, so the inbound edge decodes the wire token to the internal id before
// the engine resolves the audience - a raw id typed into a text box reached the engine still tokenised and
// matched nobody. Mounted only while the audience IS a department, so the list is fetched on demand.
function DepartmentPicker({ value, onChange }: { value: string; onChange: (ref: string) => void }) {
  const { rows } = useCollection<Department>("departments", { all: true });
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 flex-1" aria-label="Department"><SelectValue placeholder="Pick a department" /></SelectTrigger>
      <SelectContent>
        {rows.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// Captured names produced by the actions BEFORE index `i` (for the variable picker's "earlier steps").
function capturesBefore(actions: Action[], i: number): string[] {
  return actions.slice(0, i).flatMap((a) => (a.kind === "apiCall" && a.captureAs ? [a.captureAs] : []));
}

export function ActionList({ actions, onChange, meta, triggerType, inArm }: { actions: Action[]; onChange: (a: Action[]) => void; meta: WorkflowMeta | null; triggerType: string; inArm?: boolean }) {
  // A STABLE KEY PER ACTION, not the array index.
  //
  // Two of the editors below keep local state derived from the action they were opened on - the apiCall
  // editor's "create / act on a record / raw" mode, and RecordCall's chosen record type - and both are
  // deliberately seeded once rather than re-read, so that typing cannot swap the form out from under the
  // caret. With index keys, "the same slot" is not "the same action": delete step 1, or press Move up, and
  // step 2 renders into the surviving component and inherits step 1's mode, so a call authored as "Act on a
  // record" reopens in the Raw editor and is then edited through the wrong form.
  //
  // The ids ride ALONGSIDE the list through the same splice/swap the actions take, so a component follows its
  // action instead of following its position. `actions` is a controlled prop of plain JSON objects with no
  // identity of their own, which is why the ids live here and not on the data.
  const idsRef = useRef<number[]>([]);
  const nextId = useRef(0);
  const ids = idsRef.current;
  while (ids.length < actions.length) ids.push(nextId.current++);
  if (ids.length > actions.length) ids.length = actions.length;

  const set = (i: number, a: Action) => onChange(actions.map((x, j) => (j === i ? a : x)));
  const del = (i: number) => { ids.splice(i, 1); onChange(actions.filter((_, j) => j !== i)); };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= actions.length) return;
    const copy = [...actions];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    onChange(copy);
  };
  const add = (mk: () => Action) => onChange([...actions, mk()]);
  const hasTerminalWait = actions.some((a) => a.kind === "waitFor");

  return (
    <div className="space-y-2">
      {actions.map((a, i) => (
        <Card key={ids[i]} className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{i + 1}. {LABEL[a.kind]}</span>
            <div className="flex gap-0.5">
              <Button type="button" variant="ghost" size="icon" aria-label="Move this action earlier" onClick={() => move(i, -1)} disabled={i === 0}><ChevronUp className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Move this action later" onClick={() => move(i, 1)} disabled={i === actions.length - 1}><ChevronDown className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Remove this action" onClick={() => del(i)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
          <ActionEditor action={a} onChange={(x) => set(i, x)} meta={meta} triggerType={triggerType} vars={variablesFor(meta, triggerType, capturesBefore(actions, i), inArm)} />
        </Card>
      ))}
      {!hasTerminalWait && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm"><Plus className="mr-1 h-4 w-4" /> Add step</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {INTENTS.map((it) => (
              <DropdownMenuItem key={it.label} onClick={() => add(it.make)}><it.icon className="mr-2 h-4 w-4" /> {it.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {hasTerminalWait && <p className="text-xs text-muted-foreground">A "wait for" step ends the list - the continuation lives inside its branches.</p>}
    </div>
  );
}

function ActionEditor({ action, onChange, meta, triggerType, vars }: { action: Action; onChange: (a: Action) => void; meta: WorkflowMeta | null; triggerType: string; vars: Variable[] }) {
  const a = action;
  switch (a.kind) {
    case "notify":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">To</span>
            <Select value={a.recipient.of} onValueChange={(of) => onChange({ ...a, recipient: { of: of as never } })}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{(meta?.recipientKinds ?? []).map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
            </Select>
            {a.recipient.of === "ref" && <TemplatedInput value={a.recipient.field ?? ""} onChange={(field) => onChange({ ...a, recipient: { of: "ref", field } })} vars={vars} placeholder="employee ref field" />}
          </div>
          <Field label="Title"><TemplatedInput value={a.title} onChange={(title) => onChange({ ...a, title })} vars={vars} placeholder="Notification title" /></Field>
          <Field label="Body"><TemplatedInput value={a.body ?? ""} onChange={(body) => onChange({ ...a, body })} vars={vars} textarea placeholder="Optional body" /></Field>
          <Field label="Link"><Input value={a.link ?? ""} onChange={(e) => onChange({ ...a, link: e.target.value })} placeholder="e.g. leave-requests/history" /></Field>
        </div>
      );
    case "notifyManager":
      return <Field label="What is it about"><Input value={a.noun} onChange={(e) => onChange({ ...a, noun: e.target.value })} placeholder='e.g. "leave request to review"' /></Field>;
    case "notifyAudience":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Audience</span>
            <Select value={a.audience.kind} onValueChange={(k) => onChange({ ...a, audience: k === "department" ? { kind: "department", department: "" } : k === "employees" ? { kind: "employees", employees: [] } : { kind: "everyone" } })}>
              <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="everyone">Everyone</SelectItem><SelectItem value="department">A department</SelectItem><SelectItem value="employees">Specific employees</SelectItem></SelectContent>
            </Select>
            {a.audience.kind === "department" && <DepartmentPicker value={a.audience.department} onChange={(department) => onChange({ ...a, audience: { kind: "department", department } })} />}
          </div>
          {/* Placeholders, like the email twin below: two stacked templated inputs with nothing in them are
              told apart only by their labels, and a label alone is easy to miss at a glance. */}
          <Field label="Title"><TemplatedInput value={a.title} onChange={(title) => onChange({ ...a, title })} vars={vars} placeholder="Notification title" /></Field>
          <Field label="Body"><TemplatedInput value={a.body ?? ""} onChange={(body) => onChange({ ...a, body })} vars={vars} textarea placeholder="Notification body (optional)" /></Field>
        </div>
      );
    case "apiCall":
      return <ApiCallEditor action={a} onChange={onChange} meta={meta} vars={vars} />;
    case "emitEvent":
      return (
        <Field label="Event to emit">
          <Select value={a.type} onValueChange={(type) => onChange({ ...a, type })}>
            <SelectTrigger><SelectValue placeholder="pick an event" /></SelectTrigger>
            <SelectContent>{(meta?.events ?? []).map((e) => <SelectItem key={e.type} value={e.type}>{e.label} ({e.type})</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      );
    case "wait":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Wait</span>
            <Input type="number" className="h-9 w-20" value={a.delayDays ?? 0} onChange={(e) => onChange({ ...a, delayDays: Number(e.target.value) })} /> <span>days</span>
            <Input type="number" className="h-9 w-20" value={a.delayHours ?? 0} onChange={(e) => onChange({ ...a, delayHours: Number(e.target.value) })} /> <span>hours, then:</span>
          </div>
          <div className="ml-3 border-l pl-3">
            <ActionList actions={a.then} onChange={(then) => onChange({ ...a, then })} meta={meta} triggerType={triggerType} />
          </div>
        </div>
      );
    case "waitFor":
      return <WaitForEditor action={a} onChange={onChange} meta={meta} triggerType={triggerType} />;
    case "webhook":
      return (
        <div className="space-y-2">
          <Field label="URL"><Input value={a.url} onChange={(e) => onChange({ ...a, url: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Include fields (comma-separated; blank = whole payload)"><Input value={(a.includeFields ?? []).join(",")} onChange={(e) => onChange({ ...a, includeFields: e.target.value ? e.target.value.split(",").map((s) => s.trim()) : undefined })} /></Field>
        </div>
      );
    case "email":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">To</span>
            <Select value={a.to.of} onValueChange={(of) => onChange({ ...a, to: of === "address" ? { of: "address", address: "" } : { of: of as never } })}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(meta?.recipientKinds ?? []).map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                <SelectItem value="address">address</SelectItem>
              </SelectContent>
            </Select>
            {a.to.of === "ref" && <TemplatedInput value={a.to.field ?? ""} onChange={(field) => onChange({ ...a, to: { of: "ref", field } })} vars={vars} placeholder="employee ref field" />}
            {a.to.of === "address" && <TemplatedInput value={a.to.address} onChange={(address) => onChange({ ...a, to: { of: "address", address } })} vars={vars} placeholder="finance@company.com" />}
          </div>
          <Field label="Subject"><TemplatedInput value={a.subject} onChange={(subject) => onChange({ ...a, subject })} vars={vars} placeholder="Email subject" /></Field>
          <Field label="Body (HTML)"><TemplatedInput value={a.html} onChange={(html) => onChange({ ...a, html })} vars={vars} textarea placeholder="<p>…</p>" /></Field>
          <Field label="Attachments (a stored document like {{subject}} for a payslip, or a payroll bank file)">
            <div className="space-y-1.5">
              {(a.attachments ?? []).map((att, i) => {
                const isBank = "bankFile" in att;
                const setAtt = (next: typeof att) => onChange({ ...a, attachments: (a.attachments ?? []).map((x, j) => (j === i ? next : x)) });
                return (
                  <div key={i} className="space-y-1.5 rounded-md border p-2">
                    <div className="editor-row gap-1.5">
                      <Select value={isBank ? "bankFile" : "document"} onValueChange={(t) => setAtt(t === "bankFile" ? { bankFile: { run: "{{subject}}", bank: "" }, filename: att.filename } : { document: "{{subject}}", filename: att.filename })}>
                        <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="document">Stored document</SelectItem><SelectItem value="bankFile">Payroll bank file</SelectItem></SelectContent>
                      </Select>
                      <Input className="editor-row-main h-9" value={att.filename ?? ""} onChange={(e) => setAtt({ ...att, filename: e.target.value || undefined })} placeholder="filename (optional)" />
                      <Button type="button" variant="ghost" size="icon" aria-label="Remove this attachment" onClick={() => onChange({ ...a, attachments: (a.attachments ?? []).filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                    {isBank ? (
                      <div className="editor-row gap-1.5">
                        <TemplatedInput value={att.bankFile.run} onChange={(run) => setAtt({ bankFile: { ...att.bankFile, run }, filename: att.filename })} vars={vars} placeholder="run, e.g. {{subject}}" />
                        <Input className="h-9 w-40" value={att.bankFile.bank} onChange={(e) => setAtt({ bankFile: { ...att.bankFile, bank: e.target.value }, filename: att.filename })} placeholder="bank format slug" />
                      </div>
                    ) : (
                      <TemplatedInput value={att.document} onChange={(document) => setAtt({ document, filename: att.filename })} vars={vars} placeholder="{{subject}}" />
                    )}
                  </div>
                );
              })}
              <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...a, attachments: [...(a.attachments ?? []), { document: "" }] })}><Plus className="mr-1 h-4 w-4" /> Add attachment</Button>
            </div>
          </Field>
        </div>
      );
    case "emailAudience":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Audience</span>
            <Select value={a.audience.kind} onValueChange={(k) => onChange({ ...a, audience: k === "department" ? { kind: "department", department: "" } : k === "employees" ? { kind: "employees", employees: [] } : { kind: "everyone" } })}>
              <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="everyone">Everyone</SelectItem><SelectItem value="department">A department</SelectItem><SelectItem value="employees">Specific employees</SelectItem></SelectContent>
            </Select>
            {a.audience.kind === "department" && <DepartmentPicker value={a.audience.department} onChange={(department) => onChange({ ...a, audience: { kind: "department", department } })} />}
          </div>
          <Field label="Subject"><TemplatedInput value={a.subject} onChange={(subject) => onChange({ ...a, subject })} vars={vars} placeholder="Email subject" /></Field>
          <Field label="Body (HTML)"><TemplatedInput value={a.html} onChange={(html) => onChange({ ...a, html })} vars={vars} textarea placeholder="<p>…</p>" /></Field>
        </div>
      );
  }
}

// ---- apiCall: guided Create / Act-on-record / Raw ----
type BodyRow = { key: string; value: string };
function bodyToRows(body: unknown): BodyRow[] {
  return body && typeof body === "object" && !Array.isArray(body) ? Object.entries(body as Record<string, unknown>).map(([k, v]) => ({ key: k, value: typeof v === "string" ? v : JSON.stringify(v) })) : [];
}

/** A body this field form cannot represent: an array, or a scalar. Shown read-only rather than erased. */
function isFieldMap(body: unknown): boolean {
  return body == null || (typeof body === "object" && !Array.isArray(body));
}

// THE ROUND-TRIP HAS TO BE LOSSLESS. Numbers and booleans survived it; an array, a nested object and `null`
// did not - `rowsToBody` had no branch that parsed one back, so `["employees/a1"]` was shown in the row and
// written back as the STRING '["employees/a1"]'. And editing any row re-serialises all of them, so touching
// an unrelated field was enough. Several write schemas require arrays (goal-templates `:assign` takes
// `employees`, cards `initial_todos`, announcements poll `options`), the guided form cannot author one at
// all, so such a rule has to be written through the JSON hatch - and then merely OPENING it here and
// touching the body converted it to a string, which the server rejects with a 400 naming a field the reader
// never typed wrong.
function parseValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v.includes("{{")) return v; // a template is always a string
  if (/^[[{]/.test(v.trim())) { try { return JSON.parse(v); } catch { return v; } }
  return v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
}
function rowsToBody(rows: BodyRow[]): Record<string, unknown> | undefined {
  const entries = rows.filter((r) => r.key.trim());
  if (!entries.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const r of entries) out[r.key] = parseValue(r.value);
  return out;
}

function ApiCallEditor({ action, onChange: onChangeProp, meta, vars }: { action: Extract<Action, { kind: "apiCall" }>; onChange: (a: Action) => void; meta: WorkflowMeta | null; vars: Variable[] }) {
  const resources = meta?.resources ?? [];
  // The shape a saved call was written in - the mode to OPEN on. It is only the opening guess: kept as the
  // live value, typing a variable into a raw call's path ("/v1/{{subject}}:prioritize" - a custom method on
  // the record a rule fired on) re-read as "Act on a record" and swapped the editor out from under the
  // caret, so a raw call to a templated path could not be authored at all. Once the reader has said which
  // kind of call this is, that answer stands until they change it.
  const inferred = action.method.toUpperCase() === "POST" && !action.path.includes("{{") && /^\/v1\/[a-z-]+$/.test(action.path) ? "create" : action.path.includes("{{") ? "record" : "raw";
  const [mode, setMode] = useState<"create" | "record" | "raw">(inferred);
  // ...and RE-SEEDED when a DIFFERENT action arrives in this slot, exactly the way `rows` below is. "Kept as
  // the live value" is about our own writes - it must not also mean keeping the mode of an action that is no
  // longer here. Stable keys (see ActionList) make that a rare event rather than the routine consequence of
  // pressing Delete or Move up, but a parent that swaps the whole list in place can still do it.
  const emittedAction = useRef(JSON.stringify(action));
  const incomingAction = JSON.stringify(action);
  if (incomingAction !== emittedAction.current) {
    emittedAction.current = incomingAction;
    setMode(inferred);
  }
  // Every write out of this editor and its children goes through here, so the ref above records what WE sent
  // and the comparison only ever fires on a change from outside.
  const onChange = (a: Action) => {
    emittedAction.current = JSON.stringify(a);
    onChangeProp(a);
  };
  // The rows are state of their own rather than a read of `action.body`, because a body is an OBJECT: a row
  // whose key has not been typed yet has nowhere to live in it. Derived, "Add field" looked broken - the
  // empty row it appended was dropped by `rowsToBody` on the way out and never came back, so a rule's body
  // could only ever be authored in the seed. Re-seeded only when the body changes from outside this editor
  // (a different action moved into this slot), never in response to our own write.
  const [rows, setRowsState] = useState<BodyRow[]>(() => bodyToRows(action.body));
  const emitted = useRef(JSON.stringify(action.body ?? null));
  const incoming = JSON.stringify(action.body ?? null);
  if (incoming !== emitted.current) {
    emitted.current = incoming;
    setRowsState(bodyToRows(action.body));
  }
  const setRows = (r: BodyRow[]) => {
    setRowsState(r);
    const body = rowsToBody(r);
    emitted.current = JSON.stringify(body ?? null);
    onChange({ ...action, body });
  };
  const resourceOf = (path: string) => path.replace("/v1/", "").split(/[/:]/)[0] ?? "";

  // A body that is not a field map (an array, or a scalar) has no rows to show, and the form used to render
  // empty - as if the action had no body at all - so the first "Add field" wrote that emptiness back over it.
  // Surfaced instead, read-only, naming the editor that can change it.
  const bodyForm = !isFieldMap(action.body) ? (
    <Field label="Body">
      <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        This body is not a field map, so it can't be edited here without changing its shape. Use <span className="font-medium">Edit as JSON</span>.
      </p>
      <pre className="mt-1.5 overflow-x-auto rounded-lg border bg-muted/30 p-2 font-mono text-[11px]">{JSON.stringify(action.body, null, 2)}</pre>
    </Field>
  ) : (
    <Field label="Fields">
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          // A 160px key field beside a value field and a delete button is the whole width of a phone-sized
          // dialog, so the key field narrows there and the pair still reads as one row.
          <div key={i} className="flex items-center gap-1.5">
            <Input className="h-9 w-28 sm:w-40" value={r.key} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="field" />
            <TemplatedInput value={r.value} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, value: v } : x)))} vars={vars} placeholder="value" />
            <Button type="button" variant="ghost" size="icon" aria-label="Remove this field" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { key: "", value: "" }])}><Plus className="mr-1 h-4 w-4" /> Add field</Button>
      </div>
    </Field>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Do</span>
        <Select
          value={mode}
          onValueChange={(m) => {
            setMode(m as typeof mode);
            if (m === "record") onChange({ ...action, method: "PATCH", path: "/v1/{{subject}}" });
            else onChange({ ...action, method: "POST", path: "/v1/" });
          }}
        >
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="create">Create a record</SelectItem><SelectItem value="record">Act on a record</SelectItem><SelectItem value="raw">Raw API call</SelectItem></SelectContent>
        </Select>
      </div>

      {mode === "create" && (
        <>
          <Field label="Resource">
            <Select value={resourceOf(action.path)} onValueChange={(r) => onChange({ ...action, method: "POST", path: `/v1/${r}` })}>
              <SelectTrigger><SelectValue placeholder="pick a resource" /></SelectTrigger>
              <SelectContent>{resources.map((r) => <SelectItem key={r.name} value={r.name}>{r.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {bodyForm}
        </>
      )}

      {mode === "record" && <RecordCall action={action} onChange={onChange} resources={resources} vars={vars} bodyForm={bodyForm} />}

      {mode === "raw" && (
        <>
          <div className="flex items-center gap-1.5">
            <Select value={action.method} onValueChange={(method) => onChange({ ...action, method })}>
              <SelectTrigger className="h-9 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>{["POST", "PATCH", "DELETE", "GET"].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
            <TemplatedInput value={action.path} onChange={(path) => onChange({ ...action, path })} vars={vars} placeholder="/v1/…" />
          </div>
          {bodyForm}
        </>
      )}

      <Field label="Save the response as (optional - lets later steps use it)"><Input value={action.captureAs ?? ""} onChange={(e) => onChange({ ...action, captureAs: e.target.value || undefined })} placeholder="e.g. transition" /></Field>
    </div>
  );
}

function RecordCall({ action, onChange, resources, vars, bodyForm }: { action: Extract<Action, { kind: "apiCall" }>; onChange: (a: Action) => void; resources: WorkflowMeta["resources"]; vars: Variable[]; bodyForm: ReactNode }) {
  // path = /v1/<record ref>[:verb]. record ref is a variable ("{{subject}}" / "{{results.x.path}}"). The chosen
  // resource is LOCAL state (only to populate the verb dropdown) - it is never persisted on the action (the
  // server write schema is strict).
  const withoutV1 = action.path.replace("/v1/", "");
  const colon = withoutV1.lastIndexOf(":");
  const record = colon >= 0 ? withoutV1.slice(0, colon) : withoutV1;
  const verb = colon >= 0 ? withoutV1.slice(colon + 1) : action.method.toUpperCase() === "DELETE" ? "delete" : "update";
  const [resourceName, setResourceName] = useState("");
  // Cleared when a DIFFERENT action lands in this slot, for the reason the apiCall editor re-seeds its mode:
  // this is the record type whose custom verbs the dropdown lists, and carrying one action's answer over to
  // another offers verbs the new record does not have. `action.path` is the whole of what this component
  // reads, so it is the whole of what "a different action" means here.
  const seededFor = useRef(action.path);
  if (seededFor.current !== action.path && resourceName) {
    // Only on a path this component did not itself write: every write below goes through `onChange` with a
    // path built from the current `record`/`verb`, so the ref is advanced on the way out too.
    seededFor.current = action.path;
    setResourceName("");
  }
  const emit = (a: Action) => {
    if (a.kind === "apiCall") seededFor.current = a.path;
    onChange(a);
  };
  const resource = resources.find((r) => r.name === resourceName);
  const setRecord = (r: string) => emit({ ...action, path: `/v1/${r}${verb === "update" || verb === "delete" ? "" : `:${verb}`}` });
  const setVerb = (v: string) => {
    if (v === "update") emit({ ...action, method: "PATCH", path: `/v1/${record}` });
    else if (v === "delete") emit({ ...action, method: "DELETE", path: `/v1/${record}` });
    else emit({ ...action, method: "POST", path: `/v1/${record}:${v}` });
  };
  return (
    <>
      <Field label="Which record"><TemplatedInput value={record} onChange={setRecord} vars={vars} placeholder="{{subject}}" /></Field>
      {/* Two 160-190px selects behind a label do not fit a phone on one line, so the row wraps and each
          select takes the width it is given below `sm`. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-full text-sm text-muted-foreground sm:w-auto">Record type</span>
        <Select value={resourceName} onValueChange={setResourceName}>
          <SelectTrigger className="h-9 w-full sm:w-48"><SelectValue placeholder="pick to list actions" /></SelectTrigger>
          <SelectContent>{resources.map((r) => <SelectItem key={r.name} value={r.name}>{r.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={verb} onValueChange={setVerb}>
          <SelectTrigger className="h-9 w-full sm:w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="update">Update</SelectItem>
            <SelectItem value="delete">Delete</SelectItem>
            {(resource?.verbs ?? []).map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {verb !== "delete" && bodyForm}
    </>
  );
}

// ---- waitFor: a selector of arms (first to fire wins) ----
function WaitForEditor({ action, onChange, meta, triggerType }: { action: Extract<Action, { kind: "waitFor" }>; onChange: (a: Action) => void; meta: WorkflowMeta | null; triggerType: string }) {
  const setArm = (i: number, arm: WaitArm) => onChange({ ...action, on: action.on.map((x, j) => (j === i ? arm : x)) });
  const delArm = (i: number) => onChange({ ...action, on: action.on.filter((_, j) => j !== i) });
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Suspends until the first branch fires. An event branch resumes on a matching event; a timer branch resumes after a delay. No timer branch = waits forever.</p>
      {action.on.map((arm, i) => {
        const isEvent = "event" in arm;
        return (
          <Card key={i} className="border-dashed p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              {/* "On event" + which event + how to match is 124 + 224 + 160px of stated width. It has to
                  stack on a phone, and the branch's delete button stays pinned at the top right of the
                  block rather than centring itself against a three-line stack. */}
              <div className="editor-row min-w-0 flex-1">
                <Select value={isEvent ? "event" : "timer"} onValueChange={(t) => setArm(i, t === "event" ? { event: "", then: arm.then } : { timer: { days: 7 }, then: arm.then })}>
                  <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="event">⚡ On event</SelectItem><SelectItem value="timer">⏲ After timer</SelectItem></SelectContent>
                </Select>
                {isEvent ? (
                  <>
                    <Select value={(arm as { event: string }).event} onValueChange={(event) => setArm(i, { ...(arm as { event: string; match?: string; then: Action[] }), event })}>
                      <SelectTrigger className="h-8 w-56"><SelectValue placeholder="pick an event" /></SelectTrigger>
                      <SelectContent>{(meta?.events ?? []).map((e) => <SelectItem key={e.type} value={e.type}>{e.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <Select value={(arm as { match?: string }).match ?? "employeeId"} onValueChange={(match) => setArm(i, { ...(arm as { event: string; then: Action[] }), match })}>
                      <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="employeeId">same employee</SelectItem><SelectItem value="subject">same record</SelectItem></SelectContent>
                    </Select>
                  </>
                ) : (
                  <div className="flex items-center gap-1 text-sm">
                    <Input type="number" className="h-8 w-16" value={(arm as { timer: { days?: number } }).timer.days ?? 0} onChange={(e) => setArm(i, { timer: { ...(arm as { timer: { days?: number; hours?: number } }).timer, days: Number(e.target.value) }, then: arm.then })} /> days
                    <Input type="number" className="h-8 w-16" value={(arm as { timer: { hours?: number } }).timer.hours ?? 0} onChange={(e) => setArm(i, { timer: { ...(arm as { timer: { days?: number; hours?: number } }).timer, hours: Number(e.target.value) }, then: arm.then })} /> hrs
                  </div>
                )}
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="Remove this branch" onClick={() => delArm(i)} disabled={action.on.length <= 1}><Trash2 className="h-4 w-4" /></Button>
            </div>
            <div className="ml-3 border-l pl-3">
              <ActionList actions={arm.then} onChange={(then) => setArm(i, { ...arm, then } as WaitArm)} meta={meta} triggerType={isEvent ? (arm as { event: string }).event || triggerType : triggerType} inArm />
            </div>
          </Card>
        );
      })}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...action, on: [...action.on, { event: "", then: [] }] })}><Plus className="mr-1 h-4 w-4" /> Event branch</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...action, on: [...action.on, { timer: { days: 30 }, then: [] }] })}><Plus className="mr-1 h-4 w-4" /> Timer branch</Button>
      </div>
    </div>
  );
}
