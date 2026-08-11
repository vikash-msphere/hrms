import { useMemo, useState } from "react";
import { Plus, Trash2, MoreHorizontal, Ban, Copy, Check, TriangleAlert } from "lucide-react";
import { create, remove, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { COLLECTION_GROUPS, labelOf } from "@/components/access/permMatrix";
import { AccessAction } from "@/components/access/AccessAction";
import type { ApiKey } from "@/types";

// Machine credentials. A key ACTS AS the person who created it and can only ever do LESS than they can - the
// scope below narrows their access, it never adds any. So the dangerous-looking control here is not the
// scope, it is who is allowed to open this panel at all.

const EXPIRY_OPTIONS = [
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

type Draft = {
  name: string;
  allCollections: boolean;
  collections: string[];
  maxLevel: "read" | "write" | "admin";
  allowVerbs: boolean;
  expiry: string;
};

const EMPTY_DRAFT: Draft = { name: "", allCollections: true, collections: [], maxLevel: "read", allowVerbs: false, expiry: "90" };

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "-");

function keyState(k: ApiKey): { label: string; variant: "muted" | "success" | "destructive" } {
  if (k.revoke_time) return { label: "Revoked", variant: "destructive" };
  if (k.expire_time && +new Date(k.expire_time) < Date.now()) return { label: "Expired", variant: "muted" };
  return { label: "Active", variant: "success" };
}

function scopeSummary(k: ApiKey): string {
  const s = k.scope;
  if (!s || !s.collections || !s.max_level) return "-";
  const cols = s.collections;
  const where = cols === "*" ? "all collections" : `${cols.length} collection${cols.length === 1 ? "" : "s"}`;
  const what = s.max_level === "read" ? "read only" : s.max_level === "write" ? "read & write" : "full access";
  return `${what}, ${where}`;
}

export function ApiKeysPanel({ controlsSlot }: { controlsSlot?: HTMLElement | null }) {
  const { rows: keys, reload } = useCollection<ApiKey>("api-keys");
  const canWrite = usePermission("api-keys.write");
  const canRevoke = usePermission("api-keys.revoke");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const columns: Column<ApiKey>[] = useMemo(
    () => [
      {
        id: "name", header: "Key", filter: "text", accessor: (k) => k.display_name ?? "",
        cell: (k) => (
          <span className="font-medium">
            {k.display_name}
            <span className="ml-2 font-mono text-xs text-muted-foreground">{k.masked_token}</span>
          </span>
        ),
      },
      {
        id: "state", header: "State", filter: "text", accessor: (k) => keyState(k).label,
        cell: (k) => {
          const s = keyState(k);
          return <Badge variant={s.variant} className="px-1.5 py-0 text-[10px]">{s.label}</Badge>;
        },
      },
      { id: "scope", header: "Scope", filter: "text", accessor: (k) => scopeSummary(k) },
      { id: "expires", header: "Expires", filter: "none", accessor: (k) => k.expire_time ?? "", cell: (k) => <span className="text-muted-foreground">{k.expire_time ? fmtDate(k.expire_time) : "Never"}</span> },
      { id: "last_used", header: "Last used", filter: "none", accessor: (k) => k.last_used_time ?? "", cell: (k) => <span className="text-muted-foreground">{fmtDate(k.last_used_time)}</span> },
      {
        id: "actions", header: "", sortable: false, filter: "none", align: "right",
        cell: (k) =>
          canWrite || canRevoke ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canRevoke && !k.revoke_time && (
                  <AccessAction collection="api-keys" objectPath={k.path} verb="revoke" label="Revoke API key">
                    <DropdownMenuItem onClick={() => revoke(k)}><Ban className="h-4 w-4" /> Revoke</DropdownMenuItem>
                  </AccessAction>
                )}
                {canWrite && (
                  <>
                    {canRevoke && !k.revoke_time && <DropdownMenuSeparator />}
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => del(k)}><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canWrite, canRevoke],
  );

  function toggleCollection(c: string) {
    setDraft((d) => ({ ...d, collections: d.collections.includes(c) ? d.collections.filter((x) => x !== c) : [...d.collections, c] }));
  }

  async function submit() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        display_name: draft.name.trim(),
        scope: {
          collections: draft.allCollections ? "*" : draft.collections,
          max_level: draft.maxLevel,
          verbs: draft.allowVerbs ? "*" : [],
        },
      };
      if (draft.expiry !== "never") {
        body.expire_time = new Date(Date.now() + Number(draft.expiry) * 24 * 60 * 60 * 1000).toISOString();
      }
      const created = await create<ApiKey>("api-keys", body);
      setOpen(false);
      setCopied(false);
      // The one and only time this value exists outside the caller's hands.
      setMinted(created.secret ?? null);
      reload();
    } catch (e) {
      toast({ title: "Couldn't create key", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKey) {
    const ok = await confirm({
      title: `Revoke "${k.display_name}"?`,
      description: "Anything using this key stops working immediately. The key stays listed so the activity trail can still name it.",
      destructive: true,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    try {
      await invoke(k.path, "revoke");
      toast({ title: "Key revoked", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't revoke", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function del(k: ApiKey) {
    const ok = await confirm({
      title: `Delete "${k.display_name}"?`,
      description: "Permanently removes the credential. Revoke instead if you want the activity trail to keep resolving it.",
      destructive: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await remove(k.path, k.etag);
      toast({ title: "Key deleted", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <DataTable
          columns={columns}
          tableId="api-keys"
          rows={keys}
          getRowId={(k) => k.path}
          rowClassName={() => "group"}
          emptyTitle="No API keys"
          toolbar={
            canWrite ? (
              <AccessAction collection="api-keys" create label="New API key">
                <Button size="sm" onClick={() => { setDraft(EMPTY_DRAFT); setOpen(true); }}><Plus className="h-4 w-4" /> New key</Button>
              </AccessAction>
            ) : undefined
          }
          controlsSlot={controlsSlot}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          A key acts as the person who created it, narrowed by its scope - it can never do more than they can. Revoking one takes effect on its very next request.
        </p>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
          </DialogHeader>

          <Field label="Name" hint="What will use this key, e.g. 'Nightly headcount export'.">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Data warehouse sync" autoFocus />
          </Field>

          <Field label="Access level" hint="The ceiling. It cannot exceed your own access.">
            <Select value={draft.maxLevel} onValueChange={(v) => setDraft({ ...draft, maxLevel: v as Draft["maxLevel"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="write">Read &amp; write</SelectItem>
                <SelectItem value="admin">Full access</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Expires">
            <Select value={draft.expiry} onValueChange={(v) => setDraft({ ...draft, expiry: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          <div className="flex items-center gap-2">
            <Checkbox id="key-all-collections" checked={draft.allCollections} onCheckedChange={(v) => setDraft({ ...draft, allCollections: v === true })} />
            <Label htmlFor="key-all-collections">Every collection</Label>
          </div>

          {!draft.allCollections && (
            <div className="max-h-56 overflow-y-auto rounded-md border p-2">
              {COLLECTION_GROUPS.map((g) => (
                <div key={g.label} className="mb-2 last:mb-0">
                  <p className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.label}</p>
                  {g.collections.map((c) => (
                    <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
                      <Checkbox checked={draft.collections.includes(c)} onCheckedChange={() => toggleCollection(c)} />
                      <span className="text-sm">{labelOf(c)}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox id="key-verbs" checked={draft.allowVerbs} onCheckedChange={(v) => setDraft({ ...draft, allowVerbs: v === true })} />
            <Label htmlFor="key-verbs">Allow actions (approve, cancel, download, …)</Label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!draft.name.trim() || (!draft.allCollections && draft.collections.length === 0)}>Create key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The secret is shown once and is unrecoverable, so this dialog is deliberately blunt about it. */}
      <Dialog open={!!minted} onOpenChange={(o) => !o && setMinted(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Copy your key now</DialogTitle>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>This is the only time this key is shown. It is stored one-way, so it cannot be recovered - if you lose it, delete this key and create another.</p>
          </div>
          <div className="flex items-center gap-2">
            <Input readOnly value={minted ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              size="icon"
              onClick={async () => {
                await navigator.clipboard.writeText(minted ?? "");
                setCopied(true);
                toast({ title: "Key copied", variant: "success" });
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send it as <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
          </p>
          <DialogFooter>
            <Button onClick={() => setMinted(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
