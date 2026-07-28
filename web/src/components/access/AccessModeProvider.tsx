import * as React from "react";
import { useCanManageAccess, usePermission } from "@/lib/perm";
import { AclModal } from "./AclModal";

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
};

const Ctx = React.createContext<AccessModeCtx | null>(null);

export function useAccessMode(): AccessModeCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useAccessMode must be used within AccessModeProvider");
  return ctx;
}

const lsKey = (user: string | undefined) => `am:${user || "anon"}:enabled`;

export function AccessModeProvider({ userEmail, children }: { userEmail?: string; children: React.ReactNode }) {
  const available = useCanManageAccess();
  // One unified capability governs managing access rules for both subjects (post role/user unification).
  const canManageUsers = usePermission("access-rules.write");
  const canManageRoles = usePermission("access-rules.write");
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

  const value = React.useMemo<AccessModeCtx>(
    () => ({ enabled: enabled && available, available, canManageUsers, canManageRoles, toggle, open }),
    [enabled, available, canManageUsers, canManageRoles, toggle, open],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <AclModal target={target} onClose={() => setTarget(null)} canManageUsers={canManageUsers} canManageRoles={canManageRoles} />
    </Ctx.Provider>
  );
}
