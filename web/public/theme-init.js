// Apply the saved theme before first paint so there is no light/dark flash on load. Mirrors the storage key
// + resolution logic in src/lib/theme.ts. Kept as an external file (not inline) so the SPA can ship a strict
// Content-Security-Policy with `script-src 'self'` and no `'unsafe-inline'`.
(function () {
  try {
    var t = localStorage.getItem("theme") || "system";
    var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
