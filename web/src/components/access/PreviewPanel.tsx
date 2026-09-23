import * as React from "react";
import { UserSearch, Check, X, ShieldOff } from "lucide-react";
import { api } from "@/api";
import { usePermission } from "@/lib/perm";
import { roleLabel } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import type { AccessTargetRef } from "./AccessModeProvider";
import { fetchSubjectOptions } from "./subjectOptions";

// "View as": ask the ENGINE (POST /v1/access-rules:preview) what a chosen person can actually do on the
// modal's current target, and show the verdict. This is the ground truth the whole modal edits toward -
// without it a grantor can only guess whether the rules add up. Gated on the `access-rules.preview` verb
// (super by default; grantable like any custom method). Collapsed until opened, so the users list is only
// fetched on demand.
export type PreviewVerdict = {
  subject: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  read: boolean;
  write: boolean;
  admin: boolean;
  verb_allowed?: boolean;
  why?: "all" | "subtree" | "exact" | "self" | "dept" | "reports" | "org"; // the engine's full ScopeKind - chain tiers included
  denied: boolean;
  capabilities?: string[];
};

export function fetchPreview(
  target: { collection?: string; object?: string; field?: string; verb?: string; include_capabilities?: boolean },
  subjects: string[],
): Promise<PreviewVerdict[]> {
  const body: Record<string, unknown> = { subjects };
  if (target.collection) body.collection = target.collection;
  if (target.object) body.object = target.object;
  if (target.field) body.field = target.field;
  if (target.verb) body.verb = target.verb;
  if (target.include_capabilities) body.include_capabilities = true;
  return api<{ results: PreviewVerdict[] }>("/access-rules:preview", { method: "POST", body: JSON.stringify(body) }).then((r) => r.results);
}

// Options for a preview-subject picker: every EMPLOYEE (person), plus sign-in accounts with no employee
// link (service/admin accounts). People are what an admin thinks in - a users-only list silently misses
// everyone who hasn't signed in yet (the server grades those as the default-role account they'd get).
const WHY_TEXT: Record<string, string> = {
  self: "via their own record",
  dept: "via their department",
  subtree: "via their org subtree",
  exact: "via a rule on this object",
  all: "via an org-wide rule",
};

export function PreviewPanel({ target, activeVerb, createMode, rulesVersion = 0 }: { target: AccessTargetRef; activeVerb?: string; createMode: boolean; rulesVersion?: number }) {
  const canPreview = usePermission("access-rules.preview");
  const [open, setOpen] = React.useState(false);
  const [subjects, setSubjects] = React.useState<{ value: string; label: string }[] | null>(null);
  const [who, setWho] = React.useState("");
  const [verdict, setVerdict] = React.useState<PreviewVerdict | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  // The verb dimension: a concrete method target (or drilled-in chip) previews that method; the wildcard
  // "all methods" rule has no single key to ask the engine about, so it falls back to the ladder.
  const verb = activeVerb && activeVerb !== "*" ? activeVerb : undefined;

  React.useEffect(() => {
    if (open && subjects === null) fetchSubjectOptions().then(setSubjects).catch(() => setSubjects([]));
  }, [open, subjects]);
  // Target or drill-in changed -> the shown verdict no longer describes it.
  React.useEffect(() => setVerdict(null), [target.collection, target.objectPath, target.field, activeVerb]);
  // A rule edit in the lists below CHANGES the answer, so re-ask the engine for the person already on screen.
  // Leaving the old verdict up is worse than showing nothing: the panel is the ground truth admins check their
  // edit against, and a stale "can create" reads as confirmation that the edit did nothing. Only fires when a
  // person is selected (who === "" on mount), so it costs one preview call per edit, not per open.
  React.useEffect(() => {
    if (who) void check(who);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesVersion]);

  async function check(subject: string) {
    setWho(subject);
    setBusy(true);
    setError("");
    try {
      const [v] = await fetchPreview(
        { collection: target.collection, object: target.objectPath, field: target.field, verb },
        [subject],
      );
      setVerdict(v ?? null);
    } catch (e) {
      setVerdict(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!canPreview) return null;
  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="w-fit text-muted-foreground" onClick={() => setOpen(true)}>
        <UserSearch className="h-4 w-4" /> Check a person's access
      </Button>
    );
  }

  // A refusal is the verdict an admin most needs to read correctly, so it never borrows the allowed
  // wording: "can submit" behind a small cross still reads as "can submit" at a glance, and a muted
  // badge looks like a disabled control rather than a NO. The label itself flips to the negative and
  // the badge goes red, so the answer survives being skimmed.
  const yes = (ok: boolean, allowed: string, denied: string) => (
    <Badge variant={ok ? "success" : "destructive"} className="gap-1">
      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {ok ? allowed : denied}
    </Badge>
  );

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <UserSearch className="h-3.5 w-3.5" /> Check a person's access:
        </span>
        <div className="min-w-56 flex-1">
          <Combobox
            value={who}
            onValueChange={(v) => void check(v)}
            options={subjects ?? []}
            placeholder={subjects === null ? "Loading people…" : "Pick a person…"}
          />
        </div>
      </div>
      {busy && <p className="text-xs text-muted-foreground">Asking the engine…</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {verdict && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{verdict.name ?? verdict.email}</span>
          <span className="text-muted-foreground">({roleLabel(verdict.role)})</span>
          {verdict.disabled ? (
            <Badge variant="destructive" className="gap-1"><ShieldOff className="h-3 w-3" /> account disabled</Badge>
          ) : verb ? (
            yes(verdict.verb_allowed === true, `can ${verb}`, `cannot ${verb}`)
          ) : createMode ? (
            yes(verdict.write, "can create", "cannot create")
          ) : (
            <>
              {yes(verdict.read, "read", "no read")}
              {yes(verdict.write, "write", "no write")}
              {yes(verdict.admin, "full", "no full")}
            </>
          )}
          {verdict.denied && <Badge variant="destructive">explicit deny in effect</Badge>}
          {verdict.why && !verdict.denied && <span className="text-muted-foreground">{WHY_TEXT[verdict.why]}</span>}
        </div>
      )}
    </div>
  );
}
