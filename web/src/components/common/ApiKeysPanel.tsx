import { useMemo, useState } from "react";
import { Plus, Trash2, MoreHorizontal, Ban, Copy, Check, TriangleAlert, RefreshCw, Pencil, History, RotateCcw } from "lucide-react";
import { create, patch, invoke } from "@/api";
import { describeError } from "@/lib/formError";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useDebounced } from "@/hooks/useDebounced";
import { useCanSeeActivity, usePermission } from "@/lib/perm";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WriteDialog } from "@/components/common/WriteDialog";
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

// Months, not day counts. Nobody decides a credential should live for 90 days - they decide "a quarter", and
// "90 days" is that decision already converted, badly: it lands on a different day of the month than the one
// anybody would diarise, and 6 months is 180 days only twice a decade. The presets are months and resolve to
// the SAME day of a later month, so the date read back is the one that was meant.
//
// `custom` takes any future date, because the server always did and a key's real life is usually somebody
// else's date - an audit window, a contract end, a migration cutover. With only fixed spans on offer, all of
// those became "Never".
const CUSTOM_EXPIRY = "custom";
const EXPIRY_OPTIONS = [
  { value: "1", label: "1 month" },
  { value: "2", label: "2 months" },
  { value: "3", label: "3 months" },
  { value: "6", label: "6 months" },
  { value: "12", label: "1 year" },
  { value: CUSTOM_EXPIRY, label: "Custom date" },
  { value: "never", label: "Never" },
];

// The same day of the month, n months on. A month-end date has no counterpart in a shorter month (31 Jan + 1),
// so it falls back to that month's last day instead of rolling into the next one - "1 month" must never
// quietly mean "1 month and 3 days".
function addMonths(from: Date, n: number): Date {
  const d = new Date(from);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

type Draft = {
  name: string;
  description: string;
  allCollections: boolean;
  collections: string[];
  maxLevel: "read" | "write" | "admin";
  allowVerbs: boolean;
  expiry: string;
  /** The chosen day, when `expiry` is `custom`. Empty until one is picked. */
  expiryDate: string;
};

const EMPTY_DRAFT: Draft = { name: "", description: "", allCollections: true, collections: [], maxLevel: "read", allowVerbs: false, expiry: "3", expiryDate: "" };
// The earliest a key may expire: the server refuses anything not in the future, so the picker starts tomorrow.
const minExpiryDate = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "-");

function keyState(k: ApiKey): { label: string; variant: "muted" | "success" | "destructive" } {
  // Trash first, like `primaryState`: a deleted key is gone whatever else it was, and the row is only here so
  // its trail still resolves.
  if (k.delete_time) return { label: "Deleted", variant: "muted" };
  if (k.revoke_time) return { label: "Revoked", variant: "destructive" };
  if (k.expire_time && +new Date(k.expire_time) < Date.now()) return { label: "Expired", variant: "muted" };
  return { label: "Active", variant: "success" };
}

const DAY = 24 * 60 * 60 * 1000;

// The two ways a live key becomes a 3am outage: it quietly expires, or it has not been used for so long that
// nobody remembers what it was for (and revoking it is a guess). Both are computable from the row - they were
// simply never said out loud, so a key expiring on Friday looked exactly like one expiring next year.
function keyWarning(k: ApiKey): { label: string; title: string } | null {
  if (k.revoke_time || k.delete_time) return null;
  const expiresIn = k.expire_time ? +new Date(k.expire_time) - Date.now() : null;
  if (expiresIn !== null && expiresIn > 0 && expiresIn <= 14 * DAY) {
    const days = Math.max(1, Math.round(expiresIn / DAY));
    return { label: `expires in ${days}d`, title: "Whatever uses this key stops working on that date. Rotate it before then." };
  }
  if (expiresIn !== null && expiresIn <= 0) return null; // already expired: the state badge says so
  if (!k.last_used_time) {
    const age = k.create_time ? Date.now() - +new Date(k.create_time) : 0;
    return age > 30 * DAY ? { label: "never used", title: "Created over a month ago and never used. If nothing needs it, delete it." } : null;
  }
  const idle = Date.now() - +new Date(k.last_used_time);
  return idle > 90 * DAY ? { label: `idle ${Math.round(idle / DAY)}d`, title: "Not used in over 90 days. A credential nobody uses is only a risk." } : null;
}

// THE ACTIONS AXIS BELONGS IN THIS SENTENCE, and leaving it out was the one way to be actively misled by it.
//
// A scope has three axes and `max_level` is only one of them: custom methods are gated by `verbs`, and a key
// that carries them can approve a leave request or publish a payroll run. The level ceiling DOES bound them -
// a verb counts as a write, so a read-ceilinged scope holds no verbs at all (domain/keyScope.ts
// `verbsAllowedAt`, enforced in `inScope`, in `narrowAllow`, in `parseScope` on the way back, and refused at
// mint by services/apiKeys.ts) - but naming only the level still called such a key "read & write, all
// collections" and left the actions unsaid. The mint dialog is honest about it (a separate checkbox, off by
// default, disabled at read, and the pre-mint sentence ends "· actions allowed"); the list a person actually
// audits keys in was not, and the list is where a key minted months ago gets looked at.
//
// Same clause and same words as the mint sentence, so what was authored and what is listed read the same -
// which is what the comment beside `scopeSentence` already claimed and this is what makes true.
function scopeSummary(k: ApiKey): string {
  const s = k.scope;
  if (!s || !s.collections || !s.max_level) return "-";
  const cols = s.collections;
  const where = cols === "*" ? "all collections" : `${cols.length} collection${cols.length === 1 ? "" : "s"}`;
  const what = s.max_level === "read" ? "read only" : s.max_level === "write" ? "read & write" : "full access";
  // `verbs` is "*" or an allowlist; an empty list is the lock, so anything else can perform actions.
  const actions = s.verbs === "*" || (Array.isArray(s.verbs) && s.verbs.length > 0);
  return `${what}, ${where}${actions ? " · actions" : ""}`;
}

export function ApiKeysPanel({ controlsSlot }: { controlsSlot?: HTMLElement | null }) {
  // Deleted keys are their own view, reached by picking "Deleted" in the State filter - the column below
  // offers that value whether or not any is loaded, and this is how the page learns to go and fetch them.
  // They are never mixed in by default: a page caps at 100 rows, so carrying the trash always would spend
  // that budget - and a viewer's D1 reads - on rows nobody asked for, and could push live keys off the page.
  const [stateFilter, setStateFilter] = useState("");
  const deletedOnly = stateFilter === "Deleted";
  const { rows: keys, reload, loadMore } = useCollection<ApiKey>("api-keys", { deletedOnly });
  // The column filters run over the rows above, and a list page caps at 100 - so past that they can only
  // filter a window. This box is the way out: the query goes to the SERVER, which matches over the whole
  // collection, and the table shows those rows instead. Off below two characters, so the common case (a
  // handful of keys, all on one page) stays a purely local filter with no extra request.
  const [search, setSearch] = useState("");
  const debouncedQ = useDebounced(search.trim(), 250);
  const searching = debouncedQ.length >= 2;
  const { rows: searchRows, loadMore: loadMoreSearch } = useCollection<ApiKey>("api-keys", { deletedOnly, q: debouncedQ, enabled: searching });
  const canWrite = usePermission("api-keys.write");
  const canRevoke = usePermission("api-keys.revoke");
  const { toast } = useToast();
  const confirm = useConfirm();
  const canSeeActivity = useCanSeeActivity("api-keys");

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Kept out of the draft on purpose: filtering the collection list is not an edit, so the discard guard must
  // not read it as one.
  const [colFilter, setColFilter] = useState("");
  // The key being renamed, and the two fields a PATCH may touch.
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [labels, setLabels] = useState({ name: "", description: "" });
  // The key whose activity is open. Its own dialog rather than a fold inside the edit form: reading a trail
  // and editing a record are different errands, and the trail is the longer of the two.
  const [activityFor, setActivityFor] = useState<ApiKey | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const columns: Column<ApiKey>[] = useMemo(
    () => [
      {
        // The description is searchable too: "which key was the warehouse one?" is answered by what it does,
        // not by a name somebody chose a year ago.
        id: "name", header: "Key", filter: "text", accessor: (k) => `${k.display_name ?? ""} ${k.description ?? ""}`.trim(),
        cell: (k) => (
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">
              {k.display_name}
              <span className="ml-2 font-mono text-xs text-muted-foreground">{k.masked_token}</span>
            </span>
            {k.description && <span className="truncate text-xs text-muted-foreground" title={k.description}>{k.description}</span>}
          </span>
        ),
      },
      {
        // "Deleted" is offered even with none loaded: it is a value whose rows arrive only once it is picked.
        id: "state", header: "State", filter: "select", filterOptions: ["Deleted"], accessor: (k) => keyState(k).label,
        cell: (k) => {
          const s = keyState(k);
          const w = keyWarning(k);
          return (
            <span className="flex flex-wrap items-center gap-1">
              <Badge variant={s.variant} className="px-1.5 py-0 text-[10px]">{s.label}</Badge>
              {w && (
                <Badge variant="muted" className="gap-1 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-400" title={w.title}>
                  <TriangleAlert className="h-3 w-3" /> {w.label}
                </Badge>
              )}
            </span>
          );
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
                <Button variant="ghost" size="icon" aria-label="API key actions" className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:h-9 coarse:w-9">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* A deleted row gets the trash menu and nothing else - the same shape SoftDeleteRowActions
                    gives every other collection. Its Activity stays, because a dead credential's trail is the
                    whole reason the row was kept rather than destroyed. */}
                {k.delete_time ? (
                  <>
                    {canSeeActivity && (
                      <DropdownMenuItem onClick={() => setActivityFor(k)}><History className="h-4 w-4" /> Activity</DropdownMenuItem>
                    )}
                    {canWrite && (
                      <DropdownMenuItem onClick={() => softDelete.restore(k)}><RotateCcw className="h-4 w-4" /> Restore</DropdownMenuItem>
                    )}
                    {canWrite && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => softDelete.permanentlyDelete(k)}>
                          <Trash2 className="h-4 w-4" /> Delete permanently
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {/* A revoked key's record is closed: the server refuses the edit, so the affordance goes
                        too rather than offering an action that can only fail. */}
                    {canWrite && !k.revoke_time && (
                      <DropdownMenuItem onClick={() => openEdit(k)}><Pencil className="h-4 w-4" /> Edit details</DropdownMenuItem>
                    )}
                    {canSeeActivity && (
                      <DropdownMenuItem onClick={() => setActivityFor(k)}><History className="h-4 w-4" /> Activity</DropdownMenuItem>
                    )}
                    {canWrite && canRevoke && !k.revoke_time && (
                      <DropdownMenuItem onClick={() => rotate(k)}><RefreshCw className="h-4 w-4" /> Rotate</DropdownMenuItem>
                    )}
                    {canRevoke && !k.revoke_time && (
                      <AccessAction collection="api-keys" objectPath={k.path} can={k.access?.can} verb="revoke" label="Revoke API key">
                        <DropdownMenuItem onClick={() => revoke(k)}><Ban className="h-4 w-4" /> Revoke</DropdownMenuItem>
                      </AccessAction>
                    )}
                    {canWrite && (
                      <>
                        {canRevoke && !k.revoke_time && <DropdownMenuSeparator />}
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => softDelete.softDelete(k)}><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    // The row actions close over the handlers below, which are redefined every render; the gating flags are
    // what actually change the menu, so they are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, canRevoke, canSeeActivity],
  );

  function toggleCollection(c: string) {
    setDraft((d) => ({ ...d, collections: d.collections.includes(c) ? d.collections.filter((x) => x !== c) : [...d.collections, c] }));
  }

  // Module groups narrowed by the filter box; a group with nothing matching drops out entirely rather than
  // leaving an empty heading behind.
  const shownGroups = useMemo(() => {
    const q = colFilter.trim().toLowerCase();
    return COLLECTION_GROUPS.map((g) => [g.label, q ? g.collections.filter((c) => labelOf(c).toLowerCase().includes(q) || c.includes(q)) : g.collections] as const).filter(
      ([, cols]) => cols.length > 0,
    );
  }, [colFilter]);

  // A call that works as pasted, against this deployment's own origin.
  const curlSnippet = `curl -H "Authorization: Bearer ${minted ?? "<key>"}" \\\n  ${location.origin}/v1/employees`;

  // The end of the chosen day, so a key picked to die "on the 31st" works all through the 31st - the same
  // reading the ACL modal's expiry gives a temporary grant.
  const expiresOn =
    draft.expiry === "never" ? null
    : draft.expiry === CUSTOM_EXPIRY ? (draft.expiryDate ? new Date(`${draft.expiryDate}T23:59:59`) : null)
    : addMonths(new Date(), Number(draft.expiry));
  // One sentence for the whole scope, in the same words the list column uses, so what was authored and what
  // is listed afterwards read the same.
  const scopeSentence = [
    draft.maxLevel === "read" ? "read" : draft.maxLevel === "write" ? "read & write" : "read, write and administer",
    draft.allCollections ? "every collection" : `${draft.collections.length} collection${draft.collections.length === 1 ? "" : "s"}`,
    draft.allowVerbs ? "· actions allowed" : "· no actions",
    expiresOn ? `· until ${fmtDate(expiresOn.toISOString())}` : "· no expiry",
  ].join(" ");

  // Throws to fail: WriteDialog pins the message in the form and keeps the scope that was picked.
  async function submit() {
    const body: Record<string, unknown> = {
      display_name: draft.name.trim(),
      description: draft.description.trim(),
      scope: {
        collections: draft.allCollections ? "*" : draft.collections,
        max_level: draft.maxLevel,
        verbs: draft.allowVerbs ? "*" : [],
      },
    };
    if (expiresOn) body.expire_time = expiresOn.toISOString();
    const created = await create<ApiKey>("api-keys", body);
    setCopied(false);
    // The one and only time this value exists outside the caller's hands.
    setMinted(created.secret ?? null);
    reload();
  }

  // Rotation, in one action.
  //
  // A key's scope is fixed at mint time (there is no PATCH, by design), so replacing one used to mean reading
  // its scope off the row, retyping it in the new-key form, and remembering to revoke the old one afterwards -
  // three steps where the middle one is a transcription and the last one gets forgotten. This mints a
  // same-scope replacement, shows the new secret, and revokes the old key only AFTER the new one exists.
  async function rotate(k: ApiKey) {
    const ok = await confirm({
      title: `Rotate "${k.display_name}"?`,
      description:
        "A new key with the same scope is created and shown once - paste it into whatever uses this credential. The old key is revoked immediately after, so anything still using it stops working. Rotate when you are ready to swap it over.",
      confirmLabel: "Create the replacement",
    });
    if (!ok) return;
    try {
      const s = k.scope;
      // The name IS the integration ("Data warehouse sync"), not this instance of its credential - so a
      // rotation keeps it. Suffixing compounds on every turn of the handle, and the prefix already tells two
      // generations apart.
      const body: Record<string, unknown> = {
        display_name: k.display_name,
        description: k.description ?? "",
        scope: { collections: s?.collections ?? "*", max_level: s?.max_level ?? "read", verbs: s?.verbs ?? [] },
      };
      // Carry the old key's remaining life forward as a fresh window of the same length, so rotating does not
      // silently turn a 90-day credential into a permanent one.
      if (k.expire_time && k.create_time) {
        const span = +new Date(k.expire_time) - +new Date(k.create_time);
        if (span > 0) body.expire_time = new Date(Date.now() + span).toISOString();
      }
      const created = await create<ApiKey>("api-keys", body);
      setCopied(false);
      setMinted(created.secret ?? null);
      // Only now is the old one taken out: a failed mint must never leave the caller with nothing working.
      //
      // CAUGHT SEPARATELY, because by this point the outcome is no longer "nothing happened". The new key
      // exists and its secret dialog is already open; a failed revoke used to put a red "Couldn't rotate" over
      // it, skip `reload()`, and leave the operator with two live credentials, one of which they could not find
      // again once the dialog closed.
      try {
        await invoke(k.path, "revoke");
        toast({ title: "Rotated - the old key is revoked", variant: "success" });
      } catch (e) {
        toast({
          title: "New key ready, old one still live",
          description: `${describeError(e)} The new key is on screen - copy it now, then revoke "${k.display_name}" from the list.`,
          variant: "destructive",
        });
      }
      reload();
    } catch (e) {
      toast({ title: "Couldn't rotate", description: describeError(e), variant: "destructive" });
    }
  }

  // Leaving without copying throws the secret away for good, so that one exit asks first. Once it has been
  // copied, closing is ordinary and passes straight through.
  async function closeMinted() {
    if (
      !copied &&
      !(await confirm({
        title: "Close without copying the key?",
        description: "The key is not stored anywhere it can be read again. Close this and the only way to get one is to delete this key and create another.",
        confirmLabel: "Close anyway",
        destructive: true,
      }))
    )
      return;
    setMinted(null);
  }

  function openEdit(k: ApiKey) {
    setEditing(k);
    setLabels({ name: k.display_name ?? "", description: k.description ?? "" });
  }

  // Renaming and re-describing a key, which is all a PATCH may touch. Its scope, owner and expiry are fixed
  // at mint time, so the labels are the only part that can be wrong AND fixable - and getting them wrong is
  // otherwise permanent for the life of the credential.
  async function saveLabels() {
    if (!editing) return;
    await patch(editing.path, { display_name: labels.name.trim(), description: labels.description.trim() || null }, editing.etag);
    toast({ title: "Key updated", variant: "success" });
    reload();
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

  // Delete is SOFT now, so it takes the shared flow every other collection uses: the row goes, the toast
  // carries an Undo, and the credential stops authenticating either way. Permanently removing one is the
  // separate, confirmed action inside that hook - and it is the only path that orphans the key's audit rows.
  const softDelete = useSoftDelete("api-keys", "key", reload);

  return (
    <Card>
      <CardContent className="pt-4 sm:pt-6">
        <DataTable
          columns={columns}
          tableId="api-keys"
          rows={searching ? searchRows : keys}
          getRowId={(k) => k.path}
          rowClassName={() => "group"}
          emptyTitle="No API keys"
          // The column filters run over the rows THIS table holds, and the server caps a list page at 100.
          // `accessCollection` is what makes the table admit that (a truncation notice instead of presenting
          // a window as the whole set), and `onLoadMore` is the way past it.
          accessCollection="api-keys"
          onLoadMore={searching ? loadMoreSearch : loadMore}
          search={{ value: search, onChange: setSearch, placeholder: "Search all keys…" }}
          toolbar={
            canWrite ? (
              <AccessAction collection="api-keys" create label="New API key">
                <Button size="sm" onClick={() => { setDraft(EMPTY_DRAFT); setOpen(true); }}><Plus className="h-4 w-4" /> New key</Button>
              </AccessAction>
            ) : undefined
          }
          onFilterChange={(colId, value) => colId === "state" && setStateFilter(value)}
          controlsSlot={controlsSlot}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          A key acts as the person who created it, narrowed by its scope - it can never do more than they can. Revoking one takes effect on its very next request.
        </p>
        {/* Who minted, renamed, rotated or revoked a credential, and when. This is the collection's trail
            rather than any one key's: a key that was deleted still has a history, and it is exactly the one
            worth reading. Loads only when opened. */}
        <ActivitySection entity="api-keys" label="Key activity" className="mt-4 border-t pt-4" />
      </CardContent>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="New API key"
        description="A machine credential that acts as you, narrowed by the scope below. The secret is shown once, at the end, and never again."
        collection="api-keys"
        guardLabel="key"
        form={draft}
        submitLabel="Create key"
        canSubmit={!!draft.name.trim() && (draft.allCollections || draft.collections.length > 0) && (draft.expiry !== CUSTOM_EXPIRY || !!draft.expiryDate)}
        whyNot={[
          !draft.name.trim() && "Name the key, so the activity trail can say which integration did something.",
          !draft.allCollections && draft.collections.length === 0 && "Pick at least one collection, or switch to every collection.",
          draft.expiry === CUSTOM_EXPIRY && !draft.expiryDate && "Pick the date the key should expire.",
        ]}
        onSubmit={submit}
        submitAccess={(b) => <AccessAction collection="api-keys" create label="New API key">{b}</AccessAction>}
        footerStart={<span className="truncate text-xs text-muted-foreground">{scopeSentence}</span>}
      >
          <Field label="Name" field="display_name" hint="What will use this key, e.g. 'Nightly headcount export'.">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Data warehouse sync" autoFocus />
          </Field>

          {/* A credential outlives the person who minted it, and the name alone never answers the question
              that matters at revoke time: who breaks if this stops working, and who do I ask first. */}
          <Field label="Description" field="description" hint="Optional. What it does and who to ask before revoking it.">
            <Textarea
              rows={2}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="e.g. Pulls headcount into the Finance warehouse nightly. Owner: Priya, Finance Systems."
            />
          </Field>

          <Field label="Access level" hint="The ceiling. It cannot exceed your own access.">
            {/* Dropping back to "Read only" clears the actions tick with it: a custom method is a write, so
                the server refuses that pair outright (src/domain/keyScope.ts). Clearing it here means the form
                cannot hold a combination the mint will reject, and the sentence below never promises one. */}
            <Select
              value={draft.maxLevel}
              onValueChange={(v) => {
                const maxLevel = v as Draft["maxLevel"];
                setDraft({ ...draft, maxLevel, allowVerbs: maxLevel === "read" ? false : draft.allowVerbs });
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="write">Read &amp; write</SelectItem>
                <SelectItem value="admin">Full access</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* The date, not the span: "3 months" is the question, "expires 21 Nov 2026" is the answer somebody
              has to diary. */}
          <Field
            label="Expires"
            hint={
              expiresOn ? `Stops working at the end of ${fmtDate(expiresOn.toISOString())}.`
              : draft.expiry === CUSTOM_EXPIRY ? "Pick the day it should stop working."
              : "Works until it is revoked or deleted."
            }
            error={draft.expiry === CUSTOM_EXPIRY && !draft.expiryDate ? "Pick a date." : undefined}
          >
            {/* The date sits BESIDE the picker, not under it. Revealing a second control below pushed the
                collections list and the footer down the moment "Custom date" was chosen, which moves the thing
                the reader is aiming at while they are still aiming at it. Same row, same height: choosing a
                custom date fills this field's width instead of growing the form. */}
            <div className="flex items-center gap-2">
              <Select value={draft.expiry} onValueChange={(v) => setDraft({ ...draft, expiry: v })}>
                <SelectTrigger className={draft.expiry === CUSTOM_EXPIRY ? "w-[9.5rem] shrink-0" : undefined}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {draft.expiry === CUSTOM_EXPIRY && (
                <Input
                  type="date"
                  className="min-w-0 flex-1"
                  autoFocus
                  value={draft.expiryDate}
                  min={minExpiryDate()}
                  onChange={(e) => setDraft({ ...draft, expiryDate: e.target.value })}
                />
              )}
            </div>
          </Field>

          <Field
            label="Collections"
            hint="Which parts of the API this key may touch."
            action={
              !draft.allCollections && draft.collections.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, collections: [] })}>Clear {draft.collections.length}</Button>
              ) : undefined
            }
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox id="key-all-collections" checked={draft.allCollections} onCheckedChange={(v) => setDraft({ ...draft, allCollections: v === true })} />
                <Label htmlFor="key-all-collections" className="font-normal">Every collection</Label>
              </div>

              {!draft.allCollections && (
                <>
                  {/* Sixty checkboxes is a wall to scroll, and the one collection the integration needs is
                      somewhere in it. Filtering by name, plus a whole-module toggle, is how a scope gets
                      picked in two actions instead of twenty. */}
                  <Input className="h-8" placeholder="Filter collections…" value={colFilter} onChange={(e) => setColFilter(e.target.value)} />
                  <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
                    {shownGroups.map(([label, cols]) => {
                      const all = cols.every((c) => draft.collections.includes(c));
                      return (
                        <div key={label}>
                          <div className="flex items-center justify-between gap-2 px-1 py-1">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                            <button
                              type="button"
                              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  collections: all ? d.collections.filter((c) => !cols.includes(c)) : [...new Set([...d.collections, ...cols])],
                                }))
                              }
                            >
                              {all ? "none" : "all"}
                            </button>
                          </div>
                          {cols.map((c) => (
                            <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
                              <Checkbox checked={draft.collections.includes(c)} onCheckedChange={() => toggleCollection(c)} />
                              <span className="text-sm">{labelOf(c)}</span>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                    {shownGroups.length === 0 && <p className="px-1 py-2 text-sm text-muted-foreground">No collection matches "{colFilter}".</p>}
                  </div>
                </>
              )}
            </div>
          </Field>

          <div className="flex items-start gap-2">
            <Checkbox
              id="key-verbs"
              className="mt-0.5"
              aria-describedby="key-verbs-hint"
              disabled={draft.maxLevel === "read"}
              checked={draft.allowVerbs}
              onCheckedChange={(v) => setDraft({ ...draft, allowVerbs: v === true })}
            />
            {/* The hint stays OUT of the label: text inside one becomes part of the checkbox's accessible
                name, and a name carrying "Raise the access level…" makes this box answer to the same label
                as the Access level select above it. Described, not named. */}
            <span className="leading-snug">
              <Label htmlFor="key-verbs" className="font-normal">
                Allow actions (approve, cancel, download, …)
              </Label>
              <span id="key-verbs-hint" className="block text-xs text-muted-foreground">
                {draft.maxLevel === "read"
                  ? "Unavailable on a read-only key: an action runs a service, so it counts as a write. Raise the access level to allow actions."
                  : "Off by default: an integration that only reads or writes rows should not be able to approve a leave request or pay a run."}
              </span>
            </span>
          </div>

          {/* What the key will be able to do, in one sentence, before it exists. */}
          <p className="rounded-md border bg-muted/30 p-2.5 text-xs">
            <span className="font-medium">This key will be able to:</span> <span className="text-muted-foreground">{scopeSentence}</span>
          </p>
      </WriteDialog>

      {/* Editing reaches the LABELS and nothing else, and says so rather than leaving the reader to discover
          that the scope is greyed out. Changing what a key can do is a different act with a different cost:
          mint a replacement and revoke this one - which is what Rotate does. */}
      <WriteDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit key"
        description="What this credential is called and what it's for. Its access, owner and expiry were fixed when it was minted."
        collection="api-keys"
        objectPath={editing?.path}
        guardLabel="key"
        form={labels}
        submitLabel="Save changes"
        canSubmit={
          !editing?.revoke_time &&
          !!labels.name.trim() &&
          (labels.name.trim() !== (editing?.display_name ?? "") || labels.description.trim() !== (editing?.description ?? ""))
        }
        whyNot={[
          !!editing?.revoke_time && "This key has been revoked, so its record is closed.",
          !labels.name.trim() && "Give the key a name.",
          !!labels.name.trim() &&
            labels.name.trim() === (editing?.display_name ?? "") &&
            labels.description.trim() === (editing?.description ?? "") &&
            "Nothing has changed yet.",
        ]}
        onSubmit={saveLabels}
        footerStart={editing ? <span className="truncate font-mono text-xs text-muted-foreground">{editing.masked_token}</span> : undefined}
      >
        <Field label="Name" field="display_name" hint="What uses this key.">
          <Input value={labels.name} onChange={(e) => setLabels({ ...labels, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Description" field="description" hint="Optional. What it does and who to ask before revoking it.">
          <Textarea
            rows={2}
            value={labels.description}
            onChange={(e) => setLabels({ ...labels, description: e.target.value })}
            placeholder="e.g. Pulls headcount into the Finance warehouse nightly. Owner: Priya, Finance Systems."
          />
        </Field>
        {editing && (
          <p className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Fixed at mint time:</span> {scopeSummary(editing)}
            {editing.expire_time ? `, expires ${fmtDate(editing.expire_time)}` : ", no expiry"}. To change what this key can
            do, rotate it - that mints a new secret and revokes this one.
          </p>
        )}
      </WriteDialog>

      {/* One key's trail, in its own dialog. Two tabs because they are two different questions: what was done
          TO the credential, and what the credential DID. The second is the one that decides whether revoking
          is safe. Radix unmounts the inactive tab, so only the feed on screen ever queries. */}
      <Dialog open={!!activityFor} onOpenChange={(o) => !o && setActivityFor(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-muted-foreground" /> Activity · {activityFor?.display_name}
            </DialogTitle>
            <DialogDescription>
              {activityFor?.description || "What has happened to this credential, and what it has been used to do."}
            </DialogDescription>
          </DialogHeader>
          {activityFor && (
            <Tabs defaultValue="history">
              <TabsList>
                <TabsTrigger value="history">History of this key</TabsTrigger>
                <TabsTrigger value="did">What this key did</TabsTrigger>
              </TabsList>
              <TabsContent value="history">
                <ActivityFeed resource={activityFor.path} />
              </TabsContent>
              <TabsContent value="did">
                {/* A key acts as its owner, so these rows name that human - which is exactly why they need
                    their own view: without it they are indistinguishable from what that person did by hand. */}
                <ActivityFeed global apiKey={activityFor.path} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* The secret is shown once and is unrecoverable, so this dialog is deliberately blunt about it - and,
          unlike every other dialog in the app, it does not close by accident: Esc, the overlay and the X all
          go through a confirm until the key has been copied. Closing this one is the only irreversible thing
          in the panel. */}
      <Dialog open={!!minted} onOpenChange={(o) => { if (!o) void closeMinted(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your key now</DialogTitle>
            <DialogDescription>{draft.name.trim() || "This key"} is ready. Paste it into whatever will use it before you leave this dialog.</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>This is the only time this key is shown. It is stored one-way, so it cannot be recovered - if you lose it, delete this key and create another.</p>
          </div>
          {/* BLOCKED from session replay, not masked. This dialog's own copy says what the value is - "a
              machine credential that acts as you" - and the secret is shown once and is unrecoverable, so a
              leak here has no rotation prompted by discovery. Replay is unmask-by-default (instrument.ts) and
              nothing else reaches this: the input has no `name` and no `type` for the field rules to match,
              Settings is not a SENSITIVE_PAGES route, and a dialog renders through a portal outside
              `<main data-page="…">` in any case. `block` removes the node from the recording rather than
              substituting characters, which is the right instrument for a live credential. */}
          <div className="flex items-center gap-2" data-sentry-block>
            <Input readOnly value={minted ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant={copied ? "outline" : "default"}
              // `writeText` REJECTS on a non-secure context, an unfocused document or a denied permission, and
              // this is the one dialog in the app whose copy says the value cannot be recovered. Unhandled, the
              // rejection meant `setCopied` never ran, no toast appeared, and the button looked dead - with the
              // rejection surfacing in Sentry instead of on screen. The thirteen other copy sites in the app
              // already use this both-toasts shape.
              onClick={() =>
                navigator.clipboard.writeText(minted ?? "").then(
                  () => {
                    setCopied(true);
                    toast({ title: "Key copied", variant: "success" });
                  },
                  () => toast({ title: "Couldn't copy the key", description: "Select the key above and copy it by hand - it cannot be shown again.", variant: "destructive" }),
                )
              }
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {/* A working call, not just the header's name: the next thing anybody does with a fresh key is prove
              it works, and assembling that from "send it as Authorization: Bearer" is a small papercut every
              single time. Copies with the real key in it - the same secret already on screen. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Try it</span>
              <Button
                variant="ghost"
                size="sm"
                // Both outcomes reported, as above - and `copied` only set when the copy actually happened,
                // since it is what lets `closeMinted` stop asking before it throws the secret away.
                onClick={() =>
                  navigator.clipboard.writeText(curlSnippet).then(
                    () => {
                      setCopied(true);
                      toast({ title: "Command copied", variant: "success" });
                    },
                    () => toast({ title: "Couldn't copy the command", description: "Select it below and copy it by hand.", variant: "destructive" }),
                  )
                }
              >
                <Copy className="h-3.5 w-3.5" /> Copy command
              </Button>
            </div>
            {/* The same secret, as DOM text rather than an input - so even `maskAllInputs` would not cover it.
                Blocked for the same reason as the field above. */}
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed" data-sentry-block>{curlSnippet}</pre>
          </div>
          <p className="text-xs text-muted-foreground">Scope: {scopeSentence}.</p>
          <DialogFooter>
            <Button variant={copied ? "default" : "outline"} onClick={() => void closeMinted()}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
