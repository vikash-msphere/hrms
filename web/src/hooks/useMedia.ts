import { useEffect, useState } from "react";

/** A reactive CSS media-query match (SSR-safe default false). For layouts that must FORK in JS rather than in
 *  CSS - a component that would otherwise have to be mounted twice to be shown two ways. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return matches;
}
