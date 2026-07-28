import { useEffect, useState } from "react";
import { Contact } from "lucide-react";
import { get, patch } from "@/api";
import type { PersonalDetails } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/common/Field";
import { IconEdit } from "@/components/common/IconEdit";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

/** An employee's contact details. Stored encrypted (with emergency info, edited via the
 *  emergency modal); visible to the owner, HR and super_admin. */
export function EmployeePersonalDetails({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<PersonalDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PersonalDetails>({});
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setData(await get<PersonalDetails>(`employees/${employeeId}/personal-info`));
    } catch (e) {
      if ((e as { status?: number }).status === 403) setDenied(true);
    }
  }
  useEffect(() => {
    load();
  }, [employeeId]);

  function openEdit() {
    setForm(data ?? {});
    setOpen(true);
  }
  const set = (patch: Partial<PersonalDetails>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setSaving(true);
    try {
      // Save the full record so emergency fields (edited in the emergency modal) are preserved.
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, form);
      setData(updated);
      toast({ title: "Contact details saved", variant: "success" });
      setOpen(false);
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (denied) return null;
  const d = data ?? {};

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="personal-info" label="Contact details">
            <span className="flex items-center gap-2"><Contact className="h-4 w-4 text-primary" /> Contact</span>
          </AccessAction>
        </CardTitle>
        {canEdit && <IconEdit onClick={openEdit} />}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="Personal email" value={d.personal_email} field="personal_email" />
          <Row label="Personal phone" value={d.personal_phone} field="personal_phone" />
          <Row label="Alternate phone" value={d.alternate_phone} field="alternate_phone" />
          <Row label="Communication address" value={d.communication_address} field="communication_address" multiline />
          <Row label="Permanent address" value={d.same_as_communication ? "Same as communication address" : d.permanent_address} field="permanent_address" multiline />
        </dl>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto" onEnterSubmit={() => { if (!saving) save(); }}>
          <DialogHeader>
            <DialogTitle>Edit contact details</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Personal email"><Input type="email" value={form.personal_email ?? ""} onChange={(e) => set({ personal_email: e.target.value })} /></Field>
            <Field label="Personal phone"><Input value={form.personal_phone ?? ""} onChange={(e) => set({ personal_phone: e.target.value })} /></Field>
            <Field label="Alternate phone"><Input value={form.alternate_phone ?? ""} onChange={(e) => set({ alternate_phone: e.target.value })} /></Field>
          </div>
          <Field label="Communication address"><Textarea rows={2} value={form.communication_address ?? ""} onChange={(e) => set({ communication_address: e.target.value })} /></Field>
          <div className="flex items-center gap-2">
            <Checkbox id="same-addr" checked={!!form.same_as_communication} onCheckedChange={(v) => set({ same_as_communication: v === true })} />
            <Label htmlFor="same-addr">Permanent address same as communication</Label>
          </div>
          {!form.same_as_communication && (
            <Field label="Permanent address"><Textarea rows={2} value={form.permanent_address ?? ""} onChange={(e) => set({ permanent_address: e.target.value })} /></Field>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={saving}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Row({ label, value, field, multiline }: { label: string; value?: string; field?: string; multiline?: boolean }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        <FieldAccess field={field ? `personal-info.${field}` : undefined} label={label} />
      </dt>
      <dd className={`mt-0.5 text-sm font-medium ${multiline ? "whitespace-pre-line" : "truncate"}`}>{value || <span className="text-muted-foreground">-</span>}</dd>
    </div>
  );
}
