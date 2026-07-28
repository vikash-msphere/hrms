import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { get, patch } from "@/api";
import type { PersonalDetails } from "@/types";
import { formatDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { IconEdit } from "@/components/common/IconEdit";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const GENDERS = ["Male", "Female", "Other"];
const MARITAL = ["Single", "Married", "Divorced", "Widowed"];
const NONE = "__none__";

/** Personal attributes (date of birth, gender, marital status) shown on the Profile tab. Backed by the same
 *  encrypted `personal-info` sub-resource as Contact - each field is individually access-controlled
 *  (read-redacted + write-gated), so the section self-hides when the viewer has no personal-info access and
 *  shows "-" for a single field they can't read. Saving preserves the sibling contact/emergency fields (the
 *  server stores the whole blob), so this and the Contact editor never clobber each other. */
export function EmployeeProfilePersonal({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
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
      // Save the full record so the sibling contact/emergency fields are preserved (full-replace on the server).
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, form);
      setData(updated);
      toast({ title: "Personal details saved", variant: "success" });
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
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="personal-info" label="Personal details">
            <span className="flex items-center gap-2"><UserRound className="h-4 w-4 text-primary" /> Personal</span>
          </AccessAction>
        </CardTitle>
        {canEdit && <IconEdit onClick={openEdit} />}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="Date of birth" value={d.date_of_birth ? formatDate(d.date_of_birth) : undefined} field="date_of_birth" />
          <Row label="Gender" value={d.gender} field="gender" />
          <Row label="Marital status" value={d.marital_status} field="marital_status" />
        </dl>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!saving) save(); }}>
          <DialogHeader>
            <DialogTitle>Edit personal details</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Date of birth"><Input type="date" value={form.date_of_birth ?? ""} onChange={(e) => set({ date_of_birth: e.target.value })} /></Field>
            <Field label="Gender"><Picker value={form.gender} onChange={(v) => set({ gender: v })} options={GENDERS} /></Field>
            <Field label="Marital status"><Picker value={form.marital_status} onChange={(v) => set({ marital_status: v })} options={MARITAL} /></Field>
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

function Row({ label, value, field }: { label: string; value?: string; field?: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        <FieldAccess field={field ? `personal-info.${field}` : undefined} label={label} />
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{value || <span className="text-muted-foreground">-</span>}</dd>
    </div>
  );
}

function Picker({ value, onChange, options }: { value?: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>-</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>{o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
