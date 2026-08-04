// Web Push service worker: shows the pushed notification and focuses/opens the app on click. Kept to the two
// push events on purpose - no fetch handler, no caching - so it can never interfere with normal app traffic.
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
  // In-app links arrive as hash routes ("#/approvals"); anchor them to the app origin.
  const link = event.notification.data && event.notification.data.link;
  const url = link && link.startsWith("#") ? `/${link}` : link || "/";
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
