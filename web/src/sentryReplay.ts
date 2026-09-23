// The session-replay recorder, kept OFF the critical path.
//
// rrweb's recorder is 39.9 kB gzipped - measured, by building once with `replayIntegration` stubbed out: the
// `sentry` chunk goes from 92.0 to 52.1 kB gz. That was 11% of everything the browser had to fetch before the
// app could render, for a feature that records nothing unless an error or a bug report asks for the buffer.
// So it is fetched separately, after first paint, and attached to the live client with `addIntegration`.
//
// This module exists to be the DYNAMIC IMPORT BOUNDARY, and it has to carry real code to do that. A version
// of it that only re-exported `replayIntegration` and `getReplay` from "@sentry/react" was a transparent
// facade: Rollup resolved straight through it to the underlying chunk and the entry ended up STATICALLY
// importing the recorder anyway - the split looked right in the chunk list and the `modulepreload` was still
// in index.html, which is the whole thing this avoids. Functions with bodies cannot be collapsed that way.
// Keep it that way: no bare `export { x } from "@sentry/react"` here.
//
// The other half of the split lives in web/vite.config.ts, which gives "@sentry/replay" a chunk of its own so
// it is not swept into the eager `sentry` chunk with the rest of the SDK.
//
// Nothing here may import from the app, for the same reason instrument.ts may not.
import { getClient, getReplay, replayIntegration } from "@sentry/react";

type ReplayOptions = Parameters<typeof replayIntegration>[0];

/** Attach the recorder to the running client. No-op when there is no client (a build with no DSN). */
export function installReplay(options: ReplayOptions): void {
  getClient()?.addIntegration(replayIntegration(options));
}

/** The running recorder, or undefined before it has been installed (or in a build with no DSN). */
export function activeReplay(): ReturnType<typeof getReplay> {
  return getReplay();
}
