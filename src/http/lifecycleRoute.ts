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
  switch (verb) {
    case "enable":
      return done(await setDisabled(deps, user, table, singular, collection, id, false));
    case "disable":
      return done(await setDisabled(deps, user, table, singular, collection, id, true));
    case "lock":
      return done(await setLocked(deps, user, table, singular, collection, id, true));
    case "unlock":
      return done(await setLocked(deps, user, table, singular, collection, id, false));
    case "publish":
      if (opts.publish) return done(await setPublished(deps, user, table, singular, collection, id, true, opts.publishTime));
      break;
    case "unpublish":
      if (opts.publish) return done(await setPublished(deps, user, table, singular, collection, id, false, opts.publishTime));
      break;
  }
  return null;
}
