// Coerce a string to characters a base (WinAnsi) PDF font can encode.
//
// WHY THIS IS ITS OWN MODULE, and a dependency-free one. pdf-lib's standard fonts are WinAnsi-encoded, and
// pdf-lib encodes to MEASURE as well as to draw (StandardFontEmbedder.encodeTextAsGlyphs), so an unencodable
// character does not render as a blank - it THROWS out of `widthOfTextAtSize`, before `drawText` is reached.
// Every renderer therefore has to sanitize, and there are renderers on both sides of the wire: the payslip,
// letter and stamp renderers in the Worker, and the asset-tag sticker sheet the browser builds itself. A copy
// per side is how one of them ends up missing the fix, so both import this - the file holds no pdf-lib types
// and no app data, which is what lets the client import it without pulling the server's PDF stack in.
//
// Common typographic glyphs map to ASCII; anything else outside Latin-1 becomes "?".

const GLYPHS: Record<string, string> = {
  "₹": "INR ", "–": "-", "—": "-", "−": "-", "•": "*",
  "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...",
};

export function enc(s: string | number | undefined | null): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (GLYPHS[ch]) { out += GLYPHS[ch]; continue; }
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else if (c === 0x09) out += " ";
    else out += "?";
  }
  return out;
}
