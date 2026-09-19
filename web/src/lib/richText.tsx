import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { orgNameFontStack } from "@/lib/fonts";
import { splitSource } from "@/lib/splitSource";
import { parseAttrLine, type RichAttrs } from "@/lib/richTextEdit";

// Markdown-lite for board posts: what an author writes is stored as plain text and rendered to React ELEMENTS -
// never to an HTML string. That is the whole security argument. There is no `dangerouslySetInnerHTML` anywhere in
// this path, so there is nothing for a sanitizer to miss, and a post body remains something you can read, index,
// excerpt and diff as text.
//
// Markdown proper has no alignment, no type size and no typeface, so those ride on a BLOCK ATTRIBUTE LINE: a line
// of nothing but `{...}` tokens applies to the block that follows it.
//
//     {center lg serif}
//     Happy Diwali from all of us
//
// Its grammar and its vocabularies live in lib/richTextEdit.ts, beside the toolbar commands that write them; this
// file holds what each token LOOKS like. Anything unrecognised is dropped, which is what keeps a feed coherent: an
// author picks from the design system's ramp rather than naming a font or a colour. Free-form colours and
// typefaces are deliberately absent - they break in dark mode and turn a shared wall into ransom notes.
//
// The composer's toolbar writes all of this; nobody is expected to type `{center lg}` by hand (though it reads
// fine if they do). Server-side, src/domain/richText.ts strips the same markup back to prose for the search index
// and for notification excerpts.

const ALIGN: Record<string, string> = { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" };
// Size is RELATIVE to whatever the surface sets, which is why `base` is nothing at all rather than `text-base`.
// Every surface picks its own reading size - a post body is text-sm, a kudos remark scales with how long it is -
// and an absolute ramp cannot serve both: pinned to the body's ramp, "Large" on a kudos card would render its
// short remark SMALLER than leaving it alone, which is a button lying about what it does. So the three are steps
// from the surface's own size: a bit smaller, as-set, a good deal bigger, on whatever it is applied to.
//
// Clamped, because a step is a multiplier and a multiplier on an already-large surface runs away - 1.3x of a
// 1.5rem remark is nearly 2rem, far past anything else on the card. The bounds are the largest and smallest a
// board card ever wants to read at, so the step is honoured until it would leave the design's range and then
// stops. Monotonic on every surface: Small < Normal < Large, always.
//
// The line-height goes with them. A surface sets its own in rem (`text-sm` carries `1.25rem`), and a fixed
// line-height inherited by bigger words is what makes them collide - so a step in size sets a step in leading,
// unitless, which scales with the font instead of fighting it.
// The steps are wide on purpose. A ramp of 0.85x / 1x / 1.3x lands a post body on 12 / 14 / 18px, which is three
// sizes you have to compare side by side to tell apart - and a control whose settings look alike is not worth
// pressing. Far enough apart to be read at a glance, near enough that the card still looks composed.
const SIZE: Record<string, string> = {
  sm: "text-[clamp(0.7rem,0.8em,1.1rem)] leading-[1.5]",
  base: "",
  lg: "text-[clamp(1.25rem,1.55em,1.9rem)] leading-[1.3]",
};
const MUTED = "text-muted-foreground";

// `withSize` is for the one block that carries a font-size of its own: see the heading branch in RichText.
const attrClass = (a: RichAttrs, withSize = true) => cn(a.align && ALIGN[a.align], withSize && a.size && SIZE[a.size], a.muted && MUTED);
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
//
// Emphasis is a RUN of one character, so the three lengths are three alternatives tried longest first: `***both***`
// has to be read as bold AND italic before `**` gets a look at it, or it comes out as bold text beginning with a
// stray star. The toolbar writes exactly these runs (see markState in RichTextToolbar).
//
// The underscore forms are guarded by word boundaries and the asterisk ones are not, because that is where the two
// characters differ in prose: nobody writes `a*b*c` by accident, while `EMP_0042`, `first_name` and `snake_case`
// are ordinary words in an HR post and must not turn half a sentence italic.
//
// Named groups rather than numbered ones: ten alternatives deep, counting parentheses to find "the bold one" is a
// bug waiting for the next construct to be added.
const INLINE = new RegExp(
  [
    String.raw`\*\*\*(?<both>[\s\S]+?)\*\*\*`,
    String.raw`\*\*(?<bold>[\s\S]+?)\*\*`,
    String.raw`\*(?<em>[\s\S]+?)\*`,
    String.raw`(?<![\p{L}\p{N}])___(?<bothU>[\s\S]+?)___(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])__(?<boldU>[\s\S]+?)__(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])_(?<emU>[\s\S]+?)_(?![\p{L}\p{N}])`,
    String.raw`~~(?<strike>[\s\S]+?)~~`,
    "`(?<code>[^`]+)`",
    // An @mention: the link shape with an `@` on the label and an employee ref as the target (see
    // src/domain/mentions.ts). Ahead of the general link rule, which would otherwise claim it and - since
    // `employees/...` is not a scheme safeHref allows - render it as flat text.
    String.raw`\[@(?<mentionName>[^\]\n]{1,80})\]\(employees\/(?<mentionId>[0-9a-hj-km-np-tv-z]{26})\)`,
    String.raw`\[(?<linkText>[^\]\n]+)\]\((?<linkUrl>[^)\s]+)\)`,
    // A bare URL stops before the punctuation that ended the sentence it sits in: `see https://example.com.` is a
    // link to the site and then a full stop, not a link to a hostname with a dot on the end. Requiring a real
    // character after the scheme is also what keeps the toolbar's unfinished `https://` out of the feed.
    String.raw`(?<bare>(?:https?://|mailto:)[^\s<>()]*[^\s<>().,;:!?'"])`,
  ].join("|"),
  "u",
);

// A scheme this document is allowed to link to, AND something after it to go to: the toolbar hands the author
// `[](https://)` to fill in, and a label still sitting on the bare scheme is a half-written link, not a link. It
// renders as the words it is - live, it would be a piece of blue underlined text that goes nowhere.
const safeHref = (url: string) => (/^(https?:\/\/[^/\s]|mailto:[^\s@]+@)/i.test(url) ? url : undefined);

/**
 * How much text one block will be SCANNED for inline markers, and how deep a nested mark may recurse.
 *
 * `INLINE` is ten alternatives of lazy `[\s\S]+?` runs, and the loop below re-`exec`s it over the remainder
 * after every match. That is fine on prose and quadratic on a long run of unmatched openers: for each start
 * position the engine expands the lazy quantifier to the end of the string and fails, for every alternative.
 * A body of a few hundred thousand `*` therefore renders as a frozen tab - and bodies are not bounded at the
 * source either (see the length caps this is paired with in src/routes/announcements.ts and cards.ts), so it
 * was reachable by writing one post and lands on everyone who opens the board, not on its author.
 *
 * Past the ceiling the overflow is emitted as PLAIN TEXT rather than dropped: nothing a person wrote
 * disappears, it simply stops being scanned for formatting - and no real post is anywhere near it (this is
 * several times the longest announcement the app has ever stored). The depth cap does the same for nesting,
 * where the input is the recursion: `renderInline` calls itself on what a mark captured, so a deeply nested
 * `***…***` chain is bounded by the text it can contain rather than by anything checked.
 */
const MAX_INLINE_SCAN = 20_000;
const MAX_INLINE_DEPTH = 8;

function renderInline(text: string, keyPrefix = "i", depth = 0): ReactNode[] {
  // Past either bound, the words still show - they are just not read as markup. See the note above.
  if (depth >= MAX_INLINE_DEPTH) return [text];
  const out: ReactNode[] = [];
  let rest = text;
  if (rest.length > MAX_INLINE_SCAN) {
    // The tail is pushed FIRST as a plain string and the head is scanned, so the block still reads in order.
    const tail = rest.slice(MAX_INLINE_SCAN);
    rest = rest.slice(0, MAX_INLINE_SCAN);
    return [...renderInline(rest, keyPrefix, depth), tail];
  }
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}${n++}`;
    const g = (m.groups ?? {}) as Record<string, string | undefined>;
    // The asterisk and underscore spellings of a mark mean the same thing, so they meet here and part no further.
    const both = g.both ?? g.bothU;
    const bold = g.bold ?? g.boldU;
    const italic = g.em ?? g.emU;
    const { strike, code, linkText, linkUrl, bare, mentionName, mentionId } = g;
    if (both !== undefined) out.push(<strong key={key} className="font-semibold"><em>{renderInline(both, key, depth + 1)}</em></strong>);
    else if (bold !== undefined) out.push(<strong key={key} className="font-semibold">{renderInline(bold, key, depth + 1)}</strong>);
    else if (italic !== undefined) out.push(<em key={key}>{renderInline(italic, key, depth + 1)}</em>);
    else if (strike !== undefined) out.push(<s key={key} className="opacity-70">{renderInline(strike, key, depth + 1)}</s>);
    else if (code !== undefined) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{code}</code>);
    else if (mentionName !== undefined) out.push(<Mention key={key} name={mentionName} employeeId={mentionId!} />);
    else if (linkText !== undefined) {
      const href = safeHref(linkUrl!);
      out.push(href ? <Anchor key={key} href={href}>{renderInline(linkText, key, depth + 1)}</Anchor> : <span key={key}>{linkText}</span>);
    } else if (bare !== undefined) out.push(<Anchor key={key} href={bare} title={bare}>{bareLabel(bare)}</Anchor>);
    rest = rest.slice(m.index + m[0]!.length);
  }
  return out;
}

/**
 * A link in the middle of someone's writing.
 *
 * Set in the same weight as the words around it - the colour and the rule beneath already say it is a link, and a
 * bolder run of text in the middle of a sentence reads as emphasis the author did not write. The rule is a
 * hairline at a third strength, dropped clear of the descenders, so a link inside a paragraph is marked without
 * being scored through; hovering brings it up to full rather than taking it away, because an affordance that
 * vanishes when you reach for it is backwards.
 *
 * Board cards are clickable (they expand), so a link stops the click from also toggling the post.
 */
/**
 * A person named in the text. Drawn as a soft chip so a mention reads as a reference to someone rather than
 * as emphasis, and links to their profile - the useful thing to do with a name you just read.
 *
 * The NAME comes from the source, not from a lookup: it is what the author picked at the time, and a chip
 * that needs the directory loaded would flicker (or read "Someone") on every card the moment the page opens.
 * A later rename therefore leaves the old wording in old posts, exactly as a name typed into a sentence does.
 */
function Mention({ name, employeeId }: { name: string; employeeId: string }) {
  return (
    <a
      href={`/employees/${employeeId}`}
      onClick={(e) => e.stopPropagation()} // board cards expand on click; following a mention must not also toggle the post
      className="rounded bg-primary/10 px-1 font-medium text-primary transition-colors hover:bg-primary/20"
    >
      @{name}
    </a>
  );
}

function Anchor({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "text-primary underline decoration-primary/30 decoration-1 underline-offset-[3px] transition-colors",
        "hover:decoration-primary focus-visible:decoration-primary",
        // A URL has no spaces to wrap at, and a card is only so wide.
        "break-words",
      )}
    >
      {children}
    </a>
  );
}

/**
 * What a BARE url shows as. Written out in full - scheme, `www.`, query, tracking - it is a wall of characters in
 * the middle of a sentence, and the ugliest thing on the card by some way. What is left is the part a reader
 * recognises: the host, and a mark to say the address goes on. The href is untouched, and the whole of it is on
 * the title, so nothing is hidden - only tidied.
 *
 * A link the AUTHOR labelled is left exactly as they wrote it; this is only for the ones the renderer found.
 */
function bareLabel(url: string): string {
  if (/^mailto:/i.test(url)) return url.slice("mailto:".length);
  const bare = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (bare.length <= 44) return bare;
  const slash = bare.indexOf("/");
  return slash === -1 ? bare : `${bare.slice(0, slash)}/…`;
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
          // A size step goes on a span INSIDE the heading, not on the heading. `em` resolves against the PARENT's
          // font size, and a heading is the one block with a size of its own - put the step on the element and it
          // would measure itself against the body text instead, which made "Large" render a heading SMALLER than
          // leaving it alone. Inside, the parent is the heading, and the step means what it says.
          const step = b.attrs.size ? SIZE[b.attrs.size] : "";
          return (
            <H key={key} style={attrStyle(b.attrs)} className={cn("font-semibold", size, attrClass(b.attrs, false))}>
              {step ? <span className={step}>{renderInline(b.text, key)}</span> : renderInline(b.text, key)}
            </H>
          );
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
