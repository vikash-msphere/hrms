# Lifecycle verbs answer like every other item response

**Landed.** `:enable`, `:disable`, `:lock`, `:unlock`, `:publish` and `:unpublish` now answer through the same
path as every other item response.

## How it works

`src/http/lifecycleVerb.ts` performs the transition and hands the resulting ROW back (`{ row }`, or `null` when
the verb is not one of these). It builds no response. `src/http/collectionRoute.ts` passes that row to `item()`,
which decorates it, computes the access hint and serializes with `(row, user, can)` - so a lifecycle response
carries `access.can`, the collection's derived fields and any viewer-dependent shape, exactly like a GET.

`{ row }` rather than a bare row because two answers have to stay distinguishable: "not my verb" (null, which the
caller turns into 404) and "handled, and the transition found nothing afterwards" - `setDisabled` answers with
whatever the row reads back as, which is undefined if the row vanished underneath it.

The verb dispatch order is unchanged: the collection's own verb first, then `:restore`, then this shared lane. So
`automations:enable` / `:disable`, which are the collection's own (they drop the engine's rule cache), never reach
it.

## What it was

`http/lifecycleRoute.ts` built its own response: `c.json(serialize(row))`. One argument, no `decorate`, no
`access`. Three consequences, all invisible to the suite because no test read a lifecycle response body:

- The response omitted `access`, which `openapi.yaml` declares (readOnly) on ~70 resource schemas, each of these
  verbs answering `$ref` to the collection's own resource. The fix makes the response conform to the contract as
  written; no spec change was needed.
- `decorate` never ran, so derived fields came back empty. For `announcement` that meant `read: false`,
  `reactions: []`, `replies: []`, `reply_count: 0` - and those four are **required** in its schema.
- A viewer-dependent serializer was called without a viewer, so `employees` stripped the owner's own `signature`
  marker and `announcements` could not answer the `can` question its `read_by` gate asks.

It bit for real on the board. `web/src/pages/Announcements.tsx:595` reads a card's controls off the response
(`const can = a.access?.can ?? []`) and `publishDraft` folds the verb's response into the cached row wholesale, so
publishing a draft took pin/react/reply/vote/edit/delete off that card and blanked its thread until the next
refetch. `web/src/components/common/PostComposer.tsx` folds the same verb the same way. Everything else escaped
only because `web/src/hooks/useLifecycle.ts` discards the response and calls `reload()`.

## Reach

13 collections mount at least one of these verbs - the table carries `disabled` / `locked`, or the spec sets
`publish: true`:

| collection | verbs | decorate | viewer-dependent serialize |
| --- | --- | --- | --- |
| announcements | enable/disable, lock/unlock, publish/unpublish | yes | `(row, user, can)` |
| org-documents, personal-documents | enable/disable, lock/unlock, publish/unpublish | no | no |
| employees | enable/disable, lock/unlock | no | `(row, user)` |
| holidays | enable/disable, lock/unlock | yes | no |
| automations, departments, expense-categories, leave-types, pay-components, pay-periods, reimbursement-categories, vendors | enable/disable, lock/unlock | no | no |

So the response gained content for three of them (announcements its thread and its hint, holidays `selected`,
employees the owner's `signature` marker on their own record) and gained `access` for the other ten. Cost: one
`decorate` per call for the two collections that have one - four queries for announcements, one for holidays,
nothing for the rest - which is what their item read already paid, on an admin action rather than on a page.

## What did not change

- **Audit stems.** The transitions in `services/lifecycle.ts` still write `${singular}.disable` / `.enable` /
  `.lock` / `.unlock` / `.publish` / `.unpublish`.
- **404 for an unsupported verb.** A table without the column still yields `null` and still answers 404 rather
  than a 500 from an UPDATE against a missing column (`test/collectionFactory.test.ts` pins this on `pay-grades`).
- **Status codes**, the lock guard, and the notifications and events the transitions fire (`setPublished`
  broadcasts an announcement).
- **Authorization.** The middleware decided the verb before the handler ran, as everywhere else.
- **Every pre-existing test.** All of them assert a status code or a column value on these verbs, so none moved.

## Gates

`test/collectionFactory.test.ts` (31 tests) adds two: a lifecycle response carries the same `access.can` the item
read carries plus the collection's `decorate` field, and a viewer-dependent serializer receives both the caller
and the hint on that path. Together they pin the mechanism the board bug came through; they exercise it on
`holidays`, not on `announcements`, since the board's own path needs an employee principal and a reaction thread.
