/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Every row -> wire serializer must declare its return type as `Wire<"<schema>">`. That annotation is what
// makes tsc check the serializer against openapi.yaml in BOTH directions: emitting a field the contract does
// not declare fails to compile (excess property check), and dropping one the contract lists as `required`
// fails too. An unannotated serializer silently opts out of that, which is exactly how fields like
// `benefit-plan.auto_enroll` and `board.hide_empty_lanes` shipped server-side while the contract - and so
// every generated client - never knew about them.
//
// This gate only checks that the annotation is PRESENT. Whether it is correct is tsc's job, on every build.
const rawSer = import.meta.glob("../src/http/serialize.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const serialize = Object.values(rawSer)[0]!;

// Sub-object serializers that have no named schema of their own: their shape is declared inline inside the
// parent resource (an announcement's replies, a card's todos/comments, an activity entry), so there is no
// `components/schemas` entry to point a Wire<> at. The parent's annotation covers them.
const INLINE_SUB_RESOURCES = new Set(["AnnouncementReply", "CardTodo", "CardComment", "GoalComment", "Activity"]);

function serializers(src: string): { name: string; annotated: boolean }[] {
  const out: { name: string; annotated: boolean }[] = [];
  for (const m of src.matchAll(/^export function to(\w+)Resource\(/gm)) {
    // step over the parameter list, which may span lines and contain its own braces
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const head = src.slice(i, src.indexOf("{", i) + 1);
    out.push({ name: m[1]!, annotated: /:\s*Wire<"[^"]+">\s*\{$/.test(head) });
  }
  return out;
}

describe("every serializer is pinned to the OpenAPI contract", () => {
  const all = serializers(serialize);

  it("finds the serializers (guards against the parser silently matching nothing)", () => {
    expect(all.length).toBeGreaterThan(80);
  });

  it("annotates every resource serializer with its Wire<> return type", () => {
    const missing = all.filter((s) => !s.annotated && !INLINE_SUB_RESOURCES.has(s.name)).map((s) => `to${s.name}Resource`);
    expect(missing).toEqual([]);
  });

  it("keeps the inline sub-resource exemption list honest", () => {
    // If one of these gains a named schema it should be annotated like everything else, so fail once the
    // exemption stops being load-bearing rather than letting it rot.
    const stale = [...INLINE_SUB_RESOURCES].filter((name) => all.find((s) => s.name === name)?.annotated);
    expect(stale).toEqual([]);
    const gone = [...INLINE_SUB_RESOURCES].filter((name) => !all.some((s) => s.name === name));
    expect(gone).toEqual([]);
  });
});
