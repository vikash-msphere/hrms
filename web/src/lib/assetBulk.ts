// Reading a delivery note into a list of assets.
//
// Adding stock in bulk comes in exactly two shapes, and they want different things from a form: a box of
// twenty identical adapters is a NUMBER (nothing tells one from another), while twenty laptops are twenty
// SERIALS (each one is a specific machine, and the serial is the only handle on it). This module is the second
// shape: turn whatever was pasted or scanned into rows, and say per line what it read - because the failure
// worth designing against is not a rejected line, it is a line that parsed into the wrong serial and got
// created anyway.
//
// Same forgiving-but-strict spirit as lib/holidayBulk.ts, and the same rule: nothing is written until the
// preview looks right.

/** One parsed line: the serial it names (plus an optional per-line name override), or why it can't be used. */
export type BulkAssetRow = {
  line: number;
  raw: string;
  serial?: string;
  /** A name typed after the serial, overriding the "same name for all" field. */
  name?: string;
  error?: string;
};

// Long enough for the longest real serial (GS1 allows 20; some vendors concatenate part + serial), short
// enough that a whole pasted paragraph is caught as the mistake it is.
const MAX_SERIAL = 64;

/** A serial that is really a whole field separated line: commas, tabs and `|` all count as separators. */
const split = (line: string) => line.split(/\s*[|\t,;]\s*/).map((p) => p.trim());

/**
 * Parse pasted (or scanned) lines into serial rows.
 *
 * One line per device: the serial first, then optionally a name for that one device. Blank lines and `#`
 * comments are skipped entirely - they are how people annotate a paste - and a repeat inside the same paste is
 * reported on the SECOND occurrence, so the first row still creates.
 */
export function parseSerialLines(text: string): BulkAssetRow[] {
  const rows: BulkAssetRow[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [first, ...rest] = split(trimmed);
    const serial = (first ?? "").trim();
    if (!serial) {
      rows.push({ line, raw: trimmed, error: "no serial number on this line" });
      return;
    }
    if (serial.length > MAX_SERIAL) {
      rows.push({ line, raw: trimmed, error: `that is ${serial.length} characters - check it is one serial and not a whole paste` });
      return;
    }
    const key = serial.toLowerCase();
    if (seen.has(key)) {
      rows.push({ line, raw: trimmed, error: "this serial is already on an earlier line" });
      return;
    }
    seen.add(key);
    const name = rest.join(" ").trim();
    rows.push({ line, raw: trimmed, serial, ...(name ? { name } : {}) });
  });
  return rows;
}

/** The serials a parse produced, in order - what actually gets sent. */
export const usableSerials = (rows: BulkAssetRow[]) => rows.filter((r) => !!r.serial && !r.error);

/**
 * Append a scanned serial to the text in the box, skipping one that is already there.
 *
 * Continuous scanning is the point of the camera in this dialog (point it at box after box), so the same label
 * drifting back into frame must not add a second line. Returns the new text and whether it grew.
 */
export function appendSerial(text: string, serial: string): { text: string; added: boolean } {
  const clean = serial.trim();
  if (!clean) return { text, added: false };
  const already = parseSerialLines(text).some((r) => r.serial?.toLowerCase() === clean.toLowerCase());
  if (already) return { text, added: false };
  const sep = !text || text.endsWith("\n") ? "" : "\n";
  return { text: `${text}${sep}${clean}\n`, added: true };
}

/**
 * How to split a run of `total` assets into calls of at most `perCall`.
 *
 * The server takes a bounded delivery per call (services/assets.ts ASSET_BATCH_MAX), so a bigger paste is
 * several calls - and the client, not the server, is the one that can then say "40 of 120" while it works.
 */
export function batchSizes(total: number, perCall: number): number[] {
  const out: number[] = [];
  for (let left = total; left > 0; left -= perCall) out.push(Math.min(perCall, left));
  return out;
}
