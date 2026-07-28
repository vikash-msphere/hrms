import { useEffect, useState } from "react";

/** The value, but only after it has stopped changing for `ms`. Used to keep a search box responsive while
 *  making one request per pause in typing rather than one per keystroke. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
