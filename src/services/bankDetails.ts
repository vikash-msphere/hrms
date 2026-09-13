import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";
import { getSettingValue } from "./settings";
import { checkEtag, updateAtVersion } from "./versionGuard";

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

/** The stored blob, or an empty record when there is none / it will not decrypt. For the merge in
 *  `setBankDetails`: a record that cannot be read must still be replaceable field by field, not a write that
 *  fails. `getBankDetails` keeps its own three-way answer (absent / unreadable / readable), which this cannot
 *  express and does not need to. */
async function readStored(deps: Deps, enc: string | null): Promise<StoredBank> {
  if (!enc) return {};
  try {
    const parsed = JSON.parse(await deps.encryptor.decrypt(enc)) as StoredBank;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

export async function setBankDetails(deps: Deps, actor: AppUser, employeeId: string, input: BankDetailsInput, ifMatch?: string) {
  const emp = await loadEmployee(deps, employeeId);
  checkEtag(emp, ifMatch); // the precise 409 for a caller that already knows its read is stale
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
  // A MERGE PATCH, like every other write in the app: a field that is absent is unchanged, and a field sent
  // empty is cleared (the SPA sends "" for a box somebody emptied, and never null - web/src/api.ts).
  //
  // It used to build the whole blob out of `input` alone, which made an omitted field a DELETED field - the
  // exact bug services/personalDetails.ts#setPersonalDetails already carries a note about having fixed. Every
  // key in `bankSchema` is optional, so `PATCH {"ifsc_code":"X"}` erased the account number, the account name
  // and the bank together, silently: the audit row records field NAMES only, so nothing said what went. The
  // fields it destroys are the ones the bulk-payment file is built from (services/bankFile.ts), so the first
  // sign of it is a payroll disbursement that cannot be paid.
  //
  // The current blob is read the same way `getBankDetails` reads it, and an unreadable one merges as empty
  // rather than failing the write - a legacy/corrupt blob must still be replaceable by typing the details in.
  const current = await readStored(deps, emp.bankDetailsEnc);
  const stored: StoredBank = { ...current };
  for (const f of BANK_FIELDS) {
    const raw = input[f];
    if (raw == null) continue; // absent (or an explicit null) = leave this field as it is
    const v = raw.trim();
    if (v) {
      stored[f] = v;
      continue;
    }
    // EMPTY MEANS "CLEARED" ONLY FOR A FIELD THE CALLER CAN SEE.
    //
    // The account number is the one field that never comes back out (`toMaskedBankView` returns the masked
    // alias and nothing else), so the edit form cannot prefill it and sends "" for "I did not retype it" -
    // web/src/components/common/EmployeeBankDetails.tsx says so in as many words ("Blank number on an
    // existing record = keep what's stored"). A client that cannot read a value cannot meaningfully ask for
    // it to be removed, so "" here is an ABSENT field, not an emptied one. Read the other way round, every
    // save of the bank dialog that did not retype the digits deleted them - which is how a salary payment
    // goes out against an account the file no longer has. The readable fields keep the ordinary merge-patch
    // rule (emptying a prefilled box removes it), the same one services/personalDetails.ts follows.
    if (f === "account_number") continue;
    delete stored[f];
  }
  const enc = await deps.encryptor.encrypt(JSON.stringify(stored));
  // VERSION-GUARDED. The blob above is built from a read, so two overlapping edits did not conflict, they
  // overwrote: the second caller's blob was composed before the first caller's write, and everything the
  // first one changed was gone with a 200 on both requests. Concretely - HR corrects the account number while
  // the employee updates their IFSC, and whichever lands second restores the other's old value; the trail
  // cannot help, because this path deliberately records field NAMES only. The comment above states the cost
  // of losing these fields by a different route: "a payroll disbursement that cannot be paid".
  await updateAtVersion(deps, schema.employees, "employee", emp, { bankDetailsEnc: enc, updatedAt: new Date() });
  // WHICH fields changed, never their values: an account number in a table read by everyone with the `audit`
  // capability outlives the access control on the record it came from. `fieldsMeta` is the shape for exactly
  // this - the trail says "they changed the account number", which is the whole of what it is owed.
  await audit(deps, actor, "employee.bank_details.update", "employees", emp.uuid, fieldsMeta(stored), emp);
  return toMaskedBankView(stored);
}
