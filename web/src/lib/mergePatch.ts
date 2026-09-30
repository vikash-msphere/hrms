/**
 * The body of a merge patch: only the keys the reader CHANGED since the form was filled from `baseline`.
 *
 * A merge patch leaves every omitted key as it was, so sending the whole form is never needed to preserve a
 * sibling field - and sending it is a lost update waiting for a conflict. After a 409 the editor reloads the
 * record (a fresh etag) while the form keeps what was typed, so "save again" with the whole form writes the
 * values the form was opened with over everything anyone else changed meanwhile, under a version that no
 * longer refuses it. Diffed against the values the reader was SHOWN (not the reloaded record), the second
 * press re-sends their own edits and nothing else. `etag` and `path` are the record's identity, never fields.
 */
export function changedFields<T extends object>(form: T, baseline: T): Partial<T> {
  const before = baseline as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(form as Record<string, unknown>).filter(([k, v]) => k !== "etag" && k !== "path" && v !== before[k]),
  ) as Partial<T>;
}
