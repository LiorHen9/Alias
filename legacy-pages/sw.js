// Replaces the game's Service Worker at the old address (https://liorhen9.github.io/Alias/).
//
// Phones that installed the game there keep running its Service Worker, which serves the cached
// game offline. Browsers check this file for updates when the page is opened, so this version
// takes over: it deletes the game's caches, removes itself, and reloads open windows, which then
// get the notice page (index.html) straight from the network.
// Caches are shared by the whole domain (liorhen9.github.io), so it deletes only Alias's own
// ("alias-v…"), never 18Alias's ("alias18-v…") or the fonts cache both games use.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = (await caches.keys()).filter((n) => n.startsWith("alias-v"));
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.registration.unregister();
    // Reload only when the game was here (it had caches), otherwise reloading would only flash the page.
    if (names.length > 0) {
      const windows = await self.clients.matchAll({ type: "window" });
      for (const w of windows) {
        try { await w.navigate(w.url); } catch (e) { /* reloads by itself the next time it is opened */ }
      }
    }
  })());
});
