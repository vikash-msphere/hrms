import { useEffect, useState } from "react";
import { get } from "@/api";
import type { Presence } from "@/types";

/**
 * Whether this person is reachable right now - the profile header's status pill and its on-leave note.
 *
 * A SEPARATE, lazy read rather than a field on the employee record: the server derives it from approved leave
 * plus open attendance sessions (services/presence.ts), which is three indexed reads that the directory, the
 * org chart and every employee picker would otherwise pay per row to render a dot.
 *
 * Failure is silent and renders nothing. This decorates a profile; it is never the reason the page exists, and
 * a header that shouts "couldn't load presence" over a record that loaded perfectly well is worse than a
 * header with no pill on it.
 */
export function usePresence(id: string | null): Presence | null {
  const [presence, setPresence] = useState<Presence | null>(null);
  useEffect(() => {
    setPresence(null);
    if (!id) return;
    let active = true;
    get<Presence>(`employees/${id}/presence`)
      .then((p) => active && setPresence(p))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [id]);
  return presence;
}
