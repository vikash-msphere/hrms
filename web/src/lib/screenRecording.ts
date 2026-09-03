import { useSyncExternalStore } from "react";
import { finishManualRecording, startManualRecording } from "@/instrument";

// The screen-recording window, as app state rather than one dialog's state.
//
// It started inside ReportProblemDialog, which was fine while reporting a problem was the only thing that
// could record. Adding "record another one" to an existing ticket broke that: two unrelated places now start
// the same window, and the countdown has to appear in the top bar either way. So the window lives here, the
// chip renders from here, and the caller says only what the recording is FOR.
//
// `target` is that purpose, and it is persisted with the deadline because a reload must not orphan a running
// recording. The SDK's replay session is sticky, so a refresh mid-window leaves the recorder going; without
// the target surviving too, the recording would finish with nowhere to be delivered.
export type RecordingTarget =
  | { kind: "report" } // the Report a problem dialog is waiting for the id
  | { kind: "ticket"; path: string; subject?: string }; // attach it to this ticket when the window ends

export const RECORD_SECONDS = 120;
// The SDK discards a replay shorter than its own `minReplayDuration` (5s), so a window stopped immediately
// produces an id for a recording that was thrown away. A second of slack over the floor.
export const MIN_RECORDING_SECONDS = 6;

const KEY = "screen-recording";

type Session = { until: number; target: RecordingTarget };
let session: Session | null = null;
const listeners = new Set<() => void>();
const finished = new Set<(id: string | undefined, target: RecordingTarget) => void>();

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s?.until === "number" && s.target ? s : null;
  } catch {
    return null;
  }
}

function write(next: Session | null): void {
  session = next;
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: the window still works, it just will not survive a reload */
  }
  listeners.forEach((l) => l());
}

// Restored at module load, before anything renders, so a reload picks the window back up rather than leaving
// the recorder running with no countdown on screen and no way to stop it.
session = read();

/** Notified when a window ends, with the replay id (undefined if there was nothing to keep) and its purpose. */
export function onRecordingFinished(fn: (id: string | undefined, target: RecordingTarget) => void): () => void {
  finished.add(fn);
  return () => finished.delete(fn);
}

/** Begin a window. Replaces any running one - two recordings at once has no meaning. */
export function startRecording(target: RecordingTarget): void {
  write({ until: Date.now() + RECORD_SECONDS * 1000, target });
  startManualRecording();
}

/**
 * End the window and hand the id to whoever asked for it.
 *
 * A window shorter than the SDK's floor yields no usable recording, so it reports `undefined` rather than an
 * id for something Sentry discarded - a ticket linking to a 404 is worse than a ticket linking to nothing.
 */
export async function stopRecording(): Promise<void> {
  const current = session;
  if (!current) return;
  const lasted = RECORD_SECONDS - Math.max(0, Math.round((current.until - Date.now()) / 1000));
  write(null);
  const id = await finishManualRecording();
  const kept = lasted >= MIN_RECORDING_SECONDS ? id : undefined;
  finished.forEach((fn) => fn(kept, current.target));
}

const snapshot = () => session;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The running window, or null. Re-renders every subscriber when it starts, stops or is restored. */
export function useRecording(): Session | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
