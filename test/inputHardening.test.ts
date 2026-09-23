import { describe, it, expect } from "vitest";
import { assertPublicHttpsUrl } from "../src/lib/urlGuard";
import { decodeCursor, encodeCursor, clampPageSize } from "../src/http/pagination";
import { buildIcs } from "../src/lib/ics";

// Three guards that all failed the same way: each was written against the CANONICAL spelling of its input and
// let the alternate spellings through. A host has several ways to name 127.0.0.1, a cursor can be any string a
// client sends, and a content line's length is octets rather than characters. These pin the general rule rather
// than the one example each guard originally handled.

describe("webhook SSRF guard: an address is judged as an address, not as a string", () => {
  const blocked = (u: string) => expect(() => assertPublicHttpsUrl(u), u).toThrow(/not permitted/);
  const allowed = (u: string) => expect(() => assertPublicHttpsUrl(u), u).not.toThrow();

  it("blocks loopback and metadata however they are spelled", () => {
    // Dotted quad - the only form a prefix test ever caught.
    blocked("https://127.0.0.1/hook");
    blocked("https://169.254.169.254/latest/meta-data/");
    // IPv4-mapped IPv6: the same addresses wearing a v6 spelling.
    blocked("https://[::ffff:127.0.0.1]/hook");
    blocked("https://[::ffff:169.254.169.254]/hook");
    blocked("https://[::127.0.0.1]/hook");
    // inet_aton legacy notations: hex octet, octal octet, short form, single 32-bit integer.
    blocked("https://0x7f.0.0.1/hook");
    blocked("https://0177.0.0.1/hook");
    blocked("https://127.1/hook");
    blocked("https://2130706433/hook");
    // IPv6 loopback / unspecified / ULA / link-local.
    blocked("https://[::1]/hook");
    blocked("https://[::]/hook");
    blocked("https://[fd00::1]/hook");
    blocked("https://[fe80::1]/hook");
    // NAT64 and 6to4 both EMBED an IPv4 address in a v6 address, so they are the same class as the mapped form:
    // 64:ff9b::/96 carries it in the last 32 bits, 2002::/16 in the next 32. Either one spells the metadata
    // address and loopback in a way that no v6 prefix list would recognise.
    blocked("https://[64:ff9b::a9fe:a9fe]/hook");
    blocked("https://[2002:a9fe:a9fe::1]/hook");
    blocked("https://[2002:7f00:1::1]/hook");
    blocked("https://[2002:c0a8:1::1]/hook"); // 192.168.0.1
    // ...but a 6to4 address wrapping a PUBLIC v4 address is public, so the decomposition must not over-block.
    allowed("https://[2002:808:808::1]/hook"); // 8.8.8.8
    // IPv4-TRANSLATED (::ffff:0:0/96) is the FOURTH embedded-v4 spelling, and it is the one the mapped form's
    // own test cannot see: the `ffff` sits one hextet earlier, so the "top six are zero" check declines it and
    // it used to fall through to the ULA/link-local test, which says nothing about an embedded v4 address.
    blocked("https://[::ffff:0:7f00:1]/hook"); // 127.0.0.1
    blocked("https://[::ffff:0:a9fe:a9fe]/hook"); // 169.254.169.254
    blocked("https://[::ffff:0:c0a8:1]/hook"); // 192.168.0.1
    // Same rule in the other direction: wrapping a public v4 address stays public.
    allowed("https://[::ffff:0:808:808]/hook"); // 8.8.8.8
  });

  it("blocks every private and non-routable IPv4 range", () => {
    for (const h of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1"]) {
      blocked(`https://${h}/hook`);
    }
    // The RFC 5737 documentation ranges. Nothing routes there, and they are the addresses that travel in
    // copied examples - which is how one ends up saved in a rule and quietly never delivering.
    for (const h of ["192.0.2.1", "198.51.100.1", "203.0.113.1"]) blocked(`https://${h}/hook`);
    // 172.15 and 172.32 are OUTSIDE 172.16/12 - the range check must not over-block either. Same for the
    // neighbours of each documentation /24, which are ordinary public space.
    allowed("https://172.15.0.1/hook");
    allowed("https://172.32.0.1/hook");
    allowed("https://192.0.3.1/hook");
    allowed("https://198.51.101.1/hook");
    allowed("https://203.0.114.1/hook");
  });

  // The metadata endpoints that are NOT on the link-local alias. Alibaba's is inside 100.64/10 (which runs to
  // 100.127.255.255) and so was already refused; Oracle Cloud Classic answers on 192.0.0.192, which is not
  // link-local, not RFC1918 and not in that /10 - it read as an ordinary public address until 192.0.0.0/24
  // (IETF protocol assignments, never a webhook target) was blocked as a whole.
  it("blocks cloud metadata addresses that sit outside the link-local alias", () => {
    blocked("https://192.0.0.192/opc/v1/instance/");
    blocked("https://192.0.0.1/hook");
    blocked("https://100.100.100.200/latest/meta-data/"); // Alibaba, via 100.64/10
    // Every alternate spelling of 192.0.0.192, judged as an address like the loopback cases above.
    blocked("https://[::ffff:192.0.0.192]/hook");
    blocked("https://[2002:c000:c0::1]/hook"); // 6to4
    blocked("https://0xc0.0.0.0xc0/hook");
    blocked("https://3221225664/hook");
    // The neighbouring /24s are ordinary public space and must not be caught.
    allowed("https://192.0.1.1/hook");
    allowed("https://191.255.255.255/hook");
    allowed("https://193.0.0.1/hook");
    allowed("https://100.128.0.1/hook"); // just past the end of 100.64/10
  });

  // The v6 counterparts of the v4 ranges above: a documentation prefix that nothing routes to, and a prefix
  // whose entire purpose is to discard. Both read as "some public v6 address" until named.
  it("blocks the IPv6 documentation and discard-only prefixes", () => {
    blocked("https://[2001:db8::1]/hook"); // RFC 3849 documentation
    blocked("https://[2001:db8:1234:5678::abcd]/hook");
    blocked("https://[100::1]/hook"); // RFC 6666 discard-only
    blocked("https://[100::]/hook");
    // Their neighbours are ordinary global unicast and must not be caught: 2001:db9 is outside the /32, and
    // 100:0:0:1:: is outside the discard /64.
    allowed("https://[2001:db9::1]/hook");
    allowed("https://[2001:4860:4860::8888]/hook"); // Google public DNS
    allowed("https://[100:0:0:1::1]/hook");
  });

  it("blocks internal-only names and bare hostnames", () => {
    for (const h of ["localhost", "metadata", "metadata.google.internal", "vault.internal", "printer.local", "db.home.arpa", "intranet"]) {
      blocked(`https://${h}/hook`);
    }
  });

  it("still admits an ordinary public https endpoint", () => {
    allowed("https://hooks.example.com/services/abc");
    allowed("https://8.8.8.8/hook");
    expect(assertPublicHttpsUrl("https://hooks.example.com/x?y=1").pathname).toBe("/x");
  });

  // A public HOST is not a public SERVICE: a name that resolves publicly can still front an internal
  // admin/metrics/database listener on its own port, and the port is part of what the author writes.
  it("refuses a non-default port even on a public host", () => {
    for (const p of [":8080", ":9200", ":6379", ":8443", ":1"]) {
      expect(() => assertPublicHttpsUrl(`https://hooks.example.com${p}/hook`), p).toThrow(/default https port/);
    }
    allowed("https://hooks.example.com:443/hook"); // the default, written out
  });

  it("refuses anything that is not https", () => {
    expect(() => assertPublicHttpsUrl("http://hooks.example.com/x")).toThrow(/https/);
    expect(() => assertPublicHttpsUrl("file:///etc/passwd")).toThrow(/https/);
    expect(() => assertPublicHttpsUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("list cursor: a forged page_token reads as no cursor, never as NaN", () => {
  it("round-trips a real cursor", () => {
    const t = encodeCursor(1_760_000_000_000, "abcdefghijklm");
    expect(decodeCursor(t)).toEqual({ createTimeMs: 1_760_000_000_000, uid: "abcdefghijklm" });
  });

  it("rejects garbage instead of handing NaN to the query", () => {
    // Each of these used to decode to { createTimeMs: NaN, uid: "" }, and keysetPage bound `new Date(NaN)`
    // straight into the keyset comparison - a 500 on a value any client can send.
    for (const t of ["!!!!", "Zm9vfGJhcg", "fHVpZA", "MTIzNA", ""]) {
      const cur = decodeCursor(t);
      if (cur !== null) expect(Number.isFinite(cur.createTimeMs), t).toBe(true);
    }
    expect(decodeCursor(Buffer.from("notanumber|abc").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("1760000000000").toString("base64url"))).toBeNull(); // no uid half
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("caps a page at what the server will actually grant", () => {
    expect(clampPageSize(200)).toBe(100);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(undefined)).toBe(50);
  });
});

describe("iCalendar folding: 75 OCTETS, not 75 characters", () => {
  const lines = (ics: string) => ics.split("\r\n");
  const octets = (s: string) => new TextEncoder().encode(s).length;

  it("keeps every content line inside the octet limit for non-ASCII text", () => {
    // A Devanagari holiday name is three bytes per character, so counting characters produced lines of up to
    // 225 octets - which a strict parser is entitled to reject.
    const name = "गणेश चतुर्थी उत्सव सार्वजनिक अवकाश दिवस मुंबई कार्यालय";
    const ics = buildIcs([{ uid: "h1@hrms", start: "2026-09-14", end: "2026-09-14", summary: name }], "छुट्टियाँ", 0);
    for (const l of lines(ics)) expect(octets(l), l).toBeLessThanOrEqual(75);
  });

  it("unfolds back to the original text", () => {
    const name = "गणेश चतुर्थी उत्सव सार्वजनिक अवकाश दिवस मुंबई कार्यालय";
    const ics = buildIcs([{ uid: "h1@hrms", start: "2026-09-14", end: "2026-09-14", summary: name }], "Holidays", 0);
    // RFC 5545 unfolding: remove every CRLF followed by a single space.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`SUMMARY:${name}`);
  });

  it("leaves a short ASCII line untouched", () => {
    const ics = buildIcs([{ uid: "h1@hrms", start: "2026-01-26", end: "2026-01-26", summary: "Republic Day" }], "Holidays", 0);
    expect(lines(ics)).toContain("SUMMARY:Republic Day");
    for (const l of lines(ics)) expect(octets(l), l).toBeLessThanOrEqual(75);
  });

  it("still escapes the delimiters that would otherwise forge properties", () => {
    const ics = buildIcs([{ uid: "h1@hrms", start: "2026-01-26", end: "2026-01-26", summary: "A;B,C\nDTSTART:19700101" }], "Holidays", 0);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("SUMMARY:A\\;B\\,C\\nDTSTART:19700101");
    // One DTSTART per event: the injected one is inert text inside SUMMARY, not a second property.
    expect(unfolded.match(/^DTSTART/gm)).toHaveLength(1);
  });
});
