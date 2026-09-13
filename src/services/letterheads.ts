import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, removedMeta } from "../lib/audit";
import { aborted, invalidArgument, notFound } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";
import {
  letterheadDesignOrStock,
  parseLetterheadDesign,
  slotsUsedBy,
  type LetterheadDesign,
  type LetterheadSlot,
  type LetterheadVariant,
} from "../domain/letterhead";
import { renderLetterPdf, type LetterBlock, type LetterheadSpec } from "../lib/letterPdf";
import { formatLongDate } from "../lib/pdfPrimitives";
import { getSettingValue } from "./settings";

// The org's LETTERHEAD CATALOGUE: the stationery documents are issued on - one per legal entity, brand or
// business unit - so HR signs each document on the right letterhead instead of every one carrying the single
// organization logo. A row is a whole page, not just a mark: `design_json` holds the margins, typeface,
// palette, header band, footer band and watermark (domain/letterhead.ts). A letter template names its default
// (letter_templates.letterhead_id) and whoever generates a letter can override it for that one document.
//
// Flat catalog, one row per letterhead. The ARTWORK lives in R2 (`letterheads/<uuid>`), not in the row and not
// in a settings blob: lib/refData.ts snapshots the whole settings table on the first settings read of a
// request, so an image parked there would be bytes read on nearly every request forever.
export type LetterheadInput = { label?: string; design?: LetterheadDesign | null; print_design?: LetterheadDesign | null };

// A letterhead is a PAIR of pages: the one documents render on, and the one they should come out of a printer
// on. They are usually the same page minus the ink - no flooded background - or, for an org whose paper is
// already pre-printed, a print page with the header band off and its height reserved instead. A letterhead
// with no print design prints exactly as it renders, which is what most of them want.
// One name for the two versions, re-exported so callers outside this module (offer letters, review exports)
// do not each invent their own "screen | print".
export type LetterheadMedia = LetterheadVariant;

/** The design a row uses for one medium. Print falls back to the screen page, never to the stock one. */
const designFor = (row: { designJson: string | null; printDesignJson: string | null }, media: LetterheadMedia): LetterheadDesign =>
  letterheadDesignOrStock(media === "print" ? row.printDesignJson ?? row.designJson : row.designJson);

/** Validate a written design and store it canonically; `null` (or an empty design) clears it to the stock page. */
// `keepEmpty` is what separates the two pages. For the SCREEN design an empty object means "no design of its
// own" - the stock page - so it collapses to null. For the PRINT page the object's mere existence is the
// fact being stored ("this letterhead has a print version"), and a print version that keeps every stock
// setting is a real answer, not an absent one: collapsing it to null silently dropped the version the
// designer had just added, and the letter engine then printed on the screen page.
function encodeDesign(design: LetterheadDesign | null | undefined, keepEmpty = false): string | null {
  if (design == null) return null;
  let parsed;
  try {
    parsed = parseLetterheadDesign(design);
  } catch (e) {
    throw invalidArgument(`letterhead design: ${(e as Error).message}`);
  }
  return keepEmpty || Object.keys(parsed).length ? JSON.stringify(parsed) : null;
}

// Every OTHER generated document picks its letterhead the same way, but has no per-document dialog and (bar the
// letter engine) no template row to hang a choice on, so the choice is org-wide: settings/organization
// `document_logos` maps a document kind to a `letterheads/<id>` ref. Absent or blank = the organization
// logo, which is what a single-brand org leaves it at.
export const DOCUMENT_KINDS = ["letter", "payslip", "form16", "offer", "review"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type OrgWithDocumentLogos = { document_logos?: Partial<Record<DocumentKind, string>> };

// Stationery needs real resolution across a whole A4 sheet - hence 1 MB rather than the organization logo's
// 256 KB. Each image a page draws is embedded into every PDF issued on it, so the cap is also the document's
// weight; only the slots a design actually draws are embedded (domain/letterhead slotsUsedBy).
const MAX_BYTES = 1024 * 1024;
// pdf-lib embeds PNG and JPEG only (lib/pdfPrimitives embedLogo). An SVG would store happily and then silently
// vanish from every rendered letter, so it is refused at the door.
const ALLOWED = new Set(["image/png", "image/jpeg"]);

/** One stored image. The bytes live in R2 under `key`; the row carries only this record of them. */
export type LetterheadAsset = { key: string; content_type: string; size_bytes: number };
/** Every image the letterhead holds, per VERSION. The two versions never read each other's. */
export type LetterheadAssets = Partial<Record<LetterheadVariant, Partial<Record<LetterheadSlot, LetterheadAsset>>>>;

const r2Key = (uuid: string, variant: LetterheadVariant, slot: LetterheadSlot) => `letterheads/${uuid}/${variant}/${slot}`;
/** The catalogue uuid a `letterheads/<id>` ref (or a bare id) names. */
export const letterheadIdOf = (ref?: string | null): string | undefined => ref?.split("/").pop() || undefined;

/** A row's images. A blob that no longer parses reads as "no images" rather than failing the document. */
export function assetsOf(row: { assetsJson: string | null }): LetterheadAssets {
  if (!row.assetsJson) return {};
  try {
    const parsed = JSON.parse(row.assetsJson) as LetterheadAssets;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** One version's images. A print version with none of its own has none - it does NOT borrow the screen's. */
const variantAssets = (row: { assetsJson: string | null }, variant: LetterheadVariant) => assetsOf(row)[variant] ?? {};

/**
 * Does this letterhead HAVE a print version? A print design makes one, and so does an image uploaded against
 * print - somebody who has given printing its own stationery has a print version, whether or not they also
 * changed a margin. Without one, printing is the screen version wholesale.
 */
export const hasPrintVersion = (row: { printDesignJson: string | null; assetsJson: string | null }) =>
  !!row.printDesignJson || Object.keys(assetsOf(row).print ?? {}).length > 0;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function loadRow(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.letterheads).where(eq(schema.letterheads.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("letterhead not found");
  return row;
}

/**
 * Change `assets_json` by reading it, editing it in memory and writing it back - with a COMPARE-AND-SET on the
 * exact value that was read, the way services/tickets.ts#writeAttachments and services/stocktakes.ts do.
 *
 * The column holds every image of BOTH versions of the letterhead, so an unguarded rewrite from a read loses
 * the other one: two uploads in flight at once - the screen mark and the print mark, which is the ordinary way
 * somebody sets a letterhead up - and the second write is built from a snapshot taken before the first. The
 * first image vanishes from the record while its bytes stay in R2, so the generated document quietly prints
 * without it and nothing says why.
 *
 * The whole step re-runs against the fresh row on a lost race (so "there is no such image" is re-decided
 * against what is actually there), and is bounded so a pathological hot row fails loudly instead of spinning.
 */
async function writeAssets(
  deps: Deps,
  id: string,
  step: (current: LetterheadAssets, row: typeof schema.letterheads.$inferSelect) => LetterheadAssets,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await loadRow(deps, id);
    const next = step(assetsOf(row), row);
    const json = Object.keys(next).length ? JSON.stringify(next) : null;
    const [updated] = await deps.db
      .update(schema.letterheads)
      .set({ assetsJson: json, updatedAt: new Date() })
      .where(and(eq(schema.letterheads.uuid, id), row.assetsJson === null ? isNull(schema.letterheads.assetsJson) : eq(schema.letterheads.assetsJson, row.assetsJson)))
      .returning();
    if (updated) return { updated, before: row };
  }
  throw aborted("this letterhead's images are being changed by somebody else - try again");
}

export async function uploadLetterheadImage(
  deps: Deps,
  actor: AppUser,
  id: string,
  bytes: ArrayBuffer,
  contentType = "image/png",
  slot: LetterheadSlot = "mark",
  variant: LetterheadVariant = "screen"
) {
  const row = await loadRow(deps, id);
  const type = contentType.toLowerCase() === "image/jpg" ? "image/jpeg" : contentType.toLowerCase();
  if (!bytes.byteLength) throw invalidArgument("empty image");
  if (bytes.byteLength > MAX_BYTES) throw invalidArgument("image too large (max 1 MB)");
  if (!ALLOWED.has(type)) throw invalidArgument("a letterhead must be a PNG or JPEG - a PDF cannot embed anything else");
  const key = r2Key(row.uuid, variant, slot);
  await deps.docs.put(key, bytes, type);
  // Written into THIS version's images only - the other version keeps whatever it had, including nothing.
  let had = false;
  const { updated } = await writeAssets(deps, row.uuid, (all) => {
    had = !!all[variant]?.[slot]?.key;
    return { ...all, [variant]: { ...(all[variant] ?? {}), [slot]: { key, content_type: type, size_bytes: bytes.byteLength } } };
  });
  // WHICH image on which version. The snapshot argument was carrying that pair, where nothing reads it -
  // `describeRow` wants the record, and the variant/slot belong in the meta the feed renders.
  await audit(deps, actor, "letterhead.image.update", "letterheads", row.uuid, { diff: { [`${variant} ${slot}`]: { from: had ? "an image" : null, to: `${type}, ${bytes.byteLength} bytes` } } }, updated);
  return updated;
}

/** Drop one image from one version. Nothing else moves - not the other slots, not the other version. */
export async function deleteLetterheadImage(deps: Deps, actor: AppUser, id: string, slot: LetterheadSlot, variant: LetterheadVariant = "screen") {
  // Which object to drop from R2 is decided inside the guarded step, against the row that is actually
  // written - the same shape as the upload, and for the same reason: the other version's images live in this
  // one column, so an unguarded rewrite from a read deletes whichever one landed in between.
  let deletedKey: string | undefined;
  const { updated } = await writeAssets(deps, id, (all) => {
    const mine = { ...(all[variant] ?? {}) };
    const asset = mine[slot];
    if (!asset) throw notFound(`this letterhead's ${variant} version has no ${slot} image`);
    deletedKey = asset.key;
    delete mine[slot];
    const assets: LetterheadAssets = { ...all, [variant]: mine };
    if (!Object.keys(mine).length) delete assets[variant];
    return assets;
  });
  if (deletedKey) await deps.docs.delete(deletedKey).catch(() => {}); // a missing object still clears the record
  await audit(deps, actor, "letterhead.image.delete", "letterheads", id, { diff: { [`${variant} ${slot}`]: { from: "an image", to: null } } }, updated);
  return updated;
}

/** One raw image, for the branding editor's thumbnails. */
export async function getLetterheadImage(
  deps: Deps,
  id: string,
  slot: LetterheadSlot = "mark",
  variant: LetterheadVariant = "screen"
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const asset = variantAssets(await loadRow(deps, id), variant)[slot];
  const bytes = asset ? await deps.docs.get(asset.key) : null;
  if (!bytes) throw notFound(`this letterhead's ${variant} version has no ${slot} image yet`);
  return { bytes, contentType: asset!.content_type || "image/png" };
}

/** One version's images as data URLs, ready for lib/letterPdf. Only the slots asked for are read out of R2. */
async function readAssets(
  deps: Deps,
  row: { assetsJson: string | null },
  slots: LetterheadSlot[],
  variant: LetterheadVariant
): Promise<Partial<Record<LetterheadSlot, string>>> {
  const assets = variantAssets(row, variant);
  const out: Partial<Record<LetterheadSlot, string>> = {};
  await Promise.all(
    slots.map(async (slot) => {
      const asset = assets[slot];
      if (!asset) return;
      const bytes = await deps.docs.get(asset.key);
      if (bytes) out[slot] = `data:${asset.content_type || "image/png"};base64,${toBase64(bytes)}`;
    })
  );
  return out;
}

/**
 * The chosen letterhead, ready for lib/letterPdf: its page design plus the images that design draws. This is
 * the RENDER path: it is not access-gated (the caller already passed the generateLetter/previewLetter gate)
 * and never throws - an absent or deleted row returns undefined and the document falls back to the stock page
 * with the organization logo. A row whose image has gone still renders its design, just without that image.
 */
export async function resolveLetterhead(deps: Deps, ref?: string | null, media: LetterheadMedia = "screen"): Promise<LetterheadSpec | undefined> {
  const id = letterheadIdOf(ref);
  if (!id) return undefined;
  const row = (await deps.db.select().from(schema.letterheads).where(eq(schema.letterheads.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) return undefined;
  // A print version with no design of its own falls back to the screen DESIGN - and, to stay consistent, to
  // the screen version's images too. A print version that exists uses only its own.
  // A letterhead with NO print version prints as it renders - the screen design and, so the page holds
  // together, the screen images. The moment a print version exists it uses its own and only its own, even if
  // that means it has none: a print version that deliberately drops the stationery must not have the screen
  // sheet handed back to it.
  const version = hasPrintVersion(row) ? media : "screen";
  const design = designFor(row, media);
  return { design, artwork: await readAssets(deps, row, slotsUsedBy(design), version) };
}

/** The images a FROZEN design needs, for a re-render whose design came from a document's sidecar. */
export async function letterheadArtwork(
  deps: Deps,
  ref: string | null | undefined,
  design: LetterheadDesign,
  media: LetterheadMedia = "screen"
): Promise<Partial<Record<LetterheadSlot, string>>> {
  const id = letterheadIdOf(ref);
  if (!id) return {};
  const row = (await deps.db.select().from(schema.letterheads).where(eq(schema.letterheads.uuid, id)).limit(1))[0];
  if (!row) return {};
  // A letterhead with NO print version prints as it renders - the screen design and, so the page holds
  // together, the screen images. The moment a print version exists it uses its own and only its own, even if
  // that means it has none: a print version that deliberately drops the stationery must not have the screen
  // sheet handed back to it.
  const version = hasPrintVersion(row) ? media : "screen";
  return readAssets(deps, row, slotsUsedBy(design), version);
}

/** The print page a letterhead asks for, or undefined when it has none and printing is just the screen page. */
export async function printDesignOf(deps: Deps, ref?: string | null): Promise<LetterheadDesign | undefined> {
  const id = letterheadIdOf(ref);
  if (!id) return undefined;
  const row = (await deps.db.select().from(schema.letterheads).where(eq(schema.letterheads.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime || !row.printDesignJson) return undefined;
  return letterheadDesignOrStock(row.printDesignJson);
}

/**
 * The letterhead a document renders on. `overrides` are the choices MORE specific than the org-wide
 * `document_logos[kind]`, narrowest first (a generate call's ref, then the template's): the first one that was
 * actually made wins, where `undefined` means "not chosen at this level" and `""`/`null` means "chosen: no
 * letterhead". `undefined` back means the caller keeps the stock page and the organization logo.
 */
export async function documentLetterhead(
  deps: Deps,
  org: OrgWithDocumentLogos,
  kind: DocumentKind,
  overrides: (string | null | undefined)[] = [],
  media: LetterheadMedia = "screen"
): Promise<LetterheadSpec | undefined> {
  return resolveLetterhead(deps, documentLetterheadRef(org, kind, overrides), media);
}

/** Which letterhead that resolution lands on, without fetching it - for freezing the choice into a document. */
export function documentLetterheadRef(
  org: OrgWithDocumentLogos,
  kind: DocumentKind,
  overrides: (string | null | undefined)[] = []
): string | undefined {
  for (const ref of overrides) {
    if (ref === undefined) continue;
    return ref || undefined; // "" / null was a deliberate "no letterhead", and stops the chain
  }
  return org.document_logos?.[kind];
}

/**
 * A representative document rendered on one letterhead, for the design editor's live preview: real org name
 * and address, sample body copy, and enough of it to run onto a second page so the continuation header and the
 * page-numbered footer can be judged too. `draft` (when given) is validated and rendered INSTEAD of the stored
 * design, so an unsaved edit can be seen before it is committed.
 */
export async function renderLetterheadSample(deps: Deps, id: string, draft?: unknown, media: LetterheadMedia = "screen"): Promise<Uint8Array> {
  const row = await loadRow(deps, id);
  let design: LetterheadDesign;
  try {
    design = draft === undefined ? designFor(row, media) : parseLetterheadDesign(draft);
  } catch (e) {
    throw invalidArgument(`letterhead design: ${(e as Error).message}`);
  }
  const org = await getSettingValue<{ name?: string; legal_name?: string; address?: string; logo?: string }>(deps, "organization", {});
  const para = (text: string): LetterBlock => ({ kind: "para", runs: [text] });
  const { bytes: pdf } = await renderLetterPdf({
    org: { name: org.name ?? "", address: org.address, logo: org.logo, legalName: org.legal_name || undefined },
    // The version asked for, FULL STOP - no falling back to the screen version's images. This preview backs
    // the editor, where a print version is routinely being designed before it has been saved: keying the
    // images off whether a print design is already stored meant the print version previewed with the screen
    // version's artwork for as long as it went unsaved, which is exactly when someone is looking at it.
    letterhead: { design, artwork: await readAssets(deps, row, slotsUsedBy(design), media) },
    date: formatLongDate(deps.clock.now()),
    ref: `Ref: ${row.label}/PREVIEW/001`,
    to: { name: "Sample Recipient", lines: ["Designation", "Department"] },
    blocks: [
      { kind: "subject", text: "Letterhead preview" },
      para("Dear Sample Recipient,"),
      para(
        "This page is rendered on this letterhead exactly as a real document will be: the same margins, typeface, palette, header band and footer band. Body copy runs at the width your margins leave, so a wide header or a deep footer shows up here as less room for the letter itself."
      ),
      para(
        "The paragraphs below exist only to push this preview onto a second sheet, where the continuation header and the page-numbered footer can be judged. Nothing here is stored and no document is filed."
      ),
      { kind: "bullets", items: [["Header band: name, address, extra lines, the mark and the rule under them."], ["Footer band: the three cells, with {{page}} and {{pages}} filled in."], ["Watermark and full-page artwork, drawn under this text."]] },
      para(
        "A letterhead whose artwork is full-page stationery usually turns the header band off and sets a header height instead, so the body clears the printed masthead. The rule of thumb is to measure the artwork's own header in points and use that as the height."
      ),
      { kind: "gap", height: 260 },
      para("The second sheet starts around here, carrying whichever continuation header the design asks for."),
      { kind: "signature", closing: "Yours sincerely,", name: org.name || "Authorised Signatory", title: "Human Resources" },
    ],
  });
  return pdf;
}

/**
 * Copy a letterhead, artwork and all. This is how VARIANTS get made - the same stationery with a different
 * footer, an entity's second brand - without redrawing a page from the stock one or re-uploading its artwork.
 * `label`/`design` override what the source holds, so the designer can save its unsaved edits AS a copy and
 * leave the original untouched.
 */
export async function duplicateLetterhead(
  deps: Deps,
  actor: AppUser,
  id: string,
  overrides: { label?: string; design?: LetterheadDesign | null; print_design?: LetterheadDesign | null } = {}
) {
  const source = await loadRow(deps, id);
  const label = (overrides.label ?? `${source.label} copy`).trim();
  if (!label) throw invalidArgument("label cannot be empty");
  const copy = await crudService(letterheadSpec).create(deps, actor, {
    label,
    design: overrides.design !== undefined ? overrides.design : letterheadDesignOrStock(source.designJson),
    print_design:
      overrides.print_design !== undefined ? overrides.print_design : source.printDesignJson ? letterheadDesignOrStock(source.printDesignJson) : null,
  });
  // The images are separate objects, so each is copied as one - every slot, not just the one the current
  // design happens to draw, since the copy is a starting point for a different design. A source with no
  // images has none to copy; a copy that fails here is still a usable letterhead, hence no rollback.
  for (const [variant, slots] of Object.entries(assetsOf(source)) as [LetterheadVariant, Record<LetterheadSlot, LetterheadAsset>][]) {
    for (const [slot, asset] of Object.entries(slots) as [LetterheadSlot, LetterheadAsset][]) {
      const bytes = await deps.docs.get(asset.key);
      if (bytes) await uploadLetterheadImage(deps, actor, copy.uuid, bytes, asset.content_type, slot, variant);
    }
  }
  return (await deps.db.select().from(schema.letterheads).where(eq(schema.letterheads.uuid, copy.uuid)).limit(1))[0]!;
}

/**
 * Put the artwork back on a letter loaded from its frozen sidecar (which stores the design and the ref, but
 * not the image). Mutates in place; a letter with no letterhead, or one whose letterhead has since been
 * deleted, simply renders without artwork rather than failing.
 *
 * `media: "print"` also swaps in the letterhead's PRINT page when it has one - the same letter, same words,
 * same signature, on the page meant for a printer. That design is read LIVE, so editing a print page changes
 * what old letters print as; the stored PDF remains the record of what was issued.
 */
export async function rehydrateLetterhead(deps: Deps, content: { letterhead?: LetterheadSpec; letterheadRef?: string }, media: LetterheadMedia = "screen"): Promise<void> {
  const ref = content.letterheadRef;
  if (!ref) return;
  const printDesign = media === "print" ? await printDesignOf(deps, ref) : undefined;
  const design = printDesign ?? content.letterhead?.design ?? {};
  // The images come from the version being drawn - the print version's own, when it has one.
  content.letterhead = { design, artwork: await letterheadArtwork(deps, ref, design, media) };
}

/**
 * Payslips carry their own design (settings/payslip), so a letterhead lends them only its MARK - the header
 * logo. Its stationery would put an A4 background behind a payslip that already draws its own header, and its
 * watermark belongs to the letter engine's page furniture.
 */
export const letterheadMark = (lh?: LetterheadSpec): string | undefined =>
  lh && lh.design.header?.mark?.show !== false ? lh.artwork?.mark : undefined;

/** Hard delete takes every image with it; the generic purge knows nothing about the R2 objects. */
export async function purgeLetterhead(deps: Deps, actor: AppUser, id: string): Promise<void> {
  const row = (await deps.db.select().from(schema.letterheads).where(eq(schema.letterheads.uuid, id)).limit(1))[0];
  if (!row) throw notFound("letterhead not found");
  for (const slots of Object.values(assetsOf(row))) {
    for (const asset of Object.values(slots)) await deps.docs.delete(asset.key).catch(() => {});
  }
  await deps.db.delete(schema.letterheads).where(eq(schema.letterheads.uuid, id));
  // Hard delete, and the R2 objects go with it - this entry is all that is left.
  await audit(deps, actor, "letterhead.purge", "letterheads", id, removedMeta(row, "letterheads"), row);
}

export const letterheadSpec: CrudSpec<LetterheadInput, typeof schema.letterheads> = {
  table: schema.letterheads,
  collection: "letterheads",
  auditName: "letterhead",
  notFound: "letterhead not found",
  insert: (input) => {
    if (!input.label?.trim()) throw invalidArgument("label is required");
    return {
      label: input.label.trim(),
      ...(input.design !== undefined ? { designJson: encodeDesign(input.design) } : {}),
      ...(input.print_design !== undefined ? { printDesignJson: encodeDesign(input.print_design, true) } : {}),
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.letterheads> = {};
    if (has(patch, "label")) { if (!patch.label?.trim()) throw invalidArgument("label cannot be empty"); set.label = patch.label.trim(); }
    // A merge-patch `design: null` clears the design back to the stock page; a design object REPLACES the
    // stored one wholesale (a deep merge would make a band impossible to empty). `print_design: null` drops
    // the print page, which means printing goes back to using the screen one.
    if (has(patch, "design")) set.designJson = encodeDesign(patch.design);
    if (has(patch, "print_design")) set.printDesignJson = encodeDesign(patch.print_design, true);
    return set;
  },
};
