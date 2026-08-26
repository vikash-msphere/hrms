import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryLazyChunks, isChunkLoadError } from "@/lib/lazyPage";
import { clearCache } from "@/lib/resourceStore";

// Top-level crash guard. A lazy-loaded page can throw during render (a bad API shape, a null deref); without
// a boundary that white-screens the whole SPA with no recovery. This catches the throw, shows a recoverable
// fallback, and offers a reload. `resetKey` (the current route) auto-clears the error on navigation so a user
// isn't stuck on the fallback after moving to a healthy page.
//
// "Try again" has to undo the two things that otherwise make a retry replay the identical crash:
//   - React.lazy caches a failed import forever, so re-rendering the same lazy page re-throws the stored
//     rejection (retryLazyChunks re-mints it - see lib/lazyPage.tsx),
//   - the resource store caches the rows the render died on, so a remount reads them straight back (clearCache).
// The attempt counter keys the subtree, so the retry is a genuine fresh mount rather than a re-render.
// A chunk that can't be fetched at all is the one case retrying in place cannot fix (after a deploy the hashed
// file this tab is asking for is gone), so that error offers a reload instead of a dead button.
type Props = { children: React.ReactNode; resetKey?: string };
type State = { error: Error | null; attempt: number };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Route changed while showing the fallback -> clear it and try to render the new page.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  private retry = () => {
    retryLazyChunks();
    clearCache();
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.error) {
      const stale = isChunkLoadError(this.state.error);
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">{stale ? "This tab is out of date" : "Something went wrong"}</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {stale
              ? "Part of the app couldn't be downloaded - it usually means a new version shipped while this tab was open. Reloading picks it up."
              : "This page hit an unexpected error. Try again reloads the page's data from scratch; if it keeps happening, let IT know."}
          </p>
          <div className="mt-5 flex gap-2">
            {!stale && (
              <Button variant="outline" onClick={this.retry}>
                Try again
              </Button>
            )}
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      );
    }
    // Keyed by attempt so "Try again" remounts the subtree instead of re-rendering the state that crashed it.
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}
