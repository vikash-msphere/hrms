// The `locked` precondition, alone in a leaf module so that everything which merely needs to REFUSE an edit
// (services/crud.ts, services/softDelete.ts) does not have to import services/lifecycle.ts - which pulls in
// notifications, the event bus and the board helpers, and through notifications comes back around to a service
// built on crud.ts. That cycle left `crudService` undefined at module-init time depending on which module the
// bundler reached first.
//
// This is a WORKFLOW precondition (a locked row rejects edits for everyone alike), not access control: who may
// lock or unlock is decided by the middleware's verb grant.
import { failedPrecondition } from "../lib/errors";

/** Throw if the row is locked (block edits/deletes until it is unlocked). */
export function assertNotLocked(row: { locked?: boolean | null }) {
  if (row.locked) throw failedPrecondition("item is locked; unlock it before editing");
}
