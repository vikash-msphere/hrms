import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Award, BarChart3, CalendarClock, GripVertical, Megaphone, MessageSquare, Plus, RotateCcw, Smile, X } from "lucide-react";
import { create, invoke, patch } from "@/api";
import { cn, idOf } from "@/lib/utils";
import type { Announcement, Department, Employee, RecipientLayout, StickerLayout } from "@/types";
import { type BodyValign, DEFAULT_VALIGN, DEFAULT_WRAP, KUDOS_RECIPIENT_LAYOUT, KUDOS_STICKER_LAYOUT, POST_STICKER_LAYOUT, withWrap } from "@/components/common/CardSticker";
import { WrapPicker } from "@/components/common/WrapSelect";
import { FoldSection } from "@/components/common/FoldSection";
import { CategoryIcon } from "@/lib/categoryIcons";
import { CARD_WIDTH, kudosTier } from "@/lib/boardCard";
import { kudosArtFiles, kudosArtLabel, kudosArtUrl, kudosCardArtUrl, KUDOS_ART_FILES } from "@/lib/kudosArt";
import type { KudosCategory, KudosLevel } from "@/lib/kudosLevels";
import { illustrationPath, loadIllustrationIndex, suggestIllustrations, type IllustrationMeta } from "@/lib/illustrations";
import { Field, FieldRow } from "@/components/common/Field";
import { StickerField } from "@/components/common/StickerField";
import { RichTextToolbar } from "@/components/common/RichTextToolbar";
import { PostCardBody } from "@/components/common/PostCardBody";
import { PollBlock } from "@/components/common/PollBlock";
import { KudosCardBody } from "@/components/common/KudosCardBody";
import { ActivitySection } from "@/components/common/ActivitySection";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { useMentions } from "@/components/common/MentionPicker";
import { useConfirm } from "@/components/common/confirm";
import { useMedia } from "@/hooks/useMedia";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// The board composer: one dialog for every kind of thing that lands on the feed - an announcement, a post, a poll
// and a kudos.
//
// Wide, it is two columns split by what a control touches. Left is the post: what kind of thing this is, what it
// says, and - for the kinds that have one - when it goes out. Right is the card: the card itself, and the
// controls that act on it as an object (the picture, its placement, where a kudos recipient sits). Controls that
// act on the TEXT - title alignment, how the words ride in the card - stay inline with the words they affect, on
// the left. Narrow, there is no second column and the card and its controls fold in at the bottom of the one.
//
// The card in that column is the same component the feed renders (PostCardBody / KudosCardBody / PollBlock), so
// it cannot drift from the real thing, and it is sticky: the picture is placed by dragging it ON the card.
//
// Stickers are suggested, not hunted for. As the author types, their words are matched against the bundled
// illustration catalogue (suggestIllustrations) and the best half-dozen sit under the message as one-click tiles;
// a kudos offers its category's stickers first instead, since HR curated those for exactly this - and picking a
// category puts one of them on the card straight away. "Browse" behind the tiles opens the full 1700-item picker
// for anyone who wants to choose properly. Every kind can also have no picture at all.
//
// Nothing typed here is lost by accident: the form is mirrored to localStorage as it is written, closing a dirty
// composer asks first, and a draft that outlived its dialog (a refresh, a crash, a Discard regretted a second
// later is not offered - that one is deliberate) is offered back on the next open.

export type Kind = "announcement" | "post" | "poll" | "kudos";

// The preview renders the card at the width it really has on the board (CARD_WIDTH) and scales the whole thing
// down to fit its column. Laying it out at column width instead would show the author a card of different
// PROPORTIONS from the one they are about to post - text wrapping at the wrong point, a sticker covering a
// different share of the card - which is the one thing a preview must not do.
const PREVIEW_WIDTH = CARD_WIDTH;
// Where the composer stops being one column and puts the card beside the fields instead.
const WIDE = "(min-width: 1024px)";
// How the two columns divide the dialog. A board card is CARD_WIDTH (892px) wide and the preview can only shrink
// to fit, so the card column's width IS the preview's size - which is why it takes the larger share of the growth
// rather than an even split: the fields stop getting better past a readable line length, and the card never does.
//
// A proportion with a floor and a ceiling, not a fixed width. Fixed, every pixel added to the dialog would go to
// the fields; a bare percentage would squeeze the card column to nothing on the narrowest screen that still shows
// two columns. The floor is what that screen gives it, the ceiling is where the fields would start to look
// stranded. Between them the card grows with the window - on a large screen it renders at about three quarters of
// its real size, against a little under half before.
const CARD_COLUMN = "w-[clamp(460px,48%,680px)]";

function ScaledPreview({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [{ scale, height }, setBox] = useState({ scale: 1, height: 0 });
  useLayoutEffect(() => {
    const f = frame.current;
    const i = inner.current;
    if (!f || !i) return;
    // The scaled card is out of flow as far as layout is concerned, so the frame is given the scaled height
    // explicitly - otherwise it collapses and the panel can't scroll to the bottom of a long card.
    const measure = () => {
      const s = Math.min(1, f.clientWidth / PREVIEW_WIDTH);
      const h = Math.round(i.offsetHeight * s);
      setBox((cur) => (Math.abs(cur.scale - s) < 0.001 && cur.height === h ? cur : { scale: s, height: h }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(f);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={frame} className="overflow-hidden" style={{ height: height || undefined }}>
      <div ref={inner} className="origin-top-left" style={{ width: PREVIEW_WIDTH, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

// One-liner under the composer's type switcher so the kinds read as choices, not just icons.
const KIND_HINTS: Record<Kind, string> = {
  announcement: "Official company news. Highlighted in the feed, with read receipts.",
  post: "A regular post to everyone on the board.",
  poll: "Ask a question. Results stay hidden until a viewer votes.",
  kudos: "Public recognition for a colleague or a whole team.",
};
const KIND_ICONS = { announcement: Megaphone, post: MessageSquare, poll: BarChart3, kudos: Award };
const TITLE_ALIGN_ICONS = { left: AlignLeft, center: AlignCenter, right: AlignRight };
// What to suggest art for before there is anything to go on: the kind itself. Ordinary words rather than slugs,
// because they are matched against the catalogue like any typed phrase - so nothing here can name a missing file.
const KIND_ART_SEED: Record<Kind, string> = {
  announcement: "announcement news megaphone office notice",
  post: "team idea conversation together workplace",
  poll: "poll survey vote question feedback choice",
  kudos: "celebration award winners high five thank",
};
// Poll deadline presets. A datetime picker is the wrong first ask for "how long should this run?".
const POLL_DURATIONS = [
  { key: "none", label: "No deadline", days: 0 },
  { key: "1d", label: "1 day", days: 1 },
  { key: "3d", label: "3 days", days: 3 },
  { key: "1w", label: "1 week", days: 7 },
] as const;
type PollDuration = (typeof POLL_DURATIONS)[number]["key"] | "custom";

// When a post goes out. Only offered to authors who create through the write gate (the open `post` verb has no
// draft state), and never for a kudos - recognition is sent, not staged.
type Publishing = "now" | "draft" | "schedule";
const PUBLISHING_LABELS: Record<Publishing, string> = { now: "Publish now", draft: "Save as draft", schedule: "Schedule" };

// `<input type="datetime-local">` speaks local wall-clock with no zone, so both directions convert explicitly
// rather than slicing an ISO string (which would silently shift a scheduled post by the UTC offset).
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const localInputNow = () => toLocalInput(new Date().toISOString());
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);
const whenLabel = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

const EMPTY = {
  title: "",
  body: "",
  kind: "announcement" as Kind,
  options: ["", ""] as string[],
  multiple: false,
  closes: "none" as PollDuration,
  closesTime: "",
  recipient: "",
  recipientDept: "",
  kudosTarget: "person" as "person" | "department",
  level: "",
  category: "",
  illustration: "",
  titleAlign: "left" as "left" | "center" | "right",
  bodyValign: DEFAULT_VALIGN as BodyValign,
  publishing: "now" as Publishing,
  publishAt: "", // datetime-local; only read when publishing === "schedule"
  layout: null as StickerLayout | null,
  recipientAt: null as RecipientLayout | null, // kudos only: the recipient block, once dragged off its column // null = the card's own default placement, until the author moves it
};
type Form = typeof EMPTY;

// ---- Draft rescue ----------------------------------------------------------------------------------------
// The composer holds real writing, and a modal is one stray click from gone. Every keystroke past the seed is
// mirrored to localStorage under the row being edited (or "new"), and offered back - never silently restored -
// the next time that same composer opens. Cleared on a successful post and on an explicit discard, because a
// draft that outlives the thing it became is just a trap.
const draftKey = (editing: Announcement | null) => `board:composer:${editing ? idOf(editing.path) : "new"}`;
type StoredDraft = { at: number; form: Form };

function loadDraft(key: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed || typeof parsed.at !== "number" || !parsed.form) return null;
    // Laid over a blank form, never used as one. What comes back is whatever this browser wrote the last time
    // this composer was open, which may predate a field the dialog now reads - and a form missing `options` is
    // not a stale draft, it is a crash on the next render.
    return { at: parsed.at, form: { ...EMPTY, ...parsed.form } };
  } catch {
    return null;
  }
}
function saveDraft(key: string, form: Form) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), form } satisfies StoredDraft));
  } catch {
    /* private mode / quota - the in-memory form is unaffected */
  }
}
function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
const sameForm = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);
function agoLabel(at: number): string {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function PostComposer({
  open,
  onOpenChange,
  editing,
  initialKind,
  employees,
  departments,
  levels,
  kudosCategories,
  canAnnounce,
  canPost,
  canGiveKudos,
  myEmp,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Announcement | null; // null = composing something new
  initialKind: Kind; // what a fresh composer opens on (the caller decides from the grants / the quick action)
  employees: Employee[];
  departments: Department[];
  levels: KudosLevel[];
  kudosCategories: KudosCategory[];
  canAnnounce: boolean;
  canPost: boolean;
  canGiveKudos: boolean;
  myEmp: string; // the caller's own `employees/{id}`, kept out of the kudos recipient list
  onSaved: (saved?: Announcement) => void; // the row that was written, when the call handed one back
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const wide = useMedia(WIDE);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  // Narrow screens only: the card is folded away until asked for. Reset on every open.
  const [showPreview, setShowPreview] = useState(false);
  // The form as it was seeded, so "dirty" means "differs from what was opened" rather than "differs from blank".
  const seedRef = useRef<Form>(EMPTY);
  const [rescued, setRescued] = useState<StoredDraft | null>(null); // an older draft waiting to be taken back

  // What this viewer is allowed to make. Also the switcher's options, so the dialog can only ever open on
  // something it would let you choose - a caller naming a kind the grants don't cover (a quick action, a deep
  // link) gets the nearest thing they can post rather than a switcher with nothing selected and a submit that
  // 403s at the end of a written post.
  const kinds = useMemo(
    () => ([
      canAnnounce && "announcement",
      (canPost || canAnnounce) && "post",
      (canPost || canAnnounce) && "poll",
      canGiveKudos && "kudos",
    ].filter(Boolean) as Kind[]),
    [canAnnounce, canPost, canGiveKudos],
  );

  const isPoll = form.kind === "poll";
  const isKudos = form.kind === "kudos";
  // Whether this composer gets to decide WHEN the post goes out. Only the write-gated create can, and only for a
  // row that hasn't gone out yet: the open `post` verb publishes immediately by design, a kudos is sent rather
  // than staged, and a live post's schedule is history, not a setting.
  const showPublishing = !isKudos && canAnnounce && (editing ? editing.published === false : true);

  const empByPath = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e])), [employees]);
  const empName = (ref?: string) => {
    const e = ref ? empByPath.get(idOf(ref)) : undefined;
    return e ? `${e.first_name} ${e.last_name}` : "Someone";
  };
  const deptName = (ref?: string) => (ref ? departments.find((d) => idOf(d.path) === idOf(ref))?.display_name ?? "A team" : "");

  // Seed the form on every open: an edit from the row (every field the dialog shows, or the editor comes up blank
  // and looks like it is about to erase what is there), a fresh composer from the caller's default kind.
  useEffect(() => {
    if (!open) return;
    setShowPreview(false);
    const seed: Form = !editing
      ? { ...EMPTY, kind: kinds.includes(initialKind) ? initialKind : kinds[0] ?? initialKind, level: levels[0]?.name ?? "" }
      : {
          ...EMPTY,
          title: editing.title,
          body: editing.body,
          kind: (editing.kind ?? "announcement") as Kind,
          recipient: editing.recipient ?? "",
          recipientDept: editing.recipient_department ?? "",
          // Derived from which recipient the row carries, so a team kudo opens on the team tab.
          kudosTarget: editing.recipient_department ? "department" : "person",
          level: editing.level ?? "",
          category: editing.category ?? "",
          illustration: editing.illustration ?? "",
          titleAlign: editing.title_align ?? "left",
          bodyValign: editing.body_valign ?? DEFAULT_VALIGN,
          // A live post has nothing to decide here; a draft opens on what it already is - scheduled for a time,
          // or waiting for someone to press publish.
          publishing: editing.published ? "now" : editing.publish_time ? "schedule" : "draft",
          publishAt: editing.published ? "" : toLocalInput(editing.publish_time),
          // Its deadline, so an edit can move it rather than only being told what it is.
          closes: editing.poll?.closes_time ? "custom" : "none",
          closesTime: toLocalInput(editing.poll?.closes_time),
          layout: editing.illustration_layout ?? null,
          recipientAt: editing.recipient_layout ?? null,
        };
    seedRef.current = seed;
    setForm(seed);
    // Anything mirrored from a previous life of this same composer is offered back, not applied: the author
    // may well have meant to abandon it. Only when it is the same KIND of thing, though - a new composer keys its
    // draft on "new" whatever it is making, so an unfinished announcement would otherwise be offered to someone
    // who opened the dialog to give kudos, and restoring it would turn the dialog into an announcement under
    // them. It keeps until they open on that kind again, which is when it means something.
    const stored = loadDraft(draftKey(editing));
    setRescued(stored && stored.form.kind === seed.kind && !sameForm(stored.form, seed) ? stored : null);
    // Deliberately keyed on the open transition and the row: this is the seed, not a sync, or it would overwrite
    // what the author is typing on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // Mirror the form once it differs from the seed. Debounced, so typing costs one write a beat rather than one
  // a keystroke.
  const dirty = !sameForm(form, seedRef.current);
  useEffect(() => {
    if (!open || !dirty) return;
    const key = draftKey(editing);
    const t = setTimeout(() => saveDraft(key, form), 400);
    return () => clearTimeout(t);
  }, [open, dirty, form, editing]);

  // ---- Sticker suggestions -------------------------------------------------------------------------------
  // The catalogue index (1700 titles) is fetched once per tab and only ever because a composer or a picker
  // opened - see loadIllustrationIndex. Until it lands the tiles show placeholders.
  const [index, setIndex] = useState<IllustrationMeta[] | null>(null);
  useEffect(() => {
    if (!open || index) return;
    let live = true;
    loadIllustrationIndex().then((rows) => live && setIndex(rows), () => {});
    return () => { live = false; };
  }, [open, index]);

  // Matching runs off a settled copy of the text, so it isn't redone on every keystroke and the tiles don't
  // reshuffle under the cursor mid-word.
  const [settledText, setSettledText] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettledText(`${form.title} ${form.body}`), 300);
    return () => clearTimeout(t);
  }, [form.title, form.body]);

  const categoryStickers = useMemo(
    () => kudosArtFiles(kudosCategories.find((c) => c.name === form.category)?.art),
    [kudosCategories, form.category],
  );
  // Picking a category on a fresh kudos puts one of ITS stickers on the card, chosen at random from the set HR
  // curated for it - a giver who picks "Teamwork" has said enough for the card to look right without a second
  // decision. It is a real, stored pick like any other, so it can be swapped or removed from there.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || editing) return;
    if (!isKudos || !form.category) {
      seededFor.current = null;
      return;
    }
    // Once per category, so re-rendering (or typing) never re-rolls the sticker under the giver.
    if (seededFor.current === form.category) return;
    seededFor.current = form.category;
    if (!categoryStickers.length) return;
    const pick = categoryStickers[Math.floor(Math.random() * categoryStickers.length)]!;
    setForm((f) => ({ ...f, illustration: pick }));
  }, [open, editing, isKudos, form.category, categoryStickers]);
  // Art worth offering in the tile row: whatever the author's own words point at, and for a kudos its category's
  // curated stickers first - HR chose those for exactly this.
  const suggestions = useMemo(() => {
    const head = isKudos ? categoryStickers : [];
    if (!index) return head;
    const room = Math.max(0, 4 - head.length);
    const matched = suggestIllustrations(index, settledText, room);
    // Nothing typed yet that names anything - fall back to art for the kind itself, so the row is never empty.
    const rows = matched.length >= room
      ? matched
      : [...matched, ...suggestIllustrations(index, KIND_ART_SEED[form.kind], room - matched.length).filter((m) => !matched.includes(m))];
    return [...head, ...rows.map(illustrationPath)];
  }, [index, settledText, isKudos, categoryStickers, form.kind]);

  const stickerOptions = useMemo(() => KUDOS_ART_FILES.map((f) => ({ value: f, label: kudosArtLabel(f), url: kudosArtUrl(f) })), []);

  // ---- Kudos message prompts ----------------------------------------------------------------------------
  // Example remarks (category `prompts`) cycle through the empty message box to spark what to write. Pool = the
  // picked category's prompts, or every category's when none is picked. The placeholder is only visible while the
  // box is empty, and the rotation stops while the box has the caret - text changing under someone who is about
  // to write is a distraction exactly when they least need one.
  const kudosPrompts = useMemo(() => {
    const cat = kudosCategories.find((c) => c.name === form.category);
    return (cat ? (cat.prompts ?? []) : kudosCategories.flatMap((c) => c.prompts ?? [])).map((p) => p.trim()).filter(Boolean);
  }, [kudosCategories, form.category]);
  const [promptIdx, setPromptIdx] = useState(0);
  const [bodyFocused, setBodyFocused] = useState(false);
  useEffect(() => {
    setPromptIdx(0);
  }, [kudosPrompts]);
  useEffect(() => {
    if (!open || !isKudos || bodyFocused || kudosPrompts.length < 2) return;
    const t = setInterval(() => setPromptIdx((i) => (i + 1) % kudosPrompts.length), 9000);
    return () => clearInterval(t);
  }, [open, isKudos, bodyFocused, kudosPrompts]);
  const kudosPlaceholder = kudosPrompts[promptIdx] ?? "What did they do well?";

  // ---- Poll options -------------------------------------------------------------------------------------
  // Enter in an option input walks to the next one, appending a fresh one at the end - the reason the dialog has
  // no plain Enter-to-submit (Cmd/Ctrl+Enter does that job).
  const optionsRef = useRef<HTMLDivElement>(null);
  function optionEnter(i: number) {
    const focusAt = (j: number) => requestAnimationFrame(() => optionsRef.current?.querySelectorAll("input")[j]?.focus());
    if (i < form.options.length - 1) { focusAt(i + 1); return; }
    if (form.options.length >= 10) return;
    setForm((f) => ({ ...f, options: [...f.options, ""] }));
    focusAt(form.options.length);
  }
  const pollOptions = useMemo(() => form.options.map((o) => o.trim()).filter(Boolean), [form.options]);
  // Two options with the same words are a spoilt ballot: the votes split between them and neither result means
  // anything. Named rather than blocked - trailing whitespace or a near-duplicate is the author's call.
  const duplicateOption = useMemo(() => {
    const seen = new Set<string>();
    for (const o of pollOptions.map((o) => o.toLowerCase())) {
      if (seen.has(o)) return true;
      seen.add(o);
    }
    return false;
  }, [pollOptions]);
  // Drag an option by its grip to reorder. Plain HTML5 drag-and-drop: the list is at most ten short rows, so a
  // drag library would be more machinery than the job needs.
  const dragFrom = useRef<number | null>(null);
  function moveOption(from: number, to: number) {
    if (from === to) return;
    setForm((f) => {
      const next = [...f.options];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row ?? "");
      return { ...f, options: next };
    });
  }

  // ---- Message box --------------------------------------------------------------------------------------
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // `@` mentions in the body: the picker contributes a menu under the box and a key handler for it.
  const mentions = useMentions({
    value: form.body,
    onChange: (next) => setForm((f) => ({ ...f, body: next })),
    textareaRef: bodyRef,
    employees,
  });
  function insertEmoji(emoji: string) {
    const el = bodyRef.current;
    if (!el) {
      setForm((f) => ({ ...f, body: f.body + emoji }));
      return;
    }
    // Cut from the box's own value, not from a copy taken at render: the formatting bar writes to this same text,
    // and splicing the caret's offsets into a string that has moved on since would eat the difference.
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setForm((f) => ({ ...f, body: f.body.slice(0, start) + emoji + f.body.slice(end) }));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // ---- Submit -------------------------------------------------------------------------------------------
  // Why the post can't go yet, in the author's words. A disabled button that won't say what it wants is the
  // form equivalent of a shrug, so the reason is computed once and shown beside it.
  const blockedReason: string | null = (() => {
    if (editing) {
      // A kudos has no title - the server stores "" and the message lives in `body` - so requiring one here would
      // leave Save permanently disabled on every kudos edit. Judge each kind by the field it actually has.
      if (editing.kind === "kudos") return form.body.trim() ? null : "Write a message.";
      if (!form.title.trim()) return editing.kind === "poll" ? "Ask a question." : "Add a title.";
      if (editing.kind !== "poll" && !form.body.trim()) return "Write something in the body.";
    } else if (isKudos) {
      if (form.kudosTarget === "department" ? !form.recipientDept : !form.recipient) return "Pick who this is for.";
      if (!form.body.trim()) return "Write a message.";
    } else if (isPoll) {
      if (!form.title.trim()) return "Ask a question.";
      if (pollOptions.length < 2) return "Add at least two options.";
    } else {
      if (!form.title.trim()) return "Add a title.";
      if (!form.body.trim()) return "Write something in the body.";
    }
    // "Pick a date" with no date is an unfinished choice, not "no deadline": posting it would quietly give the
    // poll no closing time at all, which is the one thing the author just said they didn't want.
    if (isPoll && form.closes === "custom" && !form.closesTime) return "Pick when voting closes.";
    if (showPublishing && form.publishing === "schedule" && !form.publishAt) return "Pick when it should go out.";
    return null;
  })();
  const canSubmit = !blockedReason;

  function pollClosesIso(): string | undefined {
    if (form.closes === "none") return undefined;
    if (form.closes === "custom") return fromLocalInput(form.closesTime);
    const days = POLL_DURATIONS.find((d) => d.key === form.closes)?.days ?? 0;
    return days ? new Date(Date.now() + days * 86400000).toISOString() : undefined;
  }

  async function submit() {
    if (!canSubmit || busy) return;
    const title = form.title.trim();
    const body = form.body.trim();
    const illustration = form.illustration || null;
    // A placement is only worth storing when the card actually shows something, and only when the author put it
    // somewhere: a card with no placement of its own renders the default its kind is built around (for the kudos
    // wall, art column left, remark centre, recipient right).
    const illustration_layout = artUrl ? form.layout : null;
    const recipient_layout = form.recipientAt;
    // Only ever sent for kinds that have a heading - a kudos has none, and the verb rejects the field.
    const title_align = form.titleAlign === "left" ? null : form.titleAlign;
    // Centred is the default the card falls back to, so it travels as null rather than as a value to store -
    // and "top" is now a real choice that has to be stored to be had.
    const body_valign = form.bodyValign === DEFAULT_VALIGN ? null : form.bodyValign;
    // When it goes out. `undefined` everywhere the control isn't offered, so those callers post exactly the
    // payload they always did.
    const scheduleIso = showPublishing && form.publishing === "schedule" ? fromLocalInput(form.publishAt) : undefined;
    const asDraft = showPublishing && form.publishing !== "now";
    setBusy(true);
    try {
      let saved: Announcement | undefined;
      if (!editing && isKudos) {
        // A kudo is a board post (kind="kudos") created via the open recognition-wall verb; it drops a
        // recognition card into the same feed and inherits reactions/replies like any post.
        const target = form.kudosTarget === "department" ? { recipient_department: form.recipientDept } : { recipient: form.recipient };
        saved = await invoke<Announcement>("announcements", "giveKudos", undefined, { ...target, message: body, level: form.level || null, category: form.category || null, illustration, illustration_layout, recipient_layout, body_valign });
        toast({ title: form.kudosTarget === "department" ? "Kudos sent to the team 🎉" : "Kudos sent 🎉", variant: "success" });
      } else if (editing) {
        // A kudos edit covers the message plus the recognition meta (level/category/art); the server re-derives
        // `points` from the level. Other kinds edit title/body/art. Fixed at creation either way: the kind, the
        // recipient, and a poll's options - though a poll's DEADLINE moves, which is how one is closed early or
        // given another week. Null clears, and a card with no art simply has none - art is optional on a kudos
        // exactly as it is on every other kind.
        // `title` is omitted for a kudos: the row's title is "" by design and the write schema requires a non-empty
        // string when the field is present, so sending it would 400 on every kudos save.
        const payload =
          editing.kind === "kudos"
            ? { body, level: form.level || null, category: form.category || null, illustration, illustration_layout, recipient_layout, body_valign }
            : {
                title,
                body,
                illustration,
                illustration_layout,
                title_align,
                body_valign,
                ...(editing.kind === "poll" ? { closes_time: pollClosesIso() ?? null } : {}),
                // Only a draft carries a publishing decision; a live post's schedule is history, not a setting.
                ...(showPublishing ? { publish_time: scheduleIso ?? null } : {}),
              };
        saved = await patch<Announcement>("announcements/" + idOf(editing.path), payload, editing.etag);
        // Going live is its own verb (it owns the notification), so "Publish now" on a draft is a save then a
        // publish - and the etag has moved on by then, hence the fresh one off the response.
        if (showPublishing && form.publishing === "now") {
          saved = await invoke<Announcement>("announcements/" + idOf(editing.path), "publish", saved?.etag);
          toast({ title: "Published", variant: "success" });
        } else {
          toast({ title: scheduleIso ? `Scheduled for ${whenLabel(scheduleIso)}` : "Updated", variant: "success" });
        }
      } else if (isPoll) {
        // A poll: options required, body optional. HR uses the write-gated create; anyone else the post gate.
        const payload = { title, body: body || undefined, options: pollOptions, multiple: form.multiple, closes_time: pollClosesIso(), illustration: form.illustration || undefined, illustration_layout: illustration_layout ?? undefined, title_align: title_align ?? undefined, body_valign: body_valign ?? undefined };
        if (canAnnounce) saved = await create<Announcement>("announcements", { ...payload, kind: "poll", ...draftFields(asDraft, scheduleIso) });
        else saved = await invoke<Announcement>("announcements", "post", undefined, payload);
        toast({ title: postedToast("Poll", asDraft, scheduleIso), variant: "success" });
      } else if (canAnnounce) {
        // The write-gated create; HR chooses the kind.
        saved = await create<Announcement>("announcements", { title, body, kind: form.kind, illustration: form.illustration || undefined, illustration_layout: illustration_layout ?? undefined, title_align: title_align ?? undefined, body_valign: body_valign ?? undefined, ...draftFields(asDraft, scheduleIso) });
        toast({ title: postedToast(form.kind === "post" ? "Post" : "Announcement", asDraft, scheduleIso), variant: "success" });
      } else {
        // The board-post gate (anyone granted): always a generic post, authored by the caller.
        saved = await invoke<Announcement>("announcements", "post", undefined, { title, body, illustration: form.illustration || undefined, illustration_layout: illustration_layout ?? undefined, title_align: title_align ?? undefined, body_valign: body_valign ?? undefined });
        toast({ title: "Posted", variant: "success" });
      }
      // It exists on the server now, so the local copy is no longer a rescue - it's a stale duplicate.
      clearDraft(draftKey(editing));
      seedRef.current = form; // nothing to warn about on the way out
      onOpenChange(false);
      onSaved(saved);
    } catch (e) {
      toast({ title: editing ? "Couldn't save" : isKudos ? "Couldn't send kudos" : isPoll ? "Couldn't post poll" : "Couldn't post", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // Closing with unsaved words asks first. The mirrored copy survives either answer except an explicit discard,
  // which is the one case where the author has actually said they don't want it.
  async function requestClose(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (!dirty || busy) {
      onOpenChange(false);
      return;
    }
    const discard = await confirm({
      title: editing ? "Discard your changes?" : "Discard this post?",
      description: "What you've written here will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (!discard) return;
    clearDraft(draftKey(editing));
    onOpenChange(false);
  }

  // ---- Sticker placement --------------------------------------------------------------------------------
  // Dragging the sticker in the preview and the sliders in the sticker field all land here. A sticker always has
  // a placement - the card's default until the author touches it - so there is no mode to turn on.
  const setLayout = (layout: StickerLayout) => setForm((f) => ({ ...f, layout }));
  const setRecipientAt = (recipientAt: RecipientLayout) => setForm((f) => ({ ...f, recipientAt }));

  // ---- Preview ------------------------------------------------------------------------------------------
  // What the placement dials show and edit: the author's own placement, or the point this kind of card starts
  // from. Touching either dial commits it, which is also what moves the art out of a kudos card's default column.
  const layout = form.layout ?? (isKudos ? KUDOS_STICKER_LAYOUT : POST_STICKER_LAYOUT);
  const recipientAt = form.recipientAt ?? KUDOS_RECIPIENT_LAYOUT;
  const previewTier = kudosTier(levels, form.level);
  const previewRecipName = form.kudosTarget === "department" ? deptName(form.recipientDept) : form.recipient ? empName(form.recipient) : "";
  const previewRecipEmp = form.kudosTarget === "person" && form.recipient ? empByPath.get(idOf(form.recipient)) : undefined;
  const artUrl = form.illustration ? kudosCardArtUrl(form.illustration) : "";

  const preview = isKudos ? (
    <Card className={cn("overflow-hidden p-5", previewTier.card)}>
      <KudosCardBody
        recipientName={previewRecipName}
        recipientId={previewRecipEmp ? idOf(form.recipient) : ""}
        recipientPhoto={previewRecipEmp?.photo}
        recipientFirstName={previewRecipEmp?.first_name}
        recipientLastName={previewRecipEmp?.last_name}
        message={form.body}
        artUrl={artUrl}
        stickerLayout={form.layout}
        onStickerLayoutChange={setLayout}
        recipientLayout={form.recipientAt}
        onRecipientLayoutChange={setRecipientAt}
        iconClassName={previewTier.icon}
        bodyValign={form.bodyValign}
        placeholder="Your message will appear here."
      />
    </Card>
  ) : (
    <Card className={cn("overflow-hidden p-5", form.kind === "announcement" && "border-primary/30 bg-primary/[0.025]")}>
      <PostCardBody
        title={form.title}
        titleAlign={form.titleAlign}
        bodyValign={form.bodyValign}
        body={form.body}
        artUrl={artUrl}
        stickerLayout={form.layout}
        onStickerLayoutChange={setLayout}
        titlePlaceholder={isPoll ? "Your question" : "Your title"}
        bodyPlaceholder={isPoll ? "" : "Your message will appear here."}
        // Same as the feed: a poll's question and options flow around the picture rather than boxing it in.
        wrapAll={isPoll}
        below={
          isPoll && (
            <PollBlock
              poll={{
                multiple: form.multiple,
                closed: false,
                total_votes: 0,
                voted: false,
                closes_time: pollClosesIso(),
                options: (pollOptions.length ? pollOptions : ["Option 1", "Option 2"]).map((label, i) => ({ id: String(i), label, votes: 0, voted: false })),
              }}
              canVote={false}
              canManage={false}
              preview
              onVote={() => {}}
              onSetClosed={() => {}}
            />
          )
        }
      />
    </Card>
  );

  // ---- Form ---------------------------------------------------------------------------------------------
  // The message box is a plain textarea holding markdown-lite source, with the formatting bar editing that text
  // (see RichTextToolbar). Keeping it a textarea is the point: paste, undo, spellcheck and IME all keep working,
  // and what is stored is exactly what is shown - the preview renders the same string the card will.
  const messageField = (
    <Field label={isKudos ? "Message" : isPoll ? "Description (optional)" : "Body"}>
      <div>
        <RichTextToolbar
          textareaRef={bodyRef}
          value={form.body}
          onChange={(next) => setForm((f) => ({ ...f, body: next }))}
          valign={form.bodyValign}
          onValignChange={(v) => setForm((f) => ({ ...f, bodyValign: v }))}
        />
        <div className="relative">
          <Textarea
            ref={bodyRef}
            rows={isPoll ? 3 : isKudos ? 6 : 5}
            value={form.body}
            onChange={(e) => { setForm((f) => ({ ...f, body: e.target.value })); mentions.sync(); }}
            onKeyDown={mentions.onKeyDown}
            onKeyUp={mentions.sync}
            onClick={mentions.sync}
            onFocus={() => setBodyFocused(true)}
            onBlur={() => setBodyFocused(false)}
            placeholder={isKudos ? kudosPlaceholder : isPoll ? "Add context for the poll…" : "What's on your mind?"}
            className="rounded-t-none pr-10"
            autoFocus={isKudos && !!editing}
          />
          <EmojiPicker onPick={insertEmoji} align="end">
            <button type="button" aria-label="Insert emoji" className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-accent">
              <Smile className="h-4 w-4" />
            </button>
          </EmojiPicker>
          {/* Typing `@` offers the directory; picking someone writes the mention token (see MentionPicker). */}
          {mentions.menu}
        </div>
      </div>
    </Field>
  );

  // Both the art and the recipient are dragged where they stand - the handles appear on the card when it is
  // hovered - so the only control left here is how the words treat it. One control, so it is one row: a heading
  // with the menu on it, rather than a disclosure whose whole contents is a single menu. Reset appears once the
  // block has been moved off the card's own placement, which is the only time there is anything to go back to.
  const recipientControl = isKudos && (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-sm font-medium">Recipient</span>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <WrapPicker value={recipientAt.wrap ?? DEFAULT_WRAP} onChange={(w) => setRecipientAt(withWrap(recipientAt, w))} />
        {form.recipientAt && (
          <button type="button" onClick={() => setForm((f) => ({ ...f, recipientAt: null }))} className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Reset
          </button>
        )}
      </div>
    </div>
  );

  const stickerField = (
    <StickerField
      // In the card column it is the inspector for what is right above it, so it starts open and stacks its
      // tiles above the dials (it is one column of a dialog, however wide the viewport is).
      narrow={wide}
      defaultOpen={wide}
      value={form.illustration}
      onChange={(v) => {
        setForm((f) => ({ ...f, illustration: v }));
        // Nothing to place while the card is folded away, so picking art brings the preview out. On a wide
        // screen the card is already beside the form and there is nothing to unfold.
        if (v && !wide) setShowPreview(true);
      }}
      artUrl={artUrl}
      layout={layout}
      onLayoutChange={setLayout}
      suggestions={suggestions}
      onResetLayout={form.layout ? () => setForm((f) => ({ ...f, layout: null })) : undefined}
      loading={!index}
      label={isKudos ? "Card art" : "Sticker"}
      pickerTitle={isKudos ? "Choose kudos card art" : "Choose a sticker"}
      emptyHint={
        isKudos
          ? "Optional. Picking a category suggests one; remove it if the card reads better without."
          : "Optional. Sits behind your words - pick one and place it where you like."
      }
      pinned={isKudos ? stickerOptions : undefined}
      pinnedLabel="Kudos stickers"
      pinnedHint="the set your cards already use"
    />
  );

  const title = editing
    ? editing.kind === "kudos" ? "Edit kudos" : editing.kind === "poll" ? "Edit poll" : editing.kind === "post" ? "Edit post" : editing.published === false ? "Edit draft" : "Edit announcement"
    : isKudos ? "Give kudos" : form.kind === "announcement" ? "New announcement" : isPoll ? "New poll" : "New post";
  const submitLabel = editing
    ? showPublishing && form.publishing === "now" ? "Publish" : showPublishing && form.publishing === "schedule" ? "Schedule" : "Save changes"
    : form.publishing === "draft" && showPublishing ? "Save draft"
      : form.publishing === "schedule" && showPublishing ? "Schedule"
        : isKudos ? "Send kudos" : isPoll ? "Post poll" : form.kind === "announcement" && canAnnounce ? "Publish" : "Post";

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className={cn(
          "flex max-h-[90vh] max-w-none flex-col gap-0 overflow-hidden p-0",
          // Wide enough that the card column can reach its ceiling and still leave the fields a comfortable
          // measure; 96vw so it never touches the edges of the screen it is on.
          wide ? "w-[min(96vw,1440px)]" : "w-[min(96vw,780px)]",
        )}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter posts from anywhere in the dialog - plain Enter belongs to the poll options.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        {/* Header and footer stay put; only the fields (and, beside them, the card) scroll. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-b px-6 py-4 pr-12">
            <DialogTitle>{title}</DialogTitle>
            {!editing && <p className="text-sm text-muted-foreground">{KIND_HINTS[form.kind]}</p>}
          </DialogHeader>

          <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {/* Something was written here before and never posted. Offered, never applied - the author may well
                have meant to abandon it. */}
            {rescued && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                <RotateCcw className="h-4 w-4 shrink-0 text-primary" />
                <span>Unsaved draft from {agoLabel(rescued.at)}.</span>
                <div className="ml-auto flex gap-3 text-xs font-medium">
                  <button type="button" className="text-primary underline underline-offset-2" onClick={() => { setForm(rescued.form); setRescued(null); }}>
                    Restore
                  </button>
                  <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => { clearDraft(draftKey(editing)); setRescued(null); }}>
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/* The kind is fixed once posted (it decides the card, the audience and the gate it went through), so
                the switcher is only offered while composing. A radiogroup, not tabs: it picks what is being
                written, and it has no panel of its own to own. */}
            {!editing && kinds.length > 1 && (
              <div
                className="grid gap-1 rounded-xl bg-muted p-1"
                style={{ gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))` }}
                role="radiogroup"
                aria-label="Post type"
                onKeyDown={(e) => {
                  // Arrow keys walk the group, as a radiogroup must.
                  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                  if (!step) return;
                  e.preventDefault();
                  const at = kinds.indexOf(form.kind);
                  const next = kinds[(at + step + kinds.length) % kinds.length]!;
                  setForm((f) => ({ ...f, kind: next, level: next === "kudos" ? f.level || levels[0]?.name || "" : f.level }));
                  requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-kind="${next}"]`))?.focus());
                }}
              >
                {kinds.map((k) => {
                  const Icon = KIND_ICONS[k];
                  const on = form.kind === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      data-kind={k}
                      aria-checked={on}
                      tabIndex={on ? 0 : -1}
                      title={KIND_HINTS[k]}
                      onClick={() => setForm((f) => ({ ...f, kind: k, level: k === "kudos" ? f.level || levels[0]?.name || "" : f.level }))}
                      className={cn(
                        "flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-sm font-medium capitalize transition-colors",
                        on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {/* Four words in four columns don't fit a phone; the icons carry it there. */}
                      <span className="hidden sm:inline">{k}</span>
                      <span className="sr-only sm:hidden">{k}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {isKudos && (
              <>
                {/* Who was recognized is fixed once posted: the card is on the wall and the recipient has been
                    notified, so redirecting it would be a new kudo, not an edit. The server ignores a recipient on
                    PATCH, so an edit states it on one line instead of offering pickers that would quietly do nothing. */}
                {editing ? (
                  <p className="text-sm">
                    <span className="text-muted-foreground">To</span>{" "}
                    <span className="font-medium">{form.recipientDept ? deptName(form.recipientDept) : form.recipient ? empName(form.recipient) : "-"}</span>
                  </p>
                ) : (
                  <Field label="To">
                    <>
                      <div className="mb-2 flex gap-2">
                        <Button type="button" size="sm" variant={form.kudosTarget === "person" ? "default" : "outline"} onClick={() => setForm({ ...form, kudosTarget: "person" })}>A colleague</Button>
                        <Button type="button" size="sm" variant={form.kudosTarget === "department" ? "default" : "outline"} onClick={() => setForm({ ...form, kudosTarget: "department" })}>A whole team</Button>
                      </div>
                      {form.kudosTarget === "department" ? (
                        <Select value={form.recipientDept || undefined} onValueChange={(v) => setForm({ ...form, recipientDept: v })}>
                          <SelectTrigger><SelectValue placeholder="Select a department…" /></SelectTrigger>
                          <SelectContent>
                            {departments.filter((d) => !d.disabled).map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Combobox
                          value={form.recipient}
                          onValueChange={(v) => setForm({ ...form, recipient: v })}
                          placeholder="Select a colleague…"
                          searchPlaceholder="Search colleagues…"
                          // The first decision a kudos asks for, so the dialog opens on it rather than nowhere.
                          autoFocus
                          options={employees.filter((e) => !e.disabled && `employees/${idOf(e.path)}` !== myEmp).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
                        />
                      )}
                    </>
                  </Field>
                )}
                {/* Level and category share a row; the message then gets the full width and the most height, since
                    the words are the kudos. */}
                <FieldRow>
                  {levels.length > 0 && (
                    <Field label="Level">
                      <Select value={form.level || "none"} onValueChange={(v) => setForm({ ...form, level: v === "none" ? "" : v })}>
                        <SelectTrigger><SelectValue placeholder="Pick a level…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {levels.map((l) => <SelectItem key={l.name} value={l.name}>{l.name} · {l.points} pt{l.points === 1 ? "" : "s"}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                  {kudosCategories.length > 0 && (
                    <Field label="Category">
                      <Select value={form.category || "none"} onValueChange={(v) => setForm({ ...form, category: v === "none" ? "" : v })}>
                        <SelectTrigger><SelectValue placeholder="Pick a category…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {kudosCategories.map((c) => (
                            <SelectItem key={c.name} value={c.name}>
                              <span className="flex items-center gap-2"><CategoryIcon name={c.icon} className="h-3.5 w-3.5" /> {c.name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </FieldRow>
              </>
            )}

            {!isKudos && (
              <Field label={isPoll ? "Question" : "Title"}>
                {/* The heading is its own field, so it gets its own alignment control rather than the body's
                    attribute line. Three options: a one-line heading has nothing to justify. */}
                <div className="flex items-center gap-2">
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={isPoll ? "What do you want to ask?" : "Say it in a line"} autoFocus />
                  <div className="flex shrink-0 gap-0.5 rounded-md border bg-muted/40 p-0.5">
                    {(["left", "center", "right"] as const).map((a) => {
                      const Icon = TITLE_ALIGN_ICONS[a];
                      const on = form.titleAlign === a;
                      return (
                        <button
                          key={a}
                          type="button"
                          aria-label={`Align title ${a}`}
                          aria-pressed={on}
                          onClick={() => setForm((f) => ({ ...f, titleAlign: a }))}
                          className={cn("flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground", on && "bg-background text-foreground shadow-sm")}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Field>
            )}

            {messageField}

            {/* Options are fixed at creation - votes are already attached to them - so an edit shows them
                without offering to rewrite them, rather than hiding the poll from its own editor. */}
            {isPoll && !editing && (
              <Field label="Options" hint="Enter adds the next one. Drag to reorder." error={duplicateOption ? "Two options say the same thing - the votes for them will split." : undefined}>
                <div ref={optionsRef} className="space-y-2">
                  {form.options.map((opt, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2"
                      onDragOver={(e) => { if (dragFrom.current !== null) e.preventDefault(); }}
                      onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null) moveOption(dragFrom.current, i); dragFrom.current = null; }}
                    >
                      <span
                        draggable
                        onDragStart={() => { dragFrom.current = i; }}
                        onDragEnd={() => { dragFrom.current = null; }}
                        aria-hidden
                        title="Drag to reorder"
                        className="cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      <Input
                        value={opt}
                        onChange={(e) => setForm((f) => ({ ...f, options: f.options.map((o, j) => (j === i ? e.target.value : o)) }))}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); optionEnter(i); } }}
                        placeholder={`Option ${i + 1}`}
                      />
                      {form.options.length > 2 && (
                        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => setForm((f) => ({ ...f, options: f.options.filter((_, j) => j !== i) }))} aria-label="Remove option">
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {form.options.length < 10 && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, options: [...f.options, ""] }))}><Plus className="h-4 w-4" /> Add option</Button>
                  )}
                  {/* Inside the field, because it is a rule ABOUT these options - on its own it was a bare row
                      between two labelled fields, belonging to neither. */}
                  <label className="flex items-center gap-2 pt-1 text-sm">
                    <Checkbox checked={form.multiple} onCheckedChange={(v) => setForm((f) => ({ ...f, multiple: v === true }))} />
                    Let voters pick more than one option
                  </label>
                </div>
              </Field>
            )}
            {editing?.kind === "poll" && editing.poll && (
              <Field label="Options" hint="Fixed once posted - votes are already attached to them.">
                <ul className="divide-y rounded-md border text-sm">
                  {editing.poll.options.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 truncate">{o.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{o.votes} vote{o.votes === 1 ? "" : "s"}</span>
                    </li>
                  ))}
                </ul>
              </Field>
            )}

            {/* How long it runs, on the way in and afterwards: this is how a poll is closed early (a time in the
                past) or given another week. */}
            {isPoll && (
              <Field label="Runs for">
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {[...POLL_DURATIONS.map((d) => ({ key: d.key as PollDuration, label: d.label })), { key: "custom" as PollDuration, label: "Pick a date" }].map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, closes: d.key }))}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          form.closes === d.key ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  {form.closes === "custom" && (
                    // A deadline that has already passed posts a poll born closed, so the picker won't offer one.
                    // (An edit may still want exactly that - closing a live poll on the spot - which the
                    // "Close voting now" action below does explicitly.)
                    <Input type="datetime-local" className="mt-2" min={localInputNow()} value={form.closesTime} onChange={(e) => setForm({ ...form, closesTime: e.target.value })} />
                  )}
                  {editing && !editing.poll?.closed && (
                    <button
                      type="button"
                      className="mt-2 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      onClick={() => setForm((f) => ({ ...f, closes: "custom", closesTime: localInputNow() }))}
                    >
                      Close voting now
                    </button>
                  )}
                </>
              </Field>
            )}

            {/* When it goes out. Only for authors who post through the write gate - the open `post` verb has no
                draft state - and never for a kudos, which is sent, not staged. */}
            {showPublishing && (
              <Field label="Publishing">
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {(["now", "draft", "schedule"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, publishing: p, publishAt: p === "schedule" && !f.publishAt ? localInputNow() : f.publishAt }))}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          form.publishing === p ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {PUBLISHING_LABELS[p]}
                      </button>
                    ))}
                  </div>
                  {form.publishing === "schedule" && (
                    <Input type="datetime-local" className="mt-2" min={localInputNow()} value={form.publishAt} onChange={(e) => setForm({ ...form, publishAt: e.target.value })} />
                  )}
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <CalendarClock className="mt-px h-3.5 w-3.5 shrink-0" />
                    {form.publishing === "now"
                      ? "Goes live immediately and notifies everyone."
                      : form.publishing === "draft"
                        ? "Only people who can post see it until you publish it. Nobody is notified."
                        : "Goes live on its own at that time, and notifies everyone then. Until it does, only people who can post see it."}
                  </p>
                </>
              </Field>
            )}

            {/* On a narrow screen there is no second column, so everything about how the card LOOKS stays here,
                below everything about what it says: the picture, how the recipient sits in it, and the card. */}
            {!wide && (
              <div className="space-y-3 border-t pt-4">
                {stickerField}
                {recipientControl}
                {/* Folded by default: with no room to show it alongside, it is a check before posting rather
                    than something to compose against. No summary - unlike the two above it, this section holds
                    no setting to report. */}
                <FoldSection title="Card preview" open={showPreview} onOpenChange={setShowPreview}>
                  <ScaledPreview>{preview}</ScaledPreview>
                </FoldSection>
              </div>
            )}

            {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          </div>

          {/* Wide screens: the card, and the controls that act ON the card, in a column of their own. The split
              is by what a control touches, not by how important it is - the picture, its placement and the
              recipient block are things you do TO the card and can only judge against it, while alignment
              belongs beside the words it aligns and stays on the left.
              The card is sticky at the top of this column: the sticker is placed by dragging it on the card, so
              the card scrolling away while you reach for a dial is the one thing this layout must not do. */}
          {wide && (
            <aside className={cn(CARD_COLUMN, "shrink-0 overflow-y-auto border-l bg-muted/30 px-5 py-5")}>
              <div className="sticky top-0 z-10 -mx-5 -mt-5 bg-muted/30 px-5 pb-3 pt-5 backdrop-blur">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">On the board</p>
                <ScaledPreview>{preview}</ScaledPreview>
                {artUrl && <p className="mt-2 text-xs text-muted-foreground">Drag the picture on the card to move it, or its corner to resize.</p>}
              </div>
              <div className="space-y-3 border-t pt-4">
                {stickerField}
                {recipientControl}
              </div>
            </aside>
          )}
          </div>

          <div className="flex items-center gap-3 border-t px-6 py-4">
            {/* Why the button won't go, where the button is. A hint when the form is ready, the blocker when it
                isn't - one line either way, so the footer never jumps. */}
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {blockedReason ? (
                <span className="text-destructive">{blockedReason}</span>
              ) : (
                <span className="hidden sm:inline">
                  <kbd className="rounded border px-1 py-0.5 font-sans text-[10px]">⌘</kbd>
                  <kbd className="ml-0.5 rounded border px-1 py-0.5 font-sans text-[10px]">↵</kbd> to {editing ? "save" : "post"}
                </span>
              )}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" onClick={() => requestClose(false)}>Cancel</Button>
              <Button onClick={submit} loading={busy} disabled={!canSubmit}>{submitLabel}</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Fields that turn a create into a draft (and, with a time, into a scheduled post). Nothing at all when the
// author chose "now", so an ordinary post sends exactly the payload it always did.
function draftFields(asDraft: boolean, scheduleIso?: string) {
  return asDraft ? { published: false, ...(scheduleIso ? { publish_time: scheduleIso } : {}) } : {};
}

function postedToast(what: string, asDraft: boolean, scheduleIso?: string): string {
  if (scheduleIso) return `${what} scheduled for ${whenLabel(scheduleIso)}`;
  if (asDraft) return `${what} saved as a draft`;
  return what === "Announcement" ? "Announcement published" : `${what} posted`;
}
