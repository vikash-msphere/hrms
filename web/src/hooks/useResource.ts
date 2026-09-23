import { useCallback, useEffect, useState } from "react";
import { get } from "@/api";
import type { LoadState } from "./useCollection";

/**
 * ONE record, read by id: `GET /v1/<collection>/<id>`.
 *
 * The alternative a detail page reaches for by habit is `useCollection(collection).find(...)`, which is both
 * dearer and wrong at the edges: it reads a page of up to a hundred rows to use one of them, and the record it
 * wants may be past the page cursor - so the page renders "not found" for a record that exists. One id, one
 * row, always the right one.
 *
 * Rides the GET coalescer like every other read, so a page that reads several records by id still makes one
 * request. Not cached in the resource store: the store is keyed by list, and a record read has no list to share
 * with - which also means `reload()` here is the honest way to refresh it after a write.
 */
export function useResource<T>(collection: string, id: string | null | undefined) {
  const [row, setRow] = useState<T | null>(null);
  const [state, setState] = useState<LoadState>(id ? "loading" : "ready");
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setRow(null);
      setState("ready");
      return;
    }
    let live = true;
    setState("loading");
    setError(undefined);
    get<T>(`${collection}/${id}`).then(
      (r) => {
        if (!live) return;
        setRow(r);
        setState("ready");
      },
      (e) => {
        if (!live) return;
        // A 404 is a settled answer ("no such record"), not a failure to show a retry button for: the page
        // renders its own not-found state from a null row.
        const status = (e as { status?: number }).status;
        setRow(null);
        if (status === 404) {
          setState("ready");
        } else {
          setError((e as Error).message);
          setState("error");
        }
      },
    );
    return () => {
      live = false;
    };
  }, [collection, id, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { row, state, error, reload };
}
