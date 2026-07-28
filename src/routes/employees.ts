import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee, restoreEmployee, purgeEmployee } from "../services/employees";
import { enrollDefaultBenefits } from "../services/benefitEnrollments";
import { getBankDetails, setBankDetails } from "../services/bankDetails";
import { getIdentityDetails, setIdentityDetails } from "../services/identityDetails";
import { getPersonalDetails, setPersonalDetails } from "../services/personalDetails";
import { getTaxDetails, setTaxDetails } from "../services/taxDetails";
import { getNotificationPrefs, setNotificationPrefs } from "../services/notificationPrefs";
import { uploadPhoto, clearPhoto, getPhoto, uploadSignature, clearSignature, getSignature } from "../services/employeePhoto";
import { putAttachment, downloadAttachment, deleteAttachment } from "../services/attachments";
import { identityDocSlot } from "../services/identityDetails";
import { toEmployeeResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { redactIdentity, redactFlat, deniedFieldKeys } from "../http/fieldAccess";
import { invalidArgument, forbidden } from "../lib/errors";
import { clampPageSize } from "../http/pagination";

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
    national_id: z.string().nullable().optional(),
  })
  .strict();

const bankSchema = z
  .object({
    bank_name: z.string().nullable().optional(),
    account_name: z.string().nullable().optional(),
    account_number: z.string().nullable().optional(),
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

export const employees = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listEmployees(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true", c.req.query("q"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(empResource(user.employeeId, r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:employee_id", async (c) => {
    const row = await getEmployee(c.get("deps"), c.get("user"), c.req.param("employee_id"));
    return c.json(withAccess(empResource(c.get("user").employeeId, row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createEmployee(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(empResource(c.get("user").employeeId, row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // JSON Merge Patch; optional If-Match.
  .patch("/:employee_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateEmployee(c.get("deps"), c.get("user"), c.req.param("employee_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(empResource(c.get("user").employeeId, row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:employee_id", async (c) => {
    const id = c.req.param("employee_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeEmployee(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteEmployee(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
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
    const body = (await c.req.json().catch(() => ({}))) as { values?: Record<string, string> };
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
    const body = (await c.req.json().catch(() => ({}))) as { values?: Record<string, unknown> };
    return c.json({ path: `employees/${id}/tax`, ...(await setTaxDetails(c.get("deps"), c.get("user"), id, body.values ?? {})) });
  })
  .patch("/:employee_id/personal-info", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = (await c.req.json().catch(() => ({}))) as Parameters<typeof setPersonalDetails>[3];
    return c.json({ path: `employees/${id}/personal-info`, ...(await setPersonalDetails(c.get("deps"), c.get("user"), id, body ?? {})) });
  })
  .get("/:employee_id/notification-prefs", async (c) => {
    const id = c.req.param("employee_id")!;
    return c.json({ path: `employees/${id}/notification-prefs`, ...(await getNotificationPrefs(c.get("deps"), c.get("user"), id)) });
  })
  .patch("/:employee_id/notification-prefs", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = (await c.req.json().catch(() => ({}))) as { muted?: unknown; digest?: unknown };
    return c.json({ path: `employees/${id}/notification-prefs`, ...(await setNotificationPrefs(c.get("deps"), c.get("user"), id, body ?? {})) });
  })
  .post("/:employee_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    // Profile photo: media + clear (no standard equivalent for binary upload/download).
    if (verb === "getPhoto") return c.body(await getPhoto(deps, user, id), 200, { "Content-Type": "application/octet-stream" });
    if (verb === "uploadPhoto") return c.json(empResource(user.employeeId, await uploadPhoto(deps, user, id, await c.req.arrayBuffer())));
    if (verb === "clearPhoto") return c.json(empResource(user.employeeId, await clearPhoto(deps, user, id)));
    // Signature image (the employee's e-signature): owner-private (the service enforces owner-only).
    if (verb === "getSignature") return c.body(await getSignature(deps, user, id), 200, { "Content-Type": "application/octet-stream" });
    if (verb === "uploadSignature") return c.json(empResource(user.employeeId, await uploadSignature(deps, user, id, await c.req.arrayBuffer(), c.req.query("content_type") || undefined)));
    if (verb === "clearSignature") return c.json(empResource(user.employeeId, await clearSignature(deps, user, id)));
    // Identity-field supporting documents (slot identity:<field>). The verb is gated by the middleware
    // (employees.me.* / employees.** allow); here we additionally enforce the per-field READ grant, so a
    // restricted field's document is never reachable even by a caller who can touch identity generally.
    if (verb === "uploadIdentityDoc" || verb === "downloadIdentityDoc" || verb === "clearIdentityDoc") {
      const field = c.req.query("field");
      if (!field) throw invalidArgument("field is required");
      const code = c.get("itemCode");
      if (code && deniedFieldKeys(c.get("objectGrant"), "employees", code, "identity", [field], { employeeCode: user.employeeCode }).has(field)) {
        throw forbidden("you do not have permission to perform this action");
      }
      const slot = identityDocSlot(field);
      if (verb === "downloadIdentityDoc") {
        const { bytes, row } = await downloadAttachment(deps, COL, id, slot);
        return c.body(bytes, 200, { "Content-Type": row.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
      }
      if (verb === "uploadIdentityDoc") {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await putAttachment(deps, user, { collection: COL, objectId: id, slot, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
      } else {
        await deleteAttachment(deps, user, COL, id, slot);
      }
      return c.json({ ok: true });
    }
    // Auto-enrol the employee in default benefit plans (idempotent). Used by the new-hire automation, and
    // callable by HR directly. Gated by the employees write grant (middleware).
    if (verb === "enrollDefaultBenefits") return c.json(await enrollDefaultBenefits(deps, user, id));
    // All other employee custom methods (lifecycle, restore) require employee.write.
    const lc = await lifecycleVerb(c, { table: schema.employees, singular: "employee", collection: "employees", serialize: (row) => empResource(user.employeeId, row) });
    if (lc) return lc;
    if (verb !== "restore") return c.notFound();
    const row = await restoreEmployee(deps, user, id);
    return c.json(empResource(user.employeeId, row));
  });
