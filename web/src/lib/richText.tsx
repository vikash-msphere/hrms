import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { NAME_FONTS, orgNameFontStack } from "@/lib/fonts";
import { splitSource } from "@/lib/splitSource";

// Markdown-lite for board posts: what an author writes is stored as plain text and rendered to React ELEMENTS -
// never to an HTML string. That is the whole security argument. There is no `dangerouslySetInnerHTML` anywhere in
// this path, so there is nothing for a sanitizer to miss, and a post body remains something you can read, index,
// excerpt and diff as text.
//
// Markdown proper has no alignment, no type size and no typeface, so those ride on a BLOCK ATTRIBUTE LINE: a line
// of nothing but `{...}` tokens applies to the block that follows it.
//
//     {center xl serif}
//     Happy Diwali from all of us
//
// Tokens are drawn from fixed vocabularies below and anything unrecognised is dropped, which is what keeps a feed
// coherent: an author picks from the design system's ramp rather than naming a font or a colour. Free-form colours
// and typefaces are deliberately absent - they break in dark mode and turn a shared wall into ransom notes.
//
// The composer's toolbar writes all of this; nobody is expected to type `{center xl}` by hand (though it reads
// fine if they do). Server-side, src/domain/richText.ts strips the same markup back to prose for the search index
// and for notification excerpts.

const ALIGN: Record<string, string> = { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" };
const SIZE: Record<string, string> = { sm: "text-sm", base: "text-base", lg: "text-lg" };
const TONE: Record<string, string> = { muted: "text-muted-foreground" };

/** The vocabularies the toolbar offers, in the order it offers them. */
export const RICH_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export const RICH_SIZES = ["sm", "base", "lg"] as const;
// The typefaces the app already loads, shared with the organization wordmark (lib/fonts.ts). "default" is the UI
// font and is expressed by having no face token at all, so it is not one of the choices here.
export const RICH_FACES = NAME_FONTS.filter((f) => f.value !== "default").map((f) => f.value);
const FACE_KEYS = new Set(RICH_FACES);
export type RichAlign = (typeof RICH_ALIGNMENTS)[number];
export type RichSize = (typeof RICH_SIZES)[number];
export type RichFace = string;

export type RichAttrs = { align?: RichAlign; size?: RichSize; face?: RichFace; muted?: boolean };

const ATTR_LINE = /^\{([a-z0-9 _-]*)\}$/i;

/** `{center xl serif}` -> attrs, or null when the line is ordinary text. */
export function parseAttrLine(line: string): RichAttrs | null {
  const m = ATTR_LINE.exec(line.trim());
  if (!m) return null;
  const attrs: RichAttrs = {};
  for (const raw of m[1]!.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (raw in ALIGN) attrs.align = raw as RichAlign;
    else if (raw in SIZE) attrs.size = raw as RichSize;
    else if (FACE_KEYS.has(raw)) attrs.face = raw;
    else if (raw in TONE) attrs.muted = true;
  }
  return attrs;
}

/** attrs -> `{center xl serif}`, or "" when nothing is set (the line is then dropped entirely). */
export function formatAttrLine(attrs: RichAttrs): string {
  const tokens = [attrs.align, attrs.size, attrs.face, attrs.muted ? "muted" : ""].filter(Boolean);
  return tokens.length ? `{${tokens.join(" ")}}` : "";
}

const attrClass = (a: RichAttrs) => cn(a.align && ALIGN[a.align], a.size && SIZE[a.size], a.muted && TONE.muted);
// The typeface is the one thing that cannot be a class: the stacks are shared data (lib/fonts.ts), not a fixed
// Tailwind vocabulary, and Tailwind only emits classes it can see spelled out in the source.
const attrStyle = (a: RichAttrs) => (a.face ? { fontFamily: orgNameFontStack(a.face) } : undefined);

// ---- Blocks ------------------------------------------------------------------------------------------------

type Block =
  | { kind: "p" | "quote"; attrs: RichAttrs; text: string }
  | { kind: "h"; level: 1 | 2 | 3; attrs: RichAttrs; text: string }
  | { kind: "list"; ordered: boolean; attrs: RichAttrs; items: string[] }
  | { kind: "hr" };

// Line-based, deliberately: every construct is decided by how a line starts, which is what makes the toolbar's
// job (prefix this line, unprefix that one) exactly reversible.
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let attrs: RichAttrs = {};
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push({ kind: "p", attrs, text: para.join("\n") });
    para = [];
    attrs = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // An attribute line belongs to whatever comes next, so it closes the paragraph above it.
    const a = parseAttrLine(line);
    if (a) {
      flushPara();
      attrs = a;
      continue;
    }
    if (!trimmed) {
      flushPara();
      continue;
    }
    if (/^(---|___|\*\*\*)$/.test(trimmed)) {
      flushPara();
      out.push({ kind: "hr" });
      attrs = {};
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      out.push({ kind: "h", level: heading[1]!.length as 1 | 2 | 3, attrs, text: heading[2]! });
      attrs = {};
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushPara();
      const items = [quote[1]!];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]!.trim())) items.push(lines[++i]!.trim().replace(/^>\s?/, ""));
      out.push({ kind: "quote", attrs, text: items.join("\n") });
      attrs = {};
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      const ordered = !bullet;
      const items = [(bullet ?? numbered)![1]!];
      const same = (s: string) => (ordered ? /^\d+[.)]\s+/.test(s) : /^[-*]\s+/.test(s));
      while (i + 1 < lines.length && same(lines[i + 1]!.trim())) {
        items.push(lines[++i]!.trim().replace(ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/, ""));
      }
      out.push({ kind: "list", ordered, attrs, items });
      attrs = {};
      continue;
    }
    para.push(trimmed === "" ? "" : line);
  }
  flushPara();
  return out;
}

// ---- Inline ------------------------------------------------------------------------------------------------

// One pass, longest-marker-first, recursing into what it captured so `**bold with *stress***` works. A URL is
// only ever linked when it is http(s) or mailto - the one place a document could otherwise smuggle a scheme.
const INLINE = /(\*\*|__)([\s\S]+?)\1|(\*|_)([\s\S]+?)\3|~~([\s\S]+?)~~|`([^`]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|((?:https?:\/\/|mailto:)[^\s<>()]+)/;

const safeHref = (url: string) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : undefined);

function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}${n++}`;
    const [, , bold, , italic, strike, code, linkText, linkUrl, bare] = m;
    if (bold !== undefined) out.push(<strong key={key} className="font-semibold">{renderInline(bold, key)}</strong>);
    else if (italic !== undefined) out.push(<em key={key}>{renderInline(italic, key)}</em>);
    else if (strike !== undefined) out.push(<s key={key} className="opacity-70">{renderInline(strike, key)}</s>);
    else if (code !== undefined) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{code}</code>);
    else if (linkText !== undefined) {
      const href = safeHref(linkUrl!);
      out.push(href ? <Anchor key={key} href={href}>{renderInline(linkText, key)}</Anchor> : <span key={key}>{linkText}</span>);
    } else if (bare !== undefined) out.push(<Anchor key={key} href={bare}>{bare}</Anchor>);
    rest = rest.slice(m.index + m[0]!.length);
  }
  return out;
}

// Board cards are clickable (they expand), so a link stops the click from also toggling the post.
function Anchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      onClick={(e) => e.stopPropagation()}
      className="font-medium text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  );
}

// ---- Render ------------------------------------------------------------------------------------------------

/**
 * Render markdown-lite source, in full. A board card never truncates its own body: a post is short enough to read
 * where it sits, and hiding half of it behind a click only asks the reader to work for what the author wrote.
 *
 * `insert` puts a node BETWEEN two of the blocks, at `insertAt` (a fraction of the way through them). That is what
 * a card's "top and bottom" sticker uses: to have words above it as well as below, it has to be a sibling of the
 * paragraphs rather than something sitting on top of them - and moving it then means moving it to a different gap,
 * not pushing the whole body down.
 */
export function RichText({
  source,
  className,
  insert,
  insertAt = 0,
}: {
  source?: string | null;
  className?: string;
  insert?: ReactNode;
  insertAt?: number; // 0 = above every block, 1 = below them all
}) {
  const blocks = parseBlocks(source ?? "");
  if (!blocks.length) return insert ? <div className={className}>{insert}</div> : null;
  // Which gap it lands in. Rounding to a real gap is the honest behaviour: the positions between paragraphs are
  // the only ones that exist.
  const gap = insert ? Math.max(0, Math.min(blocks.length, Math.round(insertAt * blocks.length))) : -1;
  return (
    <div className={cn("space-y-2 whitespace-pre-wrap break-words", className)}>
      {gap === 0 && insert}
      {blocks.map((b, i) => {
        const key = `b${i}`;
        if (b.kind === "hr") return <hr key={key} className="my-3 border-border" />;
        if (b.kind === "list") {
          const List = b.ordered ? "ol" : "ul";
          return (
            <List key={key} style={attrStyle(b.attrs)} className={cn("ms-5 list-outside space-y-1", b.ordered ? "list-decimal" : "list-disc", attrClass(b.attrs))}>
              {b.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}
            </List>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={key} style={attrStyle(b.attrs)} className={cn("border-s-2 border-primary/40 ps-3 italic text-foreground/70", attrClass(b.attrs))}>
              {renderInline(b.text, key)}
            </blockquote>
          );
        }
        if (b.kind === "h") {
          // The card's own title is the h1 of this document, so a body heading starts a level below it.
          const H = (["h2", "h3", "h4"] as const)[b.level - 1]!;
          const size = (["text-xl", "text-lg", "text-base"] as const)[b.level - 1]!;
          return <H key={key} style={attrStyle(b.attrs)} className={cn("font-semibold", size, attrClass(b.attrs))}>{renderInline(b.text, key)}</H>;
        }
        return <p key={key} style={attrStyle(b.attrs)} className={attrClass(b.attrs)}>{renderInline(b.text, key)}</p>;
      }).flatMap((node, i) => (gap === i + 1 ? [node, <div key={`ins${i}`}>{insert}</div>] : [node]))}
    </div>
  );
}

/**
 * The body laid out as two columns with something standing between them - a picture in the gap, and in each
 * column an invisible float carrying that half of its outline, so the words follow the artwork down both sides.
 *
 * Two columns rather than CSS multi-column because a float can only be put inside a real element: multicol has no
 * per-column exclusions, so a picture in a multicol gutter has nothing to hug it. The reading order is the same
 * either way - left column, then right.
 */
export function SplitRichText({
  source,
  className,
  left,
  right,
  insert,
  insertAt = 0,
}: {
  source?: string | null;
  className?: string;
  left?: ReactNode; // the float carrying the left half of the outline
  right?: ReactNode;
  // A band still has to land somewhere when the body has been split. It goes in whichever half its fraction
  // falls in, re-scaled to that half - so a card can have a picture between the columns AND a band in the text.
  insert?: ReactNode;
  insertAt?: number;
}) {
  const [a, b] = splitSource(source ?? "");
  const inLeft = insert && (!b || insertAt <= 0.5);
  return (
    <div className="flex items-start">
      <div className="min-w-0 flex-1">
        {left}
        <RichText
          source={a}
          className={className}
          insert={inLeft ? insert : undefined}
          insertAt={inLeft ? Math.min(1, insertAt * 2) : undefined}
        />
      </div>
      <div className="min-w-0 flex-1">
        {right}
        <RichText
          source={b}
          className={className}
          insert={insert && !inLeft ? insert : undefined}
          insertAt={insert && !inLeft ? Math.max(0, insertAt * 2 - 1) : undefined}
        />
      </div>
    </div>
  );
}
