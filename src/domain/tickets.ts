// Help-desk categories: org config, not a collection. A category names a desk, and carries who answers for it
// (`assignee`), who else may see every ticket filed under it (`members` - the basis of category-based
// visibility), and which department services it by default (`department`, stamped onto new tickets and
// re-routable via :route). All three are refs the org fills in from Settings; the defaults below deliberately
// leave them unset, because a shipped default pointing at a person would be wrong at every install.
//
// `roles` are the roles that SERVICE the desk, where members only read it: whoever holds one, at decision time,
// may work every ticket filed under it (write and every verb). Unlike the three refs, a role name is the same at
// every install, so the IT desk ships serviced by `it_admin`. Members and roles both become per-ticket shares,
// written by services/ticketShares.ts.
//
// Pure data, and it lives in domain/ rather than beside the service for one reason: bootstrap seeds the
// `ticket-categories` settings row FROM this constant (bootstrap/collections/settings.ts), so a fresh database
// and the runtime fallback can never disagree about what the starter categories are.
export type TicketCategory = { key: string; name: string; assignee?: string | null; members?: string[]; department?: string | null; roles?: string[] };
export type TicketCategoriesConfig = { categories: TicketCategory[] };

// Starter categories so tickets work out of the box. Keys are stable lowercase ids: the UI dropdown stores
// them on the ticket row and automations match on them (the new-hire provisioning rule files under "it"), so
// renaming a key orphans existing tickets - change the `name`, never the `key`.
export const DEFAULT_TICKET_CATEGORIES: TicketCategoriesConfig = {
  categories: [
    // Problems with this application itself - a page that will not load, a number that looks wrong, a button
    // that does nothing. Separate from "IT & Systems" on purpose: that desk is laptops, accounts and printers,
    // and a bug report buried in that queue reaches whoever fixes hardware rather than whoever fixes software.
    // This is the category "Report a problem" files under, so it is the one desk that must always exist.
    { key: "app", name: "App issues" },
    { key: "it", name: "IT & Systems", roles: ["it_admin"] },
    { key: "facilities", name: "Facilities" },
    { key: "hr", name: "HR" },
    { key: "payroll", name: "Payroll" },
    { key: "general", name: "General" },
  ],
};

/**
 * The servicing roles a `ticket-categories` value names, by category key. Read off an UNTRUSTED value (a stored
 * blob or a PATCH body), so anything that is not a string list reads as no roles, and a repeat is dropped.
 */
export function rolesByCategory(value: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const cats = value && typeof value === "object" ? (value as { categories?: unknown }).categories : undefined;
  if (!Array.isArray(cats)) return out;
  for (const c of cats as { key?: unknown; roles?: unknown }[]) {
    if (!c || typeof c.key !== "string" || !c.key) continue;
    const roles = Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === "string" && !!r) : [];
    out.set(c.key, [...new Set(roles)]);
  }
  return out;
}

/** The desk a "Report a problem" submission files under, when the org still has it configured. */
export const APP_ISSUES_CATEGORY_KEY = "app";

/** One session recording attached to a ticket. `id` is a Sentry replay id; `by` is an employee ref. */
export type TicketRecording = { id: string; created_at: number; by?: string | null };

// A Sentry replay id is 32 lowercase hex. Checked rather than stored as given because this value is rendered
// as a link into a third-party console: anything else is either a client bug or an attempt to point a support
// agent somewhere of the requester's choosing.
export const REPLAY_ID_RE = /^[0-9a-f]{32}$/;

// A ticket holds a handful of recordings, not a reel. The cap is here for the same reason the attachment one
// is: without it a loop or an impatient reporter can grow a single row without bound.
export const MAX_TICKET_RECORDINGS = 10;

/**
 * How many checklist items one call may add, and how many a predefined checklist may hold.
 *
 * ONE number for three schemas - the ticket's `initial_todos`, the card's, and the `ticket-checklists` catalogue
 * they are both seeded from - because a catalogue entry longer than the add limit is a checklist that cannot be
 * applied, and the two drifting apart is how that happens. Not a judgement about how long a checklist may
 * usefully be: it is the shape of one request. The rows go in through `insertBatches`, so the parameter cap is
 * handled either way; this is what keeps a single call from deciding how much work the Worker does.
 */
export const MAX_CHECKLIST_ITEMS = 100;
/** Longest one checklist item may be. A checklist line is a label, not a description. */
export const MAX_CHECKLIST_ITEM_LEN = 500;

/** Parse the stored JSON, tolerating anything malformed - a bad blob must not take the ticket down with it. */
export function parseRecordings(json: string | null | undefined): TicketRecording[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === "string" && REPLAY_ID_RE.test(r.id)) : [];
  } catch {
    return [];
  }
}
