import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { listLetterTemplates, getLetterTemplate, createLetterTemplate, updateLetterTemplate, deleteLetterTemplate, restoreLetterTemplate, purgeLetterTemplate } from "../services/letterTemplates";
import { toLetterTemplateResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "letter-templates";

// blocks/inputs are validated loosely (the resolver only honors a closed vocabulary at render time, exactly
// like the previous settings-backed editor; the schema just guards the wire shape).
const writeSchema = z.object({
  label: z.string().min(1).optional(),
  category: z.string().nullable().optional(),
  filename: z.string().nullable().optional(),
  inputs: z.array(z.any()).nullable().optional(),
  blocks: z.array(z.any()).optional(),
}).strict();

export const letterTemplates = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listLetterTemplates(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toLetterTemplateResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:letter_template_id", async (c) => {
    const row = await getLetterTemplate(c.get("deps"), c.get("user"), c.req.param("letter_template_id")!);
    return c.json(withAccess(toLetterTemplateResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createLetterTemplate(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toLetterTemplateResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:letter_template_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateLetterTemplate(c.get("deps"), c.get("user"), c.req.param("letter_template_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toLetterTemplateResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:letter_template_id", async (c) => {
    const id = c.req.param("letter_template_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeLetterTemplate(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteLetterTemplate(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:letter_template_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreLetterTemplate(c.get("deps"), c.get("user"), id);
    return c.json(toLetterTemplateResource(row));
  });
