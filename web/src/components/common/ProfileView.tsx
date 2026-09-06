import * as React from "react";
import { Mail, Briefcase, Building2, UserCog, Hash, CalendarDays, Pencil, Plus } from "lucide-react";
import { colorFromString, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { FieldAccess } from "@/components/access/FieldAccess";
import { CopyEmail } from "@/components/common/CopyEmail";

// Identity header: no cover art. The avatar sits INSIDE the card next to the name, and the
// person's own colour (the one the avatar fallback already uses) is the only accent - a soft ring
// around the photo. A decorative gradient band read as chrome and pushed the identity itself down
// the card; the name is what this header is for. Shared by the self profile and employee pages.
export function ProfileView({
  name,
  email,
  jobTitle,
  department,
  bio,
  onEditBio,
  avatar,
  actions,
  meta,
  heading = "h2",
}: {
  name: string;
  email?: string;
  jobTitle?: string;
  department?: string;
  // Public "about me" one-liner off the employee record; onEditBio adds the edit/add affordance
  // (owner on /profile, HR on the employee page).
  bio?: string;
  onEditBio?: () => void;
  avatar?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Which heading level the name is. `h2` by default, because on /profile this card sits UNDER the page's
   * own "My Profile" heading. On an employee's page the name IS the page title, and that page has no other
   * heading - so it passes `h1` rather than leaving the page starting at level 2, which is a page a screen
   * reader cannot find the top of.
   */
  heading?: "h1" | "h2";
  // Chip row under the email line (employee ID, reports-to, direct reports…).
  meta?: React.ReactNode;
}) {
  const seed = name || email || "?";
  const accent = colorFromString(seed);
  return (
    <Card className="relative overflow-hidden">
      {/* Three stacked decorative layers, all derived from ONE value - the person's own hue, the same one
          their avatar has always used. Nothing here is a brand surface, so nothing competes with the name:
          a left rail that gives the colour a structural job, a halo behind the avatar, and a dot texture
          that only inks the empty right side of the card. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundImage: `linear-gradient(to bottom, ${colorFromString(seed, 0.85)}, ${colorFromString(seed, 0.18)} 65%, transparent)` }}
      />
      {/* Sized in px, not %, so it stays the same soft halo whatever the card's width is - a % radius
          would stretch into a full-width band on a wide screen, which is what the old cover got wrong. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: `radial-gradient(440px 260px at 52px -24px, ${colorFromString(seed, 0.13)}, transparent 70%)` }}
      />
      {/* currentColor = the card's own foreground, so the texture is ink in light mode and light in dark;
          the mask fades it out before it reaches the name. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.055] dark:opacity-[0.09]"
        style={{
          backgroundImage: "radial-gradient(currentColor 1px, transparent 1.2px)",
          backgroundSize: "14px 14px",
          maskImage: "linear-gradient(to left, black, transparent 58%)",
          WebkitMaskImage: "linear-gradient(to left, black, transparent 58%)",
        }}
      />
      <div className="relative flex flex-wrap items-start gap-x-4 gap-y-4 p-4 pl-5 sm:gap-x-5 sm:p-6 sm:pl-7">
        {/* Double ring: the person's hue as the outer pad, a hairline highlight inside it, so a photo
            reads as seated in the card rather than pasted onto it. */}
        <div
          className="shrink-0 rounded-full p-[3px] shadow-[0_1px_3px_rgba(7,19,38,0.12)] ring-1 ring-inset ring-white/50 dark:ring-white/10"
          style={{ backgroundColor: colorFromString(seed, 0.18) }}
        >
          {avatar ?? (
            <Avatar className="h-16 w-16 sm:h-[72px] sm:w-[72px]">
              <AvatarFallback className="text-xl font-semibold text-white" style={{ backgroundColor: accent }}>
                {initials(seed)}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {React.createElement(
            heading,
            // Tight tracking at display size: at 26px the default letter-spacing reads loose and webby.
            { className: "truncate text-xl font-semibold leading-tight tracking-[-0.015em] sm:text-[1.625rem]" },
            name || email,
          )}
          {/* One line of identity facts, dot-separated, rather than a title line plus an email line: the
              header then costs two lines instead of three and the chips sit closer to the name. */}
          {(jobTitle || department || (email && name)) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
              {jobTitle && <span className="font-medium text-foreground/85">{jobTitle}</span>}
              {jobTitle && department && <Dot />}
              {department && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{department}</span>
                </span>
              )}
              {(jobTitle || department) && email && name && <Dot />}
              {email && name && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <CopyEmail email={email} />
                </span>
              )}
            </div>
          )}
          {meta}
        </div>
        {/* `ml-auto` so the action stack hugs the right edge; on a narrow screen it wraps under the
            identity block (full width) and stays right-aligned there. */}
        {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 sm:pl-2">{actions}</div>}
      </div>
      {(bio || onEditBio) && <BioBlock bio={bio} onEdit={onEditBio} />}
    </Card>
  );
}

/** The public "about me" text, as its OWN band under the identity row rather than a sentence wedged
 *  into the column between the avatar and the action stack - which is where it was, and why a bio of
 *  any length shoved the header around. Line breaks the author typed are kept (`whitespace-pre-line`;
 *  the old markup collapsed them into one run-on line), and the band clamps to three lines with a
 *  Show more toggle so a 280-character bio cannot outgrow the header it belongs to. */
function BioBlock({ bio, onEdit }: { bio?: string; onEdit?: () => void }) {
  const ref = React.useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [clipped, setClipped] = React.useState(false);
  // Measured, not guessed from length: whether three lines is enough depends on the card's width and on
  // where the author's own line breaks fall. Skipped while expanded, since the clamp is off then and the
  // element would measure as fitting - which would drop the toggle the reader needs to collapse it again.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClipped(el.scrollHeight - el.clientHeight > 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bio, expanded]);

  return (
    <div className="relative border-t bg-muted/25 px-4 py-3 pl-5 sm:px-6 sm:pl-7">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          About
          <FieldAccess field="bio" label="Bio" />
        </span>
        {bio && onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit bio"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {bio ? (
        <>
          <p
            ref={ref}
            className={`mt-1 max-w-prose whitespace-pre-line text-sm leading-relaxed text-foreground/80 ${expanded ? "" : "line-clamp-3"}`}
          >
            {bio}
          </p>
          {clipped && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={onEdit}
          className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="border-b border-dashed border-current pb-px">Add a short bio</span>
        </button>
      )}
    </div>
  );
}

// Separator for the identity fact line. A dot, not a "·" glyph in the text: it centres on the line
// regardless of font and never gets picked up when the line is copied.
function Dot() {
  return <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />;
}

// The contact/org detail rows, shown in the Profile tab.
export function ProfileDetails({
  employeeNumber,
  email,
  jobTitle,
  department,
  manager,
  joined,
}: {
  employeeNumber?: string;
  email?: string;
  jobTitle?: string;
  department?: string;
  manager?: string;
  joined?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {/* Only protected fields (employee_number/department/manager) get FIELD-scope management; the rest manage
          at object scope (the body-field gate only runs on protected fields, so a field grant elsewhere is inert). */}
      <Detail icon={Hash} label="Employee ID" value={employeeNumber} field="employee_number" mono />
      <Detail icon={Mail} label="Work email" value={email ? <CopyEmail email={email} /> : undefined} />
      <Detail icon={Briefcase} label="Job title" value={jobTitle} />
      <Detail icon={Building2} label="Department" value={department} field="department" />
      <Detail icon={UserCog} label="Manager" value={manager} field="manager" />
      {joined !== undefined && <Detail icon={CalendarDays} label="Joined" value={joined} />}
    </div>
  );
}

function Detail({ icon: Icon, label, value, field, mono }: { icon: typeof Mail; label: string; value?: React.ReactNode; field?: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          <FieldAccess field={field} label={label} />
        </p>
        <p className={`truncate text-sm font-medium ${mono ? "font-mono" : ""}`}>{value || "-"}</p>
      </div>
    </div>
  );
}
