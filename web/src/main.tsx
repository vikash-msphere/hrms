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
// Dev-only, and off unless a URL asks for it (`?overflow=1`): names whichever box is painting past the
// viewport, which `html { overflow-x: clip }` otherwise hides by clipping it.
import { startOverflowProbe } from "@/lib/overflowProbe";

startOverflowProbe();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
