import { useCallback, useEffect, useState } from "react";
import { get } from "@/api";
import type { Employee } from "@/types";
import type { LoadState } from "./useCollection";

export function useEmployee(id: string | null) {
  const [emp, setEmp] = useState<Employee | null>(null);
  const [state, setState] = useState<LoadState>(id ? "loading" : "ready");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setEmp(null);
      setError(null);
      setState("ready");
      return;
    }
    let active = true;
    setState("loading");
    // Cleared with the state, as `useResource` does. A message left over from a previous id (or a previous
    // attempt) outlives the failure it describes: today both consumers render it through `<DataState>`, which
    // only shows an error in the `error` state, so it is masked - but it is a stale string waiting for the next
    // consumer that reads `error` on its own.
    setError(null);
    get<Employee>(`employees/${id}`)
      .then((e) => {
        if (!active) return;
        setEmp(e);
        setState("ready");
      })
      .catch((e) => {
        if (!active) return;
        setError((e as Error).message);
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [id, tick]);

  // Stable across renders, like `useResource`'s: a fresh closure each render re-runs any effect that lists it
  // as a dependency, every render.
  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { emp, state, error, reload };
}
