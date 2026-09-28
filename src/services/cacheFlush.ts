import type { Deps } from "../deps";
import { clearCache } from "../lib/cache";
import { bumpAllGenerations } from "../lib/cacheGenerations";
import { invalidateCodeCache } from "../lib/authzResolve";

/**
 * Make every server instance reload everything it holds in memory: permissions, roles held, the access policy,
 * reporting lines, automation rules and record codes.
 *
 * Nothing needs this after an ordinary change - a write to any of those tables moves its counter in the same
 * transaction (lib/cacheGenerations.ts), and every instance follows within seconds. It exists for the changes
 * that bypass those tables' counters, such as a code hand-edited in SQL, and for an admin who wants to be sure.
 *
 * Moving every counter reaches the OTHER instances within the check interval; this instance is emptied at once.
 * The local clear runs even if the counter write fails, so the instance that was asked always complies.
 */
export async function flushServerCaches(deps: Deps): Promise<void> {
  try {
    await bumpAllGenerations(deps);
  } finally {
    clearCache();
    invalidateCodeCache();
  }
}
