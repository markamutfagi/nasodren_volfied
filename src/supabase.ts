/*
 * Supabase istemcisi — tek kopya, tüm uygulama bunu paylaşır.
 *
 * İki derleme zamanı ortam değişkeni gerekiyor:
 *   VITE_SUPABASE_URL       — Supabase proje URL'i (örn. https://xxxx.supabase.co)
 *   VITE_SUPABASE_ANON_KEY  — Supabase "anon public" anahtarı (tarayıcıya gömülmesi güvenli,
 *                              Row Level Security kuralları gerçek yetkiyi belirler)
 *
 * Yerelde: proje kökünde bir ".env.local" dosyasına yaz (örnek: .env.local.example).
 * CI/deploy'da: GitHub Actions repo değişkeni / Cloudflare proje ortam değişkeni olarak.
 *
 * Değerler eksikse istemciyi oluşturmuyoruz (null) — bunu kullanan her yer
 * (yüksek skorlar, çok oyunculu) bunu "özellik kapalı" olarak ele almalı,
 * sayfanın tamamen çökmesine izin vermemeli.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY_ = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const SUPABASE_OK = !!(URL_ && KEY_);

export const supabase: SupabaseClient | null = SUPABASE_OK
  ? createClient(URL_!, KEY_!, {
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;

if(!SUPABASE_OK && import.meta.env.DEV){
  // eslint-disable-next-line no-console
  console.warn('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY tanımlı değil — yüksek skorlar ve çok oyunculu devre dışı.');
}
