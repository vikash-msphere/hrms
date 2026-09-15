# Pre-production review — new findings (seventh pass)

Continues [defects.md](defects.md) (1–24) and [defects-new.md](defects-new.md) (25–28). Same rules: no gates
run, every claim traced to the file and line that proves it.

- [30](#30) **Every employee can read the company's authorized-signatory signature image and seal** — live
- [29](#29) A delegated ACL admin can grant themselves any collection at `admin` — the self-grant guard covers one of three lanes
- [31](#31) `tickets.description` is the one `REDACTED_FIELDS` entry with no replay mask

---

## 29. `createAccessRule` guards one self-grant lane and leaves two open

**Files:** `src/services/accessRules.ts:260-272` (`createAccessRule`), `:344-356` (`cloneAccessRules`),
`:497-503` (`decideAccessRule`), `:76-79` (`approvalRequired`), `src/domain/policyValidate.ts:38-47`,
`src/lib/policyLoad.ts` (`loadRoleGrant` / `loadUserGrant`), `src/middleware/auth.ts:366`

`createAccessRule` carries exactly one guard against an author widening their own authority:

```ts
} else {
  subject = r.subject;
  if (!(await ...roles...)) throw notFound("subject role not found");
  if (subject === actor.role) throw failedPrecondition("cannot edit rules of the role you are using");
}
```

That guard exists, so the hazard was seen. It covers the third of three lanes into the author's own grant.
`middleware/auth.ts:366` assembles a caller's authority as:

```ts
const { grant, policy } = await loadAuthority(deps, user);   // mergeGrants(roleGrant, userGrant)
// and roleGrant itself = mergeGrants(everyoneRows, ownRoleRows)   (lib/policyLoad.ts#roleGrantFrom)
```

so three subjects feed it: the caller's role (guarded), **the caller's own user row (not guarded)**, and
**the `everyone` pseudo-role (not guarded)**.

### Lane 1 — grant yourself, as a user

```
POST /v1/access-rules
{ "subject_kind": "user", "subject": "users/<own id>",
  "collection": "compensation", "scope": "all", "level": "admin" }
```

Every check passes. `validateAccessRule` only checks shape and that the collection is in `COLLECTIONS`.
`createAccessRule`'s subject guard is in the `else` branch — the **role** branch — so the user branch does no
comparison against the actor at all. `buildPattern` yields `compensation.**`; `deriveNarrowing` gives
`scopeKind: "all"`, `matchCode: null`, i.e. a **broad** user rule, which is exactly what
`policyLoad.ts#userRulesUncached` selects (`subjectKind = "user"` AND `match_code IS NULL`). One request per
collection, and the author holds `admin` on it from the next request onward.

### Lane 2 — grant `everyone`, which includes you

`everyone` is a real row in `roles` (seeded), so the existence check passes, and `subject === actor.role` is
false for anyone not literally using the `everyone` role. `roleGrantFrom` unions `everyone`'s rows into every
non-super caller's grant. So a rule authored against `everyone` reaches the author too — and the whole
organisation with them, which is the wider blast radius of the two.

### What does NOT work (checked, so the report is not overstated)

- `collection: "**"` is refused. `policyValidate.ts:47` tests `COLLECTIONS.has(collection)`, and `COLLECTIONS`
  has no `**` entry — the wildcard lives only in `isGrantCollection`'s separate branch. So there is no
  one-request jump to full super; it is one rule per collection.
- **Cloning super is refused.** `super_admin`'s two seeded rows are `namespace '*'`, `pattern '**'`, and
  `cloneAccessRules` rebuilds each source rule as a create body — which the validator then rejects for the
  same reason. The clone reports them as `failed` and copies nothing. `cloneAccessRules` does repeat the role
  guard for its target but, like `createAccessRule`, not for a **user** target.
- **Four-eyes is enforced correctly when it is on.** `decideAccessRule` refuses
  `row.requestedBy === actor.uuid`. It is simply off by default: `approvalRequired` reads
  `settings/access-approval` and returns `cfg.enabled === true`, so an absent setting means every authored rule
  lands `active` immediately.

### Reachability

`access-rules` has **no seeded grant** (see finding #2), so today only `super_admin` holds
`access-rules.write` — and super already has `**`, so there is nothing to escalate from. This is latent.

It does not stay latent by design, though: delegating access management is the feature. `web/src/lib/perm.ts`
exposes `useCanManageAccess()` gated on `access-rules.write`, `components/access/permMatrix.ts` offers
`access-rules` as a grantable collection, and the four-eyes flow exists precisely so that *more than one
person* administers permissions. The first time an admin grants `access-rules.write` to an HR lead, that lead
can grant themselves `compensation`, `payslips`, `settlements` or `audit` at `admin` — the collections the
seeded policy deliberately keeps them out of (see #27 for the compensation boundary in particular).

Mitigations that remain: every rule writes an `access-rule.create` audit row naming the actor, and turning on
`settings/access-approval` forces a second person. Neither is a control on the write itself.

### Fix

Make the subject guard about the resulting AUTHORITY rather than about the role slot:

1. Refuse `subject_kind: "user"` where the subject resolves to the actor's own `users.uuid` — the exact
   counterpart of the role guard, one line beside it, in both `createAccessRule` and `cloneAccessRules`.
2. Treat `everyone` as a self-affecting subject for a non-super author (it is unioned into their own grant),
   or require the approval flow for it unconditionally.
3. The principled version, if it is worth the work: refuse any rule the author could not already exercise —
   `decide(actor.grant, resolveRequest(...))` against the pattern being authored, so an ACL admin can delegate
   only what they hold. That is the containment property the module's header claims for API keys
   (`domain/keyScope.ts`: *"may only ever NARROW that user's authority - never widen it"*) and the one surface
   that authors authority does not assert.

---

## 30. Every employee can read the company's authorized-signatory signature image and seal

**Files:** `src/services/settings.ts:11-27` (`MANAGED_KEYS`), `src/routes/settings.ts:440-446`,
`src/http/serialize.ts:327-335` (`toSettingResource`), `src/domain/letters.ts:22-23`,
`web/src/lib/org.tsx:112-124` (`OrgProvider`), `web/src/lib/settingsStore.ts:96`,
`src/services/employeePhoto.ts:96-101` (the rule this breaks)

The employer's e-signature and company seal are stored as **data URLs inside the `organization` settings
blob**:

```ts
// domain/letters.ts — LetterDefaults, "Sourced from the organization settings 'letter_defaults' block"
signatory_signature?: string; // authorized-signatory signature image (data URL) - the employer's e-signature
company_stamp?: string;       // company seal/stamp image (data URL) - overlaid beside the signatory
```

`GET /v1/settings/organization` returns that blob **verbatim** — `toSettingResource` does
`value: jsonOr(r.value, {})` with no redaction — and the seeded grants give every role read on every settings
key:

```
'employee','role','settings','settings.**','all','',NULL,'read'
'manager', ... ,'read'      'payroll_admin', ... ,'read'      'hr_admin', ... ,'write'
```

`settings.**` matches `settings.organization` at `read`, so the decision passes for an ordinary employee.

**It is not an obscure endpoint — the app shell fetches it for everyone.** `OrgProvider`
(`web/src/lib/org.tsx:116`) calls `getSetting("organization")` on mount to resolve branding, currency and the
favicon, so every signed-in user receives the blob on every session. And `settingsStore` writes the snapshot
to disk (`put("snapshot", DISK_KEY, ...)`, `MAX_AGE_MS.snapshot` = 24h), so the signature image also lands in
every employee's browser profile.

**The app already has the carve-out mechanism, with two entries.** `services/settings.ts:11-16`:

> Settings keys whose VALUES are stored in this table but are NOT exposed through the **broadly-readable
> generic settings API** … `MANAGED_KEYS = new Set(["bank-formats", "payroll-debit"])`

`organization` is not one of them, and the sensitive part of it is not the branding — it is two images.

**And it contradicts the rule the app enforces for individuals, one file over.** `employeePhoto.ts:96-101`:

> PRIVATE to the owner. Unlike the photo, **a signature is forgeable**, so it is owner-only at the SERVICE
> level regardless of any `employees.*` grant (HR/super included) … a deliberate hard rule, stronger than the
> grant system, so the image is never exposed.

An employee's own signature gets a service-level hard rule that even super cannot bypass. The **employer's**
signature — the one actually stamped onto offer letters, increment letters, experience letters and relieving
letters (`domain/letters.ts:364` passes `ctx.defaults.signatory_signature` into the `signature` block, and
`services/offerLetter.ts:113-114` does the same) — is handed to the whole workforce and cached on their disks.
Anyone holding it can paste a convincing authorized signature and company seal onto a document the company
never issued.

**Fix:** the two images do not belong in a blob whose whole point is that everyone reads it.

1. Minimum, and it fits the existing mechanism: move `signatory_signature` and `company_stamp` out of
   `organization` into their own key and add it to `MANAGED_KEYS`, served by a gated namespace the way
   `bank-formats` and `payroll-debit` already are (the letter renderers read the row server-side through
   `getSettingValue`, which `MANAGED_KEYS` explicitly does not affect).
2. Or strip the two fields in `toSettingResource` for the `organization` key unless the caller holds
   `settings` write — the same "serve it to the people who administer it" shape `redactFlat` uses for employee
   sub-resources.

Either way the renderers are unaffected: nothing in `src/services/letterData.ts`, `offerLetter.ts` or
`domain/letters.ts` needs the images to travel to the browser.

---

## 31. `tickets.description` is the one `REDACTED_FIELDS` entry with no replay mask

**Files:** `src/domain/manifests.ts:70-84` (`REDACTED_FIELDS`), `web/src/pages/Tickets.tsx:1026`,
`web/src/pages/Leaves.tsx:543-547,1096`, `web/src/pages/Candidates.tsx:194`, `web/src/instrument.ts:53-76,316-317`

`REDACTED_FIELDS` is the app's field-level sensitivity registry — the list of fields *"genuinely a different
sensitivity from the row they sit on - money, personal contact details, free text about a person"*. It has four
entries. Three of them are masked from session replay at field granularity; the fourth is not:

| entry | rationale in the manifest | replay treatment |
|---|---|---|
| `offers: ["base_comp"]` | *"An offer's money"* | whole route in `SENSITIVE_PAGES` |
| `candidates: ["email","phone","notes"]` | *"An external person's own contact details"* | `Candidates.tsx:194` `data-sentry-mask` |
| `leave-requests: ["reason"]` | *"routinely medical"* | `Leaves.tsx:547,1096` `data-sentry-mask`, with a comment naming `instrument.ts` |
| `tickets: ["description"]` | *"A ticket raised about a person **can carry anything**; a queue only needs its subject and state"* | **none** |

```tsx
// Tickets.tsx:1026 — the ticket detail body, rendered plain
{t.description && <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{t.description}</p>}
```

`instrument.ts` runs unmask-by-default (*"text, inputs and media are recorded, and only what is listed here is
hidden"*), `tickets` is not a `SENSITIVE_PAGES` route, and nothing on this element opts out. So the full body
of whatever ticket is open is recorded verbatim and uploaded to the error tracker.

**Bounded, and worth saying so:** `replaysSessionSampleRate: 0` and `replaysOnErrorSampleRate: 1`, so a replay
is captured only when a JS error fires — not on every session. The exposure is "a ticket body reaches a third
party whenever something throws while it is on screen", not "every ticket does". The Tickets page is also the
one page that deliberately attaches replays (`session_replays`, *"Sentry replay of the minute before the
ticket, when the requester opted in"*), so replay capture there is expected rather than incidental — which
cuts both ways: it is the page most likely to be recorded.

**Fix:** `data-sentry-mask` on that element, matching `Leaves.tsx` exactly — one attribute. Then consider
deriving the requirement instead of remembering it: `test/replayMaskDrift.test.ts` already walks `MEMORY_ONLY`
and demands a mask; walking `REDACTED_FIELDS` the same way would have caught this, and it is the registry that
already states, per field, that the value is a different sensitivity from its row.
