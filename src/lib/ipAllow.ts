// IP allow-list matching for network-fenced actions (today: the attendance clock punches).
//
// An allow-list is a comma-separated string of individual addresses and/or CIDR blocks, IPv4 and IPv6 mixed
// freely - e.g. `203.0.113.7, 198.51.100.0/24, 2001:db8::/32`. A bare address is the /32 (v4) or /128 (v6)
// case, so callers never have to write the full-length prefix.
//
// Parsing is strict and total: `parseIpAllowList` throws on anything it cannot represent, so a typo in a
// deploy var surfaces at Deps construction (src/deps.ts) rather than silently widening or closing the fence.

export type IpRule = { bytes: Uint8Array; bits: number };

// ---------------------------------------------------------------------------------------------------------
// Address parsing

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    // No leading zeros: "010" is octal in some resolvers and decimal in others, and that ambiguity is exactly
    // the kind of thing an allow-list must not carry.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(text: string): Uint8Array | null {
  if (!text.includes(":")) return null;
  // A trailing dotted quad occupies the last two groups (e.g. `::ffff:192.0.2.1`).
  let tail: Uint8Array | null = null;
  let head = text;
  const lastColon = text.lastIndexOf(":");
  const afterLastColon = text.slice(lastColon + 1);
  if (afterLastColon.includes(".")) {
    tail = parseIpv4(afterLastColon);
    if (!tail) return null;
    head = text.slice(0, lastColon + 1) + "0:0"; // placeholder groups, overwritten below
  }

  const halves = head.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once
  const groupsOf = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const left = groupsOf(halves[0]!);
  const right = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (halves.length === 1 && left.length !== 8) return null; // uncompressed form must be exactly 8 groups
  if (left.length + right.length > 8) return null;
  if (halves.length === 2 && left.length + right.length === 8) return null; // "::" must stand for >=1 group

  const groups: number[] = [];
  const push = (g: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
    groups.push(parseInt(g, 16));
    return true;
  };
  for (const g of left) if (!push(g)) return null;
  for (let i = left.length + right.length; i < 8; i++) groups.push(0); // "::" expands to the missing groups
  for (const g of right) if (!push(g)) return null;
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i]! >> 8;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  if (tail) out.set(tail, 12); // the dotted quad replaces the two placeholder groups
  return out;
}

/** Parse a single address (no prefix). Returns 4 bytes for IPv4, 16 for IPv6, or null if unparseable. */
export function parseIp(text: string): Uint8Array | null {
  const t = text.trim();
  if (!t) return null;
  // A bracketed literal (`[2001:db8::1]`) is how a v6 address travels in URLs and some proxy headers.
  const bare = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  if (bare.includes("%")) return null; // link-local zone ids are host-specific and never meaningful here
  return bare.includes(":") ? parseIpv6(bare) : parseIpv4(bare);
}

// ---------------------------------------------------------------------------------------------------------
// Allow-list parsing + matching

/**
 * Parse a comma-separated allow-list into rules. Whitespace around entries is ignored and empty entries are
 * dropped, so `""` yields `[]` (which callers read as "no fence configured"). Throws on a malformed entry.
 */
export function parseIpAllowList(raw: string | undefined): IpRule[] {
  const rules: IpRule[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const e = entry.trim();
    if (!e) continue;
    const slash = e.lastIndexOf("/");
    const addrText = slash === -1 ? e : e.slice(0, slash);
    const bytes = parseIp(addrText);
    if (!bytes) throw new Error(`"${e}" is not a valid IP address or CIDR block`);
    const maxBits = bytes.length * 8;
    let bits = maxBits;
    if (slash !== -1) {
      const prefix = e.slice(slash + 1).trim();
      if (!/^\d{1,3}$/.test(prefix)) throw new Error(`"${e}" has an invalid CIDR prefix length`);
      bits = Number(prefix);
      if (bits > maxBits) throw new Error(`"${e}" has a prefix length above /${maxBits}`);
    }
    rules.push({ bytes, bits });
  }
  return rules;
}

// The candidate byte forms of one address. IPv4 and its IPv4-mapped IPv6 form (::ffff:a.b.c.d) are the same
// host reached over different stacks, so a rule written either way matches a client presenting either way.
function candidates(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length === 4) {
    const mapped = new Uint8Array(16);
    mapped[10] = 0xff;
    mapped[11] = 0xff;
    mapped.set(bytes, 12);
    return [bytes, mapped];
  }
  const isMapped = bytes.length === 16 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return isMapped ? [bytes, bytes.slice(12)] : [bytes];
}

function matchesRule(addr: Uint8Array, rule: IpRule): boolean {
  if (addr.length !== rule.bytes.length) return false;
  const whole = rule.bits >> 3;
  for (let i = 0; i < whole; i++) if (addr[i] !== rule.bytes[i]) return false;
  const rest = rule.bits & 7;
  if (rest === 0) return true;
  const mask = 0xff << (8 - rest) & 0xff;
  return (addr[whole]! & mask) === (rule.bytes[whole]! & mask);
}

/**
 * Whether `ip` falls inside any rule. An unparseable or absent `ip` never matches: a fence that cannot
 * identify the client fails CLOSED, which is why the caller decides "no rules = no fence" separately.
 */
export function ipMatchesAny(ip: string | null | undefined, rules: IpRule[]): boolean {
  if (!rules.length || !ip) return false;
  const bytes = parseIp(ip);
  if (!bytes) return false;
  const forms = candidates(bytes);
  return rules.some((r) => forms.some((f) => matchesRule(f, r)));
}
