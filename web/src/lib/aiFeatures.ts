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
  | "goals.similar"
  | "goals.measure"
  | "boards.narrate"
  | "drafting"
  | "ats.extraction"
  | "expenses.receiptExtraction"
  | "tables.describe"
  | "analytics.narrate"
  | "budgets.narrate"
  | "moderation"
  | "moderation.conduct"
  | "suggestions.similar"
  | "attention.summary";

type AiSetting = { features?: Partial<Record<AiFeatureKey, boolean>> };

/**
 * The longest instruction, or existing draft, a drafting call accepts.
 *
 * Mirrors `MAX_DRAFT_INPUT` in `src/domain/aiDraft.ts`, which is where the cap is enforced - the route
 * answers 400 past it. Held here so the composer can stop somebody at the box instead of after a round trip:
 * the case the server rejects is improving a long announcement, which is the exact thing the "Improve" label
 * invites. `test/draftInputCap.test.ts` holds the two numbers together.
 */
export const MAX_DRAFT_INPUT = 4000;

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
