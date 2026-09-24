import { useEffect, useState } from "react";
import { Bug, Video, X } from "lucide-react";
import { create } from "@/api";
import { getSetting, invalidateSettings } from "@/lib/settingsStore";
import { useIntent } from "@/lib/intent";
import { captureSessionReplay, reportProblemToSentry } from "@/instrument";
import { onRecordingFinished, startRecording, stopRecording, useRecording } from "@/lib/screenRecording";
import { useToast } from "@/components/ui/use-toast";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { navigate, recordUrl } from "@/router";
import { idOf } from "@/lib/utils";
// Shared with the server (same pattern as Referrals.tsx), so the key this files under and the fallback list
// are each one constant rather than two that drift. The fallback matters as much as the key: the Worker
// accepts category "app" with no settings row in the table, while the SPA read a missing row as "this org has
// no categories" and disabled Send with nothing the user could do about it. An unset setting means "not
// configured yet", not "configured to be empty" - the e2e database has no settings rows at all, and neither
// does any install predating the bootstrap that seeds them.
import { APP_ISSUES_CATEGORY_KEY, DEFAULT_TICKET_CATEGORIES } from "../../../../src/domain/tickets";
import type { Ticket, TicketCategory } from "@/types";

// "Report a problem" - the something-is-broken entry point, next to "Raise a ticket" and "My tickets" in the
// top bar's support menu.
//
// It is a separate flow from raising a ticket for two reasons that a category on the normal form could not
// give it. First, it opens WHERE YOU ARE: the quick action carries no route (see lib/quickActions.ts), so
// reporting a broken screen does not first take that screen away. Second, it attaches the session recording -
// the last minute the SDK is already holding in memory - which turns "it did something weird on the leave
// page" into something support can watch.
//
// What it produces is an ordinary ticket. A bug report needs the same queue, states, notifications and replies
// as any other request, and giving it a collection of its own would have duplicated all of that to no end.
const EMPTY = { subject: "", description: "", category: "" };
// When the current demonstration window ends, as an epoch ms deadline. In sessionStorage because that is where
// the SDK keeps its own replay session, so the two survive (and expire with) the same tab.
const RECORDING_UNTIL = "problem-recording-until";

// The desk a problem report goes to without being asked. Which team fixes the software is the org's routing
// decision, not something the person hitting the bug should have to work out, so this is the "app" category
// that ships as a default (domain/tickets.ts) and only falls back to asking if the org has removed or renamed
// it. A single configured category is likewise no choice at all.
const presetOf = (list: TicketCategory[]): TicketCategory | undefined =>
  list.find((c) => c.key === APP_ISSUES_CATEGORY_KEY) ?? (list.length === 1 ? list[0] : undefined);

export function ReportProblemDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [categories, setCategories] = useState<TicketCategory[]>([]);
  const { toast } = useToast();

  // The replay is kept the moment the dialog OPENS, not when it is sent. What the SDK holds is everything
  // since its last 60-second snapshot (a sawtooth of 0-60s, not a rolling window - see captureSessionReplay),
  // so every second spent reading this dialog and typing into it is a second of the actual fault lost -
  // submit-time capture handed support a recording of someone filling in a form.
  //
  // The flush STOPS the recorder and starts a fresh buffer, so nothing is recorded on from here: reporting a
  // bug is not consent to be recorded for the rest of the afternoon. Continuous recording happens only inside
  // the "Record the problem" window below. The id is held here until there is a ticket to attach it to, and
  // a demonstration recorded in that window (`recordedId`) takes its place.
  const [replayId, setReplayId] = useState<string | undefined>(undefined);
  useIntent("report-problem", () => {
    // Arriving here while a demonstration is running means the person came back: end it and show the form.
    if (recording) return void stopRecording();
    setOpen(true);
    void captureSessionReplay().then(setReplayId);
  });

  // The recording window is shared state (lib/screenRecording.ts), not this dialog's: a window can also be
  // started from a ticket, it outlives whatever opened it, and its countdown belongs in the top bar. Here the
  // dialog only hides while one runs and takes the id when it ends.
  const recordingSession = useRecording();
  const recording = recordingSession?.target.kind === "report";
  // The demonstration, held apart from the run-up above because it is the one the person made on purpose and
  // can see: it shows as an attachment in place of the Record button, and removing it drops back to the
  // run-up rather than to nothing, which is what was attached before they pressed Record. Removing only
  // unlinks it from this report - the replay already uploaded when the window ended.
  const [recordedId, setRecordedId] = useState<string | undefined>(undefined);
  // A window stopped under the SDK's floor keeps nothing. Said beside the button, or pressing Stop early
  // would bring the form back looking exactly as it did before they recorded anything.
  const [tooShort, setTooShort] = useState(false);
  useEffect(() => onRecordingFinished((id, target) => {
    if (target.kind !== "report") return;
    setOpen(true);
    if (id) setRecordedId(id);
    setTooShort(!id);
  }), []);

  // Loaded when the dialog first opens, not on mount: this component is rendered on every page for every user,
  // and most sessions never report a problem. Nothing is fetched until somebody does.
  // The desk is chosen in the SAME update that lands the categories, rather than left to the effect below to
  // notice afterwards: that effect fires on a change to `form.category`, and a state it writes which is never
  // committed on its own (a keystroke in the same batch) is a change it never sees.
  const applyCategories = (list: TicketCategory[]) => {
    setCategories(list);
    const p = presetOf(list);
    if (p) setForm((f) => (f.category ? f : { ...f, category: p.key }));
  };

  useEffect(() => {
    if (!open || categories.length) return;
    getSetting<{ categories?: TicketCategory[] }>("ticket-categories")
      .then((s) => applyCategories(s.value?.categories ?? DEFAULT_TICKET_CATEGORIES.categories))
      .catch(() => applyCategories(DEFAULT_TICKET_CATEGORIES.categories));
  }, [open, categories.length]);

  // Whether the desk was chosen for this reader - which is also what decides whether the picker is offered.
  const preset = presetOf(categories);

  // Drop a category the org no longer has, BEFORE the preset below fills the gap. WriteDialog restores the
  // whole form from a saved draft (`draftKey`), category included, and a draft outlives the configuration it
  // was written against: rename a category, delete one, reseed the database, and the draft still names the old
  // key. The server refuses it - "that ticket category is unavailable" - and the dialog offered no way out of
  // it, because a valid `preset` hides the picker, so there was no control on screen to change the value that
  // was failing. Every attempt failed identically with nothing to click.
  useEffect(() => {
    if (!open || !categories.length) return; // nothing loaded = nothing to validate against
    if (form.category && !categories.some((c) => c.key === form.category)) setForm((f) => ({ ...f, category: "" }));
  }, [open, categories, form.category]);

  useEffect(() => {
    if (open && preset && !form.category) setForm((f) => ({ ...f, category: preset.key }));
  }, [open, preset, form.category]);

  const valid = !!form.subject.trim() && !!form.category;
  // Why Send is disabled, in the order the user can act on it. The last case is not the user's to fix, so it
  // says who can: the server requires a category to route a ticket by, and an org with none configured cannot
  // raise one at all. Without this the button just sits there dead.
  const whyNot = !form.subject.trim()
    ? "Say what went wrong."
    : categories.length === 0
      ? "No support categories are configured yet, so there's nobody to send this to. An admin can add one in Settings → Ticket categories."
      : "Pick who this should reach.";

  // Throws to fail: WriteDialog owns the busy state, pins the reason in the form and keeps what was typed.
  async function submit() {
    // Captured when the dialog opened. The fallback covers the one case that misses: a page open for less
    // than the SDK's 5s floor when the dialog was opened, where there was not yet a replay to keep.
    const session_replay_id = recordedId ?? replayId ?? (await captureSessionReplay());
    let raised: Ticket;
    try {
      raised = await create<Ticket>("tickets", {
        category: form.category,
        subject: form.subject,
        description: form.description,
        ...(session_replay_id ? { session_replay_id } : {}),
      });
    } catch (e) {
      // The categories this dialog is offering are older than the ones the server is enforcing, so the key it
      // just sent does not exist any more. The snapshot behind them can go unrefreshed for a whole day: the
      // change feed vouches for the stored copy when nothing has written to `settings`, and it cannot know the
      // copy belongs to a database that has since been replaced (lib/settingsStore.ts). Left alone this is a
      // dead end - the same failure on every press, with no control on screen to change the value that is
      // failing, because a valid preset hides the picker. So the miss is treated as the cache report it is:
      // drop the snapshot, re-read, and let the user resend against the real list.
      if (/category is unavailable/i.test(String((e as Error)?.message ?? ""))) {
        invalidateSettings();
        const fresh = await getSetting<{ categories?: TicketCategory[] }>("ticket-categories").catch(() => undefined);
        setCategories(fresh?.value?.categories ?? DEFAULT_TICKET_CATEGORIES.categories);
        setForm((f) => ({ ...f, category: "" }));
        throw new Error("The support categories changed since this form opened. It's refreshed now - check who this should reach and send again.");
      }
      throw e;
    }
    // Raise it in the tracker too, now that the ticket exists and can be linked to. After the create, not
    // before: an issue pointing at a ticket that failed to be created would be worse than no issue. The
    // replay is already flushed by this point, so the SDK stamps this event with the same replay id and the
    // issue plays back the minute that led to it.
    const ticketId = idOf(raised.path);
    reportProblemToSentry(form.subject, form.description, { id: ticketId, url: recordUrl("tickets", ticketId) }, session_replay_id);

    setForm(EMPTY);
    setReplayId(undefined);
    setRecordedId(undefined);
    setTooShort(false);
    // Where the person is told a recording went with their report. It used to be a line in the dialog and is
    // said here instead: the dialog is a form, and this lands at the moment it actually happens rather than
    // as standing text above a button. Either branch says what was sent, so the answer is never silence.
    toast({
      title: "Problem reported",
      description: session_replay_id ? "Screen recording attached." : "The recording was too short to include.",
      variant: "success",
      // Reporting from wherever you were means the ticket you just made is somewhere else. This is the way to it.
      action: { label: "View ticket", onClick: () => navigate(`tickets/${ticketId}`) },
    });
  }

  return (
    <WriteDialog
      // Never on screen while a recording runs, whoever started it. Derived rather than left to whichever
      // click handler happened to call setOpen(false): the form covers the app, the whole point of the window
      // is to go and make the fault happen, and "the dialog did not disappear" is what a missed setOpen looks
      // like. A window started from a ticket hides it too, which no handler in this file could have done.
      open={open && !recordingSession}
      onClose={() => setOpen(false)}
      title="Report a problem"
      description="Goes to support as a ticket. You'll get a notification on every reply and when it's fixed."
      collection="tickets"
      guardLabel="problem report"
      form={form}
      draftKey="problem:new"
      applyDraft={(d) => setForm(d)}
      onStartOver={() => { setForm(EMPTY); setRecordedId(undefined); setTooShort(false); }}
      submitLabel="Send report"
      canSubmit={valid}
      whyNot={whyNot}
      onSubmit={submit}
      submitAccess={(b) => <AccessAction collection="tickets" create label="Report a problem">{b}</AccessAction>}
    >
      {/* Functional updates, not `{ ...form, … }`: the category is filled in by an effect the moment the
          org's categories land (`preset`, above), and a keystroke that spreads a render's own `form` snapshot
          overwrites that write with the value the field had before it. React commits the two together, so the
          intermediate state the preset effect wrote is never committed - its `form.category` dep never
          changes, it does not run again, and the category stays empty for good. Which is a dead end and not
          just a lost keystroke: a valid preset HIDES the picker, so Send sits disabled saying "Pick who this
          should reach" with no control on screen to pick with. */}
      <Field label="What went wrong?">
        <Input autoFocus placeholder="The page went blank when I clicked Save" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
      </Field>
      <Field label="What were you doing? (optional)" hint="Anything you remember. The recording below usually covers the steps.">
        <Textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </Field>
      {/* Only when the desk could not be chosen above. Note it still renders with NO categories, where the
          picker is empty: hiding it there left a disabled Send button explaining itself in terms of a control
          that was not on screen - a dead end with nothing to click. */}
      {!preset && (
        <Field
          label="Who should see this?"
          hint={categories.length === 0 ? "No categories are configured yet. Ask an admin to add them in Settings." : "Picks the team that handles it."}
        >
          <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>{categories.map((c) => <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      )}
      {/* Under the fields, not above them: the form is what most people came to fill in, and an action that
          empties the screen sitting above the first input reads as the thing to do first.
          The run-up captured on open is disclosed on the success toast - see submit(). A demonstration the
          person recorded shows here instead, as an attachment in place of the button, with an X to drop it and
          record again. */}
      {recordedId ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pl-3 pr-1 text-sm">
          <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Screen recording attached</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label="Remove recording"
            onClick={() => setRecordedId(undefined)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => { setOpen(false); setTooShort(false); startRecording({ kind: "report" }); }}>
            <Video className="h-4 w-4" /> Record the problem
          </Button>
          {tooShort && <p className="text-xs text-muted-foreground">That recording was too short to keep. Record for at least a few seconds.</p>}
        </div>
      )}
    </WriteDialog>
  );
}

export const ReportProblemIcon = Bug;
