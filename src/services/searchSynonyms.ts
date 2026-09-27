// The org's own synonym groups (`search-synonyms` setting), for ⌘K and the list-page search boxes alike.
//
// Read off the per-request settings snapshot (lib/refData.ts via getSettingValue), which a search request has
// usually loaded already, so this is not a read of its own in practice. Normalised on the way out: the blob is
// something an admin typed into, and a malformed one narrows what widens rather than failing a search.
import type { Deps } from "../deps";
import { getSettingValue } from "./settings";
import { normalizeSynonymGroups } from "../domain/searchQuery";

export async function orgSynonymGroups(deps: Deps): Promise<string[][]> {
  const v = await getSettingValue<{ groups?: unknown }>(deps, "search-synonyms", { groups: [] });
  return normalizeSynonymGroups(v.groups);
}
