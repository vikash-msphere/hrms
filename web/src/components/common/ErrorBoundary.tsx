import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

// Top-level crash guard. A lazy-loaded page can throw during render (a bad API shape, a null deref); without
// a boundary that white-screens the whole SPA with no recovery. This catches the throw, shows a recoverable
// fallback, and offers a reload. `resetKey` (the current route) auto-clears the error on navigation so a user
// isn't stuck on the fallback after moving to a healthy page.
type Props = { children: React.ReactNode; resetKey?: string };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Route changed while showing the fallback -> clear it and try to render the new page.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Something went wrong</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            This page hit an unexpected error. You can try reloading; if it keeps happening, let IT know.
          </p>
          <div className="mt-5 flex gap-2">
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
