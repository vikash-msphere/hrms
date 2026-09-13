import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { aborted, invalidArgument } from "../lib/errors";
import { getSettingValue, mutateSetting } from "./settings";

// Bank bulk-payment Excel formats. Three pieces, all owned here:
//  - COLUMN MAPPINGS (which sheet column -> which payroll field) as plain data in the settings table key
//    `bank-formats`; managed via /v1/bank-formats (HR + super).
//  - the sensitive DEBIT account + currency per bank in the settings key `payroll-debit`; managed via
//    /v1/payroll-debit, which is private-by-default so only super_admin reaches it.
//  - the bank's blank .xlsx TEMPLATE in R2. At payroll publish (a later phase) the export writes data rows
//    into a copy of the template so the bank's exact layout, styling and sheet protection are preserved.
// Storage is the settings table (as requested); the access gate lives on the dedicated namespaces.

// What a single column's value is filled from at export. Per-employee fields, run/employer values, a typed
// constant, or skip. `transaction_type` is derived: the `intra` value when the employee's bank equals this
// format's bank (both chosen from the allowed banks), else the `inter` value.
export type ColumnSource =
  | "account_name" | "account_number" | "ifsc_code" | "bank_name" | "branch"
  | "employee_code" | "full_name" | "first_name" | "last_name" | "work_email"
  | "net" | "gross" | "total_deductions" | "tax"
  | "debit_account" | "currency" | "value_date" | "transaction_type" | "literal" | "skip";

export type BankFormatColumn = {
  col: number; // 1-based sheet column
  header: string; // the bank's header label (row 1)
  source: ColumnSource;
  value?: string; // literal columns: the constant to write
  // transaction_type: within-bank value (employee bank == this format's bank, e.g. IFT) vs other-banks (e.g. NEFT).
  intra?: string;
  inter?: string;
};

export type BankFormat = {
  template_name?: string | null; // original uploaded filename (display only)
  r2_key?: string | null; // where the template bytes live in R2
  sheet?: string; // worksheet name to fill
  header_row?: number; // 1-based row holding the headers
  data_start_row?: number; // 1-based row where data rows begin
  columns: BankFormatColumn[];
  // When this bank's entry was last written, in epoch ms - the version `etag` / `If-Match` are built from.
  // PER BANK, not per settings row: the `bank-formats` row holds every bank, so its own `updatedAt` moves when
  // any of them is edited and a guard built on that would 409 an admin whose bank nobody had touched.
  updated_at?: number;
};

export type BankFormats = Record<string, BankFormat>; // keyed by bank name (org's allowed banks)
// The debit account number is sensitive: encrypted at rest in the settings value, returned only masked on the
// wire (full value available server-side for the export). Mirrors the employee bank-account treatment.
type StoredDebit = { debit_account_enc?: string; currency_code?: string };
type PayrollDebitStore = Record<string, StoredDebit>;
export type DebitView = { bank: string; debit_account_number_masked?: string; currency_code?: string; on_file: boolean };
export type DebitInput = { debit_account_number?: string; currency_code?: string };

// ---- column mappings (settings key `bank-formats`) -------------------------------------------------------
// The whole map (used by the publish-time export).
export async function getBankFormats(deps: Deps): Promise<BankFormats> {
  return getSettingValue<BankFormats>(deps, "bank-formats", {});
}

export async function listBankFormats(deps: Deps): Promise<Array<BankFormat & { bank: string }>> {
  const m = await getBankFormats(deps);
  return Object.entries(m).map(([bank, f]) => ({ bank, ...f }));
}

export async function getBankFormat(deps: Deps, bank: string): Promise<(BankFormat & { bank: string }) | null> {
  const m = await getBankFormats(deps);
  return m[bank] ? { bank, ...m[bank]! } : null;
}

// Merge a patch into one bank's format (upsert) and persist the whole map.
//
// Through `mutateSetting`, because editing ONE bank rewrites the WHOLE map: read-then-write let two admins
// saving two different banks silently revert each other. See the note on that function - the version is taken
// and pinned server-side, across the read and the write, so no client contract changes.
/**
 * Write one bank's column mapping.
 *
 * VERSION-GUARDED, when the caller sends one. This replaces a whole blob - the column mapping that decides how
 * the payroll bank file is laid out - so an unguarded write is not "last write wins" over a field, it is one
 * admin's entire layout replacing another's with no sign anything was lost. That is the failure
 * `lib/settingsStore.ts#saveSetting` was given `If-Match` for, on arguably the most consequential config in the
 * app. `mutateSetting` already retries the settings ROW's own compare-and-swap, so two admins editing different
 * banks merge; this closes the case where they are editing the same one.
 *
 * No `ifMatch` writes unguarded, exactly as before - and so does a first write, which has no version to hold.
 */
export async function saveBankFormat(
  deps: Deps,
  actor: AppUser,
  bank: string,
  patch: Partial<BankFormat>,
  ifMatch?: string,
): Promise<BankFormat & { bank: string }> {
  if (!bank.trim()) throw invalidArgument("bank is required");
  let next: BankFormat = { columns: [] };
  await mutateSetting<BankFormats>(deps, actor, "bank-formats", {}, (m) => {
    const current = m[bank];
    if (ifMatch && current && ifMatch !== bankFormatEtag(current)) {
      throw aborted("this bank format was changed by somebody else; re-read it and reapply your change");
    }
    next = { columns: [], ...current, ...patch, updated_at: Date.now() };
    return { ...m, [bank]: next };
  });
  return { bank, ...next };
}

/** The version of one bank's entry. Undefined `updated_at` (an entry written before versioning) has no version
 *  to claim, so it answers a stable sentinel rather than a moving one. */
export const bankFormatEtag = (f: BankFormat): string => `W/"${f.updated_at ?? 0}"`;

// ---- super-only debit config (settings key `payroll-debit`) ----------------------------------------------
const maskAccount = (n?: string) => (!n ? undefined : n.length <= 4 ? "••••" : `•••• ${n.slice(-4)}`);

async function decAccount(deps: Deps, enc?: string): Promise<string | undefined> {
  if (!enc) return undefined;
  try {
    return await deps.encryptor.decrypt(enc);
  } catch {
    return undefined; // unreadable blob: reported on_file, never exposed
  }
}

async function debitView(deps: Deps, bank: string, e: StoredDebit): Promise<DebitView> {
  const n = await decAccount(deps, e.debit_account_enc);
  return { bank, debit_account_number_masked: maskAccount(n), currency_code: e.currency_code, on_file: !!e.debit_account_enc };
}

// FULL decrypted debit config, keyed by bank - server-side only (the publish-time export uses this).
export async function getPayrollDebit(deps: Deps): Promise<Record<string, DebitInput>> {
  const store = await getSettingValue<PayrollDebitStore>(deps, "payroll-debit", {});
  const out: Record<string, DebitInput> = {};
  for (const [bank, e] of Object.entries(store)) out[bank] = { debit_account_number: await decAccount(deps, e.debit_account_enc), currency_code: e.currency_code };
  return out;
}

// Masked views for the API.
export async function listPayrollDebit(deps: Deps): Promise<DebitView[]> {
  const store = await getSettingValue<PayrollDebitStore>(deps, "payroll-debit", {});
  return Promise.all(Object.entries(store).map(([bank, e]) => debitView(deps, bank, e)));
}

export async function getPayrollDebitFor(deps: Deps, bank: string): Promise<DebitView | null> {
  const store = await getSettingValue<PayrollDebitStore>(deps, "payroll-debit", {});
  return store[bank] ? debitView(deps, bank, store[bank]!) : null;
}

// Merge-patch: a blank/absent account number keeps the stored one (so an edit needn't re-enter it).
//
// Guarded by `mutateSetting` for the same reason `saveBankFormat` is - one bank's edit rewrites the map every
// bank lives in. The account is encrypted BEFORE the mutation rather than inside it: the ciphertext depends
// only on what the caller sent, so it does not have to be recomputed when a retry re-reads the map, and the
// mutation stays a pure function of the current value (which is what makes retrying it safe).
export async function savePayrollDebitFor(deps: Deps, actor: AppUser, bank: string, patch: DebitInput): Promise<DebitView> {
  if (!bank.trim()) throw invalidArgument("bank is required");
  const acct = patch.debit_account_number?.trim();
  const enc = acct ? await deps.encryptor.encrypt(acct) : undefined;
  let next: StoredDebit = {};
  await mutateSetting<PayrollDebitStore>(deps, actor, "payroll-debit", {}, (store) => {
    next = { ...store[bank] };
    if (enc) next.debit_account_enc = enc;
    if (patch.currency_code !== undefined) next.currency_code = patch.currency_code.trim() || undefined;
    return { ...store, [bank]: next };
  });
  return debitView(deps, bank, next);
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024; // 5 MB - bank templates are tiny

// R2 key for a bank's template. Bank names are free text (org settings), so slugify to a safe key segment.
export function templateKey(bank: string): string {
  const slug = bank.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bank";
  return `bank-formats/${slug}/template.xlsx`;
}

// An .xlsx is a ZIP container - it must start with the local-file-header magic "PK\x03\x04".
function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function storeBankTemplate(deps: Deps, actor: AppUser, bank: string, bytes: Uint8Array, fileName?: string | null) {
  if (!bank.trim()) throw invalidArgument("bank is required");
  if (bytes.byteLength === 0) throw invalidArgument("empty file");
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) throw invalidArgument(`file exceeds the ${MAX_TEMPLATE_BYTES / 1048576} MB limit`);
  if (!isXlsx(bytes)) throw invalidArgument("not an .xlsx file");
  const r2Key = templateKey(bank);
  await deps.docs.put(r2Key, bytes, XLSX_CONTENT_TYPE); // encrypted by the docstore wrapper
  await audit(deps, actor, "bank_format.template.upload", "settings", "bank-formats", { bank });
  return { r2_key: r2Key, file_name: fileName ?? null, size_bytes: bytes.byteLength };
}

// The stored template bytes (used by the publish-time export; null if none uploaded).
export async function getBankTemplate(deps: Deps, bank: string): Promise<ArrayBuffer | null> {
  return deps.docs.get(templateKey(bank));
}
