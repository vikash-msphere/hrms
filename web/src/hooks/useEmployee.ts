import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "@/api";
import type { Employee } from "@/types";
import type { LoadState } from "./useCollection";

export function useEmployee(id: string | null) {
  const [emp, setEmp] = useState<Employee | null>(null);
  const [state, setState] = useState<LoadState>(id ? "loading" : "ready");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // The id whose row `emp` holds.
  const held = useRef<string | null>(null);

  useEffect(() => {
    if (!id) {
      held.current = null;
      setEmp(null);
      setError(null);
      setState("ready");
      return;
    }
    let active = true;
    // A `reload()` of the record already in hand is a REFRESH, not a load: the row stays up and is swapped when
    // the new one lands. Going back to "loading" here put EmployeeProfile's whole `<DataState>` back to its
    // skeleton after every save that re-reads the row (emergency details, bio, photo, signature), which
    // unmounted every card under it - each re-read its own sub-resource from scratch, the tab's scroll was lost,
    // and a card could come back showing a different write than the one its own save had just answered with.
    const refresh = held.current === id;
    if (!refresh) setState("loading");
    // Cleared with the state, as `useResource` does. A message left over from a previous id (or a previous
    // attempt) outlives the failure it describes: today both consumers render it through `<DataState>`, which
    // only shows an error in the `error` state, so it is masked - but it is a stale string waiting for the next
    // consumer that reads `error` on its own.
    setError(null);
    get<Employee>(`employees/${id}`)
      .then((e) => {
        if (!active) return;
        held.current = id;
        setEmp(e);
        setState("ready");
      })
      .catch((e) => {
        if (!active) return;
        // A refresh that fails leaves the row it had on screen: the transport has already retried anything
        // transient, and the record read a moment ago is a truer page than an error wall over it.
        if (refresh) return;
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
