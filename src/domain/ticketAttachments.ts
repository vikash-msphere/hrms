// Attachments on a support ticket: the parse/limit rules, with no I/O.
//
// A ticket's files live in a JSON column rather than a collection of their own (see schema.tickets), so this is
// where the shape is agreed: what a stored entry looks like, how many one ticket may carry, and how a name is
// made safe to hand back in a Content-Disposition header.

export type TicketAttachment = {
  /** R2 object key. Server-generated, never taken from the client. */
  key: string;
  name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  /** Employee id of whoever attached it, when the caller had one (automation has none). */
  by?: string;
};

// Enough for a bug report with a handful of screenshots and a log, not enough to make a ticket a file share.
export const MAX_TICKET_ATTACHMENTS = 10;

/** Parse the stored column leniently: a corrupt blob reads as "no attachments" rather than breaking the read. */
export function parseAttachments(raw: string | null | undefined): TicketAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is TicketAttachment => !!a && typeof (a as TicketAttachment).key === "string");
  } catch {
    return [];
  }
}

/** A display name that cannot break out of a header or a path. Extension preserved; empty falls back. */
export function safeAttachmentName(name?: string | null): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/["\\\r\n]/g, "").trim();
  return clean || "attachment";
}
