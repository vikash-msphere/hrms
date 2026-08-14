# Documents reads through the resource store

**Landed.** `useDocuments` reads both document resources through the shared resource store, and each per-row
action reloads only its own resource.

## Why `useLifecycle`'s reload is not the waste

It reads like one: the hook discards the verb response and calls `reload()`. For ten of its eleven callers that
costs nothing, and the mechanism is worth knowing before anyone "optimizes" it.

`invoke()` in `web/src/api.ts` wraps every write in `withInvalidation`, which calls
`invalidateCollections(affectedCollections(path, verb))` as soon as the POST resolves. That refetches every cached
key of the touched collection **that has a live subscriber**, synchronously setting `e.inflight`. `useLifecycle`
then calls `reload()`, which is `ensureFetch(collection, opts, true)` - and `ensureFetch`'s first statement is
`if (e.inflight) return e.inflight`, checked before `force`. So the two coalesce into one GET, deterministically:
the invalidation's fetch is a network promise that cannot have settled in the intervening microtask.

So the count is one list GET per lifecycle action, it comes from `api.ts` and not from the hook, and it is also
the cross-tab consistency path (`ensureFetch` publishes the fresh rows on `TOPIC_ROWS` so sibling tabs adopt them
without each re-reading). There is nothing to reclaim there.

The callback is not merely a refetch either, so it cannot be dropped: `PayComponents.tsx` passes
`afterMutation = () => { reload(); void promptReapply(); }`, where the second half runs a server dry-run and
prompts to propagate the change to salary splits.

## Where the waste was

`web/src/pages/Documents.tsx` is the one caller outside the store. `web/src/lib/documents.ts` `useDocuments`
holds its rows in `useState` and lists BOTH document collections directly:

```ts
const [org, personal] = await Promise.all([
  list<DocumentResource>("org-documents", { showDeleted }).then(...).catch(() => []),
  list<DocumentResource>("personal-documents", { showDeleted }).then(...).catch(() => []),
]);
```

Because it never subscribed to the resourceStore, `invalidateCollections` found no entry to refresh, so the
automatic refetch did nothing, and then `reload()` fired **two** GETs - one for the collection that changed and one
for the collection that had not. On every `:enable` / `:disable` / `:lock` / `:unlock` / `:publish` / `:unpublish`,
every soft delete, restore and purge, and both explicit `reload()` calls.

Being off the store cost the page four other things the rest of the app has:

- **No cache and no TTL.** Navigating to Documents always re-listed both collections; every other page serves from
  the store when fresh.
- **No cross-tab adoption.** A sibling tab showing Documents never heard about a change.
- **No truncation signal.** The server caps a page at 100 rows and nothing here follows the cursor, so the page
  presented a window as the whole collection. `hasMore` / `TruncationNotice` are store-derived.
- **Silently swallowed errors.** The per-list `.catch(() => [])` rendered a failing read as "no documents" rather
  than as an error, and `state` never went to `error` for it.

## What was done

`useDocuments` kept its place as the facade - the merge is the reason that module exists - but is now two
`useCollection` reads plus a `useMemo` merge, byte-identical in expression to the old one. The page did not grow
two hooks.

Then:

- **`reload`** still reloads both, for the two call sites that genuinely touch both (acknowledging an org document
  files a signed copy as a personal one). `useSoftDelete` / `useLifecycle` take the reload for **their own**
  resource - `lcOrg` gets `reloadOrg`, `lcPersonal` gets `reloadPersonal` - which is what removes the second GET.
  They stay redundant-but-free for the same reason the other ten pages are.
- **`state`** combines as: `error` only if both sides failed, `loading` while either is loading, else `ready`. The
  rule is written down in the code because it is a judgement call: surfacing one failure when the other half
  loaded fine would regress the page for a reader who may only see personal documents, and it would be louder
  than the `.catch(() => [])` it replaces.
- **`error`** takes whichever side set one, for the DataState retry.
- **Capability gating came for free.** `useCollection` fires no request without `<collection>.read`, so an
  employee with no `org-documents.read` stops making a call the server would only 403.
- **`TruncationNotice` is wired** over both collections. The page filters and sorts cached rows, so it has to admit
  when it holds a window rather than the whole shelf; that signal was unavailable off the store.
- `setRows` was exported and used nowhere; it went with the old body. `list` is no longer imported; `apiCreate`
  still is, for `createDocument`.

One visible change worth knowing: the table no longer flashes a skeleton after a write. The old `reload` set
`loading` on every call; the store only sets `loading` when it has nothing ready yet, so rows stay put through a
revalidation.

## What this does not change

- No server change. This is entirely `web/src`.
- `api.ts` `withInvalidation` stays exactly as is. Folding a write response into the cache instead of refetching
  is a real feature and a different one: it would have to handle list membership (a row can leave a filtered
  list), ordering, multi-collection side effects (`VERB_SIDE_EFFECTS`), and the cross-tab broadcast that
  `ensureFetch` currently does for free. It would save one GET per write across the app, on user-initiated admin
  actions. Not worth that risk today; recorded here so the option is on the record rather than rediscovered.
- `useLifecycle` and `useSoftDelete` keep their `reload` callback. It is an after-hook, not a refetch, and one
  caller uses it as one.

## Verification

- `npm run typecheck` clean (it covers `web/tsconfig.json`), `npm run test` unchanged at 108 files / 1241 tests -
  this is a client refactor and no route test was added for it.
- `rows` is the same merged, same-sorted array: the merge expression is unchanged, so the `originalByPath` /
  `signedCopyPaths` memos and the expiry loop in `Documents.tsx` see what they saw before.
- Request count, by inspection: `lcOrg.disable(row)` now issues `POST org-documents/{id}:disable` plus one
  `GET /v1/org-documents` (fired by `api.ts`'s invalidation, with the hook's reload coalescing into it) and
  nothing for personal-documents. It used to issue both lists.
- No other view reads these two collections, so there is no read-dedup benefit to claim beyond the page itself.
