const CACHE_NAME = "img-love-v8-refresh";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg"
];

const RUNTIME_CACHE_ALLOWLIST = [
  "/vendor/tesseract/",
  "/api/"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;
  // Extensions may inject chrome-extension:// requests; Cache API can't store them.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Never cache dynamic APIs
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req));
    return;
  }

  // Always prefer network for app.js to avoid stale UI logic after deploys.
  if (url.origin === self.location.origin && url.pathname === "/app.js") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req, { cache: "no-store" });
          try {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, res.clone());
          } catch {
            // ignore
          }
          return res;
        } catch {
          const cached = await caches.match(req);
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Runtime cache for vendor assets (large files like OCR core/lang should not be precached on install)
  if (RUNTIME_CACHE_ALLOWLIST.some((p) => url.pathname.startsWith(p)) && url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        try {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
        } catch {
          // ignore
        }
        return res;
      })()
    );
    return;
  }

  // Always go network for CDNs; fallback to cache if available.
  if (url.hostname.includes("unpkg.com") || url.hostname.includes("cdn.jsdelivr.net")) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req, { cache: "no-store" });
          // Best-effort cache for offline revisit.
          try {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, res.clone());
          } catch {
            // ignore
          }
          return res;
        } catch {
          const cached = await caches.match(req);
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, res.clone());
        } catch {
          // ignore cache put failures (e.g. opaque/unsupported schemes)
        }
        return res;
      } catch {
        if (url.pathname === "/" || url.pathname.endsWith(".html")) {
          return (await caches.match("/index.html")) || Response.error();
        }
        return Response.error();
      }
    })()
  );
});
