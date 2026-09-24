import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { audit, fieldDiff } from "../lib/audit";
import { isEmployeeWorkEmailCollision } from "../lib/errors";
import { systemActor } from "../lib/systemActor";
import { uploadPhoto } from "./employeePhoto";
import { createEmployee } from "./employees";
import { orgToday } from "./orgDay";
import { getDefaultDepartmentId, getSettingValue } from "./settings";

// What the app takes off a Google sign-in and writes onto the employee record. Called from /auth/callback
// (routes/authRoutes.ts) inside `waitUntil`, so nothing here is on the response path and nothing here may
// throw: a failed sync is a stale profile, never a failed sign-in.
//
// ONLY WHAT THE ID TOKEN ALREADY CARRIES - `picture` and `given_name`/`family_name`, both from the `profile`
// scope. A phone number, a job title or the Workspace org unit are not in the token: the first two need a
// People API call with extra sensitive scopes, and the org unit is an Admin SDK attribute behind an
// admin-restricted scope no ordinary employee can consent to (it needs a service account with domain-wide
// delegation, which is a directory sync rather than a sign-in hook). `locale` and `hd` do arrive and are
// dropped - no field on an employee means either of them.
//
// THE THREE PARTS MAKE DIFFERENT PROMISES, and the difference is the whole design:
//
//   creating the employee record (`google_employee`) makes a PERSON, so it is off by default and happens at
//   most once - an employee already holding the work address is the memory, soft-deleted ones included.
//
//   the photo is a ONE-TIME FILL. It lands only where there has never been one - `photo_at` is both the lock
//   and the memory - so it is safe on by default.
//   the name has no empty slot to fill: `first_name`/`last_name` are NOT NULL and HR types them at hire, so a
//   sync can only ever OVERWRITE. Hence a mode rather than a switch (`never` / `once` / `always`), and hence
//   `once` as the default: at a first sign-in Google's spelling is the best thing anybody has, and after that
//   the record here is a person's considered answer rather than a blank.
//
// WHY THE CALLBACK AND NOT THE AUTH MIDDLEWARE. The claims exist only on the verified ID token, which only the
// callback holds; and the middleware's "first login mints the user" branch is the wrong hook anyway, because
// `provisionAccount` (services/employees.ts) already creates the `users` row the moment somebody is hired, so
// for anyone hired since, that branch never runs.

/** The claims this sync can use, off the VERIFIED ID token. */
export type GoogleProfileClaims = { picture?: string | null; givenName?: string | null; familyName?: string | null };

/** How far the name sync goes. */
export const NAME_MODES = ["never", "once", "always"] as const;
export type NameMode = (typeof NAME_MODES)[number];

type SignInConfig = { google_photo?: boolean; google_name?: NameMode | boolean; google_employee?: boolean };

/**
 * The stored value as a mode.
 *
 * `true`/`false` are accepted because this shipped as a boolean before it grew a middle setting, and a stored
 * `true` meant what `always` means now. NOTHING STORED is the shipped default (`once`); a value stored but not
 * recognised is `never` - a typo must sync less than intended, never more.
 */
function nameMode(raw: SignInConfig["google_name"]): NameMode {
  if (raw === undefined || raw === null) return "once";
  if (raw === true) return "always";
  if (raw === false) return "never";
  return (NAME_MODES as readonly string[]).includes(raw) ? raw : "never";
}

/** What a stored avatar may weigh. The manual upload cap is 3 MB (employeePhoto.ts); an `s400` Google avatar is
 *  ~30 KB, so anything near this is not the thing we asked for. */
const MAX_BYTES = 1024 * 1024;

/** The longest a synced name part may be. Not a validation rule the app has anywhere else - the columns are
 *  plain text - but a claim is somebody else's data, and a name is rendered in every list in the app. */
const MAX_NAME = 100;

/**
 * Take what this sign-in offers. Each half is independent: the photo failing must not cost the name, and the
 * settings row is read once for both.
 */
export async function syncGoogleProfile(deps: Deps, email: string, claims: GoogleProfileClaims): Promise<void> {
  let cfg: SignInConfig;
  try {
    // The key is spelled out here rather than held in a constant because test/settingValidatorDrift.test.ts
    // reads this call shape to check that every key the server consults is classified in routes/settings.ts.
    cfg = await getSettingValue<SignInConfig>(deps, "sign-in", { google_photo: true, google_name: "once", google_employee: false });
  } catch (e) {
    console.error("[auth] google profile sync: could not read settings/sign-in (non-fatal)", e);
    return;
  }
  // The record first, so the two syncs below have something to write on: a person created here is exactly the
  // person whose name is fresh from Google and who has never had a photo.
  if (cfg.google_employee === true) await createFromSignIn(deps, email, claims);
  // Names next: the cheap half, and the photo's fetch should not delay it.
  const mode = nameMode(cfg.google_name);
  if (mode !== "never") await syncName(deps, email, claims, mode);
  if (cfg.google_photo !== false && claims.picture) await importPhoto(deps, email, claims.picture);
}

/**
 * Make an employee record for somebody signing in who has none, when the org has asked for that.
 *
 * WHY IT IS WORTH HAVING. Signing in creates a `users` row, never an employee, and almost everything in this
 * app hangs off the employee: `me`-scoped grants match by employee CODE (domain/permissions.ts), so a person
 * with an account and no record signs in to an app with nothing in it and no error to explain why. For an org
 * that adds people to Google first, this closes that gap without an HR step.
 *
 * WHY IT IS OFF BY DEFAULT. This is the one switch here that creates a person rather than filling a field on
 * one. The record is a real employee everywhere: headcount, the directory, org chart, leave and payroll
 * surfaces - and `createEmployee` emits `employee.created`, so whatever onboarding automation the org has
 * written runs for them, exactly as it would for a hire HR typed in. That is the right behaviour and it is not
 * a quiet one, so an org opts into it.
 *
 * ONCE IS STRUCTURAL, not a stamp: an employee holding this work address is the memory. The check spans
 * SOFT-DELETED rows too, both because `work_email` is UNIQUE on the raw column (the insert would fail anyway)
 * and because a leaver signing in must not come back as a new record with a new start date and a fresh
 * onboarding checklist - that is a rehire, and a person decides it.
 *
 * What it can fill is only what the token carries: the name, the address, and today as the start date. No job
 * title, no manager; the department is the org default when one is set (services/settings.ts), which is the
 * same fallback board cards and tickets use.
 */
async function createFromSignIn(deps: Deps, email: string, claims: GoogleProfileClaims): Promise<void> {
  try {
    const first = namePart(claims.givenName);
    const last = namePart(claims.familyName);
    // No usable name means the only record this could make is one called after an email address. A person with
    // no employee record is a visible, fixable state; a directory full of half-named people is not.
    if (!first || !last) return;

    // Deliberately UNFILTERED by `delete_time` - see the note above.
    const held = (
      await deps.db
        .select({ uuid: schema.employees.uuid })
        .from(schema.employees)
        .where(sql`lower(${schema.employees.workEmail}) = ${email}`)
        .limit(1)
    )[0];
    if (held) return;

    const department = await getDefaultDepartmentId(deps);
    await createEmployee(deps, systemActor(), {
      first_name: first,
      last_name: last,
      // The address the session is for, lowercased - `provisionAccount` inside `createEmployee` links the
      // sign-in account by it, and every lane that resolves a caller lowercases first.
      work_email: email,
      // The org's own day, never the Worker's UTC one: a start date is a calendar fact, and an evening sign-in
      // in Asia/Kolkata would otherwise be dated yesterday.
      start_date: await orgToday(deps),
      department: department ? `departments/${department}` : null,
    });
  } catch (e) {
    // The two sign-ins of one brand-new person (two devices, or a tab reopened) both read no employee and both
    // insert; `employees.work_email` is UNIQUE, so the loser lands here. The row it wanted now exists, which is
    // the whole point - not an error worth logging as one. Same for a create that raced HR adding the hire.
    if (isEmployeeWorkEmailCollision(e)) return;
    console.error("[auth] google employee create failed (non-fatal)", e);
  }
}

/** A name part as it will be stored, or null when the claim is unusable. */
function namePart(raw: string | null | undefined): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v && v.length <= MAX_NAME ? v : null;
}

/**
 * Hold the employee's first/last name to what Google says, as far as the org has asked.
 *
 * Unlike the photo this is not a fill - `first_name`/`last_name` are NOT NULL and HR types them at hire, so
 * there is no empty slot and the only thing this can do is OVERWRITE. Which is why `once` exists and is the
 * default: it takes Google's spelling while the record is brand new and nobody has had a reason to correct it,
 * and then never argues again - a preferred name, a corrected transliteration or a change HR made here and
 * nobody made in Google all survive. `always` is the mirror for orgs where Google is the register of names.
 *
 * "ONCE" IS "BEFORE THIS ACCOUNT HAS EVER USED THE APP", which is what `users.last_seen_at IS NULL` says: the
 * auth middleware stamps it on the first /v1 request, which lands milliseconds after this runs on a first
 * sign-in and is long past on every later one. It is the marker the photo gets for free from `photo_at`, and
 * borrowing it costs one indexed read rather than a column of its own. Two consequences, both wanted: an
 * account that existed before anybody signed in still counts as new, and somebody who has used the app is never
 * renamed by a sign-in.
 *
 * BOTH PARTS OR NEITHER. A Google account with no family name would otherwise blank a surname the employee
 * record had, and a half-synced name is worse than an unsynced one.
 */
async function syncName(deps: Deps, email: string, claims: GoogleProfileClaims, mode: NameMode): Promise<void> {
  try {
    const first = namePart(claims.givenName);
    const last = namePart(claims.familyName);
    if (!first || !last) return;

    if (mode === "once") {
      const account = (
        await deps.db
          .select({ lastSeenAt: schema.users.lastSeenAt })
          .from(schema.users)
          .where(sql`lower(${schema.users.email}) = ${email}`)
          .limit(1)
      )[0];
      // No account row yet is the newest a person gets (the middleware mints one on their first request), so
      // it counts as a first sign-in rather than as a reason to skip.
      if (account?.lastSeenAt != null) return;
    }

    const emp = (
      await deps.db
        .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName })
        .from(schema.employees)
        .where(and(sql`lower(${schema.employees.workEmail}) = ${email}`, isNull(schema.employees.deleteTime)))
        .limit(1)
    )[0];
    if (!emp) return;
    // The common case by far: nothing to do, and saying so costs no write, no audit entry and no ETag move.
    // Without this, every sign-in would rewrite the row and 409 anybody with the profile open.
    if (emp.firstName === first && emp.lastName === last) return;

    // COMPARE-AND-SWAP on what was read. HR editing the name in the moment between the read and the write is
    // the one case where "Google wins" is the wrong answer - that edit is somebody's deliberate act, seconds
    // old, and this would silently undo it. Losing the race means skipping: the next sign-in re-reads.
    const [updated] = await deps.db
      .update(schema.employees)
      .set({ firstName: first, lastName: last, updatedAt: new Date() })
      .where(and(eq(schema.employees.uuid, emp.uuid), eq(schema.employees.firstName, emp.firstName), eq(schema.employees.lastName, emp.lastName)))
      .returning();
    if (!updated) return;
    // The trail has to be able to answer "who renamed this person, and from what" - a name changing with no
    // entry against it is the kind of edit people spend an afternoon tracing. `systemActor` is the honest
    // actor: Google said so, nobody pressed anything.
    await audit(
      deps,
      systemActor(),
      "employee.name.update",
      "employees",
      emp.uuid,
      { diff: fieldDiff({ first_name: emp.firstName, last_name: emp.lastName }, { first_name: first, last_name: last }, ["first_name", "last_name"], "employees") },
      updated,
    );
  } catch (e) {
    console.error("[auth] google name sync failed (non-fatal)", e);
  }
}

/** Google renders the avatar at whatever the size directive on the URL asks for, and the one in the ID token is
 *  `=s96-c` - smaller than the app's own avatars are displayed at on a profile page. A URL without a directive
 *  is left alone rather than guessed at. */
function atUsableSize(url: string): string {
  return /=s\d+(-[a-z]+)*$/.test(url) ? url.replace(/=s\d+(-[a-z]+)*$/, "=s400-c") : url;
}

/**
 * Is this a Google-hosted avatar URL we will make an outbound request to?
 *
 * The URL arrived inside an ID token this Worker verified against Google's JWKS, so this is a floor rather than
 * the control - but a fetch whose target came out of a token must not be able to name an arbitrary host, and
 * the cost of saying so is two lines.
 *
 * Google's GENERATED avatar (the coloured initial, for an account with no photo of its own) is refused with it:
 * the app already draws initials when there is no photo, so importing a picture of initials would do nothing
 * but make that fallback permanent and unremovable.
 */
function usableGoogleAvatar(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "googleusercontent.com" && !url.hostname.endsWith(".googleusercontent.com")) return null;
  if (/(^|\/)default-user(=|$)/.test(url.pathname)) return null;
  return url;
}

async function importPhoto(deps: Deps, email: string, pictureUrl: string): Promise<void> {
  try {
    const url = usableGoogleAvatar(pictureUrl);
    if (!url) return;

    // CLAIM THE SLOT BEFORE FETCHING, in one statement, and let the predicate be the whole decision:
    //
    //   - `photo_key IS NULL AND photo_at IS NULL` is "never had a photo and never cleared one". `clearPhoto`
    //     stamps `photo_at` while nulling the key, so somebody who deliberately removed their photo is not
    //     handed Google's back at their next sign-in.
    //   - it is also the lock. Two sign-ins racing (or one person on two devices) both read no photo; only one
    //     of them changes a row here, and the loser returns rather than fetching and writing a second time.
    //   - and it is why the ordinary case - everybody who already has a photo - costs one write that matches
    //     nothing, with no read.
    //
    // `updated_at` is held to itself, the way services/users.ts#touchLastSeen holds it: the column carries
    // `$onUpdateFn`, so a plain write here would move the employee's ETag and 409 an open editor over a
    // bookkeeping stamp.
    const now = new Date();
    const claimed = await deps.db
      .update(schema.employees)
      .set({ photoAt: now, updatedAt: sql`${schema.employees.updatedAt}` })
      .where(
        and(
          sql`lower(${schema.employees.workEmail}) = ${email}`,
          isNull(schema.employees.deleteTime),
          isNull(schema.employees.photoKey),
          isNull(schema.employees.photoAt),
        ),
      )
      .returning({ uuid: schema.employees.uuid });
    const employeeId = claimed[0]?.uuid;
    if (!employeeId) return; // no employee with this work email, or they have (or had) a photo already

    try {
      const res = await fetch(atUsableSize(url.toString()), { headers: { accept: "image/jpeg" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`google avatar fetch failed: ${res.status}`);
      // Everything downstream serves this object AS JPEG - `batchGetPhotos` hands the browser
      // `data:image/jpeg;base64,…` - so a body of any other type would be stored under a label that lies about
      // it. Google returns JPEG for a cropped render; anything else is not the thing this asked for.
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("image/jpeg")) throw new Error(`google avatar is ${type || "untyped"}, not image/jpeg`);
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error(`google avatar is ${bytes.byteLength} bytes`);
      // Through the ordinary upload path: it owns the encrypted R2 put, the `photo_key` / `photo_at` write and
      // the audit entry. `systemActor` is the honest actor - nobody pressed upload.
      await uploadPhoto(deps, systemActor(), employeeId, bytes);
    } catch (e) {
      // RELEASE THE CLAIM. Without this a single bad response (Google down, a transient 500) would spend the
      // one chance this person ever gets, silently and permanently - the predicate above would never match
      // them again. Guarded on `photo_key IS NULL` so it cannot undo a photo that did land.
      await deps.db
        .update(schema.employees)
        .set({ photoAt: null, updatedAt: sql`${schema.employees.updatedAt}` })
        .where(and(eq(schema.employees.uuid, employeeId), isNull(schema.employees.photoKey)));
      throw e;
    }
  } catch (e) {
    console.error("[auth] google profile photo import failed (non-fatal)", e);
  }
}
