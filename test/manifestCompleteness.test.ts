/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
// js-yaml is pure ESM and loads in the worker test pool (unlike @stoplight/yaml, which is CJS). It ships
// no types here; the suppression self-cleans if @types/js-yaml is ever added.
// @ts-expect-error - untyped module, runtime-only
import { load } from "js-yaml";
import { PROTECTED_FIELDS } from "../src/domain/manifests";

// Deferred guard (plan §11R): no SENSITIVE resource may have an UNCLASSIFIED writable field, so adding a
// column later cannot silently open mass-assignment. For each resource with protected fields, every
// writable (non-readOnly) wire property in the OpenAPI contract must be either PROTECTED (needs elevated
// write authz) or on a reviewed SAFE list (intentionally self/base-writable). A new field forces a choice.
const raw = import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const spec = load(Object.values(raw)[0]!) as { components: { schemas: Record<string, { properties?: Record<string, { readOnly?: boolean }> }> } };
const schemas = spec.components.schemas;

// collection (manifest key) -> OpenAPI component schema key
const SCHEMA_KEY: Record<string, string> = { users: "user", employees: "employee", compensation: "compensation" };
// Reviewed, intentionally non-sensitive writable fields. A field is allowed to be base/self-writable only
// if it appears here; otherwise it must be in PROTECTED_FIELDS. (Empty for users: all writable user fields
// - role/status/employee - are protected.)
const SAFE_WRITABLE: Record<string, string[]> = {
  users: [],
  employees: ["first_name", "last_name", "legal_name", "work_email", "job_title", "start_date", "probation_end_date"],
  // The pay amounts (base_pay/currency_code/pay_grade) are PROTECTED; these are the revision context, set
  // only by payroll/super on create (the whole collection is payroll-gated, so no self mass-assignment).
  compensation: ["employee", "effective_from"],
};
const STANDARD = new Set(["path", "create_time", "update_time", "etag", "delete_time"]);

const writableFields = (key: string): string[] => {
  const props = schemas[key]?.properties ?? {};
  return Object.entries(props).filter(([n, p]) => !STANDARD.has(n) && !p.readOnly).map(([n]) => n);
};

describe("manifest completeness - sensitive resources have no unclassified writable field", () => {
  for (const collection of Object.keys(PROTECTED_FIELDS)) {
    it(collection, () => {
      const key = SCHEMA_KEY[collection];
      if (!key || !schemas[key]) {
        // No wire write surface (e.g. compensation): mass-assignment is impossible; protected_fields is
        // forward-looking. If a schema is added later this assertion fails -> wire it into this gate.
        expect(schemas[key!], `${collection} now has a wire schema - classify its fields in this gate`).toBeUndefined();
        return;
      }
      const writable = writableFields(key);
      const classified = new Set([...(PROTECTED_FIELDS[collection] ?? []), ...(SAFE_WRITABLE[collection] ?? [])]);
      const unclassified = writable.filter((f) => !classified.has(f));
      expect(unclassified, `unclassified writable field(s) on ${collection} - add to PROTECTED_FIELDS or SAFE_WRITABLE`).toEqual([]);
      // Reverse: every protected field must be a real writable wire field (catch a stale/renamed entry).
      const stale = (PROTECTED_FIELDS[collection] ?? []).filter((f) => !writable.includes(f));
      expect(stale, `protected field(s) on ${collection} not present as a writable wire field`).toEqual([]);
    });
  }
});
