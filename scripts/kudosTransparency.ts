// Replaces the flat white backdrop on the kudos stickers (web/public/assets/kudos/*.png) with real
// transparency, so a card shows the sticker and not a white tile - which read as a bug against the tinted card
// in light mode and glared in dark mode.
//
// The stickers ship as 8-bit PALETTE PNGs with no alpha channel at all, and white is not only the backdrop: it
// is the lettering ("Good Job!"), the eyes, and the highlights. So this cannot key on colour. Two things make it
// safe:
//
//  1. Flood fill from the border. Only white REACHABLE from outside the artwork becomes transparent; an enclosed
//     white letter or eye is never reached, so it stays opaque. Making the white palette entry transparent (the
//     one-line version of this) would punch holes straight through the text.
//  2. Unmatting the antialiased rim. The pixels where art meets backdrop are art blended over white. Left
//     opaque they draw a white halo on a dark card; given alpha they still carry the white they were blended
//     with. So for a thin band around the fill, alpha comes from how light the pixel is and the colour is solved
//     back out of `observed = a*art + (1-a)*white`. Confined to a band, so light art elsewhere is untouched.
//
// Output is RGBA (colour type 6) since partial alpha per pixel cannot be expressed in a palette + tRNS.
//
// Run: node --experimental-strip-types scripts/kudosTransparency.ts [--dry] [--qa <file.png>]
// Idempotent: a file already carrying alpha is skipped, so re-running is safe.

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "web", "public", "assets", "kudos");
const DRY = process.argv.includes("--dry");
const QA_AT = process.argv.indexOf("--qa");
const QA_PATH = QA_AT >= 0 ? process.argv[QA_AT + 1] : undefined;

// A pixel joins the backdrop when it is this close to white (max channel distance) AND reachable from the edge.
const HARD = 12;
// Width in pixels of the unmatted rim just inside the fill.
const RIM = 2;
// Only rim pixels at least this light are unmatted; darker ones are art, not a blend with the backdrop.
const RIM_MIN_WHITENESS = 0.45;

// ---------------------------------------------------------------- PNG plumbing

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

type Chunk = { type: string; data: Buffer };

function readChunks(png: Buffer): Chunk[] {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const out: Chunk[] = [];
  let i = 8;
  while (i < png.length) {
    const len = png.readUInt32BE(i);
    out.push({ type: png.toString("latin1", i + 4, i + 8), data: png.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Undo the per-scanline filters. `bpp` is bytes per pixel (1 for 8-bit palette).
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[pos++]!;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const v = raw[pos + x]!;
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      row[x] = type === 0 ? v : type === 1 ? (v + a) & 0xff : type === 2 ? (v + b) & 0xff : type === 3 ? (v + ((a + b) >> 1)) & 0xff : (v + paeth(a, b, c)) & 0xff;
    }
    pos += stride;
  }
  return out;
}

// Filter each scanline with whichever of the five filters has the smallest absolute-sum - the standard heuristic,
// worth a lot on flat artwork like this.
function filterRows(pixels: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const cand = Buffer.alloc(stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let bestType = 0;
    let bestSum = Infinity;
    let best = Buffer.alloc(stride);
    for (let type = 0; type <= 4; type++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = row[x]!;
        const a = x >= bpp ? row[x - bpp]! : 0;
        const b = prev ? prev[x]! : 0;
        const c = prev && x >= bpp ? prev[x - bpp]! : 0;
        const f = type === 0 ? v : type === 1 ? v - a : type === 2 ? v - b : type === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c);
        cand[x] = f & 0xff;
        sum += Math.abs(((f + 128) & 0xff) - 128);
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        best = Buffer.from(cand);
      }
    }
    out[o++] = bestType;
    best.copy(out, o);
    o += stride;
  }
  return out;
}

type Image = { width: number; height: number; rgba: Buffer; hadAlpha: boolean };

// Decodes the shapes these files actually use: 8-bit palette (what the stickers are) plus RGB/RGBA, so a
// re-exported sticker does not silently break the script.
function decode(png: Buffer): Image {
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR")!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const colour = ihdr[9]!;
  const interlace = ihdr[12]!;
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");

  const idat = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const rgba = Buffer.alloc(width * height * 4, 255);

  if (colour === 3) {
    const plte = chunks.find((c) => c.type === "PLTE")!.data;
    const trns = chunks.find((c) => c.type === "tRNS")?.data;
    const idx = unfilter(idat, width, height, 1);
    for (let p = 0; p < width * height; p++) {
      const e = idx[p]!;
      rgba[p * 4] = plte[e * 3]!;
      rgba[p * 4 + 1] = plte[e * 3 + 1]!;
      rgba[p * 4 + 2] = plte[e * 3 + 2]!;
      rgba[p * 4 + 3] = trns && e < trns.length ? trns[e]! : 255;
    }
    return { width, height, rgba, hadAlpha: !!trns };
  }
  if (colour === 2 || colour === 6) {
    const bpp = colour === 6 ? 4 : 3;
    const px = unfilter(idat, width, height, bpp);
    for (let p = 0; p < width * height; p++) {
      rgba[p * 4] = px[p * bpp]!;
      rgba[p * 4 + 1] = px[p * bpp + 1]!;
      rgba[p * 4 + 2] = px[p * bpp + 2]!;
      rgba[p * 4 + 3] = colour === 6 ? px[p * bpp + 3]! : 255;
    }
    return { width, height, rgba, hadAlpha: colour === 6 };
  }
  throw new Error(`unsupported colour type ${colour}`);
}

function encode({ width, height, rgba }: Pick<Image, "width" | "height" | "rgba">): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filterRows(rgba, width, height, 4), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- the transform

const whiteDist = (r: number, g: number, b: number) => Math.max(255 - r, 255 - g, 255 - b);

function cutBackdrop(img: Image): { cleared: number; rimmed: number } {
  const { width, height, rgba } = img;
  const n = width * height;
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  const near = (p: number) => whiteDist(rgba[p * 4]!, rgba[p * 4 + 1]!, rgba[p * 4 + 2]!) <= HARD;
  const push = (p: number) => {
    if (!bg[p] && near(p)) {
      bg[p] = 1;
      queue[tail++] = p;
    }
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
  }

  let cleared = 0;
  for (let p = 0; p < n; p++) {
    if (bg[p]) {
      rgba[p * 4 + 3] = 0;
      cleared++;
    }
  }

  // Unmat the rim: walk outward RIM times from the cleared region. `frontier` is what became see-through last
  // round, so each ring is only visited once.
  let rimmed = 0;
  let frontier = bg;
  for (let d = 0; d < RIM; d++) {
    const next = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      if (!frontier[p]) continue;
      const x = p % width;
      const y = (p - x) / width;
      const neighbours = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of neighbours) {
        if (q < 0 || next[q] || bg[q] || rgba[q * 4 + 3] !== 255) continue;
        const r = rgba[q * 4]!;
        const g = rgba[q * 4 + 1]!;
        const b = rgba[q * 4 + 2]!;
        // Whiteness by the DARKEST channel: a pixel is only a blend with the backdrop if every channel is high.
        const whiteness = Math.min(r, g, b) / 255;
        if (whiteness < RIM_MIN_WHITENESS) continue;
        // observed = a*art + (1-a)*255  =>  art = (observed - (1-a)*255) / a
        const a = 1 - whiteness;
        const alpha = Math.round(a * 255);
        if (alpha <= 0) {
          rgba[q * 4 + 3] = 0;
          next[q] = 1;
          cleared++;
          continue;
        }
        rgba[q * 4] = Math.max(0, Math.min(255, Math.round((r - (1 - a) * 255) / a)));
        rgba[q * 4 + 1] = Math.max(0, Math.min(255, Math.round((g - (1 - a) * 255) / a)));
        rgba[q * 4 + 2] = Math.max(0, Math.min(255, Math.round((b - (1 - a) * 255) / a)));
        rgba[q * 4 + 3] = alpha;
        next[q] = 1;
        rimmed++;
      }
    }
    frontier = next;
  }
  return { cleared, rimmed };
}

// ---------------------------------------------------------------- QA contact sheet

// Every result twice - over a light card tint and over a dark one - so a white halo or a hole punched through
// lettering is obvious at a glance instead of needing a browser.
function contactSheet(tiles: { name: string; img: Image }[]): Buffer {
  const CELL = 128;
  const COLS = 10;
  const rows = Math.ceil(tiles.length / COLS);
  const width = COLS * CELL;
  const height = rows * CELL * 2;
  const out = Buffer.alloc(width * height * 4, 255);
  const BANDS: [number, number, number][] = [
    [246, 248, 250], // light card
    [15, 23, 42], // dark card (slate-900)
  ];
  tiles.forEach((t, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    BANDS.forEach((bandColour, band) => {
      const originY = (row * 2 + band) * CELL;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          // nearest-neighbour halve of a 256px tile
          const sp = (y * 2 * t.img.width + x * 2) * 4;
          const a = t.img.rgba[sp + 3]! / 255;
          const dp = ((originY + y) * width + col * CELL + x) * 4;
          for (let c = 0; c < 3; c++) out[dp + c] = Math.round(t.img.rgba[sp + c]! * a + bandColour[c]! * (1 - a));
          out[dp + 3] = 255;
        }
      }
    });
  });
  return encode({ width, height, rgba: out });
}

// ---------------------------------------------------------------- main

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".png")).sort();
const tiles: { name: string; img: Image }[] = [];
let changed = 0;

for (const file of files) {
  const path = join(DIR, file);
  const before = readFileSync(path);
  const img = decode(before);
  if (img.hadAlpha) {
    console.log(`  ${file.padEnd(30)} already has alpha - skipped`);
    tiles.push({ name: file, img });
    continue;
  }
  const { cleared, rimmed } = cutBackdrop(img);
  const after = encode(img);
  const pct = ((cleared / (img.width * img.height)) * 100).toFixed(1);
  console.log(
    `  ${file.padEnd(30)} ${pct.padStart(5)}% cleared, ${String(rimmed).padStart(5)} rim px  ${(before.length / 1024).toFixed(1)}KB -> ${(after.length / 1024).toFixed(1)}KB`,
  );
  if (!DRY) writeFileSync(path, after);
  tiles.push({ name: file, img });
  changed++;
}

if (QA_PATH) {
  writeFileSync(QA_PATH, contactSheet(tiles));
  console.log(`\nQA sheet -> ${QA_PATH} (each sticker over a light card, then a dark one)`);
}
console.log(`\n${changed}/${files.length} rewritten${DRY ? " (dry run - nothing written)" : ""}`);
