import { useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useAiFeature } from "@/lib/aiFeatures";

// The "Draft" affordance for a long-form field, shared by every page that has one.
//
// It asks for an instruction, calls `<collection>:draft`, and shows what came back. It does NOT save
// anything, and it deliberately does not offer to: the text is a starting point the author edits and then
// saves themselves, through the ordinary form. That is the whole reason a model is allowed to write here.
//
// `existing` is the field's current value. Passing it turns the request into "improve this" rather than
// "write this", which is what people actually want the second time they press the button.
//
// NOTHING IS REPLACED UNTIL SOMEBODY SAYS SO, and that is the fix this component was rewritten for. It used
// to hand the answer straight to `onDraft`, which overwrote the field the moment the model replied. Improving
// was therefore destructive and unrecoverable: three paragraphs you had written were gone, replaced by
// something you had not read yet, and the textarea's native undo could not bring them back because a
// programmatic `setState` does not go on the browser's undo stack. The answer is shown here first, beside
// nothing but a "Use this" button; until that is pressed the field is untouched, so Cancel really does mean
// nothing happened.
//
// ERRORS ARE SHOWN, not swallowed. Unlike the invisible AI features, somebody pressed a button and is waiting
// for text, so "the organisation's budget for today is spent" has to reach them - otherwise they press it
// again, and again.
export function DraftButton({ collection, kind, existing, onDraft, label = "Draft", hint, existingIsContext = false }: {
  collection: string;
  kind: string;
  existing?: string | null;
  onDraft: (text: string) => void;
  label?: string;
  /** One line of example instruction for THIS field, e.g. what the announcement is about. Used as the
   *  placeholder when writing from scratch; improving gets its own, because "say what to change" and "say
   *  what to write" are different questions and one example cannot answer both. */
  hint?: string;
  /**
   * Send `existing` as CONTEXT rather than as the thing being rewritten.
   *
   * The default reading of `existing` is "this is the text you are improving", which drives the whole
   * Draft/Improve split. Some callers want the opposite: suggesting a checklist FROM a task's description is
   * a first draft of a different field, and the description is background the model should read but never
   * rewrite. Without this the button would read "Improve" and the dialog would offer to change a field it is
   * not writing to.
   */
  existingIsContext?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  /** What the model last returned, held here rather than pushed into the field. `null` = nothing asked yet. */
  const [result, setResult] = useState<string | null>(null);
  // Gated HERE rather than at each of the four call sites, so a page that adds a Draft button cannot forget
  // it and ship a button whose only behaviour is to explain that it does not work.
  const enabled = useAiFeature("drafting");

  // Context is not a draft in progress, so it never turns this into an "Improve".
  const improving = !existingIsContext && !!(existing && existing.trim());

  function close() {
    setOpen(false);
    // Cleared on the way out, not on the way in: a dialog that reopens showing the previous answer invites
    // somebody to press "Use this" on a reply to a question they have since changed.
    setInstruction("");
    setResult(null);
  }

  async function run() {
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    try {
      // `api` rather than `invoke`: `invoke` invalidates the collection it addresses, and a draft writes
      // nothing, so going through it would trigger a full list refetch of announcements (or goals, or
      // requisitions) every time somebody pressed this button.
      const res = await api<{ text: string }>(`/${collection}:draft`, {
        method: "POST",
        body: JSON.stringify({ kind, instruction: text, existing: existing ?? null }),
      });
      setResult(res.text);
    } catch (e) {
      toast({ title: "Couldn't draft that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Sparkles className="h-4 w-4" /> {improving ? "Improve" : label}
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{improving ? "Improve this text" : existingIsContext ? label : "Draft this text"}</DialogTitle>
            <DialogDescription>
              {/* Two separate sentences about what leaves the browser, because the old single line said both
                  "the current text is sent" and "only what you type here is sent" in the same breath, which
                  cannot both be true and left the more alarming reading as the plausible one. */}
              {improving
                ? "Say what to change. Your instruction and the text currently in the field are sent."
                : existingIsContext
                  // The third case, and it needs saying: context IS sent. Letting it fall through to "only
                  // your instruction is sent" would be the same false reassurance this copy was rewritten to
                  // remove, just in a new place.
                  ? "Say what you want. Your instruction is sent, along with what you have already written on this item as background."
                  : "Say what you want written. Only your instruction is sent."}
              {" "}No records are read, and nothing is changed until you choose to use the result.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            autoFocus
            rows={3}
            value={instruction}
            placeholder={improving
              ? "e.g. make it shorter and drop the last paragraph"
              : hint ?? "e.g. the office moves to the second floor from Monday, entry is by the side door"}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run(); }}
          />

          {result !== null && (
            <div className="space-y-1">
              <p className="text-sm font-medium">Suggested text</p>
              {/* Shown as plain text in a bounded, scrollable box. Not an editor: editing belongs in the
                  field itself, where the formatting bar and the preview are, and offering a second place to
                  type the same thing is how two versions of a post come to exist. */}
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
                {result}
              </div>
              <p className="text-xs text-muted-foreground">
                {improving
                  ? "Your current text is untouched until you use this."
                  : "You can edit it after it goes into the form."}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            {result === null ? (
              <Button onClick={run} disabled={busy || !instruction.trim()}>
                {busy ? "Writing…" : improving ? "Improve" : existingIsContext ? label : "Draft"}
              </Button>
            ) : (
              <>
                {/* "Try again" keeps the instruction, because the common case after a poor answer is a small
                    edit to the wording rather than starting over. */}
                <Button variant="outline" onClick={run} disabled={busy || !instruction.trim()}>
                  {busy ? "Writing…" : "Try again"}
                </Button>
                <Button onClick={() => { onDraft(result); close(); }} disabled={busy}>Use this</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
