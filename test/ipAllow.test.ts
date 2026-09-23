import { describe, it, expect } from "vitest";
import { parseIpAllowList, ipMatchesAny } from "../src/lib/ipAllow";

// The attendance clock's network fence (ATTENDANCE_ALLOWED_IPS). Two properties matter: it must not admit an
// address outside the configured networks, and a malformed entry must throw rather than quietly match nothing
// (a fence that silently narrows locks the office out with no explanation).

const allows = (list: string, ip: string | null) => ipMatchesAny(ip, parseIpAllowList(list));

describe("ip allow-list: no rules", () => {
  it("empty, whitespace-only and undefined lists parse to no rules (no fence)", () => {
    expect(parseIpAllowList(undefined)).toEqual([]);
    expect(parseIpAllowList("")).toEqual([]);
    expect(parseIpAllowList("  ,  , ")).toEqual([]);
  });
  it("no rules never matches - the caller reads the empty list as 'no fence', not as 'deny'", () => {
    expect(allows("", "203.0.113.7")).toBe(false);
  });
});

describe("ip allow-list: IPv4", () => {
  it("a bare address is an exact host match", () => {
    expect(allows("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(allows("203.0.113.7", "203.0.113.8")).toBe(false);
  });
  it("CIDR blocks match on the prefix, including non-byte-aligned ones", () => {
    expect(allows("198.51.100.0/24", "198.51.100.255")).toBe(true);
    expect(allows("198.51.100.0/24", "198.51.101.0")).toBe(false);
    expect(allows("198.51.100.0/26", "198.51.100.63")).toBe(true);
    expect(allows("198.51.100.0/26", "198.51.100.64")).toBe(false);
    expect(allows("0.0.0.0/0", "8.8.8.8")).toBe(true); // an explicit "anywhere" fence is still a fence
  });
  it("mixes individual addresses and blocks in one list", () => {
    const list = "203.0.113.7, 198.51.100.0/24 , 192.0.2.1";
    expect(allows(list, "203.0.113.7")).toBe(true);
    expect(allows(list, "198.51.100.42")).toBe(true);
    expect(allows(list, "192.0.2.1")).toBe(true);
    expect(allows(list, "192.0.2.2")).toBe(false);
  });
});

describe("ip allow-list: IPv6", () => {
  it("matches compressed, expanded and prefix forms", () => {
    expect(allows("2001:db8::/32", "2001:db8:0:0:0:0:0:1")).toBe(true);
    expect(allows("2001:db8::/32", "2001:db9::1")).toBe(false);
    expect(allows("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(allows("::1", "::1")).toBe(true);
    expect(allows("2001:db8:abcd::/48", "2001:db8:abcd:1234::9")).toBe(true);
    expect(allows("2001:db8:abcd::/48", "2001:db8:abce::9")).toBe(false);
  });
  it("a v4 rule and a v4-mapped v6 client are the same host over two stacks", () => {
    expect(allows("198.51.100.0/24", "::ffff:198.51.100.9")).toBe(true);
    expect(allows("::ffff:198.51.100.9", "198.51.100.9")).toBe(true);
    expect(allows("198.51.100.0/24", "2001:db8::198.51.100.9")).toBe(false); // not v4-mapped, just embedded
  });
  it("v4 and v6 rules never cross-match", () => {
    expect(allows("2001:db8::/32", "203.0.113.7")).toBe(false);
    expect(allows("203.0.113.7", "2001:db8::1")).toBe(false);
  });
});

describe("ip allow-list: fails closed", () => {
  it("an absent or unparseable client IP never matches a configured fence", () => {
    expect(allows("0.0.0.0/0", null)).toBe(false);
    expect(allows("198.51.100.0/24", "")).toBe(false);
    expect(allows("198.51.100.0/24", "not-an-ip")).toBe(false);
    expect(allows("198.51.100.0/24", "198.51.100.9%eth0")).toBe(false); // zone ids are host-specific
  });
  it("rejects a malformed entry instead of narrowing the fence silently", () => {
    for (const bad of [
      "203.0.113.7.9",
      "203.0.113",
      "203.0.113.256",
      "203.0.113.010", // ambiguous leading zero (octal in some resolvers)
      "198.51.100.0/33",
      "198.51.100.0/",
      "198.51.100.0/x",
      "2001:db8::/129",
      "2001:db8:::1",
      "2001:db8:zzzz::1",
      "2001:db8:0:0:0:0:0:0:1",
      "1:2:3:4:5:6:7",
      "office-wifi",
    ]) {
      expect(() => parseIpAllowList(bad), bad).toThrow();
    }
  });
  it("one bad entry rejects the whole list, so a typo can't hide behind a good neighbour", () => {
    expect(() => parseIpAllowList("198.51.100.0/24, 203.0.113.999")).toThrow();
  });
});
