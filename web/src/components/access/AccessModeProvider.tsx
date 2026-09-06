import * as React from "react";
import { KeyRound, X, Eye, SlidersHorizontal } from "lucide-react";
import { CapabilitiesContext, hasCapability } from "@/lib/perm";
import { navigate } from "@/router";
import { startViewAs, stopViewAs, useViewAs } from "@/lib/viewAsStore";
import { lazyPage } from "@/lib/lazyPage";
import { fetchAllAccessRules, type AccessRule } from "./permMatrix";
import { fetchSubjectOptions } from "./subjectOptions";

// The access modal, LAZY. This provider wraps the whole tree, so a static import put all 26 kB of it (the
// largest single app module in the shell chunk, plus PreviewPanel behind it) on the critical path for every
// visitor on every route - to render, until an admin clicks a manage-access key, a closed dialog. Measured at
// 26.0 kB raw off first paint.
//
// lazyPage rather than React.lazy so a chunk request that loses a race with a deploy stays retryable through
// the crash boundary (see lib/lazyPage.tsx).
const AclModal = lazyPage(() => import("./AclModal").then((m) => ({ default: m.AclModal })));
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
  // Every rendered key icon registers itself while the mode is on, so the pill can say how many manageable
  // things are actually on THIS page ("nothing here is grantable" and "42 targets" look identical otherwise).
  registerTarget: () => () => void;
  targetCount: number;
};

const Ctx = React.createContext<AccessModeCtx | null>(null);

export function useAccessMode(): AccessModeCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useAccessMode must be used within AccessModeProvider");
  return ctx;
}

const lsKey = (user: string | undefined) => `am:${user || "anon"}:enabled`;
const coachKey = (user: string | undefined) => `am:${user || "anon"}:coached`;

// `capabilities` are the admin's REAL capabilities (App re-reads /users/me as the real caller for them),
// passed as a prop rather than read from context on purpose: while "view as" is active the whole shell -
// context included - belongs to the simulated user, and the access-mode machinery must keep judging by the
// real one, or the simulation could hide its own exit (a simulated user without access-rules.write would
// kill the pill, the icons and the modal).
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

  // First time an admin turns the mode on, explain what the key icons are - the affordance is discoverable
  // only once you know it exists. Dismissed forever (per user, per browser) after the first look.
  const [coach, setCoach] = React.useState(false);
  const dismissCoach = React.useCallback(() => {
    setCoach(false);
    try {
      localStorage.setItem(coachKey(userEmail), "1");
    } catch {
      /* ignore */
    }
  }, [userEmail]);

  const toggle = React.useCallback(() => {
    setEnabled((e) => {
      const next = !e;
      try {
        localStorage.setItem(lsKey(userEmail), next ? "1" : "0");
        if (next && localStorage.getItem(coachKey(userEmail)) !== "1") setCoach(true);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [userEmail]);

  // Whether the modal has ever been opened, which is what gates its mount below.
  //
  // Gating on `target` instead would have been simpler and would have changed behaviour: the modal resets
  // `focusVerb`/`addUsers`/`addExpires` itself whenever `target` changes, but `scopeSel` and `addAccess`
  // deliberately persist across opens, and unmounting on close would reset those too. Mounting once on the
  // first open and leaving it mounted keeps every open after the first identical to a static import; all that
  // is skipped is the closed dialog it used to render before anyone asked for it.
  const [aclUsed, setAclUsed] = React.useState(false);
  const open = React.useCallback((t: AccessTargetRef) => {
    setAclUsed(true);
    setTarget(t);
  }, []);

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

  // App-wide "view as": a SERVER-side simulation (src/lib/viewAs.ts). Picking a person persists the choice
  // and reloads; from then on every request carries the subject and the app answers as them - their nav,
  // their rows, their redactions - read-only, with the audit trail still naming this admin. Requires
  // access-rules.preview, which is what the server checks too.
  const viewAs = useViewAs();
  const [people, setPeople] = React.useState<{ value: string; label: string }[] | null>(null);
  const [picking, setPicking] = React.useState(false);
  React.useEffect(() => {
    // EVERY person (employees + unlinked accounts), cursor followed to the end - a picker that silently
    // misses people is a trap.
    if (picking && people === null) fetchSubjectOptions().then(setPeople).catch(() => setPeople([]));
  }, [picking, people]);
  const pickViewAs = React.useCallback(
    (subject: string, label: string) => startViewAs({ subject, label, admin: userEmail || "anon" }),
    [userEmail],
  );

  // Live count of mounted key icons. Kept in a ref and flushed once per tick: a page can mount a hundred
  // targets in one render pass, and a setState per icon would re-render the tree a hundred times.
  const countRef = React.useRef(0);
  const flushRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [targetCount, setTargetCount] = React.useState(0);
  const registerTarget = React.useCallback(() => {
    const flush = () => {
      if (flushRef.current) return;
      flushRef.current = setTimeout(() => {
        flushRef.current = null;
        setTargetCount(countRef.current);
      }, 0);
    };
    countRef.current += 1;
    flush();
    return () => {
      countRef.current -= 1;
      flush();
    };
  }, []);

  const value = React.useMemo<AccessModeCtx>(
    () => ({ enabled: on, available, canManageUsers, canManageRoles, toggle, open, denyFor, registerTarget, targetCount }),
    [on, available, canManageUsers, canManageRoles, toggle, open, denyFor, registerTarget, targetCount],
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
        {/* A running simulation ALWAYS shows the pill, even with access mode toggled off or the capability
            gone - it is the only exit, and an invisible simulation is a trap. */}
        {/* Screen readers get told the mode flipped: without this the whole UI silently grows key icons and
            nothing is announced. Polite, so it never interrupts what is being read. */}
        <span aria-live="polite" className="sr-only">
          {viewAs ? `Viewing the app as ${viewAs.label}` : on ? "Access management mode on" : "Access management mode off"}
        </span>
        {/* One-time explainer, anchored above the pill so it reads as part of the same mode. */}
        {coach && on && !viewAs && (
          // Sits above the mode pill, which is itself lifted over the phone's bottom nav.
          <div className="fixed bottom-[calc(8rem+env(safe-area-inset-bottom))] left-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-amber-400/60 bg-background p-3 text-sm shadow-xl md:bottom-16">
            <p className="mb-1 flex items-center gap-1.5 font-semibold">
              <KeyRound className="h-4 w-4 text-amber-600" /> Access mode is on
            </p>
            <p className="text-muted-foreground">
              Every table row, button, field and tab now carries a small key. Click one to say who can see or do exactly that thing. A red key means an explicit deny is in force there. Nothing you see here changes what the server enforces.
            </p>
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={dismissCoach} className="rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-500/25 dark:text-amber-200">
                Got it
              </button>
            </div>
          </div>
        )}
        {(viewAs || (enabled && available)) && (
          // The mode pill has to stay tappable (it is how the mode gets turned off), so on a phone it sits
          // above the bottom nav rather than on top of it.
          <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-4">
            <div className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full border border-amber-400/60 bg-amber-50 py-1.5 pl-3 pr-1.5 text-sm text-amber-800 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <KeyRound className="h-4 w-4 shrink-0" />
              {viewAs ? (
                <>
                  <Eye className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate" title={`Viewing the app as ${viewAs.label} - their access AND their data, read-only`}>
                    Viewing as <span className="font-semibold">{viewAs.label}</span>
                    <span className="hidden lg:inline"> · their data, read-only</span>
                  </span>
                  <button
                    type="button"
                    onClick={stopViewAs}
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    stop
                  </button>
                </>
              ) : (
                <>
                  <span className="hidden min-w-0 truncate lg:inline">Access mode - click any key icon to manage who can see or do what</span>
                  <span className="lg:hidden">Access mode</span>
                  {/* "Nothing on this page is grantable" and "there are keys, keep looking" are the same
                      picture without a number. */}
                  <span className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold tabular-nums" title={`${targetCount} manageable targets on this page`}>
                    {targetCount}
                  </span>
                  {/* Straight to the org-wide picture (roles x collections) - the one place the per-icon
                      approach can't show you, and the reason admins were leaving the mode to hunt Settings. */}
                  <button
                    type="button"
                    onClick={() => navigate("settings/permissions")}
                    title="Open the org-wide roles x collections view"
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" /> <span className="hidden sm:inline">all permissions</span>
                  </button>
                  {canPreview && !picking && (
                    <button type="button" onClick={() => setPicking(true)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium underline-offset-2 hover:underline">
                      <Eye className="h-3.5 w-3.5" /> <span className="hidden sm:inline">view as…</span>
                    </button>
                  )}
                  {canPreview && picking && (
                    <span className="w-56 shrink-0">
                      <Combobox
                        value=""
                        onValueChange={(v) => {
                          setPicking(false);
                          pickViewAs(v, people?.find((p) => p.value === v)?.label ?? v);
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
                onClick={viewAs ? stopViewAs : toggle}
                aria-label={viewAs ? "Stop viewing as another user" : "Turn off access mode"}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-amber-200 dark:hover:bg-amber-900"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
        {/* fallback null: the modal is its own overlay and the key that opened it stays on screen, so a
            frame or two with nothing new is the right "loading" for it - a spinner would flash over the page
            the admin is still looking at. */}
        {aclUsed && (
          <React.Suspense fallback={null}>
            <AclModal target={target} onClose={() => setTarget(null)} canManageUsers={canManageUsers} canManageRoles={canManageRoles} />
          </React.Suspense>
        )}
      </CapabilitiesContext.Provider>
    </Ctx.Provider>
  );
}
