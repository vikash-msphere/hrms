import { useState } from "react";
import { ArrowDown, ArrowUp, Sparkles, TrendingUp } from "lucide-react";
import { invoke } from "@/api";
import { cn } from "@/lib/utils";
import { formatMetric } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import type { Finding } from "../../../../src/domain/narrate";

// What moved in the team report since the period before it.
//
// THE NUMBERS ARE THE PANEL; THE SENTENCE IS ADDED TO THEM. `people-analytics:narrate` finds the movements
// arithmetically (domain/narrate.ts `findMovements`) and only then asks a model to write them up, so the
// endpoint answers "what changed" whether or not the AI feature is on: with it off it returns the same
// findings and a deterministic summary marked `source: "plain"`. This panel renders the findings either way
// and the written paragraph only when a model produced one that passed the grounding check.
//
// That is also how the hide-never-disable rule lands here. There is no AI control on this panel to switch
// off - no button that would answer "AI is not enabled for this organisation" - only a paragraph that is
// absent. With the feature off the panel is an ordinary period-on-period comparison, which is worth having
// on its own and is why it does not wait on anybody enabling inference.
//
// LAZY ON PURPOSE. Narrating runs the whole report a second time over the preceding window, so it is a
// second full set of D1 reads on a page that has already paid for one. It waits to be asked.

/** The server's `Narration` (services/analyticsNarrate.ts), less the fields this panel has no use for. */
type Narration = {
  text: string;
  findings: Finding[];
  source: "model" | "plain";
  window: { from: string; to: string };
  compared_to: { from: string; to: string };
};

/** Was this movement in the measure's good direction? `none` covers the measures that are neither. */
function toneOf(f: Finding): "good" | "bad" | null {
  if (f.direction === "none") return null;
  return (f.movement === "up") === (f.direction === "higher") ? "good" : "bad";
}

/**
 * Remount this on a window change rather than reloading in place - `key={`${from}|${to}|${dept}`}` at the
 * call site. Re-narrating silently under someone who has changed the dates shows a paragraph about a period
 * they are no longer looking at; collapsing back is the honest reset, and it costs a click on a panel they
 * had to open in the first place.
 */
export function WhatChanged({ from, to, department }: { from: string; to: string; department?: string }) {
  const [state, setState] = useState<"shut" | "loading" | "ready" | "error">("shut");
  const [data, setData] = useState<Narration | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setState("loading");
    const body: Record<string, unknown> = { from, to };
    if (department) body.department = `departments/${department}`;
    invoke<Narration>("people-analytics", "narrate", undefined, body)
      .then((r) => { setData(r); setState("ready"); setError(null); })
      .catch((e: unknown) => { setState("error"); setError(e instanceof Error ? e.message : String(e)); });
  };

  if (state === "shut") {
    return (
      <div className="mb-4">
        <Button variant="outline" size="sm" onClick={load}>
          <TrendingUp className="mr-1.5 h-3.5 w-3.5" />
          What changed since the previous period
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">What changed</p>
        {data && (
          <p className="text-xs text-muted-foreground">
            against {data.compared_to.from} to {data.compared_to.to}
          </p>
        )}
      </div>

      {state === "loading" && <p className="text-sm text-muted-foreground">Comparing with the previous period...</p>}

      {state === "error" && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      )}

      {state === "ready" && data && (
        data.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing moved much against the previous period.</p>
        ) : (
          <>
            {/* Only a model-written paragraph is shown. The `plain` fallback is the findings below read out
                as a sentence, so printing it here would say everything twice. */}
            {data.source === "model" && (
              <div className="mb-3 flex gap-2 rounded-lg bg-muted/50 p-3">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm">{data.text}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Written by AI from the figures below.</p>
                </div>
              </div>
            )}
            <ul className="space-y-1.5">
              {data.findings.map((f) => {
                const tone = toneOf(f);
                return (
                  <li key={f.key} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-muted-foreground">{f.label}</span>
                    <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                      <span className="text-muted-foreground">{formatMetric(f.previous, f.unit)}</span>
                      {f.movement === "up"
                        ? <ArrowUp className="h-3 w-3 self-center" />
                        : <ArrowDown className="h-3 w-3 self-center" />}
                      <span className={cn("font-medium", tone === "good" && "text-success", tone === "bad" && "text-destructive")}>
                        {formatMetric(f.current, f.unit)}
                      </span>
                      {f.changePct !== null && (
                        <span className="text-xs text-muted-foreground">
                          {Math.abs(f.changePct)}%
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )
      )}
    </div>
  );
}
