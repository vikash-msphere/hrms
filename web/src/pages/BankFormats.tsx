import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Upload, Save, FileSpreadsheet } from "lucide-react";
import { get, patch, upload } from "@/api";
import { usePermission } from "@/lib/perm";
import type { BankFormat, BankFormatColumn, PayrollDebitAccount } from "@/types";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useToast } from "@/components/ui/use-toast";

type Toast = ReturnType<typeof useToast>["toast"];

// The column "source" vocabulary - mirrors src/services/bankFormats.ts ColumnSource. UX only; the export
// (publish phase) is what reads these. `debit_account`/`currency`/`value_date`/`transaction_type` are filled
// at export time from the employer debit config / the run, not from the employee.
const SOURCES: { value: string; label: string }[] = [
  { value: "skip", label: "- skip -" },
  { value: "account_name", label: "Beneficiary name" },
  { value: "account_number", label: "Account number" },
  { value: "ifsc_code", label: "IFSC" },
  { value: "bank_name", label: "Bank name" },
  { value: "branch", label: "Branch" },
  { value: "employee_code", label: "Employee code" },
  { value: "full_name", label: "Employee full name" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "work_email", label: "Work email" },
  { value: "net", label: "Net pay (amount)" },
  { value: "gross", label: "Gross pay" },
  { value: "total_deductions", label: "Total deductions" },
  { value: "tax", label: "Tax (TDS)" },
  { value: "debit_account", label: "Debit account (employer)" },
  { value: "currency", label: "Currency" },
  { value: "value_date", label: "Value date (run)" },
  { value: "transaction_type", label: "Transaction type (IFT/NEFT)" },
  { value: "literal", label: "Constant text" },
];

// Transaction-type options. "Within bank" (employee's bank == this format's bank) allows the intra-bank mode
// (IFT) plus the inter-bank rails; "other banks" cannot use IFT. The export picks the within-bank value when
// the employee's bank equals this format's bank, else the other-banks value.
const INTRA_TYPES = ["IFT", "NEFT", "RTGS", "IMPS"];
const INTER_TYPES = ["NEFT", "RTGS", "IMPS"];

// Best-effort source from a header label, so a freshly-imported template is mostly pre-mapped.
function guessSource(header: string): string {
  const h = header.toLowerCase();
  if (/debit/.test(h)) return "debit_account";
  if (/ifsc/.test(h)) return "ifsc_code";
  if (/account\s*(number|no)|a\/c/.test(h)) return "account_number";
  if (/benef\w*\s*name|^name/.test(h)) return "account_name";
  if (/amount/.test(h)) return "net";
  if (/email/.test(h)) return "work_email";
  if (/currency/.test(h)) return "currency";
  if (/date/.test(h)) return "value_date";
  if (/(transaction|txn|payment)\s*type/.test(h)) return "transaction_type";
  if (/branch/.test(h)) return "branch";
  if (/remark|narration|advice|custom/.test(h)) return "literal";
  return "skip";
}

const blank = (): BankFormat => ({ columns: [], header_row: 1, data_start_row: 2, sheet: "" });

// Configure each allowed bank's bulk-payment Excel format: upload the bank's blank template, then map every
// column to a payroll field. The template + mappings are stored; the publish-time export fills a copy.
export default function BankFormats({ toast }: { toast: Toast }) {
  const isSuper = usePermission("users.write"); // proxy for super_admin (the debit account is super-only)
  const [banks, setBanks] = useState<string[]>([]);
  const [formats, setFormats] = useState<Record<string, BankFormat>>({});
  const [debit, setDebit] = useState<Record<string, PayrollDebitAccount>>({});
  const [sel, setSel] = useState<string>("");
  const [draft, setDraft] = useState<BankFormat>(blank());
  // `account` is the NEW account number to set (blank = keep the stored one); we never receive the full value.
  const [debitDraft, setDebitDraft] = useState<{ account: string; currency_code: string }>({ account: "", currency_code: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const org = await get<{ value?: { banks?: string[] } }>("settings/organization");
        const list = Array.isArray(org.value?.banks) ? org.value!.banks! : [];
        setBanks(list);
        const fmts = await get<{ results: BankFormat[] }>("bank-formats");
        setFormats(Object.fromEntries((fmts.results ?? []).map((f) => [f.bank!, f])));
        if (isSuper) {
          const d = await get<{ results: PayrollDebitAccount[] }>("payroll-debit-accounts");
          setDebit(Object.fromEntries((d.results ?? []).map((e) => [e.bank, e])));
        }
        if (list.length) setSel((s) => s || list[0]!);
      } catch (e) {
        toast({ variant: "destructive", title: "Could not load bank formats", description: String((e as Error).message) });
      }
    })();
  }, [isSuper, toast]);

  // Load the editable drafts whenever the selected bank changes.
  useEffect(() => {
    setDraft(formats[sel] ? { ...blank(), ...formats[sel] } : blank());
    setDebitDraft({ account: "", currency_code: debit[sel]?.currency_code ?? "" });
  }, [sel, formats, debit]);

  const setCol = (i: number, patch: Partial<BankFormatColumn>) =>
    setDraft((d) => ({ ...d, columns: d.columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));

  async function onTemplate(file: File) {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.SheetNames[0] ?? "Sheet1";
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet]!, { header: 1, defval: "" });
      const headers = (aoa[0] ?? []).map((h) => String(h ?? "").trim());
      // If row 2 is mostly long text it's an instructions row (e.g. IDFC), so data starts on row 3.
      const row2 = (aoa[1] ?? []) as unknown[];
      const looksLikeInstructions = row2.filter((v) => String(v ?? "").length > 40).length >= 2;
      const columns: BankFormatColumn[] = headers
        .map((header, i) => ({ col: i + 1, header, source: guessSource(header) }))
        .filter((c) => c.header.length > 0);
      const out = await upload<{ r2_key: string; file_name: string }>(`bank-formats/${encodeURIComponent(sel)}`, file, { verb: "uploadTemplate" });
      setDraft({ columns, header_row: 1, data_start_row: looksLikeInstructions ? 3 : 2, sheet, template_name: out.file_name ?? file.name, r2_key: out.r2_key });
      toast({ title: "Template imported", description: `${columns.length} columns from "${sheet}". Map each below, then Save.` });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not read template", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const body = { sheet: draft.sheet, header_row: draft.header_row, data_start_row: draft.data_start_row, columns: draft.columns, template_name: draft.template_name ?? null, r2_key: draft.r2_key ?? null };
      const saved = await patch<BankFormat>(`bank-formats/${encodeURIComponent(sel)}`, body);
      setFormats((m) => ({ ...m, [sel]: { ...saved, bank: sel } }));
      if (isSuper) {
        const body: Record<string, string> = { currency_code: debitDraft.currency_code };
        if (debitDraft.account.trim()) body.debit_account_number = debitDraft.account.trim();
        const d = await patch<PayrollDebitAccount>(`payroll-debit-accounts/${encodeURIComponent(sel)}`, body);
        setDebit((m) => ({ ...m, [sel]: { ...d, bank: sel } }));
      }
      toast({ title: `Saved ${sel} format` });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not save", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  const configured = useMemo(() => new Set(Object.keys(formats)), [formats]);

  if (banks.length === 0) {
    return <EmptyState icon={FileSpreadsheet} title="No banks yet" description="Add your allowed banks on the Organization tab first, then define each bank's bulk-payment Excel format here." />;
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <p className="text-sm text-muted-foreground">
          Upload each bank's blank bulk-payment Excel template, then map every column to the payroll field that fills
          it. On payroll publish the export writes one row per employee into a copy of the template.
        </p>

        {/* Bank picker */}
        <div className="flex flex-wrap gap-2">
          {banks.map((b) => (
            <Button key={b} size="sm" variant={sel === b ? "default" : "outline"} className="h-8" onClick={() => setSel(b)}>
              {b}
              {configured.has(b) && <span className="ml-1.5 rounded-full bg-success/15 px-1.5 text-[10px] font-medium text-success">set</span>}
            </Button>
          ))}
        </div>

        {sel && (
          <div className="space-y-5">
            {/* Template */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{draft.template_name ?? "No template uploaded"}</p>
                <p className="text-xs text-muted-foreground">{draft.columns.length ? `${draft.columns.length} columns · sheet "${draft.sheet}"` : "Upload the bank's blank .xlsx to detect its columns."}</p>
              </div>
              <AccessAction collection="bank-formats" verb="uploadTemplate" label="Upload template">
                <label>
                  <input type="file" accept=".xlsx" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && onTemplate(e.target.files[0])} />
                  <Button asChild size="sm" variant="outline" disabled={busy}>
                    <span><Upload className="h-4 w-4" /> {draft.columns.length ? "Replace template" : "Upload template"}</span>
                  </Button>
                </label>
              </AccessAction>
            </div>

            {/* Column mapping */}
            {draft.columns.length > 0 && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4 sm:max-w-md">
                  <Field label="Header row" hint="1-based row with the column titles.">
                    <Input type="number" min={1} value={draft.header_row ?? 1} onChange={(e) => setDraft((d) => ({ ...d, header_row: Number(e.target.value) }))} />
                  </Field>
                  <Field label="Data starts on row" hint="First row the export writes to.">
                    <Input type="number" min={1} value={draft.data_start_row ?? 2} onChange={(e) => setDraft((d) => ({ ...d, data_start_row: Number(e.target.value) }))} />
                  </Field>
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-3 py-2 font-semibold">Col</th>
                        <th className="px-3 py-2 font-semibold">Header</th>
                        <th className="px-3 py-2 font-semibold">Fill from</th>
                        <th className="px-3 py-2 font-semibold">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.columns.map((c, i) => (
                        <tr key={c.col} className="border-b last:border-0">
                          <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{c.col}</td>
                          <td className="px-3 py-1.5 font-medium">{c.header}</td>
                          <td className="px-3 py-1.5">
                            <Select value={c.source} onValueChange={(v) => setCol(i, { source: v })}>
                              <SelectTrigger className="h-8 w-52"><SelectValue /></SelectTrigger>
                              <SelectContent>{SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                            </Select>
                          </td>
                          <td className="px-3 py-1.5">
                            {c.source === "literal" && (
                              <Input className="h-8 w-44" placeholder="Constant value" value={c.value ?? ""} onChange={(e) => setCol(i, { value: e.target.value })} />
                            )}
                            {c.source === "transaction_type" && (
                              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                <span>Within bank</span>
                                <Select value={c.intra ?? ""} onValueChange={(v) => setCol(i, { intra: v })}>
                                  <SelectTrigger className="h-8 w-20"><SelectValue placeholder="IFT" /></SelectTrigger>
                                  <SelectContent>{INTRA_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                                </Select>
                                <span>Other banks</span>
                                <Select value={c.inter ?? ""} onValueChange={(v) => setCol(i, { inter: v })}>
                                  <SelectTrigger className="h-8 w-20"><SelectValue placeholder="NEFT" /></SelectTrigger>
                                  <SelectContent>{INTER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                                </Select>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Debit account - super only */}
            {isSuper && draft.columns.length > 0 && (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 dark:bg-amber-950/20">
                <p className="mb-2 text-sm font-medium">Employer debit account <span className="text-xs font-normal text-muted-foreground">· super admin only</span></p>
                <div className="grid gap-4 sm:grid-cols-2 sm:max-w-md">
                  <Field label="Debit account number" hint={debit[sel]?.on_file ? "Leave blank to keep the current account." : "The employer account funds are paid from."}>
                    <Input value={debitDraft.account} placeholder={debit[sel]?.debit_account_number_masked ?? "Account number"} onChange={(e) => setDebitDraft((d) => ({ ...d, account: e.target.value }))} />
                  </Field>
                  <Field label="Currency" hint="e.g. INR.">
                    <Input value={debitDraft.currency_code} onChange={(e) => setDebitDraft((d) => ({ ...d, currency_code: e.target.value }))} placeholder="INR" />
                  </Field>
                </div>
              </div>
            )}

            {draft.columns.length > 0 && (
              <AccessAction collection="bank-formats" label={`Save ${sel} format`}>
                <Button onClick={save} loading={busy}>{!busy && <Save className="h-4 w-4" />} Save {sel} format</Button>
              </AccessAction>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
