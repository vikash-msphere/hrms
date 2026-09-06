import { listAll } from "@/api";
import type { User } from "@/types";

// The people an access rule (or a "view as" simulation) can name: every employee, plus the user accounts that
// have no employee record. Sorted by label, because both call sites feed it straight to a Combobox.
//
// This lives in its own module rather than in PreviewPanel.tsx, where it started, for a bundling reason. It is
// needed by AccessModeProvider - one of the providers wrapping the whole tree - for the "view as" people
// picker, so importing it from PreviewPanel.tsx pinned that whole component to the critical path even though
// nothing renders it until the access modal is open. Eight lines of fetch in a module of their own let
// PreviewPanel ride the modal's lazy chunk. Keep it free of React and of component imports.
export async function fetchSubjectOptions(): Promise<{ value: string; label: string }[]> {
  const [emps, accounts] = await Promise.all([
    listAll<{ path: string; first_name: string; last_name: string; work_email?: string }>("employees"),
    listAll<User>("users"),
  ]);
  const empOpts = emps.map((e) => ({ value: e.path, label: `${e.first_name} ${e.last_name}${e.work_email ? ` · ${e.work_email}` : ""}` }));
  const unlinked = accounts.filter((u) => !u.employee).map((u) => ({ value: u.path, label: `${u.email} (account)` }));
  return [...empOpts, ...unlinked].sort((a, b) => a.label.localeCompare(b.label));
}
