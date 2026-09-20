import { useEffect, useState } from "react";
import { getSetting } from "@/lib/settingsStore";

// Which AI features this org has switched on, for the client.
//
// WHY THIS EXISTS: without it every AI affordance rendered whether or not the feature was on, and pressing
// one answered "switched off for this organisation". That is a button that exists to fail, which is the thing
// the hide-never-disable rule is about - and it is worse for an AI feature than most, because a person who
// has never seen the feature work reads the error as the feature being broken rather than as off.
//
// Read off the shared settings snapshot (lib/settingsStore.ts), so asking costs nothing beyond the one
// settings read the app already makes, and a change made in Settings invalidates it for every page at once.
//
// THIS IS NOT A SECURITY BOUNDARY. The server refuses a call to a feature that is off regardless of what the
// client believes; this only decides whether to offer the affordance. A stale snapshot means a button that
// briefly should not be there, not a call that should not have been allowed.

export type AiFeatureKey =
  | "search.semantic"
  | "tickets.triage"
  | "cards.triage"
  | "drafting"
  | "ats.extraction"
  | "tables.describe"
  | "analytics.narrate"
  | "moderation"
  | "suggestions.similar"
  | "attention.summary";

type AiSetting = { features?: Partial<Record<AiFeatureKey, boolean>> };

/**
 * True when `key` is on. Starts false and flips when the setting arrives, which is the right way round: an
 * affordance that appears a moment late is unremarkable, one that appears and then vanishes is not.
 *
 * A missing or unreadable setting leaves it false, matching the server's own default.
 */
export function useAiFeature(key: AiFeatureKey): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    getSetting<AiSetting>("ai")
      .then((s) => { if (live) setOn(s.value?.features?.[key] === true); })
      .catch(() => { /* not configured, or not readable: the feature is off */ });
    return () => { live = false; };
  }, [key]);
  return on;
}
