import type { Context } from "hono";

// AEP custom methods arrive on the wire as `/<collection>/<id>:<verb>`. This Hono
// version does not reliably bind a path param that is immediately followed by a
// literal `:verb` (it swallows the verb into the param and lets any verb match the
// first such route), so we register a single `POST /:id` per collection and parse the
// id + verb from the final path segment here, dispatching on the verb ourselves.
export function customMethod(c: Context): { id: string; verb: string } {
  const seg = c.req.path.split("/").pop() ?? "";
  const i = seg.lastIndexOf(":");
  if (i === -1) return { id: decodeURIComponent(seg), verb: "" };
  return { id: decodeURIComponent(seg.slice(0, i)), verb: seg.slice(i + 1) };
}
