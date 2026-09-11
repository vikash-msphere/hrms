import * as React from "react";
import { Save, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportUnsaved } from "@/router";

// Shared unsaved-changes machinery for draft-style settings forms (edit local state, persist on Save).
// A form tracks its dirtiness with useUnsaved/useUnsavedTracker, which feeds two consumers:
//   - the router's global registry (hash-navigation confirm + beforeunload), and
//   - the nearest <UnsavedScope>, which shows a sticky "Unsaved changes" banner with its own Save button,
//     so the save affordance is visible from the top of a long panel, not only at the bottom.

type Entry = { dirty: boolean; save: () => void | Promise<unknown> };
const ScopeCtx = React.createContext<{ report: (id: string, entry: Entry | null) => void } | null>(null);

// Register a form whose dirtiness the caller already computes (e.g. an explicit `dirty` flag).
// `save` is what the scope banner's Save button invokes for this form.
//
// `saving` - a write already on the wire - counts as NOT unsaved, and that is the point of it being here
// rather than in each form. A form clears its own `dirty` when the save RESOLVES, so between pressing Save
// and the response landing the guard still held the form as dirty: leaving in that window (clicking a nav
// item the moment you press Save, which is what people do) was answered with "You have unsaved changes.
// Leave without saving?" about changes that were at that moment being written. Worse, the navigation is
// cancelled if the reader says no - or, in a browser that auto-dismisses the confirm, cancelled silently.
// A failed save leaves `dirty` true and `saving` false, so the guard closes again on the way out.
export function useUnsavedTracker(dirty: boolean, save: () => void | Promise<unknown>, saving = false) {
  const id = React.useId();
  const scope = React.useContext(ScopeCtx);
  const saveRef = React.useRef(save);
  saveRef.current = save;
  const unsaved = dirty && !saving;
  React.useEffect(() => {
    reportUnsaved(id, unsaved);
    scope?.report(id, { dirty: unsaved, save: () => saveRef.current() });
    return () => {
      reportUnsaved(id, false);
      scope?.report(id, null);
    };
  }, [id, unsaved, scope]);
}

// Dirty tracking by snapshot: the baseline is captured from the first render where `ready` is true (i.e. the
// loaded server state), and the form is dirty whenever the current value serializes differently. On a
// successful save call markSaved() - it re-baselines from the next render's value, so saves that also
// normalize the draft (trim, sort, drop blanks) settle clean.
export function useUnsaved(value: unknown, ready: boolean, save: () => void | Promise<unknown>) {
  const snap = JSON.stringify(value) ?? "";
  const [baseline, setBaseline] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (ready && baseline === null) setBaseline(snap);
  }, [ready, baseline, snap]);
  const dirty = baseline !== null && snap !== baseline;
  useUnsavedTracker(dirty, save);
  const markSaved = React.useCallback(() => setBaseline(null), []);
  return { dirty, markSaved };
}

// Wraps a settings panel body. While any registered form inside is dirty, a sticky banner pins to the top of
// the scroll area: the unsaved hint plus a button that saves every dirty form. `bannerClassName` sets the
// sticky offset for the surface (top-0 in the settings Sheet; below the sticky TopBar on the full page).
//
// The banner's button says "Save all", not "Save", and the difference is not cosmetic. It sits ON TOP of a
// panel whose own form already has a Save, so two buttons were on screen at once carrying the same name for
// two different acts - this one commits EVERY dirty form in the panel, that one commits its own. "Click Save"
// then has two answers, whether the reader is using a screen reader, voice control, or a keyboard and a list
// of controls; the panels' own specs had already started reaching past it with `.first()`.
export function UnsavedScope({ children, bannerClassName = "top-0" }: { children: React.ReactNode; bannerClassName?: string }) {
  const [entries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(new Map());
  const report = React.useCallback((id: string, entry: Entry | null) => {
    setEntries((prev) => {
      const next = new Map(prev);
      if (entry) next.set(id, entry);
      else next.delete(id);
      return next;
    });
  }, []);
  const ctx = React.useMemo(() => ({ report }), [report]);
  const dirty = [...entries.values()].filter((e) => e.dirty);
  const [saving, setSaving] = React.useState(false);
  async function saveAll() {
    setSaving(true);
    try {
      await Promise.all(dirty.map((e) => e.save()));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ScopeCtx.Provider value={ctx}>
      {dirty.length > 0 && (
        <div className={`sticky z-20 mb-4 flex items-center gap-3 rounded-lg border border-warning/50 bg-background px-3 py-2 shadow-md ${bannerClassName}`}>
          <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
          <p className="flex-1 text-sm">You have unsaved changes - they're lost if you leave this page without saving.</p>
          <Button size="sm" onClick={saveAll} loading={saving}>
            {!saving && <Save className="h-4 w-4" />} Save all
          </Button>
        </div>
      )}
      {children}
    </ScopeCtx.Provider>
  );
}
