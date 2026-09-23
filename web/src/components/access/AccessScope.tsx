import * as React from "react";

// Ambient access context for a page or section: the collection (and optionally the object) that the data
// elements inside it belong to. Shared primitives (Field, Detail, RowActions, AccessButton) read this so the
// access-management affordance is automatic and near-universal - a page wraps its content once and every data
// element/control path inside lights up in access-mode, with no per-element wiring. Nested scopes override
// (an inner section can narrow to a sub-resource collection / a specific object).
export type AccessScopeValue = { collection: string; objectPath?: string };

const Ctx = React.createContext<AccessScopeValue | null>(null);

export function AccessScope({ collection, objectPath, children }: AccessScopeValue & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ collection, objectPath }), [collection, objectPath]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccessScope(): AccessScopeValue | null {
  return React.useContext(Ctx);
}
