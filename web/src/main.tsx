// FIRST, ahead of React and every app module: Sentry can only instrument what is loaded after it, so an error
// thrown while the rest of this file's imports evaluate is only captured if init has already run. See
// instrument.ts - it is inert unless the build carries a VITE_SENTRY_DSN.
import "./instrument";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The UI font (Inter), self-hosted via @fontsource - see the note in index.css for why these are the
// latin/latin-ext subset entrypoints and not the bare `<weight>.css`. They live here rather than as an
// `@import` in index.css because Vite inlines a CSS @import inside its own CSS pipeline, where the
// woff2-only plugin (web/vite.config.ts) cannot reach it; as JS module imports they pass through it and
// the dead woff fallbacks never get emitted. @font-face is order-independent, so this is purely a
// plumbing detail - the faces still land in the same built stylesheet.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-700.css";
import "@fontsource/inter/latin-800.css";
import "@fontsource/inter/latin-ext-800.css";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { registerAppRoot } from "@/lib/appLock";
// Dev-only, and off unless a URL asks for it (`?overflow=1`): names whichever box is painting past the
// viewport, which `html { overflow-x: clip }` otherwise hides by clipping it.
import { startOverflowProbe } from "@/lib/overflowProbe";
// Gives every clipped ("...") string its full text as a hover tooltip, measured from the live layout.
import { startClippedTitles } from "@/lib/clippedTitle";

startOverflowProbe();
// SHIPS, unlike its dev-only neighbour above, and that is a decision rather than an oversight - it was running
// in production either way, so what is written here is the reason.
//
// It is a real feature for real users: a truncated name, ticket title or file name with no way to read it is a
// dead end on every list in the app, and the measurement has to happen in the live layout (a class name cannot
// say whether a box is actually clipping) so there is no build-time version of it.
//
// The cost, stated so the next person can weigh it rather than rediscover it: a document-wide
// `MutationObserver` plus a `ResizeObserver` over every element matching `[class*="truncate"]` and friends and
// each of their direct children - hundreds of nodes on a full table. The module keeps that bounded: work is
// batched into one `requestAnimationFrame`, the layout read happens once per dirty element per frame, the
// expensive `getComputedStyle` is cached per element until its own class or style changes, and an attribute
// mutation re-measures that one element rather than re-walking the page. If that ever stops being enough, the
// cheap answer is to gate it the way `startOverflowProbe` gates itself.
startClippedTitles();

const root = createRoot(document.getElementById("root")!);
// Locking takes the whole app down before it reloads (lib/appLock.ts), so it needs the root.
registerAppRoot(root);
root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
