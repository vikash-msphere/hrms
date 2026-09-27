import { useEffect, useState } from "react";
import { create } from "@/api";
import { round2 } from "@/lib/utils";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { AccessAction } from "@/components/access/AccessAction";
import { Segmented } from "@/components/common/Segmented";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import type { LeaveBalance } from "@/types";

// Moving one leave balance by hand: a `leave-adjustments` correction (services/leaveAdjustments.ts). The row is
// the record of it - the days, the reason, who did it - and the balance moves by exactly that in the same write,
// so the balance history can always say why a number changed. Nothing here can take a balance below zero; the
// server refuses that, and the preview line says what the balance becomes before anyone presses Save.

type Direction = "add" | "remove";
const EMPTY = { direction: "add" as Direction, days: "", reason: "" };

export function AdjustBalanceDialog({ balance, who, typeName, onClose, onSaved }: {
  balance: LeaveBalance | null;
  /** The person and leave type, as the table shows them, for the title. */
  who: string;
  typeName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY);
  useEffect(() => { if (balance) setForm(EMPTY); }, [balance]);
  const days = Number(form.days);
  const valid = form.days.trim() !== "" && Number.isFinite(days) && days > 0;
  const signed = valid ? round2(form.direction === "add" ? days : -days) : 0;
  const after = round2((balance?.balance_days ?? 0) + signed);
  const blockers = [
    !valid && "Give a number of days above zero.",
    valid && after < 0 && "That would take the balance below zero.",
    !form.reason.trim() && "Say why - it is shown on the balance history.",
  ];

  async function submit() {
    if (!balance) return;
    await create("leave-adjustments", { employee: balance.employee, leave_type: balance.leave_type, days: signed, reason: form.reason.trim() });
    toast({ variant: "success", title: `${typeName} balance ${signed > 0 ? "increased" : "reduced"} by ${Math.abs(signed)} day${Math.abs(signed) === 1 ? "" : "s"}` });
    onSaved();
    onClose();
  }

  return (
    <WriteDialog
      open={!!balance}
      onClose={onClose}
      title={`Adjust ${typeName} for ${who}`}
      description="A correction by hand. The change and its reason are kept on the balance history, and the balance moves the moment you save."
      collection="leave-adjustments"
      guardLabel="balance adjustment"
      form={form}
      submitLabel="Save adjustment"
      canSubmit={blockers.every((b) => !b)}
      whyNot={blockers}
      submitAccess={(b) => <AccessAction collection="leave-adjustments" create label="Adjust a leave balance">{b}</AccessAction>}
      onSubmit={submit}
    >
      <Segmented
        label="Direction"
        value={form.direction}
        onChange={(v) => setForm({ ...form, direction: v })}
        options={[
          { value: "add", label: "Add days" },
          { value: "remove", label: "Take days off" },
        ]}
      />
      <FieldRow>
        <Field label="Days" hint={valid ? `Balance becomes ${after} (it is ${balance?.balance_days ?? 0}).` : `It is ${balance?.balance_days ?? 0} now.`}>
          <Input type="number" min={0} step={0.5} inputMode="decimal" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} autoFocus />
        </Field>
      </FieldRow>
      <Field label="Reason" hint="For example: comp-off agreed for the audit weekend, or a correction to last month's leave.">
        <Textarea rows={2} value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </Field>
    </WriteDialog>
  );
}
