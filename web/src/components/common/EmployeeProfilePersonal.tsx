import { useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { get, patch } from "@/api";
import { isConflict } from "@/lib/formError";
import type { PersonalDetails } from "@/types";
import { formatDate } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { IconEdit } from "@/components/common/IconEdit";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

const GENDERS = ["Male", "Female", "Other"];
const MARITAL = ["Single", "Married", "Divorced", "Widowed"];
const NONE = "__none__";

// Whole years between a date of birth and today - shown back as a sanity check, since a mistyped year is the
// one data-entry error nobody notices until a birthday greeting goes out to a six-year-old.
function ageFrom(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const age = now.getFullYear() - d.getFullYear();
  const before = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  return before ? age - 1 : age;
}

/** Personal attributes (date of birth, gender, marital status) shown on the Profile tab. Backed by the same
 *  encrypted `personal-info` sub-resource as Contact - each field is individually access-controlled
 *  (read-redacted + write-gated), so the section self-hides when the viewer has no personal-info access and
 *  shows "-" for a single field they can't read. Saving preserves the sibling contact/emergency fields (the
 *  server stores the whole blob), so this and the Contact editor never clobber each other. */
export function EmployeeProfilePersonal({ employeeId, canEdit, onSaved }: { employeeId: string; canEdit: boolean; onSaved?: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<PersonalDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PersonalDetails>({});
  const dob = form.date_of_birth ?? "";
  const age = dob ? ageFrom(dob) : null;
  // A future birth date is impossible; anything under 14 or over 100 is almost always a typed year. The first
  // blocks the save, the second only warns - an outlier that's genuinely correct must still be recordable.
  const dobError = dob && dob > todayStr() ? "That's in the future." : undefined;
  const dobWarn = !dobError && age != null && (age < 14 || age > 100);

  // The loader is the effect's dependency (see the note in EmployeeBankDetails).
  const load = useCallback(async () => {
    try {
      setData(await get<PersonalDetails>(`employees/${employeeId}/personal-info`));
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
    // Save the full record so the sibling contact/emergency fields are preserved - with the version it was
    // read at, so a whole-record write cannot quietly undo whatever the other dialog on this person wrote
    // while this one was open.
    try {
      const updated = await patch<PersonalDetails>(`employees/${employeeId}/personal-info`, form, data?.etag);
      setData(updated);
      toast({ title: "Personal details saved", variant: "success" });
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
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
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

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Edit personal details"
        description="Stored encrypted with their contact and emergency details. The date of birth drives birthday greetings and statutory age checks."
        collection="employees"
        objectPath={`employees/${employeeId}`}
        guardLabel="personal details"
        form={form}
        submitLabel="Save"
        canSubmit={!dobError}
        whyNot={dobError}
        onSubmit={save}
      >
          <FieldRow>
            <Field
              label="Date of birth"
              field="personal-info.date_of_birth"
              error={dobError}
              hint={!dobError && age != null ? `${age} years old.` : undefined}
            >
              <Input type="date" max={todayStr()} value={form.date_of_birth ?? ""} onChange={(e) => set({ date_of_birth: e.target.value })} />
            </Field>
            <Field label="Gender" field="personal-info.gender"><Picker value={form.gender} onChange={(v) => set({ gender: v })} options={GENDERS} /></Field>
          </FieldRow>
          <Field label="Marital status" field="personal-info.marital_status"><Picker value={form.marital_status} onChange={(v) => set({ marital_status: v })} options={MARITAL} /></Field>
          {dobWarn && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              That works out to {age} years old - check the year before saving.
            </p>
          )}
      </WriteDialog>
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
