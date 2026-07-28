import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Plus, Check } from "lucide-react";
import { create, patch, get, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf, cn } from "@/lib/utils";
import type { Holiday, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// The viewer's LOCAL calendar date (toISOString would flip to UTC's date around midnight).
const todayStr = () => new Date().toLocaleDateString("en-CA");
// Weekday of a ymd date ("Fri") - parsed as UTC so the label never shifts with the viewer's offset.
const weekdayOf = (ymd: string) => new Date(ymd.slice(0, 10) + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10) + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
const inDaysLabel = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

export default function Holidays({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Holiday>("holidays", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("holidays", "holiday", reload);
  const lc = useLifecycle("holidays", "holiday", reload);
  const writable = usePermission("holidays.write");
  const canPurge = usePermission("holidays.admin");
  const isEmployee = !!me.employee_id;

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [form, setForm] = useState({ name: "", date: "", kind: "fixed" });
  const [selBusy, setSelBusy] = useState(""); // path of the row whose selection is being toggled
  const [year, setYear] = useState(String(new Date().getFullYear()));

  const [maxOptional, setMaxOptional] = useState(2);

  async function loadPolicy() {
    try {
      const s = await get<{ value?: { max_optional?: number } }>("settings/holidays");
      if (typeof s.value?.max_optional === "number") setMaxOptional(s.value.max_optional);
    } catch {
      /* no setting yet -> default */
    }
  }
  useEffect(() => {
    loadPolicy();
  }, []);

  const selectedCount = useMemo(() => rows.filter((h) => h.kind === "optional" && h.selected).length, [rows]);
  const atLimit = selectedCount >= maxOptional;

  const today = todayStr();
  // Year framing: chips for each year present in the data; default to the current year when it exists.
  const years = useMemo(() => [...new Set(rows.map((h) => h.date.slice(0, 4)))].sort().reverse(), [rows]);
  const activeYear = years.includes(year) ? year : "";
  // Upcoming first (soonest at the top), then past newest-first; deleted rows sink to the bottom.
  const shown = useMemo(() => {
    const inYear = rows.filter((h) => !activeYear || h.date.slice(0, 4) === activeYear);
    const live = inYear.filter((h) => !h.delete_time);
    const upcoming = live.filter((h) => h.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past = live.filter((h) => h.date < today).sort((a, b) => b.date.localeCompare(a.date));
    return [...upcoming, ...past, ...inYear.filter((h) => h.delete_time)];
  }, [rows, activeYear, today]);
  // "Next holiday" answers "when is my next day OFF": for employees an unpicked optional holiday
  // isn't a day off, so it only counts when selected (admins without an employee record see all).
  const nextHoliday = useMemo(
    () =>
      rows
        .filter((h) => !h.delete_time && !h.disabled && h.date >= today)
        .filter((h) => h.kind !== "optional" || !isEmployee || !!h.selected)
        .sort((a, b) => a.date.localeCompare(b.date))[0],
    [rows, today, isEmployee],
  );
  const upcomingCount = useMemo(() => shown.filter((h) => !h.delete_time && !h.disabled && h.date >= today).length, [shown, today]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", date: "", kind: "fixed" });
    setOpen(true);
  }
  function openEdit(h: Holiday) {
    setEditing(h);
    setForm({ name: h.display_name, date: h.date, kind: h.kind ?? "fixed" });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      const body = { display_name: form.name, date: form.date, kind: form.kind };
      if (editing) {
        await patch("holidays/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Holiday updated", variant: "success" });
      } else {
        await create("holidays", body);
        toast({ title: "Holiday added", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save holiday", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleSelect(h: Holiday) {
    setSelBusy(h.path);
    try {
      if (h.selected && h.selection) {
        await remove(h.selection);
        toast({ title: `Deselected ${h.display_name}`, variant: "success" });
      } else {
        await create("holiday-selections", { holiday: h.path });
        toast({ title: `Selected ${h.display_name}`, variant: "success" });
      }
      reload();
    } catch (e) {
      toast({ title: "Couldn't update selection", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSelBusy("");
    }
  }

  const columns: Column<Holiday>[] = [
    { id: "name", header: "Holiday", accessor: (h) => h.display_name, cell: (h) => <span className="font-medium">{h.display_name}</span> },
    // Weekday up front: "is it a long weekend" is half of why anyone opens this page.
    { id: "date", header: "Date", accessor: (h) => h.date, cell: (h) => `${weekdayOf(h.date)}, ${formatDate(h.date)}` },
    {
      id: "kind",
      header: "Type",
      filter: "select",
      accessor: (h) => (h.kind === "optional" ? "Optional" : "Fixed"),
      cell: (h) => <Badge variant={h.kind === "optional" ? "warning" : "secondary"}>{h.kind === "optional" ? "Optional" : "Fixed"}</Badge>,
    },
    {
      id: "when",
      header: "When",
      filter: "select",
      accessor: (h) => (h.date >= today ? "Upcoming" : "Past"),
      cell: (h) => <Badge variant={h.date >= today ? "secondary" : "muted"}>{h.date >= today ? "Upcoming" : "Past"}</Badge>,
    },
    stateColumn<Holiday>(),
    ...metaColumns<Holiday>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (h) => (
        <div className="flex items-center justify-end gap-2">
          {isEmployee && h.kind === "optional" && !h.delete_time && !h.disabled && (
            <AccessAction collection="holiday-selections" create label="Holiday selection">
              {!h.selected && atLimit ? (
                // A disabled button swallows its tooltip, so the why lives on a wrapping span.
                <span title={`You've used all ${maxOptional} optional picks - deselect one first`}>
                  <Button size="sm" variant="outline" disabled>Select</Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant={h.selected ? "secondary" : "outline"}
                  loading={selBusy === h.path}
                  onClick={() => toggleSelect(h)}
                  title={h.selected ? "Deselect this optional holiday" : "Take this as one of your optional holidays"}
                >
                  {h.selected ? (<><Check className="h-4 w-4" /> Selected</>) : "Select"}
                </Button>
              )}
            </AccessAction>
          )}
          <SoftDeleteRowActions row={h} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Holiday Calendar"
        description="Fixed holidays apply to everyone; optional ones you can pick from."
        actions={writable && <AccessAction collection="holidays" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add holiday</Button></AccessAction>}
      />

      {rows.length > 0 && (
        <SummaryStrip
          items={[
            {
              label: "Next holiday",
              icon: CalendarDays,
              value: <span className="text-base font-semibold">{nextHoliday ? nextHoliday.display_name : "None scheduled"}</span>,
              hint: nextHoliday ? `${weekdayOf(nextHoliday.date)}, ${formatDate(nextHoliday.date)} · ${inDaysLabel(daysBetween(today, nextHoliday.date))}` : undefined,
            },
            { label: activeYear ? `Upcoming in ${activeYear}` : "Upcoming", value: upcomingCount, tone: upcomingCount ? "primary" : "muted" },
            ...(isEmployee
              ? [{
                  label: "Optional picks",
                  value: `${selectedCount} of ${maxOptional}`,
                  tone: atLimit ? ("warning" as const) : ("default" as const),
                  hint: atLimit ? "All picks used - deselect one to swap" : "Select optional holidays below",
                }]
              : []),
          ]}
        />
      )}

      {years.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {["", ...years].map((y) => (
            <button
              key={y || "all"}
              type="button"
              onClick={() => setYear(y)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                activeYear === y ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {y || "All years"}
            </button>
          ))}
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No holidays set"
            description="Add public and company holidays so everyone can plan ahead."
            action={writable && <AccessAction collection="holidays" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add holiday</Button></AccessAction>}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="holidays"
            rows={shown}
            getRowId={(h) => h.path}
            rowClassName={(h) => (h.delete_time || h.date < today ? "opacity-60" : undefined)}
            emptyTitle={activeYear ? `No holidays in ${activeYear}` : "No holidays match"}
            accessCollection="holidays"
            accessTargetOf={(h) => ({ objectPath: h.path, label: h.display_name, can: h.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim() && form.date) submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit holiday" : "Add holiday"}</DialogTitle>
          </DialogHeader>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. New Year's Day" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date">
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
            <Field label="Type" hint="Fixed applies to all; optional is pickable.">
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="optional">Optional</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !form.date}>{editing ? "Save changes" : "Add holiday"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
