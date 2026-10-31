import { defineConfig } from 'vite';

// GOAL-004: relative base so the production build works both at a domain
// root and under a sub-path (e.g. GitHub Pages project sites:
// https://<user>.github.io/<repo>/), without any code changes.
//
// GOAL-020: `npm run dev` artik LAN'a da aciliyor (host: true). Vite baslarken
// "Network: http://192.168.x.x:5173/" satirini yazar; ayni Wi-Fi'daki telefondan
// o adres acilinca oyun dokunmatik kontrollerle test edilebilir. Windows ilk
// seferde guvenlik duvari izni sorabilir — "Ozel aglar"a izin vermek yeterli.
//
// GOAL-045: cok oyunculu artik Supabase Realtime uzerinden (src/net.ts) —
// yerel aktarim sunucusu (server/relay.mjs) artik hic calistirilmiyor, bu
// yuzden burada bir plugin/proxy gerekmiyor. Dosya hala repoda duruyor
// (referans/tasima dokumani olarak, bkz. COK-OYUNCULU.md).
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
