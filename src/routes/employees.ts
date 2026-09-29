import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { AppEnv, AppUser } from "../env";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { listEmployees, getEmployee, createEmployee, updateEmployee, removeEmployee, disableEmployee, enableEmployee, setBio } from "../services/employees";
import { enrollDefaultBenefits } from "../services/benefitEnrollments";
import { getBankDetails, setBankDetails } from "../services/bankDetails";
import { getIdentityDetails, setIdentityDetails } from "../services/identityDetails";
import { getPersonalDetails, setPersonalDetails } from "../services/personalDetails";
import { getTaxDetails, setTaxDetails } from "../services/taxDetails";
import { getNotificationPrefs, setNotificationPrefs } from "../services/notificationPrefs";
import { getPresence } from "../services/presence";
import { computeProfileCompleteness } from "../services/profileCompleteness";
import { uploadPhoto, clearPhoto, photoRef, openPhoto, uploadSignature, clearSignature, getSignature } from "../services/employeePhoto";
import { putAttachment, downloadAttachment, deleteAttachment, attachmentDisposition } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { identityDocSlot } from "../services/identityDetails";
import { whoCanSeeMe } from "../services/myViewers";
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
    tracked_from: z.string().nullable().optional(),
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

/**
 * How long a browser may keep a face without asking again.
 *
 * `private` because the answer is one caller's - the whole app is `private, no-store` for that reason
 * (middleware/securityHeaders.ts), and this is the one response that opts out of the second half.
 *
 * A WEEK is not a freshness window: the URL carries the photo's version, so a replaced picture is a different
 * URL and nothing cached can ever be stale. It is the only thing it can be - the time somebody whose access to
 * a colleague was withdrawn goes on being able to re-open the copy their browser already holds. Signing out
 * clears it outright (`Clear-Site-Data: "cache"`, routes/authRoutes.ts).
 */
const PHOTO_CACHE_CONTROL = "private, max-age=604800";

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
  // The item response carries `access.subject`: what the caller may reach ABOUT THIS PERSON, per collection.
  // The profile is a page of per-person surfaces (their attendance, their goals, their pay), and each is a
  // DIFFERENT collection's grant decided against THIS person's code - a question neither `access.can` (verbs
  // on the employee row) nor the caller's scope-stripped capability set can answer.
  subjectScopes: true,
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
    // Deleting an employee ends their ACCESS too, the way offboarding does - the generic soft delete stamps
    // the row and leaves the linked login active. See services/employees.ts removeEmployee.
    remove: (deps, actor, id, ifMatch) => removeEmployee(deps, actor, id, ifMatch),
  },
  list: (c, page) => listEmployees(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.req.query("q"), page.deletedOnly),
  verbs: {
    // The lifecycle pair, answered here rather than by the generic column write: disabling an employee also
    // switches off their login, and enabling one reverses an exit (services/employees.ts).
    disable: { run: (deps, user, id) => disableEmployee(deps, user, id) },
    enable: { run: (deps, user, id) => enableEmployee(deps, user, id) },
    // Profile photo: media + clear (no standard equivalent for a binary upload/download).
    // The profile photo, answered as an IMAGE the browser can cache - every avatar in the app is an `<img>`
    // pointed at this (web/src/components/common/PhotoAvatar.tsx), which is why it takes GET as well as POST.
    //
    // `?v=` is the photo's own version, so a replaced picture is a different URL and a cached one can never be
    // stale: the freshness directives below only bound how long a viewer whose access was revoked keeps a face
    // they already had. Set here rather than left to the defaults - securityHeaders fills, never overwrites -
    // and only on the answer that carries bytes, so a refusal is never cached.
    //
    // `image/jpeg`, not octet-stream: the app sends `X-Content-Type-Options: nosniff`, so a body typed as
    // "bytes" is a body the browser will not paint.
    getPhoto: {
      get: true,
      raw: async (c, id) => {
        const deps = c.get("deps");
        // Visibility was decided by the middleware, on the record's own read (authz.ts READ_GATED_VERBS).
        const { key, version } = await photoRef(deps, id);
        const etag = `W/"${version}"`;
        const headers = { ETag: etag, "Cache-Control": PHOTO_CACHE_CONTROL };
        // Answered from the row the access check already read, before R2 is touched: a revalidation costs the
        // check (which is the point of revalidating) and nothing else.
        if (c.req.header("If-None-Match") === etag) return c.body(null, 304, headers);
        const { body, size } = await openPhoto(deps, key);
        return new Response(body, { headers: { ...headers, "Content-Type": "image/jpeg", "Content-Length": String(size) } });
      },
    },
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
    // "Who can see my data?" - the effective-access report aimed at the person asking rather than at an
    // admin, over every area of theirs (the record and its sensitive sub-resources, pay, leave, reviews,
    // documents). The middleware gates it as `employees.me.viewers`, which every role holds for THEMSELVES
    // only (grants.ts OWN_PII_ALLOW); the service additionally nails every target to the caller's own employee
    // id, so the path id is never what decides whose data is reported. Answers with the report, not an employee.
    viewers: { raw: async (c) => c.json(await whoCanSeeMe(c.get("deps"), c.get("user"))) },
  },
});

/**
 * The object code every per-field decision is made against (`employees.<code>.<sub>.<key>`), or a refusal.
 *
 * FAIL CLOSED, which is what this was not. The five redaction sites below each read `c.get("itemCode")` and
 * then wrote `code ? redact(view) : view` - so a row whose `code` is null was served RAW, and every per-field
 * deny on it silently evaporated. That is the one spelling of this decision in the app that failed open:
 * http/tableFieldAccess.ts denies every key on a null code, services/listScope.ts answers `1 = 0`, and
 * http/accessHint.ts hints nothing. `employees.code` is a nullable TEXT column with no CHECK, so "it is always
 * set" is a property of every writer forever rather than of the schema - the same assumption
 * domain/permissions.ts#matchToken was hardened against.
 *
 * A refusal rather than a blank view: a decision that cannot be made is not a decision that came back empty,
 * and the caller needs to know which.
 */
function fieldScopeCode(c: Context<AppEnv>): string {
  const code = c.get("itemCode");
  if (!code) throw forbidden("you do not have permission to perform this action");
  return code;
}

// The three identity-document verbs differ only in what they do once the per-field grant is checked.
async function identityDoc(c: Context<AppEnv>, id: string, action: "upload" | "download" | "clear") {
  const deps = c.get("deps");
  const user = c.get("user");
  const field = c.req.query("field");
  if (!field) throw invalidArgument("field is required");
  const code = fieldScopeCode(c);
  // ASKED AT THE LEVEL THE ACTION ACTUALLY IS. All three verbs used to share one `read` check, so a caller who
  // may read a field but is denied write on it could still replace or delete the supporting document behind it
  // - the converse of the rule stated over `redactedSub` below ("a caller's write grant and their read grant
  // are decided separately"), failing in the destructive direction. Not reachable with the seeded grants, where
  // every employee holds `employees.me.identity.**: write` so read and write coincide on their own record;
  // reachable the moment an admin writes a read-only per-field rule, which the ACL offers.
  const level = action === "download" ? "read" : "write";
  // `c.get("self")` - the context the gate itself decided with. Rebuilt from the employee code it cannot match
  // `my-reports` / `my-org`, so a caller reaching this record through the reporting line was refused the
  // document behind a field they may read (lib/selfContext.ts#selfContextOf).
  if (deniedFieldKeys(c.get("objectGrant"), "employees", code, "identity", [field], c.get("self"), level).has(field)) {
    throw forbidden("you do not have permission to perform this action");
  }
  const slot = identityDocSlot(field);
  if (action === "download") {
    const { bytes, row } = await downloadAttachment(deps, COL, id, slot);
    return c.body(bytes, 200, { "Content-Type": row.contentType ?? "application/octet-stream", "Content-Disposition": attachmentDisposition(row, `${field}-document`) });
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
// EVERY ANSWER THAT CARRIES ONE OF THESE VIEWS IS REDACTED, AND THAT INCLUDES THE WRITE'S OWN ANSWER.
//
// Only `tax` used to do this, and the reason written over it holds for all four: a caller's write grant and
// their read grant are decided separately, so somebody who may WRITE a field (the middleware gates the body
// per key, domain/manifests.ts SUBRESOURCE_BODY) need not be able to READ it back. All three of these services
// answer with the WHOLE record rather than with what was sent - `setIdentityDetails` and `setPersonalDetails`
// merge the patch over the stored blob and return the merged result - so a PATCH naming one writable key was
// handed every other field on the record, per-field denies and all. A deny that a GET honours and a PATCH
// hands over is not a deny; it is a longer way of asking.
//
// The matcher context is `c.get("self")` - the one the gate decided the request with, manager chain included -
// rather than one rebuilt from the employee code alone. Rebuilt, a field held through `my-reports`/`my-org`
// matched nothing here and was redacted from a response the gate had just allowed.
const selfOf = (c: Context<AppEnv>) => c.get("self") ?? { employeeCode: c.get("user").employeeCode };
const redactedSub = <T extends Record<string, unknown>>(c: Context<AppEnv>, sub: "bank-account" | "personal-info" | "tax", view: T): T =>
  redactFlat(view, sub, c.get("objectGrant"), fieldScopeCode(c), selfOf(c));

export const employees = new Hono<AppEnv>()
  // Singleton sub-resources (bank account, identity, personal info). Access (owner/HR/super_admin)
  // is enforced inside each service. JSON merge-patch on the PATCH.
  .get("/:employee_id/bank-account", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getBankDetails(c.get("deps"), c.get("user"), id);
    return c.json({ path: `employees/${id}/bank-account`, ...redactedSub(c, "bank-account", view) });
  })
  .patch("/:employee_id/bank-account", zValidator("json", bankSchema), async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await setBankDetails(c.get("deps"), c.get("user"), id, c.req.valid("json"), c.req.header("If-Match"));
    return c.json({ path: `employees/${id}/bank-account`, ...redactedSub(c, "bank-account", view) });
  })
  .get("/:employee_id/identity", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getIdentityDetails(c.get("deps"), c.get("user"), id);
    return c.json({ path: `employees/${id}/identity`, ...redactIdentity(view, c.get("objectGrant"), fieldScopeCode(c), selfOf(c)) });
  })
  .patch("/:employee_id/identity", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<{ values?: Record<string, string> }>(c);
    const view = await setIdentityDetails(c.get("deps"), c.get("user"), id, body.values ?? {}, c.req.header("If-Match"));
    return c.json({ path: `employees/${id}/identity`, ...redactIdentity(view, c.get("objectGrant"), fieldScopeCode(c), selfOf(c)) });
  })
  .get("/:employee_id/personal-info", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getPersonalDetails(c.get("deps"), c.get("user"), id);
    return c.json({ path: `employees/${id}/personal-info`, ...redactedSub(c, "personal-info", view) });
  })
  // The tax view is field-gated on WRITE (domain/manifests.ts lists `tax` in SUBRESOURCE_BODY, so the authz
  // middleware checks every key in the body) and was once not gated on READ at all - the one sub-resource
  // served straight out of its service. A per-field deny on a declared figure was therefore accepted, stored
  // and inert, which is a field ACL failing open.
  .get("/:employee_id/tax", async (c) => {
    const id = c.req.param("employee_id")!;
    const view = await getTaxDetails(c.get("deps"), c.get("user"), id);
    return c.json({ path: `employees/${id}/tax`, ...redactedSub(c, "tax", view) });
  })
  .patch("/:employee_id/tax", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<{ values?: Record<string, unknown> }>(c);
    const view = await setTaxDetails(c.get("deps"), c.get("user"), id, body.values ?? {}, c.req.header("If-Match"));
    return c.json({ path: `employees/${id}/tax`, ...redactedSub(c, "tax", view) });
  })
  .patch("/:employee_id/personal-info", async (c) => {
    const id = c.req.param("employee_id")!;
    const body = await jsonBody<Parameters<typeof setPersonalDetails>[3]>(c);
    const view = await setPersonalDetails(c.get("deps"), c.get("user"), id, body ?? {}, c.req.header("If-Match"));
    return c.json({ path: `employees/${id}/personal-info`, ...redactedSub(c, "personal-info", view) });
  })
  // Derived, so there is nothing to PATCH: see services/presence.ts for why it is read lazily and why the
  // leave type never leaves the server.
  .get("/:employee_id/presence", async (c) => {
    const id = c.req.param("employee_id")!;
    return c.json({ path: `employees/${id}/presence`, ...(await getPresence(c.get("deps"), id)) });
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
