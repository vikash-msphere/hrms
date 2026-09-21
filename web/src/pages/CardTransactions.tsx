import { useMemo, useState } from "react";
import { CreditCard, Upload, Link2, RefreshCw } from "lucide-react";
import { get, invoke, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, idOf, formatDate, formatMoney } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { CardTransaction, Expense, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { FilterChips } from "@/components/common/FilterChips";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useToast } from "@/components/ui/use-toast";

// Corporate card charges, and the claims that account for them.
//
// The page exists to answer one question a ledger of expenses cannot: what did the company pay for that
// nobody has filed a claim for? Before the statement is imported that spending is invisible, because the app
// only knows about what somebody remembered to type.

/** A pasted CSV, turned into import rows. Deliberately forgiving about column ORDER and naming, because every
 *  issuer names them differently, and deliberately strict about the three that have to be there. */
function parseStatement(text: string): { rows: { posted_on: string; amount: number; merchant?: string; reference?: string; card_last4?: string }[]; error?: string } {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], error: "Paste the statement including its header row." };
  const cells = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = cells(lines[0]!).map((h) => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find("date", "posted");
  const iAmount = find("amount", "debit", "value");
  const iMerchant = find("description", "merchant", "narrative", "particulars");
  const iRef = find("reference", "txn", "transaction id");
  const iCard = find("card", "last4");
  if (iDate < 0 || iAmount < 0) return { rows: [], error: "Could not find a date column and an amount column in the header." };

  const rows = [];
  for (const line of lines.slice(1)) {
    const c = cells(line);
    // Amounts arrive with currency symbols, thousands separators and the occasional trailing CR/DR.
    const amount = Math.abs(Number((c[iAmount] ?? "").replace(/[^0-9.-]/g, "")));
    const raw = (c[iDate] ?? "").trim();
    // Accept YYYY-MM-DD as-is; anything else goes through Date, which is where DD/MM vs MM/DD ambiguity
    // lives - so a statement in the other convention is a thing to notice, not something to guess at.
    const posted_on = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date(raw).toISOString().slice(0, 10);
    if (!amount || posted_on === "Invalid Date" || Number.isNaN(Date.parse(posted_on))) continue;
    rows.push({
      posted_on, amount,
      ...(iMerchant >= 0 && c[iMerchant] ? { merchant: c[iMerchant] } : {}),
      ...(iRef >= 0 && c[iRef] ? { reference: c[iRef] } : {}),
      ...(iCard >= 0 && c[iCard] ? { card_last4: c[iCard]!.replace(/\D/g, "").slice(-4) } : {}),
    });
  }
  if (!rows.length) return { rows: [], error: "No rows with a usable date and amount." };
  return { rows };
}

export default function CardTransactions({ me: _me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<CardTransaction>("card-transactions", { all: true });
  const { rows: expenses } = useCollection<Expense>("expenses", { all: true });
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const { toast } = useToast();
  const writable = usePermission("card-transactions.write");

  const [filter, setFilter] = useState<"all" | "unmatched" | "matched">("unmatched");
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<CardTransaction | null>(null);

  const shown = useMemo(
    () => rows.filter((r) => (filter === "all" ? true : filter === "matched" ? !!r.expense : !r.expense)),
    [rows, filter],
  );
  const unmatchedTotal = useMemo(
    () => rows.filter((r) => !r.expense).reduce((t, r) => t + (r.amount ?? 0), 0),
    [rows],
  );

  async function doImport() {
    const parsed = parseStatement(csv);
    if (parsed.error) { toast({ title: "Couldn't read that", description: parsed.error, variant: "destructive" }); return; }
    setBusy(true);
    try {
      const r = await invoke<{ imported: number; duplicates: number }>("card-transactions", "import", undefined, { rows: parsed.rows });
      // The duplicate count is the point: "42 imported" when 40 were already held tells nobody whether the
      // upload did anything.
      toast({ title: `${r.imported} imported`, description: r.duplicates ? `${r.duplicates} were already held.` : undefined, variant: "success" });
      setImportOpen(false);
      setCsv("");
      await reload();
    } catch (e) {
      toast({ title: "Import failed", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function doReconcile() {
    setBusy(true);
    try {
      const r = await invoke<{ matched: number; unmatched_rows: number; unmatched_expenses: number }>("card-transactions", "reconcile");
      toast({
        title: `${r.matched} matched`,
        description: `${r.unmatched_rows} charges still unclaimed · ${r.unmatched_expenses} claims with no charge behind them.`,
        variant: "success",
      });
      await reload();
    } catch (e) {
      toast({ title: "Couldn't reconcile", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function link(txn: CardTransaction, expensePath: string | null) {
    try {
      await patch(`card-transactions/${idOf(txn.path)}`, { expense: expensePath }, txn.etag);
      setLinking(null);
      await reload();
    } catch (e) {
      toast({ title: "Couldn't change the match", description: (e as Error).message, variant: "destructive" });
    }
  }

  const expenseLabel = (path?: string) => {
    const e = expenses.find((x) => idOf(x.path) === idOf(path ?? ""));
    return e ? `${money(e.amount)} · ${e.description || e.invoice_number || "expense"}` : path ?? "";
  };

  const columns: Column<CardTransaction>[] = [
    { id: "posted", header: "Posted", mobilePriority: 1, accessor: (r) => r.posted_on ?? "", cell: (r) => formatDate(r.posted_on) },
    { id: "merchant", header: "Merchant", mobilePriority: 2, accessor: (r) => r.merchant ?? "", cell: (r) => r.merchant || <span className="text-muted-foreground">-</span> },
    { id: "amount", header: "Amount", align: "right", mobilePriority: 3, accessor: (r) => r.amount ?? 0, aggregate: "sum", formatTotal: (n) => money(n), cell: (r) => <span className="tabular-nums">{money(r.amount ?? 0)}</span> },
    { id: "card", header: "Card", defaultHidden: true, accessor: (r) => r.card_last4 ?? "", cell: (r) => (r.card_last4 ? `····${r.card_last4}` : "-") },
    {
      // How the pairing was decided, not only that it was: an approver should be able to tell "the amount and
      // the week agreed" from "a person said so".
      id: "match", header: "Claim", filter: "select", mobilePriority: 4,
      accessor: (r) => (r.expense ? (r.match_confidence ?? "matched") : "unclaimed"),
      cell: (r) => (r.expense
        ? <span className="text-xs">{expenseLabel(r.expense)}<span className="ml-1 text-muted-foreground">({r.match_confidence})</span></span>
        : <span className="text-xs text-warning">nobody has claimed it</span>),
    },
    {
      id: "actions", header: "", sortable: false, filter: "none",
      cell: (r) => (writable ? (
        <Button size="sm" variant="ghost" onClick={() => setLinking(r)}>
          <Link2 className="mr-1 h-3.5 w-3.5" />{r.expense ? "Change" : "Link"}
        </Button>
      ) : null),
    },
  ];

  return (
    <AccessScope collection="card-transactions">
      <PageHeader
        title="Card charges"
        description="What the company card was charged, and which claims account for it."
        actions={writable ? (
          <div className="flex items-center gap-2">
            <AccessAction collection="card-transactions" verb="reconcile">
              <Button variant="outline" onClick={doReconcile} disabled={busy}><RefreshCw className="mr-1 h-4 w-4" />Match claims</Button>
            </AccessAction>
            <AccessAction collection="card-transactions" verb="import">
              <Button onClick={() => setImportOpen(true)}><Upload className="mr-1 h-4 w-4" />Import statement</Button>
            </AccessAction>
          </div>
        ) : undefined}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0
          ? <EmptyState icon={CreditCard} title="No card charges imported" description="Import a statement and the charges nobody has claimed become visible." />
          : (
            <>
              {/* The number the page exists for. Silent when everything is accounted for, because a band that
                  always reads zero is one people stop seeing. */}
              {unmatchedTotal > 0 && (
                <p className="mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning">
                  <span className="font-medium">{money(unmatchedTotal)}</span> charged to company cards with no claim behind it.
                </p>
              )}
              <FilterChips<typeof filter>
                className="mb-3"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "unmatched", label: "Unclaimed", count: rows.filter((r) => !r.expense).length },
                  { value: "matched", label: "Accounted for", count: rows.filter((r) => !!r.expense).length },
                  { value: "all", label: "All", count: rows.length },
                ]}
              />
              <DataTable<CardTransaction> rows={shown} columns={columns} getRowId={(r) => r.path} emptyTitle="Nothing here" />
            </>
          )}
      </DataState>

      <WriteDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import a statement"
        description="Paste the statement CSV including its header row. Importing the same period twice is safe - charges already held are counted and not written again."
        collection="card-transactions"
        form={{ csv }}
        submitLabel="Import"
        canSubmit={!!csv.trim()}
        whyNot={[!csv.trim() && "Paste the statement first"]}
        onSubmit={doImport}
      >
        <Field label="Statement CSV" hint="Needs a date column and an amount column; a description, reference and card number are used when present.">
          <Textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"Date,Description,Amount\n2026-06-10,SQ *COFFEE CO,1200.00"} />
        </Field>
      </WriteDialog>

      <Dialog open={!!linking} onOpenChange={(v) => !v && setLinking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Which claim accounts for this?</DialogTitle>
            <DialogDescription>
              {linking ? `${formatDate(linking.posted_on)} · ${money(linking.amount ?? 0)}${linking.merchant ? ` · ${linking.merchant}` : ""}` : ""}
              {" "}Linking by hand is recorded as a manual match, so it reads differently from one the matcher made.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1">
            {linking?.expense && (
              <Button variant="outline" className="w-full justify-start" onClick={() => link(linking, null)}>Unlink from {expenseLabel(linking.expense)}</Button>
            )}
            {/* Nearest amounts first: the claim that accounts for a charge almost always agrees on the money,
                so sorting by how far off it is puts the right answer at the top without pretending to match. */}
            {expenses
              .filter((e) => !e.recurring)
              .slice()
              .sort((a, b) => Math.abs((a.amount ?? 0) - (linking?.amount ?? 0)) - Math.abs((b.amount ?? 0) - (linking?.amount ?? 0)))
              .slice(0, 12)
              .map((e) => (
                <Button
                  key={e.path}
                  variant="ghost"
                  className={cn("w-full justify-start text-left", Math.abs((e.amount ?? 0) - (linking?.amount ?? 0)) < 0.005 && "font-medium")}
                  onClick={() => linking && link(linking, `expenses/${idOf(e.path)}`)}
                >
                  {money(e.amount ?? 0)} · {formatDate(e.incurred_on)} · {e.description || e.invoice_number || "expense"}
                </Button>
              ))}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </AccessScope>
  );
}
