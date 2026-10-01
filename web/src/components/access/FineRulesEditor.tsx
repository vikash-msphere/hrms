import * as React from "react";
import { Trash2, Plus, AlertTriangle, Clock, Pencil } from "lucide-react";
import { create, remove } from "@/api";
import { roleLabel } from "@/lib/roles";
import { addDaysYmd, orgDayFromToday, orgTimezone, stampDay } from "@/lib/orgDay";
import { zonedInstant } from "@/lib/attendance";
import { customMethodsFor } from "./customMethods";
import { type AccessRule, BASE_COLLECTIONS, collectionsForRules, labelOf, scopesForCollection, fetchScopeCapabilities, fetchConditionFields, fetchWindowFields, scopeText, permText } from "./permMatrix";
import { ruleSentence, ruleFlags, ALL_VERBS } from "./ruleLogic";
import { replaceAccessRule, ruleBody, stableText } from "./cloneRules";
// The server's own set, imported rather than restated: it is what `isFieldScopeTarget` validates against, so a
// picker built from anything else would offer rules the validator refuses (which is exactly what happened).
import { COLLECTION_FIELD_CAPABILITIES } from "../../../../src/domain/manifests";
import { DataTable, type Column } from "@/components/common/DataTable";
import { WriteDialog } from "@/components/common/WriteDialog";
import type { TableInsight } from "@/components/common/TableInsights";
import { daysUntil, fmtDaysCount } from "@/lib/tableDerive";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

// A Select item can never carry an empty value (Radix reserves "" for "cleared"), so the "any collection"
// choice in activity's target picker travels under a sentinel and maps back to "" on the rule.
const ANY_COLLECTION = "__any__";
// How much notice is useful before temporary access lapses. A week: long enough to extend it deliberately,
// short enough that the chip means something when it shows up.
const RULE_LAPSE_SOON_DAYS = 7;

type RoleOption = { name: string; label: string };
type UserOption = { path: string; email: string };

// What the add strip and the edit dialog both author about a rule: where it applies, what it grants and for how
// long. Who it is for and which collection it is about belong to the add strip alone - an edit keeps both,
// because changing either makes a different rule rather than a change to this one.
type RuleDraft = { scope: string; field: string; kind: "level" | "verb"; level: string; verb: string; effect: string; expires: string };

// The expiry picker means "until the end of that day" in the org's zone, the same calendar its `min` comes from
// - the server takes any ISO instant. `expiryDay` reads a stored instant back as the day that wrote it.
const endOfDay = (day: string) => new Date(Date.parse(zonedInstant(addDaysYmd(day, 1), "00:00", orgTimezone())) - 1000).toISOString();
const expiryDay = (iso?: string): string => stampDay(iso);

// The scope tiers this editor authors. A named department is not among them: it is anchored to a department the
// grantor picks, and only the ACL modal carries that picker - this form posts the bare tier, which the server
// refuses for that one.
const formScopes = (collection: string, caps: Record<string, string[]>) => scopesForCollection(collection, false, caps).filter((s) => s.value !== "named-dept");

// Lists EVERY assigned rule (any scope/field/verb) for a subject (fixedSubject) or across roles/users
// (roleOptions/userOptions), on the shared DataTable (so it gets the same per-column filters/sorting as
// everywhere), with edit + delete per row and an add form. Object-scoped (exact) rules are authored via the
// in-context manage-access icons (which know the object), so the add form offers the subject-relative tiers
// only; an edit keeps an object-scoped rule's object for as long as it keeps that scope.
export function FineRulesEditor({
  rules,
  reload,
  fixedSubject,
  roleOptions,
  userOptions,
  canWrite,
  controlsSlot,
}: {
  rules: AccessRule[];
  reload: () => Promise<void> | void;
  fixedSubject?: { kind: "role" | "user"; subject: string };
  roleOptions?: RoleOption[];
  userOptions?: UserOption[];
  canWrite: boolean;
  controlsSlot?: HTMLElement | null;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState(false);
  // The rule open in the edit dialog, if any.
  const [editing, setEditing] = React.useState<AccessRule | null>(null);
  // Per-collection grantable scope tiers from the policy manifest (carried on users/me, cached in permMatrix).
  // The add form is object-less, so it offers the subject-relative tiers only (self/dept/all) - the
  // object-anchored exact/subtree are authored from the in-context manage-access icons that know the object.
  const [scopeCaps, setScopeCaps] = React.useState<Record<string, string[]>>({});
  React.useEffect(() => {
    fetchScopeCapabilities().then(setScopeCaps).catch(() => setScopeCaps({}));
  }, []);

  const multi = !fixedSubject;
  const hasRoles = !!roleOptions?.length;
  const hasUsers = !!userOptions?.length;
  const emailMap = React.useMemo(() => new Map((userOptions ?? []).map((u) => [u.path, u.email])), [userOptions]);
  const subjLabel = (r: AccessRule) => (r.subject_kind === "role" ? roleLabel(r.subject) : emailMap.get(r.subject) ?? r.subject.split("/").pop() ?? r.subject);

  const allCollections = collectionsForRules(rules).length ? collectionsForRules(rules) : BASE_COLLECTIONS;
  const [add, setAdd] = React.useState<{ subjectKind: "role" | "user"; subject: string; collection: string } & RuleDraft>({
    subjectKind: roleOptions ? "role" : "user",
    subject: roleOptions?.[0]?.name ?? userOptions?.[0]?.path ?? "",
    collection: allCollections[0] ?? "employees",
    scope: "all",
    field: "",
    kind: "level",
    level: "read",
    verb: "",
    effect: "allow",
    expires: "", // optional expiry (temporary access); "" = permanent
  });
  const verbs = customMethodsFor(add.collection);
  // The relevant subject-relative scopes for the selected collection (object-less form -> hasObject=false).
  const scopeOpts = formScopes(add.collection, scopeCaps);
  const addSubjectOptions: [string, string][] = add.subjectKind === "role" ? (roleOptions ?? []).map((r) => [r.name, r.label]) : (userOptions ?? []).map((u) => [u.path, u.email]);

  async function del(r: AccessRule) {
    if (!(await confirm({ title: "Remove this permission rule?", destructive: true, confirmLabel: "Remove" }))) return;
    setBusy(true);
    try {
      await remove(r.path, r.etag);
      toast({ title: "Rule removed" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not remove", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    const subjectKind = fixedSubject?.kind ?? add.subjectKind;
    const subject = fixedSubject?.subject ?? add.subject;
    if (!subject) return;
    setBusy(true);
    try {
      const perm = add.kind === "verb" ? { verb: add.verb || verbs[0], effect: add.effect } : add.effect === "deny" ? { effect: "deny" } : { level: add.level };
      await create("access-rules", {
        subject_kind: subjectKind,
        subject,
        collection: add.collection,
        scope: add.scope,
        ...(add.field.trim() ? { field: add.field.trim() } : {}),
        ...perm,
        ...(add.expires && add.effect !== "deny" ? { expire_time: endOfDay(add.expires) } : {}),
      });
      toast({ title: "Rule added" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not add rule", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  // Two things about a rule set that no row shows: what is about to lapse, and what is sitting unapproved.
  // Both are access that is not what anybody thinks it is.
  const ruleInsights = (rs: AccessRule[]): TableInsight[] => {
    const out: TableInsight[] = [];
    const lapsing = rs.filter((r) => { const d = daysUntil(r.expire_time); return d != null && d >= 0 && d <= RULE_LAPSE_SOON_DAYS; });
    if (lapsing.length > 0) {
      out.push({
        id: "lapsing",
        label: `${lapsing.length} expiring within ${RULE_LAPSE_SOON_DAYS} days`,
        tone: "warning",
        hint: "Temporary access that stops on that date, mid-task, with nothing said.",
        filters: { expires_in: `0..${RULE_LAPSE_SOON_DAYS}` },
        sort: "expires_in.asc",
      });
    }
    const pending = rs.filter((r) => r.status && r.status !== "active");
    if (pending.length > 0) {
      out.push({
        id: "awaiting",
        label: `${pending.length} awaiting approval`,
        hint: "Written but not in force. Whoever asked for them is still without the access.",
        filters: { state: "awaiting approval" },
      });
    }
    return out;
  };

  const columns: Column<AccessRule>[] = [
    ...(multi ? [{ id: "subject", header: "Subject", filter: "select", accessor: (r: AccessRule) => subjLabel(r) } as Column<AccessRule>] : []),
    // The rule AS A SENTENCE, first and widest: five coded columns (collection/scope/field/permission/effect)
    // made every row a decoding exercise. The coded columns stay for filtering and sorting.
    {
      id: "rule",
      header: "Rule",
      filter: "text",
      accessor: (r) => ruleSentence(r, subjLabel(r)),
      cell: (r) => {
        // Dead-rule lint: a rule beaten by a deny, or already covered by a broader one, looks exactly like a
        // working rule in the table. Flagging it is the difference between "access is configured" and
        // "access works".
        const flags = ruleFlags(r, rules);
        const bad = flags.find((f) => f.kind === "denied" || f.kind === "shadowed" || f.kind === "unscoped");
        // NOT struck through, unlike the two above: this rule is live and correct for every individual record,
        // it just has no page to show them on. "Incomplete", not "dead" - striking it out would send an admin
        // to delete the rule when the fix is to add one.
        const partial = !bad && flags.find((f) => f.kind === "unlistable");
        const life = flags.find((f) => f.kind === "pending" || f.kind === "expiring");
        return (
          <div className="min-w-64 space-y-0.5">
            <span className={bad ? "text-muted-foreground line-through decoration-muted-foreground/40" : undefined}>{ruleSentence(r, subjLabel(r))}</span>
            {bad && (
              <span className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400" title={bad.note}>
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> {bad.kind === "denied" ? "no effect - a deny overrides this" : bad.kind === "unscoped" ? "no effect - this method only takes an org-wide rule" : "no effect - already covered by a broader rule"}
              </span>
            )}
            {partial && (
              <span className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400" title={partial.note}>
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> cannot open the list - pair with read on the collection
              </span>
            )}
            {life && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground" title={life.note}>
                <Clock className="h-3 w-3 shrink-0" /> {life.note}
              </span>
            )}
          </div>
        );
      },
    },
    // Grouping a rule list by collection is how it gets reviewed: every rule touching payroll, together,
    // with the deny ones visible against the allows.
    { id: "collection", header: "Collection", filter: "select", groupBy: true, accessor: (r) => labelOf(r.collection), cell: (r) => <span className="font-medium">{labelOf(r.collection)}</span> },
    { id: "scope", header: "Scope", filter: "select", groupBy: true, accessor: (r) => scopeText(r) },
    { id: "field", header: "Field", filter: "select", accessor: (r) => r.field ?? "-" },
    { id: "perm", header: "Permission", filter: "select", groupBy: true, accessor: (r) => permText(r), cell: (r) => <Badge variant={r.effect === "deny" ? "destructive" : r.verb ? "default" : "secondary"}>{permText(r)}</Badge> },
    { id: "state", header: "State", filter: "select", groupBy: true, accessor: (r) => (r.status && r.status !== "active" ? "awaiting approval" : r.expire_time ? "temporary" : "live") },
    {
      // How long a temporary rule has left. A rule that lapses takes somebody's access with it mid-task, and
      // the state column can only say "temporary" - not whether that means tomorrow or next year.
      id: "expires_in", header: "Expires in", align: "right", defaultHidden: true, filter: "number", formatTotal: fmtDaysCount,
      accessor: (r) => daysUntil(r.expire_time),
      cell: (r) => {
        const d = daysUntil(r.expire_time);
        if (d == null) return <span className="text-muted-foreground">-</span>;
        return <span className={cn("tabular-nums text-xs", d <= 7 ? "font-medium text-warning" : "text-muted-foreground")}>{d < 0 ? "lapsed" : fmtDaysCount(d)}</span>;
      },
    },
    ...(canWrite
      ? [{
          id: "actions", header: "", sortable: false, filter: "none", align: "right",
          cell: (r: AccessRule) => (
            <div className="flex justify-end gap-0.5">
              {/* A rule whose removal awaits approval is on its way out, and what happens to it next is the
                  approve/reject decision on it, not an edit. */}
              {r.status !== "pending_delete" && (
                <Button variant="ghost" size="icon" aria-label="Edit this rule" title="Edit this rule" className="h-8 w-8" disabled={busy} onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
              )}
              <Button variant="ghost" size="icon" aria-label="Delete this rule" className="h-8 w-8" disabled={busy} onClick={() => del(r)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ),
        } as Column<AccessRule>]
      : []),
  ];

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns}
        rows={rules}
        insights={ruleInsights}
        getRowId={(r) => r.path}
        tableId={`fine-rules-${fixedSubject ? fixedSubject.kind : "all"}`}
        emptyTitle="No rules"
        emptyDescription="No permission rules assigned."
        controlsSlot={controlsSlot}
      />

      {canWrite && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/20 p-3">
          {multi && hasRoles && hasUsers && (
            <Picker label="Subject kind" value={add.subjectKind} onChange={(v) => setAdd({ ...add, subjectKind: v as "role" | "user", subject: (v === "role" ? roleOptions?.[0]?.name : userOptions?.[0]?.path) ?? "" })} options={[["role", "Role"], ["user", "User"]]} />
          )}
          {multi && <Picker label={add.subjectKind === "role" ? "Role" : "User"} value={add.subject} onChange={(v) => setAdd({ ...add, subject: v })} options={addSubjectOptions} wide />}
          <Picker
            label="Collection"
            value={add.collection}
            onChange={(v) => {
              // Keep the chosen scope valid for the new collection (else snap to its narrowest), so switching
              // collection never leaves an inert scope selected.
              const opts = formScopes(v, scopeCaps);
              const scope = opts.some((o) => o.value === add.scope) ? add.scope : opts[0]?.value ?? "all";
              setAdd({ ...add, collection: v, scope, kind: "level", verb: "" });
            }}
            options={allCollections.map((c) => [c, labelOf(c)])}
          />
          <RuleFields collection={add.collection} draft={add} set={(p) => setAdd({ ...add, ...p })} scopeOpts={scopeOpts} verbs={verbs} />
          <Button disabled={busy || (multi && !add.subject) || (add.kind === "verb" && !(add.verb || verbs[0]))} onClick={addRule}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      )}

      {editing && <RuleEditDialog rule={editing} subjectLabel={subjLabel(editing)} scopeCaps={scopeCaps} onClose={() => setEditing(null)} reload={reload} />}
    </div>
  );
}

// The fields of a rule the add strip and the edit dialog share, in the same order in both.
function RuleFields({
  collection,
  draft,
  set,
  scopeOpts,
  verbs,
}: {
  collection: string;
  draft: RuleDraft;
  set: (patch: Partial<RuleDraft>) => void;
  scopeOpts: { value: string; label: string }[];
  verbs: string[];
}) {
  // The create gate is collection-level: it takes no field and no custom method, and the server refuses both.
  const createGate = draft.scope === "create";
  const fieldId = React.useId();
  const expiresId = React.useId();
  return (
    <>
      <Picker label="Scope" value={draft.scope} onChange={(v) => set(v === "create" ? { scope: v, field: "", kind: "level" } : { scope: v })} options={scopeOpts.map((s) => [s.value, s.label])} />
      {createGate ? null : COLLECTION_FIELD_CAPABILITIES.has(collection) ? (
        // For these capabilities the "field" slot is the TARGET collection: empty = every collection, else
        // narrow to one (`activity.<scope>.<collection>`, `export.<scope>.<collection>`). Driven by the
        // server's own set rather than a name test here, so the picker and the validator that accepts what
        // it writes can never disagree about which capabilities work this way.
        <Picker label="For collection" value={draft.field || ANY_COLLECTION} onChange={(v) => set({ field: v === ANY_COLLECTION ? "" : v })} options={[[ANY_COLLECTION, "All collections"], ...BASE_COLLECTIONS.filter((c) => !COLLECTION_FIELD_CAPABILITIES.has(c)).map((c) => [c, labelOf(c)] as [string, string])]} wide />
      ) : (
        <div className="w-24">
          <label htmlFor={fieldId} className="mb-1 block text-xs font-medium">Field</label>
          <Input id={fieldId} className="h-9" value={draft.field} placeholder="(optional)" onChange={(e) => set({ field: e.target.value })} />
        </div>
      )}
      {!createGate && <Picker label="Type" value={draft.kind} onChange={(v) => set({ kind: v as RuleDraft["kind"] })} options={verbs.length ? [["level", "Level"], ["verb", "Custom method"]] : [["level", "Level"]]} />}
      {draft.kind === "verb" && !createGate ? (
        <Picker label="Method" value={draft.verb || verbs[0] || ""} onChange={(v) => set({ verb: v })} options={verbs.map((v) => [v, v === ALL_VERBS ? "all methods" : v])} />
      ) : (
        // A deny refuses at every level, so it names none - the server rejects a deny that carries a level.
        draft.effect !== "deny" && <Picker label="Level" value={draft.level} onChange={(v) => set({ level: v })} options={[["read", "read"], ["write", "write"], ["admin", "admin"]]} />
      )}
      <Picker label="Effect" value={draft.effect} onChange={(v) => set({ effect: v })} options={[["allow", "allow"], ["deny", "deny"]]} />
      {draft.effect !== "deny" && (
        // Temporary access (contractor, cover during leave): the rule revokes itself at the end of that
        // day instead of relying on someone remembering.
        <div className="w-36">
          <label htmlFor={expiresId} className="mb-1 block text-xs font-medium" title="Leave empty for permanent access.">Expires</label>
          <Input id={expiresId} type="date" className="h-9" value={draft.expires} min={orgDayFromToday(1)} onChange={(e) => set({ expires: e.target.value })} />
        </div>
      )}
    </>
  );
}

// The expiry and guards of a rule, as its create body carries them.
const extrasOf = (r: AccessRule) => ({
  ...(r.expire_time ? { expire_time: r.expire_time } : {}),
  ...(r.condition ? { condition: r.condition } : {}),
  ...(r.window ? { window: r.window } : {}),
  ...(r.from_ip ? { from_ip: r.from_ip } : {}),
});

const positive = (s: string) => s.trim() !== "" && Number.isFinite(Number(s)) && Number(s) > 0;

/**
 * Change one rule: what it grants, where, until when, and its guards. Saving REPLACES it (replaceAccessRule) -
 * the API has no in-place rewrite of a grant, so the trail records the old rule coming out and the new one going
 * in, and under four-eyes both wait for a second access admin like any other change.
 */
function RuleEditDialog({
  rule,
  subjectLabel,
  scopeCaps,
  onClose,
  reload,
}: {
  rule: AccessRule;
  subjectLabel: string;
  scopeCaps: Record<string, string[]>;
  onClose: () => void;
  reload: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const ids = React.useId();
  // The rule being edited, as it stands on the server. It moves when a failed save had to put the rule back,
  // since that puts it back under a new id - and the next save has to replace THAT one.
  const [base, setBase] = React.useState(rule);
  const [draft, setDraft] = React.useState<RuleDraft>(() => ({
    scope: rule.scope,
    field: rule.field ?? "",
    kind: rule.verb ? "verb" : "level",
    level: rule.level ?? "read",
    verb: rule.verb ?? "",
    effect: rule.effect,
    expires: expiryDay(rule.expire_time),
  }));
  // The three guards, as typed. Each starts from the rule's own.
  const [limit, setLimit] = React.useState(rule.condition ? String(rule.condition.value) : "");
  const [withinDays, setWithinDays] = React.useState(rule.window ? String(rule.window.within_days) : "");
  const [fromIp, setFromIp] = React.useState(rule.from_ip ?? "");
  // Where the engine can measure a limit or date a window: the same /users/me payload the ACL modal reads, so the
  // boxes appear exactly where a guard is honoured.
  const [condFields, setCondFields] = React.useState<Record<string, string[]>>({});
  const [windowFields, setWindowFields] = React.useState<Record<string, string[]>>({});
  React.useEffect(() => {
    fetchConditionFields().then(setCondFields).catch(() => setCondFields({}));
    fetchWindowFields().then(setWindowFields).catch(() => setWindowFields({}));
  }, []);

  const collection = base.collection;
  // The catalogue's methods, plus the rule's own when the catalogue does not name it (the all-methods wildcard,
  // or one written through the API) - an edit must be able to keep what is there.
  const verbs = [...new Set([...(base.verb ? [base.verb] : []), ...customMethodsFor(collection)])];
  // The rule's own scope stays on offer when it is not a tier this form authors - one object, one department,
  // the create gate - so changing its level or expiry leaves it where it is.
  const tiers = formScopes(collection, scopeCaps);
  const scopeOpts = tiers.some((s) => s.value === base.scope) ? tiers : [{ value: base.scope, label: scopeText(base) }, ...tiers];

  const createGate = draft.scope === "create";
  const deny = draft.effect === "deny";
  const limitField = base.condition?.field ?? condFields[collection]?.[0];
  const windowField = base.window?.field ?? windowFields[collection]?.[0];
  // A create gate has no row to measure or date, and a deny takes no guard (see the body below).
  const showLimit = !deny && !createGate && !!limitField;
  const showWindow = !deny && !createGate && !!windowField;

  // The rule the dialog would write, in the API's create shape and built the way ruleBody reads a stored rule,
  // so "nothing has changed" is a comparison of the two.
  const initialExpiry = expiryDay(base.expire_time);
  const body: Record<string, unknown> = {
    subject_kind: base.subject_kind,
    subject: base.subject,
    collection,
    scope: draft.scope,
    // An anchored rule keeps its object for as long as it keeps its scope.
    ...(draft.scope === base.scope && base.scope_ref ? { scope_ref: base.scope_ref } : {}),
    ...(!createGate && draft.field.trim() ? { field: draft.field.trim() } : {}),
    ...(!createGate && draft.kind === "verb" ? { verb: draft.verb || verbs[0] } : deny ? {} : { level: draft.level }),
    ...(deny ? { effect: "deny" } : {}),
    ...(deny
      ? // A deny is given no expiry and no guard here - an expiring deny quietly re-opens access on a date nobody
        // is watching. A deny that carries them from the API keeps them, rather than losing them to an unrelated edit.
        base.effect === "deny" ? extrasOf(base) : {}
      : {
          // An untouched date keeps the stored instant exactly, rather than re-deriving it from the day.
          ...(draft.expires ? { expire_time: draft.expires === initialExpiry && base.expire_time ? base.expire_time : endOfDay(draft.expires) } : {}),
          ...(showLimit && positive(limit) ? { condition: { field: limitField, op: base.condition?.op ?? "lte", value: Number(limit) } } : {}),
          ...(showWindow && positive(withinDays) ? { window: { field: windowField, within_days: Number(withinDays) } } : {}),
          ...(fromIp.trim() ? { from_ip: fromIp.trim() } : {}),
        }),
  };
  const changed = stableText(body) !== stableText(ruleBody(base));
  // A temporary rule that has already lapsed cannot be written again with the same date - the server refuses an
  // expiry in the past, because a rule authored dead reads as access it does not give.
  const lapsed = !deny && !!base.expire_time && draft.expires === initialExpiry && +new Date(base.expire_time) <= Date.now();
  const whyNot = [
    !changed && "Nothing has changed yet.",
    showLimit && limit.trim() !== "" && !positive(limit) && "The limit has to be a number above zero.",
    showWindow && withinDays.trim() !== "" && !positive(withinDays) && "Within days has to be a number above zero.",
    lapsed && "This rule has already lapsed - pick a new expiry date or clear it.",
  ];

  // The rule as it will read once saved, from the same sentence builder as the table.
  const after: AccessRule = {
    path: base.path,
    subject_kind: base.subject_kind,
    subject: base.subject,
    collection,
    scope: draft.scope,
    scope_ref: body.scope_ref as string | undefined,
    field: body.field as string | undefined,
    level: body.level as string | undefined,
    verb: body.verb as string | undefined,
    effect: deny ? "deny" : "allow",
    condition: body.condition as AccessRule["condition"],
    window: body.window as AccessRule["window"],
    from_ip: body.from_ip as string | undefined,
  };
  const until = (iso: unknown) => (typeof iso === "string" ? `, until ${expiryDay(iso)}` : "");

  async function save() {
    const res = await replaceAccessRule(base, body);
    if (res.ok) {
      // Under four-eyes the replacement lands as a REQUEST, and the rule it replaces stays in force meanwhile.
      toast(
        res.rule.status === "pending"
          ? { title: "Change requested", description: "It takes effect once another access admin approves it. Until then the rule stays as it was." }
          : { title: "Rule updated", description: ruleSentence(res.rule, subjectLabel), variant: "success" },
      );
      return;
    }
    if (!res.rule) {
      // The old rule came out and could not be put back: there is no rule left here to edit, so the dialog closes
      // on the failure instead of offering to save over something that is gone.
      toast({
        variant: "destructive",
        title: "Could not update the rule",
        description: `${res.error} - and the rule it replaces could not be put back. Check ${subjectLabel} · ${labelOf(collection)} before relying on it.`,
      });
      return;
    }
    if (res.rule.path !== base.path || res.rule.etag !== base.etag) {
      setBase(res.rule);
      void reload();
    }
    throw new Error(res.error);
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="Edit rule"
      description={
        <>
          For <span className="font-medium">{subjectLabel}</span> on {labelOf(collection)}. Saving replaces the rule, so the activity trail shows the old one coming out and the new one going in.
        </>
      }
      collection="access-rules"
      objectPath={base.path}
      form={{ draft, limit, withinDays, fromIp }}
      guardLabel="change to this rule"
      submitLabel="Save changes"
      canSubmit={!whyNot.some(Boolean)}
      whyNot={whyNot}
      onSubmit={save}
      onSaved={() => void reload()}
      className="sm:max-w-2xl"
    >
      <div className="space-y-4">
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Now: </span>
          {ruleSentence(base, subjectLabel)}
          {until(base.expire_time)}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <RuleFields collection={collection} draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} scopeOpts={scopeOpts} verbs={verbs} />
          {/* The guards the ACL modal authors, editable here on the rule that carries them. Empty = none. */}
          {showLimit && (
            <div className="w-40">
              <label htmlFor={`${ids}-limit`} className="mb-1 block text-xs font-medium" title="Leave empty for no limit.">Limit (optional)</label>
              <Input id={`${ids}-limit`} type="number" min="1" inputMode="numeric" className="h-9" placeholder={`Max ${limitField}`} value={limit} onChange={(e) => setLimit(e.target.value)} />
            </div>
          )}
          {showWindow && (
            <div className="w-36">
              <label htmlFor={`${ids}-days`} className="mb-1 block text-xs font-medium" title="Leave empty to reach rows of any date.">Within days (optional)</label>
              <Input id={`${ids}-days`} type="number" min="1" inputMode="numeric" className="h-9" placeholder="e.g. 30" value={withinDays} onChange={(e) => setWithinDays(e.target.value)} />
            </div>
          )}
          {!deny && (
            <div className="w-52">
              <label htmlFor={`${ids}-ip`} className="mb-1 block text-xs font-medium" title="Leave empty to allow any network.">Only from (optional)</label>
              <Input id={`${ids}-ip`} className="h-9" placeholder="203.0.113.7, 198.51.100.0/24" value={fromIp} onChange={(e) => setFromIp(e.target.value)} />
            </div>
          )}
        </div>
        {changed && (
          <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs">
            <span className="font-medium">After saving:</span> {ruleSentence(after, subjectLabel)}
            {until(body.expire_time)}
          </p>
        )}
      </div>
    </WriteDialog>
  );
}

function Picker({ label, value, onChange, options, wide }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; wide?: boolean }) {
  const id = React.useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className={wide ? "h-9 w-48" : "h-9 w-36"}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
