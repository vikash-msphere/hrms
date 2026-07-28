// The e-sign provider registry: the single lookup that makes signing vendor-agnostic. Add a driver here and it
// becomes selectable via the `esign` setting's `provider` field - no other code changes. See src/domain/esign.ts.
import type { EsignProvider, EsignProviderMeta } from "../../domain/esign";
import { internalProvider } from "./internal";
import { cashfreeProvider } from "./cashfree";

export const PROVIDERS: Record<string, EsignProvider> = {
  [internalProvider.id]: internalProvider,
  [cashfreeProvider.id]: cashfreeProvider,
};

export function getProvider(id: string): EsignProvider | undefined {
  return PROVIDERS[id];
}

// Registered driver ids (for settings validation). "none" is a valid config value but not a driver.
export function providerIds(): string[] {
  return Object.keys(PROVIDERS);
}

// Non-secret metadata for every registered driver: powers the generic provider dropdown + config form in the
// web (GET /v1/esign-providers). Adding a driver here surfaces it in the UI with no other change.
export function providerMeta(): EsignProviderMeta[] {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    requiresAadhaar: p.requiresAadhaar,
    supportsWebhook: p.supportsWebhook,
    configFields: p.configFields,
  }));
}
