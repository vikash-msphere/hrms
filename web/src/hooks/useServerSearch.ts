import { useState } from "react";
import { useCollection } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";

// A list page's search box, answered by the SERVER over the whole collection.
//
// A list page loads a hundred rows and filters what it holds, so a search typed into it looked through that
// window and nothing else: the record somebody wanted was simply absent, with nothing saying the list was
// partial. The list routes take `?q=` (services/searchFilter.ts, the same index ⌘K uses), so this sends the
// debounced text there and hands the page the rows to show - its own page while the box is empty, the search
// answer once it has two characters.
//
// The same shape Tickets.tsx wrote by hand, once, so the pages that adopt it cannot drift from each other.
// `opts` are the page's own list options (`showDeleted`, `params`), so the search asks the same question of
// the server that the page's list does, only narrowed.
export function useServerSearch<T>(
  collection: string,
  page: { rows: T[]; loadMore: () => void; hasMore?: boolean },
  placeholder: string,
  opts: { showDeleted?: boolean; params?: Record<string, string> } = {},
) {
  const [value, setValue] = useState("");
  const q = useDebounced(value.trim(), 250);
  const searching = q.length >= 2;
  const found = useCollection<T>(collection, { ...opts, q, enabled: searching });
  return {
    /** The rows to hand the table. */
    rows: searching ? found.rows : page.rows,
    /** The DataTable `search` prop. */
    search: { value, onChange: setValue, placeholder },
    /** The DataTable `hasMore` / `onLoadMore` props: the search answer pages on its own. */
    hasMore: searching ? found.hasMore : page.hasMore,
    onLoadMore: searching ? found.loadMore : page.loadMore,
    searching,
  };
}
