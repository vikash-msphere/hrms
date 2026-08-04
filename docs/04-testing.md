# 04 — Testing

Run `npm test` (Vitest, via `@cloudflare/vitest-pool-workers`). The pure-domain tests need no Worker
runtime and are the fastest signal; service/route tests run against the real `workerd` runtime with
live D1/R2 bindings.

## What to test (current suite — `test/`, 13 files)
- **Pure domain**: `payroll.test.ts` (totals + rounding, run state machine), `leave.test.ts`
  (working-day / accrual math).
- **Crypto** (`crypto.test.ts`): field encryption round-trips; ciphertext != plaintext.
- **Authz engine** — the heart of the system, all pure and fast:
  - `permissions.test.ts`: the path matcher (`*` / `**` / `me` / `my-dept` / `<prefix>-*`), the
    read<write<admin ladder, deny-wins, and **fail-closed** on unknown.
  - `grants.test.ts`: every role parses to a valid `Grant`; sensitive sub-resources are opt-in.
  - `access.test.ts`: list-scope (`all` / `dept` / `own`) derived from the grant.
  - `codes.test.ts`: hierarchical-code compose/parse and boundary match (no `04-002` vs `04-002x` leak).
  - `manifests.test.ts`: protected-fields / references / owner-refs policy.
  - `authzResolve.test.ts`: request path → permission key.
- **Wire ids**: `idCodec.test.ts` (round-trip, determinism, collection-binding, tamper/length rejection),
  `encodeWireIds.test.ts` / `decodeWireIds.test.ts` (response/request id encoding), `wireRegistry.test.ts`
  (every authz collection is tokenized; round-trips; no cross-decode).
- **Serializer discipline**: standard fields are `path` / `create_time` / `update_time` / `etag` (no
  `uid`); `*Enc` / `national_id` / `bank_details` are NEVER serialized.

Access control is proven by the engine tests above plus the hardening/BOLA suite (`test/bola`, `compileGrants`, `grantExceptions`, `parity`, `listScope`, `cache`); see `docs/authz.md` §16
(route×role parity, cross-employee/cross-dept denial, owner-on-create, list fail-closed). `npm run verify`
runs everything (currently 102 tests passing).

## CI
Gate the build on the single `verify` script. It is enforced in three places: a local git pre-commit
hook (`.husky/pre-commit`, installed by `npm install`), and CI (`.github/workflows/verify.yml`):
```
npm run verify
```
It runs `api:lint` (**`--fail-severity=warn`**, so any spec drift or warning fails), then `typecheck`, then `test`.
