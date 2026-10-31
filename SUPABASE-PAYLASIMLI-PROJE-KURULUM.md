# Paylaşılan Supabase Projesi — Yüksek Skorlar + Çok Oyunculu Kurulumu

Bu dosya, sitedeki oyunların **hepsinin aynı Supabase projesini paylaştığı**
mimariyi başka bir oyunun sohbetine/kod tabanına aktarmak için yazıldı. Bu
dosyayı yeni bir sohbete yapıştırıp "bu oyun için de aynısını kur, oyun öneki
şu olsun" demen yeterli olmalı.

İkinci oyunda (nasodren-volfied) bu mimari uçtan uca kuruldu ve gerçek
Supabase projesine karşı test edildi: yüksek skor yaz/oku, çok oyunculu oda
kurma/katılma (iki ayrı tarayıcı ile). Burada anlatılan desen, oradaki
çalışan koddan çıkarıldı.

---

## 1. Neden paylaşılan tek proje?

Sitede birden fazla oyun var, hepsi aynı Supabase projesi altında
barınıyor (ayrı ayrı proje açmaya gerek yok — ücretsiz katman kotaları
gereksiz yere bölünmesin diye). Çakışmayı önlemek için **her oyun kendi
tablo/kanal adlarını benzersiz bir önekle izole eder**:

- Tablo adı: `<oyun>_scores` (örn. `volfied_scores`)
- Realtime kanal adı: `<oyun>:room:<KOD>` (örn. `volfied:room:78M5`)

Yeni bir oyun eklerken **sadece kendi önekini seç** (oyunun kısa/İngilizce
adı, alt çizgiyle — örn. üçüncü oyun "foo" ise `foo_scores` / `foo:room:`),
başka bir şeye dokunmana gerek yok; aynı projede duran diğer oyunların
tablolarını/kanallarını hiç etkilemez.

## 2. Proje kimlik bilgileri (aynı proje, tüm oyunlar için ortak)

```
VITE_SUPABASE_URL=https://ylmiykrovhufmamispdn.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable__QKZhBJ8ipGBIF4rbmwoXg_SFHwagav
```

Bu "publishable" (eski adıyla "anon public") anahtar — tarayıcıya
gömülmesi güvenli, gizli bir şey değil. Gerçek yetkilendirme Supabase'deki
Row Level Security (RLS) kurallarıyla sağlanıyor (bkz. adım 4).

Bu iki değeri:
- Yerelde `.env.local` dosyasına yaz (örnek aşağıda, adım 3).
- CI/deploy'da: GitHub Actions repo değişkeni veya Cloudflare Pages proje
  ortam değişkeni olarak ekle.

## 3. `src/supabase.ts` — tek paylaşılan istemci

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY_ = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const SUPABASE_OK = !!(URL_ && KEY_);

export const supabase: SupabaseClient | null = SUPABASE_OK
  ? createClient(URL_!, KEY_!, { realtime: { params: { eventsPerSecond: 20 } } })
  : null;
```

Değerler eksikse istemciyi oluşturma (`null` dön) — bunu kullanan her yer
(yüksek skorlar, çok oyunculu) bunu "özellik kapalı" olarak ele almalı,
sayfanın çökmesine izin vermemeli.

`npm install @supabase/supabase-js` ile kur.

`.env.local.example`:
```
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```
`.gitignore`'da `*.local` kuralı zaten `.env.local`'ı kapsar; gerçek
anahtarları commit etme.

## 4. `supabase/schema.sql` — bu oyuna özel skor tablosu

`<oyun>` yerine kendi önekini koy (örn. `volfied`, `foo`, ...). Bu dosyayı
Supabase panelinde **SQL Editor → New query**'ye yapıştırıp bir kez
çalıştır.

```sql
create table if not exists public.<oyun>_scores (
  id         bigint generated always as identity primary key,
  name       text not null,
  score      integer not null,
  day        integer not null default 1,   -- oyununa göre bu alanı uyarla/kaldır
  created_at timestamptz not null default now(),
  constraint <oyun>_scores_name_len check (char_length(name) between 1 and 12),
  constraint <oyun>_scores_score_range check (score >= 0 and score < 100000000)
);

create index if not exists <oyun>_scores_score_idx on public.<oyun>_scores (score desc);

alter table public.<oyun>_scores enable row level security;

drop policy if exists "<oyun>_scores_select_all" on public.<oyun>_scores;
create policy "<oyun>_scores_select_all" on public.<oyun>_scores
  for select using (true);

-- Herkes YENİ skor ekleyebilir, mevcut satırları güncelleyemez/silemez
-- (update/delete politikası yok = varsayılan red). İstemci hangi skoru
-- gönderirse gönderebilir, sunucu tarafı doğrulama yok — tek oyunculu bir
-- yüksek skor listesiyle aynı güven seviyesi.
drop policy if exists "<oyun>_scores_insert_anyone" on public.<oyun>_scores;
create policy "<oyun>_scores_insert_anyone" on public.<oyun>_scores
  for insert with check (
    char_length(name) between 1 and 12
    and score >= 0
    and score < 100000000
  );
```

Çok oyunculu için **tablo gerekmiyor** — hiçbir şey saklanmıyor, aşağıdaki
Realtime Presence/Broadcast tamamen bellekte/kanalda yürüyor.

## 5. Yüksek skorlar — oyun tarafı (okuma/yazma + yerel yedek)

```ts
import { supabase, SUPABASE_OK } from './supabase';

async function loadHighScores(){
  if(SUPABASE_OK){
    try{
      const { data, error } = await supabase.from('<oyun>_scores')
        .select('name,score,day').order('score', { ascending:false }).limit(10);
      if(error) throw error;
      if(Array.isArray(data)) return data;
    }catch(e){ console.warn('[scores] Supabase okunamadı, yerele dönülüyor:', e); }
  }
  return loadHighScoresLocal();   // mevcut localStorage yedeği
}

async function saveHighScore(name: string, score: number, day: number){
  if(SUPABASE_OK){
    try{
      const { error } = await supabase.from('<oyun>_scores').insert({ name, score, day });
      if(error) throw error;
      return;
    }catch(e){ console.warn('[scores] Supabase\'e kaydedilemedi, yerele yazılıyor:', e); }
  }
  saveHighScoreLocal(name, score, day);
}
```

Önemli: UI tarafındaki çağrı zincirini (`doAction` vb.) `async` yapmayı
unutma — bu fonksiyonlar artık `await` gerektiriyor.

## 6. Çok oyunculu — Supabase Realtime ile aktarım katmanı

Eski kurulumlarda (bkz. `COK-OYUNCULU.md`) ayrı bir Node/WebSocket aktarım
sunucusu (`server/relay.mjs`) gerekiyordu. Bu, statik barındırmada (GitHub
Pages, Cloudflare Pages) **hiç çalışmıyordu** — "çok oyunculu çalışmıyor"
şikayetlerinin kök nedeni buydu. Yerine geçen desen, sunucu süreci
gerektirmiyor:

- Her oda, adı oda koduyla eşleşen bir Supabase Realtime kanalı
  (`<oyun>:room:<KOD>`).
- **Presence**: oyuncu listesi + "kim ev sahibi" artık sunucuda değil, HER
  istemcide aynı saf fonksiyonla hesaplanıyor — en erken katılan
  (`joinedAt`) ev sahibi.
- **Broadcast**: oyun içi iletiler (tur başlama, canlı durum, bitiş vb.)
  broadcast ile gidiyor — kendi oyununun mesaj biçimlerini burada tanımlarsın
  (`volfied` oyununda `t:'start'|'st'|'fin'|'away'`, senin oyununda farklı
  olabilir).
- Hiçbir şey veritabanında saklanmıyor; kanalın son üyesi ayrılınca oda da
  biter.

**Gerçek testte bulunan, taşırken atlanmaması gereken tuzaklar:**

1. **En kritik:** eski WebSocket sunucuları genelde `start`/`fin` gibi "tur
   başladı/bitti" iletilerini **gönderene de** geri yollar (sunucu tarafında
   `cast()` "except" almadan çağrılır). Supabase broadcast'i varsayılan
   `self:false` — kendi gönderdiğin ileti sana geri gelmez. Oyun kodun
   gönderenin kendi mesajını da işlemeyi bekliyorsa (ör. ev sahibi `start`
   gönderip kendi turunu da ondan başlatıyorsa), bu tipleri broadcast'e ek
   olarak **gönderenin kendi listener'ına da yerel teslim et** — yoksa ev
   sahibinin kendi tarafında tur hiç başlamaz. (`nasodren-volfied/src/net.ts`
   içindeki `deliver()` fonksiyonuna bak.)
2. Ev sahibi hesabı `joinedAt`'e göre yapılıyorsa, oyuncu listesini sunucuya/
   diğer istemcilere ilettiğin her yerde `joinedAt` alanını da taşı — eksik
   kalırsa saat-kayması koruması (`Math.max(now, ...)`) `NaN`/`null` üretip
   yanlış oyuncuyu ev sahibi yapar (gerçekten yaşandı, bkz. commit geçmişi).
3. `supabase.channel(ad)` aynı adlı kanal hâlâ kayıtlıysa onu (bayat Presence
   durumuyla) geri verebilir — yeni kanal açmadan önce öncekinin kapanışını
   bekle, `supabase.getChannels()`'ta kalan aynı adlı kanalı da temizle.
4. Kanala girince ilk Presence durumu boş gelebilir — "oda yok" demeden önce
   birkaç saniye (650ms yetersiz kaldı, 3000ms kullan) bekle.
5. Tek bir `CHANNEL_ERROR`/`TIMED_OUT`'ta pes etme (kütüphane kendi yeniden
   dener); toplam bir giriş süresi (ör. 10sn) koy. Odadayken bağlantı giderse
   oyuncuyu menüye atma, yeniden bağlanınca (`SUBSCRIBED`) kaydını tekrar
   gönder.
6. `pagehide`'da `untrack()` + kanalı kapat — yoksa sekmesi kapanan oyuncu
   diğerlerinde onlarca saniye "hâlâ odada" görünür.

(Kardeş oyun nasodren3'ün kendi referans dosyası — `SUPABASE-SKOR-VE-COK-OYUNCULU.md`
— bu tuzakların daha da genişletilmiş bir listesini içeriyor; mid-round katılım
gibi daha karmaşık bir akış gerekiyorsa ona da bakmaya değer.)

`nasodren-volfied/src/net.ts` dosyası bu desenin (yukarıdaki tüm tuzaklar
düzeltilmiş hâliyle) tam, çalışan bir uygulaması — oda kurma/katılma doğrulaması (yok/dolu/tur sürüyor
kontrolleri), renk atama, "ayrıldı" bildirimleri dahil. Kendi oyununa
taşırken:

1. Dosyayı olduğu gibi kopyala.
2. `'volfied:room:' + code` içindeki `'volfied:'` önekini kendi oyun
   önekinle değiştir.
3. `net.send({...})` ile gönderilen/`net.on(fn)` ile dinlenen mesaj
   alanlarını (`t:'start'`, `t:'st'`, `t:'fin'` vb.) kendi oyun mantığına
   göre uyarla — taşıma katmanı (Presence/Broadcast/host seçimi) aynı
   kalır, sadece oyun-spesifik yük (payload) değişir.
4. Oyuncu kimliklerinin **sayısal** (number) kalmasına dikkat et — eğer
   oyun mantığın toplam puan/sıralama gibi şeyleri kimliğe göre nesne
   anahtarı yapıyorsa (`totals[id]` gibi) bu şart.

Menü tarafında "BİRLİKTE OYNA" gibi bir buton/bölüm varsa, görünürlüğünü
`SUPABASE_OK`'a bağla (barındırma yerine değil — eski hata tam da buydu:
sadece belirli bir hostname'e bakan bir kontroldü, Supabase hazır olup
olmamasına bakmıyordu).

## 7. Deploy

GitHub Actions (`.github/workflows/deploy.yml`) build adımına:
```yaml
env:
  VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
  VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}
```
Cloudflare Pages kullanılıyorsa aynı iki değeri o projenin **Settings →
Environment variables**'ına ekle (repo'da wrangler.toml yoksa bu ayar
tamamen Cloudflare panelinden yönetiliyor demektir). Değişkenler sadece
**yeni** bir build'e yansır — eski başarısız deployment satırında
"Retry"ye basmak işe yaramaz, güncel commit'ten yeni bir deployment
tetiklemek gerekir.

## 8. Doğrulama (opsiyonel ama tavsiye edilir)

- REST ile hızlı kontrol: `curl` ile `apikey`/`Authorization: Bearer` başlıklarıyla
  tabloya bir satır ekleyip (`POST .../rest/v1/<oyun>_scores`) geri okuyarak
  (`GET`) RLS politikalarının doğru kurulduğunu doğrula.
- Playwright ile iki tarayıcı bağlamı açıp biri oda kursun diğeri kodla
  katılsın, her iki tarafta da oyuncu listesinin doğru göründüğünü kontrol
  et (gerçek Realtime senkronizasyonunu kanıtlayan en sağlam test budur).
