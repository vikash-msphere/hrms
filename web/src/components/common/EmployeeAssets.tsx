import { useCallback, useEffect, useMemo, useState } from "react";
import { Laptop, Plus, HandHeart, PackagePlus, X } from "lucide-react";
import { get, patch, invoke, create } from "@/api";
import { cn, formatDate, idOf } from "@/lib/utils";
import { useCollection } from "@/hooks/useCollection";
import type { Asset, AssetCategory, AssetRequest } from "@/types";
import { ASSET_STATUS_LABEL, ASSET_STATUS_TONE } from "@/lib/assetTags";
import { ASSET_REQUEST_STATE_LABEL, ASSET_REQUEST_STATE_TONE, isOpenAssetRequest as isOpen } from "@/lib/assetRequests";
import { AssetCustodyDialog } from "@/components/assets/AssetCustody";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { TableSkeleton } from "@/components/common/Skeletons";
import { Field } from "@/components/common/Field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY_REQUEST = { category: "", neededBy: "", justification: "" };

// The company assets assigned to this employee. Read-only by default; when the caller may write assets a
// "Assign asset" action lets them hand an in-stock item to this person without leaving the profile (a PATCH
// of the asset's assignee, the same edit the Assets inventory page makes). Return/reassign still lives there.
//
// When the viewer IS the holder, a row that has not been acknowledged yet offers the scan that settles it -
// this card is where people actually look at "my stuff", so the ask belongs here as well as on Assets.
//
// It is also where kit is ASKED for: "Request an asset" files an asset-request naming a category, and the
// person's open and recent requests are listed under their assets, because "what do I hold / what did I ask
// for" is one question. An approver looking at this card can hand over the actual thing from the same picker
// that assigns stock (`:issue`), which is what closes the request.
export function EmployeeAssets({
  employeeId, employeeName, canAssign, isSelf, title = "Assigned assets", requestNow, onRequestHandled,
}: {
  employeeId: string;
  employeeName?: string;
  canAssign?: boolean;
  isSelf?: boolean;
  title?: string;
  // Set by the profile page when the "+ New → Request an asset" quick action brought the person here: the tab
  // switches and the dialog is already open, so the action costs one click from anywhere in the app.
  requestNow?: boolean;
  onRequestHandled?: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Asset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirming, setConfirming] = useState<Asset | null>(null);
  // An asset names its category by reference; the catalog is small and cached, so the name costs nothing here.
  const { rows: categories } = useCollection<AssetCategory>("asset-categories");
  const catName = useCallback((p?: string) => (p ? categories.find((c) => idOf(c.path) === idOf(p))?.display_name ?? "" : ""), [categories]);

  const empRef = `employees/${employeeId}`;
  const [requests, setRequests] = useState<AssetRequest[]>([]);

  const load = useCallback(() => {
    get<{ results: Asset[] }>(`assets?employee=${encodeURIComponent(empRef)}`)
      .then((r) => setRows(r.results ?? []))
      .catch((e) => toast({ variant: "destructive", title: "Couldn't load assets", description: (e as Error).message }))
      .finally(() => setLoaded(true));
    // Requests share this card's one open: a person who cannot read them (no grant) just sees no section.
    get<{ results: AssetRequest[] }>(`asset-requests?employee=${encodeURIComponent(empRef)}`)
      .then((r) => setRequests(r.results ?? []))
      .catch(() => setRequests([]));
  }, [empRef, toast]);

  useEffect(() => { load(); }, [load]);

  // Open requests lead: a pending one is a decision somebody owes, an approved one is kit somebody owes.
  const sortedRequests = useMemo(
    () => [...requests].sort((a, b) => Number(isOpen(b.state)) - Number(isOpen(a.state)) || (b.create_time ?? "").localeCompare(a.create_time ?? "")),
    [requests],
  );

  // --- assign an in-stock asset to this employee (optionally as the hand-over that closes a request) ---
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState<Asset[] | null>(null); // in-stock items, lazily fetched when the dialog opens
  const [pick, setPick] = useState("");
  const [on, setOn] = useState(today());
  const [issuing, setIssuing] = useState<AssetRequest | null>(null);

  function openAssign(request?: AssetRequest) {
    setPick(""); setOn(today()); setPool(null); setIssuing(request ?? null); setOpen(true);
    get<{ results: Asset[] }>("assets")
      .then((r) => {
        const stock = (r.results ?? []).filter((a) => a.status === "in_stock");
        // Handing over against a request: offer that category first, since it is what was asked for.
        setPool(request?.category ? [...stock].sort((a, b) => Number(b.category === request.category) - Number(a.category === request.category)) : stock);
      })
      .catch((e) => { setPool([]); toast({ variant: "destructive", title: "Couldn't load stock", description: (e as Error).message }); });
  }

  async function assign() {
    const a = pool?.find((x) => x.path === pick);
    if (!a) return;
    // Issuing goes through the request's own verb: it closes the request AND assigns the asset, so the two
    // can never disagree about whether the person got something. A plain assignment is just the PATCH.
    if (issuing) {
      await invoke(issuing.path, "issue", issuing.etag, { asset: a.path });
      toast({ title: "Handed over - they now scan its tag to confirm", variant: "success" });
    } else {
      await patch(a.path, { assigned_to: empRef, status: "assigned", assigned_on: on || null }, a.etag);
      toast({ title: "Assigned - they now scan its tag to confirm", variant: "success" });
    }
    load();
  }

  // --- ask for kit ---
  const [reqOpen, setReqOpen] = useState(false);
  const [reqForm, setReqForm] = useState(EMPTY_REQUEST);
  const openRequest = useCallback(() => { setReqForm(EMPTY_REQUEST); setReqOpen(true); }, []);

  useEffect(() => {
    if (!requestNow) return;
    openRequest();
    onRequestHandled?.();
  }, [requestNow, openRequest, onRequestHandled]);

  async function submitRequest() {
    await create("asset-requests", {
      // Omitted for a self-request: the server files it under the caller, which is the same path every other
      // request type takes (and it keeps a plain employee off the owner-ref gate entirely).
      ...(isSelf ? {} : { employee: empRef }),
      category: reqForm.category,
      needed_by: reqForm.neededBy || null,
      justification: reqForm.justification.trim() || null,
    });
    toast({ title: "Request filed", description: "Your manager (or HR) decides it next.", variant: "success" });
    load();
  }

  async function withdraw(r: AssetRequest) {
    if (!(await confirmDecision(confirm, "cancel", `The request for ${catName(r.category) || "an asset"}`))) return;
    try {
      await invoke(r.path, "cancel");
      toast({ title: "Request withdrawn", variant: "success" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't withdraw the request", description: (e as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          <AccessAction collection="assets" label={title}>
            <span className="flex items-center gap-2"><Laptop className="h-4 w-4 text-primary" /> {title}</span>
          </AccessAction>
        </CardTitle>
        <div className="flex items-center gap-2">
          {isSelf && (
            <AccessAction collection="asset-requests" create label="Request an asset">
              <Button size="sm" variant="outline" onClick={openRequest}><PackagePlus className="h-4 w-4" /> Request an asset</Button>
            </AccessAction>
          )}
          {canAssign && (
            <AccessAction collection="assets" label="Assign asset">
              <Button size="sm" variant="outline" onClick={() => openAssign()}><Plus className="h-4 w-4" /> Assign asset</Button>
            </AccessAction>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <TableSkeleton rows={3} cols={5} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No assets assigned.</p>
        ) : (
          // "What kit do I hold" is a question people ask on a phone, so this one has to work there: below
          // `sm` the table stacks into labelled rows (`.table-stack`) rather than scrolling sideways inside
          // the card.
          <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
          <table className="table-stack w-full text-sm sm:min-w-[26rem]">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Tag</th><th className="py-2 pr-3 font-medium">Name</th><th className="py-2 pr-3 font-medium">Category</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 font-medium">Assigned</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} className="border-b last:border-0">
                  <td data-label="Tag" className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">{r.asset_tag || "-"}</td>
                  <td data-label="Name" className="py-1.5 pr-3 font-medium">{r.name}</td>
                  {/* Category used to fold away on a phone with its value repeated under the name; now that
                      the row stacks it simply becomes another labelled line, so there is nothing to fold. */}
                  <td data-label="Category" className="py-1.5 pr-3">{catName(r.category) || "-"}</td>
                  <td data-label="Status" className="py-1.5 pr-3">
                    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", ASSET_STATUS_TONE[r.status])}>{ASSET_STATUS_LABEL[r.status] ?? r.status}</span>
                    {isSelf && r.status === "pending_ack" && (
                      <Button size="sm" variant="outline" className="ml-2 h-6 px-2 text-[11px]" onClick={() => setConfirming(r)}><HandHeart className="h-3 w-3" /> Confirm</Button>
                    )}
                  </td>
                  <td data-label="Assigned" className="whitespace-nowrap py-1.5 text-muted-foreground">{r.assigned_on ? formatDate(r.assigned_on) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {/* Requests sit under the assets: "what I hold" and "what I asked for" are one question, and an
            approved request is visibly still owed until somebody hands the kit over. */}
        {sortedRequests.length > 0 && (
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{isSelf ? "My requests" : "Requests"}</p>
            <div className="space-y-2">
              {sortedRequests.map((r) => (
                <div key={r.path} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", ASSET_REQUEST_STATE_TONE[r.state])}>
                    {ASSET_REQUEST_STATE_LABEL[r.state] ?? r.state}
                  </span>
                  <span className="font-medium">{catName(r.category) || "Asset"}</span>
                  {r.needed_by && <span className="text-xs text-muted-foreground">needed by {formatDate(r.needed_by)}</span>}
                  {r.justification && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={r.justification}>{r.justification}</span>}
                  {r.decision_note && <span className="text-xs italic text-muted-foreground" title={r.decision_note}>“{r.decision_note}”</span>}
                  <span className="ml-auto flex items-center gap-2">
                    {r.state === "APPROVED" && r.access?.can?.includes("issue") && (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => openAssign(r)}><HandHeart className="h-3 w-3" /> Hand over</Button>
                    )}
                    {r.state === "PENDING" && r.access?.can?.includes("cancel") && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => withdraw(r)}><X className="h-3 w-3" /> Withdraw</Button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${issuing ? "Hand over an asset" : "Assign asset"}${employeeName ? ` to ${employeeName}` : ""}`}
        description={issuing ? `Closes their approved request for ${catName(issuing.category) || "an asset"}. They confirm receipt by scanning the tag.` : undefined}
        collection="assets"
        objectPath={pick || undefined}
        guardLabel={issuing ? "hand-over" : "assignment"}
        form={{ pick, on }}
        submitLabel={issuing ? "Hand over" : "Assign"}
        canSubmit={!!pick}
        whyNot="Pick the item being handed over."
        className="sm:max-w-md"
        onSubmit={assign}
      >
        <Field label="Asset" hint="Only items counted into stock - anything awaiting a check-in scan has to be verified first." field="assigned_to">
          <Combobox
            value={pick}
            onValueChange={setPick}
            placeholder={pool === null ? "Loading…" : "Select an asset"}
            searchPlaceholder="Search stock…"
            options={(pool ?? []).map((a) => ({ value: a.path, label: `${a.asset_tag ? a.asset_tag + " · " : ""}${a.name}${catName(a.category) ? ` · ${catName(a.category)}` : ""}` }))}
          />
        </Field>
        {pool !== null && pool.length === 0 && <p className="text-sm text-muted-foreground">Nothing in stock. Add stock on the Assets page.</p>}
        {/* The hand-over date is the request's own `issued_time`, so it is not asked for twice. */}
        {!issuing && <Field label="Assigned on" field="assigned_on"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>}
      </WriteDialog>

      <WriteDialog
        open={reqOpen}
        onClose={() => setReqOpen(false)}
        title="Request an asset"
        description="Say what kind of thing you need. Which one you get is inventory's call, and your manager or HR decides the request first."
        collection="asset-requests"
        guardLabel="request"
        form={reqForm}
        // A typed justification is the part worth keeping through a stray click or a phone switching apps.
        draftKey="asset-request"
        applyDraft={(d) => setReqForm({ ...EMPTY_REQUEST, ...d })}
        onStartOver={() => setReqForm(EMPTY_REQUEST)}
        submitLabel="Send request"
        canSubmit={!!reqForm.category}
        whyNot="Say what kind of thing you need."
        submitAccess={(b) => <AccessAction collection="asset-requests" create label="Request an asset">{b}</AccessAction>}
        className="sm:max-w-md"
        onSubmit={submitRequest}
      >
        <Field label="What do you need" field="category">
          <Select value={reqForm.category} onValueChange={(v) => setReqForm({ ...reqForm, category: v })}>
            <SelectTrigger><SelectValue placeholder="Pick a category" /></SelectTrigger>
            <SelectContent>
              {categories.filter((c) => !c.delete_time && !c.disabled).map((c) => (
                <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Needed by (optional)" field="needed_by"><Input type="date" value={reqForm.neededBy} onChange={(e) => setReqForm({ ...reqForm, neededBy: e.target.value })} /></Field>
        <Field label="Why you need it" hint="What an approver reads." field="justification">
          <Textarea rows={3} value={reqForm.justification} onChange={(e) => setReqForm({ ...reqForm, justification: e.target.value })} placeholder="e.g. My laptop can't run the build any more." />
        </Field>
      </WriteDialog>

      {confirming && <AssetCustodyDialog asset={confirming} mode="acknowledge" onClose={() => setConfirming(null)} onDone={load} />}
    </Card>
  );
}
