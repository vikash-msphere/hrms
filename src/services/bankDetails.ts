import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";

// Structured bank account, stored as an encrypted JSON blob in employees.bank_details_enc.
// Sensitive at rest (never serialized raw); the account number is only ever returned masked.
export type BankDetailsInput = {
  bank_name?: string | null;
  account_name?: string | null;
  account_number?: string | null;
  ifsc_code?: string | null;
  currency_code?: string | null;
};

type StoredBank = {
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  ifsc_code?: string;
  currency_code?: string;
};

// Bank details are private to the employee, HR and super_admin (mirrors employee document privacy).
const maskAccount = (n?: string) => {
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
function toMasked(stored: StoredBank | null) {
  if (!stored) return { on_file: false };
  return {
    bank_name: stored.bank_name || undefined,
    account_name: stored.account_name || undefined,
    account_number_masked: maskAccount(stored.account_number),
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
    return toMasked(JSON.parse(json) as StoredBank);
  } catch {
    // Legacy / unreadable blob: report it's on file without exposing anything.
    return { on_file: true };
  }
}

export async function setBankDetails(deps: Deps, actor: AppUser, employeeId: string, input: BankDetailsInput) {
  const emp = await loadEmployee(deps, employeeId);
  if (input == null || typeof input !== "object") throw invalidArgument("bank details body required");
  const stored: StoredBank = {
    bank_name: input.bank_name?.trim() || undefined,
    account_name: input.account_name?.trim() || undefined,
    account_number: input.account_number?.trim() || undefined,
    ifsc_code: input.ifsc_code?.trim() || undefined,
    currency_code: input.currency_code?.trim() || undefined,
  };
  const enc = await deps.encryptor.encrypt(JSON.stringify(stored));
  await deps.db.update(schema.employees).set({ bankDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid));
  // Audit records that bank details changed - never the values themselves.
  await audit(deps, actor, "employee.bank_details.update", "employees", emp.uuid);
  return toMasked(stored);
}
