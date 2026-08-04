import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type BodyValign, CardCanvas, DEFAULT_WRAP, HalfSpacer, isWrapped, needsColumns, PlacedElement, POST_STICKER_LAYOUT, reserveFor, StickerImage, ValignBlock } from "@/components/common/CardSticker";
import { RichText, SplitRichText } from "@/lib/richText";
import type { StickerLayout } from "@/types";

// The inside of a board card that isn't a kudos - an announcement, a post or a poll. Shared by the feed and the
// composer's preview, so what an author is shown while writing is the same component that renders afterwards
// (the kudos equivalent is KudosCardBody).
//
// Layout: the title across the top, the message under it, then whatever the kind adds below (a poll's options).
// Where the sticker goes is the author's call - see the wrap modes in CardSticker - so the only job here is to
// render it in the slot that mode needs: its own column beside the text, floated inside the text so the words
// wrap around it, or floating over/under the card at a point of its own. A post's sticker starts behind the
// words: decoration, rather than competition for the column.
//
// `wrapAll` puts the heading and the block below into that same flow, so they wrap around the picture like the
// message does instead of taking a full-width row above and below it. Polls ask for this: the question and the
// options are short, and a picture beside them is the natural use of the space they leave. It is a per-kind
// choice rather than the default because for an announcement the title reads as a header, and a header that
// stops short to make room for a sticker reads as a mistake.

// Centring a heading has to move the whole row, not just the text inside it, or the "New" dot would stay pinned
// left while the words drifted away from it.
const TITLE_ALIGN = { left: "justify-start text-left", center: "justify-center text-center", right: "justify-end text-right" } as const;

export function PostCardBody({
  title,
  titleAlign,
  body,
  artUrl,
  stickerLayout,
  onStickerLayoutChange,
  bodyValign,
  headerExtra,
  headerClassName,
  below,
  wrapAll,
  titlePlaceholder,
  bodyPlaceholder,
}: {
  title: string;
  titleAlign?: "left" | "center" | "right"; // the heading has no attribute line of its own - see the schema note
  body?: string | null;
  artUrl?: string; // "" / undefined = no sticker
  stickerLayout?: StickerLayout | null; // where the author put it; null = the card's default placement
  onStickerLayoutChange?: (layout: StickerLayout) => void; // set = the composer preview, where it can be dragged
  bodyValign?: BodyValign; // where the words ride in a card a sticker has made taller than they are
  headerExtra?: ReactNode; // the feed's "New" dot
  headerClassName?: string; // the feed right-pads the title to clear its corner actions
  below?: ReactNode; // the poll block
  wrapAll?: boolean; // heading and `below` flow around the picture too, instead of taking full-width rows
  titlePlaceholder?: string; // stand-ins for the composer preview, while the fields are still empty
  bodyPlaceholder?: string;
}) {
  const [aspect, setAspect] = useState(1.4);
  const text = body || bodyPlaceholder;
  const at = stickerLayout ?? POST_STICKER_LAYOUT;
  const wrap = at.wrap ?? DEFAULT_WRAP;
  const floated = !!artUrl && isWrapped(wrap); // has to precede the line boxes it displaces
  // A band goes BETWEEN two paragraphs, so RichText places it rather than this wrapper - that is what gives it
  // words above as well as below, and lets it move through the body without pushing it down.
  const banded = !!artUrl && wrap === "top-bottom";
  const beside = !!artUrl && wrap === "inline"; // its own column next to them
  // Words down both sides means splitting the body in two with the picture between - see the note in CardSticker.
  const twoColumn = !!artUrl && needsColumns(stickerLayout, POST_STICKER_LAYOUT);

  const art = artUrl ? (
    <PlacedElement
      at={stickerLayout}
      template={POST_STICKER_LAYOUT}
      onChange={onStickerLayoutChange}
      aspect={aspect}
      label="sticker"
      artUrl={artUrl}
    >
      <StickerImage url={artUrl} onAspect={setAspect} />
    </PlacedElement>
  ) : null;

  // A heading is a flex box, so it is its own formatting context and will already step aside for a float rather
  // than running under it - all it needs is to come AFTER the picture in the flow, which is what `wrapAll` does.
  const heading = (
    <h3 className={cn("flex items-center gap-2 font-semibold", TITLE_ALIGN[titleAlign ?? "left"], headerClassName)}>
      <span className={cn("min-w-0", !title && "text-muted-foreground/60")}>{title || titlePlaceholder}</span>
      {headerExtra}
    </h3>
  );

  return (
    // Room for a sticker floating clear of the text: its height is (size / aspect) of the card's width.
    <CardCanvas reserve={artUrl ? reserveFor(stickerLayout, POST_STICKER_LAYOUT, aspect) || undefined : undefined}>
      {!wrapAll && heading}
      {/* A picture in its own column rides level with the words rather than at the top of them - the same
          default as everything else on a card (see DEFAULT_VALIGN). */}
      <div className={cn(!wrapAll && "mt-2", beside && "flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5")}>
        {/* A column, and the two free-floating modes, render here: a floating sticker is out of flow anyway, so
            sharing this slot with the column is what lets a drag convert one into the other without React
            unmounting the element mid-gesture. A float and a band are placed further in, by the text itself. */}
        {!floated && !banded && art}
        <div
          className={cn(
            // `relative` so a picture sitting in the gutter positions against the words it divides.
            "relative min-w-0 flex-1",
            // A word too long for the strip left beside the picture would otherwise overflow its line box and run
            // straight across the artwork. Breaking it is what a word processor does, and it is the only thing
            // that holds as the picture grows: the strip narrows with every extra bit of sticker, so past some
            // size SOME word is always too long for it.
            "break-words",
            // Contain the float. Without a formatting context of its own this block is only as tall as its words,
            // so a picture taller than them hangs out of the bottom - over the poll block, or whatever the kind
            // puts below. In the `beside` layout this is already a flex item, which is a context; on its own it
            // is not, which is exactly the case tight and square are in.
            floated && "flow-root",
            // While a sticker BEHIND the words is being placed, the text lets pointers through to it - otherwise
            // the paragraph on top would swallow half the drag area.
            wrap === "behind" && !!onStickerLayoutChange && "pointer-events-none",
          )}
        >
          {/* A float has to precede the line boxes it displaces. */}
          {floated && art}
          {banded && !body && art}
          {/* Only the WORDS move for a vertical position - the picture keeps the spot it was placed in. For a
              poll, "the words" is the question, its description and its options together: they are one block of
              content, and centring only the middle of the three would slide it over the options, which stay
              where they were laid out (the offset is a transform, not a layout change). */}
          <ValignBlock valign={bodyValign}>
            {/* The heading has to come after the picture in the flow for it to wrap around it at all. */}
            {wrapAll && heading}
            {text &&
              (!body ? (
                <p className="text-sm text-muted-foreground/60">{text}</p>
              ) : twoColumn ? (
                <SplitRichText
                  source={body}
                  className="text-sm text-foreground/80"
                  left={<HalfSpacer at={stickerLayout} fallback={POST_STICKER_LAYOUT} aspect={aspect} side="left" artUrl={artUrl} />}
                  right={<HalfSpacer at={stickerLayout} fallback={POST_STICKER_LAYOUT} aspect={aspect} side="right" artUrl={artUrl} />}
                />
              ) : (
                <RichText
                  source={body}
                  className="text-sm text-foreground/80"
                  insert={banded ? art : undefined}
                  insertAt={banded ? at.y : undefined}
                />
              ))}
            {/* `flow-root` is what makes the options step aside. They are block boxes, and a block box does not
                avoid a float - it runs underneath it and only its LINE boxes shorten, which for a full-width
                option bar means the bar slides under the picture. A formatting context of its own is placed clear
                of the float instead, and the bars then fill that narrower space. Block-level avoidance uses the
                float's box rather than its traced outline, so the poll keeps clear of the whole picture in every
                mode. */}
            {wrapAll && below && <div className="flow-root">{below}</div>}
          </ValignBlock>
        </div>
      </div>
      {!wrapAll && below}
    </CardCanvas>
  );
}
