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

export async function computeProfileCompleteness(
  deps: Deps,
  row: typeof schema.employees.$inferSelect,
): Promise<ProfileCompleteness> {
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
