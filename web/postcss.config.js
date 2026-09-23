import { fileURLToPath, URL } from "node:url";

// The Tailwind config path is resolved from THIS file, not from the current working directory. It read
// `"./web/tailwind.config.js"`, which is correct only when the build is started from the repo root - this
// file already lives in `web/`, so from anywhere else it pointed at `web/web/tailwind.config.js`. PostCSS
// does not report a missing Tailwind config: it hands Tailwind `undefined` and the build dies further in
// with `Cannot read properties of undefined (reading 'blocklist')`, which names neither the file nor the
// path. Absolute, so the config behaves identically wherever it is invoked from.
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) },
    autoprefixer: {},
  },
};
