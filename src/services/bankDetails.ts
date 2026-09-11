import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";
import { getSettingValue } from "./settings";

/** The org's declared banks (settings/organization `banks`), normalized for comparison. Empty = not configured. */
export async function orgBanks(deps: Deps): Promise<string[]> {
  const org = await getSettingValue<{ banks?: unknown }>(deps, "organization", {});
  return Array.isArray(org.banks) ? org.banks.filter((b): b is string => typeof b === "string" && !!b.trim()).map((b) => b.trim()) : [];
}

/** Case- and whitespace-insensitive bank-name match. THE comparison, so the write gate and the payment file
 *  agree on what "the same bank" means - see the note on `bankName` in setBankDetails. */
export const sameBankName = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

// Structured bank account, stored as an encrypted JSON blob in employees.bank_details_enc.
// Sensitive at rest (never serialized raw); the account number is only ever returned masked.
//
// THE canonical field set for this sub-resource, and the reason it is a `const` array rather than only a type:
// http/fieldAccess.ts needs the list at RUNTIME to decide which keys a per-field rule may deny, and it used to
// keep its own hand-written copy. The copies had already drifted (it listed a `branch` this file did not have),
// and the direction that matters is the other one - a field added here and forgotten there can never be
// denied, so a configured field-level DENY on it silently does nothing. One list, imported.
export const BANK_FIELDS = ["bank_name", "account_name", "account_number", "branch", "ifsc_code", "currency_code"] as const;
export type BankField = (typeof BANK_FIELDS)[number];

export type BankDetailsInput = Partial<Record<BankField, string | null>>;

type StoredBank = Partial<Record<BankField, string>>;

// Bank details are private to the employee, HR and super_admin (mirrors employee document privacy).
export const maskAccount = (n?: string) => {
  if (!n) return undefined;
  const last4 = n.slice(-4);
  return n.length <= 4 ? "••••" : `•••• ${last4}`;
};

async function loadEmployee(deps: Deps, employeeId: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

// Masked, wire-safe view. Never includes the full account number.
// Exported for test/fieldAccessDrift.test.ts: the shape this returns is what the redaction has to be able to
// strip, so the test asserts against the real thing rather than a re-typed copy of it.
export function toMaskedBankView(stored: StoredBank | null) {
  if (!stored) return { on_file: false };
  return {
    bank_name: stored.bank_name || undefined,
    account_name: stored.account_name || undefined,
    account_number_masked: maskAccount(stored.account_number),
    // The branch the account is held at. A required column in several banks' bulk-payment formats
    // (services/bankFile.ts maps it), which is why it is captured rather than inferred from the IFSC.
    branch: stored.branch || undefined,
    ifsc_code: stored.ifsc_code || undefined,
    currency_code: stored.currency_code || undefined,
    on_file: true,
  };
}

export async function getBankDetails(deps: Deps, _actor: AppUser, employeeId: string) {
  // Access (owner / super by default) is enforced by the middleware on employees/<code>/bank-account.
  const emp = await loadEmployee(deps, employeeId);
  if (!emp.bankDetailsEnc) return { on_file: false };
  try {
    const json = await deps.encryptor.decrypt(emp.bankDetailsEnc);
    return toMaskedBankView(JSON.parse(json) as StoredBank);
  } catch {
    // Legacy / unreadable blob: report it's on file without exposing anything.
    return { on_file: true };
  }
}

export async function setBankDetails(deps: Deps, actor: AppUser, employeeId: string, input: BankDetailsInput) {
  const emp = await loadEmployee(deps, employeeId);
  if (input == null || typeof input !== "object") throw invalidArgument("bank details body required");
  // `bank_name` IS AN ENUM, and it has to be enforced here rather than only in the picker.
  //
  // services/bankFile.ts decides a payment line's `transaction_type` by matching this string against the bank
  // format's key (both are meant to be one of the org's declared banks): equal = the format's `intra` value
  // (a within-bank internal transfer), otherwise `inter` (NEFT/RTGS). The SPA only ever offers
  // settings/organization `banks` in a Select, so the match worked for anything typed through the UI - but
  // nothing on the server said so. An API-key writer, or the free-text fallback the form shows when `banks`
  // is unset, could store "HDFC Bank Ltd." against a format keyed "HDFC", and every internal transfer in the
  // file would then be classified and charged as an inter-bank one, silently and for good.
  //
  // Only enforced when the org has actually declared its banks: an org that has not configured the list has
  // no enum to check against, and refusing every bank name would make bank details unfillable.
  const bankName = input.bank_name?.trim() || undefined;
  if (bankName) {
    const banks = await orgBanks(deps);
    if (banks.length && !banks.some((b) => sameBankName(b, bankName))) {
      throw invalidArgument(`bank_name must be one of the organization's banks (${banks.join(", ")}); "${bankName}" is not. Add it under Settings -> Organization first.`);
    }
  }
  const stored: StoredBank = {
    bank_name: bankName,
    account_name: input.account_name?.trim() || undefined,
    account_number: input.account_number?.trim() || undefined,
    branch: input.branch?.trim() || undefined,
    ifsc_code: input.ifsc_code?.trim() || undefined,
    currency_code: input.currency_code?.trim() || undefined,
  };
  const enc = await deps.encryptor.encrypt(JSON.stringify(stored));
  await deps.db.update(schema.employees).set({ bankDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid));
  // WHICH fields changed, never their values: an account number in a table read by everyone with the `audit`
  // capability outlives the access control on the record it came from. `fieldsMeta` is the shape for exactly
  // this - the trail says "they changed the account number", which is the whole of what it is owed.
  await audit(deps, actor, "employee.bank_details.update", "employees", emp.uuid, fieldsMeta(stored), emp);
  return toMaskedBankView(stored);
}
