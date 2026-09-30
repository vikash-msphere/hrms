import { useCallback, useEffect, useRef, useState } from "react";
import { Contact } from "lucide-react";
import { get, patch } from "@/api";
import { isConflict } from "@/lib/formError";
import { changedFields } from "@/lib/mergePatch";
import type { PersonalDetails } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { IconEdit } from "@/components/common/IconEdit";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";

/** An employee's contact details. Stored encrypted (with emergency info, edited via the
 *  emergency modal); visible to the owner, HR and super_admin. */
export function EmployeePersonalDetails({ employeeId, canEdit, onSaved }: { employeeId: string; canEdit: boolean; onSaved?: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<PersonalDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PersonalDetails>({});
  // Empty passes: the inline error should fire on a malformed entry, never on a field nobody has touched.
  const emailOk = !form.personal_email?.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.personal_email.trim());

  // Saves made since mount. The first read can still be on the wire when somebody opens the editor and saves -
  // it answers with the blob that save replaced, and landing second it put the old values back on the card over
  // the save's own answer, so a saved detail read as never saved until a reload. A read that left before a save
  // is therefore dropped. The two sibling cards over this blob (EmployeeEmergencyDetails,
  // EmployeeProfilePersonal) carry the same guard.
  const writes = useRef(0);
  // The loader is the effect's dependency (see the note in EmployeeBankDetails).
  const load = useCallback(async () => {
    try {
      const at = writes.current;
      const read = await get<PersonalDetails>(`employees/${employeeId}/personal-info`);
      if (at === writes.current) setData(read);
    } catch (e) {
      if ((e as { status?: number }).status === 403) setDenied(true);
    }
  }, [employeeId]);
  useEffect(() => {
    void load();
  }, [load]);

  // What the form was filled with when it opened: the save sends only what differs from it (lib/mergePatch.ts).
  const shown = useRef<PersonalDetails>({});
  function openEdit() {
    shown.current = data ?? {};
    setForm(shown.current);
    setOpen(true);
  }
  const set = (patch: Partial<PersonalDetails>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    // Only the keys changed here, with the version it was read at. The emergency fields on this same blob are
    // preserved because a merge patch leaves omitted keys alone - the whole form used to go, and after a 409
    // "save again" wrote the emergency contact as this dialog first read it over the one somebody had just
    // saved. If-Match stays: two people editing the same field at once is a race the server has to decide.
    try {
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, changedFields(form, shown.current), data?.etag);
      writes.current++;
      setData(updated);
      toast({ title: "Contact details saved", variant: "success" });
      onSaved?.();
    } catch (e) {
      if (isConflict(e)) {
        await load();
        throw new Error("Somebody else changed these details while you had them open. They have been reloaded - check them and save again.");
      }
      throw e;
    }
  }

  if (denied) return null;
  const d = data ?? {};

  return (
    <Card className="sentry-mask">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="personal-info" label="Contact details">
            <span className="flex items-center gap-2"><Contact className="h-4 w-4 text-primary" /> Contact</span>
          </AccessAction>
        </CardTitle>
        {/* Only once the record is in: an editor opened before it seeds from nothing and saves with no version -
            and this one saves the WHOLE form, so that would blank every field the reader never saw. */}
        {canEdit && data && <IconEdit onClick={openEdit} />}
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

      <WriteDialog
      className="sentry-mask"
        open={open}
        onClose={() => setOpen(false)}
        title="Edit contact details"
        description="Stored encrypted. Used to reach them off work channels and as the address on letters and statutory filings."
        collection="employees"
        objectPath={`employees/${employeeId}`}
        guardLabel="contact details"
        form={form}
        submitLabel="Save"
        canSubmit={emailOk}
        whyNot="That personal email isn't a valid address."
        onSubmit={save}
      >
          <FieldRow>
            <Field
              label="Personal email"
              field="personal-info.personal_email"
              error={!emailOk ? "Enter a valid email address." : undefined}
              hint="Where they're reachable after their work account is closed."
            >
              <Input type="email" value={form.personal_email ?? ""} onChange={(e) => set({ personal_email: e.target.value })} placeholder="name@example.com" />
            </Field>
            <Field label="Personal phone" field="personal-info.personal_phone"><Input type="tel" inputMode="tel" value={form.personal_phone ?? ""} onChange={(e) => set({ personal_phone: e.target.value })} /></Field>
          </FieldRow>
          <Field label="Alternate phone" field="personal-info.alternate_phone" hint="Optional second number, e.g. a landline or a family member.">
            <Input type="tel" inputMode="tel" value={form.alternate_phone ?? ""} onChange={(e) => set({ alternate_phone: e.target.value })} />
          </Field>
          <Field label="Communication address" field="personal-info.communication_address" hint="Where post actually reaches them.">
            <Textarea rows={2} value={form.communication_address ?? ""} onChange={(e) => set({ communication_address: e.target.value })} />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="same-addr" checked={!!form.same_as_communication} onCheckedChange={(v) => set({ same_as_communication: v === true })} />
            <Label htmlFor="same-addr">Permanent address same as communication</Label>
          </div>
          {!form.same_as_communication && (
            <Field label="Permanent address" field="personal-info.permanent_address"><Textarea rows={2} value={form.permanent_address ?? ""} onChange={(e) => set({ permanent_address: e.target.value })} /></Field>
          )}
      </WriteDialog>
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
