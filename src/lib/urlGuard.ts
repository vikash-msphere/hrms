// SSRF guard for outbound automation webhook URLs. An automation `webhook` action carries an author-supplied
// URL; before any egress we require https, the default https PORT, and a PUBLIC host, blocking loopback,
// link-local, private ranges, the cloud metadata endpoints that sit outside them, and internal-only suffixes.
// This is enforced regardless of whether a WebhookSender is wired, so enabling egress later cannot turn an
// authored rule into an SSRF/exfiltration primitive.
//
// The host is PARSED INTO AN ADDRESS before it is judged, rather than prefix-matched as a string. Every blocked
// address has several spellings - `[::ffff:127.0.0.1]` is loopback, `0x7f.0.0.1` and `0177.0.0.1` are 127.0.0.1,
// `127.1` is too - and a prefix test only catches the canonical dotted-quad one. Normalising first means the
// range checks below are stated once and hold for all of them.
//
// KNOWN LIMIT, deliberately not claimed above: a hostname that RESOLVES to a private address (DNS rebinding)
// passes. A Worker cannot resolve DNS itself, so there is nothing to check against; what this guard rules out
// is an author naming an internal address directly.
//
// AND WHAT THE CALLER STILL OWES: this judges ONE url. `fetch` follows redirects by default, so a host that
// passes here can answer 302 and send the request somewhere that never would - the guard sees the first hop
// only. Anything fetching a URL this blessed must either pass `redirect: "manual"` or re-check every hop
// through here (see services/esign/cashfree.ts#downloadSigned). The same applies to credentials: only
// `Authorization` is stripped across an origin change, so a custom auth header follows a redirect to whoever
// answers it, and a redirect target must be fetched without one.

/** Parse one IPv4 octet in any of the notations `inet_aton` accepts (decimal, 0x-hex, leading-zero octal). */
function octet(s: string): number | null {
  if (!s.length) return null;
  const n = /^0[xX][0-9a-fA-F]+$/.test(s) ? parseInt(s, 16) : /^0[0-7]+$/.test(s) ? parseInt(s, 8) : /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The 32-bit value of an IPv4 host in any legacy notation, or null if it is not an IPv4 literal at all.
 * Handles the short forms too: `127.1` is a.d (last part fills the remaining octets), `2130706433` is one
 * 32-bit number.
 */
function ipv4Value(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums = parts.map(octet);
  if (nums.some((n) => n === null)) return null;
  const vals = nums as number[];
  // The final part absorbs every octet the earlier parts did not name; the earlier ones must each fit a byte.
  const lead = vals.slice(0, -1);
  const tail = vals[vals.length - 1]!;
  if (lead.some((v) => v > 0xff)) return null;
  const tailWidth = 4 - lead.length;
  if (tail >= 2 ** (8 * tailWidth)) return null;
  return lead.reduce((acc, v, i) => acc + v * 2 ** (8 * (3 - i)), 0) + tail;
}

/** Is this 32-bit IPv4 value one we refuse to talk to? */
function blockedIpv4(v: number): boolean {
  const a = (v >>> 24) & 0xff;
  const b = (v >>> 16) & 0xff;
  const c = (v >>> 8) & 0xff;
  const d = v & 0xff;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // private
    a === 127 || // loopback
    // 100.64/10 carrier-grade NAT: 100.64.0.0 - 100.127.255.255. This also covers Alibaba Cloud's instance
    // metadata service at 100.100.100.200, which is the one major provider that does not answer on the
    // link-local alias below - worth knowing, because the address looks public until the /10 is worked out.
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || // link-local, incl. the 169.254.169.254 metadata alias
    (a === 172 && b >= 16 && b <= 31) || // private
    // 192.0.0.0/24 is IETF protocol assignments - not a host anyone routes to on purpose, and it carries
    // Oracle Cloud Classic's metadata endpoint at 192.0.0.192. It is the one metadata address in common use
    // that no other line here covers: it is not link-local, not RFC1918, and not inside the /10 above, so it
    // read as an ordinary public address. Blocked as the whole /24, since nothing in it is a webhook target.
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    // The three documentation ranges (RFC 5737): 192.0.2/24, 198.51.100/24, 203.0.113/24. Nothing routes
    // there, so a webhook naming one is a typo or a probe either way - and they are the addresses that appear
    // in copied-and-pasted examples, which is exactly how one ends up saved in a rule.
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + reserved
  );
}

/**
 * Expand an IPv6 literal into its eight 16-bit hextets, or null if it is not one.
 *
 * Needed because `URL` NORMALISES the address before we see it: `[::ffff:127.0.0.1]` arrives as
 * `::ffff:7f00:1`, so any check written against the dotted-quad spelling never fires. Comparing numbers
 * instead of text is what makes every spelling of an address answer the same way.
 */
function ipv6Hextets(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const [head, tail, ...rest] = host.split("::");
  if (rest.length) return null; // at most one "::"
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      // A trailing dotted-quad is legal in the source text even if URL usually rewrites it.
      if (part.includes(".")) {
        const v = ipv4Value(part);
        if (v === null) return null;
        out.push((v >>> 16) & 0xffff, v & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const left = parse(head ?? "");
  if (!left) return null;
  if (tail === undefined) return left.length === 8 ? left : null;
  const right = parse(tail);
  if (!right) return null;
  const gap = 8 - left.length - right.length;
  if (gap < 0) return null;
  return [...left, ...Array(gap).fill(0), ...right];
}

/** Names that are never a public host, whatever they resolve to. */
const BLOCKED_NAMES = /^(localhost|metadata|metadata\.google\.internal)$/i;
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"];

export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("webhook url is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("webhook url must use https");
  // Only the https default port. Requiring a PUBLIC host says nothing about which service on it answers: a name
  // that resolves publicly can still front an internal admin/metrics/database listener on its own port, and an
  // author who may write a webhook URL would be choosing that port. A real third-party webhook endpoint is on
  // 443, so the host check and the port check together mean "a public host's public https service".
  if (u.port !== "" && u.port !== "443") throw new Error("webhook url must use the default https port");
  const reject = () => {
    throw new Error("webhook url host is not permitted");
  };
  // `URL` keeps IPv6 hosts bracketed; strip them so one code path judges the address either way.
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) reject();

  const h6 = ipv6Hextets(host);
  if (h6) {
    const [a, b, c, d, e, f, g, i] = h6 as [number, number, number, number, number, number, number, number];
    const topSix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
    // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) are v4 addresses in a v6 spelling, so
    // they are judged by the v4 rules - this is the whole class a string prefix test always missed.
    if (topSix && (f === 0xffff || f === 0)) {
      const v4 = ((g << 16) | i) >>> 0;
      // `::` and `::1` are the unspecified and loopback addresses, not 0.0.0.0/0.0.0.1 - still blocked, and
      // blockedIpv4 already refuses a leading zero octet, so both paths agree.
      if (blockedIpv4(v4)) reject();
      return u;
    }
    // IPv4-TRANSLATED (`::ffff:0:a.b.c.d`, RFC 6145 ::ffff:0:0/96). The fourth embedded-v4 spelling, and the
    // one the `topSix` test above cannot reach: the `ffff` sits in hextet FIVE here, not six, so `e` is not 0
    // and the mapped/compatible branch declines it. It then fell past NAT64 and 6to4 to the unique-local /
    // link-local / multicast test, which says nothing about an embedded v4 address - so `::ffff:0:7f00:1` was
    // blessed as "some public v6 address" while being loopback written the long way. Judged by the v4 rules
    // like its three siblings; the list of spellings is only correct if it is complete.
    if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) {
      if (blockedIpv4(((g << 16) | i) >>> 0)) reject();
      return u;
    }
    // 64:ff9b::/96 is the well-known NAT64 prefix: the last 32 bits are an IPv4 address that a NAT64 gateway
    // translates to. It is a v4 address in a v6 spelling exactly like the two above, so it is judged by the v4
    // rules rather than being waved through as "some public v6 address".
    if (a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
      if (blockedIpv4(((g << 16) | i) >>> 0)) reject();
      return u;
    }
    // 2002::/16 is 6to4: the NEXT 32 bits are the IPv4 address of the tunnel endpoint, so `2002:a9fe:a9fe::1`
    // is the cloud metadata address wearing a v6 spelling. Same embedded-v4 class as the mapped/compatible/
    // NAT64 forms above, judged by the v4 rules rather than waved through as "some public v6 address".
    if (a === 0x2002) {
      if (blockedIpv4(((b << 16) | c) >>> 0)) reject();
      return u;
    }
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00) reject();
    // 100::/64 is the discard-only prefix (RFC 6666): a black hole, so nothing is ever there to webhook.
    if (a === 0x0100 && b === 0 && c === 0 && d === 0) reject();
    // 2001:db8::/32 is the documentation range (RFC 3849) - the v6 counterpart of the three v4 doc ranges
    // blockedIpv4 already refuses, and blocked for the same reason: nothing routes there, so a rule naming one
    // is a copied example or a probe, and examples are exactly how such an address ends up saved.
    if (a === 0x2001 && b === 0x0db8) reject();
    return u;
  }
  if (host.includes(":")) reject(); // colon-bearing but not a parseable IPv6 literal

  const v4 = ipv4Value(host);
  if (v4 !== null) {
    if (blockedIpv4(v4)) reject();
    return u;
  }

  // A name, not an address.
  if (BLOCKED_NAMES.test(host)) reject();
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) reject();
  if (!host.includes(".")) reject(); // bare single-label hostname is internal by definition
  return u;
}
