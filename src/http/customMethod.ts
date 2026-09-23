import type { Context } from "hono";
import { invalidArgument } from "../lib/errors";

// AEP custom methods arrive on the wire as `/<collection>/<id>:<verb>`. This Hono
// version does not reliably bind a path param that is immediately followed by a
// literal `:verb` (it swallows the verb into the param and lets any verb match the
// first such route), so we register a single `POST /:id` per collection and parse the
// id + verb from the final path segment here, dispatching on the verb ourselves.
//
// A malformed percent-escape (`/x%E0%A4:approve`) makes `decodeURIComponent` throw a URIError, which reached
// the error handler as an unexpected exception - a 500 for what is the caller's bad path. It is a 400.
const decodeSegment = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw invalidArgument("the resource id in the path is not valid percent-encoding");
  }
};

export function customMethod(c: Context): { id: string; verb: string } {
  const seg = c.req.path.split("/").pop() ?? "";
  const i = seg.lastIndexOf(":");
  if (i === -1) return { id: decodeSegment(seg), verb: "" };
  return { id: decodeSegment(seg.slice(0, i)), verb: seg.slice(i + 1) };
}
