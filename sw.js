// Service worker for the Discord-style chat app.
// Pages always try the network first; only known static assets use the cache.
const VERSION = "v14";
const CACHE = "app-" + VERSION;
const INDEX_URL = new URL("./index.html", self.registration.scope).href;
const STATIC_URLS = [
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
].map(path => new URL(path, self.registration.scope).href);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(STATIC_URLS.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("app-") && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Firebase and other origins are untouched.

  const isPage = request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html");

  if (isPage) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(INDEX_URL, response.clone()).catch(() => {});
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(INDEX_URL)) || (await caches.match(request));
      }
    })());
    return;
  }

  // Cache only the app's known static assets. Other same-origin requests
  // (including future JS/CSS/API endpoints) go directly to the network.
  if (!STATIC_URLS.includes(url.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request, { cache: "no-cache" })
      .then(async response => {
        if (response.ok) await cache.put(request, response.clone()).catch(() => {});
        return response;
      })
      .catch(() => cached);
    return cached || network;
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || self.registration.scope, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        if ("navigate" in client) await client.navigate(target).catch(() => {});
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text?.() || "Новое сообщение" };
  }

  const notification = data.notification || data;
  const title = notification.title || data.title || "Новое сообщение";
  const targetUrl = data.data?.url || data.url || self.registration.scope;
  const options = {
    body: notification.body || data.body || "У вас новое сообщение",
    icon: notification.icon || "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: targetUrl },
    tag: data.data?.tag || data.tag || "discord-message"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
