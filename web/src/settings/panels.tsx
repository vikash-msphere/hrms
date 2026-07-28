import * as React from "react";
import type { Me } from "@/types";
import type { useToast } from "@/components/ui/use-toast";
import { renderSettingsPanel } from "@/pages/Settings";

type Toast = ReturnType<typeof useToast>["toast"];

// The single lazily-loaded entry point for a settings panel body. Both the Settings page and the inline
// SettingsButton (feature-page gear) route through here, so the heavy panel code lands in one on-demand chunk
// and never bloats a feature page's bundle. `slot` is the header portal a few Access panels park controls in;
// `objectPath`/`onClose` are used by object-scoped panels (e.g. a board's config) to know which instance they
// edit and to dismiss the Sheet after a destructive action.
export function SettingsPanelContent({
  entryKey,
  me,
  toast,
  slot,
  openId,
  objectPath,
  onClose,
}: {
  entryKey: string;
  me: Me;
  toast: Toast;
  slot?: HTMLDivElement | null;
  openId?: string;
  objectPath?: string;
  onClose?: () => void;
}) {
  return <>{renderSettingsPanel(entryKey, me, toast, slot ?? null, openId, objectPath, onClose)}</>;
}
