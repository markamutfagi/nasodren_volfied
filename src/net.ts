/*
 * Çok oyunculu bağlantı — GOAL-045: Supabase Realtime (Presence + Broadcast)
 * üzerinden, ayrı bir Node/WebSocket aktarım sunucusu YOK. Eskiden bu dosya
 * server/relay.mjs'ye bağlanırdı (bkz. COK-OYUNCULU.md) — o sunucu statik
 * barındırmada (GitHub Pages, Cloudflare) hiç çalışmıyordu, asıl "multiplayer
 * çalışmıyor" sorununun kök nedeni buydu.
 *
 * DIŞA AÇILAN ARAYÜZ VE İLETİ BİÇİMLERİ DEĞİŞMEDİ:
 *   net.open / net.on(fn) / net.send(m) / net.close()
 *   { t:'room' | 'players' | 'start' | 'st' | 'fin' | 'away' | 'error' | 'closed', ... }
 * Bu yüzden GameplayCore.ts'teki "10d. ÇOK OYUNCULU" bölümünde TEK SATIR
 * değişmedi.
 *
 * Model: her oda, adı oda koduyla eşleşen bir Supabase Realtime kanalı
 * ("volfied:room:KOD"). Eski relay.mjs'nin sunucu tarafında yaptığı iki şeyi
 * — "kim ev sahibi" ve "hangi renk boşta" — artık HER istemci, kanaldaki
 * Presence listesinden aynı saf fonksiyonla hesaplıyor: en erken katılan
 * (joinedAt) ev sahibi. Oyun içi iletiler (start/st/fin/away) Broadcast ile
 * gidiyor. Hiçbir şey veritabanında saklanmıyor; kanalın son üyesi ayrılınca
 * oda da biter.
 *
 * Aşağıdaki davranışlar, kardeş bir oyunda (nasodren3) aynı Supabase
 * Realtime deseniyle yapılan onlarca tekrarlı testte bulunan gerçek
 * hatalardan sertleştirildi — birebir aynı sınıf hatalar burada da olurdu:
 *  1) "start" ve "fin" eski sunucuda gönderene de yolluyordu (cast() 'except'
 *     almadan çağrılıyordu) — ama Supabase broadcast'i self:false. Bu yüzden
 *     bu iki tip, broadcast'e ek olarak GÖNDERENİN KENDİ listener'ına da
 *     yerel teslim edilir (bkz. deliver()); yoksa ev sahibinin turu hiç
 *     başlamaz / kendi "fin"ini hiç işlemez.
 *  2) supabase.channel(ad) aynı konu adıyla hâlâ kayıtlı bir kanal varsa onu
 *     (bayat Presence durumuyla) geri verir — yeni kanal açmadan önce
 *     öncekinin kapanışı beklenir, kalan aynı adlı kanal da temizlenir.
 *  3) Kanala girince ilk Presence durumu boş gelir; gerçek liste ~yarım
 *     saniye sonra gelir. "Oda yok" demeden önce birkaç saniye beklenir.
 *  4) Cihaz saatleri farklı olabilir: katılan oyuncu joinedAt'i odadakilerin
 *     hepsinden SONRA gelmiş sayılır — yoksa saati geride olan yeni gelen
 *     yanlışlıkla ev sahibi olur.
 *  5) Tek bir CHANNEL_ERROR/TIMED_OUT'ta pes edilmez (kütüphane kendi
 *     yeniden dener); bunun yerine toplam bir giriş süresi var. Bağlantı
 *     odadayken giderse oyuncu menüye atılmaz, yeniden bağlanınca (SUBSCRIBED)
 *     kaydı bir kez daha gönderir.
 *  6) pagehide'da untrack() + kanalı kapat — yoksa sekmesi kapanan oyuncu
 *     diğerlerinde onlarca saniye "hâlâ odada" görünür.
 *
 * Bilinen sınır: merkezi bir otorite olmadığı için "oda dolu"/"tur sürüyor"
 * kontrolleri istemcinin kendi kendine uyguladığı nazik kontroller — katı
 * bir yetkili yok. Eski sunucuda da hile koruması yoktu, güven modeli
 * değişmiyor.
 */
import { supabase, SUPABASE_OK } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

type Msg = { t: string; [k: string]: any };
type PlayerMeta = { id: number; name: string; color: number; joinedAt: number; away: boolean; v: number };

const MAX_PLAYERS = 3;              // relay.mjs ile aynı
const NAME_MAX = 12;                // relay.mjs ile aynı
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // I/1, O/0 yok — relay.mjs ile aynı alfabe
const JOIN_TIMEOUT_MS = 10000;      // toplam giriş süresi: tek bir CHANNEL_ERROR'da pes etme
const JOIN_WAIT_MS = 3000;          // katılırken odada kimse görünmezse "oda yok" demeden önce bekle

let listener: (m: Msg) => void = () => {};
let channel: RealtimeChannel | null = null;
let me: PlayerMeta | null = null;
let phase: 'lobby' | 'round' = 'lobby';
let stage: 'idle' | 'joining' | 'tracked' | 'joined' = 'idle';
let removing: Promise<any> = Promise.resolve();
let attempt = 0;

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
// Bir oyuncunun (reconnect sonrası) birden çok Presence kaydı olabilir — en yenisini al.
function newest(arr: any[]){
  return (arr || []).reduce((x: any, y: any) => (!x || (y.v | 0) > (x.v | 0) ? y : x), null);
}
function computeRoom(state: Record<string, any[]>){
  const entries: PlayerMeta[] = Object.values(state)
    .map(newest)
    .filter(Boolean)
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
  const host = entries.length ? entries[0].id : 0;
  // joinedAt'i de taşı: admit()'in saat-kayması koruması buna ihtiyaç duyuyor
  // (eksik olursa NaN → ağda null → sıralama bozulur, yanlış kişi ev sahibi olur).
  const players = entries.map(e => ({ id: e.id, name: e.name, color: e.color, away: !!e.away, joinedAt: e.joinedAt }));
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
  me.v = (me.v | 0) + 1;
  channel.track(me).catch(() => {});
}
// Eski sunucu "start"/"fin"i gönderene de yolluyordu (bkz. dosya başı not 1) —
// bu iki tip için broadcast'e ek olarak gönderenin kendi listener'ına da
// (bir sonraki tick'te, mesaj sunucudan gelmiş gibi sırayla) teslim edilir.
const deliver = (m: Msg) => setTimeout(() => listener(m), 0);

function teardown(){
  const ch = channel;
  channel = null; me = null; phase = 'lobby'; stage = 'idle'; attempt++;
  if(ch) removing = supabase!.removeChannel(ch).catch(() => {});
}

async function enterRoom(code: string, name: string, isCreate: boolean){
  if(!SUPABASE_OK || !supabase){
    listener({ t: 'error', msg: 'Çok oyunculu şu an kullanılamıyor.' });
    return;
  }
  teardown();
  const mine = attempt;
  stage = 'joining';
  const topic = 'volfied:room:' + code;

  // supabase.channel() aynı adlı kanal hâlâ kayıtlıysa onu (bayat oyuncu
  // listesiyle) geri verir — önceki kapanışını bekle, kalanı da temizle.
  await removing;
  const stale = supabase.getChannels().find(c => c.topic === 'realtime:' + topic);
  if(stale) await supabase.removeChannel(stale).catch(() => {});
  if(mine !== attempt) return;   // bu arada ayrıldı ya da başka bir odaya girdi

  const myId = newId();
  const myName = cleanName(name);
  const ch = supabase.channel(topic, {
    config: { presence: { key: String(myId) }, broadcast: { self: false } },
  });
  channel = ch;

  const giveUp = (msg: string) => { if(channel !== ch) return; teardown(); listener({ t: 'error', msg }); };
  const joinTimer = setTimeout(() => {
    if(channel === ch && stage !== 'joined') giveUp('Sunucuya bağlanılamadı. İnternet bağlantını kontrol edip yeniden dene.');
  }, JOIN_TIMEOUT_MS);
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  function admit(others: { color: number; joinedAt: number }[]){
    if(!isCreate){
      if(!others.length) return giveUp('Bu kodla bir oda yok. Kodu kontrol et.');
      if(others.length >= MAX_PLAYERS) return giveUp('Oda dolu: en fazla ' + MAX_PLAYERS + ' kişi.');
      if(phase === 'round') return giveUp('Bu odada tur sürüyor. Tur bitince yeniden dene.');
    }
    // cihaz saatleri farklı olabilir: katılan, odadakilerin hepsinden sonra
    // gelmiş sayılır — yoksa saati geride olan yanlışlıkla ev sahibi olur.
    const at = others.length ? Math.max(Date.now(), ...others.map(p => p.joinedAt + 1)) : Date.now();
    me = { id: myId, name: myName, color: pickColor(others), joinedAt: at, away: false, v: 0 };
    stage = 'tracked';
    ch.track(me).catch(() => giveUp('Odaya girilemedi. Yeniden dene.'));
  }

  ch.on('broadcast', { event: 'msg' }, (payload: any) => {
    const m = payload && payload.payload;
    if(!m) return;
    if(m.t === 'start') phase = 'round';
    listener(m);
  });

  ch.on('presence', { event: 'leave' }, ({ currentPresences, leftPresences }: any) => {
    if(channel !== ch || stage !== 'joined') return;
    // Kaydını güncelleyen (ör. yeniden bağlanan) oyuncu için de eski kaydın
    // "leave"i gelir — gerçek ayrılma yalnızca hiç kaydı kalmadığında.
    if(currentPresences && currentPresences.length) return;
    const left = leftPresences && leftPresences[0] ? leftPresences[0].id : undefined;
    if(left === undefined || left === myId) return;
    const { host, players } = computeRoom(ch.presenceState() as any);
    listener({ t: 'players', host, players, left });
  });

  ch.on('presence', { event: 'sync' }, () => {
    if(channel !== ch) return;
    const state = ch.presenceState() as Record<string, any[]>;

    if(stage === 'joining'){
      const others = computeRoom(state).players;
      if(isCreate || others.length){ if(waitTimer) clearTimeout(waitTimer); admit(others); return; }
      // Kanal girişte önce boş durum bildirir, odadakiler biraz sonra gelir.
      if(!waitTimer) waitTimer = setTimeout(() => {
        if(channel === ch && stage === 'joining') admit(computeRoom(ch.presenceState() as any).players);
      }, JOIN_WAIT_MS);
      return;
    }

    if(stage === 'tracked'){
      if(!computeRoom(state).players.some(p => p.id === myId)) return;   // kendi kaydımız henüz yayılmadı
      stage = 'joined';
      clearTimeout(joinTimer);
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
    if(channel !== ch) return;
    // Odadayken bağlantı gidip gelirse kütüphane kendisi yeniden bağlanır;
    // döndüğünde (SUBSCRIBED) kaydımızı bir kez daha gönderiyoruz.
    if(status === 'SUBSCRIBED' && me && stage === 'joined') ch.track(me).catch(() => {});
    else if(status === 'CLOSED') { teardown(); listener({ t: 'closed' }); }
    // CHANNEL_ERROR / TIMED_OUT: tek seferde pes etme, JOIN_TIMEOUT_MS'in dolmasını bekle.
  });
}

// Sekme kapanırken odadan hemen çık — yoksa diğerleri bağlantı zaman
// aşımına kadar (onlarca saniye) hâlâ odadaymış gibi görür.
addEventListener('pagehide', () => {
  if(channel){ try{ channel.untrack(); }catch(e){} teardown(); }
});

export const net = {
  get open(){ return !!channel && stage === 'joined'; },
  on(fn: (m: Msg) => void){ listener = fn; },
  send(m: Msg){
    if(m.t === 'create'){ enterRoom(newCode(), m.name, true); return; }
    if(m.t === 'join'){ enterRoom(String(m.code || '').toUpperCase().slice(0, 4), m.name, false); return; }
    if(!channel || stage !== 'joined' || !me) return;
    if(m.t === 'leave'){ try{ channel.untrack(); }catch(e){} teardown(); return; }
    if(m.t === 'start'){
      // Eski sunucu "start"ı başlatan ev sahibine de yolluyordu (cast() 'except' almadan).
      phase = 'round';
      channel.send({ type: 'broadcast', event: 'msg', payload: m });
      deliver(m);
      return;
    }
    if(m.t === 'fin'){
      // Eski sunucu "fin"i gönderene de yolluyordu — aynı şekilde yerel teslim.
      const withFrom = { ...m, from: me.id };
      channel.send({ type: 'broadcast', event: 'msg', payload: withFrom });
      deliver(withFrom);
      return;
    }
    if(m.t === 'away') retrack({ away: !!m.on });
    channel.send({ type: 'broadcast', event: 'msg', payload: { ...m, from: me.id } });
  },
  close(){ if(channel) try{ channel.untrack(); }catch(e){} teardown(); },
};
