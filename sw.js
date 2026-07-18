const CACHE_NAME = "jappo-cotiz-v13";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=12",
  "./app.js?v=13",
  "./supabase-client.js?v=10",
  "./manifest.webmanifest",
  "./assets/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response || response.status !== 200 || response.type === "opaque") return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)
        .then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "Une nouvelle activité concerne vos cotisations." };
  }
  const title = payload.title || "Jàppoo Cotiz";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "Une nouvelle activité a été enregistrée.",
    icon: "./assets/icon.svg",
    badge: "./assets/icon.svg",
    tag: payload.tag || `jappo-${Date.now()}`,
    data: { url: payload.url || "./?notification=activity" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      if ("navigate" in existing) await existing.navigate(targetUrl);
      return;
    }
    await self.clients.openWindow(targetUrl);
  }));
});
