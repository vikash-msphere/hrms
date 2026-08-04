# 01 — Strict Resource-Oriented API Guidelines (AEP / aep.dev)

These rules are **binding**. They are enforced by the official `@aep_dev/aep-openapi-linter`
(`npm run api:lint`). Every endpoint lives in `openapi.yaml` (the source of truth) and is
implemented to match. The conventions below were verified by running the real linter to zero findings.

> Golden rule: **AEP shapes the wire contract, not your storage.** Keep DB columns as they are
> (`id`, `createdAt`, camelCase); produce AEP resources (`path`, `create_time`, snake_case) in
> `src/http/serialize.ts`. Never return a raw DB row, and never serialize encrypted columns.

## 1. Resources, not RPCs
Model every concept as a **resource** with a collection. The API is resources + standard methods,
plus a small set of **custom methods**. No verb-y paths.

## 2. Casing — exact, and easy to get wrong
| Place | Casing | Example |
|---|---|---|
| Schema component key | camelCase singular | `employee`, `payrollRun`, `leaveRequest` |
| Wire field names | snake_case | `first_name`, `work_email`, `create_time`, `next_page_token` |
| Resource identity field | `path` (a string) | `employees/{employee_id}` |
| URL collection segment | kebab-case plural | `/v1/employees`, `/v1/payroll-runs`, `/v1/leave-types` |
| Path parameter | `{snake_id}` | `/v1/employees/{employee_id}` |
| `x-aep-resource.singular`/`plural` | kebab-case | `payroll-run` / `payroll-runs` |
| `x-aep-resource.type` | `domain/<singular-kebab>` | `hrms.example.com/payroll-run` |

The identity field is **`path`**, NOT `name`. The id segment inside `path` (and every reference) is an
**opaque, encrypted wire token** (`idCodec.encode(collection, uuid)`, ~26 chars): routes and services work
in the internal `uuid`, and the middleware encodes ids outbound (`encodeWireIds`) and decodes them inbound
(`decodeWireIds`). The identity model (internal `uuid` PK + hierarchical scope `code` + wire token) is in
`docs/authz.md` (§2).

## 3. Every resource schema carries `x-aep-resource`
```yaml
employee:
  type: object
  required: [first_name, last_name, work_email]
  properties:
    path:
      type: string
      description: The server-assigned path of the resource, unique within the service.
    create_time: { type: string, format: date-time, readOnly: true }
    update_time: { type: string, format: date-time, readOnly: true }
    etag: { type: string, readOnly: true }
    first_name: { type: string }
    last_name: { type: string }
    work_email: { type: string, format: email }
  x-aep-resource:
    singular: employee
    plural: employees
    patterns:
      - 'employees/{employee_id}'        # ALWAYS quote patterns containing {…}
    type: hrms.example.com/employee
```
**Standard fields:** `path`, `create_time`, `update_time`, `etag` (the last three are `readOnly`).
Lifecycle resources also carry a read-only `state`.

## 4. Standard methods (exact shapes)
For collection `employees` (schema key `employee`), all paths under `/v1`:

| Method | HTTP | Request | Response | operationId |
|---|---|---|---|---|
| List | `GET /v1/employees` | query `max_page_size`, `page_token` | `{ results: [...], next_page_token }` | `ListEmployees` |
| Get | `GET /v1/employees/{employee_id}` | — | resource | `GetEmployee` |
| Create | `POST /v1/employees` | optional `?id`; body `application/json` | resource | `CreateEmployee` |
| Update | `PATCH /v1/employees/{employee_id}` | body `application/merge-patch+json` | resource (merge-patch ct) | `UpdateEmployee` |
| Delete | `DELETE /v1/employees/{employee_id}` | — | `204` | `DeleteEmployee` |

- **List is always paginated** (`max_page_size` + `page_token` → `results` + `next_page_token`). Never an unbounded array.
- **Update is JSON Merge Patch**: content type `application/merge-patch+json`. A field present = set; explicit `null` = clear; absent = unchanged. **No `updateMask` query parameter.**

## 5. Custom methods (`:verb`)
Non-CRUD actions are `POST /v1/<collection-kebab>/{snake_id}:verbCamel`. The verb is lowerCamelCase;
`operationId` is `":VerbResource"` (leading colon + Capitalized), e.g. `":ApprovePayrollRun"`.
Put the path parameter **inside the operation's `parameters`**, not at path-item level.

```yaml
/v1/payroll-runs/{payroll_run_id}:approve:
  post:
    description: "Custom method approve for payroll-run."
    operationId: ":ApprovePayrollRun"
    parameters: [ { in: path, name: payroll_run_id, required: true, schema: { type: string } } ]
    responses:
      '200': { description: Successful response, content: { application/json: { schema: { $ref: '#/components/schemas/payroll-run' } } } }
      '400': { $ref: '#/components/responses/Problem' }
      '500': { $ref: '#/components/responses/Problem' }
```

## 6. Long-running operations (LRO, AEP-151)
Async work (payslip generation, big exports) returns a **202** with an `operation` resource, and the
service **must** define an operations endpoint with BOTH List and Get. The linter string-matches the
paths, so they must be exactly:

- `GET /v1/operations` (List)
- `GET /v1/operations/{operation}` (Get) — note the parameter is literally `{operation}`.

```yaml
/v1/payroll-runs/{payroll_run_id}:publish:
  post:
    description: "Custom method publish: publishes the run and starts payslip generation."
    operationId: ":PublishPayrollRun"
    parameters: [ { in: path, name: payroll_run_id, required: true, schema: { type: string } } ]
    responses:
      '202':
        description: Accepted; returns a long-running operation.
        content: { application/json: { schema: { $ref: '#/components/schemas/operation' } } }
      '400': { $ref: '#/components/responses/Problem' }
      '500': { $ref: '#/components/responses/Problem' }
```
The `operation` resource: `{ path, done, response, error }`. In code the `jobs` row IS the operation
(see `src/services/payroll.ts` and `src/routes/operations.ts`).

## 7. Errors — RFC 9457 problem details (AEP-193)
Every error uses `application/problem+json` with this object (NOT a `{error:{code,...}}` shape):
```yaml
Problem:
  title: An RFC 9457 problem object
  type: object
  properties:
    type: { type: string, format: uri-reference }
    title: { type: string }
    status: { type: integer, minimum: 100, maximum: 599 }
    detail: { type: string }
    instance: { type: string, format: uri-reference }
```
Reference it as a shared response:
```yaml
components:
  responses:
    Problem:
      description: Error
      content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
```
Implemented in `src/lib/errors.ts` + `src/middleware/errorHandler.ts`.

## 8. Concurrency
Expose `etag`; accept an **optional** `If-Match` header on Update/Delete/state-changing methods
(keep it optional — required non-path params upset the linter). Mismatch → 409 (Aborted).

## 9. References by `path`
A field that points to another resource is a `path` string (e.g. an employee's `manager` is
`employees/{employee_id}`), not an embedded object or bare id.

## 10. Document-level requirements
- `/v1` prefix on every path key; bare host in `servers`.
- Every operation needs a non-empty `description`; `info` needs `description` + `contact`.

---

## YAML hazards that crash the linter (learned the hard way)
The linter throws `Cannot read properties of null (reading 'enum')` when the OpenAPI document is
secretly malformed by inline flow-mapping syntax:

1. **Comma inside an inline `{ }` description.**
   - BAD:  `path: { type: string, description: The path, unique here. }`
     → YAML reads the comma as a separator and creates a bogus null-valued key.
   - GOOD: write the description in block style, or quote it, or remove commas:
     ```yaml
     path:
       type: string
       description: The server-assigned path of the resource, unique within the service.
     ```
2. **`{` inside an inline flow-sequence**, e.g. `patterns: [ employees/{employee_id} ]` → always quote:
   `patterns:` then `  - 'employees/{employee_id}'`.
3. For enum-like fields, prefer documenting allowed values **without commas**
   (`State value DRAFT/REVIEW/APPROVED`) or use a real `enum:` array in block style.

## Adding/maintaining the spec
- Add or change an endpoint in `openapi.yaml` **first**, then `npm run api:types`, then implement.
- `npm run api:lint` (which runs at `--fail-severity=warn`) must pass before you continue.
- Caller identity comes through the contract as the `users` self-alias: **`GET /v1/users/me`** returns
  the caller's own `user` resource.
