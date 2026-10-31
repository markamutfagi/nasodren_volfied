-- Nasodren Volfied — Supabase şeması
-- Bu, SİTENİN paylaşılan Supabase projesi altında çalışıyor (her oyun için
-- ayrı proje yok). Bu yüzden tablo adı "volfied_" önekiyle bu oyuna özel —
-- sitedeki diğer oyunların (3., 4., ...) kendi tabloları kendi önekleriyle
-- aynı projeye eklenecek, burayla çakışmaz.
--
-- Supabase panelinde: SQL Editor → New query → bu dosyanın tamamını yapıştırıp çalıştır.
-- Tek seferlik kurulum; tekrar çalıştırmak istersen önce ilgili DROP satırlarını aç.

-- ============================================================
-- Yüksek skorlar (global, herkese açık liste)
-- ============================================================
create table if not exists public.volfied_scores (
  id         bigint generated always as identity primary key,
  name       text not null,
  score      integer not null,
  day        integer not null default 1,
  created_at timestamptz not null default now(),
  constraint volfied_scores_name_len check (char_length(name) between 1 and 12),
  constraint volfied_scores_score_range check (score >= 0 and score < 100000000)
);

create index if not exists volfied_scores_score_idx on public.volfied_scores (score desc);

alter table public.volfied_scores enable row level security;

-- Herkes okuyabilir (liderlik tablosu herkese açık).
drop policy if exists "volfied_scores_select_all" on public.volfied_scores;
create policy "volfied_scores_select_all" on public.volfied_scores
  for select
  using (true);

-- Herkes YENİ skor ekleyebilir (anon key ile) — ama mevcut satırları
-- güncelleyemez/silemez (update/delete politikası yok = varsayılan red).
-- Not: istemci hangi skoru gönderirse gönderebilir, sunucu tarafı doğrulama
-- yok — mevcut tek-oyunculu yüksek skor listesiyle aynı güven seviyesi.
drop policy if exists "volfied_scores_insert_anyone" on public.volfied_scores;
create policy "volfied_scores_insert_anyone" on public.volfied_scores
  for insert
  with check (
    char_length(name) between 1 and 12
    and score >= 0
    and score < 100000000
  );

-- ============================================================
-- Çok oyunculu (Realtime Presence/Broadcast)
-- ============================================================
-- Oda durumu hiçbir tabloda SAKLANMIYOR (bilerek — eski relay.mjs'nin
-- "hiçbir şey saklanmaz, oda bellekte durur" ilkesiyle aynı). Odalar sadece
-- Supabase Realtime kanalları ("volfied:room:<KOD>") üzerinden Presence+
-- Broadcast ile yürütülüyor, bu yüzden buraya tablo gerekmiyor. Kanal adının
-- "volfied:" öneki, sitedeki diğer oyunların oda kodlarıyla çakışmayı önlüyor.
--
-- Tek gereken: projede Realtime'ın açık olması (Supabase projelerinde
-- varsayılan olarak açıktır). Doğrulamak için: Project Settings → Data API →
-- Realtime bölümüne bak, ya da aşağıdaki gibi test et:
--   supabase.channel('test').subscribe(status => console.log(status))
-- "SUBSCRIBED" dönüyorsa Realtime çalışıyor demektir.
