import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn, idOf } from "@/lib/utils";
import {
  describeRestrictionsByGroup,
  mergeRestrictions,
  noticeBands,
  storedLeaves,
  validateRestrictions,
  RESTRICTION_CODES,
  RESTRICTION_CODE_LEAVES,
  RESTRICTION_LABELS,
  type LeaveRestrictions,
  type RestrictionCode,
} from "../../../../src/domain/leaveRestrictions";
import type { LeaveType } from "@/types";
import { todayStr } from "@/lib/orgDay";
import { Field, FieldRow } from "@/components/common/Field";
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
//
// ONE GRAMMAR FOR THOSE THREE, which is the thing this screen got wrong first time round. A number rule said
// them with an empty box plus a "No limit" tickbox, a yes/no rule with a four-entry dropdown, an enum with two
// sentinel options inside its own list, and a list rule with a tickbox plus an "Exempt this type" link plus a
// "Follow the org rule again" link - four idioms for one idea, and each control changed shape depending on
// whether the org happened to have set that particular leaf. They all now say it the same way: a segmented
// `Org policy | Custom | No limit` in the field's label row (Field's `action` slot, which exists for a control
// that acts on the whole field), and the value control underneath saying only what the value is.
//
// The toggle is NOT rendered where it would have one real option. In `org` scope nothing is inherited, so a
// scalar rule is just its control again and an empty one is no rule - forty two-state toggles that only mirror
// "is the box empty" would be noise on the one screen that has no inheritance at all. The structured rules
// (lists, the notice ladder) keep a toggle in both scopes because they need an explicit on/off either way.

type Blob = Record<string, Record<string, unknown> | unknown> | null;
type Group = Exclude<keyof LeaveRestrictions, "soft_rules">;
/** Which of the three statements a rule is making. In `org` scope "org" reads as "no rule". */
type Source = "org" | "custom" | "off";

/**
 * One rule, as the editor lists it.
 *
 * DECLARED RATHER THAN WRITTEN STRAIGHT INTO A SECTION, because the rules are shown two ways now - by section,
 * and as the results of a search across every section - and a policy rule that exists in one of those views
 * and not the other is a rule nobody can find. One list, two renderings.
 *
 * `wide` is the layout escape: the sections lay their rules out two to a row, and the structured ones (the
 * notice ladder, the closed periods, a chip picker) need the whole width.
 */
type RuleDef = { leaf: string; label: string; node: ReactNode; wide?: boolean };
type SectionDef = { g: Group; caption: string; rules: RuleDef[] };

const GROUPS: Group[] = ["eligibility", "request", "timing", "quota", "combinations", "counting", "exit", "accrual"];
const GROUP_TITLES: Record<Group | "soft_rules", string> = {
  eligibility: "Eligibility",
  request: "Request shape",
  timing: "Notice & timing",
  quota: "Quota",
  combinations: "Combinations",
  counting: "Counting",
  exit: "Exit process",
  accrual: "Joining month",
  soft_rules: "Waivers",
};

/**
 * What each leaf is called, for the lines that name a rule without drawing its control - the "exempt from"
 * list, a validation banner.
 *
 * Derived from the domain's code -> leaves map rather than restated here, so the words on a waiver chip, in a
 * refusal message and in this list are one set of words. The handful of leaves no rule code owns are
 * MODIFIERS (see MODIFIER_LEAVES in the domain): they qualify another rule rather than being one, so no
 * violation is ever raised in their name and they need their labels given here.
 */
const LEAF_LABEL: Record<string, string> = {
  "quota.year_basis": "A year means",
  "quota.fiscal_year_start_month": "Financial year start",
  "combinations.gap_days": "Keep apart by",
  "exit.notice_cap_days": "Cap during notice",
  "request.reason_min_length": "Minimum reason length",
  "counting.sandwich": "Sandwich rule",
};
for (const code of RESTRICTION_CODES) {
  for (const leaf of RESTRICTION_CODE_LEAVES[code]) LEAF_LABEL[leaf] ??= RESTRICTION_LABELS[code];
}

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
  /**
   * Leaves the reader has explicitly put on "Custom" but not yet given a value.
   *
   * An empty number box stores nothing, and a leaf that stores nothing is inheriting - so without this,
   * clearing a figure to retype it threw the toggle back to "Org policy" mid-keystroke and the box refilled
   * with the org's placeholder. The blob is unchanged either way (nothing invalid is ever stored); this is
   * only what the toggle shows while the box is empty on purpose.
   */
  pending: Set<string>;
  setPending: (key: string, on: boolean) => void;
  /** Validation messages the server would refuse on, keyed "group.leaf" (or "group.leaf#index" for a row). */
  problems: Record<string, string>;
};
const RuleCtx = createContext<RuleAccess | null>(null);
function useRules(): RuleAccess {
  const ctx = useContext(RuleCtx);
  if (!ctx) throw new Error("a leave-policy control was rendered outside RestrictionsEditor");
  return ctx;
}

/** Everything one rule control needs to say which of the three states it is in, and to change it. */
function useSource(g: Group, leaf: string, seed: (org: unknown) => unknown) {
  const { read, write, inherited, inheriting, pending, setPending, problems } = useRules();
  const key = `${g}.${leaf}`;
  const stored = read(g, leaf);
  const org = inherited(g, leaf);
  // Only a leaf the org actually SET can be inherited or exempted from. A null org leaf is the org saying it
  // has no such rule, which is not something a type needs to opt out of.
  const hasOrg = inheriting && org !== undefined && org !== null;
  const source: Source = stored === null ? "off" : stored !== undefined ? "custom" : pending.has(key) ? "custom" : "org";
  const select = (next: Source) => {
    setPending(key, next === "custom");
    write(g, leaf, next === "org" ? undefined : next === "off" ? null : seed(org));
  };
  return { key, stored, org, hasOrg, source, select, problem: problems[key] };
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The one control that says which of the three statements a rule is making.
 *
 * A segmented row rather than a dropdown: there are two or three options, they are mutually exclusive, and
 * which one is active is the single most important thing about the row - a closed select hides it behind a
 * click, which is most of why the old screen could not be read at a glance.
 */
function SourceToggle({ value, onSelect, segments, label }: {
  value: Source;
  onSelect: (s: Source) => void;
  segments: { value: Source; label: string }[];
  /** The rule this toggle is for. Without it the page carries twenty identical groups of "Org policy /
   *  Custom / No limit" buttons, which names nothing to a screen reader reading them one at a time. */
  label: string;
}) {
  return (
    // "<rule> source", never the rule's name on its own. The name belongs to the rule's CONTROL - the input or
    // select the Field labels - and a group answering to the same name is a second element claiming it: the
    // input loses its accessible name, and `getByLabel("Days a year")` resolves to two things. Described by
    // what it does, not named after what it acts on.
    <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label={`${label} source`}>
      {segments.map((s) => (
        <button
          key={s.value}
          type="button"
          aria-pressed={value === s.value}
          onClick={() => onSelect(s.value)}
          className={cn(
            "rounded px-1.5 py-0.5 text-xs transition-colors",
            value === s.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** The segments a rule offers: three where there is an org rule above it, none where a plain control says it. */
function scalarSegments(hasOrg: boolean): { value: Source; label: string }[] | null {
  return hasOrg
    ? [{ value: "org", label: "Org policy" }, { value: "custom", label: "Custom" }, { value: "off", label: "No limit" }]
    : null;
}

/** A numeric rule: empty = inherit, a figure = this scope's own, "No limit" = exempt from the org's. */
function NumRule({ g, leaf, label, info, unit, min = 0, max }: { g: Group; leaf: string; label: string; info?: string; unit?: string; min?: number; max?: number }) {
  const { write, scope } = useRules();
  const { stored, org: orgRaw, hasOrg, source, select, problem } = useSource(g, leaf, (org) => (typeof org === "number" ? org : ""));
  const org = orgRaw as number | null | undefined;
  const segments = scalarSegments(hasOrg);
  const hint = source === "off"
    ? "No limit - overrides the org rule"
    : source === "custom" && stored === undefined
      ? "Enter a figure - until then this rule follows the org policy"
      : source === "org"
        ? hasOrg ? `Inherits the org rule: ${org}${unit ? ` ${unit}` : ""}` : "No rule"
        : undefined;
  // `htmlFor` by hand: the control shares its row with the unit and Field has no single labelable child to
  // bind to (see the note in components/common/Field.tsx).
  const id = `rule-${scope}-${g}-${leaf}`;
  return (
    <Field
      label={label}
      info={info}
      hint={hint}
      error={problem}
      eager
      htmlFor={id}
      action={segments && <SourceToggle value={source} onSelect={select} segments={segments} label={label} />}
    >
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        disabled={source === "off"}
        placeholder={source === "off" ? "No limit" : hasOrg ? String(org) : "None"}
        value={stored === undefined || stored === null ? "" : String(stored)}
        onChange={(e) => write(g, leaf, e.target.value.trim() === "" ? undefined : Number(e.target.value))}
      />
    </Field>
  );
}

function BoolRule({ g, leaf, label, info }: { g: Group; leaf: string; label: string; info?: string }) {
  const { write } = useRules();
  const { stored, org: orgRaw, hasOrg, source, select, problem } = useSource(g, leaf, (org) => org === true);
  const org = orgRaw as boolean | null | undefined;
  const segments = scalarSegments(hasOrg);
  const v = stored === true ? "yes" : stored === false ? "no" : "__none";
  return (
    <Field
      label={label}
      info={info}
      error={problem}
      eager
      hint={source === "off" ? "No rule for this type - overrides the org rule" : source === "org" && hasOrg ? `Inherits the org rule: ${org ? "yes" : "no"}` : undefined}
      action={segments && <SourceToggle value={source} onSelect={select} segments={segments} label={label} />}
    >
      <Select
        // On "Org policy" or "No limit" the select is showing the org's answer or none at all, and it must not
        // be the thing that changes the state - the toggle above it is. Picking a value here is always a
        // custom answer, so it clears the other two.
        // Empty rather than "__none" when this scope has no answer of its own, so the trigger falls through to
        // the placeholder - which is where the org's answer is shown. Matching "__none" would display the
        // literal words "No rule" over a rule the org has very much set.
        disabled={source === "off"}
        value={source === "custom" ? v : ""}
        onValueChange={(next) => write(g, leaf, next === "__none" ? undefined : next === "yes")}
      >
        <SelectTrigger><SelectValue placeholder={source === "org" && hasOrg ? (org ? "Yes (org)" : "No (org)") : "No rule"} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">No rule</SelectItem>
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
  const { write } = useRules();
  const { stored, org: orgRaw, hasOrg, source, select, problem } = useSource(g, leaf, (org) => (typeof org === "string" ? org : options[0]!.value));
  const org = orgRaw as string | null | undefined;
  const segments = scalarSegments(hasOrg);
  const orgLabel = org ? options.find((o) => o.value === org)?.label ?? org : null;
  return (
    <Field
      label={label}
      info={info}
      error={problem}
      eager
      hint={source === "off" ? `${noneLabel} for this type - overrides the org rule` : source === "org" && orgLabel ? `Inherits the org rule: ${orgLabel}` : undefined}
      action={segments && <SourceToggle value={source} onSelect={select} segments={segments} label={label} />}
    >
      <Select
        disabled={source === "off"}
        value={source === "custom" && typeof stored === "string" ? stored : ""}
        onValueChange={(next) => write(g, leaf, next === "__none" ? undefined : next)}
      >
        <SelectTrigger><SelectValue placeholder={source === "org" && orgLabel ? `${orgLabel} (org)` : noneLabel} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{noneLabel}</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * Arrays and nested shapes, behind the same toggle as everything else.
 *
 * These keep a toggle even where nothing is inherited, because "this type has a list" and "this type has an
 * empty list" are different facts and a list on its own cannot say which - where a number box empty of a
 * number says it perfectly well.
 */
function OverrideSwitch({ g, leaf, label, empty, children }: { g: Group; leaf: string; label: string; empty: unknown; children: ReactNode }) {
  const { source, hasOrg, select, problem } = useSource(g, leaf, (org) =>
    // Seeded from the ORG's rule where there is one: the reason to override a list is almost always to change
    // it, and starting from an empty one makes the reader retype what they were already inheriting.
    org !== undefined && org !== null ? structuredClone(org) : empty);
  const segments: { value: Source; label: string }[] = hasOrg
    ? [{ value: "org", label: "Org policy" }, { value: "custom", label: "Custom" }, { value: "off", label: "No limit" }]
    : [{ value: "org", label: "No rule" }, { value: "custom", label: "Set a rule" }];
  return (
    <div className={cn("space-y-2 rounded-md border p-3", problem && "border-destructive")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <SourceToggle value={source} onSelect={select} segments={segments} label={label} />
      </div>
      {source === "off" && <p className="text-xs text-muted-foreground">No limit - the org rule doesn't apply to this type.</p>}
      {source === "org" && hasOrg && <p className="text-xs text-muted-foreground">Inheriting the org rule.</p>}
      {problem && <p role="alert" className="text-xs font-medium text-destructive">{problem}</p>}
      {source === "custom" && children}
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

/**
 * The rules the SERVER refuses, checked here so they are answered while the control that broke them is on
 * screen.
 *
 * A mirror of `validateRestrictions` rather than a second opinion: every message below is one the server
 * would also produce, and `validateRestrictions` itself runs over the whole blob afterwards as the backstop
 * (see `RestrictionsEditor`). The point of restating them per leaf is placement - the server answers with one
 * sentence after Save, naming a control that is very often behind a folded section.
 */
function ruleProblems(blob: Record<string, Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  const leafOf = (g: string, leaf: string): unknown => (blob[g] as Record<string, unknown> | undefined)?.[leaf];
  const numOf = (g: string, leaf: string): number | null => {
    const v = leafOf(g, leaf);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  for (const [g, leaf, name] of [
    ["eligibility", "min_tenure_days", "Service required"],
    ["eligibility", "max_occurrences_lifetime", "Times in total"],
    ["eligibility", "max_lifetime_days", "Days in total"],
    ["request", "min_days", "Minimum per request"],
    ["request", "max_days", "Maximum per request"],
    ["request", "max_consecutive_days", "Maximum in a row"],
    ["request", "document_required_over_days", "Document required over"],
    ["request", "backdate_days", "Back-dating allowed"],
    ["timing", "max_advance_days", "Booked ahead"],
    ["quota", "min_gap_days", "Gap between requests"],
    ["exit", "notice_cap_days", "Cap during notice"],
  ] as const) {
    const v = numOf(g, leaf);
    if (v !== null && v < 0) out[`${g}.${leaf}`] = `${name} cannot be negative.`;
  }
  const min = numOf("request", "min_days");
  const max = numOf("request", "max_days");
  if (min !== null && max !== null && min > max) {
    const msg = "The minimum cannot exceed the maximum - no request could satisfy both.";
    out["request.min_days"] = msg;
    out["request.max_days"] = msg;
  }
  const fy = numOf("quota", "fiscal_year_start_month");
  if (fy !== null && (fy < 1 || fy > 12)) out["quota.fiscal_year_start_month"] = "A month is 1 (January) to 12 (December).";
  if (leafOf("exit", "during_notice") === "capped" && numOf("exit", "notice_cap_days") === null) {
    out["exit.notice_cap_days"] = "A capped notice period needs a figure to cap it at.";
  }
  const joining = leafOf("accrual", "joining_rule") as { cutoff_day?: number } | null | undefined;
  if (joining && typeof joining.cutoff_day === "number" && (joining.cutoff_day < 1 || joining.cutoff_day > 28)) {
    // 28, not 31, and the server says the same: a cutoff on the 30th would mean something different in
    // February, and a rule whose meaning moves with the month is not one anybody can reason about.
    out["accrual.joining_rule"] = "The cutoff is the 1st to the 28th - a later one would mean something different in February.";
  }
  const blackouts = leafOf("timing", "blackouts") as { from?: string; to?: string; label?: string }[] | null | undefined;
  blackouts?.forEach((b, i) => {
    if (!b?.from || !b?.to) out[`timing.blackouts#${i}`] = "A closed period needs both dates.";
    else if (b.to < b.from) out[`timing.blackouts#${i}`] = "This period ends before it starts.";
  });
  const notice = leafOf("timing", "advance_notice") as { tiers?: { up_to_days?: number; notice_days?: number }[]; beyond_notice_days?: number | null } | null | undefined;
  if (notice) {
    const tiers = notice.tiers ?? [];
    if (!tiers.length && notice.beyond_notice_days == null) {
      out["timing.advance_notice"] = "A notice rule needs at least one band, or a figure for anything longer.";
    }
    const tops = new Map<number, number>();
    tiers.forEach((t, i) => {
      const top = t?.up_to_days;
      if (typeof top !== "number" || !Number.isFinite(top)) return;
      if (top <= 0) out[`timing.advance_notice#${i}`] = "A band covers requests UP TO a length, which has to be more than zero.";
      // Two bands ending at the same length is not a ladder - one of them silently never applies, and which
      // one depends on the order they happen to be stored in.
      else if (tops.has(top)) out[`timing.advance_notice#${i}`] = `Another band already ends at ${top} day${top === 1 ? "" : "s"}.`;
      else tops.set(top, i);
      if (typeof t?.notice_days === "number" && t.notice_days < 0) out[`timing.advance_notice#${i}`] = "Notice cannot be negative.";
    });
  }
  return out;
}

export function RestrictionsEditor({
  value,
  onChange,
  baseline,
  leaveTypes = [],
  selfPath,
  scope,
  overriddenBy,
  onValidityChange,
}: {
  value: Blob;
  onChange: (next: Blob) => void;
  /** The org baseline, for the "inherits X" hints. Only meaningful in `type` scope. */
  baseline?: LeaveRestrictions | null;
  leaveTypes?: LeaveType[];
  /** This type's own path, so it can't be listed as incompatible with itself. */
  selfPath?: string;
  scope: "org" | "type";
  /**
   * Which leave types override each section, named. Org scope only, and the reason it exists: an org baseline
   * that six types have opted out of enforces far less than the screen setting it appears to say, and nothing
   * on that screen used to hint as much.
   */
  overriddenBy?: Partial<Record<Group, { label: string; href: string }[]>>;
  /**
   * What the form holding this editor should refuse to save, and why - null when the policy is sound. The
   * server is still the authority; this stops a dialog being submitted only to come back with a sentence
   * about a field the reader has to go looking for.
   */
  onValidityChange?: (problem: string | null) => void;
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

  // Leaves put on "Custom" whose value hasn't been typed yet - see RuleAccess.pending.
  const [pending, setPendingSet] = useState<Set<string>>(() => new Set());
  const setPending = (key: string, on: boolean) =>
    setPendingSet((prev) => {
      if (on === prev.has(key)) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  // What this type (or the org) will actually enforce - through the SERVER'S OWN merge, not a copy of it here.
  // A second implementation would be the place the sentence under the editor and the rule the server applies
  // quietly stop agreeing, and the whole point of the sentence is that it can be trusted.
  const effective = useMemo(() => mergeRestrictions(baseline ?? {}, blob), [blob, baseline]);
  /** The leaves THIS scope stores - what the type overrides, as opposed to what it is handed. */
  const mine = useMemo(() => storedLeaves(value), [value]);
  const problems = useMemo(() => ruleProblems(blob), [blob]);
  // The backstop, and the one that is guaranteed to agree with the server: every message above is a message
  // the server would also produce, but the server's list is longer than the controls can usefully carry.
  const banner = useMemo(() => {
    const first = Object.values(problems)[0];
    if (first) return first;
    try {
      validateRestrictions(value ?? {});
      return null;
    } catch (e) {
      // `AppError` puts its detail on `message` (it passes it to `super`), so this IS the sentence the server
      // would have answered with - not a paraphrase of it.
      return (e as { message?: string }).message || "This policy can't be saved.";
    }
  }, [problems, value]);
  useEffect(() => { onValidityChange?.(banner); }, [banner, onValidityChange]);

  // WHICH SECTION IS SHOWING. Sections are navigation now, not a stack: one is painted at a time, so the
  // editor is one screenful whatever the policy holds. Nine accordions with live summaries still made finding
  // a rule a matter of scanning nine headers and guessing which to open, and the folds that auto-opened
  // because they held rules turned an existing policy into five expanded sections down one modal.
  //
  // Seeded ONCE, on the first section that carries rules - the same "don't hide what is set" intent the
  // auto-opening had, at one section rather than five. Recomputing it as the blob changes would move the
  // reader off the section they are typing in.
  const [selected, setSelected] = useState<string>(() => {
    for (const key of storedLeaves(value)) {
      const g = key.split(".")[0]!;
      if (g !== "soft_rules") return g;
    }
    return GROUPS[0]!;
  });
  const [query, setQuery] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  // The rule a reader has just jumped to from the policy above, so its control can say "this is the one".
  // Cleared as soon as they pick a section themselves - the highlight answers a question they already asked.
  const [focusLeaf, setFocusLeaf] = useState<string | null>(null);

  /** How many of a section's leaves this scope has set, and how many it has exempted. */
  const sectionState = (g: Group) => {
    const group = blob[g];
    let set = 0, exempt = 0;
    if (group && typeof group === "object") {
      for (const v of Object.values(group as Record<string, unknown>)) {
        if (v === null) exempt++;
        else set++;
      }
    }
    return { set, exempt, total: set + exempt };
  };
  /** Does the ORG have anything to say about this section? Decides whether "follows the org" is even true. */
  const orgHas = (g: Group) =>
    !!baseline && Object.values(baseline[g] as unknown as Record<string, unknown>).some((v) => v !== null && !(Array.isArray(v) && !v.length));

  // Folding may hide the CONTROLS and never the state - so the header says what the section is set to, rather
  // than the fixed caption it used to carry (which had to be opened just to be read).
  const summaryFor = (g: Group): string => {
    const { set, exempt } = sectionState(g);
    const parts: string[] = [];
    if (set) parts.push(`${set} set`);
    if (exempt) parts.push(`${exempt} no limit`);
    if (parts.length) return parts.join(" · ");
    return inheriting && orgHas(g) ? "Follows the org policy" : "No rules";
  };

  /** Put a whole section back to inheriting (type) or clear it (org). */
  const resetGroup = (g: Group) => {
    const next = { ...blob };
    delete next[g];
    setPendingSet((prev) => {
      const out = new Set(prev);
      for (const key of out) if (key.startsWith(`${g}.`)) out.delete(key);
      return out;
    });
    onChange(Object.keys(next).length ? next : null);
  };
  const resetAll = () => {
    setPendingSet(new Set());
    onChange(null);
  };

  /** Does this section hold anything the server would refuse? Marks its tab, so a fold cannot hide an error. */
  const sectionBad = (g: Group) => Object.keys(problems).some((k) => k.startsWith(`${g}.`));

  /** The header above whichever section is showing: what it is for, who overrides it, and how to undo it. */
  const sectionHeader = (g: Group, caption: string) => (
    <div className="space-y-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {caption} <span className="font-medium text-foreground">{summaryFor(g)}</span>
        </p>
        {sectionState(g).total > 0 && (
          <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => resetGroup(g)}>
            {inheriting ? "Reset to org" : "Clear"}
          </button>
        )}
      </div>
      {/* `!!` in front, not a bare `&&` on a length: a zero renders as the character "0" on the page. */}
      {!!overriddenBy?.[g]?.length && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Overridden by:</span>{" "}
          {overriddenBy[g]!.map((t, i) => (
            <span key={t.href}>
              {i > 0 && ", "}
              <a href={t.href} className="underline hover:text-foreground">{t.label}</a>
            </span>
          ))}
          {" "}- these types state their own version of a rule here, or opt out of one.
        </p>
      )}
    </div>
  );

  // Everything the rule controls need, handed down once. The controls themselves live at module scope - see
  // RuleAccess for why that is not optional.
  const ctx: RuleAccess = { scope, inheriting, read, write, inherited, pending, setPending, problems };

  const tiers = ((read("timing", "advance_notice") as { tiers?: { up_to_days: number; notice_days: number }[] } | null)?.tiers) ?? [];
  const beyond = (read("timing", "advance_notice") as { beyond_notice_days?: number | null } | null)?.beyond_notice_days ?? null;
  const writeNotice = (nextTiers: typeof tiers, nextBeyond: number | null) =>
    write("timing", "advance_notice", { tiers: nextTiers, beyond_notice_days: nextBeyond });
  // Kept in order as they are typed. The evaluator sorts before it reads them either way, so an unsorted list
  // enforces the same policy - but it DISPLAYS as a ladder whose rungs are out of order, and each row's band
  // is stated relative to the row above it, which then reads as nonsense.
  const sortTiers = (list: typeof tiers) => [...list].sort((a, b) => a.up_to_days - b.up_to_days);
  // THE ROWS ARE POSITIONAL, SO EVERY EDIT INDEXES INTO THE SORTED LIST, not into the stored one.
  //
  // `noticeBands` sorts its own copy before it builds the rows, so row `i` on screen is the i-th band BY
  // LENGTH - while the stored array is in whatever order it was last written or last came back from the
  // server. Editing `tiers[i]` for row `i` therefore wrote to a different band whenever the two disagreed,
  // which nothing in the editor guarantees they don't.
  const orderedTiers = sortTiers(tiers);
  /** The words in front of a band's own input: where it starts, which is where the row above it stopped. */
  const bandPrefix = (b: { moreThan: number | null }, last: boolean) => {
    if (b.moreThan === null) return last ? "Leave of any length" : "Leave of up to";
    const d = `${b.moreThan} day${b.moreThan === 1 ? "" : "s"}`;
    return last ? `Over ${d}` : `Over ${d}, up to`;
  };
  // The rows ARE the bands (domain/leaveRestrictions.ts), last one included - so what the editor shows and
  // what the server enforces are the same reading of the same list.
  const noticeRows = noticeBands({ tiers, beyond_notice_days: beyond });

  /**
   * The band's length while it is being typed, held as raw text until the reader is done with it.
   *
   * The ladder is re-sorted whenever a band's length changes, and the rows are positional, so committing per
   * keystroke moved the row out from under the caret the moment the typed number passed the band below it:
   * typing `12` into a band of `1` with a band of `5` under it re-sorted on the `2`, and the input the caret
   * was still in was now showing - and editing - the other band. `Number("")` is 0 as well, so clearing the
   * box to retype it wrote a band of zero days rather than leaving it alone.
   *
   * Committed on blur, and on Enter, which is when the number somebody meant is actually complete.
   */
  const [bandDraft, setBandDraft] = useState<{ at: number; text: string } | null>(null);
  const commitBand = (i: number) => {
    const draft = bandDraft;
    if (!draft || draft.at !== i) return;
    setBandDraft(null);
    const n = Number(draft.text);
    // An emptied or unusable box leaves the band exactly as it was. "Nothing typed" is not "zero days", and a
    // band of zero is a rung the reader cannot see the point of and did not ask for.
    if (draft.text.trim() === "" || !Number.isFinite(n) || n <= 0 || n === orderedTiers[i]?.up_to_days) return;
    writeNotice(sortTiers(orderedTiers.map((x, j) => (j === i ? { ...x, up_to_days: n } : x))), beyond);
  };

  const blackouts = (read("timing", "blackouts") as { from: string; to: string; label?: string }[] | null) ?? [];
  const excluded = (read("combinations", "no_combination_with") as string[] | null) ?? [];
  const softRules = (blob.soft_rules as unknown as string[] | undefined) ?? undefined;

  // The policy as it will be enforced, clause by clause, each saying WHERE it came from. Grouped, because a
  // thirty-clause paragraph joined by "·" is a wall nobody reads to the end of.
  const clauses = useMemo(() => describeRestrictionsByGroup(effective), [effective]);
  const clausesByGroup = useMemo(() => {
    const out = new Map<string, { text: string; own: boolean; leaf: string }[]>();
    for (const c of clauses) {
      const list = out.get(c.group) ?? [];
      // The leaf travels with the clause so the sentence can BE the way in to the control that sets it.
      list.push({ text: c.text, own: mine.has(`${c.group}.${c.leaf}`), leaf: c.leaf });
      out.set(c.group, list);
    }
    return out;
  }, [clauses, mine]);
  // The exemptions, which produce NO clause at all - "this type is not subject to the org's yearly cap" is
  // invisible in a list of rules in force, and it is exactly the thing an override is most often for.
  const exempted = useMemo(() => {
    const out: string[] = [];
    for (const g of GROUPS) {
      const group = blob[g];
      if (!group || typeof group !== "object") continue;
      for (const [leaf, v] of Object.entries(group as Record<string, unknown>)) {
        if (v === null) out.push(LEAF_LABEL[`${g}.${leaf}`] ?? leaf.replace(/_/g, " "));
      }
    }
    return out;
  }, [blob]);

  const overrides = useMemo(() => [...mine].filter((k) => k !== "soft_rules").length, [mine]);

  // EVERY RULE, DECLARED ONCE. The section view and the search results both map over this, so a rule cannot
  // be reachable one way and not the other.
  const sections: SectionDef[] = [
    {
      g: "eligibility",
      caption: "Who may take this leave.",
      rules: [
        { leaf: "min_tenure_days", label: "Service required", node: <NumRule g="eligibility" leaf="min_tenure_days" label="Service required (days)" unit="days" info="No requests until this much service. Measured against the leave's start date, so booking ahead for a date you'll be eligible on still works." /> },
        { leaf: "max_occurrences_lifetime", label: "Times in total", node: <NumRule g="eligibility" leaf="max_occurrences_lifetime" label="Times in total" info="How many separate times this may ever be taken - e.g. maternity twice." /> },
        { leaf: "max_lifetime_days", label: "Days in total", node: <NumRule g="eligibility" leaf="max_lifetime_days" label="Days in total" unit="days" info="Total days of this type over the whole employment." /> },
      ],
    },
    {
      g: "request",
      caption: "How long a request may be, and how it's split.",
      rules: [
        { leaf: "min_days", label: "Minimum per request", node: <NumRule g="request" leaf="min_days" label="Minimum per request" unit="days" info="Shortest request allowed." /> },
        { leaf: "max_days", label: "Maximum per request", node: <NumRule g="request" leaf="max_days" label="Maximum per request" unit="days" /> },
        { leaf: "max_consecutive_days", label: "Maximum in a row", node: <NumRule g="request" leaf="max_consecutive_days" label="Maximum in a row" unit="days" info="Measured over the whole run: requests separated only by days off count as one stretch, so splitting a block in two doesn't get around it." /> },
        { leaf: "backdate_days", label: "Back-dating allowed", node: <NumRule g="request" leaf="backdate_days" label="Back-dating allowed (days)" unit="days" info="How far this type may be filed late. Set it to 0 to forbid back-dating. When set, it replaces the org-wide back-dating toggle in Settings -> Leave policy -> Requests for this type." /> },
        { leaf: "half_day_allowed", label: "Half days allowed", node: <BoolRule g="request" leaf="half_day_allowed" label="Half days allowed" info="No = this leave runs whole days only." /> },
        { leaf: "must_be_single_block", label: "Must be one block", node: <BoolRule g="request" leaf="must_be_single_block" label="Must be one block" info="Yes = the whole entitlement has to be taken in one unbroken stretch." /> },
        { leaf: "reason_required", label: "Reason required", node: <BoolRule g="request" leaf="reason_required" label="Reason required" /> },
        { leaf: "reason_min_length", label: "Minimum reason length", node: <NumRule g="request" leaf="reason_min_length" label="Minimum reason length" unit="characters" min={1} /> },
        { leaf: "document_required_over_days", label: "Document required", wide: true, node: <NumRule g="request" leaf="document_required_over_days" label="Document required over (days)" unit="days" info="A sick note or similar, required past this many days. Checked when the request is approved - the request has to exist before a file can be attached to it." /> },
        {
          leaf: "blocked_weekdays",
          label: "Block particular weekdays",
          wide: true,
          node: (
            <OverrideSwitch g="request" leaf="blocked_weekdays" label="Block particular weekdays" empty={[]}>
              <DayChips g="request" leaf="blocked_weekdays" values={[0, 1, 2, 3, 4, 5, 6]} labels={WEEKDAY_LABELS} />
            </OverrideSwitch>
          ),
        },
      ],
    },
    {
      g: "timing",
      caption: "How far ahead it must be asked for.",
      rules: [
        {
          leaf: "advance_notice",
          label: "Advance notice required",
          wide: true,
          // Seeded with one band rather than an empty ladder: a notice rule with no bands says nothing, so the
          // server refuses it - and switching a rule on should not produce something that cannot be saved.
          node: (
            <OverrideSwitch g="timing" leaf="advance_notice" label="Advance notice required" empty={{ tiers: [{ up_to_days: 1, notice_days: 1 }], beyond_notice_days: null }}>
              {/* THE LADDER, WRITTEN AS THE BANDS IT ENFORCES. Each row used to be a bare "up to (days)" box,
                  which says nothing about where that band STARTS and left "what does a 3-day request need?" for
                  the reader to work out. Every row now states its own band ("over 1 day, up to 5 days"), the
                  bands are kept in order as they are typed, and the open-ended last one is a row of the table
                  rather than a separate field underneath - because a policy that says nothing about long
                  requests is a policy that lets them go with no notice at all, and that has to be on screen. */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Longer requests need more warning. Each row covers everything up to its own length, starting where the row above it stopped.
                </p>
                {noticeRows.map((band, i) => {
                  const last = band.upTo === null;
                  const rowProblem = problems[`timing.advance_notice#${i}`];
                  return (
                    <div key={i} className={cn("rounded-md border px-3 py-2 text-sm", rowProblem && "border-destructive")}>
                      {/* Wraps to its own lines on a phone rather than squeezing four controls onto one row. */}
                      <div className="flex flex-wrap items-center gap-2">
                        {/* The band's LOWER bound is text (it is whatever the row above ended at, so it is not
                            this row's to edit) and its upper bound is the input. Printing the whole band label
                            here as well would say the same number twice, once editable and once not. */}
                        <span className="shrink-0 text-muted-foreground">{bandPrefix(band, last)}</span>
                        {!last && (
                          <>
                            <Input
                              type="number"
                              min={0.5}
                              step={0.5}
                              className="h-8 w-20"
                              aria-label={`Band ${i + 1} covers leave up to (days)`}
                              value={bandDraft?.at === i ? bandDraft.text : String(band.upTo)}
                              onChange={(e) => setBandDraft({ at: i, text: e.target.value })}
                              onBlur={() => commitBand(i)}
                              // Enter commits without leaving the field, which is what a reader who has
                              // finished one rung and wants to see the ladder settle expects it to do.
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitBand(i); } }}
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
                            if (last) writeNotice(orderedTiers, v);
                            else writeNotice(orderedTiers.map((x, j) => (j === i ? { ...x, notice_days: v ?? 0 } : x)), beyond);
                          }}
                        />
                        <span className="text-muted-foreground">days' notice</span>
                        {last ? (
                          band.noticeDays == null && <span className="text-xs text-warning-foreground dark:text-warning">no notice required</span>
                        ) : (
                          <Button type="button" variant="ghost" size="icon" className="ml-auto h-8 w-8" aria-label={`Remove band ${i + 1}`} onClick={() => { setBandDraft(null); writeNotice(orderedTiers.filter((_, j) => j !== i), beyond); }}>
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      {rowProblem && <p role="alert" className="mt-1 text-xs font-medium text-destructive">{rowProblem}</p>}
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // A day past the LONGEST band so far, not past whichever happens to be last in the array - a
                  // new band that lands in the middle of the ladder is confusing to have to fix.
                  onClick={() => writeNotice(sortTiers([...orderedTiers, { up_to_days: Math.max(0, ...orderedTiers.map((t) => t.up_to_days)) + 1, notice_days: 0 }]), beyond)}
                >
                  Add a band
                </Button>
              </div>
            </OverrideSwitch>
          ),
        },
        { leaf: "max_advance_days", label: "Booked ahead", node: <NumRule g="timing" leaf="max_advance_days" label="Booked at most (days) ahead" unit="days" /> },
        { leaf: "block_adjacent_to_holiday", label: "Block next to a holiday", node: <BoolRule g="timing" leaf="block_adjacent_to_holiday" label="Block next to a holiday" info="Yes = this leave may not touch a public holiday, so it can't be used to extend one." /> },
        {
          leaf: "blackouts",
          label: "Closed periods",
          wide: true,
          node: (
            <OverrideSwitch g="timing" leaf="blackouts" label="Closed periods" empty={[]}>
              <div className="space-y-2">
                {blackouts.map((b, i) => {
                  const rowProblem = problems[`timing.blackouts#${i}`];
                  return (
                    <div key={i} className="space-y-1">
                      {/* Stacks on a phone: three date fields and a remove button in one flex row overflowed
                          the dialog at ~400px, which is the width most of this app is read at. */}
                      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                        <Field label={i === 0 ? "From" : ""}>
                          <Input type="date" aria-label={`Closed period ${i + 1} from`} value={b.from} onChange={(e) => write("timing", "blackouts", blackouts.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                        </Field>
                        <Field label={i === 0 ? "To" : ""}>
                          <Input type="date" aria-label={`Closed period ${i + 1} to`} value={b.to} onChange={(e) => write("timing", "blackouts", blackouts.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                        </Field>
                        <Field label={i === 0 ? "Label" : ""} className="col-span-2 sm:col-span-1">
                          <Input aria-label={`Closed period ${i + 1} label`} value={b.label ?? ""} placeholder="Year-end close" onChange={(e) => write("timing", "blackouts", blackouts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                        </Field>
                        <Button type="button" variant="ghost" size="icon" className="col-span-2 justify-self-end sm:col-span-1" aria-label={`Remove closed period ${i + 1}`} onClick={() => write("timing", "blackouts", blackouts.filter((_, j) => j !== i))}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      {rowProblem && <p role="alert" className="text-xs font-medium text-destructive">{rowProblem}</p>}
                    </div>
                  );
                })}
                {/* Seeded with a real date, not blank: the wire schema requires YYYY-MM-DD on both ends, so a
                    row left empty made the whole leave type fail to save with a field error about a date the
                    author had not got to yet. */}
                <Button type="button" variant="outline" size="sm" onClick={() => write("timing", "blackouts", [...blackouts, { from: todayStr(), to: todayStr(), label: "" }])}>
                  Add a period
                </Button>
              </div>
            </OverrideSwitch>
          ),
        },
        {
          leaf: "blackout_days_of_month",
          label: "Block days of the month",
          wide: true,
          node: (
            <OverrideSwitch g="timing" leaf="blackout_days_of_month" label="Block days of the month" empty={[]}>
              <DayChips g="timing" leaf="blackout_days_of_month" values={Array.from({ length: 31 }, (_, i) => i + 1)} labels={Array.from({ length: 31 }, (_, i) => String(i + 1))} offset={1} />
            </OverrideSwitch>
          ),
        },
      ],
    },
    {
      g: "quota",
      caption: "How much of this leave, and how often.",
      rules: [
        { leaf: "max_days_per_month", label: "Days a month", node: <NumRule g="quota" leaf="max_days_per_month" label="Days a month" unit="days" /> },
        { leaf: "max_days_per_year", label: "Days a year", node: <NumRule g="quota" leaf="max_days_per_year" label="Days a year" unit="days" /> },
        { leaf: "max_requests_per_month", label: "Requests a month", node: <NumRule g="quota" leaf="max_requests_per_month" label="Requests a month" info="A request counts in the month its start date falls in." /> },
        { leaf: "max_requests_per_year", label: "Requests a year", node: <NumRule g="quota" leaf="max_requests_per_year" label="Requests a year" /> },
        { leaf: "min_gap_days", label: "Gap between requests", node: <NumRule g="quota" leaf="min_gap_days" label="Gap between requests (days)" unit="days" info="Working days required between one request of this type and the next." /> },
        {
          leaf: "year_basis",
          label: "A year means",
          node: (
            <EnumRule
              g="quota"
              leaf="year_basis"
              label="A year means"
              noneLabel="Calendar year"
              options={[{ value: "calendar", label: "Calendar year" }, { value: "fiscal", label: "Financial year" }, { value: "anniversary", label: "From the joining date" }]}
            />
          ),
        },
        { leaf: "fiscal_year_start_month", label: "Financial year start", wide: true, node: <NumRule g="quota" leaf="fiscal_year_start_month" label="Financial year starts in month" min={1} max={12} info="1 = January, 4 = April. Only used when a year means the financial year." /> },
      ],
    },
    {
      g: "combinations",
      caption: "Leave types this can't be taken with.",
      rules: [
        {
          leaf: "no_combination_with",
          label: "Can't be combined with",
          wide: true,
          node: (
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
                        aria-pressed={on}
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
          ),
        },
      ],
    },
    {
      g: "counting",
      caption: "What a day off inside the leave costs.",
      rules: [
        {
          leaf: "sandwich",
          label: "Sandwich rule",
          wide: true,
          // ONE toggle over the PAIR, because the pair is one leaf. Weekends and holidays live together in
          // `counting.sandwich`, and the merge works per leaf - so a type that stores the leaf at all takes
          // BOTH halves from its own blob. The two halves each offering their own "Inherit" was therefore a
          // claim the storage cannot honour: setting weekends alone silently took holidays off the org's rule.
          node: (
            <OverrideSwitch g="counting" leaf="sandwich" label="Charge days off inside the leave" empty={{ weekends: "exclude", holidays: "exclude" }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <SandwichHalf part="weekends" label="Weekends inside the leave" />
                <SandwichHalf part="holidays" label="Holidays inside the leave" />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Charged = the day comes off the balance. "Between the leave" charges days off that fall inside the block; "beside it too" also charges the days off it runs up against.
                Both halves are set together - they are stored as one rule, so a type states both or inherits both.
              </p>
            </OverrideSwitch>
          ),
        },
      ],
    },
    {
      g: "exit",
      caption: "What happens while serving notice.",
      rules: [
        {
          leaf: "during_notice",
          label: "During notice period",
          node: (
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
          ),
        },
        { leaf: "notice_cap_days", label: "Cap during notice", node: <NumRule g="exit" leaf="notice_cap_days" label="Cap during notice (days)" unit="days" info="Required when the rule above is Capped." /> },
      ],
    },
    {
      g: "accrual",
      caption: "How the month someone joins is credited.",
      rules: [{ leaf: "joining_rule", label: "Joining month", wide: true, node: <JoiningRuleEditor /> }],
    },
  ];

  const visible = onlySet ? sections.filter((s) => sectionState(s.g).total > 0) : sections;
  // A filter that hides the section you are standing in has to move you, or the body goes blank with no
  // explanation. Falls back to the first section still showing.
  const shown = visible.some((s) => s.g === selected) || selected === "soft_rules" ? selected : visible[0]?.g ?? "soft_rules";

  const needle = query.trim().toLowerCase();
  /**
   * What a rule can be found by.
   *
   * THE LEAF KEY IS IN HERE, and that is the point rather than an implementation detail leaking. A reader
   * looking for the closed-period rule types "blackout" - which is what the API calls it (`timing.blackouts`),
   * what the refusal code calls it, and what the policy document they are working from almost certainly calls
   * it. The label happens to read "Closed periods". Searching only the words we chose for the control would
   * answer "no rule matches" to the word the whole rest of the system uses for that rule.
   *
   * `LEAF_LABEL` is in here too: the domain has its own name for each rule (the one a waiver chip and a
   * violation message show), and those are equally the words someone will search for.
   */
  const haystack = (s: SectionDef, r: RuleDef) =>
    [r.label, GROUP_TITLES[s.g], r.leaf.replace(/_/g, " "), LEAF_LABEL[`${s.g}.${r.leaf}`] ?? ""]
      .join(" ")
      .toLowerCase();
  const matches = needle
    ? sections.flatMap((s) => s.rules.filter((r) => haystack(s, r).includes(needle)).map((r) => ({ section: s, rule: r })))
    : [];

  return (
    <RuleCtx.Provider value={ctx}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {overrides === 0
            ? inheriting ? "Follows the org policy in full" : "No rules set"
            : inheriting
              ? `Overrides ${overrides} of the org's rules`
              : `${overrides} rule${overrides === 1 ? "" : "s"} set`}
        </span>
        <div className="flex items-center gap-3 text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={onlySet} onCheckedChange={(v) => setOnlySet(v === true)} />
            Only what's set
          </label>
          {overrides > 0 && (
            <button type="button" className="hover:text-foreground" onClick={resetAll}>
              {inheriting ? "Reset all to org" : "Clear all"}
            </button>
          )}
        </div>
      </div>

      {banner && (
        <p role="alert" className="rounded-md border border-destructive bg-destructive/5 p-2 text-xs font-medium text-destructive">
          {banner}
        </p>
      )}

      {/* THE POLICY ITSELF, FIRST — and every clause is the way in to the control that sets it.
          This screen used to be forty controls with the readable version of them at the very bottom, which
          made a policy something you reassembled from a form rather than something you read. Leading with the
          sentences puts the document first and the machinery second: you read what this leave type does, and
          when a line is wrong you click that line. The clause carries its own leaf, so "at most 24 days a
          calendar year" knows it is `quota.max_days_per_year` and can open exactly that control. */}
      <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {inheriting ? "What this type enforces" : "What every leave type starts from"}
        </p>
        {clauses.length === 0 && exempted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No restrictions{scope === "type" ? " beyond the org policy" : ""}. Pick a section below to add one.
          </p>
        ) : (
          <>
            {[...GROUPS, "soft_rules" as const].map((g) => {
              const list = clausesByGroup.get(g);
              if (!list?.length) return null;
              return (
                <div key={g} className="text-xs">
                  <span className="font-medium text-foreground">{GROUP_TITLES[g]}</span>
                  <ul className="mt-0.5 space-y-0.5">
                    {list.map((c, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          // `soft_rules` is a list of waivers rather than a rule with a control of its own,
                          // so its clause reads but doesn't navigate.
                          disabled={g === "soft_rules"}
                          onClick={() => {
                            setSelected(g);
                            setFocusLeaf(`${g}.${c.leaf}`);
                            setQuery("");
                          }}
                          className={cn(
                            "flex w-full flex-wrap items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground",
                            g !== "soft_rules" && "hover:bg-accent hover:text-foreground",
                          )}
                        >
                          <span>{c.text}</span>
                          {inheriting && (
                            <span className={cn(
                              "rounded-full border px-1.5 text-[10px] leading-4",
                              c.own ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground",
                            )}>
                              {c.own ? "This type" : "Org"}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {exempted.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Exempt from:</span> {exempted.join(", ")} - the org's rule doesn't apply here.
              </p>
            )}
          </>
        )}
      </div>

      {/* FIND A RULE BY NAME. Forty rules across nine sections, and which section owns a rule is a guess until
          you have learned the layout - "blackout" is Notice & timing, "half days" is Request shape. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a rule…"
          aria-label="Find a rule"
          className="h-8 max-w-[14rem]"
        />
        {!!needle && (
          <span className="text-xs text-muted-foreground">
            {matches.length} rule{matches.length === 1 ? "" : "s"} match
            <button type="button" className="ml-2 underline hover:text-foreground" onClick={() => setQuery("")}>Clear</button>
          </span>
        )}
      </div>

      {needle ? (
        matches.length === 0 ? (
          <p className="text-xs text-muted-foreground">No rule matches "{query.trim()}".</p>
        ) : (
          // Results carry the section they came from: the point of searching is not to avoid the sections, it
          // is to find out which one you needed.
          <div className="space-y-4">
            {matches.map(({ section: s, rule }) => (
              <div key={`${s.g}.${rule.leaf}`} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{GROUP_TITLES[s.g]}</p>
                {rule.node}
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          {/* The sections as CHIPS, not a second tab bar. This editor is mounted inside a dialog that carries
              its own tabs and inside a Settings card that carries another, and a third bar at the same weight
              would read as a peer of those rather than as navigation within one of them. Chips are the
              vocabulary this editor already speaks - the weekday, day-of-month, combination and waiver pickers
              are all aria-pressed chips - and they carry a count, which a tab would have to hide. */}
          {/* ON A PHONE, ONE SELECT INSTEAD OF NINE CHIPS. Wrapped, the chips take three or four rows before
              the section's own controls start, which is most of a small screen spent on navigation. The
              counts survive into the option text, so nothing is lost but the space. */}
          <div className="sm:hidden">
            <Select
              value={shown}
              onValueChange={(v) => { setSelected(v); setFocusLeaf(null); }}
            >
              <SelectTrigger aria-label="Policy section"><SelectValue /></SelectTrigger>
              <SelectContent>
                {visible.map((s) => {
                  const { total } = sectionState(s.g);
                  return (
                    <SelectItem key={s.g} value={s.g}>
                      {GROUP_TITLES[s.g]}{sectionBad(s.g) ? " · needs attention" : total > 0 ? ` · ${total}` : ""}
                    </SelectItem>
                  );
                })}
                <SelectItem value="soft_rules">Waivers{softRules?.length ? ` · ${softRules.length}` : ""}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div role="group" aria-label="Policy sections" className="hidden flex-wrap gap-1.5 sm:flex">
            {visible.map((s) => {
              const { total } = sectionState(s.g);
              const bad = sectionBad(s.g);
              return (
                <button
                  key={s.g}
                  type="button"
                  aria-pressed={shown === s.g}
                  onClick={() => { setSelected(s.g); setFocusLeaf(null); }}
                  title={summaryFor(s.g)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
                    shown === s.g && "border-primary bg-primary/10 text-primary",
                    bad && "border-destructive text-destructive",
                  )}
                >
                  {GROUP_TITLES[s.g]}
                  {bad ? (
                    <span className="rounded-full bg-destructive px-1.5 text-[10px] leading-4 text-destructive-foreground">!</span>
                  ) : total > 0 ? (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">{total}</span>
                  ) : null}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={shown === "soft_rules"}
              onClick={() => setSelected("soft_rules")}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
                shown === "soft_rules" && "border-primary bg-primary/10 text-primary",
              )}
            >
              Waivers
              {!!softRules?.length && <span className="rounded-full bg-warning/20 px-1.5 text-[10px] leading-4 text-warning-foreground dark:text-warning">{softRules.length}</span>}
            </button>
          </div>

          {shown === "soft_rules" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  A waived rule doesn't refuse the request. It's filed anyway, carrying the warning, and whoever approves it is shown what was broken.
                  A rule that isn't configured is shown dimmed - waiving it would do nothing.
                </p>
                {!!softRules?.length && (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const out = { ...blob } as Record<string, unknown>;
                      delete out.soft_rules;
                      onChange(Object.keys(out).length ? (out as Blob) : null);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <WaiverChips
                effective={effective}
                selected={softRules}
                onChange={(next) => {
                  const out = { ...blob } as Record<string, unknown>;
                  if (next.length) out.soft_rules = next;
                  else delete out.soft_rules;
                  onChange(Object.keys(out).length ? (out as Blob) : null);
                }}
              />
            </div>
          ) : (
            visible
              .filter((s) => s.g === shown)
              .map((s) => (
                <div key={s.g} className="space-y-3">
                  {sectionHeader(s.g, s.caption)}
                  {/* Two to a row, as the paired FieldRows read before; a structured rule claims the width. */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    {s.rules.map((r) => (
                      <div
                        key={r.leaf}
                        className={cn(
                          r.wide && "sm:col-span-2",
                          // The rule the reader clicked a sentence to reach, ringed so the jump lands
                          // somewhere visible - a section that merely opened at the right place leaves them
                          // hunting the row they asked for among nine others.
                          focusLeaf === `${s.g}.${r.leaf}` && "rounded-md ring-2 ring-primary/50 ring-offset-2 ring-offset-background",
                        )}
                      >
                        {r.node}
                      </div>
                    ))}
                  </div>
                </div>
              ))
          )}
        </>
      )}

    </div>
    </RuleCtx.Provider>
  );
}

/**
 * The waiver chips, grouped by the section their rule lives in and dimmed where that rule isn't configured.
 *
 * Waiving a rule nobody has set does nothing whatsoever, and as a row of forty identical chips there was no
 * way to tell those apart from the ones that work - so a policy could carry six waivers and mean none of them.
 */
function WaiverChips({ effective, selected, onChange }: {
  effective: LeaveRestrictions;
  selected: string[] | undefined;
  onChange: (next: string[]) => void;
}) {
  const list = selected ?? [];
  /** Is the rule this code decides actually configured in the policy as it will be enforced? */
  const live = (code: RestrictionCode) =>
    RESTRICTION_CODE_LEAVES[code].some((path) => {
      const [g, leaf] = path.split(".") as [Group, string];
      const v = (effective[g] as unknown as Record<string, unknown>)[leaf];
      if (v === null || v === undefined) return false;
      if (Array.isArray(v) && !v.length) return false;
      // A `false` half-day rule IS the rule ("whole days only"); `true` is the absence of one.
      if (path === "request.half_day_allowed") return v === false;
      return true;
    });
  const byGroup = new Map<Group, RestrictionCode[]>();
  for (const code of RESTRICTION_CODES) {
    const g = RESTRICTION_CODE_LEAVES[code][0]!.split(".")[0] as Group;
    byGroup.set(g, [...(byGroup.get(g) ?? []), code]);
  }
  return (
    <div className="space-y-2">
      {GROUPS.map((g) => {
        const codes = byGroup.get(g);
        if (!codes?.length) return null;
        return (
          <div key={g}>
            <p className="mb-1 text-xs font-medium text-muted-foreground">{GROUP_TITLES[g]}</p>
            <div className="flex flex-wrap gap-1.5">
              {codes.map((c) => {
                const on = list.includes(c);
                const configured = live(c);
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    title={configured ? undefined : "This rule isn't set, so waiving it does nothing"}
                    onClick={() => onChange(on ? list.filter((x) => x !== c) : [...list, c])}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
                      on && "border-warning bg-warning/10 text-warning-foreground dark:text-warning",
                      !configured && "opacity-50",
                    )}
                  >
                    {RESTRICTION_LABELS[c]}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One half of the sandwich rule - what weekends, or holidays, cost inside a stretch of leave.
 *
 * No inherit option of its own: whether the rule is this type's or the org's is decided once, for the pair,
 * by the toggle on the panel around it. The half only says what the value is.
 */
function SandwichHalf({ part, label }: { part: "weekends" | "holidays"; label: string }) {
  const { read, write } = useRules();
  const stored = (read("counting", "sandwich") as { weekends?: string; holidays?: string } | null) ?? {};
  return (
    <Field label={label}>
      <Select
        value={stored[part] ?? "exclude"}
        // Both halves written every time: the stored rule is a pair, and a half-written one reads back as
        // "not charged" for whichever half was left out - which is a rule, not an absence.
        onValueChange={(next) => write("counting", "sandwich", { weekends: "exclude", holidays: "exclude", ...stored, [part]: next })}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="exclude">Not charged</SelectItem>
          <SelectItem value="intervening">Charged between the leave</SelectItem>
          <SelectItem value="flanking">Charged between and beside it</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function JoiningRuleEditor() {
  const { read, write, inherited, inheriting, problems } = useRules();
  const stored = read("accrual", "joining_rule") as { cutoff_day?: number; if_on_or_before?: string; if_after?: string } | null | undefined;
  const org = inherited("accrual", "joining_rule") as { cutoff_day?: number } | null | undefined;
  const hasOrg = inheriting && !!org;
  const source: Source = stored === null ? "off" : stored ? "custom" : "org";
  const segments: { value: Source; label: string }[] = hasOrg
    ? [{ value: "org", label: "Org policy" }, { value: "custom", label: "Custom" }, { value: "off", label: "No limit" }]
    : [{ value: "org", label: "No rule" }, { value: "custom", label: "Set a rule" }];
  const select = (next: Source) =>
    write("accrual", "joining_rule", next === "org" ? undefined : next === "off" ? null : { cutoff_day: org?.cutoff_day ?? 15, if_on_or_before: "full", if_after: "none" });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Joining-date cutoff</span>
        <SourceToggle value={source} onSelect={select} segments={segments} label="Joining-date cutoff" />
      </div>
      {source === "off" && <p className="text-xs text-muted-foreground">No limit - the org's joining rule doesn't apply to this type.</p>}
      {source === "org" && (
        <p className="text-xs text-muted-foreground">
          {hasOrg ? `Inheriting the org rule (cutoff on the ${org.cutoff_day}).` : "The joining month is prorated by the days actually worked."}
        </p>
      )}
      {source === "custom" && (
        <>
          <FieldRow>
            <Field
              label="Cutoff day of the month"
              info="1 to 28. A cutoff past the 28th would mean something different in February."
              error={problems["accrual.joining_rule"]}
              eager
            >
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
