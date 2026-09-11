import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { AppEnv, AppUser } from "../env";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { listEmployees, getEmployee, createEmployee, updateEmployee, setBio } from "../services/employees";
import { enrollDefaultBenefits } from "../services/benefitEnrollments";
import { getBankDetails, setBankDetails } from "../services/bankDetails";
import { getIdentityDetails, setIdentityDetails } from "../services/identityDetails";
import { getPersonalDetails, setPersonalDetails } from "../services/personalDetails";
import { getTaxDetails, setTaxDetails } from "../services/taxDetails";
import { getNotificationPrefs, setNotificationPrefs } from "../services/notificationPrefs";
import { computeProfileCompleteness } from "../services/profileCompleteness";
import { uploadPhoto, clearPhoto, getPhoto, uploadSignature, clearSignature, getSignature } from "../services/employeePhoto";
import { putAttachment, downloadAttachment, deleteAttachment } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { identityDocSlot } from "../services/identityDetails";
import { toEmployeeResource } from "../http/serialize";
import { jsonBody } from "../http/jsonRequest";
import { redactIdentity, redactFlat, deniedFieldKeys } from "../http/fieldAccess";
import { invalidArgument, forbidden } from "../lib/errors";
import { actorCan } from "../domain/access";

const COL = "employees";

// Wire fields are snake_case. .strict() rejects output-only fields (path/uid/etag/...) if sent.
const writeSchema = z
  .object({
    first_name: z.string().min(1).optional(),
    last_name: z.string().min(1).optional(),
    legal_name: z.string().nullable().optional(),
    employee_number: z.string().nullable().optional(),
    work_email: z.string().email().optional(),
    job_title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    manager: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    probation_end_date: z.string().nullable().optional(),
    epf_enrolled: z.boolean().optional(),
    eps_excluded: z.boolean().optional(),
    national_id: z.string().nullable().optional(),
  })
  .strict();

const bankSchema = z
  .object({
    bank_name: z.string().nullable().optional(),
    account_name: z.string().nullable().optional(),
    account_number: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    ifsc_code: z.string().nullable().optional(),
    currency_code: z.string().nullable().optional(),
  })
  .strict();

// The signature image is owner-private (see employeePhoto.assertOwner). Strip even its existence marker from
// any employee serialized for someone other than the owner, so it never leaks through a list/get/edit.
const empResource = (viewerEmployeeId: string | null | undefined, row: any) => {
  const r = toEmployeeResource(row) as Record<string, unknown>;
  if (!viewerEmployeeId || viewerEmployeeId !== row?.uuid) delete r.signature;
  return r;
};

// The employee record. Its serializer is viewer-dependent (the signature marker is owner-only) and its item
// read carries the profile-completeness flags, so both go through the spec rather than a hand-written handler.
// Every write is the service's own: a create allocates the code under the department and provisions the user,
// an update can re-parent the employee (re-coding every row they own), and delete/purge cascade.
type EmployeeWrite = z.infer<typeof writeSchema>;

// The record-quality flags for ONE employee. Owner-private (like `signature`) with one exception: HR
// (employees.write) also gets them as a record-quality signal, minus `signature` - even its existence is
// private (see empResource). This rides the item read only: it decrypts three stored blobs per row and no list
// renders it, so it belongs to the `get` rather than to `decorate`, which the factory applies to a page too.
const withCompleteness = async (deps: Deps, actor: AppUser, row: any) => {
  if (actor.employeeId !== row.uuid && !actorCan(actor, "employees.write")) return row;
  const flags = await computeProfileCompleteness(deps, row);
  if (actor.employeeId !== row.uuid) delete flags.signature;
  return { ...row, _profileCompleteness: flags };
};

const records = collectionRoutes<EmployeeWrite, typeof schema.employees>({
  table: schema.employees,
  collection: COL,
  auditName: "employee",
  notFound: "employee not found",
  param: "employee_id",
  writeSchema,
  serialize: (row, user) => {
    const res = empResource(user?.employeeId, row);
    if (row._profileCompleteness) res.profile_completeness = row._profileCompleteness;
    return res;
  },
  overrides: {
    get: async (deps, actor, id) => withCompleteness(deps, actor, await getEmployee(deps, actor, id)),
    create: (deps, actor, input, id) => createEmployee(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateEmployee(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => listEmployees(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.req.query("q"), page.deletedOnly),
  verbs: {
    // Profile photo: media + clear (no standard equivalent for a binary upload/download).
    getPhoto: { raw: async (c, id) => c.body(await getPhoto(c.get("deps"), c.get("user"), id), 200, { "Content-Type": "application/octet-stream" }) },
    uploadPhoto: { run: async (deps, user, id, _b, c) => uploadPhoto(deps, user, id, await requireCappedBody(c.req.raw)) },
    clearPhoto: { run: (deps, user, id) => clearPhoto(deps, user, id) },
    // Signature image (the employee's e-signature): owner-private (the service enforces owner-only).
    getSignature: { raw: async (c, id) => c.body(await getSignature(c.get("deps"), c.get("user"), id), 200, { "Content-Type": "application/octet-stream" }) },
    uploadSignature: { run: async (deps, user, id, _b, c) => uploadSignature(deps, user, id, await requireCappedBody(c.req.raw), c.req.query("content_type") || undefined) },
    clearSignature: { run: (deps, user, id) => clearSignature(deps, user, id) },
    // Identity-field supporting documents (slot identity:<field>). The verb is gated by the middleware
    // (employees.me.* / employees.** allow); here we additionally enforce the per-field READ grant, so a
    // restricted field's document is never reachable even by a caller who can touch identity generally. All
    // three answer with bytes or a receipt rather than the employee, so they own their responses.
    uploadIdentityDoc: { raw: (c, id) => identityDoc(c, id, "upload") },
    downloadIdentityDoc: { raw: (c, id) => identityDoc(c, id, "download") },
    clearIdentityDoc: { raw: (c, id) => identityDoc(c, id, "clear") },
    // Auto-enrol the employee in default benefit plans (idempotent). Used by the new-hire automation, and
    // callable by HR directly. Answers with a count, not the employee.
    enrollDefaultBenefits: { raw: async (c, id) => c.json(await enrollDefaultBenefits(c.get("deps"), c.get("user"), id)) },
  },
});

// The three identity-document verbs differ only in what they do once the per-field grant is checked.
async function identityDoc(c: Context<AppEnv>, id: string, action: "upload" | "download" | "clear") {
  const deps = c.get("deps");
  const user = c.get("user");
  const field = c.req.query("field");
  if (!field) throw invalidArgument("field is required");
  const code = c.get("itemCode");
  if (code && deniedFieldKeys(c.get("objectGrant"), "employees", code, "identity", [field], { employeeCode: user.employeeCode }).has(field)) {
    throw forbidden("you do not have permission to perform this action");
  }
  const slot = identityDocSlot(field);
  if (action === "download") {
    const { bytes, row } = await downloadAttachment(deps, COL, id, slot);
    return c.body(bytes, 200, { "Content-Type": row.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
  }
  if (action === "upload") {
    const bytes = new Uint8Array(await requireCappedBody(c.req.raw));
    await putAttachment(deps, user, { collection: COL, objectId: id, slot, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
  } else {
    await deleteAttachment(deps, user, COL, id, slot);
  }
  return c.json({ ok: true });
}

// The singleton sub-resources hang off an employee (they are not collections): each is one row's worth of
// fields, gated by the same path grant and redacted per field. Registered before the collection lane so their
// two-segment paths win.
export const employees = new Hono<AppEnv>()
  // Singleton sub-resources (bank account, identity, personal info). Access (owner/HR/super_admin)
  // is enforced inside each service. JSON merge-patch on the PATCH.
  .get("/:employee_id/bank-account", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getBankDetails(c.get("deps"), c.get("user"), id);
    const code = c.get("itemCode");
    const out = code ? redactFlat(view, "bank-account", c.get("objectGrant"), code, { employeeCode: c.get("user").employeeCode }) : view;
    return c.json({ path: `employees/${id}/bank-account`, ...out });
  })
  .patch("/:employee_id/bank-account", zValidator("json", bankSchema), async (c) => {
    const id = c.req.param("employee_id")!;
    return c.json({ path: `employees/${id}/bank-account`, ...(await setBankDetails(c.get("deps"), c.get("user"), id, c.req.valid("json"))) });
  })
  .get("/:employee_id/identity", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getIdentityDetails(c.get("deps"), c.get("user"), id);
    const code = c.get("itemCode");
    const out = code ? redactIdentity(view, c.get("objectGrant"), code, { employeeCode: c.get("user").employeeCode }) : view;
    return c.json({ path: `employees/${id}/identity`, ...out });
  })
  .patch("/:employee_id/identity", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<{ values?: Record<string, string> }>(c);
    return c.json({ path: `employees/${id}/identity`, ...(await setIdentityDetails(c.get("deps"), c.get("user"), id, body.values ?? {})) });
  })
  .get("/:employee_id/personal-info", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getPersonalDetails(c.get("deps"), c.get("user"), id);
    const code = c.get("itemCode");
    const out = code ? redactFlat(view, "personal-info", c.get("objectGrant"), code, { employeeCode: c.get("user").employeeCode }) : view;
    return c.json({ path: `employees/${id}/personal-info`, ...out });
  })
  .get("/:employee_id/tax", async (c) => {
    const id = c.req.param("employee_id")!;
    return c.json({ path: `employees/${id}/tax`, ...(await getTaxDetails(c.get("deps"), c.get("user"), id)) });
  })
  .patch("/:employee_id/tax", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<{ values?: Record<string, unknown> }>(c);
    return c.json({ path: `employees/${id}/tax`, ...(await setTaxDetails(c.get("deps"), c.get("user"), id, body.values ?? {})) });
  })
  .patch("/:employee_id/personal-info", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<Parameters<typeof setPersonalDetails>[3]>(c);
    return c.json({ path: `employees/${id}/personal-info`, ...(await setPersonalDetails(c.get("deps"), c.get("user"), id, body ?? {})) });
  })
  .get("/:employee_id/notification-prefs", async (c) => {
    const id = c.req.param("employee_id")!;
    return c.json({ path: `employees/${id}/notification-prefs`, ...(await getNotificationPrefs(c.get("deps"), c.get("user"), id)) });
  })
  .patch(
    "/:employee_id/bio",
    zValidator("json", z.object({ bio: z.string().max(280).nullable().optional() }).strict()),
    async (c) => {
      const id = c.req.param("employee_id")!;
      return c.json({ path: `employees/${id}/bio`, ...(await setBio(c.get("deps"), c.get("user"), id, c.req.valid("json").bio)) });
    },
  )
  .patch("/:employee_id/notification-prefs", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<{ muted?: unknown; digest?: unknown }>(c);
    return c.json({ path: `employees/${id}/notification-prefs`, ...(await setNotificationPrefs(c.get("deps"), c.get("user"), id, body ?? {})) });
  })
  .route("/", records);
