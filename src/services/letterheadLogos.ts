import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

// The org's LETTERHEAD CATALOGUE: the logos letters can be issued on - one per legal entity, brand or business
// unit - so HR signs each document on the right letterhead instead of every letter carrying the single
// organization logo. A letter template names its default (letter_templates.letterhead_id) and whoever generates
// a letter can override it for that one document.
//
// Flat catalog, one row per logo. The ARTWORK lives in R2 (`letterhead-logos/<uuid>`), not in the row and not
// in a settings blob: lib/refData.ts snapshots the whole settings table on the first settings read of a
// request, so an image parked there would be bytes read on nearly every request forever.
export type LetterheadLogoInput = { label?: string };

// A letterhead prints at ~46pt tall; 256 KB matches the organization logo's cap in the Settings UI.
const MAX_BYTES = 256 * 1024;
// pdf-lib embeds PNG and JPEG only (lib/pdfPrimitives embedLogo). An SVG would store happily and then silently
// vanish from every rendered letter, so it is refused at the door.
const ALLOWED = new Set(["image/png", "image/jpeg"]);

const r2Key = (uuid: string) => `letterhead-logos/${uuid}`;
/** The catalogue uuid a `letterhead-logos/<id>` ref (or a bare id) names. */
export const letterheadIdOf = (ref?: string | null): string | undefined => ref?.split("/").pop() || undefined;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function loadLogo(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.letterheadLogos).where(eq(schema.letterheadLogos.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("letterhead logo not found");
  return row;
}

export async function uploadLetterheadImage(deps: Deps, actor: AppUser, id: string, bytes: ArrayBuffer, contentType = "image/png") {
  const logo = await loadLogo(deps, id);
  const type = contentType.toLowerCase() === "image/jpg" ? "image/jpeg" : contentType.toLowerCase();
  if (!bytes.byteLength) throw invalidArgument("empty image");
  if (bytes.byteLength > MAX_BYTES) throw invalidArgument("image too large (max 256 KB)");
  if (!ALLOWED.has(type)) throw invalidArgument("a letterhead must be a PNG or JPEG - a PDF cannot embed anything else");
  const key = r2Key(logo.uuid);
  await deps.docs.put(key, bytes, type);
  const [updated] = await deps.db
    .update(schema.letterheadLogos)
    .set({ r2Key: key, contentType: type, sizeBytes: bytes.byteLength, updatedAt: new Date() })
    .where(eq(schema.letterheadLogos.uuid, logo.uuid))
    .returning();
  await audit(deps, actor, "letterhead-logo.image.update", "letterhead-logos", logo.uuid);
  return updated!;
}

/** The raw artwork, for the branding editor's preview. */
export async function getLetterheadImage(deps: Deps, id: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const logo = await loadLogo(deps, id);
  const bytes = logo.r2Key ? await deps.docs.get(logo.r2Key) : null;
  if (!bytes) throw notFound("this letterhead has no image yet");
  return { bytes, contentType: logo.contentType || "image/png" };
}

/**
 * The chosen letterhead as a data URL, ready for lib/pdfPrimitives embedLogo. This is the RENDER path: it is
 * not access-gated (the caller already passed the generateLetter/previewLetter gate) and never throws - an
 * absent, deleted or image-less logo returns undefined and the letter falls back to the organization logo.
 */
export async function letterheadDataUrl(deps: Deps, ref?: string | null): Promise<string | undefined> {
  const id = letterheadIdOf(ref);
  if (!id) return undefined;
  const row = (await deps.db.select().from(schema.letterheadLogos).where(eq(schema.letterheadLogos.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime || !row.r2Key) return undefined;
  const bytes = await deps.docs.get(row.r2Key);
  return bytes ? `data:${row.contentType || "image/png"};base64,${toBase64(bytes)}` : undefined;
}

/** Hard delete takes the artwork with it; the generic purge knows nothing about the R2 object. */
export async function purgeLetterheadLogo(deps: Deps, actor: AppUser, id: string): Promise<void> {
  const row = (await deps.db.select().from(schema.letterheadLogos).where(eq(schema.letterheadLogos.uuid, id)).limit(1))[0];
  if (!row) throw notFound("letterhead logo not found");
  if (row.r2Key) await deps.docs.delete(row.r2Key).catch(() => {});
  await deps.db.delete(schema.letterheadLogos).where(eq(schema.letterheadLogos.uuid, id));
  await audit(deps, actor, "letterhead-logo.purge", "letterhead-logos", id);
}

export const letterheadLogoSpec: CrudSpec<LetterheadLogoInput, typeof schema.letterheadLogos> = {
  table: schema.letterheadLogos,
  collection: "letterhead-logos",
  auditName: "letterhead-logo",
  notFound: "letterhead logo not found",
  insert: (input) => {
    if (!input.label?.trim()) throw invalidArgument("label is required");
    return { label: input.label.trim() };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.letterheadLogos> = {};
    if (has(patch, "label")) { if (!patch.label?.trim()) throw invalidArgument("label cannot be empty"); set.label = patch.label.trim(); }
    return set;
  },
};
