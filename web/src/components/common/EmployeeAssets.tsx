import { useCallback, useEffect, useState } from "react";
import { Laptop, Plus } from "lucide-react";
import { get, patch } from "@/api";
import { formatDate } from "@/lib/utils";
import type { Asset } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/common/Field";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const STATUS_LABEL: Record<Asset["status"], string> = { in_stock: "In stock", assigned: "Assigned", repair: "In repair", retired: "Retired" };
const today = () => new Date().toISOString().slice(0, 10);

// The company assets assigned to this employee. Read-only by default; when the caller may write assets a
// "Assign asset" action lets them hand an in-stock item to this person without leaving the profile (a PATCH
// of the asset's assignee, the same edit the Assets inventory page makes). Return/reassign still lives there.
export function EmployeeAssets({ employeeId, employeeName, canAssign }: { employeeId: string; employeeName?: string; canAssign?: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Asset[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    get<{ results: Asset[] }>(`assets?employee=${encodeURIComponent("employees/" + employeeId)}`)
      .then((r) => setRows(r.results ?? []))
      .catch((e) => toast({ variant: "destructive", title: "Couldn't load assets", description: (e as Error).message }))
      .finally(() => setLoaded(true));
  }, [employeeId, toast]);

  useEffect(() => { load(); }, [load]);

  // --- assign an in-stock asset to this employee ---
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState<Asset[] | null>(null); // in-stock items, lazily fetched when the dialog opens
  const [pick, setPick] = useState("");
  const [on, setOn] = useState(today());
  const [busy, setBusy] = useState(false);

  function openAssign() {
    setPick(""); setOn(today()); setPool(null); setOpen(true);
    get<{ results: Asset[] }>("assets")
      .then((r) => setPool((r.results ?? []).filter((a) => a.status === "in_stock")))
      .catch((e) => { setPool([]); toast({ variant: "destructive", title: "Couldn't load stock", description: (e as Error).message }); });
  }

  async function assign() {
    const a = pool?.find((x) => x.path === pick);
    if (!a) return;
    setBusy(true);
    try {
      await patch(a.path, { assigned_to: `employees/${employeeId}`, status: "assigned", assigned_on: on || null }, a.etag);
      toast({ title: "Asset assigned", variant: "success" });
      setOpen(false);
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't assign asset", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          <AccessAction collection="assets" label="Assigned assets">
            <span className="flex items-center gap-2"><Laptop className="h-4 w-4 text-primary" /> Assigned assets</span>
          </AccessAction>
        </CardTitle>
        {canAssign && (
          <AccessAction collection="assets" label="Assign asset">
            <Button size="sm" variant="outline" onClick={openAssign}><Plus className="h-4 w-4" /> Assign asset</Button>
          </AccessAction>
        )}
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No assets assigned.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Tag</th><th className="py-2 pr-3 font-medium">Name</th><th className="py-2 pr-3 font-medium">Category</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 font-medium">Assigned</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-mono text-xs">{r.asset_tag || "-"}</td>
                  <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                  <td className="py-1.5 pr-3">{r.category ?? "-"}</td>
                  <td className="py-1.5 pr-3">{STATUS_LABEL[r.status] ?? r.status}</td>
                  <td className="py-1.5 text-muted-foreground">{r.assigned_on ? formatDate(r.assigned_on) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" onEnterSubmit={() => { if (!busy && pick) assign(); }}>
          <DialogHeader><DialogTitle>Assign asset{employeeName ? ` to ${employeeName}` : ""}</DialogTitle></DialogHeader>
          <Field label="Asset" hint="Only items currently in stock.">
            <Combobox
              value={pick}
              onValueChange={setPick}
              placeholder={pool === null ? "Loading…" : "Select an asset"}
              searchPlaceholder="Search stock…"
              options={(pool ?? []).map((a) => ({ value: a.path, label: `${a.asset_tag ? a.asset_tag + " · " : ""}${a.name}` }))}
            />
          </Field>
          {pool !== null && pool.length === 0 && <p className="text-sm text-muted-foreground">Nothing in stock. Add stock on the Assets page.</p>}
          <Field label="Assigned on"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={assign} loading={busy} disabled={!pick}>Assign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
