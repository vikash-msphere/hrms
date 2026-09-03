import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import {
  letterheadSpec, uploadLetterheadImage, getLetterheadImage, deleteLetterheadImage, purgeLetterhead,
  renderLetterheadSample, duplicateLetterhead, type LetterheadInput,
} from "../services/letterheads";
import { LETTERHEAD_SLOTS, LETTERHEAD_VARIANTS, type LetterheadDesign, type LetterheadSlot, type LetterheadVariant } from "../domain/letterhead";
import { invalidArgument } from "../lib/errors";

/** `?slot=` -> a known slot. An unknown one is refused rather than silently writing over the mark. */
function slotOf(raw?: string): LetterheadSlot {
  if (!raw) return "mark";
  if (!(LETTERHEAD_SLOTS as readonly string[]).includes(raw)) throw invalidArgument(`slot must be one of ${LETTERHEAD_SLOTS.join(", ")}`);
  return raw as LetterheadSlot;
}

/** `?variant=` -> which VERSION of the letterhead the image belongs to. The two never share. */
function variantOf(raw?: string): LetterheadVariant {
  if (!raw) return "screen";
  if (!(LETTERHEAD_VARIANTS as readonly string[]).includes(raw)) throw invalidArgument(`variant must be one of ${LETTERHEAD_VARIANTS.join(", ")}`);
  return raw as LetterheadVariant;
}
import { jsonBody } from "../http/jsonRequest";
import { toLetterheadResource } from "../http/serialize";

// The letterhead catalogue (Settings -> Company -> Logos): create a letterhead, upload its artwork, design its
// page. The artwork rides as raw bytes on `:uploadImage` and comes back from `:image`, so neither one answers
// with the resource. Private-by-default like every collection - grant read to whoever generates letters, write
// to whoever curates the branding.
// `design` arrives as free-form JSON and is validated by domain/letterhead.ts (which names the offending
// property), so the schema only bounds its size here; `null` clears it back to the stock page.
const writeSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    design: z.record(z.string(), z.unknown()).nullable().optional(),
    print_design: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const letterheads = collectionRoutes<LetterheadInput, typeof letterheadSpec.table>({
  ...letterheadSpec,
  param: "letterhead_id",
  writeSchema,
  serialize: toLetterheadResource,
  // A hard delete must take the R2 object with it; the generic purge only knows the row.
  overrides: { purge: (deps, user, id) => purgeLetterhead(deps, user, id) },
  verbs: {
    // `?variant=` picks the VERSION (screen or print) and `?slot=` the job within it (mark, stationery,
    // watermark). The two versions hold entirely separate images, so uploading to one never touches the other.
    uploadImage: {
      run: async (deps, user, id, _b, c) =>
        uploadLetterheadImage(
          deps, user, id, await c.req.arrayBuffer(), c.req.query("content_type") || undefined,
          slotOf(c.req.query("slot")), variantOf(c.req.query("variant"))
        ),
    },
    image: {
      raw: async (c, id) => {
        const { bytes, contentType } = await getLetterheadImage(c.get("deps"), id, slotOf(c.req.query("slot")), variantOf(c.req.query("variant")));
        return c.body(bytes, 200, { "Content-Type": contentType });
      },
    },
    // Remove one image from one version. Nothing else moves - not the other slots, not the other version.
    deleteImage: {
      run: (deps, user, id, _b, c) => deleteLetterheadImage(deps, user, id, slotOf(c.req.query("slot")), variantOf(c.req.query("variant"))),
    },
    // Save-as-a-copy: a new letterhead carrying this one's artwork, with the body's label/design if it sends
    // any (the designer sends what is on screen, so a variant can be split off without saving over the
    // original). Answers with the copy, like a create.
    duplicate: {
      run: (deps, user, id, body) => duplicateLetterhead(deps, user, id, (body ?? {}) as { label?: string; design?: LetterheadDesign | null }),
    },
    // The design editor's live preview: a representative document rendered on this letterhead, so a draft can
    // be judged as a printed page before it is saved. Persists nothing.
    preview: {
      raw: async (c, id) => {
        const body = await jsonBody<{ design?: unknown; variant?: string }>(c);
        const media = body.variant === "print" ? "print" : "screen";
        const pdf = await renderLetterheadSample(c.get("deps"), id, body.design, media);
        const bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
        return c.body(bytes, 200, { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="letterhead-preview.pdf"' });
      },
    },
  },
});
