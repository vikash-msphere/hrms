import { useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { get, patch } from "@/api";
import type { BankDetails } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { IconEdit } from "@/components/common/IconEdit";
import { FieldAccess } from "@/components/access/FieldAccess";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useOrg } from "@/lib/org";

type Form = { bank_name: string; account_name: string; account_number: string; ifsc_code: string; currency_code: string };
const EMPTY: Form = { bank_name: "", account_name: "", account_number: "", ifsc_code: "", currency_code: "" };

/** An employee's bank account. The server keeps it encrypted and only ever returns the
 *  account number masked; access is restricted to the owner, HR and super_admin. */
export function EmployeeBankDetails({ employeeId, canEdit, title = "Bank details", onSaved }: { employeeId: string; canEdit: boolean; title?: string; onSaved?: () => void }) {
  const { toast } = useToast();
  const { org } = useOrg();
  const allowedCurrencies = org.currencies ?? ["INR"];
  const allowedBanks = org.banks ?? [];
  const [data, setData] = useState<BankDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [confirmNumber, setConfirmNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, { form, confirmNumber }, () => setOpen(false), { label: "bank details" });

  async function load() {
    try {
      setData(await get<BankDetails>(`employees/${employeeId}/bank-account`));
    } catch (e) {
      if ((e as { status?: number }).status === 403) setDenied(true);
    }
  }
  useEffect(() => {
    load();
  }, [employeeId]);

  function openEdit() {
    // Pre-fill the non-secret fields; the account number is never returned, so it starts blank.
    setForm({
      bank_name: data?.bank_name ?? "",
      account_name: data?.account_name ?? "",
      account_number: "",
      ifsc_code: data?.ifsc_code ?? "",
      currency_code: data?.currency_code ?? org.default_currency ?? "INR",
    });
    setConfirmNumber("");
    setErr(null);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const updated = await patch<BankDetails>(`employees/${employeeId}/bank-account`, form);
      setData(updated);
      toast({ title: "Bank details saved", variant: "success" });
      onSaved?.();
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (denied) return null;

  // Salary goes wherever these digits point, and a wrong-but-valid account number is not recoverable by the
  // payer. So the number is typed twice when it's being set or changed, and an IFSC that can't be real is
  // caught here rather than by a failed transfer. Blank number on an existing record = keep what's stored.
  const numberChanged = form.account_number.trim() !== "";
  const numberMismatch = numberChanged && confirmNumber.trim() !== "" && confirmNumber.trim() !== form.account_number.trim();
  // Indian IFSC: 4-letter bank code, a reserved 0, then a 6-character branch code. Other routing schemes pass
  // through unchecked - the format is only asserted for the one it can be asserted for.
  const ifsc = form.ifsc_code.trim().toUpperCase();
  const ifscInvalid = ifsc !== "" && form.currency_code === "INR" && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);
  const canSave = !saving && !numberMismatch && !ifscInvalid && (!numberChanged || confirmNumber.trim() === form.account_number.trim());

  // [label, value, write-key]. The key (e.g. account_number, not the masked read alias) scopes the per-field
  // access rule to `bank-account.<key>`.
  const rows: [string, string | undefined, string][] = [
    ["Bank name", data?.bank_name, "bank_name"],
    ["IFSC / routing code", data?.ifsc_code, "ifsc_code"],
    ["Account holder", data?.account_name, "account_name"],
    ["Account number", data?.account_number_masked, "account_number"],
    ["Currency", data?.currency_code, "currency_code"],
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="bank-account" label="Bank details">
            <span className="flex items-center gap-2"><Landmark className="h-4 w-4 text-primary" /> {title}</span>
          </AccessAction>
        </CardTitle>
        {canEdit && <IconEdit label={data?.on_file ? "Edit" : "Add"} onClick={openEdit} />}
      </CardHeader>
      <CardContent>
        {!data?.on_file ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No bank details on file.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {rows.map(([label, value, key]) => (
              <div key={label}>
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {label}
                  <FieldAccess field={`bank-account.${key}`} label={label} />
                </dt>
                <dd className="mt-0.5 text-sm font-medium">{value || "-"}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (canSave) save(); }}>
          <AccessScope collection="employees" objectPath={`employees/${employeeId}`}>
          <DialogHeader>
            <DialogTitle>{data?.on_file ? "Edit bank details" : "Add bank details"}</DialogTitle>
            <DialogDescription>Where salary, reimbursements and settlements are paid. The account number is stored encrypted and only ever shown masked.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          {allowedBanks.length === 0 && (
            /* No configured banks means the one required field can't be filled - a dead end that looks like a
               broken select until it's named. */
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              No banks are configured yet, so there's nothing to pick. An admin sets the list in Settings → Identity.
            </p>
          )}
          <FieldRow className="sm:grid-cols-[3fr_2fr]">
            <Field label="Bank name">
              <Select value={form.bank_name || undefined} onValueChange={(v) => setForm({ ...form, bank_name: v })}>
                <SelectTrigger><SelectValue placeholder="Select a bank…" /></SelectTrigger>
                <SelectContent>
                  {allowedBanks.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="IFSC / routing" error={ifscInvalid ? "Not an IFSC - 4 letters, a 0, then 6 characters (e.g. HDFC0001234)." : undefined}>
              <Input
                value={form.ifsc_code}
                onChange={(e) => setForm({ ...form, ifsc_code: e.target.value.toUpperCase() })}
                placeholder="HDFC0001234"
                autoCapitalize="characters"
                spellCheck={false}
              />
            </Field>
          </FieldRow>
          <Field label="Account holder" hint="As the bank has it - a mismatched name gets the transfer rejected.">
            <Input value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} />
          </Field>
          <FieldRow className="sm:grid-cols-[3fr_2fr]">
            <Field label="Account number" hint={data?.on_file ? "Leave blank to keep the current number." : undefined}>
              <Input
                value={form.account_number}
                onChange={(e) => setForm({ ...form, account_number: e.target.value })}
                placeholder={data?.account_number_masked || ""}
                inputMode="numeric"
                spellCheck={false}
                className="tabular-nums"
              />
            </Field>
            <Field label="Currency">
              <Select value={form.currency_code || undefined} onValueChange={(v) => setForm({ ...form, currency_code: v })}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {allowedCurrencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          {/* Only asked when the number is actually being set or changed - re-typing it to edit an IFSC would
              be busywork, and pasting the same value twice is no check at all, so paste is blocked here. */}
          {numberChanged && (
            <Field
              label="Confirm account number"
              error={numberMismatch ? "The two numbers don't match." : undefined}
              hint={!numberMismatch && confirmNumber.trim() !== "" ? "Matches." : "Type it again - salary goes wherever this points."}
            >
              <Input
                value={confirmNumber}
                onChange={(e) => setConfirmNumber(e.target.value)}
                onPaste={(e) => e.preventDefault()}
                inputMode="numeric"
                spellCheck={false}
                className="tabular-nums"
              />
            </Field>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} loading={saving} disabled={!canSave}>Save</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
