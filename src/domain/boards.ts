// Kanban board configuration as pure data + helpers (no I/O). A board's columns, swimlanes and classes of
// service are stored as JSON on the `boards` row (like ats.stages / ticket-workflow are data-defined), so the
// method - not code - decides the workflow. The `move` service and the analytics roll-up read these helpers.

// One column on the board. The column IS the workflow state (no separate enum). `wipLimit` null = unlimited.
// `policy` is the explicit column policy (definition of done / entry criteria) shown on the header. Exactly one
// column should carry `commitment` (work is committed to on entry -> starts lead time) and one `delivery`
// (work is delivered on entry -> ends lead/cycle time); columns before the commitment point are the "options"
// backlog (uncommitted). `allowCreate` says whether a new task may be created straight into the column; off
// unless turned on, so work enters a board where the team decided it does and reaches the later columns by
// being moved there. A board needs at least one such column (`requireEntryColumn`), and the first one is where
// a task filed without naming a column lands (`entryColumn`).
// How a column's WIP limit is counted: board-wide (every card in the column, the canonical Kanban constraint)
// or per assignee (each person may hold at most `wipLimit` cards in the column). Default column-wide.
export type WipScope = "column" | "assignee";
export type BoardColumn = {
  key: string;
  label: string;
  wipLimit: number | null;
  limitScope?: WipScope;
  policy: string;
  commitment: boolean;
  delivery: boolean;
  allowCreate: boolean;
};

export type SwimlaneMode = "none" | "assignee" | "goal" | "priority" | "department" | "custom";
export const SWIMLANE_MODES: readonly SwimlaneMode[] = ["none", "assignee", "goal", "priority", "department", "custom"];

// A custom swimlane (used when swimlaneMode = "custom"); cards carry a `swimlaneKey` naming one.
export type Swimlane = { key: string; label: string };

// A label in the board's label catalog. Cards reference these by `key`. `color` is a UI hint.
export type Label = { key: string; label: string; color?: string };

export const CARD_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

// Sensible starter board: an options backlog, a committed "Ready" column, work + review WIP-limited columns,
// and a delivery "Done" column. New tasks are created in the backlog only. Teams reshape it via the `configure` verb.
export const DEFAULT_BOARD_COLUMNS: BoardColumn[] = [
  { key: "backlog", label: "Backlog", wipLimit: null, policy: "Anything proposed. Not yet committed.", commitment: false, delivery: false, allowCreate: true },
  { key: "ready", label: "Ready", wipLimit: 5, policy: "Refined, estimated, and ready to pull. Entering here commits the work.", commitment: true, delivery: false, allowCreate: false },
  { key: "in_progress", label: "In progress", wipLimit: 3, policy: "Actively being worked. One person, one card.", commitment: false, delivery: false, allowCreate: false },
  { key: "review", label: "Review", wipLimit: 3, policy: "Awaiting review / verification.", commitment: false, delivery: false, allowCreate: false },
  { key: "done", label: "Done", wipLimit: null, policy: "Accepted and delivered.", commitment: false, delivery: true, allowCreate: false },
];

// Scrum default columns: the IN-SPRINT workflow only (the product backlog is the separate "no sprint" set,
// so there is deliberately no "Backlog" column here). Entering "To do" commits the item to the sprint board
// (lead time starts); "Done" is the delivery point. New tasks are filed into "To do", the column a product-backlog
// item carries until it is planned into a sprint.
export const DEFAULT_SCRUM_COLUMNS: BoardColumn[] = [
  { key: "to_do", label: "To do", wipLimit: null, policy: "Pulled into the sprint, not yet started.", commitment: true, delivery: false, allowCreate: true },
  { key: "in_progress", label: "In progress", wipLimit: 3, policy: "Actively being worked. One person, one card.", commitment: false, delivery: false, allowCreate: false },
  { key: "review", label: "Review", wipLimit: 3, policy: "Awaiting review / verification.", commitment: false, delivery: false, allowCreate: false },
  { key: "done", label: "Done", wipLimit: null, policy: "Meets the definition of done.", commitment: false, delivery: true, allowCreate: false },
];

const KEY_RE = /^[a-z0-9][a-z0-9_]*$/;

// Validate + normalize a columns array from user input. Throws a plain Error with a message (the service maps
// it to invalidArgument). At most one commitment and one delivery column; keys unique and slug-shaped.
export function normalizeColumns(input: unknown): BoardColumn[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("a board needs at least one column");
  const seen = new Set<string>();
  let commit = 0;
  let deliver = 0;
  const cols = input.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const key = String(c.key ?? "").trim();
    if (!KEY_RE.test(key)) throw new Error(`column key "${key}" must be a lowercase slug`);
    if (seen.has(key)) throw new Error(`duplicate column key "${key}"`);
    seen.add(key);
    const label = String(c.label ?? "").trim() || key;
    const wl = c.wipLimit;
    const wipLimit = wl == null || wl === "" ? null : Math.max(0, Math.trunc(Number(wl)));
    if (wipLimit !== null && Number.isNaN(wipLimit)) throw new Error(`wip limit for "${key}" is invalid`);
    const commitment = !!c.commitment;
    const delivery = !!c.delivery;
    if (commitment) commit++;
    if (delivery) deliver++;
    const limitScope: WipScope = c.limitScope === "assignee" ? "assignee" : "column";
    return { key, label, wipLimit, limitScope, policy: String(c.policy ?? "").trim(), commitment, delivery, allowCreate: c.allowCreate === true };
  });
  if (commit > 1) throw new Error("only one column may be the commitment point");
  if (deliver > 1) throw new Error("only one column may be the delivery point");
  return cols;
}

export function normalizeSwimlanes(input: unknown): Swimlane[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const key = String(s.key ?? "").trim();
    if (!KEY_RE.test(key)) throw new Error(`swimlane key "${key}" must be a lowercase slug`);
    if (seen.has(key)) throw new Error(`duplicate swimlane key "${key}"`);
    seen.add(key);
    return { key, label: String(s.label ?? "").trim() || key };
  });
}

// The board's label catalog.
export function normalizeLabels(input: unknown): Label[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const key = String(s.key ?? "").trim();
    if (!KEY_RE.test(key)) throw new Error(`label key "${key}" must be a lowercase slug`);
    if (seen.has(key)) throw new Error(`duplicate label key "${key}"`);
    seen.add(key);
    const color = s.color ? String(s.color) : undefined;
    return { key, label: String(s.label ?? "").trim() || key, ...(color ? { color } : {}) };
  });
}

// A card's label keys: a deduped array of slug strings (references into a board's label catalog).
export function normalizeLabelKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const k = String(raw ?? "").trim();
    if (KEY_RE.test(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export function parseColumns(json: string | null | undefined): BoardColumn[] {
  if (!json) return [];
  try {
    return normalizeColumns(JSON.parse(json));
  } catch {
    return [];
  }
}

// Task-key prefix: uppercase alphanumerics only, 1-6 chars, starting with a letter (e.g. "ms-site" -> "MSSITE").
// Empty allowed. A task's key is `<prefix>-<seq>`, so a hyphen inside the prefix would be a second separator, and
// search reads a key as a letter-led prefix (CARD_KEY in services/globalSearch.ts), so a digit-led one is never found.
export function cleanPrefix(input: unknown): string {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

// Why a cleaned prefix can't be saved, or null when it can. The web form shows this before the server refuses.
export function prefixError(prefix: string): string | null {
  return /^[0-9]/.test(prefix) ? "must start with a letter" : null;
}

export function normalizePrefix(input: unknown): string {
  const prefix = cleanPrefix(input);
  const err = prefixError(prefix);
  if (err) throw new Error(`task key prefix ${err}`);
  return prefix;
}

// Default prefix from a board name: initials of the words, else the first letters, without any leading digits.
// "Marketing Site" -> "MS", "2026 Roadmap" -> "R".
export function derivePrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const base = initials.length >= 2 ? initials : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3);
  return cleanPrefix(base).replace(/^[0-9]+/, "") || "TASK";
}

export function columnIndex(cols: BoardColumn[], key: string): number {
  return cols.findIndex((c) => c.key === key);
}
// The column a task filed without naming one lands in: the first that takes new tasks.
export function entryColumn(cols: BoardColumn[]): BoardColumn | undefined {
  return cols.find((c) => c.allowCreate);
}
// A board whose columns all refuse new tasks could never be given one, so saving that is refused. Checked on
// create and configure, not in `normalizeColumns`: that also parses stored rows, and a stored board that fails
// it would read as having no columns at all.
export function requireEntryColumn(cols: BoardColumn[]): BoardColumn[] {
  if (!entryColumn(cols)) throw new Error("at least one column must allow new tasks to be created in it");
  return cols;
}
export function commitmentIndex(cols: BoardColumn[]): number {
  return cols.findIndex((c) => c.commitment);
}
export function deliveryKey(cols: BoardColumn[]): string | null {
  return cols.find((c) => c.delivery)?.key ?? null;
}
