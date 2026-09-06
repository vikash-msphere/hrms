import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { SPA_HEADERS } from "./fixtures";
import { DEFAULT_TICKET_CATEGORIES } from "../src/domain/tickets";

// Adding and removing a ticket category, for the ten workflow specs that need a category only their own
// ticket carries.
//
// It lives here rather than as a copy inside each of them because the operation is a READ-MODIFY-WRITE of one
// org-wide blob: `settings/ticket-categories` holds the whole list, so appending one category means sending
// all of them back. Ten specs doing that at once on a 24-worker run is not a corner case - each read the list
// before the others' writes landed, each wrote its own version back, and the last one to save deleted every
// category the other nine had just added. The specs failed far away from the cause, with the server correctly
// refusing "that ticket category is unavailable" for a category the spec was sure it had created.
//
// So the write is a compare-and-swap: `If-Match` carries the version the list was read at, the server refuses
// a save built on a stale one (409, src/services/settings.ts), and this re-reads and re-applies. That is what
// the header is for, and the same guard is what protects two admins editing Settings at the same time.

type Category = { key: string; name?: string };

async function readCategories(page: Page): Promise<{ categories: Category[]; etag?: string }> {
  const res = await page.request.get("/v1/settings/ticket-categories");
  // No row yet: the first writer creates it, and its PATCH carries no If-Match because there is no version to
  // match. The defaults are what the server itself falls back to, so starting from them keeps them.
  if (res.status() === 404) return { categories: DEFAULT_TICKET_CATEGORIES.categories };
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { value?: { categories?: Category[] }; etag?: string };
  return { categories: body.value?.categories ?? [], etag: body.etag };
}

/**
 * Apply `change` to the category list and save it, re-reading and re-applying for as long as somebody else
 * gets there first. `change` returns null to mean "nothing to do" (the sweep, when there is nothing to sweep).
 */
async function mutate(page: Page, change: (categories: Category[]) => Category[] | null): Promise<void> {
  const ATTEMPTS = 10;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { categories, etag } = await readCategories(page);
    const next = change(categories);
    if (!next) return;
    const res = await page.request.patch("/v1/settings/ticket-categories", {
      headers: { ...SPA_HEADERS, ...(etag ? { "If-Match": etag } : {}) },
      data: { value: { categories: next } },
    });
    if (res.ok()) return;
    // Anything but success is retried by re-reading: 409 is the conflict this is here for, and the row not
    // existing yet is a race two specs can both lose on their first attempt.
    if (attempt === ATTEMPTS - 1) expect(res.status(), await res.text()).toBe(200);
    await page.waitForTimeout(100 + attempt * 150);
  }
}

/** Add one category, leaving every other spec's alone. */
export async function addTicketCategory(page: Page, key: string, name: string): Promise<void> {
  await mutate(page, (categories) => (categories.some((c) => c.key === key) ? null : [...categories, { key, name }]));
}

/** Remove every category whose key starts with `prefix` - this spec's own, and nobody else's. */
export async function dropTicketCategories(page: Page, prefix: string): Promise<void> {
  await mutate(page, (categories) => {
    const kept = categories.filter((c) => !c.key.startsWith(prefix));
    return kept.length === categories.length ? null : kept;
  });
}
