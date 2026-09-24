// Web Push service worker: shows the pushed notification and focuses/opens the app on click. Kept to the two
// push events on purpose - no fetch handler, no caching - so it can never interfere with normal app traffic.
// That is also a SECURITY property now: the app's code is served only to a signed-in browser (the static-site
// gate, src/http/staticSite.ts), and a fetch handler that cached the shell or its chunks would hand them to
// whoever opens this browser next, signed in or not, without the request ever reaching the gate.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON payload: show a bare notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Notification", {
      body: data.body || undefined,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { link: data.link || "" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // In-app links arrive as app paths ("/approvals"); anchor anything relative to the app root, so it resolves
  // against the origin rather than against whatever page an already-open window happens to be showing.
  //
  // SAME ORIGIN OR HOME. `//evil.example/x` and `/\evil.example` both start with "/" and both resolve to another
  // host - a protocol-relative URL, and a backslash browsers read as a slash - so "starts with /" is not "is an
  // app path". The link is resolved against the origin and opened only if it is still on it.
  const link = event.notification.data && event.notification.data.link;
  const raw = link ? (link.startsWith("/") ? link : `/${link.replace(/^#\/?/, "")}`) : "/";
  let url = "/";
  try {
    const resolved = new URL(raw, self.location.origin);
    if (resolved.origin === self.location.origin) url = resolved.pathname + resolved.search + resolved.hash;
  } catch {
    /* unparseable: home */
  }
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.focus();
          if ("navigate" in w) w.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
