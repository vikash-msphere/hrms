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
// It asks for an instruction, calls `<collection>:draft`, and hands the text back through `onDraft` for the
// page to put in its editor. It does NOT save anything, and it deliberately does not offer to: the text is a
// starting point the author edits and then saves themselves, through the ordinary form. That is the whole
// reason a model is allowed to write here at all.
//
// `existing` is the field's current value. Passing it turns the request into "improve this" rather than
// "write this", which is what people actually want the second time they press the button.
//
// ERRORS ARE SHOWN, not swallowed. Unlike the invisible AI features, somebody pressed a button and is waiting
// for text, so "the organisation's budget for today is spent" has to reach them - otherwise they press it
// again, and again.
export function DraftButton({ collection, kind, existing, onDraft, label = "Draft", hint }: {
  collection: string;
  kind: string;
  existing?: string | null;
  onDraft: (text: string) => void;
  label?: string;
  /** One line under the input saying what this particular field is for, e.g. "what the announcement is about". */
  hint?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  // Gated HERE rather than at each of the four call sites, so a page that adds a Draft button cannot forget
  // it and ship a button whose only behaviour is to explain that it does not work.
  const enabled = useAiFeature("drafting");

  const improving = !!(existing && existing.trim());

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
      onDraft(res.text);
      setOpen(false);
      setInstruction("");
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{improving ? "Improve this text" : "Draft this text"}</DialogTitle>
            <DialogDescription>
              {improving
                ? "Say what to change. The current text is sent along with your instruction."
                : "Say what you want written."}
              {" "}Only what you type here is sent - no records are read. You will be able to edit the result before saving.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            rows={4}
            value={instruction}
            placeholder={hint ?? "e.g. the office moves to the second floor from Monday, entry is by the side door"}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run(); }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={run} disabled={busy || !instruction.trim()}>{busy ? "Writing..." : improving ? "Improve" : "Draft"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
