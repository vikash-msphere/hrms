import * as React from "react";
import { UserSearch, Check, X, ShieldOff } from "lucide-react";
import { api, listAll } from "@/api";
import { usePermission } from "@/lib/perm";
import { roleLabel } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import type { User } from "@/types";
import type { AccessTargetRef } from "./AccessModeProvider";

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
  why?: "all" | "subtree" | "exact" | "self" | "dept";
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
export async function fetchSubjectOptions(): Promise<{ value: string; label: string }[]> {
  const [emps, accounts] = await Promise.all([
    listAll<{ path: string; first_name: string; last_name: string; work_email?: string }>("employees"),
    listAll<User>("users"),
  ]);
  const empOpts = emps.map((e) => ({ value: e.path, label: `${e.first_name} ${e.last_name}${e.work_email ? ` · ${e.work_email}` : ""}` }));
  const unlinked = accounts.filter((u) => !u.employee).map((u) => ({ value: u.path, label: `${u.email} (account)` }));
  return [...empOpts, ...unlinked].sort((a, b) => a.label.localeCompare(b.label));
}

const WHY_TEXT: Record<string, string> = {
  self: "via their own record",
  dept: "via their department",
  subtree: "via their org subtree",
  exact: "via a rule on this object",
  all: "via an org-wide rule",
};

export function PreviewPanel({ target, activeVerb, createMode }: { target: AccessTargetRef; activeVerb?: string; createMode: boolean }) {
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

  const yes = (ok: boolean, label: string) => (
    <Badge variant={ok ? "success" : "muted"} className="gap-1">
      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {label}
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
            yes(verdict.verb_allowed === true, `can ${verb}`)
          ) : createMode ? (
            yes(verdict.write, "can create")
          ) : (
            <>
              {yes(verdict.read, "read")}
              {yes(verdict.write, "write")}
              {yes(verdict.admin, "full")}
            </>
          )}
          {verdict.denied && <Badge variant="destructive">explicit deny in effect</Badge>}
          {verdict.why && !verdict.denied && <span className="text-muted-foreground">{WHY_TEXT[verdict.why]}</span>}
        </div>
      )}
    </div>
  );
}
