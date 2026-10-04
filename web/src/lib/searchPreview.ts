// What the search's preview pane shows of one record (CommandPalette.tsx, the pane beside the results on a wide
// drop-down): its status, who it belongs to, its key dates and the first lines of its text - read off the
// record as the API returns it, so one rule covers every collection the search finds instead of a layout per
// kind. Pure, so it can be tested without a browser.
import { formatDate } from "@/lib/utils";

export type PreviewFact = { label: string; value: string };
export type RecordPreview = { status: string | null; facts: PreviewFact[]; text: string | null };

// The dates worth a line, in the order a reader wants them, under the label that says what each one is.
const DATE_FIELDS: readonly [string, string][] = [
  ["start_date", "Starts"],
  ["end_date", "Ends"],
  ["due_date", "Due"],
  ["expense_date", "Spent on"],
  ["date", "Date"],
  ["create_time", "Created"],
];

// The free text a record carries, first one present wins.
const TEXT_FIELDS = ["description", "reason", "body", "summary", "notes", "comment", "content", "details"] as const;

// Enough to read what the record says, in the pane's width, without becoming the page.
const TEXT_MAX = 600;

const words = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * The preview of `row`. `nameOf` turns an employee ref into the person's name (the palette's cached
 * directory), or null when it is not someone the caller can see - then the line is left out rather than
 * showing a bare id.
 */
export function previewOf(row: Record<string, unknown>, nameOf: (ref: string) => string | null): RecordPreview {
  const status = typeof row.state === "string" ? row.state : typeof row.status === "string" ? row.status : null;
  const facts: PreviewFact[] = [];
  if (typeof row.employee === "string") {
    const who = nameOf(row.employee);
    if (who) facts.push({ label: "Person", value: who });
  }
  for (const [field, label] of DATE_FIELDS) {
    const v = row[field];
    if (typeof v === "string" && v) facts.push({ label, value: formatDate(v) });
  }
  const raw = TEXT_FIELDS.map((f) => row[f]).find((v): v is string => typeof v === "string" && v.trim() !== "");
  const text = raw ? (raw.trim().length > TEXT_MAX ? `${raw.trim().slice(0, TEXT_MAX).trimEnd()}…` : raw.trim()) : null;
  return { status: status ? words(status) : null, facts, text };
}
