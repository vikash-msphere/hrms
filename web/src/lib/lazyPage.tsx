import * as React from "react";
import { RefreshCw } from "lucide-react";
import { sessionDead, sessionLapsed, waitForSignIn } from "@/api";
import { Button } from "@/components/ui/button";

// React.lazy() remembers the FIRST outcome of its importer forever. Once that dynamic import rejects - an
// offline blip, a chunk request that lost the race with a deploy - the lazy component replays the stored
// rejection on every later render and never calls the importer again. That is why the crash boundary's "Try
// again" looked dead: it cleared the error, re-rendered the very same lazy component, and got the cached
// rejection straight back, so only a full page reload ever recovered.
//
// lazyPage keeps lazy()'s call shape but mints its lazy component per RETRY GENERATION, so bumping the
// generation (retryLazyChunks) makes the next render run `import()` for real.

let generation = 0;
const subs = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

const getGeneration = () => generation;

/** Forget every already-attempted chunk so the next render re-imports it. Called by the retry in ErrorBoundary. */
export function retryLazyChunks(): void {
  generation++;
  subs.forEach((cb) => cb());
}

/**
 * The one failure a retry can't fix in place: the chunk itself is unreachable. After a deploy the hashed file
 * the running tab is asking for is simply gone, so re-importing it fails identically - only a reload (which
 * fetches the new index.html and its new hashes) recovers. The boundary uses this to offer the right button.
 */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /ChunkLoadError|Loading chunk|dynamically imported module|module script failed|Importing a module/i.test(msg);
}

/**
 * One transparent retry before anybody is shown a boundary.
 *
 * A chunk request can fail on the way rather than because anything is wrong with it: a stalled response, a
 * server restarting mid-request, a connection dropped on a train. That failure takes the whole panel down
 * behind "Try again" - a button the reader has to notice and press for a fetch that would have worked on the
 * second attempt. Retried once, quietly, and only for a FETCH failure: a module that throws while evaluating
 * fails identically twice, so the second attempt costs one request and changes nothing about what is shown.
 * (Where it helps depends on the browser. Chrome keeps a failed module fetch for the life of the document, so
 * there the retry replays the failure without a request - seen in e2e/sessionExpiry.spec.ts's trace. It is kept
 * for the browsers that do fetch again, and costs nothing where they do not.)
 *
 * A signed-out tab is the other cause, and needs the opposite answer. The static-site gate
 * (src/http/staticSite.ts) refuses every chunk once the session has lapsed, so a retry fails the same way and
 * the crash boundary's "this tab is out of date - reload" is wrong twice over: nothing shipped, and a reload
 * would take the person away to sign in. So a failed chunk asks whether the session is alive first. If it is not,
 * the ordinary lapse path runs (sessionDead: the in-place "Signed out" dialog, sibling tabs told), and the import
 * waits - behind the Suspense fallback - until the dialog reports the person signed back in, then tries again.
 * Where the browser has kept the failure (Chrome, above) that attempt cannot succeed, and only a reload fetches
 * the chunk: the page then shows SignedBackIn, which says so and offers one. Not an error, and not the crash
 * boundary - nothing is broken, and a boundary would log a crash to the console and to Sentry every time a tab
 * left open overnight meets its first new page.
 */
function retryingImport<T>(load: () => Promise<{ default: T }>): () => Promise<{ default: T }> {
  return () =>
    load().catch(async (e) => {
      if (!isChunkLoadError(e)) throw e;
      if (await sessionLapsed()) {
        const back = waitForSignIn();
        sessionDead();
        await back;
        try {
          return await load();
        } catch (again) {
          if (!isChunkLoadError(again)) throw again;
          return { default: SignedBackIn as unknown as T };
        }
      }
      return new Promise<{ default: T }>((resolve, reject) => {
        setTimeout(() => load().then(resolve, reject), 300);
      });
    });
}

/** Stands in for a page or panel whose chunk was refused while signed out and that the browser will not fetch
 *  again until the document reloads (see retryingImport). The session is fine by now - the dialog just checked -
 *  so a reload lands here signed in. Nothing reloads by itself: whatever else is on screen, a half-written form
 *  included, stays until the person chooses to. */
function SignedBackIn() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <RefreshCw className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold text-foreground">You're signed back in</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        This part of the app was held back while you were signed out, and the browser won't fetch it again until
        the page reloads. Save anything you're in the middle of, then reload to finish loading it.
      </p>
      <div className="mt-5 flex gap-2">
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  );
}

/** Drop-in for React.lazy() whose failures are retryable. Use it for every route/panel-level import. */
export function lazyPage<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): React.FunctionComponent<React.ComponentProps<T>> {
  const built = new Map<number, React.LazyExoticComponent<T>>();
  const importer = retryingImport(load);
  const at = (g: number) => {
    let c = built.get(g);
    if (!c) {
      built.clear(); // only the current generation is worth holding: older ones carry the failure we just retried
      c = React.lazy(importer);
      built.set(g, c);
    }
    return c as React.ComponentType<any>;
  };
  return function LazyPage(props: React.ComponentProps<T>) {
    const g = React.useSyncExternalStore(subscribe, getGeneration, getGeneration);
    const Component = at(g);
    return <Component {...props} />;
  };
}
