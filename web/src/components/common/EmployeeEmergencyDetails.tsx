import { useCallback, useEffect, useRef, useState } from "react";
import { HeartPulse } from "lucide-react";
import { get, patch } from "@/api";
import { isConflict } from "@/lib/formError";
import type { PersonalDetails } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { IconEdit } from "@/components/common/IconEdit";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const NONE = "__none__";

/** Emergency details - who to call, blood group, allergies and medical notes. A card on the Profile tab,
 *  below Contact: it is the same encrypted `personal-info` sub-resource Personal and Contact are cut from, so
 *  it is read where they are read rather than behind a header button of its own. Each field is individually
 *  access-controlled (read-redacted + write-gated); the card self-hides when the viewer has no personal-info
 *  access and shows "-" for a single field they can't read. Saving preserves the sibling personal/contact
 *  fields (the server stores the whole blob), so the three editors never clobber each other.
 *
 *  The health-insurance e-card is NOT here: it is a personal document, so it is filed and listed with the
 *  rest of them on the Documents tab (UploadInsuranceButton), under the documents grant rather than this
 *  one. */
export function EmployeeEmergencyDetails({ employeeId, canEdit, onSaved }: { employeeId: string; canEdit: boolean; onSaved?: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<PersonalDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PersonalDetails>({});

  // Saves made since mount. A read that left before a save answers with the blob the save replaced, and when
  // it landed second it put the old values back on the card over the save's own answer - see
  // EmployeePersonalDetails, which carries the same guard.
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

  function openEdit() {
    setForm(data ?? {});
    setOpen(true);
  }
  const set = (patch: Partial<PersonalDetails>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    // Send only what CHANGED, with the version it was read at.
    //
    // It is a merge patch, so an omitted key is left as it was - which is how the sibling personal/contact
    // fields on the same encrypted blob survive this write, and why a field this reader may not READ (redacted
    // out of the response, so never in the form) is never sent back. The narrower body is also what a
    // PER-FIELD rule needs: the server gates every key PRESENT in the body against
    // `employees.<code>.personal-info.<key>` write (middleware/authz.ts), so posting the whole record asks for
    // write on fields nobody touched, and a single per-field deny refuses a save that changed something else
    // entirely. If-Match stays on regardless: two people editing this record at once is a race the server has
    // to decide, not this dialog.
    const before = (data ?? {}) as Record<string, unknown>;
    const changed = Object.fromEntries(
      Object.entries(form as Record<string, unknown>).filter(([k, v]) => k !== "etag" && k !== "path" && v !== before[k]),
    ) as PersonalDetails;
    try {
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, changed, data?.etag);
      writes.current++;
      setData(updated);
      toast({ title: "Emergency details saved", variant: "success" });
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
    // `sentry-mask`, like the sibling panels over this record: what is on this card is blood group, allergies
    // and free-text medical notes, the only genuinely medical fields in the app. Replay is unmask-by-default,
    // and "Report a problem" attaches the current replay to a ticket, so without this a colleague's allergies
    // ride into the helpdesk queue.
    <Card className="sentry-mask">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="personal-info" label="Emergency details">
            <span className="flex items-center gap-2"><HeartPulse className="h-4 w-4 text-destructive" /> Emergency</span>
          </AccessAction>
        </CardTitle>
        {/* Only once the record is in: an editor opened before it seeds from nothing and saves with no version. */}
        {canEdit && data && <IconEdit onClick={openEdit} />}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {/* Contacts are atomic (name / phone / relation separately), not composite, so a rule can hide, say,
              a phone number without hiding the name. */}
          <Row label="Emergency contact name" value={d.emergency_name} field="emergency_name" />
          <Row label="Emergency contact phone" value={d.emergency_phone} field="emergency_phone" />
          <Row label="Emergency contact relation" value={d.emergency_relation} field="emergency_relation" />
          <Row label="Second contact name" value={d.emergency2_name} field="emergency2_name" />
          <Row label="Second contact phone" value={d.emergency2_phone} field="emergency2_phone" />
          <Row label="Second contact relation" value={d.emergency2_relation} field="emergency2_relation" />
          <Row label="Blood group" value={d.blood_group} field="blood_group" />
          <Row label="Allergies" value={d.allergies} field="allergies" multiline />
          <Row label="Medical notes" value={d.medical_notes} field="medical_notes" multiline />
        </dl>
      </CardContent>

      <WriteDialog
        className="sentry-mask"
        open={open}
        onClose={() => setOpen(false)}
        title="Edit emergency details"
        description="Who to call if something happens at work, and what a paramedic needs to know. Stored encrypted with their personal and contact details."
        collection="employees"
        objectPath={`employees/${employeeId}`}
        guardLabel="emergency details"
        form={form}
        submitLabel="Save"
        onSubmit={save}
      >
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
          {/* `data-sentry-ignore` as well as the dialog's mask: keystroke recording is a separate channel from
              element masking, so a masked box still ships what was typed into it. Same pairing
              RequestLeaveDialog uses for a leave reason, and for the same reason - this text is a diagnosis. */}
          <Field label="Allergies" field="personal-info.allergies" hint="Anything a paramedic should know before treating them."><Textarea rows={2} data-sentry-ignore value={form.allergies ?? ""} onChange={(e) => set({ allergies: e.target.value })} /></Field>
          <Field label="Medical notes" field="personal-info.medical_notes"><Textarea rows={2} data-sentry-ignore value={form.medical_notes ?? ""} onChange={(e) => set({ medical_notes: e.target.value })} /></Field>
          {!(form.emergency_name ?? "").trim() !== !(form.emergency_phone ?? "").trim() && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              A contact needs both a name and a number to be worth calling.
            </p>
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
