// Rasterizes the PWA icon set from web/public/favicon.svg.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genIcons.ts
//
// Not part of `npm run build` on purpose: the output is committed, and `sharp` is only present transitively,
// so a build must never depend on it. Re-run this by hand whenever the mark or the brand colour changes.
//
// Android needs a MASKABLE icon in addition to the plain one. The launcher crops a maskable icon to whatever
// shape the device uses (circle, squircle, rounded square), keeping only the inner ~80% "safe zone" - so the
// maskable variant is drawn full-bleed on the brand colour with the mark shrunk to 60%, where any crop still
// clears it. Feeding the plain icon in as maskable is the classic mistake: its rounded corners get cropped
// again and the mark loses its edges.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const pub = (f: string) => resolve(root, "web/public", f);

const favicon = readFileSync(pub("favicon.svg"), "utf8");
const BRAND = "#1D4C91"; // --primary / Brand Blue 700, matching the manifest theme_color

// The mark, re-laid-out for maskable: square (no corner radius, the launcher supplies the shape) and scaled
// to 60% about the centre. The source places the mark at translate(566.9 566.9) scale(.8) inside a 5669.29
// viewBox; 60% of that box leaves an equal 20% margin on every side.
const inset = (5669.29 * (1 - 0.6)) / 2;
const maskable = favicon
  .replace(/rx="\d+"/, "")
  .replace('transform="translate(566.9 566.9) scale(.8)"', `transform="translate(${inset} ${inset}) scale(.6)"`);
if (!maskable.includes("scale(.6)")) throw new Error("favicon.svg no longer matches the expected transform - update genIcons.ts");
writeFileSync(pub("icon-maskable.svg"), maskable);

// No `density` override: the source viewBox is already 5669 units, so sharp rasterizes at 5669x5669 and
// every target is a downscale. Forcing a higher density multiplies that and trips sharp's pixel limit.
const render = (svg: string, size: number, out: string) =>
  sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(pub(out))
    .then(() => console.log(`  ${out}  ${size}x${size}`));

await Promise.all([
  render(favicon, 192, "icon-192.png"),
  render(favicon, 512, "icon-512.png"),
  render(maskable, 512, "icon-maskable-512.png"),
  render(favicon, 180, "apple-touch-icon.png"), // iOS ignores the manifest and reads this by convention
]);
console.log("icons written to web/public");
