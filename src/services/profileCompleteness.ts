import * as schema from "../db/schema";
import type { Deps } from "../deps";

/** Which self-service profile sections have data, for the /profile completeness meter. Computed from the
 *  employee row the caller's GET already loaded - the encrypted sub-resource blobs are columns on that same
 *  row, so this costs decrypt CPU only, zero extra D1 reads. The flags reveal whether e.g. bank data
 *  exists, so the route attaches them only for the employee themselves or HR (employees.write). */
export type ProfileCompleteness = {
  photo: boolean;
  personal: boolean;
  contact: boolean;
  emergency: boolean;
  identity: boolean;
  bank: boolean;
  // Optional: stripped for non-owner viewers (a signature's existence is owner-private).
  signature?: boolean;
};

const has = (v: unknown) => typeof v === "string" && v.trim() !== "";

async function blob(deps: Deps, enc: string | null): Promise<Record<string, unknown>> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The employee columns the flags are computed from, so a caller can read just these. */
export type ProfileColumns = Pick<
  typeof schema.employees.$inferSelect,
  "photoKey" | "signatureKey" | "personalDetailsEnc" | "bankDetailsEnc" | "identityDetailsEnc"
>;

export async function computeProfileCompleteness(deps: Deps, row: ProfileColumns): Promise<ProfileCompleteness> {
  const personal = await blob(deps, row.personalDetailsEnc);
  const bank = await blob(deps, row.bankDetailsEnc);
  // Identity fields are org-configurable (settings/employee-fields); checking them against the config would
  // cost a settings read, so "complete" here is just "at least one value stored".
  const identity = await blob(deps, row.identityDetailsEnc);
  return {
    photo: !!row.photoKey,
    personal: has(personal.date_of_birth) && has(personal.gender),
    contact: has(personal.personal_phone) && (has(personal.communication_address) || has(personal.permanent_address)),
    emergency: has(personal.emergency_name) && has(personal.emergency_phone),
    identity: Object.values(identity).some(has),
    bank: has(bank.account_number) && has(bank.ifsc_code),
    signature: !!row.signatureKey,
  };
}

/** The /profile checklist, in the order and with the names its tiles use (web ProfileCompleteness.tsx ITEMS),
 *  so a message naming the missing items names the tiles the reader will see. `appLock` is the one item not
 *  on the employee row: whether their sign-in account has an app PIN. */
const CHECKLIST: { key: keyof ProfileCompleteness | "appLock"; label: string }[] = [
  { key: "photo", label: "Profile photo" },
  { key: "personal", label: "Personal details" },
  { key: "contact", label: "Contact details" },
  { key: "emergency", label: "Emergency contact" },
  { key: "appLock", label: "App PIN" },
  { key: "identity", label: "Identity" },
  { key: "bank", label: "Bank details" },
  { key: "signature", label: "Signature" },
];

/** The checklist items still empty for one person, by label. `appPinMissing` comes from the scheduled
 *  metrics (services/scheduledMetrics.ts), which already know who has an app PIN. */
export async function missingProfileItems(deps: Deps, row: ProfileColumns, appPinMissing: boolean): Promise<string[]> {
  const flags = await computeProfileCompleteness(deps, row);
  return CHECKLIST.filter((i) => (i.key === "appLock" ? appPinMissing : !flags[i.key])).map((i) => i.label);
}
