> **GOAL-045 notu (tarihsel):** Bu doküman, `server/relay.mjs` ile çalışan eski
> WebSocket aktarım sunucusunu anlatıyor. Statik barındırmada (GitHub Pages,
> Cloudflare Pages) hiç çalışmadığı için — asıl "çok oyunculu çalışmıyor"
> sorununun kök nedeni buydu — oyun artık `src/net.ts` içinde Supabase
> Realtime (Presence + Broadcast) kullanıyor, ayrı bir sunucu süreci yok.
> `net.ts`'nin dışa açtığı arayüz ve ileti biçimleri aynı kaldığı için
> aşağıdaki protokol/akış açıklamaları (oda, ev sahibi, tur, `st`/`fin`
> iletileri) hâlâ doğru — sadece "Dağıtım" bölümündeki sunucu barındırma kısmı
> artık geçerli değil. `server/relay.mjs` referans/taşıma amacıyla repoda
> duruyor.

# Çok Oyunculu Yapı ve Mobil Notları

Siklamen Akış'ın çevrim içi modunda kullanılan yapının özeti. Başka bir tarayıcı oyununa taşımak için yazıldı:
neyin oyundan bağımsız olduğu, neyin oyuna göre değişeceği ve mobilde dikkat edilecekler.

Dosyalar: `server/relay.mjs` (eski sunucu, artık kullanılmıyor), `src/net.ts` (Supabase Realtime bağlantısı),
`src/gameplay/GameplayCore.ts` içindeki "10d. ÇOK OYUNCULU" bölümü (oyun tarafı).

---

## 1. Genel fikir

- **Aktarım sunucusu (relay), oyun sunucusu değil.** Sunucu oyun kuralı çalıştırmaz. Odayı, ev sahibini, turun
  başlayıp bitmesini bilir; oyuncuların gönderdiği durumu odadaki diğerlerine iletir.
- **Her cihaz kendi oyununu oynatır.** Herkes aynı bölümü **aynı tohumla** (`seed`) aynı anda başlatır. Böylece
  rastgele dağılan nesneler herkeste aynı başlar, ama her oyuncu kendi tahtasında bağımsız oynar.
- Ağdan gelen tek şey **diğer oyuncuların anlık görüntüsü** (yılanın hücreleri, tahtadaki nesneler, skor). Bunlar
  yalnızca çizilir; senin oyununu etkilemez. Bu yüzden gecikme oynanışı bozmaz, en kötü ihtimalle rakibin
  tahtası biraz geriden gelir.
- **Hiçbir şey saklanmaz:** oda bellekte durur, son oyuncu çıkınca silinir. Hesap, çerez, günlük yok.
- Oda **4 karakterlik kodla** kurulur (karışan harfler yok: I/1, O/0). En fazla 3 oyuncu.

Bu model "yan yana yarış" türü oyunlar için uygun (kim önce bitirir, kim çok puan toplar). Oyuncuların **aynı
dünyada birbirine dokunduğu** oyunlar (çarpışma, birbirini vurma) için yetmez; orada sunucunun ya da ev sahibinin
otorite olması gerekir (bkz. bölüm 7).

```
 Telefon A ──┐                         ┌── Telefon B
  (kendi     │   ws  { t:'st', ... }   │   (kendi
   oyunu)    ├──────►  RELAY  ◄────────┤    oyunu)
             │   oda: ABCD, ev sahibi  │
 Telefon C ──┘   tur: 'lobby'|'round'  └── her biri diğerlerini izler
```

---

## 2. İleti protokolü (JSON, WebSocket)

Her ileti `{ t: '<tür>', ... }`. Sunucu tanımadığı türü yok sayar.

### İstemci → sunucu

| `t`      | Alanlar                         | Ne yapar |
|----------|---------------------------------|----------|
| `create` | `name`                          | Yeni oda kurar, kuran ev sahibi olur. |
| `join`   | `code`, `name`                  | Odaya katılır. Oda yoksa / doluysa / tur sürüyorsa `error`. |
| `leave`  | —                               | Odadan çıkar. |
| `start`  | `level`                         | Yalnızca ev sahibi, en az 2 oyuncuyla. Turu başlatır. |
| `st`     | oyuna özgü (aşağıda)            | Anlık durum. Yalnızca tur sürerken, gönderen hariç herkese gider. |
| `fin`    | `ok`, `time`, `eaten`, `score`  | Oyuncu turu bitirdi (`ok: true` kazandı/çıktı, `false` elendi). Herkese gider. |
| `away`   | `on`                            | Sekme arka plana alındı / geri gelindi. |

### Sunucu → istemci

| `t`       | Alanlar                                         | Ne zaman |
|-----------|-------------------------------------------------|----------|
| `room`    | `code`, `you`, `host`, `players[]`, `round`     | Odaya girince (yalnızca sana). |
| `players` | `host`, `players[]`, `left?`                    | Biri girince/çıkınca; ev sahibi değişince. |
| `start`   | `round`, `level`, `seed`, `in`                  | Tur başlıyor. `in` ms sonra herkes aynı anda oynamaya geçer. |
| `st`      | gönderilen alanlar + `from`                     | Diğer oyuncunun anlık durumu. |
| `fin`     | `from`, `ok`, `time`, `eaten`, `score`          | Biri turu bitirdi. |
| `away`    | `from`, `on`                                    | Biri ara verdi / döndü. |
| `error`   | `msg`                                           | Kullanıcıya gösterilecek hata (Türkçe). |
| `closed`  | —                                               | **Sunucudan gelmez**, `net.js` bağlantı kopunca kendisi üretir. |

`players[]` öğesi: `{ id, name, color, away }`. `color` 0/1/2: odadaki boş ilk renk; oyuncu çıkınca renk serbest kalır.

Siklamen Akış'taki `st` gövdesi (başka oyunda tamamen değişir):

```js
{ t: 'st',
  c:  [x0, y0, x1, y1, ...],     // yılanın hücreleri, düz dizi (dizi içinde dizi yerine: daha kısa JSON)
  it: [['m', x, y], ...],        // tahtadaki nesneler: tür kısaltması + konum
  v:  [x0, y0, ...],             // virüsler
  e: eaten, T: target, s: score, // ilerleme
  d: stepMs,                     // bir adımın süresi: karşı taraf ara kareleri buna göre yumuşatır
  x: exitOpen ? 1 : 0 }
```

**Kural:** tek harfli alan adları, düz sayı dizileri, boolean yerine 0/1. 4 KB'tan büyük ileti gelirse sunucu o bağlantıyı kapatır (`maxPayload`).

---

## 3. Sunucu (`server/relay.mjs`)

Tek bağımlılık: `ws`. Üç şekilde çalışır:

| Komut | Ne olur |
|-------|---------|
| `npm run dev` / `npm run preview` | Vite eklentisi aktarım sunucusunu 8787'de başlatır; Vite `/mp` yolunu oraya yönlendirir. Ayrı terminal gerekmez. |
| `npm run mp` | Tek başına, `PORT` (varsayılan 8787). Yayında bu kullanılır. |
| Aynı makinede birden çok Vite | Port doluysa ikinci sunucu açılmaz, hepsi aynı aktarım sunucusunu (aynı odaları) görür. |

### Oyundan bağımsız parçalar (olduğu gibi taşınır)

- Oda kodu üretme (`newCode`), oda haritası (`rooms`), giriş/çıkış (`enter`/`leave`).
- Ev sahibi çıkarsa odadaki ilk oyuncu ev sahibi olur.
- Son oyuncu çıkınca oda silinir.
- Takma ad temizliği (`cleanName`): kontrol karakterleri ve `< >` atılır, boşluklar tekleşir, 14 karakter.
- **Hız sınırı:** saniyede 40 iletiden fazlası yok sayılır.
- **`maxPayload: 4096`:** büyük ileti bağlantıyı düşürür.
- **Nabız:** 20 sn'de bir `ping`; `pong` gelmeyen bağlantı kapatılır. Telefon Wi-Fi'den düşünce ya da uygulama
  öldürülünce `close` olayı hiç gelmeyebilir, bu olmadan "hayalet oyuncular" odada kalır.
- `phase: 'lobby' | 'round'`: tur sürerken katılma yok; `st`/`fin` yalnızca turda kabul edilir.
- Tur bitişi (`roundDone`): herkes `fin` göndermiş **ya da** `away` durumunda.

### Oyuna göre değişecek yerler

```js
const MAX_PLAYERS = 3;                                    // oyuncu sayısı (renk listesi [0,1,2] de buna göre)
case 'start': ... level: Math.max(0, Math.min(7, m.level | 0))   // bölüm sayısı
              ... in: 6000                                // başlamadan önceki bekleme (bilgi kartı + geri sayım)
case 'fin':   ... { ok, time, eaten, score }              // sonuç alanları
```

`st` içeriğine sunucu hiç bakmaz (`{ ...m, from }` diye iletir), bu yüzden oyunun durum biçimi değişince sunucuyu
değiştirmek gerekmez.

### Vite'a bağlama

```js
// vite.config.js
import { relayPlugin } from './server/relay.mjs';
export default defineConfig({
  base: './',
  plugins: [qrcode(), relayPlugin()],
  server:  { host: true, port: 5173 },   // LAN'a aç: telefondan erişim
  preview: { host: true, port: 4173 },
});
```

Eklenti `globalThis.__mpRelay` ile bir kez başlar (Vite yapılandırmayı yeniden yükleyince ikinci kopya açılmaz).
Yönlendirme hata verirse (sunucuyu tutan süreç kapandıysa) eklenti sunucuyu yeniden başlatır; oyuncu yeniden
denediğinde bağlanır.

Neden `/mp` yolu, ayrı port değil: telefon sayfayı `http://192.168.1.x:5173` adresinden açar; WebSocket aynı
adres ve porttan gidince ek güvenlik duvarı izni, CORS ya da "karışık içerik" sorunu çıkmaz.

---

## 4. İstemci bağlantısı (`src/net.js`)

Oyundan bağımsız, olduğu gibi taşınır. 28 satır.

```js
const URL_ = import.meta.env.VITE_MP_URL || (location.host
  ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mp`
  : 'ws://localhost:8787');            // file:// ile açıldıysa
```

- **Tembel bağlantı:** `net.send()` ilk çağrıldığında bağlanır, bağlanana kadar iletileri sıraya koyar. Oyuncu
  "Oda kur"a basmadan sunucuya hiç bağlanılmaz.
- `net.on(fn)`: tek dinleyici; gelen her ileti `fn(m)`.
- Bağlantı koparsa `{ t: 'closed' }` üretir; kurulamazsa `{ t: 'error' }`.
- `net.open`: bağlı mı.
- `net.close()`: bilerek kapatma (odadan çıkarken). `onclose` içindeki `ws !== me` kontrolü, bilerek kapatılan
  eski bağlantının "koptu" iletisi üretmesini engeller.

**Yeniden bağlanma yok.** Bağlantı koparsa oyuncu menüye döner, odaya yeniden katılır. Mobilde sık rastlanır
(bkz. bölüm 6); yeni oyunda istenirse bölüm 7'deki gibi eklenebilir.

---

## 5. Oyun tarafı (`src/main.js`, "ÇOK OYUNCULU" bölümü)

### Durum

```js
const mp = { code, you, host, players, round, level,
  totals: {},   // oyuncu → toplam puan (turlar boyunca)
  fins: {},     // oyuncu → bu turdaki fin iletisi
  ranks: {},    // oyuncu → varış sırası (fin geliş sırasına göre)
  away: {},     // oyuncu → arka planda mı
  over,         // tur sonucu bir kez hesaplandı mı
  views, boxes, // rakip tahtalarının PIXI ve DOM nesneleri
  sentAt, timers };
```

### Akış

1. **Lobi:** `create` / `join` → `room` gelir → oyuncu listesi çizilir. Ev sahibine "Başlat" düğmesi görünür
   (en az 2 oyuncu).
2. **Başlangıç (`start`):** herkes `rnd = seeded(m.seed)` ile aynı rastgele diziye geçer, bölümü kurar, bilgi
   kartını gösterir ve **`m.in` ms sonra** oynamaya başlar. Geri sayım `setTimeout` ile; zamanlayıcılar
   `mp.timers`'ta tutulur ki tur iptal olunca temizlensin (`mpClear`).
   - Herkes iletiyi aynı anda almaz (birkaç on ms fark). Yan yana yarışta önemsiz; milisaniye adaleti
     gerekiyorsa sunucu mutlak başlangıç zamanı göndermeli ve istemciler saat farkını ölçmeli.
3. **Oyun:** her oyun adımında `mpSend()`; **en sık 60 ms'de bir** (≈16/sn, sunucunun 40/sn sınırının altında).
   Önemli anlarda `mpSend(true)` sınırı atlar (tur başı, bitiş).
4. **Rakipleri çizme (`mpState` + `mpRender`):** gelen durumda önceki hücreler `prev`, yenileri `cells` olur;
   çizimde ikisi arasında `d` (adım süresi) boyunca doğrusal geçiş yapılır. İki hücre arası 1,5'ten fazla
   atlıyorsa (ışınlanma, yeni tur) geçiş yapılmaz. Durum değişmediyse yeniden çizilmez (`v.drawn`).
   Nesneler için sprite havuzu (`v.pool`): her iletide yeni sprite yaratılmaz.
5. **Bitiş:** oyuncu çıkınca/elenince `fin`. Her istemci `mpRoundOver()` ile kendisi sonucu hesaplar:
   herkesin `fin`'i ya da `away`'i geldiyse sıralar (önce bitirenler varış sırasıyla, sonra bitiremeyenler
   topladıkları ile), puan verir (3/2/1, bitiremeyen 0). `mp.over` bir kez hesaplanmasını garanti eder (geç gelen
   ileti ya da oyuncu çıkışı puanı iki kez eklemesin).
6. **Sonraki tur:** ev sahibi `start` gönderir (`level + 1`). Toplam puanlar istemcide tutulur.

Sonuç her istemcide ayrı hesaplanır ama girdiler (fin iletileri) aynı olduğu için herkes aynı sonucu görür.
Varış sırası iletilerin sunucudan geçiş sırasıdır; sunucu tek iş parçacıklı olduğu için herkese aynı sırayla gider.

### Arka plana alma (`away`)

```js
document.addEventListener('visibilitychange', () => {
  if (mp.code && net.open) {
    mp.away[mp.you] = document.hidden;
    net.send({ t: 'away', on: document.hidden });
    if (mode === 'versus') mpRoundOver();
  }
});
```

Tarayıcı arka plandaki sekmede çizimi durdurur, oyun donar. Diğerleri "X oyuna ara verdi" görür ve oynamaya devam
eder; ara veren herkes bitirdiyse tur onu beklemeden biter. Bu olmadan telefonu kilitleyen bir oyuncu turu sonsuza
kadar asılı bırakır.

### Ekran bölme (`mpRects`)

Her oyuncunun tahtası bir "kart". Kendi kartın büyük, rakiplerinkiler canlı küçük önizleme.

| Ekran | Yerleşim |
|-------|----------|
| Bilgisayar / tablet (kısa kenar ≥ 520 px) | Eşit kartlar yan yana, ortalı, ekranın en çok %86 × %90'ı. |
| Yatay telefon | Kendi kartın yüksekliği doldurur, rakipler yanında. |
| Dikey telefon | Kendi kartın altta büyük, rakipler üstte yan yana. |

Rakip tahtasının hücresi en az 3 px kalır (`MIN_CELL`). Kart başlığındaki ad/skor/ilerleme çubuğu DOM'da (`.col`,
`.opp`), tahta PIXI'de; ikisi aynı dikdörtgene (`place`) oturtulur. Dar kartlarda yazı küçülür: CSS
`@container` sorguları (300 / 171 / 120 px eşikleri `mpRects` içindeki `hd` ile aynı).

### Gizlilik

- Gönderilen yalnızca takma ad ve oyun anı. Takma ad hem sunucuda hem istemcide temizlenir; ekrana basılırken
  `esc()` ile HTML kaçışı yapılır (sunucuya güvenme: başka bir istemci her şeyi gönderebilir).
- Takma ad `localStorage`'da hatırlanır (`prog.mpName`), sunucuda değil.

---

## 6. Mobil

### Telefondan test

- `server.host: true` → Vite LAN adresini de açar. `vite-plugin-qrcode` terminale QR basar: telefonun kamerasıyla
  okut, aynı Wi-Fi'de açılır. Çok oyunculu da aynı adresten (`/mp`) çalışır; 2-3 telefonla ya da telefon +
  bilgisayar sekmesiyle denenir.
- Windows güvenlik duvarı ilk seferde Node için izin ister: **özel ağlara** izin ver, yoksa telefon bağlanamaz.
- **Mobilde konsol:** adrese `?eruda` ekle (yalnızca geliştirme modunda yüklenir):
  ```js
  if (import.meta.env.DEV && /eruda/.test(location.search + location.hash)) import('eruda').then(m => m.default.init());
  ```
- **Ekran boyutu testi** (`tools/ekran-testi.mjs`, Playwright): her ekranı 320×568'den 1920×1080'e 13 boyutta
  açar; her düğmenin ekranda mı, başka öğenin altında mı, yazısı kesik mi olduğunu ölçer ve yan yana kontrol
  görüntüsü üretir. Çok oyunculu düzen değişince mutlaka dikey ve yatay telefon boyutlarına bak.

### Sayfa iskeleti

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#EAF7F4">
```

```css
html,body{overflow:hidden;overscroll-behavior:none;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
#app{position:fixed;top:0;left:0;right:0;height:100%;height:100dvh;   /* dvh: adres çubuğu açılıp kapanınca boy doğru kalır */
  padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)}  /* çentik */
#stage{touch-action:none}   /* kaydırma hareketi sayfayı kaydırmasın / yakınlaştırmasın */
```

- `viewport-fit=cover` olmadan `env(safe-area-inset-*)` sıfır döner.
- `height:100%` önce, `100dvh` sonra: eski tarayıcı ikinciyi anlamazsa birinciyi kullanır.
- Seçilebilir olması gereken yerlerde (`input`, oda kodu) `user-select:text` geri açılır; oda kodunu kopyalamak
  için gerekli.

### Giriş

- **Kaydırma (swipe)** `pointer` olaylarıyla: 20 px eşik, her eşik aşımında yön verip başlangıcı sıfırla
  (parmağı kaldırmadan art arda dönüş yapılabilsin). `pointercancel` / `pointerleave`'i de dinle.
- Dokunmatik mi: `matchMedia('(pointer: coarse)').matches` → ipucu yazısını değiştir ("kaydır" / "ok tuşları").
- Oda kodu kutusu: `autocapitalize="characters"`, `maxlength="4"`, `autocomplete="off"`, `spellcheck="false"`;
  `input` olayında büyük harfe çevir ve harf/rakam dışını sil. Ad kutusu: `autocapitalize="words"`,
  `enterkeyhint="done"`.
- iOS, yazı boyutu 16 px'ten küçük `input`'a odaklanınca sayfayı yakınlaştırır: kutular 20 px.

### Telefonda ses, titreşim, odak

- **Ses** ancak bir dokunuştan sonra açılır: ilk `pointerdown`/`keydown`'da `AudioContext` başlat (capture
  aşamasında, her yerde).
- **Titreşim:** `navigator.vibrate` iOS Safari'de yok. Desteklemeyen cihazda ayarı gizle, çağrıyı `try` içine al.
- **Arka plan:** `visibilitychange` (sekme / uygulama değişti) ve `blur`'da tek oyunculu oyun duraklar, ses kısılır.
  Çok oyunculuda duraklatma yok (tur herkes için aynı akar), onun yerine `away` iletisi (bölüm 5).

### Telefonda WebSocket

- **Ekran kilitlenince / uygulama değişince** mobil tarayıcı bağlantıyı askıya alır ya da bir süre sonra kapatır
  (iOS'ta özellikle hızlı). Bu yüzden: `away` iletisi, sunucuda nabız, istemcide `closed` ele alınır ve oyuncuya
  "Bağlantı koptu, yeniden katıl" denir.
- Wi-Fi ↔ mobil veri geçişi bağlantıyı koparır; `close` olayı gecikebilir. Nabız 20 sn: kopan oyuncu en geç
  ~40 sn içinde odadan düşer.
- Sayfa `https` ise WebSocket `wss` olmak zorunda (`net.js` bunu kendisi seçer). `http` sayfadan `wss`'ye
  bağlanılabilir, tersi olmaz.

### Telefonda çizim (PIXI)

- `resolution: Math.min(devicePixelRatio, 2)`: 3x ekranlarda 3 kat çizim yükü olmasın.
- Rakip tahtalarında **maske kullanılmıyor**: telefonda her maske ayrı bir çizim geçişi. Köşe yuvarlatma zemin
  dokusuna bir kez işlenir (`destination-in`).
- Değişmeyen şeyi yeniden çizme: rakibin durumu değişmediyse çizim atlanır; DOM başlığı da `innerHTML` aynıysa
  yazılmaz (`el._h`).
- Boy değişimini `ResizeObserver` ile `#stage` üstünden dinle (`resize` olayı adres çubuğu animasyonunu kaçırır).

---

## 7. Yayına alma

1. Oyunu derle: `npm run build` → `dist/` herhangi bir statik barındırmaya (Netlify, GitHub Pages, Vercel...).
2. Aktarım sunucusu WebSocket ister, **statik barındırmada çalışmaz**: Node çalıştıran bir yere koy (VPS,
   Render, Fly.io, Railway vb.) ve `npm run mp` (ya da `node server/relay.mjs`) ile başlat. Port `PORT` ortam
   değişkeninden alınır.
3. Oyunu derlerken adresi ver (derleme anında gömülür):
   ```
   VITE_MP_URL=wss://oyun.example.com/mp npm run build
   ```
   Oyun ve sunucu aynı alan adında, nginx arkasındaysa `VITE_MP_URL` gerekmez; `/mp` yolunu yönlendir:
   ```nginx
   location /mp {
     proxy_pass http://127.0.0.1:8787;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_read_timeout 120s;   # nabız aralığından (20 sn) uzun olmalı
   }
   ```
   (Tek başına çalışan sunucu her yolu kabul eder, `/mp` olduğu gibi geçer.)
4. Ücretsiz barındırmalarda sunucu boşta uyuyabilir; ilk bağlantı birkaç saniye sürer. "Bağlanıyor…" yazısı
   bunun için var.

### Bilinen sınırlar / yeni oyunda düşünülecekler

- **Hile koruması yok:** istemci `fin`'de istediği süreyi gönderebilir. Arkadaş arası oyun için kabul edilebilir;
  açık skor tablosu olacaksa sonucu sunucu doğrulamalı.
- **Yeniden bağlanma yok.** Eklemek için: sunucu oyuncuya `room` iletisinde bir gizli `token` verir, kopan
  oyuncunun kaydını 30 sn tutar; istemci `closed` gelince artan aralıklarla yeniden bağlanıp `{ t:'resume', code, token }`
  gönderir.
- **Tek süreç, bellekte oda:** sunucu yeniden başlarsa bütün odalar gider. Birden fazla sunucu kopyası
  çalıştırılacaksa odaların ortak bir yerde (Redis vb.) tutulması gerekir; küçük oyun için tek süreç yeter.
- **Etkileşimli çok oyunculu** (aynı dünya, çarpışma) için bu model yetmez: ev sahibi ya da sunucu dünyayı
  simüle etmeli, diğerleri yalnızca girdi göndermeli.

---

## 8. Yeni oyuna taşıma listesi

- [ ] `server/relay.mjs` ve `src/net.js`'yi kopyala; `npm i ws`.
- [ ] `vite.config.js`'ye `relayPlugin()` ve `host: true` ekle; `npm i -D vite-plugin-qrcode eruda`.
- [ ] Relay'de: `MAX_PLAYERS`, renk listesi, `start` içindeki bölüm sınırı ve bekleme süresi, `fin` alanları.
- [ ] Oyunun rastgeleliğini tohumlu yap (`seeded(seed)`); turu `start.seed` ile kur. `Math.random()` kullanan
      her oyun mantığı herkeste farklı sonuç verir (görsel süs için sorun değil).
- [ ] `st` biçimini belirle: kısa alan adları, düz diziler, 4 KB altı. 60 ms sınırıyla gönder.
- [ ] Rakip görünümü: önceki/sonraki durum arasında yumuşak geçiş, sprite havuzu, değişmediyse çizme.
- [ ] `fin` → herkes `mpRoundOver` ile sonucu kendisi hesaplasın; `over` bayrağıyla bir kez.
- [ ] `visibilitychange` → `away`.
- [ ] `closed` ve `error` iletilerini kullanıcıya göster.
- [ ] Ekranı oyuncu sayısı ve yöne göre böl; dikey telefonda kendi tahtan altta büyük.
- [ ] Telefondan QR ile, 2 cihazla dene; birini kilitle, Wi-Fi'yi kapat, ev sahibini çıkar.
- [ ] Ekran testini dikey/yatay telefon boyutlarında çalıştır.
- [ ] Yayında: statik oyun + Node'da relay, `VITE_MP_URL` ya da nginx `/mp` yönlendirmesi, `wss`.

---

## 9. Sinüs Harekâtı uyarlaması

Dosyalar: `server/relay.mjs`, `src/net.ts`, `src/gameplay/GameplayCore.ts` içindeki "10d. ÇOK OYUNCULU" bölümü,
`index.html` içindeki `#rivals` ve "ÇOK OYUNCULU" CSS bloğu.

- **Tur = bir gün.** Ev sahibi lobide başlangıç gününü seçer; sonra "Ertesi gün", 12. günden sonra "Yeni kür".
  Hedefe ilk ulaşan 3, ikinci 2, üçüncü 1 puan; canı ya da süresi biten 0. Bitiremeyenler temizledikleri alanla
  sıralanır. Tur süresi `MP_ROUND_SEC` (240 sn — ölçülmedi, ayarlanabilir).
- **Tohum:** yalnızca bölüm kurulurken (`startLevel`: virüs, mikrop, güçlendirici yerleri) `rand = seeded(seed)`;
  görsel rastgelelik `Math.random` kalır. Düşman hareketi kare süresine bağlı olduğu için zamanla ayrışır (beklenen).
- **`st` gövdesi:** `p` (alan ‰), `s` skor, `l` can, `x/y` oyuncu hücresi, `v` virüsler, `m` mikroplar, `c` kesim
  köşeleri (çizerken), `d` gönderim aralığı (100 ms), `g` temizlenen alan haritası (yalnızca alan kapanınca).
  `g`: 2x2 hücrelik bloklar, 80x80 bit, base64 (~1,1 KB). Hücre hücre değil, çünkü tahta ızgaraya düşerken
  cihazdan cihaza kenarda bir iki hücre oynayabiliyor.
- **Protokol eklemeleri:** `start` → `fresh` (toplamları sıfırla) ve `tot` (ev sahibinin toplamları: tur arasında
  katılan da aynı sıralamayı görsün); `fin` → `pct` (‰), `score`, `why` (`'time'` | `'out'`).
- **Rakip tahtaları yan yana** (`mpSplit`, `mpPlaceRivals`): rakibin tahtası seninkiyle aynı kesit ve kadraj,
  oyunun kendi katmanlarıyla çizilir (tur başında `dzCanvas`/`bgCanvas`/`wallCanvas` kadraja kırpılır, her rakip
  `g` haritasıyla maskelenir). Masaüstünde iki tahta eşit; dokunmatikte rakibinki seninkinin %60-75'i ve hafif
  sönük (göz kendi tahtanda kalsın). Üç kişide rakipler en az yarı boyda. Çözücü "yanda" ve "altta" dizilimleri
  (üç kişide rakipler kendi aralarında üst üste ya da yan yana) dener, kendi tahtanı büyük bırakanı seçer, yakınsa
  yan yanayı: uzun kesitli günlerde dikey telefonda da yan yana, geniş kesitlerde rakip alta geçer.
- **Skor listesi:** yarış skorları yüksek skor listesine yazılmaz (hile koruması yok; ödül listesi tek oyunculu kürün).
- **Yayın:** GitHub Pages statik. Aktarım sunucusu Node çalışan bir yerde (`npm run mp`), adresi depo değişkeni
  `VITE_MP_URL` (`wss://.../mp`) ile derlemeye verilir (`.github/workflows/deploy.yml`). Verilmezse GitHub Pages'te
  "Birlikte oyna" düğmesi gösterilmez.
