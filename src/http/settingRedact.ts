// The one settings blob that is not all ordinary org config.
//
// `settings/organization` is read by EVERY signed-in user: web/src/lib/org.tsx#OrgProvider fetches it on mount
// for branding, currency and the favicon, settingsStore keeps the snapshot on disk for 24h, and the seeded
// grants give every role `settings.**` at read. Two of the values inside it are not branding:
// `letter_defaults.signatory_signature` and `letter_defaults.company_stamp` are the employer's authorized
// signature image and the company seal, the two images stamped onto offer, increment, experience and
// relieving letters (domain/letters.ts, services/offerLetter.ts). Handing those to the whole workforce - and
// caching them on every employee's disk - is what lets anyone paste a convincing authorized signature and seal
// onto a document the company never issued.
//
// It is also the exact hazard services/employeePhoto.ts already refuses to take for an INDIVIDUAL's signature:
// "a signature is forgeable, so it is owner-only at the SERVICE level regardless of any employees.* grant".
// An employee's own signature gets a hard rule even super cannot bypass; the employer's had none.
//
// So the blob is served WHOLE to the people who administer it - whoever may PATCH this key - and without the
// two images to everybody else. Same shape as http/fieldAccess.ts#redactFlat for employee sub-resources: the
// decision is rendered by the engine's own `decide()` (which is why this lives in src/http and not in the
// service), and it can only ever NARROW a response the middleware has already allowed.
//
// The letter renderers are unaffected. They read the row server-side through services/settings.ts
// #getSettingValue, which never passes through a serializer.
import { decide, resolveRequest } from "../domain/permissions";
import type { AppUser } from "../env";
import type { Wire } from "./wire";

/** Fields of `organization.letter_defaults` that are the employer's signature material, not its branding. */
export const SIGNATURE_FIELDS = ["signatory_signature", "company_stamp"] as const;

type OrgValue = { letter_defaults?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Drop the employer's signature and seal from a serialized setting unless this caller may write the key.
 *
 * Deciding on WRITE rather than on some new capability is deliberate: the question "may you see the signature
 * the company signs with" has the same answer as "may you change it", and reusing the key's own write
 * decision means a per-key deny (`settings.organization`) narrows both halves at once instead of one.
 */
export function redactSettingResource(res: Wire<"setting">, user: AppUser): Wire<"setting"> {
  if (res.key !== "organization") return res;
  const value = res.value as OrgValue | null | undefined;
  const defaults = value?.letter_defaults;
  if (!defaults || !SIGNATURE_FIELDS.some((f) => defaults[f] != null)) return res;
  if (decide(user.grant, resolveRequest("PATCH", `/v1/settings/${res.key}`), { employeeCode: user.employeeCode }).allow) return res;
  const letterDefaults = { ...defaults };
  for (const f of SIGNATURE_FIELDS) delete letterDefaults[f];
  // `value` is an open JSON blob on the wire (the generated type is an empty object), so the cast is through
  // `unknown` - the shape is the setting's own, not the schema's.
  return { ...res, value: { ...value, letter_defaults: letterDefaults } as unknown as Wire<"setting">["value"] };
}
