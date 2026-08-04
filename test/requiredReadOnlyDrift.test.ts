/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
// @ts-expect-error - untyped module, runtime-only (same pattern as openapiRoutesDrift.test.ts)
import { load } from "js-yaml";

// A resource schema is $ref'd by its own POST and PATCH bodies as well as its responses - AEP-133/134 require
// exactly that, so there is no separate request schema to put response-only constraints on. Prism (which every
// local request goes through via `npm run dev:proxy`) validates request bodies against `required`, and it
// applies the OpenAPI rule that a readOnly property is required in RESPONSES ONLY.
//
// So: listing a readOnly field in `required` is free, and listing a WRITABLE one silently breaks every partial
// write - a two-field merge-patch becomes a 422 for the fields it did not send. That failure only shows up
// when someone runs the app, not in tsc or the rest of the suite, which is why it is pinned here.
//
// Writable fields the server always emits belong in ALWAYS_PRESENT in src/http/wire.ts instead. That narrows
// the types identically, and the serializers' `Wire<>` annotations make tsc check the claim.
const rawSpec = import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const spec = load(Object.values(rawSpec)[0]!) as {
  components: { schemas: Record<string, { required?: string[]; properties?: Record<string, { readOnly?: boolean }> }> };
};

describe("spec `required` lists only ever name readOnly properties", () => {
  const offenders: string[] = [];
  const undeclared: string[] = [];
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    for (const key of schema.required ?? []) {
      const prop = schema.properties?.[key];
      if (!prop) undeclared.push(`${name}.${key}`);
      else if (prop.readOnly !== true) offenders.push(`${name}.${key}`);
    }
  }

  it("names no writable property (that would 422 every partial merge-patch)", () => {
    expect(offenders).toEqual([]);
  });

  it("names no property the schema does not declare", () => {
    expect(undeclared).toEqual([]);
  });

  it("actually inspected the schemas (guards against an empty parse passing vacuously)", () => {
    const withRequired = Object.values(spec.components.schemas).filter((s) => s.required?.length).length;
    expect(withRequired).toBeGreaterThan(50);
  });
});
