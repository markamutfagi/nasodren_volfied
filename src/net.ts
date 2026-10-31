/*
 * Çok oyunculu bağlantı — GOAL-045: artık Supabase Realtime (Presence +
 * Broadcast) üzerinden, ayrı bir Node/WebSocket aktarım sunucusu YOK.
 * Eskiden bu dosya server/relay.mjs'ye bağlanırdı (bkz. COK-OYUNCULU.md,
 * hâlâ repoda, referans/taşıma dokümanı olarak duruyor). O sunucu statik
 * barındırmada (GitHub Pages, Cloudflare) hiç çalışmıyordu — asıl "multiplayer
 * çalışmıyor" sorununun kök nedeni buydu.
 *
 * DIŞA AÇILAN ARAYÜZ VE İLETİ BİÇİMLERİ DEĞİŞMEDİ:
 *   net.open / net.on(fn) / net.send(m) / net.close()
 *   { t:'room' | 'players' | 'start' | 'st' | 'fin' | 'away' | 'error' | 'closed', ... }
 * Bu yüzden GameplayCore.ts'teki "10d. ÇOK OYUNCULU" bölümünde (lobi, rakip
 * tahta çizimi, tur akışı — yüzlerce satır) TEK SATIR değişmedi.
 *
 * Not: bu proje, sitedeki birden fazla oyunun paylaştığı TEK bir Supabase
 * projesi üzerinde çalışıyor (her oyun için ayrı proje yok) — bu yüzden
 * tablo adı (volfied_scores, bkz. supabase/schema.sql) ve kanal öneki
 * ("volfied:") bu oyuna özel: diğer oyunların skor/oda isimleriyle
 * çakışmasın diye.
 *
 * Model: her oda, adı oda koduyla eşleşen bir Supabase Realtime kanalı
 * ("volfied:room:KOD"). Eski relay.mjs'nin sunucu tarafında yaptığı iki şeyi —
 * "kim ev sahibi" ve "hangi renk boşta" — artık HER istemci, kanaldaki
 * Presence listesinden aynı saf fonksiyonla hesaplıyor: en erken katılan
 * (joinedAt) ev sahibi. Oyun içi iletiler (start/st/fin) Broadcast ile gidiyor.
 * Hiçbir şey veritabanında saklanmıyor — relay.mjs'nin "hiçbir şey saklanmaz"
 * ilkesiyle aynı; kanalın son üyesi ayrılınca oda da biter.
 *
 * Bilinen sınır: merkezi bir sunucu/otorite olmadığı için "oda dolu" ve
 * "tur sürüyor" kontrolleri artık istemcinin kendi kendine uyguladığı nazik
 * kontroller — katı bir yetkili yok. Eski sunucuda da hile koruması yoktu
 * (bkz. COK-OYUNCULU.md §7 "Bilinen sınırlar"), bu açıdan güven modeli
 * değişmiyor, sadece "oda var mı / dolu mu" denetiminin kesinliği azalıyor.
 */
import { supabase, SUPABASE_OK } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

type Msg = { t: string; [k: string]: any };
type PlayerMeta = { id: number; name: string; color: number; joinedAt: number; away: boolean };

const MAX_PLAYERS = 3;              // relay.mjs ile aynı
const NAME_MAX = 12;                // relay.mjs ile aynı
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // I/1, O/0 yok — relay.mjs ile aynı alfabe
const EMPTY_GRACE_MS = 650;         // "create" henüz track() etmemişken "join" gelirse yanlış "oda yok" demesin

let listener: (m: Msg) => void = () => {};
let channel: RealtimeChannel | null = null;
let me: PlayerMeta | null = null;
let roomCode = '';
let phase: 'lobby' | 'round' = 'lobby';
let stage: 'idle' | 'joining' | 'tracked' | 'joined' = 'idle';

function newCode(){
  let c = '';
  for(let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return c;
}
function cleanName(s: any){
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Oyuncu';
}
function newId(){
  // Tamsayı kimlik şart: GameplayCore.ts toplam puanları `mp.totals`'ta
  // sayısal anahtar olarak tutuyor ve `+id` ile geri çeviriyor.
  return Date.now() % 1000000 * 1000 + ((Math.random() * 1000) | 0);
}

/* Presence durumundan oyuncu listesi + ev sahibi: relay.mjs'teki list()/
   "ev sahibi çıkınca ilk oyuncu devralır" mantığının istemci tarafı karşılığı
   — herkes aynı Presence durumundan aynı sonucu hesaplar. */
function computeRoom(state: Record<string, any[]>){
  const entries: PlayerMeta[] = Object.values(state)
    .map(arr => (arr && arr[0]) as PlayerMeta)
    .filter(Boolean)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const host = entries.length ? entries[0].id : 0;
  const players = entries.map(e => ({ id: e.id, name: e.name, color: e.color, away: !!e.away }));
  return { host, players };
}
function pickColor(players: { color: number }[]){
  const taken = new Set(players.map(p => p.color));
  for(const c of [0, 1, 2]) if(!taken.has(c)) return c;
  return 0;
}
function retrack(patch: Partial<PlayerMeta>){
  if(!channel || !me) return;
  Object.assign(me, patch);
  channel.track(me).catch(() => {});
}

function teardown(){
  if(channel){ try{ supabase!.removeChannel(channel); }catch(e){} }
  channel = null; me = null; roomCode = ''; phase = 'lobby'; stage = 'idle';
}

function enterRoom(code: string, name: string, isCreate: boolean){
  if(!SUPABASE_OK || !supabase){
    listener({ t: 'error', msg: 'Çok oyunculu şu an kullanılamıyor.' });
    return;
  }
  teardown();
  roomCode = code;
  stage = 'joining';
  const myId = newId();
  const myName = cleanName(name);

  const ch = supabase.channel('volfied:room:' + code, {
    config: { presence: { key: String(myId) }, broadcast: { self: false } },
  });
  channel = ch;

  ch.on('broadcast', { event: 'msg' }, (payload: any) => {
    const m = payload && payload.payload;
    if(m && m.t === 'start') phase = 'round';
    if(m) listener(m);
  });

  ch.on('presence', { event: 'leave' }, ({ leftPresences }: any) => {
    if(stage !== 'joined' || !channel) return;
    const { host, players } = computeRoom(channel.presenceState() as any);
    const left = leftPresences && leftPresences[0] ? leftPresences[0].id : undefined;
    listener({ t: 'players', host, players, left });
  });

  ch.on('presence', { event: 'sync' }, () => {
    if(!channel) return;
    const state = channel.presenceState() as Record<string, any[]>;

    if(stage === 'joining'){
      const others = computeRoom(state).players;   // henüz track() etmedim, bunlar hep başkaları
      if(!isCreate && others.length === 0){
        // Oda yok GİBİ görünüyor — ama "kur" eden daha yeni track() etmiş
        // olabilir (yayılma gecikmesi). Kısa bir grace süresi sonra tekrar bak.
        setTimeout(() => {
          if(stage !== 'joining' || !channel) return;
          const still = computeRoom(channel.presenceState() as any).players;
          if(still.length === 0){
            listener({ t: 'error', msg: 'Bu kodla bir oda yok. Kodu kontrol et.' });
            teardown();
          } else {
            continueJoin(ch, myId, myName, still);
          }
        }, EMPTY_GRACE_MS);
        return;
      }
      continueJoin(ch, myId, myName, others);
      return;
    }

    if(stage === 'tracked'){
      stage = 'joined';
      const { host, players } = computeRoom(state);
      listener({ t: 'room', code, you: myId, host, players, round: 0 });
      return;
    }

    if(stage === 'joined'){
      const { host, players } = computeRoom(state);
      listener({ t: 'players', host, players });
    }
  });

  ch.subscribe((status: string) => {
    if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT'){
      listener({ t: 'error', msg: 'Sunucuya bağlanılamadı. İnternet bağlantını kontrol edip yeniden dene.' });
      teardown();
    } else if(status === 'CLOSED'){
      if(channel === ch) listener({ t: 'closed' });
    }
  });

  function continueJoin(ch2: RealtimeChannel, myId2: number, myName2: string, others: { color: number }[]){
    if(!isCreate){
      if(others.length >= MAX_PLAYERS){
        listener({ t: 'error', msg: 'Oda dolu: en fazla ' + MAX_PLAYERS + ' kişi.' });
        teardown();
        return;
      }
      if(phase === 'round'){
        listener({ t: 'error', msg: 'Bu odada tur sürüyor. Tur bitince yeniden dene.' });
        teardown();
        return;
      }
    }
    me = { id: myId2, name: myName2, color: pickColor(others), joinedAt: Date.now(), away: false };
    stage = 'tracked';
    ch2.track(me).catch(() => {});
  }
}

export const net = {
  get open(){ return !!channel; },
  on(fn: (m: Msg) => void){ listener = fn; },
  send(m: Msg){
    if(m.t === 'create'){ enterRoom(newCode(), m.name, true); return; }
    if(m.t === 'join'){ enterRoom(String(m.code || '').toUpperCase().slice(0, 4), m.name, false); return; }
    if(!channel) return;
    if(m.t === 'leave'){ teardown(); return; }
    if(m.t === 'start') phase = 'round';
    if(m.t === 'away'){ retrack({ away: !!m.on }); }
    channel.send({ type: 'broadcast', event: 'msg', payload: { ...m, from: me ? me.id : 0 } });
  },
  close(){ teardown(); },
};
