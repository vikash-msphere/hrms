import { createContext, useContext, useMemo, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn, idOf } from "@/lib/utils";
import { describeRestrictions, mergeRestrictions, noticeBands, RESTRICTION_CODES, type LeaveRestrictions } from "../../../../src/domain/leaveRestrictions";
import type { LeaveType } from "@/types";
import { todayStr } from "@/lib/orgDay";
import { Field, FieldRow } from "@/components/common/Field";
import { FoldSection } from "@/components/common/FoldSection";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// The leave-policy editor, shared by the org baseline (Settings -> Leave policy) and one leave type's
// overrides (Leave Types -> edit). One component, because the two edit the SAME blob shape and a second
// implementation would be the place the two screens quietly stop offering the same rules.
//
// THE THREE STATES. In `type` scope every rule is one of:
//   inherit  - the leaf is absent from this type's blob, so the org's baseline applies (the default)
//   set      - this type has its own value
//   no limit - the leaf is present and null, which EXEMPTS this type from the org's rule
// The third is the reason a plain "empty means none" input is not enough: without it a type can never opt out
// of an org-wide rule, only restate it. In `org` scope there is nothing to inherit from, so clearing a field
// just removes the rule and the "no limit" affordance is hidden.

type Blob = Record<string, Record<string, unknown> | unknown> | null;
type Group = Exclude<keyof LeaveRestrictions, "soft_rules">;

/**
 * How a rule control reaches the blob it edits.
 *
 * THROUGH A CONTEXT, AND THE CONTROLS LIVE AT MODULE SCOPE - which is not a style choice. Defined inside the
 * editor, each control was a NEW component type on every render, so React unmounted and remounted the whole
 * panel on every keystroke: the field being typed into lost focus after each character, which made the policy
 * form effectively unusable for anything longer than one digit. Hoisting them out fixes that; the context is
 * what keeps the call sites from having to pass four accessors apiece.
 */
type RuleAccess = {
  scope: "org" | "type";
  /** Does this scope sit under an org baseline? `type` does, `org` has nothing above it. */
  inheriting: boolean;
  /** The stored leaf: `undefined` = never set (inherits), `null` = explicitly exempt, else the value. */
  read: (g: Group, leaf: string) => unknown;
  /** `undefined` removes the leaf (back to inheriting); `null` exempts; anything else sets it. */
  write: (g: Group, leaf: string, v: unknown) => void;
  /** What the org baseline says for this leaf, for the "inherits X" hints. */
  inherited: (g: Group, leaf: string) => unknown;
};
const RuleCtx = createContext<RuleAccess | null>(null);
function useRules(): RuleAccess {
  const ctx = useContext(RuleCtx);
  if (!ctx) throw new Error("a leave-policy control was rendered outside RestrictionsEditor");
  return ctx;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A numeric rule: empty = inherit, a figure = this scope's own, "No limit" = exempt from the org's. */
function NumRule({ g, leaf, label, info, unit, min = 0, max }: { g: Group; leaf: string; label: string; info?: string; unit?: string; min?: number; max?: number }) {
  const { read, write, inherited, inheriting, scope } = useRules();
  const stored = read(g, leaf);
  const org = inherited(g, leaf) as number | null | undefined;
  const off = stored === null;
  const hint = off
    ? "No limit - overrides the org rule"
    : stored === undefined
      ? inheriting && org != null ? `Inherits the org rule: ${org}${unit ? ` ${unit}` : ""}` : "No rule"
      : undefined;
  // `htmlFor` by hand: the control sits in a row beside its "No limit" switch, so Field has no single child
  // to bind its label to and the label would name nothing (see the note in components/common/Field.tsx).
  const id = `rule-${scope}-${g}-${leaf}`;
  return (
    <Field label={label} info={info} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          disabled={off}
          placeholder={off ? "No limit" : org != null ? String(org) : "None"}
          value={stored === undefined || stored === null ? "" : String(stored)}
          onChange={(e) => write(g, leaf, e.target.value.trim() === "" ? undefined : Number(e.target.value))}
        />
        {inheriting && org != null && (
          <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <Checkbox checked={off} onCheckedChange={(v) => write(g, leaf, v === true ? null : undefined)} />
            No limit
          </label>
        )}
      </div>
    </Field>
  );
}

function BoolRule({ g, leaf, label, info }: { g: Group; leaf: string; label: string; info?: string }) {
  const { read, write, inherited, inheriting } = useRules();
  const stored = read(g, leaf) as boolean | null | undefined;
  const org = inherited(g, leaf) as boolean | null | undefined;
  const v = stored === undefined ? "inherit" : stored === null ? "off" : stored ? "yes" : "no";
  return (
    <Field label={label} info={info}>
      <Select
        value={v}
        onValueChange={(next) => write(g, leaf, next === "inherit" ? undefined : next === "off" ? null : next === "yes")}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">{inheriting && org != null ? `Inherit (${org ? "yes" : "no"})` : "No rule"}</SelectItem>
          {/* Only where there is something to be exempt FROM: with no org rule set, "no rule" and "exempt"
              are the same statement and offering both invites the reader to think they differ. */}
          {inheriting && org != null && <SelectItem value="off">No rule for this type</SelectItem>}
          <SelectItem value="yes">Yes</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function EnumRule({ g, leaf, label, info, options, noneLabel = "No rule" }: {
  g: Group; leaf: string; label: string; info?: string; options: { value: string; label: string }[]; noneLabel?: string;
}) {
  const { read, write, inherited, inheriting } = useRules();
  const stored = read(g, leaf) as string | null | undefined;
  const org = inherited(g, leaf) as string | null | undefined;
  return (
    <Field label={label} info={info}>
      <Select
        value={stored === undefined ? "__inherit" : stored === null ? "__none" : stored}
        onValueChange={(next) => write(g, leaf, next === "__inherit" ? undefined : next === "__none" ? null : next)}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit">
            {inheriting && org ? `Inherit (${options.find((o) => o.value === org)?.label ?? org})` : noneLabel}
          </SelectItem>
          {inheriting && org != null && <SelectItem value="__none">{noneLabel} for this type</SelectItem>}
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Arrays and nested shapes are edited behind one switch: off = inherit, on = this is the whole list. */
function OverrideSwitch({ g, leaf, label, empty, children }: { g: Group; leaf: string; label: string; empty: unknown; children: ReactNode }) {
  const { read, write, inherited, inheriting } = useRules();
  const stored = read(g, leaf);
  const on = stored !== undefined && stored !== null;
  const org = inherited(g, leaf);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          {/* Unticking goes back to INHERIT (the leaf is removed), never to null - "exempt" is its own
              affordance beside this one, because the two are different statements. */}
          <Checkbox checked={on} onCheckedChange={(v) => write(g, leaf, v === true ? empty : undefined)} />
          {label}
        </label>
        {!on && stored !== null && (
          <span className="text-xs text-muted-foreground">{inheriting && org ? "Inheriting the org rule" : "No rule"}</span>
        )}
        {on && inheriting && org != null && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => write(g, leaf, null)}>
            Exempt this type
          </button>
        )}
      </div>
      {stored === null && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Exempt - the org rule doesn't apply to this type.
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => write(g, leaf, undefined)}>
            Follow the org rule again
          </button>
        </p>
      )}
      {on && children}
    </div>
  );
}

function DayChips({ g, leaf, values, labels, offset = 0 }: { g: Group; leaf: string; values: number[]; labels: string[]; offset?: number }) {
  const { read, write } = useRules();
  const list = (read(g, leaf) as number[] | null) ?? [];
  const toggle = (n: number) => write(g, leaf, list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b));
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={list.includes(n)}
          onClick={() => toggle(n)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
            list.includes(n) && "border-primary bg-primary/10 text-primary",
          )}
        >
          {labels[n - offset]}
        </button>
      ))}
    </div>
  );
}

export function RestrictionsEditor({
  value,
  onChange,
  baseline,
  leaveTypes = [],
  selfPath,
  scope,
}: {
  value: Blob;
  onChange: (next: Blob) => void;
  /** The org baseline, for the "inherits X" hints. Only meaningful in `type` scope. */
  baseline?: LeaveRestrictions | null;
  leaveTypes?: LeaveType[];
  /** This type's own path, so it can't be listed as incompatible with itself. */
  selfPath?: string;
  scope: "org" | "type";
}) {
  // Memoized so the `effective` merge below doesn't re-run on every keystroke elsewhere in the dialog: a
  // fresh `{}` each render is a new dependency identity each render.
  const blob = useMemo(() => (value ?? {}) as Record<string, Record<string, unknown>>, [value]);
  const inheriting = scope === "type";

  const read = (g: Group, leaf: string): unknown => {
    const group = blob[g];
    return group && typeof group === "object" && leaf in group ? (group as Record<string, unknown>)[leaf] : undefined;
  };
  // `undefined` removes the leaf (and the group once it is empty), which is what makes "inherit" expressible:
  // an absent leaf is not the same fact as a null one.
  const write = (g: Group, leaf: string, v: unknown) => {
    const next: Record<string, Record<string, unknown>> = { ...blob };
    const group = { ...(next[g] ?? {}) };
    if (v === undefined) delete group[leaf];
    else group[leaf] = v;
    if (Object.keys(group).length === 0) delete next[g];
    else next[g] = group;
    onChange(Object.keys(next).length ? next : null);
  };
  const inherited = (g: Group, leaf: string): unknown =>
    baseline ? (baseline[g] as unknown as Record<string, unknown>)[leaf] : undefined;

  // What this type (or the org) will actually enforce - through the SERVER'S OWN merge, not a copy of it here.
  // A second implementation would be the place the sentence under the editor and the rule the server applies
  // quietly stop agreeing, and the whole point of the sentence is that it can be trusted.
  const effective = useMemo(() => mergeRestrictions(baseline ?? {}, blob), [blob, baseline]);

  // Everything the rule controls need, handed down once. The controls themselves live at module scope - see
  // RuleAccess for why that is not optional.
  const ctx: RuleAccess = { scope, inheriting, read, write, inherited };
    // `htmlFor` by hand: the control sits in a row beside its "No limit" switch, so Field has no single child
    // to bind its label to and the label would name nothing (see the note in components/common/Field.tsx).
  const tiers =((read("timing", "advance_notice") as { tiers?: { up_to_days: number; notice_days: number }[] } | null)?.tiers) ?? [];
  const beyond = (read("timing", "advance_notice") as { beyond_notice_days?: number | null } | null)?.beyond_notice_days ?? null;
  const writeNotice = (nextTiers: typeof tiers, nextBeyond: number | null) =>
    write("timing", "advance_notice", { tiers: nextTiers, beyond_notice_days: nextBeyond });
  // Kept in order as they are typed. The evaluator sorts before it reads them either way, so an unsorted list
  // enforces the same policy - but it DISPLAYS as a ladder whose rungs are out of order, and each row's band
  // is stated relative to the row above it, which then reads as nonsense.
  const sortTiers = (list: typeof tiers) => [...list].sort((a, b) => a.up_to_days - b.up_to_days);
  /** The words in front of a band's own input: where it starts, which is where the row above it stopped. */
  const bandPrefix = (b: { moreThan: number | null }, last: boolean) => {
    if (b.moreThan === null) return last ? "Leave of any length" : "Leave of up to";
    const d = `${b.moreThan} day${b.moreThan === 1 ? "" : "s"}`;
    return last ? `Over ${d}` : `Over ${d}, up to`;
  };
  // The rows ARE the bands (domain/leaveRestrictions.ts), last one included - so what the editor shows and
  // what the server enforces are the same reading of the same list.
  const noticeRows = noticeBands({ tiers, beyond_notice_days: beyond });

  const blackouts = (read("timing", "blackouts") as { from: string; to: string; label?: string }[] | null) ?? [];
  const excluded = (read("combinations", "no_combination_with") as string[] | null) ?? [];
  const softRules = (blob.soft_rules as unknown as string[] | undefined) ?? undefined;

  const sentence = describeRestrictions(effective);

  return (
    <RuleCtx.Provider value={ctx}>
    <div className="space-y-3">
      <FoldSection title="Eligibility" summary="Who may take this leave" defaultOpen={false}>
        <FieldRow>
          <NumRule g="eligibility" leaf="min_tenure_days" label="Service required (days)" unit="days" info="No requests until this much service. Measured against the leave's start date, so booking ahead for a date you'll be eligible on still works." />
          <NumRule g="eligibility" leaf="max_occurrences_lifetime" label="Times in total" info="How many separate times this may ever be taken - e.g. maternity twice." />
        </FieldRow>
        <NumRule g="eligibility" leaf="max_lifetime_days" label="Days in total" unit="days" info="Total days of this type over the whole employment." />
      </FoldSection>

      <FoldSection title="Request shape" summary="How long, how it's split">
        <FieldRow>
          <NumRule g="request" leaf="min_days" label="Minimum per request" unit="days" info="Shortest request allowed." />
          <NumRule g="request" leaf="max_days" label="Maximum per request" unit="days" />
        </FieldRow>
        <FieldRow>
          <NumRule g="request" leaf="max_consecutive_days" label="Maximum in a row" unit="days" info="Measured over the whole run: requests separated only by days off count as one stretch, so splitting a block in two doesn't get around it." />
          <NumRule g="request" leaf="backdate_days" label="Back-dating allowed (days)" unit="days" info="How far this type may be filed late. Set it to 0 to forbid back-dating. When set, it replaces the org-wide back-dating toggle for this type." />
        </FieldRow>
        <FieldRow>
          <BoolRule g="request" leaf="half_day_allowed" label="Half days allowed" info="No = this leave runs whole days only." />
          <BoolRule g="request" leaf="must_be_single_block" label="Must be one block" info="Yes = the whole entitlement has to be taken in one unbroken stretch." />
        </FieldRow>
        <FieldRow>
          <BoolRule g="request" leaf="reason_required" label="Reason required" />
          <NumRule g="request" leaf="reason_min_length" label="Minimum reason length" unit="characters" min={1} />
        </FieldRow>
        <NumRule g="request" leaf="document_required_over_days" label="Document required over (days)" unit="days" info="A sick note or similar, required past this many days. Checked when the request is approved - the request has to exist before a file can be attached to it." />
        <OverrideSwitch g="request" leaf="blocked_weekdays" label="Block particular weekdays" empty={[]}>
          <DayChips g="request" leaf="blocked_weekdays" values={[0, 1, 2, 3, 4, 5, 6]} labels={WEEKDAY_LABELS} />
        </OverrideSwitch>
      </FoldSection>

      <FoldSection title="Notice & timing" summary="How far ahead it must be asked for">
        {/* Seeded with one band rather than an empty ladder: a notice rule with no bands says nothing, so the
            server refuses it - and ticking a switch should not produce something that cannot be saved. */}
        <OverrideSwitch g="timing" leaf="advance_notice" label="Advance notice required" empty={{ tiers: [{ up_to_days: 1, notice_days: 1 }], beyond_notice_days: null }}>
          {/* THE LADDER, WRITTEN AS THE BANDS IT ENFORCES. Each row used to be a bare "up to (days)" box, which
              says nothing about where that band STARTS and left "what does a 3-day request need?" for the
              reader to work out. Every row now states its own band ("over 1 day, up to 5 days"), the bands are
              kept in order as they are typed, and the open-ended last one is a row of the table rather than a
              separate field underneath - because a policy that says nothing about long requests is a policy
              that lets them go with no notice at all, and that has to be on screen. */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Longer requests need more warning. Each row covers everything up to its own length, starting where the row above it stopped.
            </p>
            {noticeRows.map((band, i) => {
              const last = band.upTo === null;
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  {/* The band's LOWER bound is text (it is whatever the row above ended at, so it is not this
                      row's to edit) and its upper bound is the input. Printing the whole band label here as
                      well would say the same number twice, once editable and once not. */}
                  <span className="shrink-0 text-muted-foreground">{bandPrefix(band, last)}</span>
                  {!last && (
                    <>
                      <Input
                        type="number"
                        min={0.5}
                        step={0.5}
                        className="h-8 w-20"
                        aria-label={`Band ${i + 1} covers leave up to (days)`}
                        value={String(band.upTo)}
                        onChange={(e) => writeNotice(sortTiers(tiers.map((x, j) => (j === i ? { ...x, up_to_days: Number(e.target.value) } : x))), beyond)}
                      />
                      <span className="text-muted-foreground">days</span>
                    </>
                  )}
                  <span className="text-muted-foreground">needs</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 w-20"
                    placeholder={last ? "none" : "0"}
                    aria-label={last ? "Anything longer needs notice (days)" : `Band ${i + 1} needs notice (days)`}
                    value={band.noticeDays == null ? "" : String(band.noticeDays)}
                    onChange={(e) => {
                      const v = e.target.value.trim() === "" ? null : Number(e.target.value);
                      if (last) writeNotice(tiers, v);
                      else writeNotice(tiers.map((x, j) => (j === i ? { ...x, notice_days: v ?? 0 } : x)), beyond);
                    }}
                  />
                  <span className="text-muted-foreground">days' notice</span>
                  {last ? (
                    band.noticeDays == null && <span className="text-xs text-warning-foreground dark:text-warning">no notice required</span>
                  ) : (
                    <Button type="button" variant="ghost" size="icon" className="ml-auto h-8 w-8" aria-label={`Remove band ${i + 1}`} onClick={() => writeNotice(tiers.filter((_, j) => j !== i), beyond)}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              // A day past the LONGEST band so far, not past whichever happens to be last in the array - a new
              // band that lands in the middle of the ladder is confusing to have to fix.
              onClick={() => writeNotice(sortTiers([...tiers, { up_to_days: Math.max(0, ...tiers.map((t) => t.up_to_days)) + 1, notice_days: 0 }]), beyond)}
            >
              Add a band
            </Button>
          </div>
        </OverrideSwitch>
        <FieldRow>
          <NumRule g="timing" leaf="max_advance_days" label="Booked at most (days) ahead" unit="days" />
          <BoolRule g="timing" leaf="block_adjacent_to_holiday" label="Block next to a holiday" info="Yes = this leave may not touch a public holiday, so it can't be used to extend one." />
        </FieldRow>
        <OverrideSwitch g="timing" leaf="blackouts" label="Closed periods" empty={[]}>
          <div className="space-y-2">
            {blackouts.map((b, i) => (
              <div key={i} className="flex items-end gap-2">
                <Field label={i === 0 ? "From" : ""} className="flex-1">
                  <Input type="date" aria-label={`Closed period ${i + 1} from`} value={b.from} onChange={(e) => write("timing", "blackouts", blackouts.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                </Field>
                <Field label={i === 0 ? "To" : ""} className="flex-1">
                  <Input type="date" aria-label={`Closed period ${i + 1} to`} value={b.to} onChange={(e) => write("timing", "blackouts", blackouts.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                </Field>
                <Field label={i === 0 ? "Label" : ""} className="flex-1">
                  <Input aria-label={`Closed period ${i + 1} label`} value={b.label ?? ""} placeholder="Year-end close" onChange={(e) => write("timing", "blackouts", blackouts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                </Field>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove closed period ${i + 1}`} onClick={() => write("timing", "blackouts", blackouts.filter((_, j) => j !== i))}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {/* Seeded with a real date, not blank: the wire schema requires YYYY-MM-DD on both ends, so a row
                left empty made the whole leave type fail to save with a field error about a date the author
                had not got to yet. */}
            <Button type="button" variant="outline" size="sm" onClick={() => write("timing", "blackouts", [...blackouts, { from: todayStr(), to: todayStr(), label: "" }])}>
              Add a period
            </Button>
          </div>
        </OverrideSwitch>
        <OverrideSwitch g="timing" leaf="blackout_days_of_month" label="Block days of the month" empty={[]}>
          <DayChips g="timing" leaf="blackout_days_of_month" values={Array.from({ length: 31 }, (_, i) => i + 1)} labels={Array.from({ length: 31 }, (_, i) => String(i + 1))} offset={1} />
        </OverrideSwitch>
      </FoldSection>

      <FoldSection title="Quota" summary="How much, how often">
        <FieldRow>
          <NumRule g="quota" leaf="max_days_per_month" label="Days a month" unit="days" />
          <NumRule g="quota" leaf="max_days_per_year" label="Days a year" unit="days" />
        </FieldRow>
        <FieldRow>
          <NumRule g="quota" leaf="max_requests_per_month" label="Requests a month" info="A request counts in the month its start date falls in." />
          <NumRule g="quota" leaf="max_requests_per_year" label="Requests a year" />
        </FieldRow>
        <FieldRow>
          <NumRule g="quota" leaf="min_gap_days" label="Gap between requests (days)" unit="days" info="Working days required between one request of this type and the next." />
          <EnumRule
            g="quota"
            leaf="year_basis"
            label="A year means"
            noneLabel="Calendar year"
            options={[{ value: "calendar", label: "Calendar year" }, { value: "fiscal", label: "Financial year" }, { value: "anniversary", label: "From the joining date" }]}
          />
        </FieldRow>
        <NumRule g="quota" leaf="fiscal_year_start_month" label="Financial year starts in month" min={1} max={12} info="1 = January, 4 = April. Only used when a year means the financial year." />
      </FoldSection>

      <FoldSection title="Combinations" summary="Leave types this can't be taken with">
        <OverrideSwitch g="combinations" leaf="no_combination_with" label="Can't be combined with" empty={[]}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {leaveTypes.filter((t) => t.path !== selfPath).map((t) => {
                const ref = `leave-types/${idOf(t.path)}`;
                const on = excluded.includes(ref);
                return (
                  <button
                    key={t.path}
                    type="button"
                    onClick={() => write("combinations", "no_combination_with", on ? excluded.filter((x) => x !== ref) : [...excluded, ref])}
                    className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent", on && "border-primary bg-primary/10 text-primary")}
                  >
                    {t.display_name}
                  </button>
                );
              })}
            </div>
            <NumRule g="combinations" leaf="gap_days" label="Keep apart by (working days)" unit="days" info="0 = they may not run back to back. Higher = they may not come within that many working days of each other." />
          </div>
        </OverrideSwitch>
      </FoldSection>

      <FoldSection title="Counting" summary="What a day off inside the leave costs">
        <div className="grid gap-3 sm:grid-cols-2">
          <SandwichRule part="weekends" label="Weekends inside the leave" />
          <SandwichRule part="holidays" label="Holidays inside the leave" />
        </div>
        <p className="text-xs text-muted-foreground">
          Charged = the day comes off the balance. "Between the leave" charges days off that fall inside the block; "beside it too" also charges the days off it runs up against.
        </p>
      </FoldSection>

      <FoldSection title="Exit process" summary="What happens while serving notice">
        <FieldRow>
          <EnumRule
            g="exit"
            leaf="during_notice"
            label="While serving notice"
            noneLabel="No rule"
            info="Applies once a notice period is being served, or a last working day is recorded and still ahead."
            // No "Allowed" option: it would mean exactly what "No rule" already means, and two controls that
            // do the same thing is how somebody ends up believing they set something.
            options={[{ value: "blocked", label: "Not allowed" }, { value: "capped", label: "Capped" }]}
          />
          <NumRule g="exit" leaf="notice_cap_days" label="Cap during notice (days)" unit="days" info="Required when the rule above is Capped." />
        </FieldRow>
      </FoldSection>

      <FoldSection title="Joining month" summary="How the month someone joins is credited">
        <JoiningRuleEditor />
      </FoldSection>

      <FoldSection title="Waivers" summary={softRules?.length ? `${softRules.length} rule(s) warn instead of blocking` : "Every rule blocks"}>
        <p className="mb-2 text-xs text-muted-foreground">
          A waived rule doesn't refuse the request. It's filed anyway, carrying the warning, and whoever approves it is shown what was broken.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {RESTRICTION_CODES.map((c) => {
            const list = softRules ?? [];
            const on = list.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => {
                  const next = on ? list.filter((x) => x !== c) : [...list, c];
                  const out = { ...blob } as Record<string, unknown>;
                  if (next.length) out.soft_rules = next;
                  else delete out.soft_rules;
                  onChange(Object.keys(out).length ? (out as Blob) : null);
                }}
                className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent", on && "border-warning bg-warning/10 text-warning-foreground dark:text-warning")}
              >
                {c.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      </FoldSection>

      <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        {sentence.length ? (
          <>
            <span className="font-medium text-foreground">In force:</span> {sentence.join(" · ")}.
          </>
        ) : (
          <>No restrictions{scope === "type" ? " beyond the org policy" : ""}.</>
        )}
      </p>
    </div>
    </RuleCtx.Provider>
  );
}

/** One half of the sandwich rule. Split out because both halves are the same control over a nested object. */
function SandwichRule({ part, label }: { part: "weekends" | "holidays"; label: string }) {
  const { read, write, inherited, inheriting } = useRules();
  const stored = read("counting", "sandwich") as { weekends?: string; holidays?: string } | null | undefined;
  const org = (inherited("counting", "sandwich") as { weekends?: string; holidays?: string } | null | undefined)?.[part];
  const v = stored?.[part];
  return (
    <Field label={label}>
      <Select
        value={v ?? "__inherit"}
        onValueChange={(next) => {
          if (next === "__inherit") {
            const other = part === "weekends" ? stored?.holidays : stored?.weekends;
            // Dropping the last half of the pair drops the rule: a sandwich setting that names neither
            // weekends nor holidays is not a rule, it is an empty object the server would store for nothing.
            write("counting", "sandwich", other ? { ...(stored ?? {}), [part]: "exclude" } : undefined);
            return;
          }
          write("counting", "sandwich", { weekends: "exclude", holidays: "exclude", ...(stored ?? {}), [part]: next });
        }}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit">{inheriting && org && org !== "exclude" ? `Inherit (${org})` : "Not charged"}</SelectItem>
          <SelectItem value="exclude">Not charged</SelectItem>
          <SelectItem value="intervening">Charged between the leave</SelectItem>
          <SelectItem value="flanking">Charged between and beside it</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function JoiningRuleEditor() {
  const { read, write, inherited, inheriting } = useRules();
  const stored = read("accrual", "joining_rule") as { cutoff_day?: number; if_on_or_before?: string; if_after?: string } | null | undefined;
  const org = inherited("accrual", "joining_rule") as { cutoff_day?: number } | null | undefined;
  const on = !!stored;
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={on}
          onCheckedChange={(v) => write("accrual", "joining_rule", v === true ? { cutoff_day: 15, if_on_or_before: "full", if_after: "none" } : undefined)}
        />
        Use a joining-date cutoff
      </label>
      {!on && (
        <p className="text-xs text-muted-foreground">
          {inheriting && org ? `Inheriting the org rule (cutoff on the ${org.cutoff_day}).` : "The joining month is prorated by the days actually worked."}
        </p>
      )}
      {on && (
        <>
          <FieldRow>
            <Field label="Cutoff day of the month" info="1 to 28. A cutoff past the 28th would mean something different in February.">
              <Input type="number" min={1} max={28} value={String(stored?.cutoff_day ?? 15)}
                onChange={(e) => write("accrual", "joining_rule", { ...stored, cutoff_day: Number(e.target.value) })} />
            </Field>
            <Field label="Joined on or before it">
              <Select value={stored?.if_on_or_before ?? "full"} onValueChange={(v) => write("accrual", "joining_rule", { ...stored, if_on_or_before: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Credit the whole month</SelectItem>
                  <SelectItem value="prorate">Prorate it</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          <Field label="Joined after it" info="Not credited also means this leave can't be requested in the joining month - there is nothing to spend.">
            <Select value={stored?.if_after ?? "none"} onValueChange={(v) => write("accrual", "joining_rule", { ...stored, if_after: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not credited at all</SelectItem>
                <SelectItem value="prorate">Prorate it</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}

