// Roles are data (the `roles` table), so Role is an open string, not a fixed union. Validity is checked at
// runtime: an unknown role resolves to no grant and fails closed. The roles refactor removed every
// switch-on-role, so nothing depends on compile-time exhaustiveness.
export type Role = string;

export type AppUser = {
  uuid: string;
  email: string;
  role: Role;
  // EVERY role this caller holds - the primary above plus any secondary ones (db/schema.ts `user_roles`), with
  // the primary first and no duplicates. `role` stays the point-in-time one the audit trail records and the UI
  // labels people by; this is what per-object ROLE rules have to fan out over (middleware/authz.ts
  // `roleSubjects`), or a rule written for somebody's second role silently stops applying to them.
  roles: Role[];
  // Per-rule GUARDS this caller's rules carry - an approval limit, a network fence - keyed by grant pattern
  // (domain/ruleCondition.ts). Consulted
  // by the authz middleware AFTER `decide()` has allowed, and only ever to refuse - a condition can subtract
  // from a grant, never add to one. Empty for almost everybody.
  guards?: import("./domain/ruleCondition").GuardIndex;
  status: "active" | "disabled";
  employeeId: string | null;
  employeeCode: string | null; // the caller's employee code (the dept-scope key), joined at auth - free for authz
  name: string | null; // the caller's display name, joined at auth (free) - stamped onto audit rows as a point-in-time snapshot
  grant: import("./domain/permissions").Grant; // the caller's role grant, loaded on the auth read - the decision reads this, never the DB
  policy: import("./domain/manifests").Policy; // global body-AC manifest (protected fields + refs), carried on the auth read
  reqMeta?: { ip?: string; ua?: string }; // per-request client metadata, set in middleware, recorded by audit()
  // Identifies the SITTING this request belongs to, for grouping a whole login in the audit trail. Set only on
  // the session-cookie lane; an API key and an Access assertion carry no session to group by.
  sessionId?: string;
  // The grant PATTERN that authorized this request (`compensation.**`), set by the authz middleware once the
  // decision is made and recorded on every audit row the request writes. Absent on a denial - the refusal
  // names its own pattern in the problem detail instead.
  authorizedBy?: string;
  // How far that pattern actually REACHED on this request: the caller's own record (`self`), inside their own
  // department (`dept`), or beyond it (`wider`). Counted per pattern in `rule_usage` so an access review can
  // distinguish a rule that genuinely needs org-wide breadth from one nobody has ever used beyond their team.
  // Absent on a denial, and on any request that resolved to no item (there is no row to classify).
  authorizedScope?: "self" | "dept" | "wider";
  // Set true by audit() (request-actor path) so the authz write backstop knows the handler already logged this
  // request and skips its generic activity row. Reset per request in authz (batch reuses one user object).
  audited?: boolean;
  // Present ONLY on a "view as" simulation (lib/viewAs.ts): this whole AppUser is the SIMULATED subject, and
  // this field carries the real access admin driving it. Audit rows are written against the real human (with
  // the simulated email as `viewing_as` meta), so the trail never credits a read to the person being watched.
  // `grant` + `employeeCode` are the REAL caller's own authority, carried so the authz middleware can ask them
  // the same question it just answered for the subject: a simulation may never read what the admin driving it
  // could not have read as themselves (lib/viewAs.ts, rail 2).
  simulatedBy?: {
    uuid: string;
    email: string;
    employeeId: string | null;
    employeeCode: string | null;
    name: string | null;
    sessionId?: string;
    grant: import("./domain/permissions").Grant;
  };
  // Present ONLY when the caller authenticated with an API key (middleware/auth.ts). The principal is still
  // the key's OWNER - `grant` above has already been narrowed by the key's scope - so nothing downstream has
  // to special-case machine callers to be safe. This field exists for the three places that legitimately
  // care: the authz ceiling gate (a second check that survives per-object rule merges), audit attribution
  // (the trail must distinguish a human from their key), and the rules a key may not perform at all
  // (simulating another user, minting further keys).
  apiKey?: { uuid: string; code: string | null; name: string; prefix: string; scope: import("./domain/keyScope").KeyScope };
};

export type Bindings = {
  DB: D1Database;
  DOCS: R2Bucket;
  // Workers AI. OPTIONAL: absent = no AI layer, and every feature that would have used one falls back to what
  // the app did before it (FTS search, a manual pick, no draft button). Which models may be called is an
  // allowlist in domain/aiPolicy.ts, not a matter of what this binding will accept - it will proxy external
  // providers, and that is the one thing the AI layer must never do with employee data.
  AI?: Ai;
  // Optional AI Gateway id to route inference through, for per-model analytics and a shared cache. Payload
  // logging is suppressed on every call regardless (lib/ai.ts): the gateway records that a call happened, not
  // what was in it. Unset = call the binding directly.
  AI_GATEWAY_ID?: string;
  // The semantic search index. OPTIONAL and independent of `AI`: with no index bound, global search is the
  // FTS5 path it has always been. Holds derived personal data (an embedding is partially invertible), so it
  // is treated as a data store in its own right - what may be put in it is decided by domain/aiPolicy.ts, and
  // what may be read out of it is re-decided in SQL, never by the index's own metadata.
  VEC?: VectorizeIndex;
  // The built SPA in web/dist. Bound so the Worker can decide the SPA fallback itself instead of letting the
  // asset layer answer every miss with index.html - see the notFound handler in src/index.ts.
  ASSETS: Fetcher;
  // Auth is one of two modes, selected by configuration (see routes/authRoutes.ts):
  //  - Access mode (default): Cloudflare Access fronts the app; CF_ACCESS_* are required.
  //  - Google mode: GOOGLE_CLIENT_ID set -> the Worker runs its own Google-OIDC sign-in (no per-seat Access
  //    cost); GOOGLE_CLIENT_SECRET + AUTH_SESSION_KEY are then required and CF_ACCESS_* are not.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_SESSION_KEY?: string; // base64 >=32-byte HMAC key signing the stateless session cookie (lib/session.ts)
  FIELD_ENCRYPTION_KEY: string;
  WIRE_ID_KEY: string; // master key for the wire-id codec (encrypts the internal id -> opaque token)
  // Transactional email. EMAIL_PROVIDER selects the vendor (default "resend"); one of resend|brevo|sendgrid|
  // postmark|mailgun, or "console" to log the message instead of sending it (preview stacks and the browser
  // suite; preflight refuses it for a production deploy). EMAIL_API_KEY is that vendor's secret, EMAIL_FROM
  // the verified sender. EMAIL_REGION is provider-specific (Mailgun sending domain); unused by the rest.
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
  EMAIL_REGION?: string;
  // Divert every outbound message to this ONE address instead of its real recipient. For a staging/rehearsal
  // deploy: `console` proves nothing about whether email works, and a real vendor on a copy of the database
  // mails real employees from a real company address. Preflight makes this a blocking error in production.
  EMAIL_REDIRECT_TO?: string;
  // Optional comma-separated allow-list of email domains permitted to AUTO-PROVISION on first login (e.g.
  // "example.com"). Cloudflare Access is the real perimeter; this is a cheap second net so a misconfigured
  // Access policy can't silently create employee-role users for outside emails. Unset/empty = no restriction.
  ALLOWED_EMAIL_DOMAINS?: string;
  // Optional network fence on the attendance clock: a comma-separated list of individual IPs and/or CIDR
  // blocks (IPv4 and IPv6 may be mixed, e.g. "203.0.113.7, 198.51.100.0/24, 2001:db8::/32") from which
  // `attendance/me:clockIn` / `:clockOut` are accepted - the office networks/VPN. Unset or empty = no fence,
  // punch from anywhere. When set, a punch from anywhere else is 403, and a punch whose client IP cannot be
  // established is refused too (the fence fails closed). It gates only the two self-service punches: an HR
  // attendance-regularization still corrects a missed punch from any network.
  ATTENDANCE_ALLOWED_IPS?: string;
  // E-sign vendor secrets (never in the settings blob). Optional: absent unless an operator wires a provider.
  ESIGN_CASHFREE_CLIENT_ID?: string;
  ESIGN_CASHFREE_CLIENT_SECRET?: string; // also the webhook HMAC key (Cashfree has no separate webhook secret)
  ESIGN_CASHFREE_PUBLIC_KEY?: string; // Cashfree's RSA public key (base64 SPKI or PEM) for the production X-Cf-Signature 2FA header; absent = header not sent
  // Error tracker DSN, for the /diag relay only (routes/diag.ts). Not a secret - the same DSN is baked into
  // the SPA as VITE_SENTRY_DSN, and a DSN only permits writing events. It is here so the Worker knows the one
  // destination it may forward to; unset = the relay 404s and the SPA reports nothing.
  SENTRY_DSN?: string;
  // Which build and which deployment the Worker's own errors belong to. `SENTRY_RELEASE` should be the same
  // string the SPA is built with (VITE_APP_VERSION) so both halves of a trace land on one release;
  // `SENTRY_ENVIRONMENT` separates staging from production in the tracker. Both optional - absent means
  // "unknown release" and environment "production".
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
  // Web Push (browser notifications): a VAPID keypair (base64url, P-256). Optional - absent = push off, the
  // app degrades to the in-app bell + email digest. Generate once per deployment (e.g. `npx web-push
  // generate-vapid-keys`); the public key is also baked into the SPA as VITE_VAPID_PUBLIC_KEY.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string; // "mailto:ops@example.com"; defaults to mailto:EMAIL_FROM
  DEV_FAKE_EMAIL?: string; // local-only; never set in production
  ALLOW_DEV_AUTH?: string; // local-only gate ("true") that must accompany DEV_FAKE_EMAIL; never set in production
  // Internal, never a real Cloudflare binding: set ONLY by the /v1/batch:run handler when it re-dispatches
  // sub-requests in-process. Lets the auth + dbContext middleware reuse the already-resolved caller and Deps
  // instead of re-verifying the JWT and re-deriving the HKDF subkeys (codec/encryptor) per sub-request - the
  // CPU hog that would blow the 10ms budget on a 27-read batch. authz still runs per sub-request, so gating is
  // unchanged. The client cannot set this (it lives on the Worker env, not the request).
  __sharedCtx?: { deps: import("./deps").Deps; user: AppUser };
};

export type Variables = {
  requestId: string; // per-request correlation id, echoed as the x-request-id response header + in 500 logs
  user: AppUser;
  deps: import("./deps").Deps;
  scope: import("./domain/access").ListScope; // list scope for the request's collection, decided by the middleware
  // The matcher context this request was decided in - the caller's employee code plus, when their grant uses
  // the manager-chain tokens, their reporting line (lib/selfContext.ts). Published so a handler can ask the
  // engine a further question in the SAME context rather than resolving the chain again.
  self: import("./domain/permissions").SelfContext;
  // Global search only (`GET /v1/search`): one entry per collection the caller may LIST, holding that
  // collection's list scope. Built by the middleware from the same decide()/scopeFor() it applies to a real
  // list request, so the search service binds scopes to columns and decides nothing. A collection missing
  // from the map is one the caller may not list, and is never queried.
  searchScopes: Map<string, import("./domain/access").ListScope>;
  // Same idea for GET /v1/dashboard-summary: per-collection list scopes for the KPI aggregates, decided by
  // the middleware; the summary service only binds them to COUNT/SUM queries.
  summaryScopes: Map<string, import("./domain/access").ListScope>;
  // Same idea for GET /v1/people-analytics: per-collection list scopes for the per-person measures (leave,
  // punctuality, tasks, goals, reviews, ...), decided by the middleware; the analytics service only binds them
  // to grouped aggregates. A collection missing from the map contributes no column to the report.
  analyticsScopes: Map<string, import("./domain/access").ListScope>;
  // GET /v1/approvals-summary: per-queue APPROVE scopes (not list scopes - the badge counts what the caller may
  // decide on), decided by the middleware. A queue the caller holds the verb in at no scope is absent.
  approvalScopes: Map<string, import("./domain/access").ListScope>;
  // `POST /v1/table-views/{id}:run` (the custom-grid runner): per-collection list scopes for every collection a
  // grid can touch, decided by the middleware from the same decide()/scopeFor() a real list request gets. The
  // runner binds them and decides nothing, so a column whose collection is missing from the map is dropped and
  // the rows behind every column are the caller's own - which is what makes SHARING a view safe.
  tableScopes: Map<string, import("./domain/access").ListScope>;
  // GET /v1/changes: which collections this caller may LIST at all. Names only - the answer is a set of
  // collection names, not rows - so this is the boolean half of searchScopes, decided the same way and costing
  // no read. A collection the caller cannot list is never named in the answer.
  listableCollections: Set<string>;
  // Whether that same caller may read the prior-employer verification queue (`tax-verifications.read`). It is a
  // virtual capability with no table, so it rides a boolean rather than a scope.
  taxVerificationsReadable: boolean;
  // The grant the middleware decided this request with: the role grant merged with any per-object exceptions
  // for the resolved item (item paths) - set so a handler can compute a share-accurate `access.can` hint
  // without re-loading. Absent on collection/non-item paths (the role grant alone applies).
  objectGrant: import("./domain/permissions").Grant;
  // The internal code the middleware resolved the path's item to (null on collection/create paths). Set so a
  // handler can do per-field read redaction off the SAME code the decision used - no second uuid->code lookup.
  itemCode: string | null;
  // The OWNER's employee code for that item, when the collection is flat-coded with an owner column (assets,
  // users - services/codeCascade.ts OWNER_COLUMN_COLLECTIONS). It is the second key the decision was made on
  // (domain/permissions.ts Resolved#ownerResource), carried so the access hint can be computed on the same pair
  // and never advertises less than the request itself allows. Null everywhere else.
  itemOwnerCode: string | null;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
