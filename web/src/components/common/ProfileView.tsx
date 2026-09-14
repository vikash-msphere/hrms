import * as React from "react";
import { Copy, Pencil, Plus } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { HoverPanel } from "@/components/common/HoverPanel";
import { FieldAccess } from "@/components/access/FieldAccess";
import { useAccessMode } from "@/components/access/AccessModeProvider";

// Identity header, to the Profile Header design. Three bands inside one card:
//   1. identity  - avatar, name, `status`, the role line, `bio`, `actions`
//   2. facts     - the record as labelled cells (`facts`)
//   3. tabs      - the record's sections (`tabs`), inside the same card rather than floating under it
//
// The design is deliberately NEUTRAL: no per-person accent hue, no gradient rail, no halo, no dot texture.
// Those were three decorative layers competing with the one thing a profile header is for, which is the
// person's name. What remains is hierarchy doing the work - 31px name, a role line, quiet labels.
//
// Colours are TOKENS, not the mock's hex. The mock is a light-mode artboard; this app ships light and dark,
// so every value here resolves through the theme (see web/src/index.css) and the card stays legible in both.
// Sizes, weights, tracking and spacing are the mock's.

// The header's buttons. One weight for every action, labelled, never an unexplained icon.
//
// `coarse:min-h-11` on both: at 13.5px with 9px of padding these are ~32px tall, and the 44px touch floor
// (docs/06-responsive-ui.md rule 1) is applied centrally only to small SQUARE icon controls and Radix rows -
// a bespoke labelled button has to say it itself.
export const HEADER_BTN =
  "inline-flex items-center justify-center gap-[7px] rounded-[10px] border bg-card px-[13px] py-[9px] text-[13.5px] font-semibold leading-none text-muted-foreground shadow-sm transition-colors hover:border-muted-foreground/40 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 coarse:min-h-11";
/** The one filled action per view. */
export const HEADER_BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-[10px] bg-primary px-4 py-[10px] text-[13.5px] font-semibold leading-none text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 coarse:min-h-11";

export function ProfileView({
  name,
  jobTitle,
  department,
  employmentType,
  workMode,
  location,
  bio,
  onEditBio,
  avatar,
  actions,
  status,
  note,
  meta,
  facts,
  factsAction,
  tabs,
  identityRef,
  heading = "h2",
}: {
  name: string;
  jobTitle?: string;
  department?: string;
  /** "Full-time", "Contract"… - already humanized by the caller. */
  employmentType?: string;
  /** "Hybrid", "Remote"… */
  workMode?: string;
  location?: string;
  // Public "about me" one-liner off the employee record; onEditBio adds the edit/add affordance
  // (owner on /profile, HR on the employee page).
  bio?: string;
  onEditBio?: () => void;
  avatar?: React.ReactNode;
  // The action row: labelled buttons, every one of them visible. No overflow menu.
  actions?: React.ReactNode;
  // What the person currently is - on leave, inactive, on probation. Sits next to the name.
  status?: React.ReactNode;
  // A full-width callout under the bio, for something the reader has to know before they write to this
  // person: who is covering while they are away.
  note?: React.ReactNode;
  /**
   * Which heading level the name is. `h2` by default, because on /profile this card sits UNDER the page's
   * own "My Profile" heading. On an employee's page the name IS the page title, and that page has no other
   * heading - so it passes `h1` rather than leaving the page starting at level 2, which is a page a screen
   * reader cannot find the top of.
   */
  heading?: "h1" | "h2";
  // Chips that GO somewhere, beside the role line. A fact with nothing behind it belongs in `facts`.
  meta?: React.ReactNode;
  // The facts band: `<ProfileFact>` cells. Omitted, the band does not render.
  facts?: React.ReactNode;
  // One affordance for the band as a whole (the record's edit pencil), right-aligned.
  factsAction?: React.ReactNode;
  // The record's tab strip, rendered as the card's last band so the sections read as part of the record
  // rather than as a separate control floating underneath it. Pass the `TabsList` with `mb-0 border-b-0`:
  // the card's own bottom edge is the strip's baseline here, so the list must not draw a second one.
  tabs?: React.ReactNode;
  /**
   * Attached to the IDENTITY row - the name and the actions beside it. What a sticky identity bar has to
   * watch: it earns its place the moment the name is gone, not once the whole card including the facts band
   * and the tab strip has left, which on a page that scrolls less than a card's height is never.
   */
  identityRef?: React.Ref<HTMLDivElement>;
}) {
  const seed = name || "?";
  // job title · department · full-time · hybrid · Berlin - one line, dot-separated, in that order: what they
  // do, then where they sit, then the shape of the arrangement. Everything is optional and the line simply
  // closes up, so a record with only a title still reads as a sentence rather than a row of orphan separators.
  const roleParts = [jobTitle, department, employmentType, [workMode, location].filter(Boolean).join(" · ")].filter(Boolean) as string[];
  return (
    <Card className="overflow-hidden rounded-2xl">
      {/* Two blocks that share a line when both fit and stack when they don't - decided by the CONTENT, not
          by a breakpoint, because what has to fit is a name of unknown length beside a button row whose
          width depends on which actions this viewer holds.
          The identity's `flex-[1_1_440px]` is what makes that work: 440px is its hypothetical size when the
          browser decides where to break, so the actions move to their own line rather than squeezing the
          name. (Breaking is settled on those sizes BEFORE any shrinking, so the identity is never compressed
          below 440 while sharing.) `flex-1` alone would be `flex: 1 1 0%` - a zero basis, which never forces
          a break and is exactly how the buttons ended up wedged in beside the face.
          When they do share, the identity's `grow` eats the slack and pushes the actions to the right edge on
          its own; when they wrap, the actions are alone on their line and sit left, under the person. */}
      <div ref={identityRef} className="flex flex-wrap items-start gap-4 p-5 sm:gap-5 sm:px-7 sm:pb-[22px] sm:pt-[26px]">
        <div className="flex min-w-0 flex-[1_1_440px] items-start gap-4 sm:gap-5">
          {/* A rounded SQUARE, not a circle: a square holds more of a face at the same footprint, and it
              sits with the rest of the card's geometry instead of being the one round thing on it. Smaller
              on a phone, where 92px is a quarter of the width and the name has to live beside it. */}
          <div className="shrink-0 overflow-hidden rounded-[14px] shadow-[inset_0_0_0_1px_hsl(var(--border))] sm:rounded-[18px]">
            {avatar ?? (
              <Avatar className="h-[68px] w-[68px] rounded-[14px] sm:h-[92px] sm:w-[92px] sm:rounded-[18px]">
                <AvatarFallback className="rounded-[14px] bg-muted text-2xl font-semibold text-muted-foreground sm:rounded-[18px]">
                  {initials(seed)}
                </AvatarFallback>
              </Avatar>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-[9px]">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              {React.createElement(
                heading,
                // 31px at -0.025em. Tight tracking at display size: at this size the default letter-spacing
                // reads loose and webby. `min-w-0` so the name is what gives way when the row is tight.
                { className: "m-0 min-w-0 truncate text-2xl font-bold leading-[1.1] tracking-[-0.025em] sm:text-[1.9375rem]" },
                name,
              )}
              {status}
            </div>

            {roleParts.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-muted-foreground">
                {roleParts.map((part, i) => (
                  <React.Fragment key={part}>
                    {i > 0 && <Dot />}
                    <span className={cn("min-w-0 truncate", i === 0 && "font-semibold text-foreground")}>{part}</span>
                  </React.Fragment>
                ))}
              </div>
            )}

            <Bio bio={bio} onEdit={onEditBio} />
            {meta}
            {note}
          </div>
        </div>

        {/* `shrink-0` so the group keeps its natural width in the break calculation: a shrinkable one would
            be squeezed onto the line instead of moving off it, which is the whole thing being avoided. */}
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {facts && <FactsBand action={factsAction}>{facts}</FactsBand>}
      {/* No padding under the strip, and the strip itself draws no bottom rule (see the `tabs` prop): the
          CARD'S bottom edge is the tab bar's baseline, so the active tab's underline lands on it. Otherwise a
          tab is separated from the panel it names by three lines in a row - its own border-b, the list's
          margin, then the card closing - and the underline ends up pointing at a border rather than at
          anything the tab owns. */}
      {tabs && <div className="border-t px-4 pt-1 sm:px-7">{tabs}</div>}
    </Card>
  );
}

/** The record itself, as a band of labelled cells. On the card's own ground with a hairline over it - the
 *  band is part of the card, not a panel stuck to the bottom of one. */
function FactsBand({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-t px-5 py-[18px] sm:px-7">
      <div className="flex items-start justify-between gap-3">
        {/* `auto-fit` at a 186px floor: the cells tile to whatever the card is wide, so the same band is four
            across on a desktop and two on a phone without a breakpoint naming either number. */}
        <dl className="grid min-w-0 flex-1 gap-x-[26px] gap-y-5 [grid-template-columns:repeat(auto-fit,minmax(186px,1fr))]">{children}</dl>
        {action && <div className="-mr-1 -mt-1 shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/** One cell of the facts band: a small-caps label over its value, with the field's own manage-access icon.
 *  `field` is set only for the PROTECTED fields (employee_number / department / manager) - the body-field
 *  gate only runs on those, so a field grant anywhere else would be inert and its icon a lie. */
export function ProfileFact({
  label,
  value,
  hoverContent,
  hint,
  field,
  mono,
  copy,
  onClick,
  addLabel,
  onAdd,
}: {
  label: string;
  value?: React.ReactNode;
  /**
   * A panel shown on hover over the value. Its contents may be interactive - it is a Popover, not a tooltip
   * (see HoverPanel). The cell keeps its own `onClick`; the panel offers the finer-grained destinations.
   */
  hoverContent?: React.ReactNode;
  /** A quieter second value on the same line: the tenure beside the joining date, an extension beside a number. */
  hint?: React.ReactNode;
  field?: string;
  mono?: boolean;
  /** Text to put on the clipboard. Turns the value into a button with a COPY hint, per the mock. */
  copy?: string;
  /** Makes the value a link/button (reports-to opens their profile). */
  onClick?: () => void;
  /** Offered in place of an empty value, to a caller who may fill it in. */
  addLabel?: string;
  onAdd?: () => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = React.useState(false);
  // The mock's COPY -> COPIED swap in place, rather than only a toast: the hint sits on the value you just
  // clicked, so the confirmation is where the eye already is.
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const body = (
    <span className="flex min-w-0 items-baseline gap-[7px]">
      <span className={cn("min-w-0 truncate text-[14.5px] font-medium text-foreground", mono && "font-mono")}>{value}</span>
      {hint && <span className="shrink-0 text-[12.5px] text-muted-foreground">{hint}</span>}
    </span>
  );

  // Whatever the value ends up being - a copy button, a link, or plain text - gets wrapped once, so the
  // hover surface is the entire value rather than one element inside it.
  const withHover = (el: React.ReactNode) =>
    hoverContent && value ? <HoverPanel content={hoverContent}>{el}</HoverPanel> : el;

  return (
    <div className="group/fact flex min-w-0 flex-col gap-1.5">
      <dt className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-muted-foreground">
        <span className="truncate">{label}</span>
        <FieldAccess field={field} label={label} />
      </dt>
      <dd className="m-0 min-w-0">
        {withHover(
          value ? (
            copy ? (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    .writeText(copy)
                    .then(() => {
                      setCopied(true);
                      toast({ title: `${label} copied`, variant: "success" });
                    })
                    .catch(() => {});
                }}
                className="flex min-w-0 max-w-full items-baseline gap-[7px] text-left transition-colors hover:text-primary"
              >
                {body}
                <span className="shrink-0 text-[11px] font-bold tracking-wide text-muted-foreground opacity-0 transition-opacity group-hover/fact:opacity-100 focus-visible:opacity-100">
                  {copied ? "COPIED" : "COPY"}
                </span>
                <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/fact:opacity-100 sm:hidden" />
              </button>
            ) : onClick ? (
              <button type="button" onClick={onClick} className="flex min-w-0 max-w-full text-left transition-colors hover:text-primary">
                {body}
              </button>
            ) : (
              body
            )
          ) : onAdd && addLabel ? (
            // The mock's inline "Add ID" - the empty cell offers the fix to whoever can apply it, instead of
            // spending a row on a dash.
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex items-center gap-1.5 text-[14.5px] font-semibold text-primary transition-colors hover:text-primary/80"
            >
              <Plus className="h-3.5 w-3.5" />
              {addLabel}
            </button>
          ) : (
            <span className="text-[14.5px] text-muted-foreground/70">Not on file</span>
          ),
        )}
      </dd>
    </div>
  );
}

/** The public "about me" line, in the identity column under the role it elaborates - not a band of its own
 *  with a heading. One sentence does not need a section announcing it.
 *
 *  Typographically it must not read as a third metadata row: prose leading, a prose measure, and a darker ink
 *  than the muted role line above it. Line breaks the author typed are kept (`whitespace-pre-line`), and it
 *  clamps to two lines with a toggle so a 280-character bio cannot push the facts band off the fold. */
function Bio({ bio, onEdit }: { bio?: string; onEdit?: () => void }) {
  const am = useAccessMode();
  const ref = React.useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [clipped, setClipped] = React.useState(false);
  // Measured, not guessed from length: whether two lines is enough depends on the card's width and on where
  // the author's own line breaks fall. Skipped while expanded, since the clamp is off then and the element
  // would measure as fitting - which would drop the toggle the reader needs to collapse it again.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClipped(el.scrollHeight - el.clientHeight > 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bio, expanded]);

  if (!bio) {
    // Owner-only prompt (the page decides), so an empty bio costs a colleague's profile nothing at all.
    return onEdit ? (
      <button
        type="button"
        onClick={onEdit}
        className="inline-flex items-center gap-1.5 self-start text-[15px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        <span className="border-b border-dashed border-current pb-px">Add a short bio</span>
        <FieldAccess field="bio" label="Bio" />
      </button>
    ) : null;
  }

  // The footer row exists only when it has something to hold: a toggle, an edit pencil, or - in access mode -
  // the field's manage icon, which would otherwise have nowhere to live now the label is gone.
  const footer = clipped || expanded || !!onEdit || am.enabled;
  return (
    // 620px, the mock's measure: the identity column is the full width of a wide page, and one sentence set
    // that wide is the single thing that most reads as unprofessional.
    <div className="group/bio max-w-[620px]">
      <p
        ref={ref}
        className={cn("whitespace-pre-line text-[15px] leading-[1.55] text-muted-foreground", !expanded && "line-clamp-2")}
      >
        {bio}
      </p>
      {footer && (
        <div className="mt-1 flex items-center gap-2">
          {(clipped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs font-semibold text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
          {/* Hover-revealed, like every other secondary icon affordance in the app (CopyEmail, the row
              menus): visible on focus too, so it is reachable without a pointer. */}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit bio"
              title="Edit bio"
              className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/bio:opacity-100"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <FieldAccess field="bio" label="Bio" />
        </div>
      )}
    </div>
  );
}

// Separator for the role line. A dot, not a "·" glyph in the text: it centres on the line regardless of font
// and never gets picked up when the line is copied.
function Dot() {
  return <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />;
}
