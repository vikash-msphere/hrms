import { useEffect, useRef, useState } from "react";
import { IdCard, Paperclip, Download } from "lucide-react";
import { IconEdit } from "@/components/common/IconEdit";
import { get, patch, upload, download } from "@/api";
import type { IdentityDetails } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/common/Field";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

/** Configured identity fields (PAN/UAN/Aadhaar etc.) for one employee. The set of fields and
 *  which are required/sensitive is configured centrally in Settings. Sensitive values are
 *  encrypted at rest and only ever shown masked. Access: owner, HR, super_admin. */
export function EmployeeIdentityDetails({ employeeId, canEdit, title = "Identity" }: { employeeId: string; canEdit: boolean; title?: string }) {
  const { toast } = useToast();
  const [data, setData] = useState<IdentityDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Hidden file input for attaching/replacing a field's supporting document.
  const fileRef = useRef<HTMLInputElement>(null);
  const docTarget = useRef<string | null>(null);

  async function load() {
    try {
      setData(await get<IdentityDetails>(`employees/${employeeId}/identity`));
    } catch (e) {
      if ((e as { status?: number }).status === 403) setDenied(true);
    }
  }
  useEffect(() => {
    load();
  }, [employeeId]);

  function pickDoc(fieldKey: string) {
    docTarget.current = fieldKey;
    fileRef.current?.click();
  }
  async function onDocPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const field = docTarget.current;
    e.target.value = "";
    if (!file || !field) return;
    try {
      await upload(`employees/${employeeId}`, file, { verb: "uploadIdentityDoc", params: { field } });
      toast({ title: "Document attached", variant: "success" });
      load();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    }
  }
  const getDoc = (field: string) => download(`employees/${employeeId}`, `${field}-document`, { verb: "downloadIdentityDoc", params: { field } });

  function openEdit() {
    // Sensitive fields are never returned in full, so they start blank (placeholder shows the mask).
    const seed: Record<string, string> = {};
    for (const f of data?.fields ?? []) seed[f.key] = f.sensitive ? "" : f.value ?? "";
    setForm(seed);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const updated = await patch<IdentityDetails>(`employees/${employeeId}/identity`, { values: form });
      setData(updated);
      toast({ title: "Identity details saved", variant: "success" });
      setOpen(false);
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (denied) return null;
  const fields = data?.fields ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="identity" label="Identity">
            <span className="flex items-center gap-2"><IdCard className="h-4 w-4 text-primary" /> {title}</span>
          </AccessAction>
        </CardTitle>
        {canEdit && fields.length > 0 && <IconEdit label="Edit" onClick={openEdit} />}
      </CardHeader>
      <CardContent>
        <input ref={fileRef} type="file" className="hidden" onChange={onDocPicked} />
        {fields.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No identity fields configured. Add them in Settings.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {fields.map((f) => {
              const docMode = f.document ?? "none";
              return (
              <div key={f.key}>
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {f.label}
                  {f.sensitive && <Badge variant="muted" className="px-1 py-0 text-[10px]">sensitive</Badge>}
                  {f.denied && <Badge variant="muted" className="px-1 py-0 text-[10px]">restricted</Badge>}
                  {docMode === "required" && !f.has_doc && !f.denied && <Badge variant="warning" className="px-1 py-0 text-[10px]">doc required</Badge>}
                  <FieldAccess field={`identity.${f.key}`} label={f.label} />
                </dt>
                <dd className="mt-0.5 flex items-center gap-2 text-sm font-medium">
                  <span>{f.value || <span className="text-muted-foreground">-</span>}</span>
                  {f.has_doc && !f.denied && (
                    <button type="button" onClick={() => getDoc(f.key)} className="inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline">
                      <Download className="h-3 w-3" /> document
                    </button>
                  )}
                  {canEdit && docMode !== "none" && !f.denied && (
                    <button type="button" onClick={() => pickDoc(f.key)} className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground">
                      <Paperclip className="h-3 w-3" /> {f.has_doc ? "replace" : "attach"}
                    </button>
                  )}
                </dd>
              </div>
            );})}
          </dl>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!saving) save(); }}>
          <DialogHeader>
            <DialogTitle>Edit identity details</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {fields.map((f) => (
              <Field
                key={f.key}
                label={f.label + (f.mandatory ? " *" : "")}
                hint={f.sensitive ? (f.has_value ? "Leave blank to keep the current value." : "Shown masked once saved.") : undefined}
              >
                <Input
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  placeholder={f.sensitive && f.has_value ? f.value : ""}
                />
              </Field>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={saving}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
