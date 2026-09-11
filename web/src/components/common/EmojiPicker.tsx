import { useEffect, useState, type ReactNode } from "react";
import type { EmojiMartData } from "@emoji-mart/data";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { TilesSkeleton } from "@/components/common/Skeletons";

// A self-contained emoji picker: a hand-picked quick row on top, a search box, and the full unicode set
// grouped by category. The dataset (@emoji-mart/data, ~1900 emoji) is lazy-loaded the first time any picker
// opens and cached module-wide, so it never weighs on initial page load. We render native glyphs only - no
// emoji-mart React component - so the UI stays consistent with the rest of the app. Used by the board's
// reaction control and the post editor.

const QUICK = ["👍", "💯", "✅", "🎉", "👏", "🙏", "😂", "😮"];
const CATEGORY_LABEL: Record<string, string> = {
  people: "Smileys & People",
  nature: "Animals & Nature",
  foods: "Food & Drink",
  activity: "Activity",
  places: "Travel & Places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags",
};

let cache: EmojiMartData | null = null;
async function loadData(): Promise<EmojiMartData> {
  if (cache) return cache;
  const mod = await import("@emoji-mart/data");
  cache = ((mod as { default?: EmojiMartData }).default ?? (mod as unknown as EmojiMartData));
  return cache;
}

export function EmojiPicker({
  onPick,
  children,
  align = "start",
}: {
  onPick: (emoji: string) => void;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EmojiMartData | null>(cache);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (open && !data) void loadData().then(setData);
  }, [open, data]);

  function pick(native: string) {
    onPick(native);
    setOpen(false);
    setQ("");
  }

  const term = q.trim().toLowerCase();
  const matches: string[] | null =
    data && term
      ? (() => {
          const out: string[] = [];
          for (const id in data.emojis) {
            const e = data.emojis[id]!;
            if (e.name.toLowerCase().includes(term) || e.keywords.some((k) => k.includes(term))) {
              const native = e.skins[0]?.native;
              if (native) out.push(native);
            }
            if (out.length >= 64) break;
          }
          return out;
        })()
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-2">
        {/* Named, because every glyph in it appears again in its own category below: without a group there are
            two identical "🎉" buttons in the popover and nothing to say which one is the shortcut. */}
        <div role="group" aria-label="Quick picks" className="mb-2 flex flex-wrap gap-1 border-b pb-2">
          {QUICK.map((e) => (
            <button key={e} type="button" className="rounded p-1 text-xl leading-none hover:bg-accent" onClick={() => pick(e)}>
              {e}
            </button>
          ))}
        </div>
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search emoji" className="mb-2 h-8" autoFocus />
        <div className="max-h-56 overflow-y-auto">
          {!data ? (
            // The emoji set is a ~1MB import; a grid of tiles keeps the popover the height it will be.
            <TilesSkeleton count={32} className="grid-cols-8 gap-0.5 sm:grid-cols-8" />
          ) : matches ? (
            matches.length ? (
              <div className="grid grid-cols-8 gap-0.5">
                {matches.map((e, i) => (
                  <button key={`${e}-${i}`} type="button" className="rounded p-1 text-xl leading-none hover:bg-accent" onClick={() => pick(e)}>
                    {e}
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">No emoji found</p>
            )
          ) : (
            data.categories.map((cat) => (
              <div key={cat.id} className="mb-2">
                <p className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{CATEGORY_LABEL[cat.id] ?? cat.id}</p>
                <div className="grid grid-cols-8 gap-0.5">
                  {cat.emojis.map((id) => {
                    const native = data.emojis[id]?.skins[0]?.native;
                    return native ? (
                      <button key={id} type="button" className="rounded p-1 text-xl leading-none hover:bg-accent" onClick={() => pick(native)}>
                        {native}
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
