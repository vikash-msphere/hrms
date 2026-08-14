import type { Context } from "hono";
import type { AppEnv } from "../env";
import { customMethod } from "./customMethod";
import { setDisabled, setLocked, setPublished } from "../services/lifecycle";

type Opts = {
  table: any;
  singular: string;
  collection: string;
  publish?: boolean; // resource supports publish/unpublish
  publishTime?: boolean; // also stamp publish_time on publish
};

/**
 * The row a transition produced, wrapped. `{ row }` rather than a bare row because two answers have to stay
 * distinguishable: "not my verb" (null, which the caller turns into a 404) and "handled, and the transition found
 * nothing afterwards" - `setDisabled` answers with whatever the row reads back as, which is undefined if the row
 * vanished underneath it.
 */
type Handled = { row: unknown };

/**
 * Performs the shared lifecycle custom methods (:enable/:disable/:lock/:unlock and, when enabled,
 * :publish/:unpublish) and hands the resulting ROW back. It deliberately does NOT build the response: that is
 * `item()` in http/collectionRoute.ts, which decorates the row, computes the access hint and serializes with
 * `(row, user, can)`. Building a response here is what left `:publish` answering without `access.can` and with an
 * empty reaction thread, since a serializer called with one argument cannot know the caller and `decorate` never
 * ran (see lifecycle-response-plan.md).
 *
 * Returns null when the verb is not one of these, so the caller can try its own.
 */
export async function lifecycleVerb(c: Context<AppEnv>, opts: Opts): Promise<Handled | null> {
  const { id, verb } = customMethod(c);
  const deps = c.get("deps");
  const user = c.get("user");
  const { table, singular, collection } = opts;
  // A member is only offered where the table can hold the state (pay_grades, for one, has no locked/disabled
  // column). Returning null makes the unsupported verb a clean 404 at the caller's `c.notFound()` instead of a
  // 500 from an UPDATE against a column that does not exist.
  const has = (column: string) => !!(table as Record<string, unknown>)[column];
  switch (verb) {
    case "enable":
      if (has("disabled")) return { row: await setDisabled(deps, user, table, singular, collection, id, false) };
      break;
    case "disable":
      if (has("disabled")) return { row: await setDisabled(deps, user, table, singular, collection, id, true) };
      break;
    case "lock":
      if (has("locked")) return { row: await setLocked(deps, user, table, singular, collection, id, true) };
      break;
    case "unlock":
      if (has("locked")) return { row: await setLocked(deps, user, table, singular, collection, id, false) };
      break;
    case "publish":
      if (opts.publish) return { row: await setPublished(deps, user, table, singular, collection, id, true, opts.publishTime) };
      break;
    case "unpublish":
      if (opts.publish) return { row: await setPublished(deps, user, table, singular, collection, id, false, opts.publishTime) };
      break;
  }
  return null;
}
