// Service worker: сначала сеть для страницы (чтобы обновления приходили сразу),
// кеш для иконок и манифеста. Запросы к Firebase и другим сайтам не перехватываются.
const VERSION = "v8";
const CACHE = "app-" + VERSION;
const STATIC = ["./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(STATIC.map(u => c.add(u).catch(() => {})))));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase, gstatic и т.д. идут напрямую

  // Страница: сначала сеть, при отсутствии связи — копия из кеша
  if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
    e.respondWith(
      fetch(req, { cache: "no-cache" }) // проверка у сервера: свежая версия сразу, без ожидания 10 минут HTTP-кеша
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)).catch(() => {}); return res; })
        .catch(() => caches.match("./index.html").then(r => r || caches.match(req)))
    );
    return;
  }

  // Иконки и манифест: из кеша, с фоновым обновлением
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req, { cache: "no-cache" }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); } return res; }).catch(() => hit);
      return hit || net;
    })
  );
});

// Показываем уведомление через Service Worker, чтобы оно не зависело от видимости вкладки.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ("focus" in client) { client.navigate?.(target); return client.focus(); }
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
  }));
});

// Firebase Cloud Messaging/любой Web Push sender может передавать JSON payload.
// Для доставки при полностью закрытом приложении всё равно нужен настроенный push sender.
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() || "Новое сообщение" }; }
  const notification = data.notification || data;
  const title = notification.title || data.title || "Новое сообщение";
  const options = {
    body: notification.body || data.body || "У вас новое сообщение",
    icon: notification.icon || "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: data.data?.url || data.url || self.registration.scope },
    tag: data.data?.tag || data.tag || "discord-message"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
