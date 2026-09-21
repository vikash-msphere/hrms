// What a grid's column HEADERS say.
//
// A custom grid draws the columns of several nodes of a join side by side, so a header is worth exactly as
// much as it answers "whose?". Three columns headed "Name" answer nothing; "Ticket -> Requester -> Department:
// Name" on all three answers it at a width no screen has, and buries the one word that differs at the end of
// the longest one. The rule here is the middle of those two:
//
//   a header is the SHORTEST form that is still unique among the headers beside it.
//
// So a grid with one "Name" keeps "Name". Add the requester's and both grow one hop - only as far as they must
// - and a fourth column from two hops away is left alone as long as nothing collides with it. The qualification
// is a property of the SET, not of the field: the same column is "Name" in one table and "Manager -> Department"
// in the next, because that is what the reader of each needs it to say.
//
// Pure, and deliberately its own module rather than part of services/tableCatalog: naming is decided once, so
// the runner, the catalogue and anything else that draws the same grid cannot disagree about what a column is
// called.

/** One column to be named. */
export type HeaderField = {
  /** The catalogue key. Two entries with the same key ARE the same column and never fight each other. */
  key: string;
  /** The field's own name at its node ("Name", "Personal email"). */
  label: string;
  /** The link names from the base down to this field's node ("Manager", "Department"). Empty at the base. */
  trail?: readonly string[];
  /** This field IS its node's name, so the trail alone can stand as the header ("Department"). */
  nodeName?: boolean;
  /** The author's own header. Never shortened and never grown - the rest are named AROUND it. */
  fixed?: string;
};

const SEP = " -> ";

/**
 * "Department" followed by "Department name" is the same word twice, and the hop said it first. Dropped only
 * when a name is left over: the whole label repeating the hop ("Department" under Department) is the node's
 * own name, which `nodeName` already renders as the trail alone.
 */
function withoutTheHop(hop: string | undefined, label: string): string {
  if (!hop || !label.toLowerCase().startsWith(`${hop.toLowerCase()} `)) return label;
  const rest = label.slice(hop.length + 1).trim();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : label;
}

/**
 * Every form this header could take, shortest first: the bare name, then one more hop of its trail each time,
 * ending at the fully qualified name. An author's own header has exactly one form, which is itself.
 */
export function headerForms(f: HeaderField): string[] {
  if (f.fixed) return [f.fixed];
  const trail = f.trail ?? [];
  const leaf = withoutTheHop(trail[trail.length - 1], f.label);
  // Below the base the bare name is not a form at all, collision or no collision: a column headed "Personal
  // email" on a grid of people is read as the person's, and it is their manager's. Shortening may drop what a
  // reader can infer from the columns beside it; it may never say something untrue about the row. So the
  // first hop is the floor, and only the hops ABOVE it are spent on telling columns apart.
  const forms = trail.length ? [] : [leaf];
  for (let depth = 1; depth <= trail.length; depth++) {
    const prefix = trail.slice(trail.length - depth).join(SEP);
    // A node's own name needs no ": Name" after it - a column headed "Department" holding "Engineering" is
    // what a reader would have written by hand.
    forms.push(f.nodeName ? prefix : `${prefix}: ${leaf}`);
  }
  // The collapse is a courtesy, so it is also the first thing given up: a grid that already has a column
  // called "Department" (an author's own header, most likely) takes the spelled-out name back.
  if (f.nodeName && trail.length) forms.push(`${trail.join(SEP)}: ${leaf}`);
  return forms;
}

/**
 * The most explicit form: the whole trail, and the field's own name at the end of it. What a tooltip says,
 * and what a picker chip carries - both stand outside the grid that made the short one readable.
 */
export const fullHeader = (f: HeaderField): string => {
  const forms = headerForms(f);
  return forms[forms.length - 1]!;
};

/**
 * Name every column of one grid, in the order given.
 *
 * Left to right, each column takes the shortest form nothing else has taken: the columns already named hold
 * their names, and the ones still to come hold their longest. That second half is what keeps the walk honest
 * in ONE pass - a column never takes a name that a later column will be forced into, so nothing has to be
 * taken back, and the answer does not depend on the order the collisions happen to be discovered in. Reading
 * order decides ties, which is the same order the reader's eye takes them in.
 */
export function headerLabels(fields: readonly HeaderField[]): string[] {
  const forms = fields.map(headerForms);
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const taken = new Set<string>();
    for (let j = 0; j < fields.length; j++) {
      // The same key twice is one column asked for twice, not two columns that need telling apart.
      if (j === i || fields[j]!.key === fields[i]!.key) continue;
      taken.add(j < i ? out[j]! : forms[j]![forms[j]!.length - 1]!);
    }
    // Nothing left that is free means there is no trail to spend: two fields of one node named the same by
    // an author. A repeated header is the author's to fix, and it beats a header that says something false.
    out.push(forms[i]!.find((form) => !taken.has(form)) ?? forms[i]![forms[i]!.length - 1]!);
  }
  return out;
}
