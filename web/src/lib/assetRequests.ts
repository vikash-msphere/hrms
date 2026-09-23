// Asset-request presentation: the five states a request can be in, read. Kept out of the components so the
// profile card, the Assets page queue and the approvals inbox all label a request the same way.
//
// ISSUED is the terminal state that actually gave somebody something: an approved request is still a promise
// until an asset is handed over, and the asset then waits in `pending_ack` until its holder scans the tag.
export const ASSET_REQUEST_STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "ISSUED"] as const;
export type AssetRequestState = (typeof ASSET_REQUEST_STATES)[number];

export const ASSET_REQUEST_STATE_LABEL: Record<string, string> = {
  PENDING: "Awaiting decision",
  APPROVED: "Approved - awaiting hand-over",
  REJECTED: "Rejected",
  CANCELLED: "Withdrawn",
  ISSUED: "Handed over",
};

export const ASSET_REQUEST_STATE_TONE: Record<string, string> = {
  PENDING: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  APPROVED: "bg-primary/10 text-primary",
  REJECTED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
  ISSUED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

/** A request still going somewhere: it is waiting on a decision, or on the kit it was promised. */
export const isOpenAssetRequest = (state?: string) => state === "PENDING" || state === "APPROVED";
