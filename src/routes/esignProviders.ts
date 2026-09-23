import { Hono } from "hono";
import type { AppEnv } from "../env";
import { providerMeta } from "../services/esign";

// Non-secret e-sign driver catalog for the Settings E-signature tab: the provider dropdown + each driver's
// config fields are rendered from this, so adding a vendor (a driver file) needs no UI change. Virtual
// capability collection (no table): the authz middleware gates GET as `esign-providers.read`. Never returns
// secrets - only field descriptors an operator fills in.
export const esignProviders = new Hono<AppEnv>().get("/", (c) => c.json({ providers: providerMeta() }));
