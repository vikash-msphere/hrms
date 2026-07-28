import type { ReactNode } from "react";
import { usePermission } from "@/lib/perm";

// Declarative, DOM-clean permission gate (docs/archive/plan.txt section 7). `perm` is a prop consumed by this
// component - it is NEVER spread onto a child or rendered into the DOM. Renders `children` only when the
// caller has the capability; otherwise `fallback` (default nothing). UX only; the server enforces.
//
//   <Can perm="holidays.write"><Button onClick={add}>Add holiday</Button></Can>
//
export function Can({ perm, children, fallback = null }: { perm: string; children: ReactNode; fallback?: ReactNode }) {
  return <>{usePermission(perm) ? children : fallback}</>;
}
