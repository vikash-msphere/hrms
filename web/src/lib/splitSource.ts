// Cutting a markdown-lite body in two, so a card can lay it out as two columns with a picture standing between
// them (see SplitRichText, and the wrap-mode note in components/common/CardSticker.tsx).
//
// Deliberately dependency-free - no React, no path aliases - so it can be unit-tested directly. Where the cut
// lands is the whole job, and it has edge cases worth pinning down.

// The same shape as parseAttrLine in richText.tsx: a line of nothing but `{center xl serif}` tokens, which
// belongs to the block BELOW it and must never be separated from it.
const ATTR_LINE = /^\{[a-z0-9 _-]*\}$/i;

export function splitSource(src: string): [string, string] {
  const text = (src ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length === 0) return ["", ""];
  const middle = text.length / 2;

  // Where each line starts, so "nearest the middle" can be measured in characters rather than in lines - a long
  // paragraph and a one-word line should not count the same.
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const nearest = (predicate: (line: string, i: number) => boolean) => {
    let best = -1;
    let bestDistance = Infinity;
    lines.forEach((line, i) => {
      if (i === 0 || !predicate(line, i)) return;
      const d = Math.abs(starts[i]! - middle);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    return best;
  };

  // A blank line: the cleanest cut there is, and the block above keeps any attribute line it owns.
  const blank = nearest((line) => line.trim() === "");
  if (blank > 0) return [lines.slice(0, blank).join("\n").trimEnd(), lines.slice(blank + 1).join("\n").trimStart()];

  // Failing that, between two lines - but never straight after an attribute line, which belongs to what follows.
  const boundary = nearest((_l, i) => !ATTR_LINE.test((lines[i - 1] ?? "").trim()));
  if (boundary > 0 && lines.length > 1) return [lines.slice(0, boundary).join("\n"), lines.slice(boundary).join("\n")];

  // No usable boundary, so the cut has to fall between two words of the line that straddles the middle. Every
  // other line stays where it was: whatever happens here, nothing may be dropped - the two halves put back
  // together are always the whole body.
  let at = lines.length - 1;
  for (let i = 0; i < lines.length; i++) if (starts[i]! <= middle) at = i;
  const line = lines[at] ?? "";
  // Only prose can be cut mid-line. A list item or a heading would lose its marker, and an attribute line governs
  // what comes after it rather than carrying words of its own - so when the middle lands on one of those there is
  // nothing safe to cut, and the body stays whole in the first column.
  const unsplittable = /^\s*(?:[-*]\s|\d+[.)]\s|>|#{1,3}\s)/.test(line) || ATTR_LINE.test(line.trim());
  const space = unsplittable ? -1 : line.lastIndexOf(" ", Math.round(line.length / 2));
  if (space <= 0) return [text, ""];
  // The second half starts mid-sentence, so it needs the attribute line that was governing the first half - the
  // two columns are one paragraph and must be set the same way.
  const governing = at > 0 && ATTR_LINE.test((lines[at - 1] ?? "").trim()) ? [lines[at - 1]!] : [];
  return [
    [...lines.slice(0, at), line.slice(0, space)].join("\n"),
    [...governing, line.slice(space + 1), ...lines.slice(at + 1)].join("\n"),
  ];
}

