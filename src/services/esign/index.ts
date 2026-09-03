// The e-sign provider registry: the single lookup that makes signing vendor-agnostic. Add a driver here and it
// becomes selectable via the `esign` setting's `provider` field - no other code changes. See src/domain/esign.ts.
import type { EsignProvider, EsignProviderMeta, EsignSecrets } from "../../domain/esign";
import { failedPrecondition } from "../../lib/errors";
import { internalProvider } from "./internal";
import { cashfreeProvider } from "./cashfree";

export const PROVIDERS: Record<string, EsignProvider> = {
  [internalProvider.id]: internalProvider,
  [cashfreeProvider.id]: cashfreeProvider,
};

export function getProvider(id: string): EsignProvider | undefined {
  return PROVIDERS[id];
}

/**
 * Refuse a driver whose env secrets are not set, BEFORE anything is created.
 *
 * The app deliberately ships with no vendor credentials - in-app signature signing needs none - so an
 * unconfigured external provider is the normal state, not an edge case. Without this gate, picking "Aadhaar
 * e-Sign" on a template or document got as far as `createRequest`, which throws a bare `Error` deep inside
 * the vendor adapter: a 500 with no guidance, in `letterGenerate`'s case after the document row and its R2
 * object already exist (they are then unwound). A precondition here says which env secrets are missing.
 */
export function assertProviderConfigured(provider: EsignProvider, secrets: EsignSecrets | undefined): void {
  const missing = (provider.requiredSecrets ?? []).filter((k) => !secrets?.[k]);
  if (!missing.length) return;
  const ENV_NAME: Record<string, string> = {
    apiKey: `ESIGN_${provider.id.toUpperCase()}_CLIENT_ID`,
    apiSecret: `ESIGN_${provider.id.toUpperCase()}_CLIENT_SECRET`,
    webhookSecret: `ESIGN_${provider.id.toUpperCase()}_WEBHOOK_SECRET`,
    publicKey: `ESIGN_${provider.id.toUpperCase()}_PUBLIC_KEY`,
  };
  throw failedPrecondition(
    `e-sign provider "${provider.id}" is not configured on this deployment: set ${missing.map((k) => ENV_NAME[k] ?? k).join(" and ")}. Until then, use in-app signature signing.`,
  );
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
