import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Emit the PWA manifest at build/serve time so its name follows VITE_APP_NAME (public/ files are copied
// verbatim - a static manifest there could not carry the configured app name).
function pwaManifest(mode: string): Plugin {
  const env = loadEnv(mode, fileURLToPath(new URL("./", import.meta.url)), "VITE_");
  const name = env.VITE_APP_NAME || "Meridian";
  const manifest = JSON.stringify(
    {
      name,
      short_name: name,
      description: "HR self-service: leave, payslips, attendance, approvals and more.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#F7F9FB", // --neutral-50, the app's light page ground
      theme_color: "#1D4C91", // Brand Blue 700 (--primary)
      icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
    },
    null,
    2
  );
  return {
    name: "pwa-manifest",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest });
    },
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_req, res) => {
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(manifest);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: "./web",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [react(), pwaManifest(mode)],
  build: {
    outDir: "../web/dist",
    emptyOutDir: true,
    // Don't emit the inline module-preload polyfill: an inline <script> would force the SPA CSP to allow
    // 'unsafe-inline' scripts. Modern browsers support modulepreload natively, so the polyfill is unneeded.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Split the big, rarely-changing vendor libs out of the app entry so the index chunk shrinks and each
        // vendor is cached independently across app deploys. (xlsx / the native PDF path are already isolated
        // via dynamic import() at their call sites.)
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
          if (id.includes("@radix-ui")) return "radix";
          if (id.includes("lucide-react")) return "icons";
        },
      },
    },
  },
  server: {
    proxy: {
      // Binary custom methods go STRAIGHT to the worker: Prism re-encodes a binary body as text, so a PDF
      // arrives with U+FFFD replacement bytes where its binary header/streams were - a corrupt file that
      // downloads as unopenable and renders as a blank PDF viewer. Everything else goes through the Prism
      // contract-validation proxy. Any new verb that returns or accepts raw bytes must be listed here (the
      // route's `c.body(...)` with a non-JSON Content-Type is the tell).
      "^/v1/.*:(getPhoto|uploadPhoto|getSignature|uploadSignature|download|downloadIdentityDoc|uploadIdentityDoc|upload|uploadTemplate|previewLetter|preview|previewPayslip|bankFile|statutoryReport)": "http://localhost:8787",
      "/v1": "http://localhost:4010",
    },
  },
}));
