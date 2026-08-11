import type { Context } from "hono";
import type { AppEnv } from "../env";
import { customMethod } from "./customMethod";
import { setDisabled, setLocked, setPublished } from "../services/lifecycle";

type Opts = {
  table: any;
  singular: string;
  collection: string;
  serialize: (row: any) => unknown;
  publish?: boolean; // resource supports publish/unpublish
  publishTime?: boolean; // also stamp publish_time on publish
};

/**
 * Handles the shared lifecycle custom methods (:enable/:disable/:lock/:unlock and,
 * when enabled, :publish/:unpublish). Returns a Response if it handled the verb,
 * otherwise null so the caller can handle its own verbs (restore, download, ...).
 */
export async function lifecycleVerb(c: Context<AppEnv>, opts: Opts): Promise<Response | null> {
  const { id, verb } = customMethod(c);
  const deps = c.get("deps");
  const user = c.get("user");
  const { table, singular, collection, serialize } = opts;
  const done = (row: unknown) => c.json(serialize(row));
  // A member is only offered where the table can hold the state (pay_grades, for one, has no locked/disabled
  // column). Returning null makes the unsupported verb a clean 404 at the caller's `c.notFound()` instead of a
  // 500 from an UPDATE against a column that does not exist.
  const has = (column: string) => !!(table as Record<string, unknown>)[column];
  switch (verb) {
    case "enable":
      if (has("disabled")) return done(await setDisabled(deps, user, table, singular, collection, id, false));
      break;
    case "disable":
      if (has("disabled")) return done(await setDisabled(deps, user, table, singular, collection, id, true));
      break;
    case "lock":
      if (has("locked")) return done(await setLocked(deps, user, table, singular, collection, id, true));
      break;
    case "unlock":
      if (has("locked")) return done(await setLocked(deps, user, table, singular, collection, id, false));
      break;
    case "publish":
      if (opts.publish) return done(await setPublished(deps, user, table, singular, collection, id, true, opts.publishTime));
      break;
    case "unpublish":
      if (opts.publish) return done(await setPublished(deps, user, table, singular, collection, id, false, opts.publishTime));
      break;
  }
  return null;
}
