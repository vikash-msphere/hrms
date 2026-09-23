// Trusted CA ROOT certificates that decide whether a signed PDF verifies as VALID (green) or UNKNOWN (amber).
// A signature whose chain does not terminate at one of these roots is shown as "unknown", never a false "valid".
//
// IMPORTANT (learned the hard way with PKI.js): trust anchors must be ROOTS ONLY. Do NOT put intermediate CA
// certs here - PKI.js path-building fails when an intermediate is in the trusted set. Intermediates are already
// embedded in every eSign PDF's CMS, so the chain reaches these roots on its own; nothing else is needed.
//
// Two tiers, because eMudhra/CCA run SEPARATE test (sandbox) and production hierarchies. Sandbox roots are
// trusted ONLY in a dev/sandbox build - a production build never trusts a sandbox-signed document.

// Production CCA root(s). Anchor real Aadhaar-eSign documents here. Until one is present, production-signed
// documents verify as UNKNOWN (amber), which is the correct, honest fallback: the INTEGRITY half of
// verification still works with no roots at all (a tampered file is still shown red), but nothing can attest
// to WHO signed - so a genuine Aadhaar signature and a self-signed one look identical.
//
// Which certificate: don't guess, read it off a real document. `node --import ./scripts/tsResolve.mjs
// scripts/esignChain.ts <signed.pdf>` walks the chain embedded in one of your provider's signed PDFs and
// names the exact issuer it terminates at (e.g. "CCA India 2022"). Fetch that certificate from
// https://cca.gov.in -> Repository, check its published SHA-256 fingerprint against a second independent
// source, and paste the PEM below. Documents are verified as of their SIGNING time, so keeping older roots
// here alongside the current one is what lets years-old documents still verify.
// "CCA India 2022" - the Root Certifying Authority of India's current production root (RSA 4096, SHA-256,
// CA:TRUE + keyCertSign, valid 2022-02-02 -> 2042-02-02, serial 762433ebdb26765a8560cd0aa82fe117).
// SHA-256 fingerprint, pinned by test/ccaRoots.test.ts so this anchor cannot be swapped unnoticed:
//   9A:3F:D3:17:67:98:E8:42:DD:CB:12:C2:62:F1:1C:FA:CC:A7:0A:8B:84:C6:EA:6F:DA:30:84:2A:95:A9:4C:D8
// Exported so test/ccaRoots.test.ts can pin it by fingerprint: this is the set a PRODUCTION build trusts,
// and it is the half that must never change by accident (TRUSTED_ROOT_PEMS additionally carries the sandbox
// root under dev, so asserting on that alone could not tell the two apart).
export const PROD_ROOT_PEMS: string[] = [
  `-----BEGIN CERTIFICATE-----
MIIFNDCCAxygAwIBAgIQdiQz69smdlqFYM0KqC/hFzANBgkqhkiG9w0BAQsFADA6
MQswCQYDVQQGEwJJTjESMBAGA1UEChMJSW5kaWEgUEtJMRcwFQYDVQQDEw5DQ0Eg
SW5kaWEgMjAyMjAeFw0yMjAyMDIxMjA0MzdaFw00MjAyMDIxMjA0MzdaMDoxCzAJ
BgNVBAYTAklOMRIwEAYDVQQKEwlJbmRpYSBQS0kxFzAVBgNVBAMTDkNDQSBJbmRp
YSAyMDIyMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAv3EBudWC8HY0
oSwtJZCqpjQTGpEewl3EdDqUORV0qoFp78mdR/vuATXI83G7nF9RLvmNjgQgKr/b
Mx6gPO4Y57bMjAsgwEzleFclZka/sqc68iN5rS3huhrCX6MEINLyDOQ71MRA7GJC
aNL6E3j1438eTu011mlikeZYBdkhvfpAVjCw90w8wcWDmqx66Y561T/RiXyz2uEh
BBZAD43gV58eXStOeOTwAzEZYMrmp232GfmQKabYRfdIRus1avyuGea2nICEsRHE
8M2tdzwpGP7oIy2qHBFJJ+3AwmwQA4DjmDkJtCD+58awohQavRNhqjsGD+ZifG3V
R4i6WrKv8OWqZzcZj3g3Elr5+fRMlz1GSqkWPBw1Ev8KWTHazSUKF7OMxm3XzyXx
Qnw7fZF9GOVtx3adpfRPqYGgtbOP34EVkz4wsHvNMrvUrYcKymdOrnkTjlX26fIH
UJpKGYkLk9q0jhMNKs4Rn8lj4pJ7YF33/ND4bjpV0ex1EAQz0iZvT37OnxNiuAZ/
+4Djf075UuNX2ecWnadOrN1r8NAParZIwUoSUnWhU8TqAWWRqzFURHUZuOMQcA0g
eg4c9zqtBoUPgtQksbIAEsEXmDuRpwSIFjEkK11f5Eemfmfdg37KyIjQ67TRTmBA
+kT9Q5JIm/e7m1ILg/HKckgLUOCnAMsCAwEAAaM2MDQwDwYDVR0TAQH/BAUwAwEB
/zARBgNVHQ4ECgQITjtINlziX30wDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEB
CwUAA4ICAQCdbE8d1c1DysKtrtYlApYIXTlY3N2XHNQ6gKoaVWsKa1TJ/ovrT+FV
3bmQLet3aSoEG6pTe/vLZSg8WiF7cn7WuF4XlQS3yA2Uu8/cg/S4owqhQJp6K/Xg
6UoSBad9Kog1H8deOfV8Nmb8a89zB4Yf8/AepId+Lr/3I6O7iub+PUT2QBXnksa+
cf0yf+49GhyMCILZvctNSQd4Vxr9EgRvBARTrAgNQ9sEOJ6myOz4iTFR7T2pIFP8
Cp15e8jEVI1q4IuHu3XlwJNk9f5k3gbwrzoy9P5rP8voQU3u9wh62JZa9U63b+u/
Ur1tsKb5Lx0YUedtHvpIiIRurEPxumW0twjrx8TrAcXRrViSL7dsXAoYC0dXo154
EE8jBAzgIIur7tJizxgXDEn4i2pu8Yd615YML9ii5BooEJ2j6fQ0nzyPRmx1Egw2
Fjlgzzceai4TUOcaCKab86yyu5MZIp+BiPR840nw5MggbRgYH2nFRBA70toVm4VF
lbZs3reGmaICm4ST6R395OxYS1iYBm5kXm9tLb4pkIhUxrkgyuiwE+DsWceBjHAY
aXnCgUGKtiG9tfBMUw3fChoPb9L1yKdNof3zXDdTloMqEpO4BFrmjco8kt1v0LUQ
PhNZmQP4nqd4Hqx2384nPmWDXbQ+eePyxRteYGY0hJeDLVpyeYG8VQ==
-----END CERTIFICATE-----`,
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
