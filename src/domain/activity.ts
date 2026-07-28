// Coarse action tone (category) taxonomy — the source of truth mirrored by web/src/lib/activity.ts. Groups
// the fine-grained audit verbs so the activity feed can color-code and filter by category. Server-side so the
// `?tone=` filter can be applied in SQL when the log is paginated (client-side filtering only sees loaded pages).
export type ActionTone = "create" | "update" | "move" | "assign" | "remove" | "positive" | "comment" | "read" | "denied" | "other";

const TONE: Record<string, ActionTone> = {
  create: "create", add: "create", award: "create", record: "create",
  update: "update", configure: "update", prioritize: "update", updateProgress: "update", disburse: "update", skipStage: "update",
  move: "move",
  assign: "assign",
  delete: "remove", purge: "remove", cancel: "remove", reject: "remove", block: "remove", close: "remove",
  restore: "positive", unblock: "positive", approve: "positive", complete: "positive", activate: "positive", resolve: "positive", acknowledge: "positive", launch: "positive", enroll: "positive", submit: "positive", start: "positive", reopen: "positive",
  comment: "comment", nominate: "comment",
  // Access-audit rows (written by the middleware): `<col>.read.sensitive` (a sensitive read) and
  // `access.denied` (a blocked attempt — the abuse signal). `verbOf` keys on the last dotted segment.
  sensitive: "read", denied: "denied",
};

export const MAPPED_VERBS = Object.keys(TONE);
const verbOf = (action: string) => (action.includes(".") ? action.slice(action.lastIndexOf(".") + 1) : action);
export function actionTone(action: string): ActionTone {
  return TONE[verbOf(action)] ?? "other";
}
// Verbs belonging to a tone — for the SQL `action LIKE '%.<verb>'` filter. "other" = every unmapped verb (no
// finite list), signalled by returning null so the caller filters by exclusion instead.
export function verbsForTone(tone: string): string[] | null {
  if (tone === "other") return null;
  return Object.entries(TONE).filter(([, t]) => t === tone).map(([v]) => v);
}
