import { useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import {
  type BodyValign,
  CardCanvas,
  DEFAULT_WRAP,
  HalfSpacer,
  isWrapped,
  ValignBlock,
  needsColumns,
  wrapSide,
  KUDOS_RECIPIENT_LAYOUT,
  KUDOS_STICKER_LAYOUT,
  PlacedElement,
  reserveFor,
  StickerImage,
} from "@/components/common/CardSticker";
import { RichText, SplitRichText } from "@/lib/richText";
import type { RecipientLayout, StickerLayout } from "@/types";

// The inside of a kudos card. Shared by the board feed and the composer's "Preview" so what a giver is shown
// before posting is the same component that renders afterwards - not a lookalike that drifts.
//
// Layout: a header naming the recipient, then a row of three - the card art on the left at a fixed 200px and full
// strength, the remark in the middle at a size that scales inversely with its length, and the recipient hero on
// the right. Stacks vertically on narrow screens. That trio IS the kudos card, so it is what a card shows until
// the giver decides otherwise.
//
// Either the art or the recipient can be picked up and placed by hand - just drag it in the composer preview, no
// mode to arm - and either can take any of the word-processor wrap modes (see CardSticker). Whatever leaves the
// row gives its width to the remark.

// A short shout-out reads huge; a paragraph stays readable.
export function kudosQuoteSize(message: string): string {
  const n = message.length;
  return n <= 55 ? "text-2xl" : n <= 130 ? "text-xl" : n <= 260 ? "text-lg" : "text-base";
}

export function KudosCardBody({
  recipientName,
  recipientId,
  recipientPhoto,
  recipientFirstName,
  recipientLastName,
  message,
  artUrl,
  artIsSticker,
  stickerLayout,
  onStickerLayoutChange,
  recipientLayout,
  onRecipientLayoutChange,
  iconClassName,
  bodyValign,
  headerExtra,
  headerClassName,
  placeholder,
}: {
  recipientName: string;
  recipientId?: string;
  recipientPhoto?: string;
  recipientFirstName?: string;
  recipientLastName?: string;
  message: string;
  artUrl: string;
  artIsSticker: boolean;
  stickerLayout?: StickerLayout | null; // where the giver placed the art; null = the default 200px column
  onStickerLayoutChange?: (layout: StickerLayout) => void; // set = the composer preview, where it can be dragged
  recipientLayout?: RecipientLayout | null; // where the giver placed the recipient; null = its default column
  onRecipientLayoutChange?: (at: RecipientLayout) => void;
  iconClassName?: string; // the level tier's accent colour
  bodyValign?: BodyValign; // where the remark rides in the card's height
  headerExtra?: ReactNode; // the feed's "New" dot
  headerClassName?: string; // the feed right-pads the header to clear its corner actions
  placeholder?: string; // stand-in shown while the message is still empty (composer preview)
}) {
  const [aspect, setAspect] = useState(1.4);
  const shown = message.trim();
  const artAt = stickerLayout ?? KUDOS_STICKER_LAYOUT;
  const heroAt = recipientLayout ?? KUDOS_RECIPIENT_LAYOUT;
  const artWrap = artAt.wrap ?? DEFAULT_WRAP;
  // A card has ONE body of text, so two of these arrangements are exclusive: only one thing can stand between the
  // split columns, and only one can be a band in the paragraphs. When the art and the recipient both ask for the
  // same one, the art keeps it and the recipient falls back to its column - rather than the two of them landing on
  // top of each other, or the loser vanishing from the card altogether.
  const artMiddle = !!artUrl && needsColumns(stickerLayout, KUDOS_STICKER_LAYOUT);
  const artBanded = !!artUrl && artWrap === "top-bottom";
  const heroWants = heroAt.wrap ?? DEFAULT_WRAP;
  const heroClash =
    (heroWants === "top-bottom" && artBanded) ||
    (isWrapped(heroWants) && wrapSide(heroAt.x) === "middle" && artMiddle);
  // The fallback is expressed as a placement, not a special case downstream: everything below reads one value.
  const heroPlacement = heroClash ? { ...heroAt, wrap: "inline" as const } : recipientLayout;
  const heroWrap = heroClash ? "inline" : heroWants;

  // A float has to sit among the words it displaces; everything else - a column, and the two floating modes -
  // shares the row slot, which is what lets a drag turn one into the other without React unmounting the element
  // mid-gesture.
  const artFloated = !!artUrl && isWrapped(artWrap);
  const heroFloated = isWrapped(heroWrap);
  // A band goes BETWEEN two paragraphs of the remark, placed by RichText - see PostCardBody for why.
  const heroBanded = heroWrap === "top-bottom";
  // Words down both sides means splitting the remark in two with whatever stands between - see CardSticker.
  const heroMiddle = !artMiddle && needsColumns(heroPlacement, KUDOS_RECIPIENT_LAYOUT);
  const twoColumn = artMiddle || heroMiddle;
  // The spacers belong to whichever of the two is actually standing in the gap. Only the art has an outline to
  // halve; the recipient is a DOM block, so its columns hold off its box.
  const middleAt = artMiddle ? stickerLayout : heroPlacement;
  const middleFallback = artMiddle ? KUDOS_STICKER_LAYOUT : KUDOS_RECIPIENT_LAYOUT;
  const middleAspect = artMiddle ? aspect : 1;
  const middleArt = artMiddle ? artUrl : undefined;
  // A float belongs to ONE of the split columns, not to the block that holds both. Left where it is, the split
  // container - a flex box, so its own formatting context - is narrowed beside the float and shifts right, while
  // whatever stands between the columns is still anchored to the middle of the text block. The two midpoints stop
  // agreeing and the right-hand column runs straight over the picture. Inside a column it also does the thing a
  // float is for: wrap the words next to it.
  const artInColumn = artFloated && !artMiddle && twoColumn;
  const heroInColumn = heroFloated && !heroMiddle && twoColumn;
  const columnFloat = (side: "left" | "right") => (
    <>
      {artInColumn && (artAt.x < 0.5) === (side === "left") && art}
      {heroInColumn && (heroAt.x < 0.5) === (side === "left") && recipient}
    </>
  );

  // The recognized person. Everything inside is sized in `cqw` - 1% of THIS block's width, via the container it
  // declares - so resizing the block scales the photo and the name with it instead of just widening a box.
  const hero = (
    <div className="flex w-full flex-col items-center gap-2 text-center [container-type:inline-size]">
      <PhotoAvatar employeeId={recipientId ?? ""} name={recipientName} photo={recipientPhoto} className="h-[70cqw] w-[70cqw]" />
      {recipientFirstName || recipientLastName ? (
        <span className="leading-tight text-muted-foreground">
          <span className="block text-[clamp(0.75rem,13cqw,1.5rem)] font-semibold">{recipientFirstName}</span>
          <span className="block text-[clamp(0.75rem,13cqw,1.5rem)] font-medium">{recipientLastName}</span>
        </span>
      ) : (
        <span className="text-[clamp(0.75rem,13cqw,1.5rem)] font-semibold leading-tight text-muted-foreground">{recipientName}</span>
      )}
    </div>
  );

  const art = artUrl ? (
    <PlacedElement
      at={stickerLayout}
      template={KUDOS_STICKER_LAYOUT}
      onChange={onStickerLayoutChange}
      aspect={aspect}
      label="art"
      artUrl={artUrl}
      flowClassName="hidden w-[200px] shrink-0 sm:block"
    >
      {/* KUDOS_ART_DIECUT (inside StickerImage) gives dark mode a solid white silhouette behind a brand sticker;
          without it the dark-navy slogans vanish into the card. Illustrations are slate-toned and get none. */}
      <StickerImage url={artUrl} isSticker={artIsSticker} onAspect={setAspect} />
    </PlacedElement>
  ) : null;

  const recipient = (
    <PlacedElement
      at={heroPlacement}
      template={KUDOS_RECIPIENT_LAYOUT}
      onChange={onRecipientLayoutChange}
      label="recipient"
      flowClassName="w-28 shrink-0"
    >
      {hero}
    </PlacedElement>
  );

  // Room for anything that sits outside the normal flow, so the card contains it instead of clipping it away.
  // The art's height follows its aspect; the recipient block is roughly square once the name sits under the photo.
  const reserve = Math.max(
    artUrl ? reserveFor(stickerLayout, KUDOS_STICKER_LAYOUT, aspect) : 0,
    reserveFor(heroPlacement, KUDOS_RECIPIENT_LAYOUT),
  );

  return (
    <CardCanvas reserve={reserve || undefined}>
      <div className="flex min-h-[260px] flex-col gap-4">
        {/* Header: who was recognized, with an appreciation flourish. The card tint carries the level. */}
        <div className={cn("flex flex-wrap items-center gap-2", headerClassName)}>
          <Sparkles className={cn("h-4 w-4 shrink-0", iconClassName)} />
          <p className="text-sm text-muted-foreground">
            Kudos to <span className="font-semibold text-foreground">{recipientName || "…"}</span>
          </p>
          {headerExtra}
        </div>
        <div className="flex flex-1 flex-col items-center gap-6 sm:flex-row sm:gap-10">
          {!artFloated && !artBanded && art}
          <div
            className={cn(
              // `relative` so a picture sitting in the gutter positions against the words it divides.
              "relative min-w-0 flex-1",
              // A word too long for the strip left beside the art would overflow its line box and run across the
              // artwork; breaking it is the only thing that holds as the art grows. It bites sooner here than on
              // an ordinary post, because a short remark is set large (kudosQuoteSize) - big words need a wide
              // strip, so a smaller picture is already enough to deny them one.
              // This block is a flex item, so it is already a formatting context and contains its own floats.
              "break-words",
              // While something BEHIND the words is being placed, the remark lets pointers through to it.
              ((artWrap === "behind" && !!onStickerLayoutChange) || (heroWrap === "behind" && !!onRecipientLayoutChange)) && "pointer-events-none",
            )}
          >
            {/* Anything floated has to precede the words it displaces. The remark is markdown-lite like any other
                body, but its default type size comes from how long it is (kudosQuoteSize) - a two-word shout-out
                reads huge. An explicit size in the source still wins, since the block's own class applies
                inside. */}
            {artFloated && !artInColumn && art}
            {heroFloated && !heroInColumn && recipient}
            {!shown && artBanded && art}
            {!shown && heroBanded && recipient}
            {/* Only the WORDS move for a vertical position - the art and the recipient keep the spots they were
                placed in. */}
            <ValignBlock valign={bodyValign}>
            {shown && twoColumn ? (
              <SplitRichText
                source={shown}
                className={cn("text-center font-medium leading-relaxed text-foreground/90", kudosQuoteSize(shown))}
                left={
                  <>
                    <HalfSpacer at={middleAt} fallback={middleFallback} aspect={middleAspect} side="left" artUrl={middleArt} />
                    {columnFloat("left")}
                  </>
                }
                right={
                  <>
                    <HalfSpacer at={middleAt} fallback={middleFallback} aspect={middleAspect} side="right" artUrl={middleArt} />
                    {columnFloat("right")}
                  </>
                }
                // A band survives a split: it goes into whichever half its fraction falls in.
                insert={artBanded ? art : heroBanded ? recipient : undefined}
                insertAt={artBanded ? artAt.y : heroBanded ? heroAt.y : undefined}
              />
            ) : shown ? (
              <RichText
                source={shown}
                className={cn("text-center font-medium leading-relaxed text-foreground/90", kudosQuoteSize(shown))}
                // One band at a time between the paragraphs; the art takes precedence when both ask for it.
                insert={artBanded ? art : heroBanded ? recipient : undefined}
                insertAt={artBanded ? artAt.y : heroBanded ? heroAt.y : undefined}
              />
            ) : (
              <p className={cn("text-center font-medium leading-relaxed text-muted-foreground/60", kudosQuoteSize(placeholder || ""))}>{placeholder}</p>
            )}
            </ValignBlock>
          </div>
          {!heroFloated && !heroBanded && recipient}
        </div>
      </div>
    </CardCanvas>
  );
}
