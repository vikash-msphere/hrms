// Roles are data (the `roles` table), so Role is an open string, not a fixed union. Validity is checked at
// runtime: an unknown role resolves to no grant and fails closed. The roles refactor removed every
// switch-on-role, so nothing depends on compile-time exhaustiveness.
export type Role = string;

export type AppUser = {
  uuid: string;
  email: string;
  role: Role;
  status: "active" | "disabled";
  employeeId: string | null;
  employeeCode: string | null; // the caller's employee code (the dept-scope key), joined at auth - free for authz
  name: string | null; // the caller's display name, joined at auth (free) - stamped onto audit rows as a point-in-time snapshot
  grant: import("./domain/permissions").Grant; // the caller's role grant, loaded on the auth read - the decision reads this, never the DB
  policy: import("./domain/manifests").Policy; // global body-AC manifest (protected fields + refs), carried on the auth read
  reqMeta?: { ip?: string; ua?: string }; // per-request client metadata, set in middleware, recorded by audit()
  // Set true by audit() (request-actor path) so the authz write backstop knows the handler already logged this
  // request and skips its generic activity row. Reset per request in authz (batch reuses one user object).
  audited?: boolean;
};

export type Bindings = {
  DB: D1Database;
  DOCS: R2Bucket;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  FIELD_ENCRYPTION_KEY: string;
  WIRE_ID_KEY: string; // master key for the wire-id codec (encrypts the internal id -> opaque token)
  // Transactional email. EMAIL_PROVIDER selects the vendor (default "resend"); one of resend|brevo|sendgrid|
  // postmark|mailgun. EMAIL_API_KEY is that vendor's secret, EMAIL_FROM the verified sender. EMAIL_REGION is
  // provider-specific (Mailgun sending domain); unused by the rest.
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
  EMAIL_REGION?: string;
  // Optional comma-separated allow-list of email domains permitted to AUTO-PROVISION on first login (e.g.
  // "example.com"). Cloudflare Access is the real perimeter; this is a cheap second net so a misconfigured
  // Access policy can't silently create employee-role users for outside emails. Unset/empty = no restriction.
  ALLOWED_EMAIL_DOMAINS?: string;
  // E-sign vendor secrets (never in the settings blob). Optional: absent unless an operator wires a provider.
  ESIGN_CASHFREE_CLIENT_ID?: string;
  ESIGN_CASHFREE_CLIENT_SECRET?: string; // also the webhook HMAC key (Cashfree has no separate webhook secret)
  ESIGN_CASHFREE_PUBLIC_KEY?: string; // Cashfree's RSA public key (base64 SPKI or PEM) for the production X-Cf-Signature 2FA header; absent = header not sent
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
  // Global search only (`GET /v1/search`): one entry per collection the caller may LIST, holding that
  // collection's list scope. Built by the middleware from the same decide()/scopeFor() it applies to a real
  // list request, so the search service binds scopes to columns and decides nothing. A collection missing
  // from the map is one the caller may not list, and is never queried.
  searchScopes: Map<string, import("./domain/access").ListScope>;
  // The grant the middleware decided this request with: the role grant merged with any per-object exceptions
  // for the resolved item (item paths) - set so a handler can compute a share-accurate `access.can` hint
  // without re-loading. Absent on collection/non-item paths (the role grant alone applies).
  objectGrant: import("./domain/permissions").Grant;
  // The internal code the middleware resolved the path's item to (null on collection/create paths). Set so a
  // handler can do per-field read redaction off the SAME code the decision used - no second uuid->code lookup.
  itemCode: string | null;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
