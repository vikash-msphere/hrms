import { useEffect, useRef, useState } from "react";
import { HeartPulse, ShieldPlus, Download as DownloadIcon, Upload as UploadIcon, Loader2 } from "lucide-react";
import { get, patch, list, upload, download } from "@/api";
import { createDocument, documentFileName } from "@/lib/documents";
import type { PersonalDetails, DocumentResource } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IconEdit } from "@/components/common/IconEdit";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

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
}: {
  employeeId: string;
  canEdit: boolean;
  // Optional controlled open, so the dialog can also be opened from outside its own trigger button
  // (the profile completeness meter's "Emergency contact" chip does).
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
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
  // Health-insurance e-card: a personal-document typed INSURANCE, filed once and surfaced here (for emergencies)
  // and on the Documents page. Reads/writes ride personal-documents access; if the viewer can't read them the
  // list simply comes back empty (section hidden), never an error.
  const [insDocs, setInsDocs] = useState<DocumentResource[]>([]);
  const [insBusy, setInsBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load on open (whether via the trigger button or the controlled prop).
  useEffect(() => {
    if (!open) return;
    setEdit(false);
    setLoading(true);
    void loadInsurance();
    get<PersonalDetails>(`employees/${employeeId}/personal-info`)
      .then((r) => setData(r))
      .catch((e) => {
        toast({ title: "Couldn't load emergency details", description: (e as Error).message, variant: "destructive" });
        setOpen(false);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId]);

  async function loadInsurance() {
    try {
      const r = await list<DocumentResource>("personal-documents");
      setInsDocs((r.results ?? []).filter((x) => x.employee === `employees/${employeeId}` && x.document_type === "INSURANCE"));
    } catch {
      setInsDocs([]);
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
    try {
      // Save the full record so the contact fields (edited elsewhere) are preserved.
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, form);
      setData(updated);
      setEdit(false);
      toast({ title: "Emergency details saved", variant: "success" });
      onSaved?.();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
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
      <span className="inline-flex items-center gap-1">
        {/* Ghost: lives in the banner's right stack, which should stay quieter than the identity side.
            The red icon alone carries the recognition. */}
        <Button variant="ghost" size="icon" title="Emergency details" onClick={() => setOpen(true)}>
          <HeartPulse className="h-4 w-4 text-destructive" />
        </Button>
        <FieldAccess accessTarget={subRef} />
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader className="flex flex-row items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <HeartPulse className="h-5 w-5 text-destructive" /> Emergency details
              <FieldAccess accessTarget={subRef} />
            </DialogTitle>
            {canEdit && !edit && !loading && (
              <AccessAction collection="employees" objectPath={obj} field="personal-info" label="Emergency details">
                <IconEdit label={hasAny ? "Edit" : "Add"} onClick={() => { setForm(data ?? {}); setEdit(true); }} />
              </AccessAction>
            )}
          </DialogHeader>

          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : edit ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Contact Name"><Input placeholder="1st contact name" value={form.emergency_name ?? ""} onChange={(e) => set({ emergency_name: e.target.value })} /></Field>
                <Field label="Number"><Input value={form.emergency_phone ?? ""} onChange={(e) => set({ emergency_phone: e.target.value })} /></Field>
                <Field label="Relation"><Input value={form.emergency_relation ?? ""} onChange={(e) => set({ emergency_relation: e.target.value })} /></Field>
                <Field label="Contact Name"><Input placeholder="2nd contact name" value={form.emergency2_name ?? ""} onChange={(e) => set({ emergency2_name: e.target.value })} /></Field>
                <Field label="Number"><Input value={form.emergency2_phone ?? ""} onChange={(e) => set({ emergency2_phone: e.target.value })} /></Field>
                <Field label="Relation"><Input value={form.emergency2_relation ?? ""} onChange={(e) => set({ emergency2_relation: e.target.value })} /></Field>
              </div>
              <Field label="Blood group">
                <Select value={form.blood_group || NONE} onValueChange={(v) => set({ blood_group: v === NONE ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>-</SelectItem>
                    {BLOOD.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Allergies"><Textarea rows={2} value={form.allergies ?? ""} onChange={(e) => set({ allergies: e.target.value })} /></Field>
              <Field label="Medical notes"><Textarea rows={2} value={form.medical_notes ?? ""} onChange={(e) => set({ medical_notes: e.target.value })} /></Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEdit(false)}>Cancel</Button>
                <Button onClick={save} loading={saving}>Save</Button>
              </DialogFooter>
            </>
          ) : (
            <>
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
                        <Button size="sm" variant="ghost" className="h-7 shrink-0" title="Download" onClick={() => download(doc.path, documentFileName({ ...doc, content_type: doc.content_type ?? "application/pdf" }))}>
                          <DownloadIcon className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No card on file{canEdit ? " - upload a PDF or image." : "."}</p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
