# Board access plan

Status: built. The design section below records the first plan; where the build differs it says so here.
- "Everyone" is NOT a per-board rule row. D1 caps a statement at 100 bound parameters and every list binds one
  pair per share, so org visibility is the board's code segment instead (`ve-` / `vr-` / `vp-`), reached by the
  employee role's subtree rules; only private access and managers use per-board rows.
- Per-board rules are SUBTREE rules on the board's code, so they sit in the caller's cached grant.
- The read verb is `:sharing` (not `:access`, which every resource already uses for its access hint).
- A sprint is gated by `references.sprints.board` at write (manage), not by an owner ref.
- People are shared by employee or user ref; there is no department subject (decided with the user).

## Context

Boards are flat-coded and carry no department, so the only board rules a role can hold reach every board:
`manager` and `project_manager` hold `boards.**` write, and every employee holds `boards.**` read plus
`cards.**` write. Two things are wanted:

1. **A department on a board**, so a department's managers manage that department's boards (and parent
   departments' managers manage their sub-departments' boards). Optional on a board; required when a manager
   creates one. The project manager, HR and super admin keep managing every board.
2. **Per-board visibility**: who can see a board and its tasks, and who can work them.

Decided with the user: boards may have no department; PM manages every board; department required when a
manager creates a board; a parent department's managers manage child departments' boards; a board hidden from
Everyone is hidden from HR too (only super admin, and the project manager who manages every board, see it);
no sharing with a department (people and roles only); a goal keeps counting a linked task on a board the
viewer cannot see, without showing the task.

## Why not a `my-dept` rule

A rule reaches a row by its code. Board codes are flat (`0a`, `04`), and flat codes collide with department
codes (`04` is Engineering, `0a` is Legal), so a `boards.my-dept.**` rule would hand an unattached board `04`
to every Engineering manager. The ticket servicing department hit the same wall and solved it with
per-object rules written as data (`services/ticketShares.ts`). This plan does the same, with no engine change.

## Design

### Cards and sprints are coded under their board

Today a card's code is its filer's (`allocOwnedCode` on `employee_id`) and a sprint's is flat. Both move under
the board: card `<boardCode>-<leaf>`, sprint `<boardCode>-<leaf>`. A card never changes board, so the code is
stable. With that, one per-object rule on code `<boardCode>` covers the board's cards (`applyScope` and the
item matcher already treat a share on C as C and everything under it). So access to a board is three rules on
one code: `boards.<bc>.**`, `cards.<bc>.**`, `sprints.<bc>.**`.

- `employee_id` stays on the card (who filed it; "my tasks" filters use it); only `code` changes.
- Wire ids are uuid-based, so no URL changes. Task keys (`MS-12`) are `task_prefix` + `seq`, unaffected.
- No role may ever hold `cards.me|my-dept|my-reports` or the same on sprints/boards: those tokens match codes,
  and board-coded rows would collide with employee/department codes. Recorded as `excluded` in the role files
  and pinned in test/roleFiles.test.ts.

### Access levels on a board

| Level | Rules on the board's code | Meaning |
|---|---|---|
| View | `boards.<bc>.**` read, `cards.<bc>.**` read, `sprints.<bc>.**` read, verbs `boards.<bc>.metrics` + read-only card verbs (`flow`, `triage`, `watch`, `unwatch`) | See the board and its tasks |
| Edit | View + `cards.<bc>.**` write + the named card verbs employees hold today (`move`, `block`, `assign`, `comment`, todos, ...) | Work the tasks |
| Manage | Edit + `boards.<bc>.**` write + every board verb + `sprints.<bc>.**` write + every sprint verb | Shape the board, run sprints, archive |

Card verbs are NAMED from one list (as the employee role does today), not a wildcard, so a card verb added
later is not granted by an old share.

### Who holds what

- **Department managers (automatic, Manage):** the managers listed on the board's department and on every
  ancestor department (`departments.manager_ids` up the `parent_id` chain). Written as user rules marked
  `source: "board-share"`, re-synced when: a board's department changes, a department's managers change, a
  department is re-parented. Resync touches only `board-share` rows, never a rule an admin wrote.
- **Sharing (chosen per board):** "Everyone in the org" at None / View / Edit, plus named people and roles at
  View / Edit / Manage. Everyone = the `everyone` pseudo-role (the same way a public kudos works). Stored as
  `board-share` rows; edited through a new board verb `boards.<bc>:share` (body: the full list), read back
  through `boards.<bc>:access`.
- **Creator (automatic, Manage):** whoever creates a board holds Manage on it, as a `board-share` user row an
  owner can later remove in Sharing.
- **Seeded roles:** super admin (`**`) and project_manager keep `boards.** / cards.** / sprints.**` broadly, so
  they see and manage every board, private or not. HR and managers lose their broad board, card and sprint
  rules; they keep create (`boards` 1-token write) and reach boards through the creator, department and
  sharing rows. Employees lose `boards.**` read,
  `cards.**` write and the broad card verbs; they keep the 1-token `boards` / `cards` / `sprints` list gates and
  reach boards through shares.
- **New board default:** Everyone = Edit (today's behaviour), so nothing changes until an owner narrows it.
- **Creating a board as a manager:** department required and must be one they (or an ancestor department)
  manage; checked in `createBoard` by asking the engine whether the caller would hold Manage there. Callers with
  broad `boards.**` write (PM, super) may leave it empty. Anyone else without a managed department (HR) may
  leave it empty too and manages the board as its creator.
- **Creating a card:** the service asks the engine for `cards.<bc>` write (the board's code), since the
  1-token create gate cannot see which board. Same for sprints with Manage.

### Live database (migration)

1. `boards.department_id` (nullable FK, indexed) - drizzle generate.
2. Recode every card and sprint under its board (deterministic leaf from `seq` / creation order), and rewrite
   any authored `cards.<old>` / `sprints.<old>` per-object rules to the new code.
3. For every existing board: Everyone = Edit (so nobody loses anything on deploy).
4. Role rules: remove the seeded employee/manager rows listed above (matched on full pattern + level +
   `source='acl'`, no `match_code`, like 0004); keep the 1-token gates. project_manager's role and rules are added
   here too (still missing on prod).
5. Policy manifest: nothing (REFERENCES `cards.board` read stays; the service check covers write).

### Surfaces that must respect board visibility

Everything that lists cards goes through `listCards` -> `applyScope`, so it follows automatically. To audit
explicitly, since each can leak a private board's task titles: ⌘K search index (`domain/searchIndex.ts`),
Dashboard My-day, profile Performance tab, goal linked-task rollups (`linkedTaskRollup`), card notifications
and watchers, `cards:triage` / `suggestSteps` / `flow` (read over "cards the caller can list"), table builder
field catalogue, CSV export, activity trail.

### Web

- Board create dialog + board settings: Department combobox (required for a manager, optional for HR/PM).
- Board settings: "Sharing" section: Everyone (None / View / Edit), people and roles with a level, and a
  read-only list "Managed by: <department managers>" so the automatic part is visible.
- Hide, never disable: board shape controls, sprint controls, the add-task composer and card actions render
  only for callers who hold them (existing `AccessAction` gates, now per board).
- Boards list shows a lock icon on a board not shared with Everyone.

## Files

- `src/db/schema.ts`, new migration, `src/services/boards.ts`, `src/services/cards.ts`,
  `src/services/sprints.ts`, new `src/services/boardShares.ts` (modelled on `ticketShares.ts`),
  `src/services/departments.ts` (resync hook), `src/routes/boards.ts` (`:share`, `:access`), `src/http/serialize.ts`,
  `openapi.yaml` + `npm run api:types`, custom-method registries for the two verbs (see the verb checklist),
  `bootstrap/authz/roles/{employee,manager,project_manager,everyone}.json`, `scripts/genSeed.ts` (seed boards
  get shares), regenerate `scripts/seed.sql` + `bootstrap/bootstrap.sql`.
- Web: `web/src/pages/Boards.tsx` (create, settings, sharing), types.

## Verification

- Unit (real D1): department managers + ancestors get Manage; changing department / managers / parent moves
  it; authored rules survive resync; a private board's cards are absent from `GET /v1/cards`, search, My-day
  and goal rollups for a non-member; View cannot move a card; Edit cannot rename the board; manager cannot
  create a board for a department they do not manage; migration recodes cards/sprints and keeps every
  existing board Everyone = Edit.
- `test/roleFiles.test.ts`: the excluded self/dept tokens on boards/cards/sprints.
- e2e: manager manages their department's board and not another's; a private board is invisible to a
  non-member and visible to a shared person; PM manages both.
