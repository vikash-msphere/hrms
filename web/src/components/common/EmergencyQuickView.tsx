import { useEffect, useRef, useState } from "react";
import { HeartPulse, ShieldPlus, Download as DownloadIcon, Upload as UploadIcon, Loader2 } from "lucide-react";
import { get, patch, list, upload, download } from "@/api";
import { describeError, isConflict } from "@/lib/formError";
import { createDocument, documentFileName } from "@/lib/documents";
import type { PersonalDetails, DocumentResource } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IconEdit } from "@/components/common/IconEdit";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { DetailSkeleton } from "@/components/common/Skeletons";

const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const NONE = "__none__";

/** Heart-pulse button that opens the emergency modal - the single place to both view and edit
 *  emergency info (contacts, blood group, allergies, medical notes). */
export function EmergencyQuickView({
  employeeId,
  canEdit,
  open: openProp,
  onOpenChange,
  onSaved,
  triggerless,
}: {
  employeeId: string;
  canEdit: boolean;
  // Optional controlled open, so the dialog can also be opened from outside its own trigger button
  // (the profile completeness meter's "Emergency contact" chip does).
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
  // Drop the heart button and mount the dialog alone, for a caller that already offers this as a NAMED
  // affordance of its own - the profile header's "Emergency" button. An unlabelled red icon is the
  // loudest thing in a header and still the one whose meaning you have to hover to learn. The caller
  // then owns `open`/`onOpenChange`.
  triggerless?: boolean;
}) {
  const { toast } = useToast();
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = onOpenChange ?? setOpenLocal;
  const [data, setData] = useState<PersonalDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<PersonalDetails>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Guards the EDIT pass, not the dialog: the read view holds nothing to lose, so it closes on the first click
  // as it always has, while a half-typed contact asks first.
  const guard = useDialogGuard(edit, form, () => setEdit(false), { label: "emergency details" });
  // Health-insurance e-card: a personal-document typed INSURANCE, filed once and surfaced here (for emergencies)
  // and on the Documents page. Reads/writes ride personal-documents access; if the viewer can't read them the
  // list simply comes back empty (section hidden), never an error.
  const [insDocs, setInsDocs] = useState<DocumentResource[]>([]);
  const [insBusy, setInsBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load on open (whether via the trigger button or the controlled prop).
  //
  // GUARDED, like every other refetching effect in this app (hooks/useResource.ts, hooks/usePresence.ts).
  // `employeeId` genuinely changes under a mounted instance - pages/EmployeeProfile.tsx passes the id the
  // prev/next stepper moves, and nothing closes this dialog on that change - so two reads can be in flight for
  // two different people at once. Unguarded, a response for A landing after one for B rendered A's emergency
  // contacts, blood group and insurance e-card under B's name, which is the worst panel in the app to get
  // wrong in that direction.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setEdit(false);
    setLoading(true);
    void loadInsurance(() => live);
    get<PersonalDetails>(`employees/${employeeId}/personal-info`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => {
        if (!live) return;
        toast({ title: "Couldn't load emergency details", description: (e as Error).message, variant: "destructive" });
        setOpen(false);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId]);

  // `isLive` is the effect's own guard, passed in so a reload triggered by a save (which has no guard to give)
  // still shares one implementation with the guarded one above.
  async function loadInsurance(isLive: () => boolean = () => true) {
    try {
      // Ask the server for THIS person's documents (`?employee=`, which the list route takes), rather than
      // reading the newest page of everybody's and filtering here. The server scope is an AUTHZ scope, not a
      // per-employee one: for HR it is the whole org, so a hundred rows is a few weeks of uploads and the card
      // then shows "no insurance on file" for somebody who has one - next to an upload button that would file
      // a duplicate. It hid its own failure too, because a card just uploaded is always the newest row.
      const r = await list<DocumentResource>("personal-documents", { params: { employee: `employees/${employeeId}` } });
      if (!isLive()) return;
      setInsDocs((r.results ?? []).filter((x) => x.document_type === "INSURANCE"));
    } catch {
      if (isLive()) setInsDocs([]);
    }
  }

  async function uploadInsurance(file: File | null) {
    if (!file) return;
    setInsBusy(true);
    try {
      const doc = await createDocument({ employee: `employees/${employeeId}`, document_type: "INSURANCE", display_name: file.name.replace(/\.[^.]+$/, "") || "Health insurance card" });
      await upload(doc.path, file);
      toast({ title: "Insurance card uploaded", variant: "success" });
      await loadInsurance();
    } catch (e) {
      toast({ title: "Couldn't upload the card", description: (e as Error).message, variant: "destructive" });
    } finally {
      setInsBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const set = (patch: Partial<PersonalDetails>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      // Save the full record so the contact fields (edited elsewhere) are preserved - which is exactly why the
      // version goes with it: a whole-blob write with no If-Match does not lose a race, it silently restores
      // the old value of whatever the Contact or Personal editor wrote while this dialog was open.
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, form, data?.etag);
      setData(updated);
      guard.markSaved();
      setEdit(false);
      toast({ title: "Emergency details saved", variant: "success" });
      onSaved?.();
    } catch (e) {
      if (isConflict(e)) {
        const fresh = await get<PersonalDetails>(`employees/${employeeId}/personal-info`).catch(() => null);
        if (fresh) setData(fresh);
        setErr("Somebody else changed these details while you had them open. They have been reloaded - check them and save again.");
        return;
      }
      setErr(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  const d = data ?? {};
  // Access targets (explicit - this widget is reused on pages whose ambient AccessScope isn't `employees`).
  const obj = `employees/${employeeId}`;
  const subRef = { collection: "employees", objectPath: obj, field: "personal-info", label: "Emergency details" };
  const fieldRef = (key: string, label: string) => ({ collection: "employees", objectPath: obj, field: `personal-info.${key}`, label });
  // [label, value, field key]. Every field is individually access-controlled: the backend redacts each
  // `personal-info.<key>` per its own rule (fieldAccess.ts FLAT_KEYS), and each row carries its own manage-
  // access icon. Contacts are atomic (name / phone / relation separately), not composite, so a rule can hide,
  // say, a phone number without hiding the name.
  const rows: [string, string | undefined, string][] = [
    ["Emergency contact name", d.emergency_name, "emergency_name"],
    ["Emergency contact phone", d.emergency_phone, "emergency_phone"],
    ["Emergency contact relation", d.emergency_relation, "emergency_relation"],
    ["Second contact name", d.emergency2_name, "emergency2_name"],
    ["Second contact phone", d.emergency2_phone, "emergency2_phone"],
    ["Second contact relation", d.emergency2_relation, "emergency2_relation"],
    ["Blood group", d.blood_group, "blood_group"],
    ["Allergies", d.allergies, "allergies"],
    ["Medical notes", d.medical_notes, "medical_notes"],
  ];
  const hasAny = rows.some(([, v]) => v);

  return (
    <>
      {!triggerless && (
        <span className="inline-flex items-center gap-1">
          {/* Ghost: lives in the banner's right stack, which should stay quieter than the identity side.
              The red icon alone carries the recognition. */}
          <Button variant="ghost" size="icon" title="Emergency details" onClick={() => setOpen(true)}>
            <HeartPulse className="h-4 w-4 text-destructive" />
          </Button>
          {/* The `personal-info` manage-access icon also renders in the dialog header below, so a
              triggerless mount loses the affordance from the page, not from the app. */}
          <FieldAccess accessTarget={subRef} />
        </span>
      )}
      <Dialog open={open} onOpenChange={(next) => (edit ? guard.onOpenChange(next) : setOpen(next))}>
        {/* `sentry-mask`, like the seven sibling panels over this record: a dialog renders through a PORTAL,
            outside `<main data-page>`, so instrument.ts's route-level masking cannot reach it - and what is in
            here is blood group, allergies and free-text medical notes, the only genuinely medical fields in the
            app. Replay is unmask-by-default, and "Report a problem" attaches the current replay to a ticket,
            so without this a colleague's allergies ride into the helpdesk queue. */}
        <DialogContent scrollBody className="sentry-mask" onEnterSubmit={() => { if (edit && !saving) void save(); }}>
          <DialogHeader className="flex flex-row items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <DialogTitle className="flex items-center gap-2">
                <HeartPulse className="h-5 w-5 text-destructive" /> Emergency details
                <FieldAccess accessTarget={subRef} />
              </DialogTitle>
              <DialogDescription>
                {edit
                  ? "Who to call if something happens at work, and what a paramedic needs to know. Stored encrypted."
                  : "Who to call if something happens at work. Kept encrypted and visible only to them, HR and whoever you've shared it with."}
              </DialogDescription>
            </div>
            {canEdit && !edit && !loading && (
              <AccessAction collection="employees" objectPath={obj} field="personal-info" label="Emergency details">
                <IconEdit label={hasAny ? "Edit" : "Add"} onClick={() => { setForm(data ?? {}); setErr(null); setEdit(true); }} />
              </AccessAction>
            )}
          </DialogHeader>

          {loading ? (
            <DetailSkeleton rows={5} className="px-1" />
          ) : edit ? (
            <>
              <DialogBody>
              <FormError error={err} />
              <fieldset className="space-y-3">
                <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">First contact</legend>
                <FieldRow className="sm:grid-cols-3">
                  <Field label="Name" field="personal-info.emergency_name"><Input value={form.emergency_name ?? ""} onChange={(e) => set({ emergency_name: e.target.value })} /></Field>
                  <Field label="Phone" field="personal-info.emergency_phone"><Input type="tel" inputMode="tel" value={form.emergency_phone ?? ""} onChange={(e) => set({ emergency_phone: e.target.value })} /></Field>
                  <Field label="Relation" field="personal-info.emergency_relation"><Input placeholder="e.g. Spouse" value={form.emergency_relation ?? ""} onChange={(e) => set({ emergency_relation: e.target.value })} /></Field>
                </FieldRow>
              </fieldset>
              <fieldset className="space-y-3">
                <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Second contact (optional)</legend>
                <FieldRow className="sm:grid-cols-3">
                  <Field label="Name" field="personal-info.emergency2_name"><Input value={form.emergency2_name ?? ""} onChange={(e) => set({ emergency2_name: e.target.value })} /></Field>
                  <Field label="Phone" field="personal-info.emergency2_phone"><Input type="tel" inputMode="tel" value={form.emergency2_phone ?? ""} onChange={(e) => set({ emergency2_phone: e.target.value })} /></Field>
                  <Field label="Relation" field="personal-info.emergency2_relation"><Input value={form.emergency2_relation ?? ""} onChange={(e) => set({ emergency2_relation: e.target.value })} /></Field>
                </FieldRow>
              </fieldset>
              <Field label="Blood group" field="personal-info.blood_group">
                <Select value={form.blood_group || NONE} onValueChange={(v) => set({ blood_group: v === NONE ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>-</SelectItem>
                    {BLOOD.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {/* `data-sentry-ignore` as well as the dialog's mask: keystroke recording is a separate channel
                  from element masking, so a masked box still ships what was typed into it. Same pairing
                  RequestLeaveDialog uses for a leave reason, and for the same reason - this text is a diagnosis. */}
              <Field label="Allergies" field="personal-info.allergies" hint="Anything a paramedic should know before treating them."><Textarea rows={2} data-sentry-ignore value={form.allergies ?? ""} onChange={(e) => set({ allergies: e.target.value })} /></Field>
              <Field label="Medical notes" field="personal-info.medical_notes"><Textarea rows={2} data-sentry-ignore value={form.medical_notes ?? ""} onChange={(e) => set({ medical_notes: e.target.value })} /></Field>
              {!(form.emergency_name ?? "").trim() !== !(form.emergency_phone ?? "").trim() && (
                <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                  A contact needs both a name and a number to be worth calling.
                </p>
              )}
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
                <Button onClick={save} loading={saving}>Save</Button>
              </DialogFooter>
            </>
          ) : (
            <DialogBody>
              {!hasAny ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No emergency details on file.</p>
              ) : (
                <dl className="divide-y">
                  {rows.map(([label, value, key]) => (
                    <div key={label} className="grid grid-cols-3 gap-3 py-2.5 first:pt-0">
                      <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        {label}
                        {key && <FieldAccess accessTarget={fieldRef(key, label)} />}
                      </dt>
                      <dd className="col-span-2 whitespace-pre-line text-sm font-medium">{value || "-"}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {/* Health insurance e-card - the same personal-document surfaced on the Documents page. */}
              <div className="mt-4 border-t pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-sm font-medium"><ShieldPlus className="h-4 w-4 text-primary" /> Health insurance card</p>
                  {canEdit && (
                    <>
                      <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" className="hidden" onChange={(e) => uploadInsurance(e.target.files?.[0] ?? null)} />
                      <Button size="sm" variant="outline" disabled={insBusy} onClick={() => fileRef.current?.click()}>
                        {insBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadIcon className="h-4 w-4" />} Upload
                      </Button>
                    </>
                  )}
                </div>
                {insDocs.length ? (
                  <ul className="space-y-1.5">
                    {insDocs.map((doc) => (
                      <li key={doc.path} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{doc.display_name}</span>
                          <FieldAccess accessTarget={{ collection: "personal-documents", objectPath: doc.path, label: doc.display_name }} />
                        </span>
                        <AccessAction collection="personal-documents" objectPath={doc.path} can={doc.access?.can} verb="download" label="Download the e-card">
                          <Button size="sm" variant="ghost" className="h-7 shrink-0" title="Download" onClick={() => download(doc.path, documentFileName({ ...doc, content_type: doc.content_type ?? "application/pdf" }))}>
                            <DownloadIcon className="h-4 w-4" />
                          </Button>
                        </AccessAction>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No card on file{canEdit ? " - upload a PDF or image." : "."}</p>
                )}
              </div>
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
