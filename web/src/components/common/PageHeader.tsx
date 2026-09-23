import * as React from "react";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessScope } from "@/components/access/AccessScope";
import { cn } from "@/lib/utils";

// The page's standing explanation - useful the first time, furniture every time after. At full width it costs
// one line and is worth it. On a phone the longest of them run to four lines of a screen that is already
// carrying a title, a metric strip and a toolbar before the first row of actual content, so below `sm` it
// clamps to two lines and expands on tap.
//
// The toggle is a separate control rather than the paragraph itself: text inside a <button> cannot be
// selected by dragging across it, and a page description is the sort of thing people copy into a message to a
// colleague. It exists only where the clamp does (below `sm`) and only when the text is long enough for the
// clamp to be hiding something - a clamp with no way out is text lost, and on touch there is no hover to hint
// that more exists.
function PageDescription({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const clampable = text.length > 90;
  return (
    <>
      <p
        id="page-description"
        className={cn(
          "mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground",
          clampable && !open && "line-clamp-2 sm:line-clamp-none",
        )}
      >
        {text}
      </p>
      {clampable && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="page-description"
          className="mt-0.5 text-sm font-medium text-primary sm:hidden"
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  accessCollection,
}: {
  // Optional small uppercase context line above the title (e.g. the section/workspace this page sits in), so
  // a page reads as situated rather than free-floating.
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  // When set, the page title carries a collection-level access icon (visible in access mode) so the whole
  // page's read/write/admin access can be managed right from its header.
  accessCollection?: string;
}) {
  return (
    // `flex-wrap` on the row itself, so the action cluster drops to a line of its own AS A UNIT when it does
    // not fit beside the title. Without it the cluster wrapped internally instead, and a header with three
    // labelled actions became a two-line ragged stack pinned beside a title that had been squeezed to a
    // third of the width - worst at tablet size, where there is enough room to look deliberate and not
    // enough to be. Below `sm` it is a column as before.
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
      {/* `basis-64 grow`: the title keeps a sane minimum before the cluster is asked to wrap, rather than
          being squeezed to a word and a half while the buttons hold their full width. */}
      <div className="min-w-0 sm:basis-64 sm:grow">
        {eyebrow && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
          {accessCollection ? (
            /* The header icon manages the WHOLE collection. A fresh scope drops any ambient object pin (a
               deep-link route like tickets/<id> sets one), so the icon never narrows to the opened row. */
            <AccessScope collection={accessCollection}>
              <AccessAction collection={accessCollection} label={title}><span>{title}</span></AccessAction>
            </AccessScope>
          ) : (
            title
          )}
        </h1>
        {description && <PageDescription text={description} />}
      </div>
      {/* `[&>*]:flex-wrap` reaches the caller's own cluster: most pages pass a single <div className="flex
          gap-2"> holding two or three labelled buttons, and as ONE flex item that div's floor is the sum of
          them - three "Generate letter"-sized buttons are wider than a phone. Letting that child wrap too
          makes the header's floor its widest button, whoever wrote the cluster. */}
      {/* `min-w-0`, NOT `shrink-0`. The two cancel each other out: `flex-wrap` only wraps once the container
          is offered less width than its content wants, and `shrink-0` is a promise never to offer it less -
          so the cluster kept its full width and simply hung off the right edge instead (measured: a header
          with three actions ran 25px past a 768px tablet). Letting it shrink is what turns the wrap on; the
          title beside it already carries its own `min-w-0`, so neither side can pin the row open. */}
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end [&>*]:flex-wrap">{actions}</div>}
    </div>
  );
}
