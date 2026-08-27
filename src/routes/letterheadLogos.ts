import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { letterheadLogoSpec, uploadLetterheadImage, getLetterheadImage, purgeLetterheadLogo } from "../services/letterheadLogos";
import { toLetterheadLogoResource } from "../http/serialize";

// The letterhead catalogue (Settings -> Company -> Logos): create a logo, then upload its artwork. The artwork
// rides as raw bytes on `:uploadImage` and comes back from `:image`, so neither one answers with the resource.
// Private-by-default like every collection - grant read to whoever generates letters, write to whoever curates
// the branding.
const writeSchema = z.object({ label: z.string().min(1).max(120).optional() }).strict();

export const letterheadLogos = collectionRoutes<{ label?: string }, typeof letterheadLogoSpec.table>({
  ...letterheadLogoSpec,
  param: "letterhead_logo_id",
  writeSchema,
  serialize: toLetterheadLogoResource,
  // A hard delete must take the R2 object with it; the generic purge only knows the row.
  overrides: { purge: (deps, user, id) => purgeLetterheadLogo(deps, user, id) },
  verbs: {
    uploadImage: { run: async (deps, user, id, _b, c) => uploadLetterheadImage(deps, user, id, await c.req.arrayBuffer(), c.req.query("content_type") || undefined) },
    image: {
      raw: async (c, id) => {
        const { bytes, contentType } = await getLetterheadImage(c.get("deps"), id);
        return c.body(bytes, 200, { "Content-Type": contentType });
      },
    },
  },
});
