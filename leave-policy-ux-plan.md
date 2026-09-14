# Leave policy editor: the conventions it holds to

The policy engine is described in `leave-policy-plan.md` and in `docs/architecture-decisions.md`. This is
about the screen in front of it — `web/src/components/leave/RestrictionsEditor.tsx`, the one component both
the org baseline (Settings → Leave policy → Restrictions) and a single leave type's overrides (Leave Types →
edit) are edited through.

## One grammar for the three states

A rule in `type` scope is doing exactly one of three things, and every rule says which through the same
segmented control, in the field's label row:

| Segment | Stored as | Means |
|---|---|---|
| `Org policy` | the leaf is absent | the org's baseline applies |
| `Custom` | the leaf holds a value | this type's own rule |
| `No limit` | the leaf is `null` | this type is exempt from the org's rule |

The toggle appears only where it has more than one real option:

- **Scalar rules** (number, yes/no, enum) carry it only when the org has actually set that leaf. In `org`
  scope nothing is inherited, so the control alone says it and an empty one is no rule.
- **Structured rules** (lists, the notice ladder, the joining cutoff) carry it in both scopes, as
  `No rule | Set a rule` where there is no baseline — a list cannot express "I have no list" by being empty.

Picking `Custom` seeds from the org's value where there is one: the reason to override a rule is nearly
always to change it, and starting from blank makes the reader retype what they were already inheriting.

A leaf put on `Custom` whose box is then emptied stays on `Custom` (`RuleAccess.pending`). Nothing invalid is
stored — an empty box stores no leaf — but the toggle must not flip back to `Org policy` mid-keystroke while
somebody is retyping a figure.

## The policy is the page; the controls are underneath

The editor opens with the policy written out — every clause the merged rules produce, grouped by section and
badged `Org` or `This type`. **Each clause is a button that opens the control that sets it**, which works
because `describeRestrictionsByGroup` tags every clause with the leaf it came from. The section chips and the
forty controls sit below it, as the machinery rather than the headline.

Before this the readable version of the policy was at the very bottom, under everything, which made a policy
something you reassembled from a form rather than something you read.

## One rule, one place — in the request form too

`RequestLeaveDialog` states the policy as a single checklist: a row per rule for the chosen type, each
resolving to met / not met / waived as dates are picked. It replaced a notice hint on the Start date field, a
blocking panel and a waived panel — three surfaces that overlapped, which is why the code carried a flag to
stop the hint printing a sentence the panel was already printing.

That flag is gone rather than ported. The invariant it kept by hand — one surface states a given rule — now
holds by construction, and `leaveRestrictionsEnforced.spec.ts` asserts the policy heading resolves to exactly
one element (`exact: true`, since these matchers are substring by default) so a regression fails loudly. The
original duplication was never noticed by anyone reading the dialog; it surfaced only as a strict-mode
violation, because both sentences were true and neither was wrong on its own.

## Closed periods are one thing, not fourteen

A closed period is drawn as a continuous tint across the days it covers and named once beneath the grid;
per-day rules (a blocked weekday, a blocked day of the month) keep a strike on the day, because each
occurrence really is its own recurring fact. `DayInfo.barred` carries `kind` to tell them apart.

The leave calendar draws the org's closed periods too — `closedOn` on `ViewProps`, honoured by **every** view:
`MonthGrid`, `QuarterGrid`, `TeamGrid` (through its single `dayTint`), `AgendaList` (where a closed day earns
a row even with nothing booked on it) and `DayPanel`.

Every view, not most of them, and the reason is worth keeping. A contradiction between two *features* — the
picker refusing what the calendar drew as free — invites "these are different screens". A contradiction
between two *view modes of one feature*, one toggle apart, invites "the closure must have ended": same shape,
shorter distance, easier to hit and harder to explain. So a view that cannot show closures should not be a
view of this calendar.

## Sections are navigation, not a stack

The nine sections are chips in a `role="group"` labelled `Policy sections`, and one section is painted at a
time. Each chip carries its count, or a `!` when that section holds something the server would refuse. The
editor opens on the first section that holds rules.

Chips rather than a tab bar, deliberately: this editor is mounted inside a dialog that carries its own tabs
and inside a Settings card that carries another, so a third bar at the same weight would read as a peer of
those rather than as navigation within one of them. Chips are also the vocabulary the editor already speaks —
the weekday, day-of-month, combination and waiver pickers are all `aria-pressed` chips — and they carry a
count, which a tab would have to hide.

The section header states what it is set to (`2 set · 1 no limit`, `Follows the org policy`, `No rules`) and
carries the undo: `Reset to org` per section, `Reset all to org` in the editor header.

**Search reaches every section.** A rule is found by name from wherever you are standing, and each result says
which section it came from — the point is not to avoid the sections, it is to learn which one you needed. This
is why the rules are declared as a list (`RuleDef`) rather than written straight into their sections: the
section view and the search results map over one definition, so a rule cannot be reachable one way and not the
other.

## The leave-type dialog is three tabs

Basics / Balance / Restrictions, `variant="segmented"`. It was one scroll of about fifty controls — its own
twenty plus the editor's thirty.

Segmented, not `underline`: every tabbed dialog in this app (AccessTab, ApiKeysPanel, RequestsHistoryTabs) is
segmented, and `underline` is defined by resembling the sidebar's workspace bar (`tabs.tsx:8-10`) — navigation
chrome, which reads wrong inside a form the reader still has to Save or Cancel out of.

The policy summary and the activity feed sit **below** the tabs. They describe the whole form, and behind a
tab they would only be visible from the third of it that produced them.

## The two halves of a policy link to each other

The org baseline and a type's overrides are separate settings entries, so each names the other: the type
editor's Restrictions tab links to `#/settings/leave-policy?tab=restrictions`, and every name under
`Overridden by` links to `#/settings/leave-types/<id>`, which `useDeepOpen` opens. `LeaveCapsTab`'s tab lives
in `?tab=` via `setQueryParam` — the guard's `panelKey` ignores query params other than `setting`/`settingObj`,
so switching tabs never prompts the unsaved-changes confirm.

## The readout says where each clause came from

`describeRestrictionsByGroup` (in the domain, with `describeRestrictions` mapping over it) tags each clause
with the group and leaf it was produced from, so the "In force" block can badge it `Org` or `This type`
against `storedLeaves`. Exemptions produce no clause at all, so they are listed separately — an opt-out is
the most common reason to override anything, and it was invisible in a list of rules in force.

## Refusals arrive before Save, in the server's own words

`ruleProblems` restates, per leaf, the pairwise checks `validateRestrictions` enforces (min over max, a capped
notice period with no cap, a closed period ending before it starts, two bands sharing an upper bound, a cutoff
outside 1–28). `validateRestrictions` itself then runs over the whole blob as the backstop, and its message —
which is the sentence the server would have answered with — is the banner at the head of the editor. The host
form gets it through `onValidityChange` and refuses to submit.

Anything added to the server's validation should be added here too, or it becomes a refusal that only arrives
after a round trip.

## What the org screen shows about its own baseline

Settings → Leave policy → Restrictions names, per section, the leave types that override it, read off the
rows that tab already fetches through `storedLeaves`. A baseline six types have opted out of enforces far
less than the screen setting it would otherwise appear to say.

## Not built

- **A policy simulator** ("would this request pass?"). `checkLeaveRestrictions` already runs client-side in
  `RequestLeaveDialog`, but a faithful answer needs holidays, working days, the person's neighbouring
  requests and their notice period. Anything less is a second, quieter evaluator that disagrees with the
  server, which is the failure this whole feature is built to avoid.
- **Moving `allow_backdated` into the blob.** It stays its own settings key; the two controls cross-reference
  each other instead, since `request.backdate_days` silently beats it per type.
- **Per-employee exceptions** — deferred as Phase 3 in `leave-policy-plan.md`.
