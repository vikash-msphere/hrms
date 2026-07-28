// Trusted CA ROOT certificates that decide whether a signed PDF verifies as VALID (green) or UNKNOWN (amber).
// A signature whose chain does not terminate at one of these roots is shown as "unknown", never a false "valid".
//
// IMPORTANT (learned the hard way with PKI.js): trust anchors must be ROOTS ONLY. Do NOT put intermediate CA
// certs here - PKI.js path-building fails when an intermediate is in the trusted set. Intermediates are already
// embedded in every eSign PDF's CMS, so the chain reaches these roots on its own; nothing else is needed.
//
// Two tiers, because eMudhra/CCA run SEPARATE test (sandbox) and production hierarchies. Sandbox roots are
// trusted ONLY in a dev/sandbox build - a production build never trusts a sandbox-signed document.

// Production CCA root(s). Anchor real Aadhaar-eSign documents here. Add the current CCA India production root
// (from https://cca.gov.in -> Repository) - e.g. "CCA India 2022". Until one is present, production-signed
// documents verify as UNKNOWN (amber), which is the correct, honest fallback.
const PROD_ROOT_PEMS: string[] = [
  // `-----BEGIN CERTIFICATE-----\n…CCA India 2022 root…\n-----END CERTIFICATE-----`,
];

// Sandbox/test CCA root: "CCA India Test 2020" (the self-signed root of eMudhra's eSign OTP test hierarchy).
// Trusted ONLY when the app runs in dev or an explicitly sandbox build (see `allowSandbox`).
const SANDBOX_ROOT_PEMS: string[] = [
  `-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIIOGbxM6jA1q8wDQYJKoZIhvcNAQELBQAwPzELMAkGA1UE
BhMCSU4xEjAQBgNVBAoTCUluZGlhIFBLSTEcMBoGA1UEAxMTQ0NBIEluZGlhIFRl
c3QgMjAyMDAeFw0yMDA0MjIxMjE4MDBaFw0zMDA0MjIxMjE4MDBaMD8xCzAJBgNV
BAYTAklOMRIwEAYDVQQKEwlJbmRpYSBQS0kxHDAaBgNVBAMTE0NDQSBJbmRpYSBU
ZXN0IDIwMjAwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDOV8DH0qpi
666ZjDUw3ZSldWSV/tY2uZ589pxjueD0Ijz0WuETWeVIWD3+RKnmDfAwr1X8/R+r
wCsuRxl15L4yt2rhTtbDJ0p7CNlvSjfl3JnVwZHKaA3y+0ssUZ2GZ5ZOrujoG3aO
oM8bPQsY1d7giEbXYm9ZiQjOT4oEcNtUCwz1Qs76NY9yRuzsWguB8jjZHO9uvim8
aBLadz/KTeNfBO7eCCbs+ZdKgUCv6oFAqxEJA+JKeL9bwniiMTXlZB2D35DPNNC/
EqIjRMXdVg5o241nHpgcczg52HYcgWrsH4h7RUq8HmcMCi4mJtNuuDu3Q3V95uo4
misW/GbvzYdFAgMBAAGjPzA9MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFGlF
YIpMmt4Y/tojpFnQoFZFtvRVMAsGA1UdDwQEAwIBBjANBgkqhkiG9w0BAQsFAAOC
AQEAmHcVXa/7wdlS5x3wxncvahKBOkgftYpW1uKPfNt91R6KrZjv6C9km6UY5i1E
PvNWmfsIjMXQXFDmua8tkQLyVlzeb3hjst76hmRC+s5+Uq02LRLCRv/+sJR77Z6m
KzB9rZtmM7xCLiqVgh9nHheskCA8jKslqbWWk44ZD6rvHmPN3HRZepqhPaTF8sqG
z2uLH2z6DBxpaxz/SdBq7Hu40GlOR0N0yawTvjzLk2AwxU7ConGSSTKD/Bx7XRO/
gZLb3DrqYuKDpHwLJ6JQcwSHMSmzRjOufjrOFiQAykLYBprzlesEyxllcg1R2UIu
4z13uq5yGD0V+sbs/G4SLn6CoQ==
-----END CERTIFICATE-----`,
];

// Trust sandbox roots only in dev (Vite `import.meta.env.DEV`) or when a build explicitly opts in via
// `VITE_ESIGN_ALLOW_SANDBOX=true`. A normal production build trusts prod roots only.
function allowSandbox(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    return env?.DEV === true || env?.VITE_ESIGN_ALLOW_SANDBOX === "true";
  } catch { return false; }
}

export const TRUSTED_ROOT_PEMS: string[] = [...PROD_ROOT_PEMS, ...(allowSandbox() ? SANDBOX_ROOT_PEMS : [])];
