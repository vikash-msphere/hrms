import { useState } from "react";
import { CalendarRange, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { cn, idOf } from "@/lib/utils";
import { LEAVE_COLORS, leaveColor } from "@/lib/leaveColors";
import type { LeaveType, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { InfoHint } from "@/components/common/InfoHint";
import { useToast } from "@/components/ui/use-toast";

export default function LeaveTypes({ embedded, title, openId }: { me?: Me; embedded?: boolean; title?: string; openId?: string }) {
  const { rows, state, error, reload } = useCollection<LeaveType>("leave-types", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const sd = useSoftDelete("leave-types", "leave type", reload);
  const lc = useLifecycle("leave-types", "leave type", reload);
  const writable = usePermission("leave-types.write");
  const canPurge = usePermission("leave-types.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const EMPTY_FORM = { name: "", accrual: "0", frequency: "monthly", paid: true, probation: true, probationAccrual: "0", probationCap: "", encashable: false, encashCap: "", minRetained: "0", carryForward: false, carryForwardCap: "", color: "" };
  const [form, setForm] = useState(EMPTY_FORM);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  }
  function openEdit(lt: LeaveType) {
    setEditing(lt);
    const next = {
      name: lt.display_name,
      accrual: String(lt.accrual_days_per_year ?? 0),
      frequency: lt.accrual_frequency ?? "monthly",
      paid: lt.paid,
      probation: lt.available_during_probation ?? true,
      probationAccrual: String(lt.probation_accrual_days_per_year ?? 0),
      probationCap: lt.probation_cap_days == null ? "" : String(lt.probation_cap_days),
      encashable: lt.encashable ?? false,
      encashCap: lt.encashment_cap_days_per_year == null ? "" : String(lt.encashment_cap_days_per_year),
      minRetained: String(lt.min_balance_retained_days ?? 0),
      carryForward: lt.carry_forward ?? false,
      carryForwardCap: lt.carry_forward_cap_days == null ? "" : String(lt.carry_forward_cap_days),
      color: lt.color ?? "",
    };
    setForm(next);
    setOpen(true);
  }

  async function submit() {
    const body = {
      display_name: form.name,
      accrual_days_per_year: Number(form.accrual),
      accrual_frequency: form.frequency as "monthly" | "semi_monthly",
      paid: form.paid,
      available_during_probation: form.probation,
      probation_accrual_days_per_year: Number(form.probationAccrual),
      probation_cap_days: form.probationCap.trim() === "" ? null : Number(form.probationCap),
      encashable: form.encashable,
      encashment_cap_days_per_year: form.encashCap.trim() === "" ? null : Number(form.encashCap),
      min_balance_retained_days: Number(form.minRetained) || 0,
      carry_forward: form.carryForward,
      carry_forward_cap_days: form.carryForwardCap.trim() === "" ? null : Number(form.carryForwardCap),
      // "Auto" (no colour picked) is NULL on the wire, not "": the field is a `#rrggbb` string or nothing,
      // so an empty string was rejected outright - every leave type saved without touching the swatch came
      // back 400.
      color: form.color || null,
    };
    if (editing) {
      await patch("leave-types/" + idOf(editing.path), body, editing.etag);
      toast({ title: "Leave type updated", variant: "success" });
    } else {
      await create("leave-types", body);
      toast({ title: "Leave type created", variant: "success" });
    }
    reload();
  }

  // Four bordered panels of switches are each clear on their own and easy to misread together, so the form
  // says back what it will actually do before it is saved.
  const policySummary = (() => {
    const accrual = Number(form.accrual) || 0;
    const parts: string[] = [
      accrual > 0
        ? `${accrual} day${accrual === 1 ? "" : "s"} a year, credited ${form.frequency === "semi_monthly" ? `${Math.round((accrual / 24) * 100) / 100} on the 1st and the 16th` : `${Math.round((accrual / 12) * 100) / 100} on the 1st of each month`}`
        : "no accrual (balance is granted manually)",
      form.paid ? "paid" : "unpaid",
    ];
    if (!form.probation) parts.push("cannot be requested on probation");
    else {
      const pa = Number(form.probationAccrual) || 0;
      parts.push(`on probation: ${pa > 0 ? `${pa} day${pa === 1 ? "" : "s"} a year` : "no accrual"}${form.probationCap.trim() ? `, at most ${form.probationCap.trim()} takeable` : ""}`);
    }
    parts.push(
      form.encashable
        ? `encashable${form.encashCap.trim() ? ` up to ${form.encashCap.trim()} days a year` : ""}${Number(form.minRetained) > 0 ? `, keeping ${Number(form.minRetained)} days in the balance` : ""}`
        : "not encashable",
    );
    parts.push(form.carryForward ? `carries into the next year${form.carryForwardCap.trim() ? ` (up to ${form.carryForwardCap.trim()} days)` : ""}` : "unused balance resets on 31 Dec");
    return parts.join(" · ");
  })();

  const columns: Column<LeaveType>[] = [
    { id: "name", header: "Name", accessor: (lt) => lt.display_name, cell: (lt) => (
      <span className="flex items-center gap-2 font-medium">
        <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: leaveColor(lt.color, lt.path) }} />
        {lt.display_name}
      </span>
    ) },
    { id: "accrual", header: "Accrual / year", accessor: (lt) => lt.accrual_days_per_year ?? 0, cell: (lt) => `${lt.accrual_days_per_year ?? 0} days` },
    {
      id: "paid",
      header: "Paid",
      filter: "select",
      accessor: (lt) => (lt.paid ? "Paid" : "Unpaid"),
      cell: (lt) => <Badge variant={lt.paid ? "success" : "muted"}>{lt.paid ? "Paid" : "Unpaid"}</Badge>,
    },
    {
      id: "probation",
      header: "Probation",
      filter: "select",
      accessor: (lt) => ((lt.available_during_probation ?? true) ? "Available" : "Restricted"),
      cell: (lt) =>
        (lt.available_during_probation ?? true) ? (
          <Badge variant="secondary">Available</Badge>
        ) : (
          <Badge variant="warning">Restricted</Badge>
        ),
    },
    {
      id: "encashable",
      header: "Encashable",
      filter: "select",
      accessor: (lt) => (lt.encashable ? "Encashable" : "No"),
      cell: (lt) =>
        lt.encashable ? (
          <Badge variant="success">Encashable{lt.encashment_cap_days_per_year != null ? ` (≤${lt.encashment_cap_days_per_year}/yr)` : ""}</Badge>
        ) : (
          <Badge variant="muted">No</Badge>
        ),
    },
    {
      id: "carryForward",
      header: "Carry-forward",
      filter: "select",
      accessor: (lt) => (lt.carry_forward ? "Yes" : "No"),
      cell: (lt) =>
        lt.carry_forward ? (
          <Badge variant="success">Carry-forward{lt.carry_forward_cap_days != null ? ` (≤${lt.carry_forward_cap_days})` : ""}</Badge>
        ) : (
          <Badge variant="muted">Resets</Badge>
        ),
    },
    stateColumn<LeaveType>(),
    ...metaColumns<LeaveType>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (lt) => <SoftDeleteRowActions row={lt} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />,
    },
  ];

  const createBtn = writable && (
    <AccessAction collection="leave-types" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New leave type</Button>
    </AccessAction>
  );

  return (
    <div>
      {/* Standalone: own page header. Embedded (a Settings section): the optional `title` renders on the
          table's toolbar row so it lines up with the create button, which stays in the toolbar. */}
      {!embedded && (
        <PageHeader accessCollection="leave-types" title="Leave Types" description="Define the kinds of leave employees can request and how they accrue." actions={createBtn} />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No leave types"
            description="Create leave types like Annual, Sick or Unpaid."
            action={createBtn}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="leave-types"
            rows={rows}
            getRowId={(lt) => lt.path}
            rowClassName={(lt) => (lt.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No leave types match"
            title={embedded ? title : undefined}
            toolbar={embedded ? createBtn : undefined}
            accessCollection="leave-types"
            accessTargetOf={(lt) => ({ objectPath: lt.path, label: lt.display_name, can: lt.access?.can })}
          />
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit leave type" : "New leave type"}
        description="How this leave accrues, who can take it, and what happens to what's left at year end."
        collection="leave-types"
        objectPath={editing?.path}
        guardLabel="leave type"
        form={form}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={!!form.name.trim()}
        whyNot="Give the leave type a name."
        onSubmit={submit}
        className="sm:max-w-2xl lg:max-w-4xl"
      >
          {/* `htmlFor` by hand: the field holds the colour swatch beside the input, so Field has no single
              child to bind its label to and the label named nothing. */}
          <Field label="Name" htmlFor="leave-type-name" info="The color sets this type's pills on the calendar/timeline. Click the swatch to change it; 'Auto' picks a stable color.">
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Choose color"
                    className="h-9 w-9 shrink-0 rounded-md border ring-offset-2 transition hover:ring-2 hover:ring-ring"
                    style={{ backgroundColor: leaveColor(form.color || null, editing?.path) }}
                  />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2">
                  <div className="grid grid-cols-6 gap-2">
                    {LEAVE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={c}
                        onClick={() => setForm({ ...form, color: form.color === c ? "" : c })}
                        className={cn("h-7 w-7 rounded-full ring-offset-2 transition", form.color === c && "ring-2 ring-ring")}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, color: "" })}
                    className="mt-2 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
                  >
                    {form.color ? "Reset to auto color" : "Auto color (in use)"}
                  </button>
                </PopoverContent>
              </Popover>
              <Input id="leave-type-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Annual Leave" autoFocus />
            </div>
          </Field>
          <FieldRow>
            <Field label="Accrual days per year" info="Days added to balance over a full year.">
              <Input type="number" min={0} value={form.accrual} onChange={(e) => setForm({ ...form, accrual: e.target.value })} />
            </Field>
            <Field label="Accrual frequency" info={form.frequency === "semi_monthly" ? "Half the monthly amount credited on the 1st and 16th." : "The full month's amount credited on the 1st."}>
              <Select value={form.frequency} onValueChange={(v) => setForm({ ...form, frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="semi_monthly">Twice a month (1st &amp; 16th)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          <div className="flex items-center gap-2">
            <Checkbox id="paid" checked={form.paid} onCheckedChange={(v) => setForm({ ...form, paid: v === true })} />
            <Label htmlFor="paid">Paid leave</Label>
          </div>
          {/* Three independent policies, each a short panel: side by side on a wide dialog they read as the
              alternatives they are, instead of a column taller than the screen. */}
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border p-3 space-y-3">
              <p className="text-sm font-medium">Probation policy</p>
              <div className="flex items-center gap-2">
                <Checkbox id="probation" checked={form.probation} onCheckedChange={(v) => setForm({ ...form, probation: v === true })} />
                <Label htmlFor="probation">Can be requested during probation</Label>
              </div>
              <FieldRow>
                <Field label="Probation accrual / year" info="Accrual rate while on probation (0 = none).">
                  <Input type="number" min={0} value={form.probationAccrual} onChange={(e) => setForm({ ...form, probationAccrual: e.target.value })} />
                </Field>
                <Field label="Probation cap (days)" info="Max takeable on probation. Blank = no cap.">
                  <Input type="number" min={0} value={form.probationCap} disabled={!form.probation} placeholder="No cap" onChange={(e) => setForm({ ...form, probationCap: e.target.value })} />
                </Field>
              </FieldRow>
            </div>
            <div className="rounded-lg border p-3 space-y-3">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium">Encashment policy</p>
                <InfoHint text="Caps may be overridden by a cumulative org-wide cap in Settings → Leave caps." />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="encashable" checked={form.encashable} onCheckedChange={(v) => setForm({ ...form, encashable: v === true })} />
                <Label htmlFor="encashable">Can be encashed (mid-employment cashout)</Label>
              </div>
              <FieldRow>
                <Field label="Annual cap (days)" info="Max encashable per calendar year. Blank = no cap.">
                  <Input type="number" min={0} value={form.encashCap} disabled={!form.encashable} placeholder="No cap" onChange={(e) => setForm({ ...form, encashCap: e.target.value })} />
                </Field>
                <Field label="Minimum balance retained" info="Balance may not be encashed below this.">
                  <Input type="number" min={0} value={form.minRetained} disabled={!form.encashable} onChange={(e) => setForm({ ...form, minRetained: e.target.value })} />
                </Field>
              </FieldRow>
            </div>
            <div className="rounded-lg border p-3 space-y-3">
              <p className="text-sm font-medium">Carry-forward policy</p>
              <div className="flex items-center gap-2">
                <Checkbox id="carryForward" checked={form.carryForward} onCheckedChange={(v) => setForm({ ...form, carryForward: v === true })} />
                <Label htmlFor="carryForward">Unused balance carries into the next calendar year</Label>
              </div>
              <Field label="Carry-forward cap (days)" info="Max days that carry over. Blank = no cap. Excess is auto-encashed or forfeited per Settings → Leave caps.">
                <Input type="number" min={0} value={form.carryForwardCap} disabled={!form.carryForward} placeholder="No cap" onChange={(e) => setForm({ ...form, carryForwardCap: e.target.value })} />
              </Field>
            </div>
          </div>
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{form.name.trim() || "This leave type"}:</span> {policySummary}.
          </p>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
  );
}
