// SSRF guard for outbound automation webhook URLs. An automation `webhook` action carries an author-supplied
// URL; before any egress we require https and a PUBLIC host, blocking loopback, link-local, private ranges,
// and internal-only suffixes. This is enforced regardless of whether a WebhookSender is wired, so enabling
// egress later cannot turn an authored rule into an SSRF/exfiltration primitive.

// Loopback / link-local / RFC1918 (except 172.16/12, checked numerically below) / IPv6 ULA + loopback.
const BLOCKED_HOST_RE = /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|::1$|fc|fd|fe80)/i;

export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("webhook url is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("webhook url must use https");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST_RE.test(host)) throw new Error("webhook url host is not permitted");
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) throw new Error("webhook url host is not permitted");
  if (!host.includes(".")) throw new Error("webhook url host is not permitted"); // bare hostname / metadata alias
  // 172.16.0.0/12
  const m = /^172\.(\d{1,3})\./.exec(host);
  if (m && +m[1]! >= 16 && +m[1]! <= 31) throw new Error("webhook url host is not permitted");
  return u;
}
