import * as React from "react";

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
 */
function retryingImport<T>(load: () => Promise<{ default: T }>): () => Promise<{ default: T }> {
  return () =>
    load().catch((e) => {
      if (!isChunkLoadError(e)) throw e;
      return new Promise<{ default: T }>((resolve, reject) => {
        setTimeout(() => load().then(resolve, reject), 300);
      });
    });
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
