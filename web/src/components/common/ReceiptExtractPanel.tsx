import { useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { api, blobOf, patch } from "@/api";
import { openPdf } from "@/lib/pdfjs";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useAiFeature } from "@/lib/aiFeatures";

// Read a claim's invoice into the expense form, one field at a time.
//
// THE PDF IS READ HERE, IN THE BROWSER, and the TEXT is what goes to the server - the same arrangement
// `ResumeExtractPanel` uses and for the same three reasons: the Worker has no PDF reader, this app already
// ships pdfjs for the document viewer, and a PDF parser is enough of an attack surface that keeping it out
// of the Worker is a feature rather than a workaround.
//
// SO THIS READS INVOICES AND NOT PHOTOGRAPHS. A photo of a till receipt has no selectable text and gets the
// "may be a scan" message below. Fixing that would need a vision model, and the reason it was refused is in
// src/services/receiptExtract.ts: an image cannot be scrubbed before it reaches a model the way text is, and
// receipts carry whatever else is printed on them.
//
// NOTHING IS SAVED UNTIL SOMEBODY PRESSES ACCEPT, and accept is an ordinary PATCH of the expense - the same
// write the form does, with the same validation and the same audit row. No bulk "accept all", deliberately:
// the point of the review is that a person checked each value against the document, and one button defeats
// that. The amount especially - a receipt shows a subtotal, a tax line, a tip and a total, and the model
// picking the wrong one is the failure this review exists to catch.
type Fields = Record<string, unknown>;

const LABELS: Record<string, string> = {
  amount: "Total amount",
  tax_amount: "Tax amount",
  incurred_on: "Date incurred",
  vendor_name: "Vendor",
  invoice_number: "Invoice number",
};

/** Which expense column each extracted field writes to.
 *
 *  `vendor_name` has NO entry on purpose. The model returns the seller's name as printed, and the expense
 *  row holds a vendor REFERENCE - resolving one to the other is a guess about which catalogue entry was
 *  meant, and a wrong guess misattributes spend with nothing on screen admitting it. It is shown so the
 *  submitter can pick the right vendor themselves. */
const PATCHABLE: Record<string, string> = {
  amount: "amount",
  tax_amount: "tax_amount",
  incurred_on: "incurred_on",
  invoice_number: "invoice_number",
};

/** Money and dates go back as their own types; everything else as text. Sending an amount as a string would
 *  be rejected by the route's own schema, which is the right place for that to fail but a poor experience. */
const valueFor = (key: string, v: unknown): unknown => (key === "amount" || key === "tax_amount" ? Number(v) : String(v ?? ""));

const render = (v: unknown): string => String(v ?? "");

export function ReceiptExtractPanel({ expenseId, expensePath, can, hasInvoice, isDraft, onSaved }: {
  expenseId: string;
  expensePath: string;
  can?: string[];
  hasInvoice: boolean;
  isDraft: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [fields, setFields] = useState<Fields | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, "accepted" | "dismissed">>({});
  const enabled = useAiFeature("expenses.receiptExtraction");

  // No invoice, not a draft, or the feature is off. Each would make the button an error waiting to happen,
  // and the server refuses all three - so offering it would be offering a failure. A submitted claim is
  // excluded because filling fields underneath an approver is a different and much worse feature.
  if (!hasInvoice || !isDraft || !enabled) return null;

  async function read() {
    setBusy(true);
    try {
      const blob = await blobOf(`expenses/${expenseId}`, { verb: "download" });
      const doc = await openPdf(new Uint8Array(await blob.arrayBuffer()));
      let text = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        // `items` mixes text runs with marked-content markers, which carry no `str` - hence the guard rather
        // than a cast: a marker stringified would put "[object Object]" into the receipt text.
        text += content.items.map((i) => ("str" in i ? i.str : "")).join(" ") + "\n";
        // Stop at the server's cap rather than sending a payload that would only be refused.
        if (text.length > 8_000) break;
      }
      const clean = text.trim().slice(0, 8_000);
      if (!clean) {
        toast({
          title: "Nothing to read",
          description: "This file has no selectable text - a photographed receipt has to be typed in.",
          variant: "destructive",
        });
        return;
      }
      const res = await api<{ fields: Fields }>(`/expenses/${expenseId}:extractReceipt`, {
        method: "POST",
        body: JSON.stringify({ text: clean }),
      });
      setFields(res.fields);
      setDone({});
    } catch (e) {
      toast({ title: "Couldn't read the receipt", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function accept(key: string, value: unknown) {
    const column = PATCHABLE[key];
    if (!column) return;
    try {
      await patch(expensePath.replace(/^\//, ""), { [column]: valueFor(key, value) });
      setDone((d) => ({ ...d, [key]: "accepted" }));
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    }
  }

  const shown = fields ? Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && render(v) !== "") : [];

  return (
    <section className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-muted-foreground" /> Read the receipt
        </h2>
        <AccessAction verb="extractReceipt" collection="expenses" objectPath={expensePath} can={can} label="Read the receipt into the form">
          <Button variant="outline" size="sm" onClick={read} disabled={busy}>
            {busy ? "Reading…" : fields ? "Read again" : "Read receipt"}
          </Button>
        </AccessAction>
      </div>

      {fields && shown.length === 0 && (
        <p className="mt-2 text-sm text-muted-foreground">The receipt did not state any of the fields being looked for.</p>
      )}

      {shown.length > 0 && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Taken from the document. Check each one against the receipt before accepting - nothing is saved until you do.
          </p>
          <ul className="mt-2 space-y-2">
            {shown.map(([key, value]) => {
              const state = done[key];
              const savable = !!PATCHABLE[key];
              return (
                <li key={key} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2.5">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{LABELS[key] ?? key}</p>
                    <p className="whitespace-pre-wrap text-sm">{render(value)}</p>
                    {!savable && <p className="text-xs text-muted-foreground">Pick the matching vendor yourself - this is the name as printed, not a catalogue entry.</p>}
                  </div>
                  {!state && savable && (
                    <span className="flex gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => accept(key, value)}><Check className="h-4 w-4" /> Accept</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDone((d) => ({ ...d, [key]: "dismissed" }))}><X className="h-4 w-4" /> Dismiss</Button>
                    </span>
                  )}
                  {state === "accepted" && <span className="text-sm text-success">Saved</span>}
                  {state === "dismissed" && <span className="text-sm text-muted-foreground">Dismissed</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
