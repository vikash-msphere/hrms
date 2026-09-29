import { useEffect, useMemo, useState } from "react";
import { Lock, UserPlus, X } from "lucide-react";
import { invoke, invokeRead, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { usePermission } from "@/lib/perm";
import { LEVEL_OPTIONS, VISIBILITY_OPTIONS, type BoardLevel, type BoardVisibility } from "@/lib/boardAccess";
import type { Board, Department, Employee } from "@/types";
import { Field } from "@/components/common/Field";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

// A board's sharing, as `:sharing` answers it and `:share` takes it back (services/boards.ts). A person comes
// back as `users/<id>` with their employee record beside it; one added here goes out as `employees/<id>` and
// the server finds their account.
type Member = { kind: "user" | "role"; subject: string; employee?: string | null; name: string; level: BoardLevel };
type Sharing = {
  visibility: BoardVisibility;
  department: string | null;
  members: Member[];
  managers: { user: string; employee: string | null; name: string }[];
};

// Who may see and work one board: its visibility, its department (whose managers manage it) and its sharing
// list. Rendered only for whoever manages the board (the `share` verb), in the board's settings sheet.
export function BoardSharingTab({ board, onSaved }: { board: Board; onSaved?: () => void }) {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState<Sharing | null>(null);
  const [visibility, setVisibility] = useState<BoardVisibility>(board.visibility ?? "edit");
  const [department, setDepartment] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: picking });
  // Roles are offered only to a caller who may read the roles catalogue; anyone else shares with people.
  const canPickRoles = usePermission("roles.read");
  const { rows: roles } = useCollection<{ path: string; name: string; label?: string }>("roles", { all: true, enabled: canPickRoles });

  const load = () =>
    invokeRead<Sharing>(`boards/${idOf(board.path)}`, "sharing").then((s) => {
      setLoaded(s);
      setVisibility(s.visibility);
      setDepartment(s.department ?? "");
      setMembers(s.members);
    });
  useEffect(() => {
    load().catch((e) => toast({ title: "Couldn't load sharing", description: (e as Error).message, variant: "destructive" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.path]);

  const pickedEmployees = useMemo(() => members.map((m) => m.employee ?? (m.subject.startsWith("employees/") ? m.subject : null)).filter((x): x is string => !!x), [members]);
  const roleOptions = roles.filter((r) => r.name !== "super_admin" && !members.some((m) => m.kind === "role" && m.subject === r.name));

  if (!loaded) return <PanelSkeleton />;

  const setLevel = (i: number, level: BoardLevel) => setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, level } : m)));
  const drop = (i: number) => setMembers((ms) => ms.filter((_, j) => j !== i));
  const addPeople = (refs: string[]) => {
    setPicking(false);
    const byId = new Map(employees.map((e) => [idOf(e.path), e]));
    setMembers((ms) => [
      ...ms,
      ...refs
        .filter((r) => !pickedEmployees.some((p) => idOf(p) === idOf(r)))
        .map((r) => {
          const e = byId.get(idOf(r));
          return { kind: "user" as const, subject: `employees/${idOf(r)}`, employee: `employees/${idOf(r)}`, name: e ? `${e.first_name} ${e.last_name}` : "Someone", level: "edit" as const };
        }),
    ]);
  };
  const addRole = (name: string) => {
    const r = roles.find((x) => x.name === name);
    if (r) setMembers((ms) => [...ms, { kind: "role", subject: r.name, name: r.label ?? r.name, level: "view" }]);
  };

  async function save() {
    setBusy(true);
    try {
      // The department is the board's own field (who manages it follows); the rest is the `share` verb.
      if ((department || null) !== (loaded!.department || null)) {
        await patch(`boards/${idOf(board.path)}`, { department: department ? `departments/${idOf(department)}` : null }, board.etag);
      }
      await invoke(`boards/${idOf(board.path)}`, "share", undefined, {
        visibility,
        members: members.map((m) => ({ kind: m.kind, subject: m.subject, level: m.level })),
      });
      await load();
      onSaved?.();
      toast({ title: "Sharing saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save sharing", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const vis = VISIBILITY_OPTIONS.find((o) => o.value === visibility)!;
  return (
    <div className="space-y-3">
      <Field label="Who can see it" hint={vis.hint}>
        <Select value={visibility} onValueChange={(v) => setVisibility(v as BoardVisibility)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {VISIBILITY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Department" hint="Its managers, and the managers of the departments above it, manage this board.">
        <Combobox
          value={department}
          onValueChange={setDepartment}
          options={[{ value: "", label: "No department" }, ...departments.filter((d) => !d.delete_time).map((d) => ({ value: d.path, label: d.display_name }))]}
          placeholder="No department"
        />
      </Field>
      {loaded.managers.length > 0 && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <p className="text-xs text-muted-foreground">Manage it through the department</p>
          <p>{loaded.managers.map((m) => m.name).join(", ")}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Shared with</span>
          <div className="flex items-center gap-2">
            {canPickRoles && roleOptions.length > 0 && (
              <Select value="" onValueChange={addRole}>
                <SelectTrigger className="h-8 w-40"><SelectValue placeholder="Add a role" /></SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => <SelectItem key={r.name} value={r.name}>{r.label ?? r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}><UserPlus className="h-3.5 w-3.5" /> Add people</Button>
          </div>
        </div>
        {members.length === 0 ? (
          <p className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            {visibility === "private" ? "Only the department's managers can see this board." : "Nobody beyond what \"Who can see it\" allows."}
          </p>
        ) : (
          members.map((m, i) => (
            <div key={`${m.kind}:${m.subject}`} className="editor-row">
              <span className="editor-row-main flex items-center gap-1.5 text-sm">
                {m.name}
                {m.kind === "role" && <Badge variant="secondary">Role</Badge>}
              </span>
              <Select value={m.level} onValueChange={(v) => setLevel(i, v as BoardLevel)}>
                <SelectTrigger className="h-8 w-44" aria-label={`What ${m.name} can do`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LEVEL_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="icon" variant="ghost" aria-label={`Stop sharing with ${m.name}`} className="h-7 w-7 text-destructive" onClick={() => drop(i)}><X className="h-4 w-4" /></Button>
            </div>
          ))
        )}
      </div>

      <div className="flex justify-end border-t pt-3">
        <Button onClick={save} loading={busy}>Save sharing</Button>
      </div>

      {picking && (
        <EmployeePicker
          title="Share this board with"
          confirmLabel="Add"
          employees={employees}
          departments={departments}
          exclude={pickedEmployees}
          onClose={() => setPicking(false)}
          onConfirm={addPeople}
        />
      )}
    </div>
  );
}
