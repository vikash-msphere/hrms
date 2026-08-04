# Reviews page UX plan

Improvements to `/reviews` (`web/src/pages/Reviews.tsx`). The page serves three audiences at once:
the employee (write self-assessment, read outcome, acknowledge), the manager (write reviews for
reports, request 360 feedback), and HR (watch progress across cycles). The plan keeps all three in
one page but makes each audience's slice scannable and fast.

## Done (baseline pass)

- Summary strip: Need you / In progress / Completed counts (shared `SummaryStrip`).
- Filter chips (All / Needs you / In progress / Completed, with counts) plus a cycle `Select` when
  reviews span more than one cycle; filtered-empty state with a Clear filters action.
- Collapsible review cards: header is a toggle; cards needing the caller's action start open, the
  rest start folded. Folded header still shows avatar, name, cycle, stage trail, due date, and the
  overall rating once shared. Card body and `ActivitySection` mount only when open.
- "Needs you" badge on the card header, matching the needs-first sort.
- `ScalePicker` shows the picked rating's label next to the buttons (was tooltip-only).

## Phase 1: client-only wins (one file, no API changes) - DONE

1. **Deep-link + URL filter state.** Support `?review=<id>` (open + scroll to that card) and
   `?filter=needs|open|done&cycle=<id>` so filters survive reload and notifications can land on the
   exact review. Follows the DataTable URL-state convention.
2. **Rating history / trend.** The caller already has every review they can read. On a
   SHARED/ACKNOWLEDGED card, show the previous cycle's overall rating next to the current one
   (e.g. "3 to 4, up"). Client-side lookup by employee across cycles; zero new reads.
3. **Draft-saved indicator.** Self-assessment and manager comment drafts already persist to
   localStorage; surface a small "Draft saved" hint so long-form writers know it is safe to leave.
4. **Guided self-assessment.** Replace the single blank textarea prompt with framework competency
   chips that insert section headings into the text. No schema change; the field stays one string,
   but the blank-page problem goes away and managers get structured input.
5. **Overdue emphasis.** Destructive left border on cards whose current stage is past due, plus an
   Overdue count in the summary strip. Overdue is the first thing HR scans for.
6. **Group by cycle + expand/collapse all.** When "All cycles" is selected and reviews span several
   cycles, render cycle section headers; add an expand/collapse-all toggle next to the filters.

## Phase 2: small server touches - DONE

7. **Acknowledge with comment.** Optional employee note on `:acknowledge` (for example
   disagreement or context), stored on the review and visible to manager/HR. Verb accepts an
   optional body field; UI adds an optional textarea on the acknowledge step.
8. **Nudge stalled reviews.** Either a `:nudge` verb (manager/HR button that notifies whoever owns
   the current stage) or, cheaper, a seeded workflow automation on stage age using the existing
   SLA/scheduled-trigger machinery, which needs no UI at all. Decide when building.
9. **Peer-feedback picker suggestions.** When nominating 360 reviewers, pre-rank same-department
   colleagues and recent kanban card co-collaborators. Ranking is client-side over already-loaded
   collections; only the picker ordering changes.

## Phase 3: heavier items - DONE

10. **Review PDF.** Export the final acknowledged review as a letter-style PDF via the existing
    `pdfPrimitives` / letter infrastructure. Pairs with the e-signature machinery.
11. **Per-competency self ratings.** Employee rates themself on the same scale; the manager form
    and the shared result show the self/manager gap per competency as a conversation flag. Needs a
    `self_ratings` column plus changes to both forms; the highest-payoff large item.
12. **HR calibration view.** Overall-rating distribution per cycle and department. Belongs on the
    ReviewCycles page rather than this one.

## Status

All phases implemented.

- Phase 1: all six items live in `web/src/pages/Reviews.tsx` (URL filter state + `#/reviews/<id>`
  deep link, previous-cycle rating trend, draft-saved hints, competency section chips, overdue
  accents + strip count, cycle grouping with expand/collapse all).
- Phase 2: `:acknowledge` takes an optional `comment` (stored as `ack_comment`, notifies the manager
  when present); new `:nudge` verb (manager `reviews.my-dept.nudge`, HR `reviews.*.nudge`) reminds the
  current stage owner; review notifications deep-link to `reviews/<id>`; `EmployeePicker` gained
  ranked `suggested` chips fed by board-collaborator + same-department scoring.
- Phase 3: optional per-competency `self_ratings` on `:submitSelf` with self-vs-manager gap flags in
  the manager form and shared result; `:pdf` verb renders the finished (shared/acknowledged) review
  through the letterhead renderer with a viewer dialog on the card; ReviewCycles gained a lazy
  per-cycle Calibration panel (rating distribution + completion, department filter).

Decision on item 8: implemented as the `:nudge` verb (not a scheduled automation) - the engine has no
review-stage-age trigger, and a button next to Skip stage matches how HR actually unblocks a review.
