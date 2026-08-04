import * as React from "react";
import { KeyRound, X, Eye } from "lucide-react";
import { CapabilitiesContext, hasCapability } from "@/lib/perm";
import { setViewAs, useViewAs } from "@/lib/viewAsStore";
import { AclModal } from "./AclModal";
import { fetchAllAccessRules, type AccessRule } from "./permMatrix";
import { fetchPreview, fetchSubjectOptions } from "./PreviewPanel";
import { Combobox } from "@/components/ui/combobox";

// A target the access-management UI can act on. `objectPath` ("collection/uuid") is present when the target is
// a specific row/object (Users tab meaningful); absent for collection-scope targets (Roles tab only).
export type AccessTargetRef = {
  collection: string;
  objectPath?: string;
  field?: string; // a protected field of the collection -> field-level access management (Roles tab only)
  verb?: string; // a custom method (AEP `:verb`) -> the modal manages allow/deny of that method
  create?: boolean; // a "new <X>" affordance -> the modal manages who can CREATE (the collection-level gate)
  label?: string;
  can?: string[]; // the object's access.can (effective verbs for the caller), for the modal's "current" banner
  why?: "all" | "subtree" | "exact" | "self" | "dept"; // scope provenance: why the caller holds read on this object
};

type AccessModeCtx = {
  enabled: boolean; // toggle on/off
  available: boolean; // caller may manage access at all (gates the toggle's visibility)
  canManageUsers: boolean; // grant-exceptions.write -> Users tab
  canManageRoles: boolean; // grants.write -> Roles tab
  toggle: () => void;
  open: (target: AccessTargetRef) => void;
  // Does an explicit DENY rule exist that (approximately) covers this target? Drives the red key tint so
  // silent lockouts are FINDABLE without opening every modal - it flags "a deny lives here, look", it does
  // not adjudicate (the engine does that; broad self/dept/all denies are counted for any object).
  denyFor: (t: AccessTargetRef) => boolean;
};

const Ctx = React.createContext<AccessModeCtx | null>(null);

export function useAccessMode(): AccessModeCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useAccessMode must be used within AccessModeProvider");
  return ctx;
}

const lsKey = (user: string | undefined) => `am:${user || "anon"}:enabled`;

// `capabilities` are the admin's REAL capabilities, passed as a prop (not read from context) on purpose:
// while "view as" is active, App swaps the CapabilitiesContext under the entire shell to the simulated
// user's set - the access-mode machinery must keep judging by the real one, or the simulation could hide
// its own exit (a simulated user without access-rules.write would kill the pill, the icons, the modal).
export function AccessModeProvider({ userEmail, capabilities, children }: { userEmail?: string; capabilities: string[]; children: React.ReactNode }) {
  const available = hasCapability(capabilities, "access-rules.write");
  // One unified capability governs managing access rules for both subjects (post role/user unification).
  const canManageUsers = available;
  const canManageRoles = available;
  const canPreview = hasCapability(capabilities, "access-rules.preview");
  const [enabled, setEnabled] = React.useState(false);
  const [target, setTarget] = React.useState<AccessTargetRef | null>(null);

  // Restore the toggle from localStorage (per user) once the user is known. Never enabled if not available.
  React.useEffect(() => {
    if (!available) {
      setEnabled(false);
      return;
    }
    try {
      setEnabled(localStorage.getItem(lsKey(userEmail)) === "1");
    } catch {
      /* ignore */
    }
  }, [available, userEmail]);

  const toggle = React.useCallback(() => {
    setEnabled((e) => {
      const next = !e;
      try {
        localStorage.setItem(lsKey(userEmail), next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [userEmail]);

  const open = React.useCallback((t: AccessTargetRef) => setTarget(t), []);

  // Rules cache for the deny tint: loaded when the mode turns on, refreshed when the modal closes (the
  // only place rules change while browsing). Failure -> empty (no tint, mode still works).
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const on = enabled && available;
  React.useEffect(() => {
    if (on && target === null) fetchAllAccessRules().then(setRules).catch(() => setRules([]));
  }, [on, target]);
  const denyFor = React.useCallback(
    (t: AccessTargetRef): boolean =>
      rules.some((r) => {
        if (r.effect !== "deny" || r.collection !== t.collection) return false;
        if (t.verb ? r.verb !== t.verb && r.verb !== "*" : !!r.verb) return false;
        if ((t.field ?? undefined) !== (r.field ?? undefined)) return false;
        // Object-pinned denies only tint their own object; broad (self/dept/all) denies tint everywhere.
        if ((r.scope === "exact" || r.scope === "subtree") && t.objectPath && r.scope_ref !== t.objectPath) return false;
        return true;
      }),
    [rules],
  );

  // App-wide "view as": writes the selected user's server-computed capability set to the viewAs store;
  // App reads it and swaps the capabilities on the `me` it prop-drills through the shell (nav, pages,
  // buttons - everything gated). Data stays the admin's own; per-row access.can hints also stay the
  // admin's, so per-record buttons can differ (the pill says so). Requires access-rules.preview.
  const viewAs = useViewAs();
  const [people, setPeople] = React.useState<{ value: string; label: string }[] | null>(null);
  const [picking, setPicking] = React.useState(false);
  React.useEffect(() => {
    // EVERY person (employees + unlinked accounts), cursor followed to the end - a picker that silently
    // misses people is a trap.
    if (picking && people === null) fetchSubjectOptions().then(setPeople).catch(() => setPeople([]));
  }, [picking, people]);
  // The selection survives a hard refresh: the subject ref is stored per admin; capabilities are ALWAYS
  // re-fetched (rules may have changed while away), never persisted.
  const vaKey = `viewas:${userEmail || "anon"}`;
  const pickViewAs = React.useCallback(
    (subject: string) => {
      fetchPreview({ include_capabilities: true }, [subject])
        .then(([v]) => {
          if (v) {
            setViewAs({ subject, email: v.email, role: v.role, capabilities: v.capabilities ?? [] });
            try {
              localStorage.setItem(vaKey, subject);
            } catch { /* ignore */ }
          }
        })
        .catch(() => setViewAs(null));
    },
    [vaKey],
  );
  const clearViewAs = React.useCallback(() => {
    setViewAs(null);
    try {
      localStorage.removeItem(vaKey);
    } catch { /* ignore */ }
  }, [vaKey]);
  // Rehydrate once the mode is on: a stored subject resumes the simulation after a hard refresh. Turning
  // the mode OFF ends the simulation and forgets the selection.
  const hydrated = React.useRef(false);
  React.useEffect(() => {
    if (!on) {
      if (viewAs) clearViewAs();
      setPicking(false);
      hydrated.current = false;
      return;
    }
    if (hydrated.current || !canPreview) return;
    hydrated.current = true;
    try {
      const stored = localStorage.getItem(vaKey);
      if (stored) pickViewAs(stored);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, canPreview]);

  const value = React.useMemo<AccessModeCtx>(
    () => ({ enabled: on, available, canManageUsers, canManageRoles, toggle, open, denyFor }),
    [on, available, canManageUsers, canManageRoles, toggle, open, denyFor],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* The access-mode chrome always runs on the REAL capabilities, even mid-simulation (see above). */}
      <CapabilitiesContext.Provider value={capabilities}>
        {/* The mode is easy to forget once toggled from the user menu - a persistent floating pill makes the
            state unmistakable and gives a one-click exit without reopening the menu. Always ONE line: the
            row never wraps, the only flexible cell (the label) truncates, and every control is shrink-0, so
            the exit X can never be pushed onto a second row. */}
        {enabled && available && (
          <div className="fixed bottom-4 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2">
            <div className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full border border-amber-400/60 bg-amber-50 py-1.5 pl-3 pr-1.5 text-sm text-amber-800 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <KeyRound className="h-4 w-4 shrink-0" />
              {viewAs ? (
                <>
                  <Eye className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate" title={`Viewing as ${viewAs.email} - their access, your data (per-row buttons may still reflect you)`}>
                    Viewing as <span className="font-semibold">{viewAs.email}</span>
                    <span className="hidden lg:inline"> · their access, your data</span>
                  </span>
                  <button
                    type="button"
                    onClick={clearViewAs}
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    stop
                  </button>
                </>
              ) : (
                <>
                  <span className="hidden min-w-0 truncate sm:inline">Access mode - click any key icon to manage who can see or do what</span>
                  <span className="sm:hidden">Access mode</span>
                  {canPreview && !picking && (
                    <button type="button" onClick={() => setPicking(true)} className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium underline-offset-2 hover:underline">
                      <Eye className="h-3.5 w-3.5" /> view as…
                    </button>
                  )}
                  {canPreview && picking && (
                    <span className="w-56 shrink-0">
                      <Combobox
                        value=""
                        onValueChange={(v) => {
                          setPicking(false);
                          pickViewAs(v);
                        }}
                        options={people ?? []}
                        placeholder={people === null ? "Loading people…" : "View app as…"}
                      />
                    </span>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={toggle}
                aria-label="Turn off access mode"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-amber-200 dark:hover:bg-amber-900"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
        <AclModal target={target} onClose={() => setTarget(null)} canManageUsers={canManageUsers} canManageRoles={canManageRoles} />
      </CapabilitiesContext.Provider>
    </Ctx.Provider>
  );
}
