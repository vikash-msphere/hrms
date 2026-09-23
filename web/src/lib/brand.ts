// Product/app brand name. Build-time constant from VITE_APP_NAME (see web/.env).
// Distinct from the org's display name, which is runtime-configurable in Settings.
export const APP_NAME = import.meta.env.VITE_APP_NAME ?? "Meridian";
