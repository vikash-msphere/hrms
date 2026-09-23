// The `internal` e-sign driver: the legacy in-place image signing (owner uploads a signature image on their
// profile, then signs their own document via the `:sign` verb -> src/services/letterSign.ts). No vendor call,
// no webhook - createRequest just marks the document "sent" so the owner is prompted to sign in the app.
import type { EsignProvider } from "../../domain/esign";

export const internalProvider: EsignProvider = {
  id: "internal",
  label: "Internal (in-app image signing)",
  requiresAadhaar: false,
  supportsWebhook: false,
  configFields: [],
  async createRequest() {
    // Nothing to send: the owner signs in-app. The `:sign` verb (letterSign) embeds the image + locks the row.
    return { providerRef: "", signUrl: undefined, status: "sent" };
  },
  async parseWebhook() {
    return null; // in-app signing has no inbound webhook
  },
};
