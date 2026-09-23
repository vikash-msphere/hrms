// Posts the moderation gate is holding, and the one predicate that keeps them out of every read.
//
// WHAT A HOLD IS. With `moderation` switched on, a post is written invisible, read by a model, and only then
// published (`services/moderation.ts moderationGate`). Between those two moments - and indefinitely, when the
// model objected or could not answer - the row exists and nobody may see it. `held_at` is that state, and it
// is on the three walls that can be held: announcements, their replies, and suggestions.
//
// WHY IT IS ITS OWN COLUMN AND NOT AN ABSENCE OF `published`. A draft and a held post are both invisible to
// the board, and they are invisible to DIFFERENT PEOPLE. A draft is withheld from readers and shown to the
// editors who may see restricted rows - that is what `STATE_VISIBILITY` means, and it is a deliberate
// editorial state. A held post is withheld from EVERYONE, including those same editors and including its own
// author, because the question it is waiting on is "may this be seen at all". Expressed as a `published`
// flag it would leak into every drafts view HR opens.
//
// WHY THE PREDICATE IS HERE RATHER THAN IN EACH QUERY. There are a dozen reads over these three tables (the
// board feed, a single post, the replies under it, the suggestion box, search, the activity counts) and a
// held row must be absent from all of them. One of them forgetting is not a cosmetic bug: it is the gate not
// holding, on the one surface where somebody looked. So the rule is written once and the call sites say
// `notHeld(table)`.
//
// THE ONE PLACE THAT DELIBERATELY IGNORES IT is the moderation queue itself (`listModerationQueue`), which
// exists precisely to show what is being held. It reads the host rows directly and says so in its own
// comments.
import { isNull, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/** The tables that carry `held_at`, by collection. A collection absent here cannot be held. */
export const HELDABLE = ["announcements", "announcement-replies", "suggestions"] as const;

/**
 * `held_at IS NULL` for a table that has the column, or undefined for one that does not.
 *
 * Undefined rather than a thrown error or a false predicate: this is called from generic CRUD that runs over
 * every collection in the app, and "this table cannot be held" is the normal answer for almost all of them.
 * A table that CAN be held but whose read forgets to call this is the failure mode worth worrying about, and
 * `test/withheldReads.test.ts` is what watches for it.
 */
// `any` for the table, like the other generic predicates in this layer (`publicStateFilter`): this is called
// from CRUD that runs over every table in the app, and drizzle's table types do not unify.
export function notHeld(table: any): SQL | undefined {
  const col = (table as { heldAt?: AnySQLiteColumn }).heldAt;
  return col ? isNull(col) : undefined;
}

/** Whether a row the caller already has in hand is being held, for the item lane. */
export const isHeld = (row: { heldAt?: Date | null } | undefined | null): boolean => !!row?.heldAt;
