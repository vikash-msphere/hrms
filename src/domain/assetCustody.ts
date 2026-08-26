// Asset custody: who is holding this thing, and what proves it.
//
// The printed sticker is the evidence. An asset nobody has scanned is `pending_verification` (the company
// claims to hold it) or `pending_ack` (an employee is claimed to hold it); scanning the tag turns either
// claim into `in_stock` / `assigned`. Everything here is pure so the transition table and the scan matcher
// are unit-testable without a database - the service does the I/O around it.

export type AssetStatus = "pending_verification" | "in_stock" | "pending_ack" | "assigned" | "repair" | "retired";

/** Condition the holder reports when confirming receipt (or the stock-taker when checking one in). */
export type AssetCondition = "good" | "damaged" | "missing_parts";
export const ASSET_CONDITIONS: AssetCondition[] = ["good", "damaged", "missing_parts"];

/**
 * The org's `settings/asset-tags.custody` block. Both enforcement flags default ON - unproven custody is the
 * whole point - and turning them off restores the pre-custody behaviour (create lands in stock, assignment
 * lands assigned) without touching any code path.
 */
export type CustodyPolicy = {
  requireStockScan: boolean;
  requireAck: boolean;
  allowManualAck: boolean;
  ackReminderDays: number;
  verifyStaleDays: number;
};

export const DEFAULT_CUSTODY: CustodyPolicy = {
  requireStockScan: true,
  requireAck: true,
  allowManualAck: false,
  ackReminderDays: 3,
  verifyStaleDays: 180,
};

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const posInt = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);

/** Resolve the policy from the (partial, possibly absent) `settings/asset-tags` blob. */
export function custodyPolicy(settings: unknown): CustodyPolicy {
  const c = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).custody : undefined) as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return DEFAULT_CUSTODY;
  return {
    requireStockScan: bool(c.stock_scan_required, DEFAULT_CUSTODY.requireStockScan),
    requireAck: bool(c.ack_required, DEFAULT_CUSTODY.requireAck),
    allowManualAck: bool(c.manual_ack_allowed, DEFAULT_CUSTODY.allowManualAck),
    ackReminderDays: posInt(c.ack_reminder_days, DEFAULT_CUSTODY.ackReminderDays),
    verifyStaleDays: posInt(c.verify_stale_days, DEFAULT_CUSTODY.verifyStaleDays),
  };
}

/** Where an asset lands when it is (re)assigned to somebody, or returned to the company. */
export function statusForAssignment(policy: CustodyPolicy, assignedTo: string | null): AssetStatus {
  if (assignedTo) return policy.requireAck ? "pending_ack" : "assigned";
  return policy.requireStockScan ? "pending_verification" : "in_stock";
}

/** True for the two states that exist only because nobody has scanned the tag yet. */
export function isPending(status: string): boolean {
  return status === "pending_verification" || status === "pending_ack";
}

/**
 * What a scanned string proves about this asset. Two tiers, because only one of the things a sticker can carry
 * is unguessable:
 *
 *   "secret"     - the tag secret printed inside the QR. Real evidence: it is served only to callers who hold
 *                  `printTag`, so possessing it means possessing the sticker.
 *   "identifier" - the wire id (from a deep-link / found URL) or the human asset tag. These DO come off a real
 *                  sticker - a laser scanner reading a Code 128 label produces the asset tag and nothing else -
 *                  but they are also on every serialized asset row the caller could already read, so a match
 *                  proves only that the caller named the right asset. Never a sighting's evidence.
 *   null         - the scan belongs to some other asset (or to nothing).
 *
 * The internal uuid is accepted at the identifier tier for the same reason the wire id is: it is what a scan
 * of an internally-generated deep link decodes to.
 *
 * Matching is done on the raw scan rather than a parsed shape so a payload that gained a query string, a
 * trailing newline from a USB wedge, or surrounding whitespace still matches.
 */
export type ScanProof = "secret" | "identifier";

export function scanProof(scan: string, asset: { uuid: string; wireId?: string | null; assetTag?: string | null; tagSecret?: string | null }): ScanProof | null {
  const t = scan.trim();
  if (!t) return null;
  const hay = t.toLowerCase();
  const tokens = new Set(hay.split(/[^a-z0-9_-]+/i).filter(Boolean));
  const has = (v?: string | null) => !!v && (tokens.has(v.toLowerCase()) || hay === v.toLowerCase());
  if (has(asset.tagSecret)) return "secret";
  if (has(asset.wireId) || has(asset.uuid) || has(asset.assetTag)) return "identifier";
  return null;
}

/** Does this scan name this asset at all (either tier)? For "is this the right thing", not "is this proved". */
export function scanMatchesAsset(scan: string, asset: { uuid: string; wireId?: string | null; assetTag?: string | null; tagSecret?: string | null }): boolean {
  return scanProof(scan, asset) !== null;
}

/**
 * A tag secret: 10 chars of Crockford-ish base32, no vowels, so it cannot be mistyped into a rude word.
 *
 * Rejection sampling, not `% 30`: 256 is not a multiple of the alphabet, so a plain modulo makes the first
 * sixteen symbols measurably likelier than the rest. This is the value that proves somebody is holding the
 * sticker, so it is drawn uniformly - bytes at or above the largest usable multiple of 30 are thrown away and
 * redrawn rather than folded in.
 */
const SECRET_ALPHABET = "0123456789BCDFGHJKLMNPQRSTVWXZ";
const SECRET_LENGTH = 10;
export function mintTagSecret(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % SECRET_ALPHABET.length); // 240: the largest whole number of alphabets in a byte
  let out = "";
  while (out.length < SECRET_LENGTH) {
    // Draw a little more than is needed, so the usual case is one call however many bytes get rejected.
    for (const b of random(SECRET_LENGTH)) {
      if (b >= limit) continue;
      out += SECRET_ALPHABET[b % SECRET_ALPHABET.length];
      if (out.length === SECRET_LENGTH) break;
    }
  }
  return out;
}

/** Whole days between two instants, floored - the unit every custody reminder is expressed in. */
export function daysBetween(from: Date | number, to: Date | number): number {
  return Math.floor((+to - +from) / 86_400_000);
}
