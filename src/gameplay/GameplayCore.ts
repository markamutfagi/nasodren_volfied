// @ts-nocheck
/*
 * GameplayCore.ts
 *
 * GOAL-004 migration note:
 * Bu dosya, orijinal nasodren-volfield.html icindeki tek satir-ici <script>
 * bloğunun (window.__startGame = async function(){ ... }) MINIMUM
 * DEĞİŞİKLİKLE taşınmış halidir.
 *
 * Yapilan TEK yapisal degisiklikler:
 *   1) `window.__startGame = async function(){` -> `export async function startGame(){`
 *      (global fonksiyon atamasi yerine ES module export'u).
 *   2) Global `PIXI` nesnesi yerine `import * as PIXI from 'pixi.js'` (npm bagimliligi).
 *   3) Bu dosyanin basina `// @ts-nocheck` eklendi: orijinal kod tip-siz JS
 *      oldugu icin, "refactor yapma" kuralina uyarak hicbir tip/null-check
 *      eklenmedi; derleme (build) esbuild ile tip kontrolu yapilmadan
 *      gerceklestiriliyor (bkz. package.json build script).
 *
 * Gameplay mantigi, flood-fill algoritmasi, dusman davranislari, skor
 * sistemi, alan kapatma mantigi vs. BIREBIR AYNI birakildi. PIXI v6/v7/v8
 * uyumluluk dallanmalari (MAJOR kontrolleri) da bilerek dokunulmadan
 * korundu.
 */
import * as PIXI from 'pixi.js';
// GOAL-009 (Görsel Revizyon Sprinti 1): prosedürel dokuların yerini alan gerçek assetler.
import playerAssetUrl from '../../assets/siklament.png';   // oyuncu sprite'ı
import bossAssetUrl from '../../assets/bacteria.png';      // boss sprite'ı (1. evre: küçük)
import boss2AssetUrl from '../../assets/bacteria2.png';    // 2. evre: orta
import boss3AssetUrl from '../../assets/bacteria3.png';    // 3. evre: en büyük ve hızlı
import minionFlagellaAssetUrl from '../../assets/minion_flagella.png'; // kind:0 minion
import minionSporeAssetUrl from '../../assets/minion_spore.png';       // kind:1 minion
import healthAssetUrl from '../../assets/health.png'; // GOAL-013: can ikonu
// GOAL-020: arka plan müziği motoru (prosedürel + assets/music dosya yuvası)
import { createMusic } from '../audio/Music';
// Çok oyunculu: aktarım sunucusuna bağlantı (bkz. COK-OYUNCULU.md)
import { net } from '../net';
// GOAL-045: yüksek skorlar artık Supabase'de (gerçekten global, localStorage değil)
import { supabase, SUPABASE_OK } from '../supabase';
// GOAL-018: siklamen geri döndü — artık tüm bölümlerin zemininde değil, ilacın
// kendisinin konu olduğu günün (Koruma modu) bilgi görseli olarak.
import flowerAssetUrl from '../../assets/siclament.png';

/* GOAL-016: bölüm arka planları için asset yuvası.
   assets/bg/ klasörüne bırakılan her PNG otomatik bulunur; dosya adı hangi
   bölümde kullanılacağını söyler:
     day01.png ... day10.png  → o güne özel arka plan
     vestibule.png / meatus.png / sinus.png → o kesit arketipinin tamamı
   Hiç dosya yoksa oyun prosedürel arka planı çizmeye devam eder, yani sanat
   gelene kadar hiçbir şey bozulmaz. */
const BG_GLOB = import.meta.glob('../../assets/bg/*.png', { eager:true, import:'default' });

/* GOAL-018: bölüm bilgi görseli için ayrı asset yuvası. assets/plate/ içine
   bırakılan day01.png ... day10.png, o günün merkez görselinin yerine geçer —
   gerçek bir bilimsel fotoğraf/illüstrasyon gelince kod değişmeden devreye
   girsin diye. Boşken prosedürel doğal çizim kullanılır. */
const PLATE_GLOB = import.meta.glob('../../assets/plate/*.png', { eager:true, import:'default' });

/* Bölüm haritaları için asset yuvası. assets/board/ içine bırakılan görselin
   kızarık boşluğu o günün tahtası olur (bkz. boardMask, paintBoard):
     day01.png ... day08.png → yalnızca o gün
     maxillary_sol.png, frontal_sag.png ... → o bölgenin o tarafı
   Görseli olmayan günler anatomi çiziminden (ANAT) kurulmaya devam eder. */
const BOARD_GLOB = import.meta.glob('../../assets/board/*.png', { eager:true, import:'default' });

export async function startGame(){
"use strict";

/* =========================================================================
   0. PIXI SÜRÜM KATMANI (v6 / v7 / v8)
   ========================================================================= */
const MAJOR = parseInt(PIXI.VERSION, 10) || 7;
const BLEND_ADD = (PIXI.BLEND_MODES && PIXI.BLEND_MODES.ADD !== undefined) ? PIXI.BLEND_MODES.ADD : 'add';
function makeCanvas(w,h){ const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
function texFromCanvas(cv){
  const t = PIXI.Texture.from(cv);
  try{
    if(MAJOR >= 8) t.source.scaleMode = 'linear';
    else t.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  }catch(e){}
  return t;
}
function texUpdate(t){ try{ if(MAJOR>=8) t.source.update(); else t.baseTexture.update(); }catch(e){} }
/* GOAL-009: PNG asset -> PIXI texture (texFromCanvas ile aynı ölçek-modu mantığı) */
function texFromImage(img){
  const t = PIXI.Texture.from(img);
  try{
    if(MAJOR >= 8) t.source.scaleMode = 'linear';
    else t.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  }catch(e){}
  return t;
}
function loadImage(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/* =========================================================================
   1. MATEMATİK YARDIMCILARI
   ========================================================================= */
const clamp = (v,a,b)=> v<a?a:(v>b?b:v);
const lerp  = (a,b,t)=> a+(b-a)*t;
/* rand: oynanışın rastgeleliği. Normalde Math.random; çok oyunculu turda
   bölüm kurulurken (düşman ve güçlendirici yerleri) sunucunun tohumuna
   geçiyor ki herkeste aynı başlasın (bkz. startLevel). Görsel süs için fark
   etmiyor, o yüzden yalnızca kurulum sırasında. */
let rand = Math.random;
const rnd   = (a,b)=> a+rand()*(b-a);
function seeded(s){   // mulberry32
  return () => { s = (s + 0x6D2B79F5)|0; let t = Math.imul(s ^ s>>>15, 1 | s);
    t = t + Math.imul(t ^ t>>>7, 61 | t) ^ t; return ((t ^ t>>>14)>>>0) / 4294967296; };
}
const smooth = t => t*t*(3-2*t);
const sstep = (e0,e1,x)=>{ const t = clamp((x-e0)/(e1-e0),0,1); return t*t*(3-2*t); };
const hex2rgb = h => { const n = parseInt(h.slice(1),16); return [n>>16&255, n>>8&255, n&255]; };
function mixc(a,b,t){ return [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)]; }
function ramp(stops, t){
  t = clamp(t,0,1);
  const n = stops.length-1, f = t*n, i = Math.min(n-1, f|0);
  return mixc(stops[i], stops[i+1], f-i);
}
/* Piksel döngüleri için bellek ayırmayan sürümler: sonucu o'ya yazar. */
function rampTo(stops, t, o){
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const n = stops.length-1, f = t*n, i = Math.min(n-1, f|0), u = f-i, a = stops[i], b = stops[i+1];
  o[0] = a[0] + (b[0]-a[0])*u; o[1] = a[1] + (b[1]-a[1])*u; o[2] = a[2] + (b[2]-a[2])*u;
}
function mixTo(o, b, t){ o[0] += (b[0]-o[0])*t; o[1] += (b[1]-o[1])*t; o[2] += (b[2]-o[2])*t; }
function valueNoise(w,h,scale,seed){
  const gw = Math.ceil(w/scale)+2, gh = Math.ceil(h/scale)+2, g = new Float32Array(gw*gh);
  let s = seed>>>0 || 1;
  for(let i=0;i<g.length;i++){ s = (s*1664525+1013904223)>>>0; g[i] = s/4294967296; }
  const out = new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const fx = x/scale, fy = y/scale, ix = fx|0, iy = fy|0;
    const sx = smooth(fx-ix), sy = smooth(fy-iy);
    const a = g[iy*gw+ix], b = g[iy*gw+ix+1], c = g[(iy+1)*gw+ix], d = g[(iy+1)*gw+ix+1];
    out[y*w+x] = lerp(lerp(a,b,sx), lerp(c,d,sx), sy);
  }
  return out;
}
function fbm(w,h,base,seed,oct){
  oct = oct||3;
  const out = new Float32Array(w*h);
  let amp = .55, sc = base, norm = 0;
  for(let o=0;o<oct;o++){
    const n = valueNoise(w,h,sc,seed+o*7919);
    for(let i=0;i<out.length;i++) out[i] += n[i]*amp;
    norm += amp; amp *= .5; sc *= .42;
  }
  for(let i=0;i<out.length;i++) out[i] /= norm;
  return out;
}
/* fbm, görsel katman çözünürlüğünde: eski (VW x VH) çözünürlükte üretilip
   bilineer büyütülüyor — gürültü zaten yumuşak, keskinliği üstüne binen
   doğrusal olmayan eğriler (damar filamenti, kenar) tam çözünürlükte veriyor. */
function fbmHi(base, seed, oct){
  const lo = fbm(VW, VH, base, seed, oct);
  if(SC === AU) return lo;
  const out = new Float32Array(HW*HH);
  for(let y=0;y<HH;y++){
    const gy = clamp((y+.5)/PX - .5, 0, VH-1), iy = Math.min(VH-2, gy|0), ty = gy-iy;
    const ra = iy*VW, rb = ra+VW;
    for(let x=0;x<HW;x++){
      const gx = clamp((x+.5)/PX - .5, 0, VW-1), ix = Math.min(VW-2, gx|0), tx = gx-ix;
      const a = lo[ra+ix], b = lo[ra+ix+1], c = lo[rb+ix], d = lo[rb+ix+1];
      out[y*HW+x] = (a + (b-a)*tx)*(1-ty) + (c + (d-c)*tx)*ty;
    }
  }
  return out;
}

/* =========================================================================
   2. YAPILANDIRMA
   Oynanış ızgarası 160x160 (hücre = mantık birimi).
   Görsel katmanlar hücre başına SC piksel (bkz. aşağıda) üretilip sahaya ölçekleniyor.
   ========================================================================= */
/* GOAL-022 (revize): ızgara her cihazda AYNI.
   Bir ara telefonlar için ızgarayı 120x160'a çevirip kesitleri o orana
   esnetmiştim; alan büyüyordu ama oyun PC'dekiyle aynı oyun olmaktan
   çıkıyordu: mesafeler uzuyor, konka/septum çıkıntıları geriliyor, kesit
   "uzamış" görünüyordu. Doğru çözüm geometriyi bozmak değil, ÇERÇEVEYİ
   düzeltmek: alanın kenarlarındaki bomboş kemik payını ekran dışında
   bırakıp boşluğun kendisini ekrana oturtmak (bkz. cavBB + layout).
   Böylece telefonda da masaüstünde de tıpatıp aynı saha oynanıyor.
   GOAL-034: ızgara 160x120'den 160x160'a çıktı — kesitler artık yüz
   haritasının pencereleri ve burun boşluğu, etmoid gibi dikey biçimler
   120 satıra yeterli alanla sığmıyordu. Her cihazda yine aynı; ekrandaki
   boyutu hâlâ kesitin kendi kutusu (cavBB) belirliyor. */
const GW = 160, GH = 160, B = 3, CS = 6;
const PFW = GW*CS, PFH = GH*CS;
/* Görsel katmanların çözünürlüğü: hücre başına SC piksel. Eskiden 3'tü
   (480x480); tahta ekranı doldurmak için büyütüldüğünde yüksek DPI ekranda
   ~8 kat büyüyordu — kenarlar basamaklı, şema ve yazı bulanık. Artık 6
   (960x960), zayıf cihazda 4. Görsel çizimler hâlâ eski birimde (AU = 3
   piksel/hücre) yazılı: prosedürel çizen yerler PX = SC/AU ile ölçekleniyor,
   yumuşak gürültüler eski çözünürlükte üretilip büyütülüyor (fbmHi), yani
   bölüm hazırlığı 4 kat değil ~1,5-2 kat uzuyor. */
// zayıf cihaz: az çekirdek ya da az bellek (Chrome/Android'in bildirdiği GB) → daha küçük katmanlar
const SC = ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 2) ? 4 : 6, HW = GW*SC, HH = GH*SC;
const AU = 3, VW = GW*AU, VH = GH*AU, PX = SC/AU;
/* GOAL-015: oyun alani artik dikdortgen degil, burun/sinus boslugu. Yuzde
   hesabi sabit INTERIOR yerine cavCount uzerinden yapiliyor (bkz. bolum 4b). */
const EMPTY = 0, FILL = 1, TRAIL = 2;

const PU = { SPEED:0, FREEZE:1, LASER:2, BOMB:3, DOSE:4 };
/* tag: sahadaki etikette ve NASIL OYNANIR'da duran tek kelimelik ad. label
   bilimsel adı; ne işe yaradığını oyun oynamayan biri de tag'den okusun. */
const PU_META = [
  { key:'SPEED',  label:'Sürfaktan hızı',    tag:'HIZ',     letter:'💨', color:'#35e0d8', dur:9  },
  { key:'FREEZE', label:'Ozmotik dondurma',  tag:'DONDUR',  letter:'❄', color:'#8fb9ff', dur:6  },
  { key:'LASER',  label:'Siliyer aktivasyon',tag:'ATEŞ',    letter:'⚡', color:'#9ef05a', dur:10 },
  { key:'BOMB',   label:'Trigeminal refleks',tag:'TEMİZLE', letter:'💥', color:'#ff4d9d', dur:0  },
  { key:'DOSE',   label:'Doz yenilendi',     tag:'DOZ',     letter:'💧', color:'#ffc24a', dur:0  }
];
/* Oyuncu ve güçlendiricilerin boyu. Saha birimindeki taban boy (34) sahayla
   birlikte ölçekleniyor, ama ekrandaki boy bir aralıkta tutuluyor: telefonda
   saha küçülünce 13 piksele inip kayboluyor, büyük ekranda da sahayı
   kalabalıklaştırıyorlardı. Aralık telefonda biraz daha dar (bkz. layout →
   playerW/puW). Yalnızca görsel — çarpışma ve toplama ızgara hücresiyle. */
const PLAYER_SIZE = 34, PU_SIZE = 32;
const PLAYER_PX = { desk:[28, 36], touch:[24, 30] };   // ekranda en az / en çok
const PU_PX     = { desk:[24, 30], touch:[21, 26] };

/* GOAL-036: bölgeler yalnızca sinuzit.jfif'teki dört yapı. GOAL-039: kür 8
   günden 12 güne çıktı — her bölge önce sol, sonra sağ, sonra iki taraf
   birlikte oynanıyor ("oyun çok hızlı ilerliyor" geri bildirimi). Tema listesi
   on iki günlük tedavi yayı; her gün kendi temasını (L.theme) taşıyor — nefes
   ritmi, levha ve motif temayla birlikte. Eski on günlük listeye iki ara tema
   eklendi: salgının incelmesi ve basıncın dengelenmesi. */
const LEVEL_THEMES = [
  { day:1,  name:'Akut tıkanıklık',       target:.70, bossR:9,  bossSpd:15, bossN:1, fire:0.00, mini:3,  miniSpd:19, dose:75, pu:3,
    med:'Tıkanıklık zirvede. Harekete geç!',
    pal:['#150409','#5d0c18','#c2202c','#ff7a4a'] },
  { day:2,  name:'Ödem ve basınç',        target:.72, bossR:9,  bossSpd:17, bossN:1, fire:0.35, mini:4,  miniSpd:21, dose:70, pu:3,
    med:'Basınç artıyor. Sıkı dur!',
    pal:['#1a050c','#6d1020','#d12a35','#ff8a5a'] },
  { day:3,  name:'Hipereminin kırılması', target:.75, bossR:8,  bossSpd:19, bossN:1, fire:0.55, mini:5,  miniSpd:23, dose:66, pu:4,
    med:'Kızarıklık kırılıyor, nefes yakın.',
    pal:['#220711','#83182b','#e0455c','#ffa08a'] },
  { day:4,  name:'Mukus yoğunluğu',       target:.77, bossR:8,  bossSpd:21, bossN:1, fire:0.75, mini:6,  miniSpd:25, dose:62, pu:4,
    med:'Mukus koyulaştı. Sıkı temizlik!',
    pal:['#240c07','#8a3a1c','#dc7a2c','#ffc56a'] },
  { name:'Salgının incelmesi',     target:.78, bossR:8,  bossSpd:22, bossN:1, fire:0.85, mini:6,  miniSpd:26, dose:60, pu:4,
    med:'Salgı inceliyor, akmaya hazır.',
    pal:['#22120a','#86501c','#e09a30','#ffd27a'] },
  { day:5,  name:'Drenajın düzenlenmesi', target:.79, bossR:7,  bossSpd:23, bossN:1, fire:0.95, mini:7,  miniSpd:27, dose:58, pu:4,
    med:'Drenaj düzeliyor, ritim tuttur.',
    pal:['#1f1806','#7d6316','#d8b433','#ffe58a'] },
  { day:6,  name:'Ostium açılımı',        target:.80, bossR:7,  bossSpd:25, bossN:1, fire:1.15, mini:8,  miniSpd:29, dose:55, pu:5,
    med:'Kanallar aralanıyor, hava sızıyor.',
    pal:['#13230c','#3f6b21','#8ec63c','#d6f58a'] },
  { name:'Basıncın dengelenmesi',  target:.81, bossR:8,  bossSpd:25, bossN:1, fire:1.25, mini:8,  miniSpd:29, dose:54, pu:5,
    med:'Hava giriyor, basınç dengeleniyor.',
    pal:['#0d2216','#2a6236','#5cb86a','#b8f0b0'] },
  { day:7,  name:'Normal fonksiyon',      target:.82, bossR:10, bossSpd:26, bossN:1, fire:1.35, mini:9,  miniSpd:30, dose:52, pu:5,
    med:'Doku normale dönüyor. Devam!',
    pal:['#07211f','#16575a','#38a8a2','#9af0e2'] },
  { day:8,  name:'Koruma modu',           target:.83, bossR:7,  bossSpd:27, bossN:2, fire:1.45, mini:9,  miniSpd:31, dose:50, pu:5,
    med:'Koruma modu: günde tek doz.',
    pal:['#061c24','#125560','#33a5bb','#95e8f5'] },
  { day:9,  name:'Kronik destek',         target:.85, bossR:7,  bossSpd:29, bossN:2, fire:1.60, mini:10, miniSpd:33, dose:48, pu:5,
    med:'Direnç kırılıyor, son viraj.',
    pal:['#0a1028','#283f7c','#5f7fd0','#b9cbff'] },
  { day:10, name:'Tam havalandırma',      target:.88, bossR:9,  bossSpd:31, bossN:2, fire:1.80, mini:11, miniSpd:35, dose:46, pu:5,
    med:'Zafer yakın: tam havalandırma!',
    pal:['#0b0a26','#2d2a7a','#6f63cf','#c5b8ff'] }
];
/* GOAL-037: GÜNLERİN ZORLUĞU — ölçülerek ayarlandı.
   Tema listesindeki sayılar on günlük eski kesitler içindi; yeni tahtalarda
   eğri kırıktı (bir test oyuncusuyla ölçüldü: 1. gün 9 saniyede bitiyor,
   5. gün 3-4'ten kolay, frontal günlerinde alanın ancak %5'i alınabiliyordu).
   Zorluğu yalnızca düşman sayısı değil tahtanın biçimi de belirliyor: geniş
   bir frontal lobda kesimler uzun, mikroplar yetişiyor. Bu yüzden her günün
   değerleri tahtasıyla birlikte ayarlandı (areaT: tahtanın hücre alanı —
   küçük tahta kısa kesim demek).
   Hedef eğri: aynı test oyuncusu 1. günü neredeyse her seferinde, son günü
   üç denemeden ikisinde geçiyor; aradaki her gün bir öncekinden biraz zor.
   Bunun üstüne oyuncu her yeni güne +1 canla giriyor. (Kaybedince "günü
   tekrarla" seçeneği vardı; kaldırıldı — oyun bitince kür baştan başlıyor,
   bölüm seçiminden istenen güne girilebiliyor.) Bir değer değişirse eğri yeniden ölçülmeli: tools/denge-testi.mjs.
   Maksiller ve frontal günleri harita görsellerine (assets/board), bakteri de
   üç evreye (BOSS_TIER_BY_DAY: yarıçap 7 → 9 → 11, son evre en hızlı) geçince
   yeniden ölçüldü. İç bölmesi olmayan açık maksiller kesede ve büyüyen
   bakterinin yanında asıl kaldıraç mikrop sayısı ve hedef yüzde çıktı.
   Burun boşluğu iki ayrı yarım tahtaya bölününce (dar ve uzun, ızgaraya ancak
   ~5000 hücreyle sığıyor) 1-2. günler de yeniden ölçüldü.
   Ölçüm (üç canla kazanma oranı, gün başına 48-112 deneme): %92 · 88 · 84 ·
   80 · 81 · 88 · 71 · 64; gün başına ölüm 0.7 → 1.4.
   GOAL-039: kür 12 güne çıkıp (her bölgede sol, sağ, iki taraf birlikte)
   burnun konkaları ve etmoidin bölmeleri kalkınca yeniden ölçüldü. Bölmesiz
   burun yarımında virüs bütün alanda dolaşabildiği için 1-2. gün zorlaşmıştı
   (%73 · 55), tek parça etmoid de eski değerlerle %33-39'a düşmüştü; ikisinde
   de mikrop sayısı ve hedef yüzde indirildi. Hedef eğri yine aynı: 1. gün
   ~%92'den 12. gün ~%65'e. Ölçüm (gün başına 80 deneme, ±%5 gürültü): %98 ·
   90 · 90 · 80 · 83 · 78 · 77-88 · 76 · 66 · 65 · 73 · 59; ölüm 0.8 → 1.5. */
const DAY_TUNE = [
  { target:.66, bossR:7, bossSpd:12, bossN:1, fire:0, mini:1, miniSpd:16, dose:80 },
  { target:.66, bossR:7, bossSpd:13, bossN:1, fire:0, mini:1, miniSpd:16, dose:78 },
  { target:.66, bossR:7, bossSpd:14, bossN:1, fire:.1, mini:2, miniSpd:17, dose:76 },
  { target:.66, bossR:7, bossSpd:14, bossN:1, fire:.25, mini:2, miniSpd:16, dose:72 },
  { target:.72, bossR:9, bossSpd:14, bossN:1, fire:.2, mini:1, miniSpd:16, dose:68 },
  { target:.69, bossR:9, bossSpd:15, bossN:1, fire:.2, mini:2, miniSpd:16, dose:68 },
  { target:.68, bossR:9, bossSpd:15, bossN:1, fire:.3, mini:1, miniSpd:16, dose:64 },
  { target:.7, bossR:9, bossSpd:15, bossN:1, fire:.2, mini:2, miniSpd:16, dose:62 },
  { target:.7, bossR:11, bossSpd:16, bossN:1, fire:.2, mini:1, miniSpd:17, dose:62 },
  { target:.71, bossR:11, bossSpd:19, bossN:1, fire:.1, mini:1, miniSpd:16, dose:60, areaT:5400 },
  { target:.71, bossR:11, bossSpd:20, bossN:1, fire:.2, mini:1, miniSpd:17, dose:58, areaT:5400 },
  { target:.71, bossR:11, bossSpd:20, bossN:1, fire:.2, mini:2, miniSpd:17, dose:58 }
];
const LEVELS = LEVEL_THEMES.map((T, i) => Object.assign({}, T, DAY_TUNE[i], { day:i+1, theme:i }));
/* -------------------------------------------------------------------------
   GOAL-015 — NEFES KATMANI
   Her güne bir burun/sinüs kesiti (cav), bir nefes ritmi (breath: kaç saniyede
   bir vücut nefes almayı deniyor) ve tıkalı nefesin basınç bedeli (pressGain)
   düşüyor.
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   GOAL-024/036 — ANATOMİK YOLCULUK
   Bölümler assets/sinuzit.jfif'teki önden görünümdeki dört yapı (bkz. ANAT,
   BOARDS): burun boşluğu, maksiller, etmoid ve frontal sinüs. Sıra ilacın
   izlediği yol: burundan giriyor, önce en büyük sinüs olan maksiller, sonra
   gözlerin arasındaki etmoid ve en son, kanalı en uzun olan frontal açılıyor.
   Her bölgede (burun boşluğu dahil) birinci gün sol, ikinci gün sağ taraf —
   görseldeki iki taraf gerçekten farklı biçimde. GOAL-039: üçüncü gün iki
   taraf birlikte (side 'iki', L.pair): giriş sahnesinde iki sinüs yüzden öne
   çıkıyor, birbirine yaklaşıp ekranı kaplıyor; tahta ikisinin orta hatta
   kaynaşmış tek parça hâli (bkz. pairShift).
   ------------------------------------------------------------------------- */
const REGIONS = {
  nasal: { name:'Burun boşluğu', cav:'vestibule', music:'vestibule',
    about:'Siklamenin girdiği yer. Konkalar şişmiş, hava akımı daralmış; yolculuk buradan başlıyor.' },
  maxillary: { name:'Maksiller sinüs', cav:'maxillary', music:'meatus',
    about:'Yanak kemiğindeki en büyük boşluk. Ostiumu tavanda olduğu için yerçekimine karşı boşalır.' },
  ethmoid: { name:'Etmoid sinüs', cav:'ethmoid', music:'sinus',
    about:'Gözlerin arasındaki petek. Onlarca küçük hücre, her biri dar bir boyunla bağlı ve ayrı ayrı tıkanıyor.' },
  frontal: { name:'Frontal sinüs', cav:'frontal', music:'sinus',
    about:'Alındaki boşluk. Kanalı en uzun, ostiumu en tepede; yayın en zor durağı.' },
};
const DAY_REGION = ['nasal','nasal','nasal','maxillary','maxillary','maxillary',
                    'ethmoid','ethmoid','ethmoid','frontal','frontal','frontal'];
const DAY_SIDE   = ['sol','sag','iki','sol','sag','iki','sol','sag','iki','sol','sag','iki'];
/* Virüs kür boyunca evriliyor: 1-4. gün küçük, 5-8. gün orta, 9-12. gün en
   büyük ve en hızlı (görseller assets/bacteria*.png). Boyut ve hız
   DAY_TUNE'daki bossR/bossSpd; görsel buradan. */
const BOSS_TIER_BY_DAY = [0,0,0,0, 1,1,1,1, 2,2,2,2];
LEVELS.forEach((L,i) => {
  const R = REGIONS[DAY_REGION[i]];
  L.region    = DAY_REGION[i];
  L.regionName= R.name;
  L.regionAbout = R.about;
  L.side      = DAY_SIDE[i];
  L.pair      = DAY_SIDE[i] === 'iki';
  L.sideName  = L.pair ? 'İKİ TARAF' : DAY_SIDE[i] === 'sag' ? 'SAĞ' : 'SOL';
  L.sideLong  = L.pair ? 'İKİ TARAF' : L.sideName + ' TARAF';
  L.music     = R.music;
  L.cav       = R.cav;
  L.bossTier  = BOSS_TIER_BY_DAY[i];
  L.breath    = 11.5 - L.theme*0.4;      // tema 1: 11.5sn ... tema 12: 7.1sn
  L.pressGain = 0.15 + L.theme*0.011;    // tıkalı nefesin basınç bedeli
});

/* -------------------------------------------------------------------------
   GOAL-031 — BİLGİ ŞERİDİ METİNLERİ
   Oyuncu kestikçe tahtanın yanındaki şeritte beliren kısa bilgiler (12 gün).
   Her gün dört tane: ilki ilk kesimde, sonrakiler hedefin %25/%50/%75'inde (bkz.
   Info). Aynı bölgenin iki günü farklı bilgiler taşıyor ki sağ tarafa geçen
   oyuncu aynı şeyleri tekrar okumasın. Anatomi ve fizyoloji bilgisi; ilacın
   kendisine dair iddia bilerek yok — o metinler marka onayından geçmeli.
   Başlık 2-4 kelime, gövde tek-iki cümle: göz ucuyla okunacak kadar.
   k: aynı bilginin kısa hâli (en çok ~60 karakter). Telefonda tahtanın altında
   tam karta yer yokken başlıkla birlikte iki satıra sığıp bir bakışta
   okunsun diye; uzun hâli yer olduğunda, duraklatmada ve gün sonunda.
   ------------------------------------------------------------------------- */
const FACTS = [
  [ { t:'Üç kat konka', b:'Burnun yan duvarlarında üç kıvrımlı çıkıntı var: alt, orta ve üst konka. Havayı ısıtıp nemlendiren yüzeyi büyütürler.',
      k:'Burnun yan duvarında üç kıvrım var; havayı ısıtıp nemlendirirler.' },
    { t:'Tıkanıklığın kaynağı', b:'Akut tıkanıklıkta konkaların içindeki damar ağı kanla dolar, mukoza şişer; havanın geçtiği aralık birkaç milimetreye iner.',
      k:'Konka damarları kanla dolar, mukoza şişer, hava yolu daralır.' },
    { t:'Nazal siklus', b:'Konkalar birkaç saatte bir sırayla şişip iner. Bu yüzden çoğu zaman burnun bir tarafı diğerinden daha açıktır.',
      k:'Konkalar sırayla şişip iner; burnun bir yanı genelde daha açıktır.' },
    { t:'Günde binlerce litre', b:'Bir yetişkin günde yaklaşık 10.000 litre hava solur. Dinlenirken bu havanın büyük kısmı önce burundan geçer.',
      k:'Günde yaklaşık 10.000 litre hava soluruz, çoğu burundan.' } ],
  [ { t:'Septum', b:'Burnu ikiye ayıran orta duvar kıkırdak ve kemikten oluşur. Yetişkinlerin çoğunda hafifçe bir yana eğiktir.',
      k:'Burnu ikiye ayıran orta duvar; çoğu insanda hafifçe eğiktir.' },
    { t:'Ödem', b:'İltihapta damarlardan sızan sıvı mukozada birikir. Şişen doku hem hava yolunu hem de sinüslerin ağızlarını daraltır.',
      k:'Damarlardan sızan sıvı mukozayı şişirir, sinüs ağızlarını daraltır.' },
    { t:'Havayı hazırlayan yol', b:'Burun, soluduğun havayı akciğere ulaşmadan önce vücut sıcaklığına yaklaştırır ve nemlendirir.',
      k:'Burun havayı akciğere varmadan ısıtır ve nemlendirir.' },
    { t:'Sinüslerin kapısı', b:'Bütün sinüsler burun boşluğuna küçük ağızlarla açılır. Sinüslere giden yol da buradan geçer.',
      k:'Bütün sinüsler burun boşluğuna küçük ağızlarla açılır.' } ],
  [ { t:'İki yol, tek nefes', b:'Septum burnu iki ayrı kanala böler. İki taraftan alınan hava arkada, burun ile yutağın birleştiği yerde buluşur.',
      k:'Septum burnu ikiye böler; iki kanal arkada buluşur.' },
    { t:'Koana', b:'Burun boşluğunun iki arka ağzına koana denir. Soluduğun hava buradan geçip yutağa iner.',
      k:'Burnun iki arka ağzı koanadır; hava buradan yutağa iner.' },
    { t:'Tek örtü', b:'Burnun ve bütün sinüslerin iç yüzeyi kesintisiz tek bir mukozayla kaplıdır; burundaki iltihap bu yüzden sinüslere kolayca yayılır.',
      k:'Burun ve sinüsler tek mukozayla kaplı; iltihap kolay yayılır.' },
    { t:'Rinosinüzit', b:'Burun ve sinüs iltihabı çoğu zaman birlikte görüldüğü için hekimler bugün "rinosinüzit" terimini kullanır.',
      k:'Burun ve sinüs iltihabı birlikte görülür: rinosinüzit.' } ],
  [ { t:'En büyük sinüs', b:'Maksiller sinüs yanak kemiğinin içindedir. Yetişkinde ortalama 15 ml hacmiyle sinüslerin en büyüğüdür.',
      k:'Yanak kemiğinde, yaklaşık 15 ml; sinüslerin en büyüğü.' },
    { t:'Ağzı tepede', b:'Doğal ağzı (ostium) iç duvarın tepesine yakındır. Sinüs boşalmak için yerçekimine değil, silyalara güvenir.',
      k:'Ağzı iç duvarın tepesinde; salgıyı silyalar yukarı taşır.' },
    { t:'Silyer yol', b:'Siller salgıyı sinüsün tabanından başlayıp duvarlar boyunca kıvrılan bir yolla ostiuma doğru taşır.',
      k:'Siller salgıyı tabandan duvarlar boyunca ostiuma taşır.' },
    { t:'Dişlere komşu', b:'Üst azı dişlerinin kökleri sinüs tabanına çok yakındır; bazı sinüzitlerin kaynağı bir diştir.',
      k:'Üst azı dişlerinin kökleri sinüs tabanına çok yakındır.' } ],
  [ { t:'Göz tabanı', b:'Sinüsün tavanı aynı zamanda göz çukurunun tabanıdır. İçinden yanağa duyu taşıyan infraorbital sinir geçer.',
      k:'Sinüsün tavanı, göz çukurunun tabanıdır.' },
    { t:'Tıkalı sinüs neden ağrır?', b:'Ağzı kapanan sinüste salgı birikir ve basınç değişir; yanakta dolgunluk ve ağrı buradan gelir.',
      k:'Ağzı kapanınca salgı birikir, basınç yanağı ağrıtır.' },
    { t:'Ostium açılınca', b:'Ağız yeniden açıldığında sinüse hava girer, basınç dengelenir ve biriken salgı akmaya başlar.',
      k:'Hava girer, basınç dengelenir, biriken salgı akar.' },
    { t:'Dişlerle büyür', b:'Maksiller sinüs doğumda çok küçüktür; kalıcı dişler çıktıkça aşağı doğru büyüyerek erişkin boyutuna ulaşır.',
      k:'Doğumda küçüktür; kalıcı dişler çıktıkça büyür.' } ],
  [ { t:'Virüsle başlar', b:'Akut sinüzitlerin büyük çoğunluğu soğuk algınlığı virüsleriyle başlar; bakteri ancak az bir kısmına sonradan eklenir.',
      k:'Akut sinüzitin çoğu virüsle başlar; bakteri nadiren eklenir.' },
    { t:'İkiz değil', b:'Sağ ve sol maksiller sinüs çoğu zaman birbirinden biraz farklı büyüklükte ve biçimdedir.',
      k:'Sağ ve sol maksiller sinüs çoğu zaman birbirinden farklıdır.' },
    { t:'Diş ağrısı gibi', b:'Maksiller sinüs tıkandığında ağrı üst dişlere vurabilir; sinüzit bu yüzden bazen diş ağrısıyla karışır.',
      k:'Ağrı üst dişlere vurabilir; diş ağrısıyla karışır.' },
    { t:'Röntgende koyu', b:'Sağlıklı sinüs hava doludur ve röntgende koyu görünür. Salgıyla dolunca beyazlaşır.',
      k:'Hava dolu sinüs röntgende koyu; salgıyla dolunca beyaz.' } ],
  [ { t:'Petek', b:'Etmoid sinüs tek bir boşluk değil: her iki yanda 3 ile 18 arası küçük hava hücresinden oluşan bir labirent.',
      k:'Tek boşluk değil: her yanda 3-18 küçük hava hücresi.' },
    { t:'Kâğıt duvar', b:'Hücreleri göz çukurundan ayıran duvara lamina papyracea denir; adı gibi kâğıt inceliğindedir.',
      k:'Göz çukuruyla arasındaki duvar kâğıt inceliğindedir.' },
    { t:'Silyaların ritmi', b:'Her epitel hücresinde yüzlerce sil vardır; saniyede 10-15 kez çırparak mukus örtüsünü taşırlar.',
      k:'Siller saniyede 10-15 kez çırparak mukusu taşır.' },
    { t:'Temizlik bandı', b:'Sağlıklı mukozada mukus örtüsü dakikada birkaç milimetre hızla boğaza doğru ilerler.',
      k:'Mukus örtüsü dakikada birkaç milimetre boğaza ilerler.' } ],
  [ { t:'Ön ve arka hücreler', b:'Ön etmoid hücreleri orta meatusa, arka hücreler üst meatusa açılır.',
      k:'Ön hücreler orta, arka hücreler üst meatusa açılır.' },
    { t:'Doğuştan var', b:'Etmoid hücreleri doğumda zaten vardır; çocuklarda en sık tutulan sinüsler de bunlardır.',
      k:'Doğumda vardır; çocuklarda en sık tutulan sinüslerdir.' },
    { t:'Mukozanın kalkanı', b:'Mukusun içindeki antikorlar ve enzimler mikropları daha dokuya ulaşmadan etkisiz hâle getirir.',
      k:'Mukustaki antikor ve enzimler mikropları etkisiz bırakır.' },
    { t:'Koku yarığı', b:'Etmoidin tavanına yakın, septumun yanındaki dar yarıkta koku epiteli bulunur. Burası tıkanınca koku azalır.',
      k:'Etmoidin tavanında koku epiteli var; tıkanınca koku azalır.' } ],
  [ { t:'İki labirent', b:'Etmoid hücreleri iki yanda ayrı birer labirent oluşturur; aralarında burun boşluğunun üst kısmı ve septum bulunur.',
      k:'İki yanda ayrı labirent; aralarında burnun üst kısmı var.' },
    { t:'Adı elekten', b:'Etmoid adı Yunanca "elek" anlamındaki sözcükten gelir; kemiğin delikli, petek gibi yapısını anlatır.',
      k:'Adı Yunancada "elek"ten gelir; petek gibi deliklidir.' },
    { t:'Elek gibi tavan', b:'Etmoid kemiğin delikli tavanından geçen ince koku sinirleri burnun tepesine iner.',
      k:'Delikli tavanından koku sinirleri burna iner.' },
    { t:'Gözlerin arasında', b:'Etmoid hücreleri iki gözün tam arasında durur; şiştiklerinde ağrı göz çevresinde ve burun kökünde hissedilir.',
      k:'İki gözün arasında; şişince ağrı göz çevresinde olur.' } ],
  [ { t:'Alındaki boşluk', b:'Frontal sinüsler kaşların üstünde, alın kemiğinin iki tabakası arasındadır. Sağ ve sol çoğu zaman farklı büyüklüktedir.',
      k:'Kaşların üstünde, alın kemiğinde; iki yanı çoğu zaman farklı.' },
    { t:'Parmak izi gibi', b:'Frontal sinüsün kıvrımlı kenarı kişiye özgüdür; röntgenden kimlik tespitinde bile kullanılır.',
      k:'Kıvrımlı kenarı kişiye özgü; kimlik tespitinde kullanılır.' },
    { t:'En uzun yol', b:'Frontal sinüs, dar ve kıvrımlı frontal resesle aşağıya, orta meatusa boşalır. Tıkanmaya en açık yol budur.',
      k:'Dar ve kıvrımlı bir kanalla boşalır; en kolay tıkanan yol.' },
    { t:'Kronik sinüzit', b:'Belirtiler 12 haftadan uzun sürerse kronik sinüzitten söz edilir.',
      k:'Belirtiler 12 haftadan uzun sürerse kronik sayılır.' } ],
  [ { t:'Geç gelişen sinüs', b:'Frontal sinüs doğumda yok denecek kadar küçüktür; okul çağında belirginleşir, ergenlikte gelişimini tamamlar.',
      k:'Doğumda çok küçüktür; ergenlikte gelişimini tamamlar.' },
    { t:'Herkeste yok', b:'Her yüz kişiden birkaçında frontal sinüs hiç gelişmez.',
      k:'Her yüz kişiden birkaçında frontal sinüs hiç gelişmez.' },
    { t:'Neden sinüsümüz var?', b:'Görevleri tam bilinmiyor; kafatasını hafifletmek ve sese tını katmak en bilinen açıklamalar.',
      k:'Tam bilinmiyor; kafatasını hafifletir, sese tını katar.' },
    { t:'Tam havalandırma', b:'Bütün ağızlar açıkken sinüsler burunla birlikte havalanır ve salgı silyalarla kendiliğinden akar.',
      k:'Ağızlar açıkken sinüsler havalanır, salgı kendiliğinden akar.' } ],
  [ { t:'Ortadaki bölme', b:'İki frontal sinüsü ince bir kemik bölme ayırır; bu bölme çoğu zaman tam ortada durmaz.',
      k:'İki frontal sinüsü ince bir bölme ayırır; çoğu kez ortada değil.' },
    { t:'Öne eğilince', b:'Frontal sinüs tıkalıyken öne eğilmek alındaki basınç ve ağrıyı artırabilir.',
      k:'Tıkalıyken öne eğilince alın ağrısı artabilir.' },
    { t:'Dört çift sinüs', b:'Yüzün iki yanında dörder sinüs vardır: maksiller, etmoid, frontal ve kafatasının derinindeki sfenoid.',
      k:'Dört çift sinüs: maksiller, etmoid, frontal ve sfenoid.' },
    { t:'Birlikte nefes', b:'Bütün sinüsler burunla aynı hava yoluna açılır; ağızları açıkken hepsi her nefeste birlikte havalanır.',
      k:'Sinüsler aynı yola açılır; açıkken her nefeste havalanır.' } ]
];

const PLAYER_SPD = 38, PLAYER_SPD_FAST = 60, MEGA_SHARE = .12;

/* =========================================================================
   3. SES
   ========================================================================= */
/* GOAL-020: ses mimarisi.
   master
     ├── musicBus → arka plan müziği + ortam uğultusu
     └── sfxBus   → oyunun bütün efektleri
   Böylece "müziği kıs ama efektler kalsın" mümkün oluyor. Seviyeler
   localStorage'da tutuluyor; ayarlar ekranı (AYARLAR) bunları değiştiriyor. */
const AUDIO_KEY = 'nasodren_audio_v1';
const AudioPrefs = {
  master:.7, music:.6, sfx:.9, muted:false,
  load(){
    try{
      const o = JSON.parse(localStorage.getItem(AUDIO_KEY) || 'null');
      if(o && typeof o === 'object'){
        if(typeof o.master === 'number') this.master = clamp(o.master,0,1);
        if(typeof o.music  === 'number') this.music  = clamp(o.music,0,1);
        if(typeof o.sfx    === 'number') this.sfx    = clamp(o.sfx,0,1);
        this.muted = !!o.muted;
      }
    }catch(e){}
  },
  save(){
    try{ localStorage.setItem(AUDIO_KEY, JSON.stringify({
      master:this.master, music:this.music, sfx:this.sfx, muted:this.muted })); }catch(e){}
  }
};
AudioPrefs.load();

const Sound = {
  ctx:null, master:null, musicBus:null, sfxBus:null, music:null, noise:null,
  on:!AudioPrefs.muted, prefs:AudioPrefs,
  scenePend:{ name:'menu', day:0 },
  init(){
    if(this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC){ this.on = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus.connect(this.master); this.sfxBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate*2, buf = this.ctx.createBuffer(1,len,this.ctx.sampleRate), d = buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i] = Math.random()*2-1;
    this.noise = buf;
    this.ambient();
    this.music = createMusic(this.ctx, this.musicBus);
    this.music.setScene(this.scenePend.name, this.scenePend.day);
    this.apply();
  },
  resume(){ if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  /* Seviyeleri donanıma uygula. Müzik motoru tamamen kısıkken hiç çalışmasın
     diye durduruluyor — sessizce dönüp CPU yemesin. */
  apply(){
    this.on = !AudioPrefs.muted;
    if(!this.ctx) return;
    this.master.gain.value   = AudioPrefs.muted ? 0 : AudioPrefs.master;
    this.musicBus.gain.value = AudioPrefs.music;
    this.sfxBus.gain.value   = AudioPrefs.sfx;
    if(this.music){
      const want = !AudioPrefs.muted && AudioPrefs.master > .001 && AudioPrefs.music > .001;
      if(want) this.music.start(); else this.music.stop();
    }
  },
  set(which, v){
    AudioPrefs[which] = clamp(v,0,1);
    if(which !== 'muted' && AudioPrefs.muted && v > 0) AudioPrefs.muted = false;
    AudioPrefs.save();
    this.init(); this.resume(); this.apply();
  },
  /* Hangi bölümdeyiz / menüde miyiz — müzik buna göre değişiyor.
     Ses motoru henüz açılmamışsa (ilk dokunuş olmadan AudioContext kurulamaz)
     istek saklanır ve init sırasında uygulanır. */
  scene(name, day){
    this.scenePend = { name:name, day:day||0 };
    if(this.music) this.music.setScene(name, day||0);
  },
  tension(v){ if(this.music) this.music.setTension(v); },
  ambient(){
    const c = this.ctx, s = c.createBufferSource();
    s.buffer = this.noise; s.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    const g = c.createGain(); g.gain.value = .02;
    const lfo = c.createOscillator(); lfo.frequency.value = .16;
    const lg = c.createGain(); lg.gain.value = .014;
    lfo.connect(lg); lg.connect(g.gain);
    s.connect(f); f.connect(g); g.connect(this.musicBus);
    s.start(); lfo.start();
  },
  air(dur,f0,f1,vol,q){
    if(!this.on || !this.ctx) return;
    const c = this.ctx, t = c.currentTime, s = c.createBufferSource();
    s.buffer = this.noise; s.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q||1.1;
    bp.frequency.setValueAtTime(f0,t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40,f1), t+dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(vol, t+dur*.14);
    g.gain.exponentialRampToValueAtTime(.0005, t+dur);
    s.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    s.start(t); s.stop(t+dur+.05);
  },
  tone(f,dur,type,vol,to){
    if(!this.on || !this.ctx) return;
    const c = this.ctx, t = c.currentTime, o = c.createOscillator();
    o.type = type||'sine'; o.frequency.setValueAtTime(f,t);
    if(to) o.frequency.exponentialRampToValueAtTime(Math.max(20,to), t+dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(vol, t+.01);
    g.gain.exponentialRampToValueAtTime(.0004, t+dur);
    o.connect(g); g.connect(this.sfxBus); o.start(t); o.stop(t+dur+.05);
  },
  capture(share){
    const big = clamp(share*6,0,1);
    this.air(.42+big*.5, 420+big*380, 1500+big*1400, .3+big*.2, 1.0);
    this.tone(190+big*90,.34,'sine',.1,340+big*170);
  },
  sneeze(){ this.air(.78,2600,170,.5,.7); this.tone(140,.6,'sine',.3,36); this.tone(72,.5,'triangle',.2,28); },
  pickup(){ this.tone(660,.1,'sine',.15); setTimeout(()=>this.tone(990,.18,'sine',.13),70); },
  hit(){ this.tone(210,.45,'sawtooth',.2,52); this.air(.34,900,120,.2,.8); },
  clear(){ [523,659,784,1046].forEach((f,i)=>setTimeout(()=>this.tone(f,.5,'sine',.13),i*110)); this.air(1.1,300,2200,.19,.9); },
  laser(){ this.tone(1400,.06,'square',.04,760); },
  ui(){ this.tone(720,.07,'sine',.08,980); },
  /* GOAL-015: nefes döngüsünün sesleri — hepsi mevcut air()/tone() ile */
  inhaleCue(){ this.air(1.0,150,540,.09,.9); },
  breathOpen(){ this.air(1.05,380,2400,.24,.8); [392,523,659].forEach((f,i)=>setTimeout(()=>this.tone(f,.4,'sine',.09),i*85)); },
  leak(){ this.air(.7,760,260,.16,2.4); this.tone(160,.3,'triangle',.07,96); },
  blocked(){ this.air(.6,250,70,.2,1.6); this.tone(86,.5,'sine',.18,40); },
  heartbeat(){ this.tone(58,.15,'sine',.15,32); setTimeout(()=>this.tone(50,.2,'sine',.10,28),175); },
  toggle(){ AudioPrefs.muted = !AudioPrefs.muted; AudioPrefs.save(); this.apply(); return this.on; }
};

/* =========================================================================
   4. PROSEDÜREL DOKULAR — hepsi yüksek çözünürlükte, dosya yok
   ========================================================================= */
function texRadial(size, stops){
  const cv = makeCanvas(size,size), c = cv.getContext('2d');
  const g = c.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
  for(const s of stops) g.addColorStop(s[0], s[1]);
  c.fillStyle = g; c.fillRect(0,0,size,size);
  return texFromCanvas(cv);
}
/* GOAL-009: oyuncu ve boss artık gerçek PNG assetlerinden (bkz. texFromImage
   + loadImage, TEX nesnesi kurulumu) — eski prosedürel texPlayer()/texBoss()
   kaldırıldı. */
/* GOAL-012: minion'lar artık gerçek PNG assetlerinden (bkz. texFromImage +
   loadImage, TEX.mini kurulumu) — eski prosedürel texMinion() kaldırıldı. */
function texPowerup(meta){
  const S = 96, cv = makeCanvas(S,S), c = cv.getContext('2d');
  const m = S/2, R = S*.38;
  c.translate(m,m);
  c.rotate(Math.PI/4);
  const g = c.createLinearGradient(-R,-R,R,R);
  g.addColorStop(0,'rgba(255,255,255,.32)');
  g.addColorStop(.45,'rgba(10,22,32,.92)');
  g.addColorStop(1,'rgba(10,22,32,.82)');
  c.fillStyle = g; c.fillRect(-R,-R,R*2,R*2);
  c.lineWidth = 3; c.strokeStyle = meta.color; c.strokeRect(-R,-R,R*2,R*2);
  c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.35)';
  c.strokeRect(-R+6,-R+6,(R-6)*2,(R-6)*2);
  c.rotate(-Math.PI/4);
  c.font = '46px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji","Roboto Condensed",sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = meta.color;
  c.shadowColor = meta.color; c.shadowBlur = 16;
  c.fillText(meta.letter, 0, 3);
  return texFromCanvas(cv);
}
/* GOAL-017: rüzgâr dokuları.
   Açılan hava yolunda akan havayı herkesin tanıyacağı bir dille göstermek
   için iki biçim: uzun sivrilen bir hız çizgisi ve ucunda kıvrım olan bir
   rüzgâr kancası. İkisi de yatay çizilip sprite döndürülerek akış yönüne
   oturtuluyor. */
function texWind(){
  // GOAL-019: kuyruğu uzun, başı parlak bir kuyrukluyıldız. Sprite akış yönüne
  // döndürüldüğü için baş +x tarafında: ışık önde, iz arkada kalıyor.
  const W = 384, H = 64, cv = makeCanvas(W,H), c = cv.getContext('2d');
  const g = c.createLinearGradient(0,0,W,0);
  g.addColorStop(0,   'rgba(255,255,255,0)');
  g.addColorStop(.30, 'rgba(255,255,255,.20)');
  g.addColorStop(.62, 'rgba(255,255,255,.55)');
  g.addColorStop(.84, 'rgba(255,255,255,.95)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(0,H*.5);
  c.quadraticCurveTo(W*.56,H*.30, W,H*.42);
  c.lineTo(W,H*.58);
  c.quadraticCurveTo(W*.56,H*.70, 0,H*.5);
  c.closePath(); c.fill();
  const g2 = c.createRadialGradient(W*.80,H*.5,0,W*.80,H*.5,H*.45);
  g2.addColorStop(0,'rgba(255,255,255,.85)');
  g2.addColorStop(1,'rgba(255,255,255,0)');
  c.fillStyle = g2;
  c.beginPath(); c.ellipse(W*.80,H*.5,W*.13,H*.28,0,0,7); c.fill();
  return texFromCanvas(cv);
}
/* GOAL-018: tıkalı işareti. Eskiden tıkanıklığı, yola çıkıp duvara çarpan
   kırmızı hava noktaları anlatıyordu; sürekli hareket ekranı yoruyordu ve
   "gidemiyor" mesajı ancak izlerseniz okunuyordu. Yerine herkesin tanıdığı
   tek bir simge: daire içinde çapraz çizgi. */
/* GOAL-028: burada texBlocked(), texGust() ve texRing() vardı; üçü de yalnızca
   port halkaları, tıkanma simgesi ve rota boyunca akan esinti içindi. Nefes
   noktasal olmaktan çıkınca üçü de karşılıksız kaldı. */
function texGrain(){
  const S = 256, cv = makeCanvas(S,S), c = cv.getContext('2d');
  const img = c.createImageData(S,S), d = img.data;
  for(let i=0;i<S*S;i++){
    const v = Math.random()*46;
    d[i*4]=v; d[i*4+1]=v; d[i*4+2]=v; d[i*4+3]=255;
  }
  c.putImageData(img,0,0);
  return texFromCanvas(cv);
}

/* ---- açığa çıkan resim: sağlıklı doku + siklamen ---- */
const bgCanvas = makeCanvas(HW,HH);
/* GOAL-028: burada eskiden paintDuct() vardı — burun deliğinden ostiuma giden
   sabit rotayı dokuya bir parıltı olarak işliyordu. Nefes artık noktadan
   noktaya değil bütün boşluktan geçtiği için izlenecek tek bir rota da yok. */

/* =========================================================================
   BİLGİ LEVHASI (GOAL-017)

   Siklamen çiçeğinin yerini alan katman. Her gün, o günün mekanizmasını
   anlatan bir şema açığa çıkıyor: tıkalı geçit, ödem basıncı, daralan
   damarlar, koyu mukus, incelen salgı, drenaj, açılan ostium, dengelenen
   basınç, silyer taşıma, doz kalkanı,
   kronik destek, tam havalandırma.

   Hepsi aynı dili konuşuyor — ince ışıklı çizgi, günün paletinden tek vurgu
   rengi, altında kısa başlık — ki oyuncu hangi görsel olursa olsun onu "şema"
   olarak tanısın. Çizim -110..110 x -78..78 aralığında, merkezi taşınmış bir
   koordinat sisteminde yapılıyor.
   ========================================================================= */
function plateDrop(c,x,y,r){
  c.beginPath(); c.moveTo(x, y-r*1.7);
  c.bezierCurveTo(x+r*1.1, y-r*.2, x+r, y+r, x, y+r);
  c.bezierCurveTo(x-r, y+r, x-r*1.1, y-r*.2, x, y-r*1.7);
  c.closePath();
}
/* Düzgün daire yerine hafifçe bozulmuş, organik bir kapalı şekil. */
function bioBlob(c,x,y,r,wob,seed){
  const N = 10, pts = [];
  for(let i=0;i<N;i++){
    const a = i/N*Math.PI*2;
    const rr = r*(1 + Math.sin(a*3+seed)*wob*.5 + Math.cos(a*2-seed*1.7)*wob*.5);
    pts.push([x+Math.cos(a)*rr, y+Math.sin(a)*rr]);
  }
  c.beginPath();
  c.moveTo((pts[N-1][0]+pts[0][0])/2, (pts[N-1][1]+pts[0][1])/2);
  for(let i=0;i<N;i++){
    const p = pts[i], q = pts[(i+1)%N];
    c.quadraticCurveTo(p[0],p[1],(p[0]+q[0])/2,(p[1]+q[1])/2);
  }
  c.closePath();
}
function bioFill(c,x,y,r,c0,c1){
  const g = c.createRadialGradient(x-r*.3,y-r*.35,r*.1,x,y,r*1.15);
  g.addColorStop(0,c0); g.addColorStop(1,c1);
  c.fillStyle = g;
}
/* Dallanan damar — gerçek kılcal ağlar gibi her dalda incelerek. */
function vessel(c,x,y,a,len,w,depth){
  if(depth <= 0 || w < .7) return;
  const x2 = x+Math.cos(a)*len, y2 = y+Math.sin(a)*len;
  c.lineWidth = w;
  c.beginPath(); c.moveTo(x,y);
  c.quadraticCurveTo(x+Math.cos(a+.35)*len*.55, y+Math.sin(a+.35)*len*.55, x2, y2);
  c.stroke();
  vessel(c,x2,y2,a-rnd(.22,.62),len*.74,w*.68,depth-1);
  vessel(c,x2,y2,a+rnd(.22,.62),len*.74,w*.68,depth-1);
}
/* Silyalı yüzey: metakronal dalga hâlinde eğilen sil dizisi. */
function ciliaRow(c,y,amp,step,len,col,alpha){
  c.strokeStyle = col; c.globalAlpha = alpha; c.lineWidth = 2; c.lineCap = 'round';
  for(let x=-106;x<=106;x+=step){
    const b = Math.sin(x*.055)*amp;
    c.beginPath(); c.moveTo(x,y);
    c.quadraticCurveTo(x+b*.55, y-len*.55, x+b, y-len);
    c.stroke();
  }
  c.globalAlpha = 1;
}
/* Sıralı silindirik epitel hücreleri, çekirdekleriyle. */
function epithelium(c,y,h,col0,col1){
  for(let x=-108;x<106;x+=18){
    const g = c.createLinearGradient(0,y,0,y+h);
    g.addColorStop(0,col0); g.addColorStop(1,col1);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x+2,y+4); c.quadraticCurveTo(x+9,y-3, x+16,y+4);
    c.lineTo(x+16,y+h); c.lineTo(x+2,y+h);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(12,26,32,.5)';
    c.beginPath(); c.ellipse(x+9, y+h*.62, 3.6, 5, 0,0,7); c.fill();
  }
}
/* Hazır görseli levha kutusuna sığdırıp ortalar. */
function drawPlateImage(c, img){
  const s = Math.min(236/img.width, 176/img.height);
  const w = img.width*s, h = img.height*s;
  c.drawImage(img, -w/2, -h/2, w, h);
}

/* Günün konusunu doğal/bilimsel diliyle gösteren merkez görselleri.
   Şema oku, çarpı işareti, grafik ekseni yok: hepsi dokunun, hücrenin,
   damarın kendi biçimi. Çizim -110..110 x -78..78 aralığında. */
const PLATES = [
  /* 1 — Kanla dolu kılcal damar ağı */
  function(c){
    const g = c.createRadialGradient(0,0,10,0,0,120);
    g.addColorStop(0,'rgba(190,40,58,.30)'); g.addColorStop(1,'rgba(190,40,58,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0,0,120,0,7); c.fill();
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(206,52,70,.85)';
    vessel(c,-108,22,-.18,46,11,5);
    vessel(c,108,-30,Math.PI+.22,44,10,5);
    vessel(c,-18,84,-1.35,42,9,4);
    c.strokeStyle = 'rgba(255,152,152,.45)';
    vessel(c,-104,26,-.2,40,4,4);
    c.fillStyle = 'rgba(236,96,104,.5)';
    for(let i=0;i<26;i++){ const x = rnd(-100,100), y = rnd(-70,70);
      c.beginPath(); c.ellipse(x,y,5,3.4,rnd(0,3),0,7); c.fill(); }
  },
  /* 2 — Sıvı tutmuş, şişmiş mukoza hücreleri */
  function(c){
    c.fillStyle = 'rgba(120,190,205,.12)';
    c.beginPath(); c.arc(0,0,114,0,7); c.fill();
    for(let i=0;i<11;i++){
      const a = i/11*Math.PI*2 + .3, d = i < 4 ? 26 : 68;
      const x = Math.cos(a)*d, y = Math.sin(a)*d*.72, r = 25 + (i%3)*6;
      bioFill(c,x,y,r,'rgba(178,216,224,.44)','rgba(58,110,126,.30)');
      bioBlob(c,x,y,r,.16,i*1.7); c.fill();
      c.strokeStyle = 'rgba(200,234,240,.35)'; c.lineWidth = 1.6;
      bioBlob(c,x,y,r,.16,i*1.7); c.stroke();
      c.fillStyle = 'rgba(18,46,56,.45)';
      c.beginPath(); c.ellipse(x+r*.1,y+r*.05,r*.22,r*.18,0,0,7); c.fill();
    }
    c.fillStyle = 'rgba(150,226,236,.16)';
    for(let i=0;i<18;i++){ const x = rnd(-104,104), y = rnd(-70,70);
      c.beginPath(); c.arc(x,y,rnd(3,9),0,7); c.fill(); }
  },
  /* 3 — Ortasından daralan (kasılan) damarlar */
  function(c){
    for(let i=0;i<4;i++){
      const y = -48 + i*32, w0 = 15 - i*1.6, w1 = 4;
      const g = c.createLinearGradient(-110,0,110,0);
      g.addColorStop(0,'rgba(196,60,78,.62)');
      g.addColorStop(.5,'rgba(206,112,122,.42)');
      g.addColorStop(1,'rgba(190,152,152,.28)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-110,y-w0);
      c.bezierCurveTo(-30,y-w0, -18,y-w1, 0,y-w1);
      c.bezierCurveTo(30,y-w1, 50,y-w1*1.2, 110,y-w1*1.3);
      c.lineTo(110,y+w1*1.3);
      c.bezierCurveTo(50,y+w1*1.2, 30,y+w1, 0,y+w1);
      c.bezierCurveTo(-18,y+w1, -30,y+w0, -110,y+w0);
      c.closePath(); c.fill();
    }
  },
  /* 4 — Goblet hücreleri ve üstünde koyulaşmış mukus örtüsü */
  function(c){
    epithelium(c, 30, 48, 'rgba(150,196,200,.5)', 'rgba(46,92,102,.5)');
    for(let i=0;i<4;i++){
      const x = -76 + i*50;
      c.fillStyle = 'rgba(214,190,116,.6)';
      c.beginPath();
      c.moveTo(x-4,30); c.quadraticCurveTo(x-13,44, x-9,70);
      c.lineTo(x+9,70); c.quadraticCurveTo(x+13,44, x+4,30);
      c.closePath(); c.fill();
    }
    const g = c.createLinearGradient(0,-40,0,30);
    g.addColorStop(0,'rgba(206,182,102,.10)'); g.addColorStop(1,'rgba(196,168,88,.48)');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(-110,30);
    for(let x=-110;x<=110;x+=10) c.lineTo(x, -6 + Math.sin(x*.05)*10);
    c.lineTo(110,30); c.closePath(); c.fill();
    c.fillStyle = 'rgba(224,204,138,.55)';
    for(let i=0;i<5;i++){ plateDrop(c, -84+i*42, -30-((i%2)*14), 11); c.fill(); }
  },
  /* 4b — İncelen salgı: solda koyu, iri topaklar; sağa doğru uzayıp ince
     iplik ve küçük damlacıklara dönüşüyor (viskozitenin düşüşü) */
  function(c){
    const g = c.createLinearGradient(-110,0,110,0);
    g.addColorStop(0,'rgba(196,150,70,.20)'); g.addColorStop(1,'rgba(200,214,170,0)');
    c.fillStyle = g; c.fillRect(-110,-78,220,156);
    for(let i=0;i<5;i++){
      const y = -56 + i*28, r = 15 - (i%2)*3;
      bioFill(c,-74,y,r,'rgba(226,182,96,.62)','rgba(150,104,40,.46)');
      bioBlob(c,-74,y,r,.2,i*2.1); c.fill();
      c.strokeStyle = 'rgba(222,196,120,.42)'; c.lineCap = 'round';
      for(let k=0;k<3;k++){
        c.lineWidth = 5 - k*1.5;
        const y2 = y + (k-1)*7;
        c.beginPath(); c.moveTo(-62, y + (k-1)*3);
        c.bezierCurveTo(-30, y2 - 6, 4, y2 + 8, 40 + k*14, y2 + Math.sin(i+k)*6); c.stroke();
      }
    }
    c.fillStyle = 'rgba(214,228,184,.55)';
    for(let i=0;i<16;i++){ const x = 44 + (i%4)*17 + rnd(-4,4), y = -62 + (i>>2)*36 + rnd(-6,6);
      plateDrop(c, x, y, 3 + (i%3)); c.fill(); }
  },
  /* 5 — Katmanlar hâlinde süzülen mukus */
  function(c){
    for(let i=0;i<3;i++){
      const y = -34 + i*34, al = .26 - i*.05;
      const g = c.createLinearGradient(-110,y,110,y);
      g.addColorStop(0,'rgba(190,200,120,0)');
      g.addColorStop(.35,'rgba(198,206,132,'+al.toFixed(2)+')');
      g.addColorStop(1,'rgba(150,196,180,0)');
      c.fillStyle = g;
      c.beginPath(); c.moveTo(-110,y);
      for(let x=-110;x<=110;x+=10) c.lineTo(x, y + Math.sin(x*.045+i)*9);
      for(let x=110;x>=-110;x-=10) c.lineTo(x, y + 20 + Math.sin(x*.045+i)*9);
      c.closePath(); c.fill();
    }
    c.fillStyle = 'rgba(214,224,160,.5)';
    for(let i=0;i<7;i++){ plateDrop(c, -92+i*31, -52+(i%3)*40, 8); c.fill(); }
    c.strokeStyle = 'rgba(220,235,200,.22)'; c.lineWidth = 2; c.lineCap = 'round';
    for(let i=0;i<5;i++){ const y = -60+i*30;
      c.beginPath(); c.moveTo(-100,y);
      c.bezierCurveTo(-30,y+8, 30,y-8, 100,y+4); c.stroke(); }
  },
  /* 6 — Dokunun ortasında açılmış ostium ağzı */
  function(c){
    const g0 = c.createRadialGradient(0,0,26,0,0,106);
    g0.addColorStop(0,'rgba(190,120,118,.40)'); g0.addColorStop(1,'rgba(90,50,56,0)');
    c.fillStyle = g0; bioBlob(c,0,0,98,.10,1.2); c.fill();
    const g1 = c.createRadialGradient(0,0,2,0,0,44);
    g1.addColorStop(0,'rgba(4,12,16,.92)');
    g1.addColorStop(.7,'rgba(10,30,38,.72)');
    g1.addColorStop(1,'rgba(30,70,78,.22)');
    c.fillStyle = g1; bioBlob(c,0,0,42,.14,3.4); c.fill();
    c.strokeStyle = 'rgba(226,196,190,.5)'; c.lineWidth = 3;
    bioBlob(c,0,0,44,.14,3.4); c.stroke();
    const g2 = c.createRadialGradient(0,0,0,0,0,30);
    g2.addColorStop(0,'rgba(150,240,236,.28)'); g2.addColorStop(1,'rgba(150,240,236,0)');
    c.fillStyle = g2; c.beginPath(); c.arc(0,0,30,0,7); c.fill();
  },
  /* 6b — Basıncın dengelenmesi: sinüsün dibinde kalan salgı düz bir yüzeyle
     duruyor, ağızdan giren hava kabarcıklarla yukarı çıkıp boşluğu dolduruyor */
  function(c){
    c.save();
    bioBlob(c,0,2,92,.12,2.6); c.clip();
    const ga = c.createLinearGradient(0,-90,0,90);
    ga.addColorStop(0,'rgba(170,246,236,.26)'); ga.addColorStop(.55,'rgba(120,200,196,.08)'); ga.addColorStop(1,'rgba(0,0,0,0)');
    c.fillStyle = ga; c.fillRect(-110,-90,220,180);
    const gf = c.createLinearGradient(0,30,0,96);
    gf.addColorStop(0,'rgba(190,206,150,.50)'); gf.addColorStop(1,'rgba(120,140,90,.42)');
    c.fillStyle = gf; c.beginPath(); c.moveTo(-110,32);
    for(let x=-110;x<=110;x+=10) c.lineTo(x, 32 + Math.sin(x*.06)*1.6);
    c.lineTo(110,96); c.lineTo(-110,96); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(226,240,200,.55)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-110,32);
    for(let x=-110;x<=110;x+=10) c.lineTo(x, 32 + Math.sin(x*.06)*1.6);
    c.stroke();
    c.strokeStyle = 'rgba(206,252,246,.5)'; c.lineWidth = 1.4;
    for(let i=0;i<14;i++){ const x = -60 + (i%5)*28 + rnd(-6,6), y = 22 - (i/5|0)*28 - rnd(0,10), r = 3 + (i%4)*1.6;
      c.beginPath(); c.arc(x,y,r,0,7); c.stroke(); }
    c.restore();
    c.strokeStyle = 'rgba(226,190,184,.55)'; c.lineWidth = 3;
    bioBlob(c,0,2,92,.12,2.6); c.stroke();
    c.fillStyle = 'rgba(8,20,26,.9)'; c.beginPath(); c.ellipse(52,-70,10,6,-.5,0,7); c.fill();
  },
  /* 7 — Çalışan silyalı epitel yüzeyi */
  function(c){
    epithelium(c, 22, 56, 'rgba(158,206,206,.55)', 'rgba(40,92,100,.55)');
    ciliaRow(c, 22, 15, 7, 40, 'rgba(146,238,226,.75)', .75);
    ciliaRow(c, 24, 12, 11, 30, 'rgba(210,255,248,.5)', .5);
    const g = c.createLinearGradient(0,-44,0,-12);
    g.addColorStop(0,'rgba(190,240,236,.02)'); g.addColorStop(1,'rgba(190,240,236,.20)');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(-110,-12);
    for(let x=-110;x<=110;x+=10) c.lineTo(x, -34 + Math.sin(x*.05)*5);
    c.lineTo(110,-12); c.closePath(); c.fill();
  },
  /* 8 — Siklamen çiçeği (Cyclamen europaeum) */
  function(c){ drawPlateImage(c, flowerImg); },
  /* 9 — Sağlıklı mukoza kesiti: bazal tabaka, epitel, sil, ince mukus filmi */
  function(c){
    const gb = c.createLinearGradient(0,44,0,78);
    gb.addColorStop(0,'rgba(120,86,92,.55)'); gb.addColorStop(1,'rgba(60,40,46,.30)');
    c.fillStyle = gb; c.fillRect(-110,44,220,34);
    epithelium(c, 4, 44, 'rgba(172,216,212,.6)', 'rgba(48,104,108,.6)');
    ciliaRow(c, 4, 10, 8, 26, 'rgba(160,240,228,.6)', .6);
    const g = c.createLinearGradient(0,-38,0,-18);
    g.addColorStop(0,'rgba(200,246,244,.03)'); g.addColorStop(1,'rgba(200,246,244,.22)');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(-110,-18);
    for(let x=-110;x<=110;x+=10) c.lineTo(x, -36 + Math.sin(x*.045)*4);
    c.lineTo(110,-18); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(198,110,118,.35)'; c.lineCap = 'round';
    vessel(c,-92,70,-.35,24,4,3);
    vessel(c,72,72,Math.PI+.4,22,4,3);
  },
  /* 10 — Havayla dolmuş, ışık alan sinüs boşluğu */
  function(c){
    const gw = c.createLinearGradient(0,-80,0,80);
    gw.addColorStop(0,'rgba(150,110,108,.40)');
    gw.addColorStop(.5,'rgba(150,110,108,0)');
    gw.addColorStop(1,'rgba(150,110,108,.40)');
    c.fillStyle = gw; c.fillRect(-110,-80,220,160);
    const gl = c.createRadialGradient(-20,-10,6,0,0,114);
    gl.addColorStop(0,'rgba(180,250,244,.30)'); gl.addColorStop(1,'rgba(180,250,244,0)');
    c.fillStyle = gl; c.beginPath(); c.arc(0,0,114,0,7); c.fill();
    c.strokeStyle = 'rgba(196,250,244,.35)'; c.lineWidth = 2.4; c.lineCap = 'round';
    for(let i=0;i<5;i++){ const y = -44+i*22;
      c.beginPath(); c.moveTo(-102,y);
      c.bezierCurveTo(-30,y-10, 30,y+10, 102,y-4); c.stroke(); }
    c.strokeStyle = 'rgba(216,255,250,.35)'; c.lineWidth = 1.4;
    for(let i=0;i<24;i++){ const x = rnd(-100,100), y = rnd(-66,66);
      c.beginPath(); c.arc(x,y,rnd(3,9),0,7); c.stroke(); }
  }
];
const PLATE_CAPS = ['KILCAL DAMARLAR DOLU','ÖDEMLİ MUKOZA','DAMARLAR DARALIYOR',
  'KOYU MUKUS TABAKASI','SALGI İNCELİYOR','MUKUS AKIŞI','OSTIUM AÇIKLIĞI','HAVA DOLUYOR','SİLYALI EPİTEL',
  'SİKLAMEN EKSTRESİ','SAĞLIKLI MUKOZA','HAVALANAN SİNÜS'];

/* GOAL-019: levha önce kendi saydam tuvaline çiziliyor. Bunun iki faydası var:
   dokunun üstüne iki geçişle (normal + toplamalı) basılıp belirginleşebiliyor,
   ve aynı tuval bölüm girişindeki önizleme görseli olarak yeniden
   kullanılabiliyor — oyuncu günün görselini temizlemeyi beklemeden görüyor. */
const PLATE_W = 300, PLATE_H = 240;
const PLATE_K = Math.max(1, PX*(window.devicePixelRatio > 1 ? 1.5 : 1));   // levha tuvali, sahadaki büyütmeye yetecek kadar ince
const plateCv = makeCanvas(Math.round(PLATE_W*PLATE_K), Math.round(PLATE_H*PLATE_K)), plateCtx = plateCv.getContext('2d');
function renderPlateLayer(L){
  const c = plateCtx;
  c.setTransform(1,0,0,1,0,0);
  c.clearRect(0,0,plateCv.width,plateCv.height);
  c.setTransform(PLATE_K,0,0,PLATE_K,0,0);
  const custom = plateAssetImgs['day'+String(L.day).padStart(2,'0')];
  const plate = PLATES[L.theme];
  if(!custom && !plate) return false;
  c.save();
  c.translate(PLATE_W/2, PLATE_H/2);
  c.lineCap = 'round'; c.lineJoin = 'round'; c.globalAlpha = 1;
  if(custom) drawPlateImage(c, custom); else plate(c);
  c.restore();
  return true;
}
/* Bölüm giriş panelinde gösterilecek önizleme (koyu zeminli PNG veri-URL'i). */
function plateThumbURL(L){
  if(!renderPlateLayer(L)) return '';
  const cv = makeCanvas(plateCv.width, plateCv.height), c = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const g = c.createRadialGradient(W/2,H/2,0,W/2,H/2,W*.55);
  g.addColorStop(0,'#0d1f28'); g.addColorStop(1,'#050c12');
  c.fillStyle = g; c.fillRect(0,0,W,H);
  c.drawImage(plateCv,0,0);
  c.globalCompositeOperation = 'lighter'; c.globalAlpha = .45;
  c.drawImage(plateCv,0,0);
  try{ return cv.toDataURL('image/png'); }catch(e){ return ''; }
}

/* assets/bg/ içinden gelen hazır arka planı alanı kaplayacak şekilde basar. */
function drawCover(c, img){
  const s = Math.max(HW/img.width, HH/img.height);
  const w = img.width*s, h = img.height*s;
  c.drawImage(img, (HW-w)/2, (HH-h)/2, w, h);
}

/* =========================================================================
   İYİLEŞMİŞ SİNÜS SAHNESİ
   Temizledikçe altından çıkan resim: her bölgenin iyileşmiş hâlinin tahtayı
   baştan sona kaplayan tek parça illüstrasyonu (hi-bit: düz yüzeyler, birkaç
   ton basamağı, temiz çizgi). Ortak iskelet:
     - Boşluğun içi aydınlık, hava dolu (bölge rengine çalan ton, üstten ışık).
     - Duvarlar boyunca ince, pürüzsüz, pembe bir zar — kesitin
       biçimine kendiliğinden uyuyor (ızgaradaki duvara uzaklıktan).
     - Havada ışık huzmeleri, dipten tepeye yükselen hava akımları ve
       kabarcıklar.
   GOAL-040: zar artık et gibi değil. Yüzeydeki silyalar ("kıllı yapı"),
   damar çizgileri ve kıvrım dokusu kaldırıldı: sahne yalnızca "bir boşluğun
   içindeyim" hissini versin, itici bir organik ayrıntı göstermesin. Eski
   pembe renk kaldı (kullanıcı isteği), bant eskisinden biraz ince.
   Bölgeye özel: burunda konkaların arasından akan hava; maksillerde tavanda
   ışık saçan ostium ağzı ve tabanda diş kökleri; etmoidde ince duvarlı bal
   peteği hücreleri ve parlayan ağızları; frontalde güçlü ışık ve dipteki
   kanaldan yükselen hava. Hepsi deterministik (gün tohumu): aynı gün hep aynı
   resim. Öğeler kesitin ölçülen noktalarına (tepe, dip) oturuyor ki ostium ya
   da diş kökleri kemiğin arkasında kalmasın. Gün ilerledikçe sahne aydınlanıyor
   (tedavi yayı). assets/bg/ içinde hazır görsel varsa sahnenin yerine o basılıyor.
   ========================================================================= */
const SCENE_AIR = {   // dipten tepeye
  nasal:     ['#0c1d27','#15384a','#2c6474','#6aa9ad','#d9f1ea'],
  maxillary: ['#120f2a','#262457','#47488f','#8a88c8','#e6e2fb'],
  ethmoid:   ['#08182c','#123762','#2a64a0','#6aa2d6','#dcecfb'],
  frontal:   ['#0a1f1a','#13453a','#2a7c63','#72c49f','#e2f8ea']
};
const SCENE_MUC = ['#4a1d2c','#8a3a4d','#c9677a','#ec9aa6'].map(hex2rgb);   // duvardan yüzeye: eski pembe zar
const SCENE_MUC_HI = hex2rgb('#ffe0e4');
const sceneDist = new Float32Array(GW*GH);
const sceneMask = makeCanvas(HW,HH), sceneOv = makeCanvas(HW,HH);
/* Izgarada duvara (boşluk dışı hücre) uzaklık, hücre biriminde — iki geçişli
   chamfer. Duvardaki zar bu alanı izliyor. */
function sceneDistance(){
  const D = sceneDist, INF = 1e6, R2 = Math.SQRT2;
  for(let i=0;i<GW*GH;i++) D[i] = cavity[i] ? INF : 0;
  for(let y=0;y<GH;y++) for(let x=0;x<GW;x++){
    const i = y*GW+x; if(!D[i]) continue;
    let v = D[i];
    if(x>0) v = Math.min(v, D[i-1]+1);
    if(y>0){ v = Math.min(v, D[i-GW]+1); if(x>0) v = Math.min(v, D[i-GW-1]+R2); if(x<GW-1) v = Math.min(v, D[i-GW+1]+R2); }
    D[i] = v;
  }
  for(let y=GH-1;y>=0;y--) for(let x=GW-1;x>=0;x--){
    const i = y*GW+x; if(!D[i]) continue;
    let v = D[i];
    if(x<GW-1) v = Math.min(v, D[i+1]+1);
    if(y<GH-1){ v = Math.min(v, D[i+GW]+1); if(x<GW-1) v = Math.min(v, D[i+GW+1]+R2); if(x>0) v = Math.min(v, D[i+GW-1]+R2); }
    D[i] = v;
  }
  /* GOAL-040: üç geçiş 3x3 kutu bulanıklığı — chamfer alanının eş-uzaklık
     çizgileri ızgarada köşeli; zarın iç kenarı basamak basamak görünüyordu.
     Duvar hücreleri 0'da kalıyor, yalnızca boşluğun içi yumuşuyor. */
  const tmp = new Float32Array(GW*GH);
  for(let pass=0; pass<3; pass++){
    for(let y=1;y<GH-1;y++) for(let x=1;x<GW-1;x++){
      const i = y*GW+x; if(!D[i]){ tmp[i] = 0; continue; }
      let sum = 0;
      for(let dy=-GW; dy<=GW; dy+=GW) sum += D[i+dy-1] + D[i+dy] + D[i+dy+1];
      tmp[i] = Math.max(.5, sum/9);
    }
    for(let y=1;y<GH-1;y++) for(let x=1;x<GW-1;x++){ const i = y*GW+x; if(D[i]) D[i] = tmp[i]; }
  }
}
/* Duvara uzaklık, ızgara biriminde herhangi bir noktada (hücre merkezleri arası bilineer) */
function distAt(gx, gy){
  const x = clamp(gx - .5, 0, GW-1.001), y = clamp(gy - .5, 0, GH-1.001), ix = x|0, iy = y|0, tx = x-ix, ty = y-iy, i = iy*GW+ix;
  const a = sceneDist[i], b = sceneDist[i+1], c = sceneDist[i+GW], d = sceneDist[i+GW+1];
  return (a + (b-a)*tx)*(1-ty) + (c + (d-c)*tx)*ty;
}
/* Kesitin ölçülen noktaları: tepe (ışığın girdiği yer) ve dip (havanın girdiği yer) */
function sceneAnchors(){
  const bb = cavBB;
  const rowSpan = y => { let a = GW, b = -1; for(let x=0;x<GW;x++) if(cavity[y*GW+x]){ if(x < a) a = x; b = x; } return b < 0 ? null : [a, b+1]; };
  const mid = (y0, y1) => { let s = 0, n = 0; for(let y=y0;y<y1;y++){ const r = rowSpan(y); if(r){ s += (r[0]+r[1])/2; n++; } } return n ? s/n : (bb.x0+bb.x1)/2; };
  return { tx:mid(bb.y0, bb.y0+3), ty:bb.y0, bx:mid(bb.y1-3, bb.y1), by:bb.y1, rowSpan,
           x0:bb.x0, x1:bb.x1, y0:bb.y0, y1:bb.y1, w:bb.x1-bb.x0, h:bb.y1-bb.y0 };
}
function paintHealthy(L){
  const c = bgCanvas.getContext('2d');
  c.setTransform(1,0,0,1,0,0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  // GOAL-016: bölüme özel hazır arka plan varsa sahnenin yerine geçer
  const custom = bgAssetImgs['day'+String(L.day).padStart(2,'0')] || bgAssetImgs[L.cav];
  if(custom){ c.fillStyle = '#081118'; c.fillRect(0,0,HW,HH); drawCover(c, custom); return; }
  sceneDistance();
  const A = sceneAnchors(), rg = L.region;
  const arc = clamp((L.day-1)/Math.max(1, LEVELS.length-1), 0, 1), bright = .84 + .2*arc;
  const air = (SCENE_AIR[rg] || SCENE_AIR.nasal).map(hex2rgb);
  const T = rg === 'ethmoid' ? 2.6 : 3.4;                       // zar kalınlığı (hücre) — eskisinden (3.2/4.4) biraz ince
  const n1 = fbmHi(46, L.day*131+7, 3);
  const img = c.createImageData(HW,HH), d = img.data;
  const mk = sceneMask.getContext('2d'), mimg = mk.createImageData(HW,HH), md = mimg.data;
  const col = [0,0,0], ac = [0,0,0];
  const gsx = A.tx, gsy = A.ty - 2, gs2 = Math.pow(Math.max(A.w, A.h)*.75, 2)*.36;   // ışık kaynağı
  for(let py=0; py<HH; py++){
    const gy = (py+.5)/SC, v = clamp((A.y1 - gy)/Math.max(1, A.h), 0, 1);   // 0 dip, 1 tepe
    const ly = gy - gsy;
    for(let px=0; px<HW; px++){
      const i = py*HW+px, gx = (px+.5)/SC;
      const dist = distAt(gx, gy) - .5, e = T;                    // sabit kalınlık: iç kenar düzgün bir eğri
      // hava: dipten tepeye aydınlanıyor, tepedeki kaynaktan ışık, zarın dibinde hafif gölge
      const lx = gx - gsx, glow = Math.exp(-(lx*lx + ly*ly)/gs2);
      const ao = 1 - sstep(e, e + 3.5, dist);
      rampTo(air, (.14 + v*.48 + glow*.28 + (n1[i]-.5)*.12 - ao*.10)*bright, ac);
      // zar: duvardan yüzeye koyudan açığa pembe, pürüzsüz; yüzeyinde tek
      // ince ışık çizgisi (damar, kıvrım, sil yok)
      const m = clamp(dist/e, 0, 1);
      rampTo(SCENE_MUC, Math.pow(m, .85), col);
      mixTo(col, SCENE_MUC_HI, sstep(.78,.95,m)*(1 - sstep(.95,1,m))*.6 + glow*m*.12);
      const aw = sstep(e - .3, e + .3, dist);                   // havanın payı
      mixTo(col, ac, aw);
      d[i*4] = col[0]; d[i*4+1] = col[1]; d[i*4+2] = col[2]; d[i*4+3] = 255;
      md[i*4+3] = aw*255;
    }
  }
  c.putImageData(img, 0, 0);
  mk.putImageData(mimg, 0, 0);
  // vektör katmanlar (gün tohumlu)
  let sd = (L.day*2654435761 + 97)>>>0;
  const R = () => (sd = (sd*1664525 + 1013904223)>>>0)/4294967296;
  sceneLayer(c, o => sceneRays(o, A, R, rg === 'frontal' ? 1.25 : 1), true, 'lighter');
  if(rg === 'ethmoid') sceneLayer(c, o => sceneHoneycomb(o, A, R), true);
  sceneLayer(c, o => sceneAirflow(o, A, R, rg), true, 'lighter');
  sceneLayer(c, o => sceneBubbles(o, A, R, rg === 'frontal' ? 40 : 24), true);
  if(rg === 'maxillary'){ sceneLayer(c, o => sceneTeeth(o, A), false); sceneLayer(c, o => sceneOstium(o, A), false, 'lighter'); }
  if(rg === 'ethmoid') sceneLayer(c, o => sceneOpenings(o, A, R), true);
  if(rg === 'frontal') sceneLayer(c, o => sceneDuct(o, A), false, 'lighter');
}
/* Bir vektör katmanı: ayrı tuvalde (ızgara biriminde) çiziliyor, istenirse
   yalnızca havaya kırpılıyor (mukozanın üstüne taşmasın), sonra zemine basılıyor. */
function sceneLayer(c, draw, airOnly, blend){
  const o = sceneOv.getContext('2d');
  o.setTransform(1,0,0,1,0,0); o.globalCompositeOperation = 'source-over'; o.globalAlpha = 1;
  o.clearRect(0,0,HW,HH);
  o.setTransform(SC,0,0,SC,0,0); o.lineCap = 'round'; o.lineJoin = 'round';
  o.save(); draw(o); o.restore();
  if(airOnly){
    o.setTransform(1,0,0,1,0,0); o.globalCompositeOperation = 'destination-in';
    o.drawImage(sceneMask, 0, 0); o.globalCompositeOperation = 'source-over';
  }
  c.save(); c.setTransform(1,0,0,1,0,0); c.globalCompositeOperation = blend || 'source-over';
  c.drawImage(sceneOv, 0, 0); c.restore();
}
/* Tepeden yelpaze gibi inen ışık huzmeleri */
function sceneRays(o, A, R, k){
  const ox = A.tx, oy = A.ty - 3, len = A.h*1.05, n = k > 1 ? 9 : 7;
  for(let j=0;j<n;j++){
    const a = (j/(n-1) - .5)*1.05 + (R()-.5)*.12, w = .04 + R()*.05;
    const g = o.createLinearGradient(ox, oy, ox + Math.sin(a)*len, oy + Math.cos(a)*len);
    g.addColorStop(0, 'rgba(255,250,235,'+(.12*k).toFixed(3)+')');
    g.addColorStop(.6, 'rgba(255,250,235,'+(.05*k).toFixed(3)+')');
    g.addColorStop(1, 'rgba(255,250,235,0)');
    o.fillStyle = g; o.beginPath(); o.moveTo(ox, oy);
    o.lineTo(ox + Math.sin(a - w)*len, oy + Math.cos(a - w)*len);
    o.lineTo(ox + Math.sin(a + w)*len, oy + Math.cos(a + w)*len); o.closePath(); o.fill();
  }
  const g = o.createRadialGradient(ox, oy+2, 0, ox, oy+2, Math.max(8, A.w*.45));
  g.addColorStop(0, 'rgba(255,248,230,'+(.16*k).toFixed(3)+')'); g.addColorStop(1, 'rgba(255,248,230,0)');
  o.fillStyle = g; o.fillRect(A.x0-6, A.y0-6, A.w+12, A.h+12);
}
/* Dipten (havanın girdiği yer) tepeye yükselen hava akımları */
function sceneAirflow(o, A, R, rg){
  const n = rg === 'frontal' ? 11 : rg === 'nasal' ? 10 : 8;
  for(let k=0;k<n;k++){
    const f = k/(n-1) - .5, x0 = A.bx + f*A.w*.55, x1 = A.tx + f*A.w*.35, ph = R()*6, fr = 1.3 + R()*.5;
    const pts = [];
    for(let j=0;j<=7;j++){
      const t = j/7, y = lerp(A.y1 + 1, A.y0 - 1, t);
      pts.push([lerp(x0, x1, sstep(0,1,t)) + Math.sin(t*Math.PI*fr + ph)*A.w*.06*(1 - Math.abs(f)), y]);
    }
    const a = .10 + R()*.12, g = o.createLinearGradient(0, A.y1, 0, A.y0);
    g.addColorStop(0, 'rgba(200,255,248,0)'); g.addColorStop(.3, 'rgba(200,255,248,'+a.toFixed(3)+')');
    g.addColorStop(.8, 'rgba(230,255,252,'+(a*.8).toFixed(3)+')'); g.addColorStop(1, 'rgba(230,255,252,0)');
    o.strokeStyle = g; o.lineWidth = .35 + R()*.7;
    o.beginPath(); splinePath(o, pts, false); o.stroke();
  }
}
/* Havada süzülen kabarcıklar (parlak kenar + küçük ışık) */
function sceneBubbles(o, A, R, n){
  for(let k=0;k<n;k++){
    const x = A.x0 + R()*A.w, y = A.y0 + R()*A.h, r = .35 + R()*R()*1.4;
    o.fillStyle = 'rgba(220,255,250,.10)'; o.beginPath(); o.arc(x, y, r, 0, 7); o.fill();
    o.strokeStyle = 'rgba(230,255,252,.45)'; o.lineWidth = .14; o.stroke();
    o.fillStyle = 'rgba(255,255,255,.75)'; o.beginPath(); o.arc(x - r*.35, y - r*.35, r*.22, 0, 7); o.fill();
  }
}
/* Maksiller: tavanda ışık saçan ostium ağzı */
function sceneOstium(o, A){
  const x = A.tx, y = A.ty + 1.8, r = 2.6;
  const g = o.createRadialGradient(x, y, 0, x, y, r*6);
  g.addColorStop(0, 'rgba(255,250,230,.34)'); g.addColorStop(.35, 'rgba(255,240,210,.12)'); g.addColorStop(1, 'rgba(255,240,210,0)');
  o.fillStyle = g; o.beginPath(); o.arc(x, y, r*6, 0, 7); o.fill();
  o.fillStyle = 'rgba(255,250,236,.55)'; o.beginPath(); o.ellipse(x, y, r, r*.55, 0, 0, 7); o.fill();
  o.strokeStyle = 'rgba(255,214,222,.8)'; o.lineWidth = .3; o.stroke();
}
/* Maksiller: tabanın hemen altındaki diş kökleri — mukozanın altından
   kabaran yuvarlak tepecikler (her biri iki köklü bir azı dişi gibi) */
function sceneTeeth(o, A){
  const yy = Math.max(A.y0, A.y1 - 6), sp = A.rowSpan(yy);
  if(!sp) return;
  const w = sp[1] - sp[0], n = w > 26 ? 3 : w > 14 ? 2 : 1;
  for(let k=0;k<n;k++){
    const x = sp[0] + w*(k+1)/(n+1), top = A.y1 - 4.2 + (k%2)*.6, bw = 3.2;
    const g = o.createLinearGradient(0, top, 0, A.y1 + 1);
    g.addColorStop(0, 'rgba(246,234,214,.80)'); g.addColorStop(1, 'rgba(214,188,160,.55)');
    o.fillStyle = g;
    o.beginPath();                                   // iki tepecik
    o.moveTo(x - bw, A.y1 + 2);
    o.bezierCurveTo(x - bw, top - .2, x - .4, top - .2, x, top + 1.1);
    o.bezierCurveTo(x + .4, top - .2, x + bw, top - .2, x + bw, A.y1 + 2);
    o.closePath(); o.fill();
    o.fillStyle = 'rgba(236,154,166,.42)';           // üstteki mukoza örtüsü
    o.fill();
    o.strokeStyle = 'rgba(255,236,238,.6)'; o.lineWidth = .22;   // nemli üst kenar
    o.beginPath(); o.moveTo(x - bw*.8, top + 1.4); o.bezierCurveTo(x - bw*.7, top, x - .5, top, x - .15, top + .9); o.stroke();
  }
}
/* Etmoid: bal peteği — ince, ışık geçiren hücre duvarları */
function sceneHoneycomb(o, A, R){
  const s = 5.2, hh = s*Math.sqrt(3)/2;
  o.lineWidth = .22;
  for(let col=-1; col*s*1.5 < A.w + s*2; col++){
    for(let row=-1; row*hh*2 < A.h + hh*3; row++){
      const cx = A.x0 + col*s*1.5, cy = A.y0 + row*hh*2 + (col & 1 ? hh : 0);
      o.beginPath();
      for(let k=0;k<6;k++){ const a = k/6*Math.PI*2; const px = cx + Math.cos(a)*s*.94, py = cy + Math.sin(a)*s*.94;
        if(k) o.lineTo(px, py); else o.moveTo(px, py); }
      o.closePath();
      const g = o.createRadialGradient(cx, cy - s*.3, 0, cx, cy, s);
      g.addColorStop(0, 'rgba(225,240,255,'+(.04 + R()*.07).toFixed(3)+')'); g.addColorStop(1, 'rgba(225,240,255,0)');
      o.fillStyle = g; o.fill();
      o.strokeStyle = 'rgba(225,240,255,.30)'; o.stroke();
    }
  }
}
/* Etmoid: hücrelerin açılan ağızları (turkuaz ışıklı) */
function sceneOpenings(o, A, R){
  for(let k=0;k<9;k++){
    const x = A.x0 + (.12 + R()*.76)*A.w, y = A.y0 + (.1 + R()*.8)*A.h, r = .9 + R()*.8;
    const g = o.createRadialGradient(x, y, 0, x, y, r*3.2);
    g.addColorStop(0, 'rgba(120,250,236,.45)'); g.addColorStop(1, 'rgba(120,250,236,0)');
    o.fillStyle = g; o.beginPath(); o.arc(x, y, r*3.2, 0, 7); o.fill();
    o.fillStyle = 'rgba(8,30,52,.75)'; o.beginPath(); o.ellipse(x, y, r, r*.7, 0, 0, 7); o.fill();
    o.strokeStyle = 'rgba(150,255,240,.85)'; o.lineWidth = .22; o.stroke();
  }
}
/* Frontal: dipteki uzun kanaldan (frontal resess) yükselen parlak hava */
function sceneDuct(o, A){
  const x = A.bx, y = A.by - 1.5;
  const g = o.createRadialGradient(x, y, 0, x, y, 9);
  g.addColorStop(0, 'rgba(210,255,240,.45)'); g.addColorStop(1, 'rgba(210,255,240,0)');
  o.fillStyle = g; o.beginPath(); o.arc(x, y, 9, 0, 7); o.fill();
}

/* ---- hastalıklı doku rengi (alfa ayrı hesaplanır) ---- */
const tissueRGB = new Uint8ClampedArray(HW*HH*3);
function paintTissue(L){
  const cols = L.pal.map(hex2rgb);
  const stops = [cols[0], cols[1], cols[2], cols[3]];
  const n1 = fbmHi(42,L.day*977+31,3);
  const n2 = fbmHi(11,L.day*613+7,3);
  const col = [0,0,0];
  for(let y=0;y<HH;y++) for(let x=0;x<HW;x++){
    const i = y*HW+x;
    const core = clamp(1 - Math.hypot((x/HW-.5)*1.9,(y/HH-.5)*1.9), 0, 1);
    const ridged = Math.pow(1-Math.abs(n2[i]*2-1), 2.4);      // damar filamentleri
    rampTo(stops, n1[i]*.72 + core*.34 - .12, col);
    mixTo(col, cols[3], ridged*.55*(.35+core*.65));            // parlayan damarlar
    const v = n1[i];
    mixTo(col, cols[0], v*v*v*.5);                             // koyu yarıklar
    tissueRGB[i*3]=col[0]; tissueRGB[i*3+1]=col[1]; tissueRGB[i*3+2]=col[2];
  }
}

/* =========================================================================
   4b. BURUN BOŞLUĞU (GOAL-015)

   Oyun alanı artık dikdörtgen değil. Her gün, burnun/sinüslerin bir koronal
   kesiti açılıyor: içi = oynanabilir mukoza (cavity=1), dışı = kemik/kıkırdak
   duvar (kalıcı FILL — oyuncunun üstünde yürüdüğü güvenli zemin).

   Şekiller canvas ile, ızgara biriminde çiziliyor; beyaz = boşluk, siyah =
   duvar. Yeni bir kesit eklemek birkaç satırlık path işi.

   GOAL-028: kesitlerin eskiden iki portu vardı (burun deliği / ostium) ve
   nefes o iki nokta arasında yol arıyordu. Artık port yok: nefes boşluğun
   tamamından, aşağıdan yukarı geçmeye çalışıyor (bkz. computeBreath). Yani
   hedef yüzdesi "ne kadar temizledin"i, nefes de "dokuyu ne kadar açtın"ı
   ölçüyor. Kesit tanımlarındaki in/out alanları artık okunmuyor.
   ========================================================================= */
const cavity  = new Uint8Array(GW*GH);   // 1 = oynanabilir boşluk
const cavSoft = new Float32Array(HW*HH); // görsel duvar için yumuşatılmış maske
/* GOAL-033: kesitin gerçek (vektör) konturundan türeyen kenar yumuşatmalı
   kapsama. Hastalıklı doku ve sınır ışıması boşluğun kenarında artık ızgara
   hücrelerini değil bunu izliyor — kenarlar merdiven basamağı gibi değil,
   çizildikleri eğri kadar düzgün. */
const cavM = new Float32Array(HW*HH);
let cavCount = 0, cavCX = GW/2, cavCY = GH/2;
/* GOAL-029: nefesin yayılması için çalışma dizileri (bkz. computeBreath). */
const bfsQ    = new Int32Array(GW*GH);
const bfsSeen = new Uint8Array(GW*GH);

/* GOAL-030 — KESİT ÇİZİM YARDIMCILARI
   Nokta dizisinden geçen yumuşak eğri (Catmull-Rom → bezier).
   Anatomik hatlar artık elips ve dikdörtgenden kurulmuyor: kemik de mukoza da
   hiçbir yerde düz çizgi ya da tam daire değil. Hatlar gerçek koronal
   kesitlerdeki gibi elle yerleştirilmiş noktalardan geçiyor. */
function splinePath(c, pts, closed){
  const n = pts.length;
  const P = i => closed ? pts[(i+n)%n] : pts[i<0?0:(i>n-1?n-1:i)];
  c.moveTo(pts[0][0], pts[0][1]);
  const segs = closed ? n : n-1;
  for(let i=0;i<segs;i++){
    const p0 = P(i-1), p1 = P(i), p2 = P(i+1), p3 = P(i+2);
    c.bezierCurveTo(p1[0]+(p2[0]-p0[0])/6, p1[1]+(p2[1]-p0[1])/6,
                    p2[0]-(p3[0]-p1[0])/6, p2[1]-(p3[1]-p1[1])/6, p2[0], p2[1]);
  }
  if(closed) c.closePath();
}
function blob(c, pts){ c.beginPath(); splinePath(c, pts, true); c.fill(); }
/* İnce kemik lamel ya da dar kanal: o anki dolgu rengiyle kalın bir çizgi.
   Siyahken septum/unsinat/hücre bölmesi, beyazken ostium ve resess. */
function lamella(c, pts, w){
  c.save(); c.strokeStyle = c.fillStyle; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); splinePath(c, pts, false); c.stroke(); c.restore();
}
/* Kemik dokusuna işlenen komşu yapılar (bkz. paintWalls). Tahta tek başına
   bir boşluk; yanında göz çukuru ya da diş kökleri durunca oyuncu yüzün
   neresinde olduğunu ilk bakışta okuyor. Hepsi kısık alfalı, oynanabilir
   alanın dışında kalıyor. */
function orbitMark(c, cx, cy, rx, ry, u){
  u = u || 1;                               // bir ızgara hücresi, çizim biriminde
  c.save();
  c.translate(cx, cy); c.scale(rx, ry);
  const g = c.createRadialGradient(0,-.12,0, 0,0,1);
  g.addColorStop(0,'rgba(10,5,9,.60)'); g.addColorStop(.7,'rgba(16,8,13,.40)'); g.addColorStop(1,'rgba(16,8,13,0)');
  c.fillStyle = g; c.beginPath(); c.arc(0,0,1,0,7); c.fill();
  c.restore();
  c.save(); c.lineCap = 'round';
  c.strokeStyle = 'rgba(226,182,170,.22)'; c.lineWidth = 1.3*u;        // kortikal kenar
  c.beginPath(); c.ellipse(cx, cy, rx*.86, ry*.86, 0, Math.PI*1.08, Math.PI*1.92); c.stroke();
  c.strokeStyle = 'rgba(226,182,170,.06)'; c.lineWidth = .9*u;
  c.beginPath(); c.ellipse(cx, cy, rx*.86, ry*.86, 0, Math.PI*.12, Math.PI*.88); c.stroke();
  c.restore();
}

/* =========================================================================
   GOAL-034/036 — TEK ANATOMİ, GÖRSELDEN İZLENMİŞ
   Giriş sahnesindeki yüz haritası ile bölüm tahtaları AYNI çizimden geliyor:
   harita bu tanımı olduğu gibi çiziyor, her bölümün tahtası da aynı çizimin
   o sinüsü içeren kısmı; dalış tahtanın gerçek yerine iniyor.

   GOAL-036: biçimler artık benim çizimim değil — assets/sinuzit.jfif'teki
   önden görünümün konturları, görsel üzerinde piksel piksel izlendi. Bu
   yüzden aşağıdaki sayılar GÖRSEL PİKSELİ (668x459'luk dosyada x,y); IMG()
   onları yüz uzayına çeviriyor (gözler görselde (118,200) ve (218,200),
   yüz uzayında x ±0.375, y -0.272). Görsel değişirse konturlar aynı
   yöntemle yeniden izlenebilir. Sağ ve sol ayna değil: görseldeki iki
   taraf gerçekten farklı, tahtalar da öyle.
   ========================================================================= */
const IMG = p => [(p[0] - 168.5)/133.3, (p[1] - 200)/133.3 - .272];
const imgPts = pts => pts.map(IMG);
/* Görseldeki renkler: her sinüs kendi rengiyle tanınıyor. */
const ANAT_COL = { frontal:[112,200,96], ethmoid:[98,152,226], maxillary:[160,114,218], nasal:[236,152,164] };
/* Kapalı biçimler: boşluğun kendisi. */
const ANAT = {
  frontal: {
    sol: imgPts([[164.5,162],[160,159.6],[152,160.2],[144,163.5],[136,165.2],[130,168],[127.5,172.3],[132,175],
                 [138,178],[143,182],[147,186],[150,190],[153,194],[157,196.8],[162,197.8],[164.8,196.5],[165,180]]),
    sag: imgPts([[170.5,161],[174,159],[178,159.8],[184,162.8],[190,165],[196,167],[201,169.5],[205,172.5],[203,175],
                 [198,178],[192,182],[186,186],[181,190.5],[177,194.5],[174,197.4],[171,197.8],[170.4,190],[170.4,170]]) },
  /* GOAL-039: etmoid tek parça bir petek silüeti — içteki hücre bölmeleri
     yerine dış kenardaki üç hücre kabarıklığı. Boyunlar enin ~%20'si kadar:
     petek okunuyor ama oynanışta cep kapatmıyor. */
  ethmoid: {
    sol: imgPts([[152,199],[158,198.5],[161.5,199.5],[161.5,215],[161.5,230],[160.5,237],[157,240.5],[152,240],
                 [148,237],[146,232],[146.5,227.5],[148.5,224.5],[146,220.5],[145,215.5],[146,212],[148,210],
                 [146.5,206.5],[147,202.5],[149.5,200]]),
    sag: imgPts([[179,198.5],[183,197.5],[187,199.5],[189,203],[189,208],[187.5,211.5],[189.5,215],[191.5,219],
                 [190.5,222.5],[192.5,225.5],[192.5,229],[190,232],[185.5,233.5],[181,232],[179,228],[179,215],[179,205]]) },
  /* Burun boşluğunun iki yarımı; aradaki boşluk septum. Üstte gözlerin
     arasına uzanan dar kolon, altta birleştikleri taban. */
  nasal: {
    sol: imgPts([[163,196.5],[163,226],[157,227.5],[153,232],[150,240],[148.5,248],[147,256],[146.5,262],[147.5,268],[150,272],
                 [155,275],[162,276.3],[170.5,276.6],[170.5,272],[169.5,269.5],[167,267],[165.2,262],[165.2,230],[165.2,196.5]]),
    sag: imgPts([[176,196.5],[176,226],[182,227.5],[186,232],[188.5,240],[190,248],[190.5,256],[191,262],[190,268],[187.5,272],
                 [183,275],[176,276.3],[167.5,276.6],[167.5,272],[168.5,269.5],[171,267],[172.8,262],[172.8,230],[172.8,196.5]]) },
  maxillary: {
    sol: imgPts([[113,228.5],[118,225],[124,223],[130,222],[137,222],[142,223],[145,226.5],[146.5,232],[146,240],[144.5,248],
                 [143.5,256],[142,262],[139.5,267],[134,271],[127,272],[120,270],[115,266],[111.5,259],[110,251],[109.8,243],[110.5,235]]),
    sag: imgPts([[192,227],[194.5,222.5],[200,221],[206,221.5],[212,223.5],[217.5,227.5],[221.5,233],[224,240],[225,248],
                 [224,256],[221,262],[216,266.5],[210,268.5],[204,268.5],[198,266],[195.5,261.5],[193.5,255],[192.5,248],[192,240],[192,232]]) }
};
/* Kanallar ve ağızlar — boşluğun parçası: [bölge, taraf, çizgi, kalınlık].
   Maksiller kesenin ağzı burun boşluğuna, etmoid hücrelerinin ağızları
   burnun üst kolonuna açılıyor (görselde ince, haritada da ince). */
const ANAT_DUCTS = [
  ['maxillary','sol', imgPts([[143.5,231],[149.5,232.5],[155,234]]), .022],
  ['maxillary','sag', imgPts([[192,231],[187,232.5],[183.5,234]]), .022],
  ['ethmoid','sol', imgPts([[160,205],[164.5,205]]), .022], ['ethmoid','sol', imgPts([[160,218],[164.5,218]]), .022],
  ['ethmoid','sol', imgPts([[160,231],[164.5,231]]), .022],
  ['ethmoid','sag', imgPts([[180.5,205],[176,205]]), .022], ['ethmoid','sag', imgPts([[180.5,219],[176,219]]), .022],
  ['ethmoid','sag', imgPts([[180.5,228],[176,228]]), .022]
];
/* GOAL-039: tahtaların içi tek parça. Burun boşluğundaki konka sarmalları,
   etmoid hücre bölmeleri, polip ve kist lekeleri kaldırıldı — oynanışta
   alanı cep cep bölüyor, kesimleri kilitliyordu ("burnun içi tek parça olsun,
   içerideki çizgi gibi şeyler olmasın"). Harita tahtayla aynı tanımdan
   çizildiği için orada da yoklar: dış hatlar sinüsü tanıtmaya yetiyor. */
const sideKey = sg => sg < 0 ? 'sol' : 'sag';
/* Her bölümün tahtası: hangi yapı, üstten kırpılıyor mu. Pencere bu yapının
   sınır kutusu. Burun boşluğunun gözlerin arasına uzanan dar kolonu tepeden
   kırpılıyor — tahtayı boyuna uzatıp alanı daraltıyordu. GOAL-039: etmoid
   artık burnun kolonuyla birlikte değil, yalnızca kendi dış hattıyla —
   hücreler, kanallar ve kolon tahtayı birbirine dar boyunlarla bağlı odalara
   bölüyordu; birebir görsel değil genel biçim yeterli. */
const BOARDS = {
  nasal:     { parts:['nasal'], clipY0:IMG([0,224])[1] },
  maxillary: { parts:['maxillary'] },
  ethmoid:   { parts:['ethmoid'] },
  frontal:   { parts:['frontal'] }
};
/* Günün tarafları: tek taraf ya da iki taraf birlikte (L.pair) */
const daySides = L => L.pair ? ['sol','sag'] : [L.side];
/* GOAL-039 — İKİ TARAF BİRLİKTE
   Sol ve sağ sinüs orta hatta doğru kaydırılıp üst üste bindiriliyor; iki
   biçim kaynaşıp tek parça, geniş bir tahta oluyor. Kayma yüz biriminde, her
   taraf için ayrı işaretle (sol sağa, sağ sola). Miktar: iki biçimin orta
   hattaki en iç noktaları arasındaki açığın yarısı + bindirme payı (en dar
   biçimin eninin PAIR_OVERLAP katı). Pay, birleşim yerinde dar bir boğaz
   kalmasın diye bölgeye göre ayarlı; burunda septum aralığını da kapatıyor. */
const PAIR_OVERLAP = { nasal:.28, maxillary:.22, ethmoid:.30, frontal:.16 };
function pairShift(region){
  const S = ANAT[region].sol, D = ANAT[region].sag, xs = P => P.map(p => p[0]);
  const gap = Math.min(...xs(D)) - Math.max(...xs(S));
  const w = Math.min(Math.max(...xs(S)) - Math.min(...xs(S)), Math.max(...xs(D)) - Math.min(...xs(D)));
  return gap/2 + PAIR_OVERLAP[region]*w;
}
/* Bir tarafın tahtadaki yatay kayması (tek taraflı günlerde 0) */
const sideDX = (L, sd) => L.pair ? (sd === 'sol' ? 1 : -1)*(L.pairD || 0) : 0;
/* Eski kesitlerin hücre alanı — yeni tahtaların ölçeği buna göre (gün dengesi) */
/* GOAL-039: etmoid tahtaları uzun ve dar; ızgaraya ancak bu kadar sığıyor
   (yükseklik sınırı), hedef de ulaşılabilen alan. İki taraflı günler daha geniş. */
const AREA_BY_DAY = [7839,7517,8200, 6989,6663,8600, 5900,4900,6600, 5698,5378,8600];
/* Harita görselleri (assets/board): koyu lacivert zeminin üstünde kızarık bir
   boşluk. Boşluk, kırmızının maviyi geçtiği pikseller; zemindeki soluk
   desenler ayrı küçük parçalar olarak kalıyor, en büyük parça tutulup içindeki
   koyu lekeler dolduruluyor. Sonuç boşluğun kutusuna kırpılmış beyaz maske. */
const boardMasks = {};
function boardMask(img){
  const sc = Math.min(1, 960/Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width*sc)), h = Math.max(1, Math.round(img.height*sc));
  const src = makeCanvas(w, h), sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data, N = w*h;
  const red = new Uint8Array(N);
  for(let i=0;i<N;i++){ const r = px[i*4], b = px[i*4+2]; red[i] = (r > b + 10 && r > 28) ? 1 : 0; }
  // en büyük bağlı kızarık parça
  const comp = new Int32Array(N).fill(-1), q = new Int32Array(N);
  let id = 0, best = -1, bestN = 0;
  for(let s=0;s<N;s++){
    if(!red[s] || comp[s] >= 0) continue;
    let qh = 0, qt = 0; comp[s] = id; q[qt++] = s;
    while(qh < qt){
      const i = q[qh++], x = i%w;
      if(x>0   && red[i-1] && comp[i-1] < 0){ comp[i-1] = id; q[qt++] = i-1; }
      if(x<w-1 && red[i+1] && comp[i+1] < 0){ comp[i+1] = id; q[qt++] = i+1; }
      if(i>=w  && red[i-w] && comp[i-w] < 0){ comp[i-w] = id; q[qt++] = i-w; }
      if(i<N-w && red[i+w] && comp[i+w] < 0){ comp[i+w] = id; q[qt++] = i+w; }
    }
    if(qt > bestN){ bestN = qt; best = id; }
    id++;
  }
  // dışarıdan ulaşılamayan her şey boşluğun parçası (iç lekeler dolsun)
  const out = new Uint8Array(N); let qh = 0, qt = 0;
  const push = i => { if(!out[i] && comp[i] !== best){ out[i] = 1; q[qt++] = i; } };
  for(let x=0;x<w;x++){ push(x); push(N-w+x); }
  for(let y=0;y<h;y++){ push(y*w); push(y*w+w-1); }
  while(qh < qt){
    const i = q[qh++], x = i%w;
    if(x>0) push(i-1); if(x<w-1) push(i+1); if(i>=w) push(i-w); if(i<N-w) push(i+w);
  }
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for(let i=0;i<N;i++) if(!out[i]){ const x = i%w, y = (i/w)|0;
    if(x<x0) x0 = x; if(x>x1) x1 = x; if(y<y0) y0 = y; if(y>y1) y1 = y; }
  if(x1 < x0) return null;
  const mw = x1-x0+1, mh = y1-y0+1, cv = makeCanvas(mw, mh), mctx = cv.getContext('2d');
  const md = mctx.createImageData(mw, mh), d = md.data;
  for(let y=0;y<mh;y++) for(let x=0;x<mw;x++) if(!out[(y+y0)*w + x+x0]){
    const k = (y*mw+x)*4; d[k] = d[k+1] = d[k+2] = d[k+3] = 255;
  }
  mctx.putImageData(md, 0, 0);
  /* Kontur (Moore komşuluk izi): yüz haritası sinüsü bu biçimle çiziyor.
     Piksel basamakları yay uzunluğuna göre seyrek örneklenip eğriye
     (splinePath) bırakılıyor. */
  const ins = (x, y) => x >= 0 && y >= 0 && x < mw && y < mh && !out[(y+y0)*w + x+x0];
  const DX = [1,1,0,-1,-1,-1,0,1], DY = [0,1,1,1,0,-1,-1,-1];
  const dirOf = (dx, dy) => { for(let k=0;k<8;k++) if(DX[k] === dx && DY[k] === dy) return k; return 4; };
  let sx = 0; while(sx < mw && !ins(sx, 0)) sx++;
  let cx = sx, cy = 0, bx = sx-1, by = 0, f0 = null;
  const ring = [[sx, 0]];
  for(let it=0; it<4*(mw+mh)*8; it++){
    const b = dirOf(bx-cx, by-cy); let nx = -1, ny = -1;
    for(let k=1;k<=8;k++){
      const dd = (b+k)%8, tx = cx+DX[dd], ty = cy+DY[dd];
      if(ins(tx, ty)){ nx = tx; ny = ty; const pd = (b+k-1)%8; bx = cx+DX[pd]; by = cy+DY[pd]; break; }
    }
    if(nx < 0) break;
    if(!f0) f0 = [nx, ny];
    else if(cx === sx && cy === 0 && nx === f0[0] && ny === f0[1]) break;
    cx = nx; cy = ny; ring.push([cx, cy]);
  }
  if(ring.length > 1 && ring[ring.length-1][0] === sx && ring[ring.length-1][1] === 0) ring.pop();
  const cum = [0];
  for(let i=1;i<=ring.length;i++){ const a = ring[i-1], c2 = ring[i % ring.length];
    cum.push(cum[i-1] + Math.hypot(c2[0]-a[0], c2[1]-a[1])); }
  const per = cum[ring.length], NP = 84, contour = [];
  for(let j=0, i=0; j<NP; j++){
    const t = per*j/NP; while(i < ring.length-1 && cum[i+1] < t) i++;
    const a = ring[i], c2 = ring[(i+1) % ring.length], u = (t - cum[i]) / Math.max(1e-6, cum[i+1]-cum[i]);
    contour.push([lerp(a[0], c2[0], u) + .5, lerp(a[1], c2[1], u) + .5]);
  }
  const pa = polyAreaCentroid(contour);
  return { cv, ar:mh/mw, w:mw, h:mh, contour, area:pa.a, cx:pa.cx, cy:pa.cy };
}
/* Çokgenin alanı ve ağırlık merkezi (shoelace) */
function polyAreaCentroid(P){
  let a = 0, x = 0, y = 0;
  for(let i=0;i<P.length;i++){
    const p = P[i], q = P[(i+1) % P.length], cr = p[0]*q[1] - q[0]*p[1];
    a += cr; x += (p[0]+q[0])*cr; y += (p[1]+q[1])*cr;
  }
  a /= 2;
  return Math.abs(a) < 1e-12 ? { a:0, cx:P[0][0], cy:P[0][1] } : { a:Math.abs(a), cx:x/(6*a), cy:y/(6*a) };
}
/* Harita görseli olan sinüs, yüz haritasında da o biçimle duruyor: kontur,
   eski çizimin alanıyla ve yüksekliğinde (ağırlık merkezi) oturtulup ANAT'ın
   yerine geçiyor. Yatayda orta hattaki kenarı eski kenarla hizalı — daha
   geniş bir biçim burun boşluğunun üstüne taşmasın, yanağa doğru büyüsün.
   Yani harita, dalış ve tahta yine tek bir biçimden geliyor; görselin yüz
   uzayındaki kutusu tahtanın penceresi oluyor (art.win). */
/* Dikeyde hangi kenar eski çizimle hizalanıyor: maksillerin tavanı göz
   çukurunun tabanıdır (hemen gözün altında), frontalin tabanı etmoidin ve
   göz çukurunun üstüne oturur. Diğerleri ağırlık merkezinden. */
const ART_VALIGN = { maxillary:'top', frontal:'bottom' };
function applyBoardArtToAnatomy(){
  for(const rg in ANAT) for(const sd of ['sol','sag']){
    const art = boardMasks[rg + '_' + sd];
    if(!art || !art.area || !ANAT[rg][sd]) continue;
    const prev = ANAT[rg][sd], old = polyAreaCentroid(prev), s = Math.sqrt(old.a/art.area);
    const xs = P => P.map(p => p[0]), ys = P => P.map(p => p[1]), medial = sd === 'sol' ? Math.max : Math.min;
    const dx = medial(...xs(prev)) - (old.cx + (medial(...xs(art.contour)) - art.cx)*s);
    const va = ART_VALIGN[rg];
    const dy = va === 'top' ? Math.min(...ys(prev)) - (old.cy + (Math.min(...ys(art.contour)) - art.cy)*s)
             : va === 'bottom' ? Math.max(...ys(prev)) - (old.cy + (Math.max(...ys(art.contour)) - art.cy)*s) : 0;
    const X = x => old.cx + (x - art.cx)*s + dx, Y = y => old.cy + (y - art.cy)*s + dy;
    ANAT[rg][sd] = art.contour.map(p => [X(p[0]), Y(p[1])]);
    art.win = [X(0), Y(0), X(art.w), Y(art.h)];
  }
  buildDrainage();
}
/* =========================================================================
   DRENAJ YOLLARI (yüz haritası)
   Sinüslerin burna gerçekte açıldığı yerler, önden görünümde sadeleştirilmiş:
     - Maksiller: ağzı iç duvarın ÜST köşesinde; infundibulumdan yukarı-içe
       çıkıp orta meatusa (orta konkanın altı, burnun yan duvarı) açılıyor.
     - Frontal: dipteki frontal resessten aşağı iniyor, etmoid ile burnun üst
       kolonu arasından geçip orta meatus bölgesine (OMC) açılıyor.
     - Etmoid: hücre ağızları burnun üst kolonuna (üst/orta meatus).
   İlacın yolu da bunları izliyor: burun deliğinden septum boyunca ortak
   meatusla yukarı, orta konkanın altından orta meatusa, oradan kanalla sinüse.
   Noktalar görsel pikseli (sinuzit.jfif), sağ taraf kendi geometrisinden.
   ========================================================================= */
const DRAIN = {
  sol: { nostril:[156,272], low:[164,262], under:[164,247], tuck:[157,247.5], meatusLo:[151.8,245],
         meatus:[153,237], omc:[163.8,229], gap:162.3, ethDuct:[160,231] },
  sag: { nostril:[181,272], low:[174,262], under:[174,247], tuck:[180.5,247.5], meatusLo:[186.8,245],
         meatus:[186.3,237], omc:[175.4,229], gap:177.5, ethDuct:[180.5,228] }
};
function buildDrainage(){
  for(const sd of ['sol','sag']){
    const D = DRAIN[sd], m = sd === 'sol' ? 1 : -1;     // m: içe (burna) doğru x yönü
    // maksiller: iç duvarın üst köşesi → biraz yukarı-içe → orta meatus
    const MX = ANAT.maxillary[sd];
    let so = MX[0], best = -1e9;
    for(const q of MX){ const sc = m*q[0]*1.6 - q[1]; if(sc > best){ best = sc; so = q; } }
    const meat = IMG(D.meatus), mid = [lerp(so[0], meat[0], .45), Math.min(so[1], meat[1]) - .018];
    const mxDuct = [so, mid, meat];
    const k = ANAT_DUCTS.findIndex(d => d[0] === 'maxillary' && d[1] === sd);
    if(k >= 0) ANAT_DUCTS[k][2] = mxDuct;
    D.maxDuct = mxDuct;
    // frontal: tabanın en alt noktası → etmoid ile kolon arasındaki aralıktan aşağı → OMC
    const FR = ANAT.frontal[sd];
    let fb = FR[0]; for(const q of FR) if(q[1] > fb[1]) fb = q;
    const frDuct = [fb, IMG([D.gap, 205]), IMG([D.gap, 222]), IMG(D.omc)];
    const j = ANAT_DUCTS.findIndex(d => d[0] === 'frontal' && d[1] === sd);
    if(j >= 0) ANAT_DUCTS[j][2] = frDuct; else ANAT_DUCTS.push(['frontal', sd, frDuct, .02, 'map']);
    D.frDuct = frDuct;
  }
}
/* Bir tarafın harita görseli: önce güne özel (yalnızca tek taraflı günde),
   sonra bölge + taraf. */
function sideArt(L, sd){
  return (!L.pair && boardMasks['day' + String(L.day).padStart(2,'0')]) || boardMasks[L.region + '_' + sd] || null;
}
const boardArt = L => sideArt(L, daySides(L)[0]);
function boardWindow(L){
  const B0 = BOARDS[L.region], sides = daySides(L);
  let x0 = 9, y0 = 9, x1 = -9, y1 = -9, framed = false;
  const ext = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for(const sd of sides){
    const art = sideArt(L, sd), dx = sideDX(L, sd);
    if(art && art.win){ ext(art.win[0] + dx, art.win[1]); ext(art.win[2] + dx, art.win[3]); framed = true; continue; }
    if(art){
      /* Yalnızca güne özel görsel (dayNN): yüz haritasındaki sinüsün yerine ve
         kabaca onun büyüklüğünde oturuyor, dalış haritadaki sinüse iniyor. Asıl
         ölçeği yine fitBoard (alan hedefi) belirliyor. */
      let a0 = 9, b0 = 9, a1 = -9, b1 = -9;
      for(const p of ANAT[L.region][sd]){ a0 = Math.min(a0, p[0]); a1 = Math.max(a1, p[0]); b0 = Math.min(b0, p[1]); b1 = Math.max(b1, p[1]); }
      const S = Math.sqrt((a1-a0)*(b1-b0)), ww = S/Math.sqrt(art.ar), wh = S*Math.sqrt(art.ar);
      const cx = (a0+a1)/2, cy = (b0+b1)/2;
      art.dayWin = [cx - ww/2, cy - wh/2, cx + ww/2, cy + wh/2];
      ext(art.dayWin[0], art.dayWin[1]); ext(art.dayWin[2], art.dayWin[3]); framed = true; continue;
    }
    for(const rg of B0.parts) for(const p of ANAT[rg][sd]){
      if(B0.clipY0 !== undefined && p[1] < B0.clipY0) continue;
      ext(p[0] + dx, p[1]);
    }
  }
  if(framed) return [x0, y0, x1, y1];
  const m = .02;
  return [x0 - m, B0.clipY0 !== undefined ? B0.clipY0 : y0 - m, x1 + m, y1 + m];
}
function roundRectPath(c, x0, y0, x1, y1, r){
  c.beginPath();
  c.moveTo(x0+r, y0); c.arcTo(x1, y0, x1, y1, r); c.arcTo(x1, y1, x0, y1, r);
  c.arcTo(x0, y1, x0, y0, r); c.arcTo(x0, y0, x1, y0, r); c.closePath();
}
/* Tahtayı yüz uzayında çizer (çağıran dönüşümü kurar). Beyaz = boşluk.
   İki taraflı günde her taraf kendi kaymasıyla; biçimler orta hatta kaynaşıyor. */
function paintBoard(c, L){
  const B0 = BOARDS[L.region];
  c.fillStyle = '#fff';
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  let anyArt = false;
  for(const sd of daySides(L)){
    const art = sideArt(L, sd), dx = sideDX(L, sd);
    if(art){                                  // harita görseli: maskesi penceresine
      const w = art.win || art.dayWin;
      c.drawImage(art.cv, w[0] + dx, w[1], w[2]-w[0], w[3]-w[1]);
      anyArt = true; continue;
    }
    c.save(); c.translate(dx, 0);
    for(const rg of B0.parts) blob(c, ANAT[rg][sd]);
    c.restore();
  }
  if(anyArt) return;
  // pencere: dışı kemik (burunda kolonun tepesini kırpıyor)
  const w = L.win, r = .12*Math.min(w[2]-w[0], w[3]-w[1]);
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = '#fff'; roundRectPath(c, w[0], w[1], w[2], w[3], r); c.fill();
  c.globalCompositeOperation = 'source-over';
}
/* Kemiğe işlenen komşu yapılar: göz çukurları — yüz haritasındaki gözlerle
   aynı yerde (haritada olmayan hiçbir şey tahtaya çizilmiyor). u = bir ızgara
   hücresinin yüz birimi. */
function paintBoardMarks(c, u){
  for(const s of [-1, 1]) orbitMark(c, s*.375, -.272, .19, .07, u);
}
/* Pencereyi ızgaraya yerleştirir: ölçek k (hücre / yüz birimi) ve öteleme.
   count(f) o yerleşimde boşluğa düşen hücre sayısı; iki adımda alan hedefe
   (L.area) yaklaştırılıyor, pencere ızgaraya sığmıyorsa sığdığı kadar. */
function fitBoard(L, count){
  const w = L.win, ww = w[2]-w[0], wh = w[3]-w[1];
  const kMax = Math.min((GW-2*B-6)/ww, (GH-2*B-6)/wh);
  const place = k => ({ k, gx0:GW/2 - k*(w[0]+w[2])/2, gy0:GH/2 - k*(w[1]+w[3])/2 });
  let k = kMax*.7;
  for(let it=0; it<2; it++){
    const n = count(place(k));
    if(n > 0) k = Math.min(kMax, k*Math.sqrt(L.area/n));
  }
  return place(k);
}

const shapeCv = makeCanvas(HW,HH), shapeCtx = shapeCv.getContext('2d', { willReadFrequently:true });

/* Boşluğa ulaşılamayan cepleri duvara çevirir. Şekiller elle çizildiği için
   bir oda yanlışlıkla mühürlenirse alan hedefi imkânsız hale gelirdi; bu ağ
   onu sessizce kapatır, bölüm her zaman tamamlanabilir kalır. */
/* GOAL-028: kesit ızgaraya düşerken kopan küçük odalar mühürlenir. Eskiden
   tohum burun deliğiydi; port kalmadığı için artık EN BÜYÜK bağlı parça
   tutuluyor, geri kalanı kemiğe dönüyor. Sonuç aynı (tek parça oynanabilir
   alan) ama hiçbir sabit noktaya bağlı değil. */
function sealUnreachable(){
  const comp = new Int32Array(GW*GH).fill(-1), q = new Int32Array(GW*GH);
  let id = 0, best = -1, bestN = 0;
  for(let start=0;start<cavity.length;start++){
    if(!cavity[start] || comp[start] >= 0) continue;
    let qh = 0, qt = 0, cnt = 0;
    comp[start] = id; q[qt++] = start;
    while(qh < qt){
      const i = q[qh++], x = i%GW, y = (i/GW)|0; cnt++;
      if(x>0    && cavity[i-1]  && comp[i-1]  < 0){ comp[i-1]  = id; q[qt++] = i-1; }
      if(x<GW-1 && cavity[i+1]  && comp[i+1]  < 0){ comp[i+1]  = id; q[qt++] = i+1; }
      if(y>0    && cavity[i-GW] && comp[i-GW] < 0){ comp[i-GW] = id; q[qt++] = i-GW; }
      if(y<GH-1 && cavity[i+GW] && comp[i+GW] < 0){ comp[i+GW] = id; q[qt++] = i+GW; }
    }
    if(cnt > bestN){ bestN = cnt; best = id; }
    id++;
  }
  if(best < 0) return;
  for(let i=0;i<cavity.length;i++) if(cavity[i] && comp[i] !== best) cavity[i] = 0;
}

/* Kesitin her satırında kaç boşluk hücresi var — nefesin karşılaşacağı
   kesit alanı. Kesit değiştiğinde bir kez ölçülüyor. */
/* Boşluğun en üst ve en alt satırı. Nefes aşağıdan girip yukarı çıktığı için
   yükseklik yüzdesi bu iki sınıra göre hesaplanıyor. */
function measureRows(){
  let y0 = -1, y1 = -1;
  for(let y=0;y<GH;y++){
    const row = y*GW; let k = 0;
    for(let x=0;x<GW;x++) if(cavity[row+x]){ k = 1; break; }
    if(k){ if(y0 < 0) y0 = y; y1 = y; }
  }
  breath.y0 = y0 < 0 ? 0 : y0;
  breath.y1 = y1 < 0 ? GH-1 : y1;
}

/* GOAL-034: kesit, tek anatomi çiziminin günün penceresi (bkz. paintBoard). */
/* lo: yerleşim denemeleri için eski (AU) çözünürlükte — yalnızca hücre
   merkezleri sayılıyor, tam çözünürlük son çizime kalıyor. */
const shapeLoCv = makeCanvas(VW,VH), shapeLoCtx = shapeLoCv.getContext('2d', { willReadFrequently:true });
function rasterBoard(L, f, lo){
  const c = lo ? shapeLoCtx : shapeCtx, S = lo ? AU : SC, W = GW*S, H = GH*S;
  c.setTransform(1,0,0,1,0,0);
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#000'; c.fillRect(0,0,W,H);
  c.setTransform(S*f.k,0,0,S*f.k, S*f.gx0, S*f.gy0);
  paintBoard(c, L);
  c.setTransform(1,0,0,1,0,0);
  return c.getImageData(0,0,W,H).data;
}
function sampleCavity(raw, lo){
  const S = lo ? AU : SC, W = GW*S, H = GH*S;
  cavity.fill(0);
  let n = 0;
  for(let y=B;y<GH-B;y++) for(let x=B;x<GW-B;x++){
    const px = Math.min(W-1, ((x+.5)*S)|0), py = Math.min(H-1, ((y+.5)*S)|0);
    if(raw[(py*W+px)*4] > 127){ cavity[y*GW+x] = 1; n++; }
  }
  return n;
}
function buildCavity(L){
  // GOAL-034: günün penceresi ve hedef alanı (anatomi tanımı LEVELS'tan sonra geliyor)
  L.pairD = L.pair ? pairShift(L.region) : 0;   // GOAL-039: iki taraf birlikte
  L.win  = boardWindow(L);
  L.area = L.areaT || AREA_BY_DAY[L.day-1];   // areaT: günün ayar tablosu (GOAL-037)
  const f = fitBoard(L, g => sampleCavity(rasterBoard(L, g, true), true));
  L.face = f;                    // giriş sahnesi dalışı bu yerleşime iniyor
  const raw = rasterBoard(L, f);
  sampleCavity(raw);
  /* Izgaraya düşerken kopan küçük cepler kemiğe çevriliyor; görsel maskeden de
     siliniyorlar ki temizlenemeyen "hasta" lekeler olarak kalmasınlar. */
  const pre = cavity.slice();
  sealUnreachable();
  for(let i=0;i<cavity.length;i++) if(pre[i] && !cavity[i]){
    const gx = i%GW, gy = (i/GW)|0;
    for(let py=gy*SC; py<gy*SC+SC; py++) for(let px=gx*SC; px<gx*SC+SC; px++) raw[(py*HW+px)*4] = 0;
  }

  // yumuşatılmış maske — duvar dokusunun kenarı tırtıklı olmasın. Kutu
  // bulanıklığı (iki geçiş) hücre biriminde eski genişlikte: yarıçap PX piksel,
  // yani çözünürlük artınca kenar daha düzgün ama aynı kalınlıkta.
  const edgePx = B*SC, R = Math.max(1, Math.round(PX)), tmp = new Float32Array(HW*HH);
  for(let y=0;y<HH;y++){
    const row = y*HW;
    for(let x=0;x<HW;x++){
      let s = 0, n = 0;
      for(let dx=-R;dx<=R;dx++){ const px = x+dx; if(px<0||px>=HW) continue; s += raw[(row+px)*4]; n++; }
      tmp[row+x] = s/n;
    }
  }
  for(let y=0;y<HH;y++) for(let x=0;x<HW;x++){
    if(x<edgePx||y<edgePx||x>=HW-edgePx||y>=HH-edgePx){ cavSoft[y*HW+x] = 0; continue; }
    let s = 0, n = 0;
    for(let dy=-R;dy<=R;dy++){ const py = y+dy; if(py<0||py>=HH) continue; s += tmp[py*HW+x]; n++; }
    cavSoft[y*HW+x] = s/n/255;
  }
  for(let i=0;i<HW*HH;i++) cavM[i] = clamp((cavSoft[i]-.5)*2.6 + .5, 0, 1);

  measureRows();   // GOAL-028: nefesin okuyacağı satır kesitleri

  cavCount = 0;
  let sx = 0, sy = 0, bx0 = GW, by0 = GH, bx1 = 0, by1 = 0;
  for(let i=0;i<cavity.length;i++) if(cavity[i]){
    cavCount++;
    const x = i%GW, y = (i/GW)|0;
    sx += x; sy += y;
    if(x<bx0) bx0 = x; if(x>bx1) bx1 = x;
    if(y<by0) by0 = y; if(y>by1) by1 = y;
  }
  if(cavCount){
    cavCX = sx/cavCount; cavCY = sy/cavCount;
    /* GOAL-022 (revize): kesitin gerçekte kapladığı kutu. Alan 160x160 ama
       boşluk çoğu kesitte 120x110 civarında; aradaki fark solda ve sağda
       bomboş kemik. Çerçeveyi bu kutuya göre kurunca telefonda saha ekranın
       enini doldurabiliyor, artan kemik ekran dışında kalıyor. */
    cavBB = { x0:bx0, y0:by0, x1:bx1+1, y1:by1+1 };
  }
  layout();          // yeni kesit yeni çerçeve istiyor
}

/* Boşluk içinde, çevresi de boşluk olan rastgele bir hücre — düşman/powerup
   doğumları duvarın içine düşmesin diye. */
/* Boşluğun sınırlayıcı kutusu (ızgara birimi, x1/y1 dışlayıcı) */
let cavBB = { x0:0, y0:0, x1:GW, y1:GH };
/* Saha içi yazı/etiketlerin ölçek çarpanı: saha küçüldükçe büyüyorlar ki
   telefonda "HAVA GİRİŞİ" gibi bilgiler okunaklı kalsın (bkz. layout). */
let uiScale = 1;
let playerW = PLAYER_SIZE, puW = PU_SIZE;   // saha birimi; layout() ekrandaki aralığa göre ayarlıyor
/* Ekranda gercekten gorunen saha dikdortgeni (saha pikseli). Kadraj kemik
   payini kirptigi icin kenara yakin etiketler disarida kalabiliyor. */
let frame = { x0:0, y0:0, x1:GW*CS, y1:GH*CS };
/* GOAL-031: aynı kadraj EKRAN pikselinde (giriş sahnesi silüeti tahtanın
   üstüne tam oturtmak, bilgi şeridi de tahtanın dışında kalmak için). */
let scrFrame = { x0:0, y0:0, x1:1, y1:1 }, scrField = { x:0, y:0, s:1 };
function randomCavityCell(pad){
  pad = pad|0;
  for(let tries=0;tries<500;tries++){
    const x = (B+2+rand()*(GW-2*B-4))|0, y = (B+2+rand()*(GH-2*B-4))|0;
    const i = y*GW+x;
    if(!cavity[i]) continue;
    let ok = true;
    for(let dy=-pad;dy<=pad && ok;dy++) for(let dx=-pad;dx<=pad;dx++){
      const px = x+dx, py = y+dy;
      if(px<0||py<0||px>=GW||py>=GH||!cavity[py*GW+px]){ ok = false; break; }
    }
    if(ok) return { x:x, y:y, i:i };
  }
  const cx = clamp(Math.round(cavCX), 0, GW-1), cy = clamp(Math.round(cavCY), 0, GH-1);
  return { x:cx, y:cy, i:cy*GW+cx };
}

/* GOAL-028: oyuncunun başlangıcı. Eskiden burun deliği portunun dibiydi; port
   kalmayınca boşluğun en alt sırasında yatayda merkeze en yakın noktanın
   altındaki duvara oturuyor. Nefes de aşağıdan yukarı ilerlediği için oyuncu
   havayla aynı yerden yola çıkıyor. */
function playerStart(){
  let by = -1;
  for(let y=GH-1;y>=0 && by<0;y--)
    for(let x=0;x<GW;x++) if(cavity[y*GW+x]){ by = y; break; }
  if(by < 0) return { x:GW>>1, y:GH-B };
  let bx = GW>>1, bd = Infinity;
  for(let x=0;x<GW;x++) if(cavity[by*GW+x]){
    const d = Math.abs(x-cavCX); if(d < bd){ bd = d; bx = x; }
  }
  for(let y=by;y<GH;y++) if(!cavity[y*GW+bx]) return { x:bx, y:y };
  return { x:bx, y:GH-B };
}

/* ---- kemik/kıkırdak duvar dokusu ---- */
const wallCanvas = makeCanvas(HW,HH), wallCtx = wallCanvas.getContext('2d');
function paintWalls(L){
  const img = wallCtx.createImageData(HW,HH), d = img.data;
  const n1 = fbmHi(34,L.day*331+17,3), n2 = fbmHi(9,L.day*197+5,2);
  const bone = [hex2rgb('#120b10'), hex2rgb('#2c1a20'), hex2rgb('#4a2f36'), hex2rgb('#785654')];
  const col = [0,0,0], warm = [206,132,130];
  for(let i=0;i<HW*HH;i++){
    const v = cavSoft[i];
    const a = 1 - sstep(.34,.62,v);
    if(a <= .004) continue;                       // boşluk: tamamen şeffaf
    const edge = sstep(.06,.52,v);                // boşluğa yakın iç yüzey
    rampTo(bone, n1[i]*.52 + n2[i]*.20 + edge*.40, col);
    mixTo(col, warm, edge*edge*.46);              // mukoza altı sıcaklık
    d[i*4] = col[0]; d[i*4+1] = col[1]; d[i*4+2] = col[2];
    d[i*4+3] = Math.min(255, a*255);
  }
  wallCtx.putImageData(img,0,0);
  /* GOAL-030: komşu yapılar (göz çukuru, diş). source-atop: yalnızca kemiğin
     opak olduğu yere düşüyor, boşluğa taşmıyor. Kesit gibi aynalanıyor. */
  const f = L.face;
  if(f){
    wallCtx.save();
    wallCtx.globalCompositeOperation = 'source-atop';
    wallCtx.setTransform(SC*f.k,0,0,SC*f.k, SC*f.gx0, SC*f.gy0);   // yüz uzayı (GOAL-034)
    paintBoardMarks(wallCtx, 1/f.k);
    wallCtx.restore();
  }
}

/* =========================================================================
   5. IZGARA + ALAN KAPATMA (değişmeyen, doğrulanmış çekirdek)
   ========================================================================= */
const cells   = new Uint8Array(GW*GH);
const markBuf = new Uint8Array(GW*GH);
function resetGrid(){
  // GOAL-015: kenar bandının yanı sıra boşluk dışındaki her hücre de kalıcı
  // FILL — yani kemik duvar. Oyuncu üstünde yürür, düşman içine giremez.
  cells.fill(EMPTY);
  for(let y=0;y<GH;y++) for(let x=0;x<GW;x++){
    const i = y*GW+x;
    if(x<B||y<B||x>=GW-B||y>=GH-B || !cavity[i]) cells[i] = FILL;
  }
}
function scanRow(stack,lx,rx,y){
  const row = y*GW; let added = false;
  for(let i=lx;i<=rx;i++){
    const ok = cells[row+i] === EMPTY && !markBuf[row+i];
    if(ok && !added){ stack.push(i,y); added = true; }
    else if(!ok) added = false;
  }
}
function spanFill(sx,sy){
  sx|=0; sy|=0;
  if(sx<0||sy<0||sx>=GW||sy>=GH) return;
  if(cells[sy*GW+sx] !== EMPTY || markBuf[sy*GW+sx]) return;
  const stack = [sx,sy];
  while(stack.length){
    const y = stack.pop(), x = stack.pop(), row = y*GW;
    if(cells[row+x] !== EMPTY || markBuf[row+x]) continue;
    let lx = x, rx = x;
    while(lx>0    && cells[row+lx-1]===EMPTY && !markBuf[row+lx-1]) lx--;
    while(rx<GW-1 && cells[row+rx+1]===EMPTY && !markBuf[row+rx+1]) rx++;
    for(let i=lx;i<=rx;i++) markBuf[row+i] = 1;
    if(y>0)    scanRow(stack,lx,rx,y-1);
    if(y<GH-1) scanRow(stack,lx,rx,y+1);
  }
}

/* =========================================================================
   6. SAHNE
   ========================================================================= */
const app = await (async () => {
  const opts = { background:0x060d14, antialias:true, powerPreference:'high-performance',
    resolution: Math.min(window.devicePixelRatio||1, 2), autoDensity:true,
    width: window.innerWidth, height: window.innerHeight };
  if(MAJOR >= 8){ const a = new PIXI.Application(); await a.init(opts); return a; }
  return new PIXI.Application(opts);
})();
const view = (MAJOR>=8) ? app.canvas : app.view;
document.getElementById('app').insertBefore(view, document.getElementById('vig'));

/* GOAL-009: gerçek assetler — PIXI kurulumundan hemen sonra, TEX nesnesinden
   önce yükleniyor ki texFromImage() çağrıldığında görsel hazır olsun. */
const [playerImg, bossImg, boss2Img, boss3Img, flowerImg, minionFlagellaImg, minionSporeImg] = await Promise.all([
  loadImage(playerAssetUrl), loadImage(bossAssetUrl), loadImage(boss2AssetUrl), loadImage(boss3AssetUrl),
  loadImage(flowerAssetUrl), loadImage(minionFlagellaAssetUrl), loadImage(minionSporeAssetUrl)
]);
/* GOAL-016: varsa bölüm arka planları (yoksa boş kalır) */
const bgAssetImgs = {}, plateAssetImgs = {}, boardAssetImgs = {};
async function loadGlob(glob, into){
  await Promise.all(Object.keys(glob).map(async k => {
    const name = k.slice(k.lastIndexOf('/')+1).replace(/\.png$/i,'').toLowerCase();
    try{ into[name] = await loadImage(glob[k]); }catch(e){}
  }));
}
await loadGlob(BG_GLOB, bgAssetImgs);
await loadGlob(PLATE_GLOB, plateAssetImgs);
await loadGlob(BOARD_GLOB, boardAssetImgs);
for(const k in boardAssetImgs) boardMasks[k] = boardMask(boardAssetImgs[k]);
applyBoardArtToAnatomy();

const PLAYER_AR = playerImg.height / playerImg.width; // en-boy oranı korunsun diye
const BOSS_IMGS = [bossImg, boss2Img, boss3Img];
const BOSS_AR = BOSS_IMGS.map(im => im.height / im.width);
// GOAL-012: minion assetleri kare olmayabilir; her tür için ayrı en-boy oranı
const MINI_AR = [minionFlagellaImg.height / minionFlagellaImg.width, minionSporeImg.height / minionSporeImg.width];

const bootEl = document.getElementById('boot'); if(bootEl) bootEl.remove();

const root = new PIXI.Container(), shakeRoot = new PIXI.Container();
shakeRoot.addChild(root); app.stage.addChild(shakeRoot);
const layerBG = new PIXI.Container(), layerRim = new PIXI.Container(),
      layerEnt = new PIXI.Container(), layerTrail = new PIXI.Container(),
      layerLight = new PIXI.Container(), layerGrain = new PIXI.Container();
root.addChild(layerBG, layerRim, layerEnt, layerTrail, layerLight, layerGrain);

const bgTex = texFromCanvas(bgCanvas);
const bgSprite = new PIXI.Sprite(bgTex);
bgSprite.width = PFW; bgSprite.height = PFH;
layerBG.addChild(bgSprite);

/* İyileşmiş dokunun canlılığı: temizlenen alanda yukarı süzülen hava
   zerreleri. Hastalıklı doku (dzSprite) ve kemik bu katmanın üstünde olduğu
   için yalnızca açılan yerde görünüyor — ayrı bir maskeye gerek yok. Nefes
   anında kısa bir an parlıyor (bkz. render). */
function texMotes(){
  const S = 256, cv = makeCanvas(S,S), c = cv.getContext('2d');
  c.globalCompositeOperation = 'lighter';
  for(let k=0;k<46;k++){
    const x = Math.random()*S, y = Math.random()*S, r = .8 + Math.random()*Math.random()*3.6;
    const g = c.createRadialGradient(x,y,0,x,y,r*2.4);
    const a = .25 + Math.random()*.5;
    g.addColorStop(0,'rgba(220,255,250,'+a.toFixed(2)+')'); g.addColorStop(.4,'rgba(150,240,232,'+(a*.45).toFixed(2)+')');
    g.addColorStop(1,'rgba(150,240,232,0)');
    for(const ox of [-S,0,S]) for(const oy of [-S,0,S]){ c.save(); c.translate(ox,oy); c.fillStyle = g; c.beginPath(); c.arc(x,y,r*2.4,0,7); c.fill(); c.restore(); }
  }
  for(let k=0;k<5;k++){                                    // seyrek, ince hava telleri
    const x = Math.random()*S, len = 40 + Math.random()*70, y0 = Math.random()*S;
    const g = c.createLinearGradient(0,y0,0,y0+len);
    g.addColorStop(0,'rgba(170,250,240,0)'); g.addColorStop(.5,'rgba(170,250,240,.10)'); g.addColorStop(1,'rgba(170,250,240,0)');
    c.strokeStyle = g; c.lineWidth = 1.2;
    for(const oy of [-S,0]){ c.beginPath(); c.moveTo(x, y0+oy); c.quadraticCurveTo(x+6, y0+oy+len*.5, x-2, y0+oy+len); c.stroke(); }
  }
  return texFromCanvas(cv);
}
const healLive = MAJOR >= 8 ? new PIXI.TilingSprite({ texture:texMotes(), width:PFW, height:PFH })
                            : new PIXI.TilingSprite(texMotes(), PFW, PFH);
healLive.blendMode = BLEND_ADD; healLive.alpha = .4;
layerBG.addChild(healLive);

/* hastalıklı doku: HW x HH RGBA (hücre başına SC piksel), alfa ızgaradan bilineer türetiliyor */
const dzCanvas = makeCanvas(HW,HH), dzCtx = dzCanvas.getContext('2d');
const dzImg = dzCtx.createImageData(HW,HH);
const dzTex = texFromCanvas(dzCanvas);
const dzSprite = new PIXI.Sprite(dzTex);
dzSprite.width = PFW; dzSprite.height = PFH;
layerBG.addChild(dzSprite);

/* GOAL-015: kemik/kıkırdak duvar — doku katmanının üstünde, boşluğun dışını
   kapatıyor. Izgara mantığında burası zaten kalıcı FILL olduğu için reveal
   makinesine (rasterRegion/dzTex) hiç dokunulmadı; sadece üstü örtülüyor. */
const wallTex = texFromCanvas(wallCanvas);
const wallSprite = new PIXI.Sprite(wallTex);
wallSprite.width = PFW; wallSprite.height = PFH;
layerBG.addChild(wallSprite);

/* sınır ışıması: alfa geçişinin tepe noktasından türetilen ince bant */
const rimCanvas = makeCanvas(HW,HH), rimCtx = rimCanvas.getContext('2d');
const rimImg = rimCtx.createImageData(HW,HH);
const rimTex = texFromCanvas(rimCanvas);
const rimCore = new PIXI.Sprite(rimTex);
rimCore.width = PFW; rimCore.height = PFH; rimCore.blendMode = BLEND_ADD; rimCore.alpha = .95;
/* Işıma: aynı bandın bulanık kopyası. Eskiden %1,2 büyütülmüş bir kopyaydı;
   merkezden uzak kenarlarda ışıma yana kayıyor, kesim kenarları çift çizgi
   gibi görünüyordu. Bulanıklık her yöne eşit. */
const rimBloom = new PIXI.Sprite(rimTex);
rimBloom.width = PFW; rimBloom.height = PFH;
rimBloom.blendMode = BLEND_ADD; rimBloom.alpha = .5;
try{
  const bf = MAJOR >= 8 ? new PIXI.BlurFilter({ strength:5, quality:2 }) : new PIXI.BlurFilter(5, 2);
  bf.blendMode = BLEND_ADD;              // filtre varken karışımı filtre belirliyor
  rimBloom.filters = [bf];
}catch(e){ rimBloom.alpha = 0; }
layerRim.addChild(rimBloom, rimCore);

/* alfa + kenar bandını tek geçişte hesapla (yalnızca değişen bölge) */
/* GOAL-035: hücrenin "hâlâ hastalıklı mı" değeri (1 = hastalıklı doku görünür).
   Boşluk hücresinde doğrudan durumu. Kemik hücresinde ise KOMŞULARINDAN:
   yumuşak kontur ızgara basamaklarının arasından kemik hücrelerine taşıyor;
   kemik sabit 1 sayılınca, duvar boyunca temizlenmiş bir alanda bile
   kenarda hastalıklı doku ve ışıma noktaları kalıyordu (oyuncunun gördüğü
   beyaz noktalar). Artık kemik hücresi, yanındaki boşluk hücrelerinden biri
   hâlâ açıksa 1, hepsi temizlendiyse 0. */
const capBuf = new Uint8Array(GW*GH);
function capAt(k){
  if(cavity[k]) return cells[k] === FILL ? 0 : 1;
  const x = k%GW, y = (k/GW)|0;
  for(let dy=-1;dy<=1;dy++){
    const yy = y+dy; if(yy<0 || yy>=GH) continue;
    for(let dx=-1;dx<=1;dx++){
      const xx = x+dx; if(xx<0 || xx>=GW) continue;
      const n = yy*GW+xx;
      if(cavity[n] && cells[n] !== FILL) return 1;
    }
  }
  return 0;
}
function rasterRegion(cx0, cy0, cx1, cy1){
  const x0 = clamp((cx0-1)*SC, 0, HW), x1 = clamp((cx1+2)*SC, 0, HW);
  const y0 = clamp((cy0-1)*SC, 0, HH), y1 = clamp((cy1+2)*SC, 0, HH);
  const dd = dzImg.data, rd = rimImg.data;
  for(let y=clamp(cy0-2,0,GH-1); y<=clamp(cy1+3,0,GH-1); y++)
    for(let x=clamp(cx0-2,0,GW-1); x<=clamp(cx1+3,0,GW-1); x++) capBuf[y*GW+x] = capAt(y*GW+x);
  for(let py=y0;py<y1;py++){
    const gy = (py+.5)/SC - .5;
    const iy = Math.floor(gy), ty = gy-iy;
    const ya = clamp(iy,0,GH-1)*GW, yb = clamp(iy+1,0,GH-1)*GW;
    for(let px=x0;px<x1;px++){
      const gx = (px+.5)/SC - .5;
      const ix = Math.floor(gx), tx = gx-ix;
      const xa = clamp(ix,0,GW-1), xb = clamp(ix+1,0,GW-1);
      /* GOAL-033: hücre alanı yalnızca TEMİZLENEN yeri söylüyor (bkz. capAt);
         boşluğun kenarını yumuşak kontur (cavM) çiziyor. Kesim çizgileri
         zaten dik doğrular, onlar ızgarada da düzgün kalıyor. */
      const a = capBuf[ya+xa], b = capBuf[ya+xb], c = capBuf[yb+xa], e = capBuf[yb+xb];
      const top = a+(b-a)*tx, bot = c+(e-c)*tx;
      const i = py*HW+px;
      const cap = top+(bot-top)*ty, v = cap * cavM[i];
      dd[i*4]   = tissueRGB[i*3];
      dd[i*4+1] = tissueRGB[i*3+1];
      dd[i*4+2] = tissueRGB[i*3+2];
      dd[i*4+3] = v*255;
      // ışıma daha yumuşak maskeden: dar bantta çizgi kesik kesik görünüyordu
      const vr = cap * cavSoft[i], rim = 4*vr*(1-vr);
      rd[i*4] = 190; rd[i*4+1] = 255; rd[i*4+2] = 250;
      rd[i*4+3] = Math.min(255, rim*rim*300);
    }
  }
  const w = x1-x0, h = y1-y0;
  if(w > 0 && h > 0){
    dzCtx.putImageData(dzImg, 0,0, x0,y0,w,h);
    rimCtx.putImageData(rimImg, 0,0, x0,y0,w,h);
    texUpdate(dzTex); texUpdate(rimTex);
  }
}

const TEX = {
  glow:   texRadial(256, [[0,'rgba(255,255,255,1)'],[.28,'rgba(255,255,255,.45)'],[1,'rgba(255,255,255,0)']]),
  spark:  texRadial(64,  [[0,'rgba(255,255,255,1)'],[.4,'rgba(255,255,255,.6)'],[1,'rgba(255,255,255,0)']]),
  player: texFromImage(playerImg),
  boss:   BOSS_IMGS.map(texFromImage),   // evre sırasıyla (bkz. BOSS_TIER_BY_DAY)
  mini:   [texFromImage(minionFlagellaImg), texFromImage(minionSporeImg)],
  pu:     PU_META.map(texPowerup),
  wind:   texWind(),
  grain:  texGrain()
};

const grainSprite = new PIXI.Sprite(TEX.grain);
grainSprite.width = PFW*1.2; grainSprite.height = PFH*1.2;
grainSprite.blendMode = BLEND_ADD; grainSprite.alpha = .055;
layerGrain.addChild(grainSprite);

/* GOAL-028: NEFES DALGASI
   Sahada artık "HAVA GİRİŞİ" / "OSTIUM ÇIKIŞI" halkaları ve etiketleri yok.
   Yerlerini, her nefes denemesinde bütün sahayı alttan yukarı tarayan tek bir
   yatay bant aldı. Bandın nereye kadar çıkabildiği tıkanıklığın nerede
   olduğunu söylüyor: oyuncu HUD'a bakmadan, dokunun kendisinde görüyor.
   Geçerken turkuaz, tıkandığı yerde kırmızıya dönüp sönüyor. */
function texBand(){
  const W = 8, H = 128, cv = makeCanvas(W,H), c = cv.getContext('2d');
  const g = c.createLinearGradient(0,0,0,H);
  g.addColorStop(0,   'rgba(255,255,255,0)');
  g.addColorStop(.40, 'rgba(255,255,255,.30)');
  g.addColorStop(.50, 'rgba(255,255,255,1)');
  g.addColorStop(.60, 'rgba(255,255,255,.30)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0,0,W,H);
  return texFromCanvas(cv);
}
const waveBand = new PIXI.Sprite(texBand());
waveBand.anchor.set(.5); waveBand.x = PFW/2; waveBand.width = PFW;
waveBand.blendMode = BLEND_ADD; waveBand.alpha = 0;
layerLight.addChild(waveBand);

/* Nefes geçtiğinde tüm alanı yalayan kısa turkuaz dalga — "geçti" anının
   basınç kızarmasıyla aynı güçte bir karşılığı olsun diye. */
const breathWave = new PIXI.Sprite(TEX.glow);
breathWave.anchor.set(.5); breathWave.x = PFW/2; breathWave.y = PFH/2;
breathWave.blendMode = BLEND_ADD; breathWave.tint = 0x7ff0e6; breathWave.alpha = 0;
layerLight.addChild(breathWave);

const playerLight = new PIXI.Sprite(TEX.glow);
playerLight.anchor.set(.5); playerLight.width = playerLight.height = 250;
playerLight.blendMode = BLEND_ADD; playerLight.tint = 0xff6fb0; playerLight.alpha = .2;
layerLight.addChild(playerLight);

const playerGlow = new PIXI.Sprite(TEX.glow);
playerGlow.anchor.set(.5); playerGlow.width = playerGlow.height = 96;
playerGlow.blendMode = BLEND_ADD; playerGlow.tint = 0xff87c0; playerGlow.alpha = .5;
const playerSprite = new PIXI.Sprite(TEX.player);
playerSprite.anchor.set(.5);
playerSprite.width = 34; playerSprite.height = 34 * PLAYER_AR; // GOAL-009: gerçek PNG en-boy oranı + okunabilirlik için hafif büyütme (30->34)
/* İlaç kalkanı, oyuncunun üstünde: siklamenin çevresinde kalan dozu gösteren
   halka. Panelde ayrı bir çubuk olarak dururken ne işe yaradığı
   anlaşılmıyordu; halka bilgiyi oyuncunun baktığı yerde veriyor. Dolu halka =
   kenarda korunuyorsun. Çizerken koruma yok, halka sönükleşiyor; doz bitince
   halka kesik kesik kırmızıya dönüyor (kenarda da savunmasızsın). */
const shieldG = new PIXI.Graphics();
layerEnt.addChild(playerGlow, shieldG, playerSprite);
function strokeArc(g, cx, cy, r, a0, a1, width, color, alpha){
  const style = { width, color, alpha, cap:'round' };
  g.moveTo(cx + Math.cos(a0)*r, cy + Math.sin(a0)*r);
  if(MAJOR >= 8){ g.arc(cx, cy, r, a0, a1); g.stroke(style); }
  else { g.lineStyle(Object.assign({}, style, { cap:PIXI.LINE_CAP ? PIXI.LINE_CAP.ROUND : 'round' })); g.arc(cx, cy, r, a0, a1); }
}
function drawShield(x, y, t){
  const g = shieldG; g.clear();
  if(G.state !== 'play' && G.state !== 'paused'){ return; }
  const u = playerW/PLAYER_SIZE, dr = clamp(G.dose/Math.max(1, G.doseMax), 0, 1), R = 24*u, top = -Math.PI/2;
  if(dr <= 0){                                 // kırık halka
    const a = .45 + .35*Math.sin(t*7);
    for(let k=0;k<6;k++){ const a0 = top + k/6*Math.PI*2 + .18; strokeArc(g, x, y, R, a0, a0 + .55, 2.6*u, 0xff4d6d, a); }
    return;
  }
  const dim = G.drawing ? .38 : 1;             // çizerken kalkan korumuyor
  const col = dr <= .15 ? 0xff4d6d : dr < .30 ? 0xff9a3c : 0xffc24a;
  const pulse = dr <= .15 ? .55 + .45*Math.sin(t*10) : 1;
  strokeArc(g, x, y, R, 0, Math.PI*2, 2.4*u, 0xffffff, .10*dim);          // iz
  strokeArc(g, x, y, R, top, top + dr*Math.PI*2, 3*u, col, .95*dim*pulse);
  strokeArc(g, x, y, R, top, top + dr*Math.PI*2, 7*u, col, .18*dim*pulse);  // hafif ışıma
}

function pool(container, make, n){
  const a = [];
  for(let i=0;i<n;i++){ const s = make(); s.visible = false; container.addChild(s); a.push(s); }
  return a;
}
/* Kesim çizgisi: tek parça vektör çizgi (yuvarlak köşe ve uç) + aynı
   çizgiden iki kat ışıma. Eskiden her düz parça ayrı bir dikdörtgendi;
   köşelerde boşluk kalıyor, ışıma çekirdekle kayık duruyordu. */
const trailGlowG = new PIXI.Graphics(), trailCoreG = new PIXI.Graphics();
trailGlowG.blendMode = BLEND_ADD;
layerTrail.addChild(trailGlowG, trailCoreG);
function strokePath(g, pts, width, color, alpha){
  if(pts.length < 2) return;
  const style = { width, color, alpha, join:'round', cap:'round' };
  if(MAJOR >= 8){
    g.moveTo(pts[0][0], pts[0][1]); for(let i=1;i<pts.length;i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke(style);
  } else {
    g.lineStyle(Object.assign({}, style, { join:PIXI.LINE_JOIN ? PIXI.LINE_JOIN.ROUND : 'round',
                                           cap:PIXI.LINE_CAP ? PIXI.LINE_CAP.ROUND : 'round' }));
    g.moveTo(pts[0][0], pts[0][1]); for(let i=1;i<pts.length;i++) g.lineTo(pts[i][0], pts[i][1]);
  }
}
const particles = [];
const partSprites = pool(layerEnt, ()=>{ const s = new PIXI.Sprite(TEX.spark);
  s.anchor.set(.5); s.blendMode = BLEND_ADD; return s; }, 300);

/* =========================================================================
   6b. NEFES (GOAL-028)

   Eskiden hava yolu iki noktalıydı: burun deliği halkasından ostium halkasına,
   temizlenmiş hücreler üzerinden bir yol aranıyordu. Bu sahaya iki halka ve
   iki etiket koymayı gerektiriyordu ve oyunu "şu noktayı şu noktaya bağla"
   bulmacasına indirgiyordu — bir kez rotayı bulan oyuncu için her gün aynı
   hamleydi.

   Artık nefes noktasal değil: vücut BÜTÜN boşluktan nefes almayı deniyor.
   Nefes aşağıdan yukarı satır satır ilerliyor; her satırın direnci o satırın
   ne kadarının temizlendiğine bağlı. Nefes ilerledikçe zayıflıyor ve tıkalı
   bir satırda tükeniyor. Nereye kadar gidebildiği (reach) akışı besliyor,
   akış da bütün haritayı etkiliyor (bkz. flowMult, movePlayer, updateEnemies).

   Nerede temizlediğin hâlâ önemli — alt satırlar üsttekilerin önünü açıyor —
   ama ezberlenecek tek bir rota yok; dokuyu açmanın kendisi hedef.
   ========================================================================= */
let breath = { reach:0, hFrac:0, top:false, stallY:GH-1, y0:0, y1:GH-1 };

/* GOAL-027: akışın puana kazandırdığı çarpan. Tek bir yerde tanımlı, çünkü
   hem skor hesabı hem HUD hem de bölüm sonu bonusu aynı sayıyı gösteriyor;
   ayrı ayrı hesaplansalardı biri değişince diğeri yalan söylerdi. */
function flowMult(){ return 1 + G.flow*0.8; }

/* Nefesin şu anda nereye kadar gidebildiği.
   Sönüm katsayısı (.12) şuna göre seçildi: hiç temizlenmemiş bir dokuda nefes
   yirmi küsur satır sonra tükeniyor — yani bölüm başında sıfır değil ama
   neredeyse hiç; tamamen açılmış bir dokuda hiç zayıflamadan tepeye çıkıyor.
   Arada her şey sürekli: tek bir hücre bile nefesi bir parça ileri taşıyor. */
/* GOAL-029: NEFESİN ÖLÇÜMÜ

   İlk sürüm satır satır "kesit alanı" ölçüyordu: her satırın ne kadarı
   temizse nefes o kadar az zayıflıyor, tıkalı bir satırda tükeniyordu. Model
   dikey temizleyene haksızlık ediyordu — boşluğun sol yarısını dipten tepeye
   açmış bir oyuncu kesintisiz açık bir kanal yaratmış oluyor ama her satır
   yarı dolu göründüğü için ölçüm "%40" diyordu. Oysa o kanaldan hava geçer,
   yalnızca daha dar geçer. Sönümü yumuşatmak bunu çözmüyordu: katsayıyı
   düşürünce bu sefer yatay temizleyen, alanın %95'ini açmışken bile son
   kapalı satır duvar gibi kestiği için tam nefes alamıyordu.

   Doğru ayrım, tek bir sayı yerine İKİ EKSEN kullanmak. Nefes aşağıdan
   giriyor (boşluğun en alt sıraları) ve yalnızca temizlenmiş hücreler
   üzerinden yayılıyor. Bu yayılma iki şey söylüyor:

     reach — havanın ULAŞTIĞI doku oranı (hacim). Akış çarpanını bu besliyor.
     hFrac — havanın ÇIKABİLDİĞİ yükseklik (mesafe). Dalganın nereye kadar
             gideceğini ve tıkalı nefesin basınç cezasını bu belirliyor.

   Çarpan tarafı böylece şekilden bağımsız: alanın yarısını yatay da açsan
   dikey de açsan reach 0.50, çarpan aynı. Yükseklik tarafı ise dengesizlik
   değil strateji — genişlemek çarpanı, dipten tepeye bağlanmak basınç
   rahatlamasını getiriyor; ikisi de her oyuncuya açık.

   Yan kazanç: dibe bağlı olmayan kopuk temiz bölgeler akışa sayılmıyor.
   "Dipten yukarı, bağlantılı temizle" öğrenilebilir bir kurala dönüşüyor. */
function computeBreath(){
  bfsSeen.fill(0);
  let qh = 0, qt = 0;
  // Tohum: nefes aşağıdan giriyor — boşluğun en alt üç sırasındaki temiz hücreler.
  // Üç sıra, tek sıralık bir pürüzün (kesitin dip ucu birkaç hücre geniş) bütün
  // ölçümü sıfırlamaması için.
  const seedY = Math.max(breath.y0, breath.y1 - 2);
  for(let y=seedY; y<=breath.y1; y++){
    const row = y*GW;
    for(let x=0;x<GW;x++){
      const i = row+x;
      if(cavity[i] && cells[i] === FILL && !bfsSeen[i]){ bfsSeen[i] = 1; bfsQ[qt++] = i; }
    }
  }
  let reached = 0, topY = breath.y1;
  while(qh < qt){
    const i = bfsQ[qh++], x = i%GW, y = (i/GW)|0;
    reached++;
    if(y < topY) topY = y;
    let nb;
    nb = i-1;  if(x>0    && cavity[nb] && cells[nb]===FILL && !bfsSeen[nb]){ bfsSeen[nb]=1; bfsQ[qt++]=nb; }
    nb = i+1;  if(x<GW-1 && cavity[nb] && cells[nb]===FILL && !bfsSeen[nb]){ bfsSeen[nb]=1; bfsQ[qt++]=nb; }
    nb = i-GW; if(y>0    && cavity[nb] && cells[nb]===FILL && !bfsSeen[nb]){ bfsSeen[nb]=1; bfsQ[qt++]=nb; }
    nb = i+GW; if(y<GH-1 && cavity[nb] && cells[nb]===FILL && !bfsSeen[nb]){ bfsSeen[nb]=1; bfsQ[qt++]=nb; }
  }
  const span = Math.max(1, breath.y1 - breath.y0);
  breath.reach  = clamp(reached/Math.max(1, cavCount), 0, 1);
  breath.hFrac  = reached ? clamp((breath.y1 - topY)/span, 0, 1) : 0;
  breath.top    = breath.hFrac >= .995;
  breath.stallY = reached ? topY : breath.y1;
  G.flowTarget  = breath.reach;
  return breath;
}

const airPuffs = [];
const airPool = pool(layerLight, ()=>{ const s = new PIXI.Sprite(TEX.wind);
  s.anchor.set(.5); s.blendMode = BLEND_ADD; return s; }, 72);

/* GOAL-028: hava artık bir rotayı takip etmiyor; verilen satırda temizlenmiş
   NEREDE bir yer varsa oradan yukarı kopuyor. Nefes dalgası ilerlerken bu
   çağrılıyor, yani hareket bütün sahaya yayılıyor — "hava her yerden geçmeye
   çalışıyor" hissi tam olarak bu. */
function spawnBreathPuffs(gy, count){
  gy = clamp(gy|0, 0, GH-1);
  for(let k=0;k<count;k++){
    let x = -1;
    for(let tries=0;tries<24;tries++){
      const cx = (B + Math.random()*(GW-2*B))|0;
      const i = gy*GW+cx;
      if(cavity[i] && cells[i] === FILL){ x = cx; break; }
    }
    if(x < 0) continue;
    const thin = Math.random() < .5, life = rnd(.55,1.15);
    airPuffs.push({ x:x, y:gy, vx:rnd(-4,4), vy:-(10+Math.random()*18),
      life:life, dur:life, len:thin ? rnd(42,84) : rnd(28,56), thin:thin });
  }
}
function updateAirFlow(dt){
  for(let i=airPuffs.length-1;i>=0;i--){
    const a = airPuffs[i];
    a.x += a.vx*dt; a.y += a.vy*dt; a.life -= dt;
    if(a.life <= 0) airPuffs.splice(i,1);
  }
  if(airPuffs.length > airPool.length) airPuffs.splice(0, airPuffs.length - airPool.length);
  for(let i=0;i<airPool.length;i++){
    const s = airPool[i], a = airPuffs[i];
    if(!a){ s.visible = false; continue; }
    const env = Math.sin(clamp(a.life/a.dur,0,1)*Math.PI);   // belirip sönüyor
    s.visible = true;
    s.rotation = -Math.PI/2;                                  // dikey akış
    s.x = (a.x+.5)*CS; s.y = (a.y+.5)*CS;
    s.width  = a.len*(.6+env*.4);
    s.height = a.thin ? 5 : 14;
    s.tint   = a.thin ? 0xeafffc : 0x8fe4ee;
    s.alpha  = (a.thin ? .5 : .28) * env;
  }
}

/* GOAL-009: uçan skor yazıları — particles[]/partSprites ile birebir aynı
   havuz+yaşam-döngüsü deseni, sadece kıvılcım yerine sayı dokusu çiziyor. */
const scorePops = [];
const scorePopPool = pool(layerEnt, ()=>{ const s = new PIXI.Sprite(TEX.spark);
  s.anchor.set(.5); return s; }, 6);
function spawnScorePopup(gx, gy, amount){
  if(amount <= 0) return;
  const cv = makeCanvas(220,64), c = cv.getContext('2d');
  c.font = '700 34px "Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.shadowColor = '#35e0d8'; c.shadowBlur = 14;
  c.fillStyle = '#eaffFb';
  c.fillText('+'+Math.round(amount).toLocaleString('tr-TR'), 110, 32);
  scorePops.push({ x:gx, y:gy, life:1.1, dur:1.1, tex:texFromCanvas(cv) });
}
function updateScorePops(dt){
  for(let i=scorePops.length-1;i>=0;i--){
    const p = scorePops[i];
    p.life -= dt;
    if(p.life <= 0){ p.tex.destroy(true); scorePops.splice(i,1); }
  }
  for(let i=0;i<scorePopPool.length;i++){
    const s = scorePopPool[i], p = scorePops[i];
    if(!p){ s.visible = false; continue; }
    s.visible = true; s.texture = p.tex;
    const k = 1 - p.life/p.dur;
    s.x = p.x*CS; s.y = p.y*CS - k*46*uiScale;
    s.width = 150*uiScale; s.height = 44*uiScale;
    s.alpha = clamp(p.life/(p.dur*.4), 0, 1);
  }
}

/* =========================================================================
   7. OYUN DURUMU
   ========================================================================= */
const G = {
  state:'title', levelIdx:0, level:LEVELS[0],
  score:0, lives:3,
  px:GW>>1, py:GH-B, frac:0, dir:0, lastDir:0,
  moveDir:0, slide:0,   // GOAL-033: kenar izlemede gerçek adım yönü ve kayma tarafı
  drawing:false, trail:[], corners:[], startCell:0,
  filled:0, pct:0, dose:60, doseMax:60,
  invuln:0, buffs:{},
  bosses:[], minions:[], bullets:[], shots:[], pus:[],
  shake:0, laserCd:0, time:0,
  // GOAL-015: nefes döngüsü ve basınç
  pressure:0, breathT:10, breathStreak:0, breathCue:false, beatT:0,
  airAmbT:0, breathFlash:0, blockFlash:0,
  /* GOAL-028: nefes dalgasının animasyon durumu. waveDur 0 ise dalga yok;
     doBreath() bunu doldurup render() bandı alttan (waveY0) tıkandığı satıra
     (waveY1) taşıyor. fullBreath, nefesin o bölümde ilk kez baştan sona
     geçtiği anı bir kez ödüllendirmek için. */
  waveT:0, waveDur:0, waveY0:0, waveY1:0, waveOk:0, waveTop:false, fullBreath:false,
  /* GOAL-027: AKIŞ — haritanın tamamına etki eden tek sürekli değişken.
     flowTarget o anki nefes ölçümü (breath.reach), flow ise onu yumuşakça
     takip eden görünür değer. Ani sıçramalar yerine dokunun yavaşça açılıp
     kapanması isteniyor; bir hamlede kanalı bağladığında saha bir anda değil
     yarım saniyede canlanıyor. */
  flow:0, flowTarget:0
};
const DIRV = {0:[0,0],1:[1,0],2:[-1,0],3:[0,-1],4:[0,1]};
const OPP  = {1:2,2:1,3:4,4:3};
/* Çok oyunculu oda ve tur durumu (bkz. bölüm 10d). Burada, çünkü syncHUD,
   layout gibi açılışta çalışan yerler de okuyor. */
const mp = {
  code:'', you:0, host:0, players:[], pick:0,   // oda; pick: ev sahibinin seçtiği başlangıç günü
  inRound:false, over:false, round:0, level:0, seed:0, view:'',
  totals:{},    // oyuncu → toplam puan (turlar boyunca)
  fins:{},      // oyuncu → bu turdaki fin iletisi
  order:[],     // hedefe ulaşanlar, varış sırasıyla
  away:{},      // oyuncu → arka planda mı
  live:{},      // oyuncu → son bilinen ilerleme { p, s, l }
  rv:{},        // rakip tahtaları (DOM + tuval)
  snap:null,    // rakip tahtalarının ortak katmanları: günün dokusu, kemik (bkz. mpSnap)
  lay:null,     // yerleşim: rakip grubunun yeri ve ölçeği (bkz. mpSplit)
  mine:null, result:null, goAt:0, t0:0, endsAt:0, sentAt:0, sentP:0, sentS:0,
  mapDirty:false, going:false, waitAt:0, timers:[]
};

/* =========================================================================
   8. ARAYÜZ (DOM)
   ========================================================================= */
const $ = id => document.getElementById(id);
const UI = {
  dayTxt:$('dayTxt'), dayDots:$('dayDots'), name:$('stageName'),
  fill:$('gaugeFill'), goal:$('gaugeGoal'), pct:$('pctRead'),
  score:$('scoreVal'), lives:$('lives'), buffs:$('buffs'),
  toast:$('toast'), toastT:$('toast').querySelector('.t'), toastS:$('toast').querySelector('.s'),
  overlay:$('overlay'), plate:$('plate'), fps:$('fps'),
  menuScreen:$('menuScreen'), menuContent:$('menuContent'),
  // GOAL-015
  airway:$('airway'), airPct:$('airPct'), breathBar:$('breathBar'),
  airFill:$('airFill'), airMark:$('airMark'),
  // GOAL-021: her göstergenin yanında artık sayısal değer de var
  breathVal:$('breathVal'),
  veil:$('pressVeil'), flowVeil:$('flowVeil'),   // GOAL-027
  hint:$('touchHint'),         // GOAL-022: dokunmatik kontrol ipucu
  hudInner:$('hudInner'),      // GOAL-023: eni tahtanın enine bağlanıyor
  rivals:$('rivals'), rvList:$('rvList'), rvClock:$('rvClock'), rvTitle:$('rvTitle')   // çok oyunculu: rakip tahtaları
};
/* İpucu bir kez sürükledikten sonra bir daha gösterilmiyor. */
const HINT_KEY = 'nasodren_touchhint_v1';
let hintSeen = false;
try{ hintSeen = localStorage.getItem(HINT_KEY) === '1'; }catch(e){}
function showTouchHint(on){
  UI.hint.classList.toggle('on', !!on && !hintSeen);
}
function retireTouchHint(){
  if(hintSeen) return;
  hintSeen = true;
  try{ localStorage.setItem(HINT_KEY,'1'); }catch(e){}
  UI.hint.classList.remove('on');
}
let toastTimer = 0;
function toast(main, sub){
  UI.toastT.textContent = main;
  UI.toastS.textContent = sub || '';
  UI.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> UI.toast.classList.remove('on'), 1500);
}
let doseAlertState = 'ok'; // GOAL-013 (madde 7): eşik geçişlerinde tek seferlik uyarı için
/* HUD (yeniden düzen): önem sırası hedef → can → nefes. Gün ve skor küçük.
   Doz kalkanı panelde değil, oyuncunun üstünde halka (bkz. drawShield);
   basınç sürekli bir çubuk değil, yalnızca yükselirken uyarı olarak çıkıyor. */
function syncHUD(){
  const L = G.level;
  UI.dayTxt.textContent = 'Gün ' + L.day + ' / ' + LEVELS.length;
  if(UI.dayDots.childElementCount !== LEVELS.length) UI.dayDots.innerHTML = LEVELS.map(() => '<i></i>').join('');
  UI.dayDots.querySelectorAll('i').forEach((d, k) => { d.className = k < L.day-1 ? 'done' : k === L.day-1 ? 'now' : ''; });
  // GOAL-024: HUD basligi artik gunun temasi degil BOLGE — oyun sirasinda
  // asil gereken bilgi nerede oldugumuz; gunun adi brifingde ve haritada zaten
  // duruyor. Genis ekranda ikisi birden siga.
  UI.name.innerHTML = '<b>'+escapeHtml(L.regionName)+'</b><i>· '+L.sideName+'</i>'
    + '<u>'+escapeHtml(L.name)+'</u>';
  UI.fill.style.width = (G.pct*100).toFixed(1)+'%';
  UI.goal.style.left = (L.target*100)+'%';
  // GOAL-027: hedef artık tek koşul. Hava yolu bir kapı değil, çarpan.
  const met = G.pct >= L.target;
  UI.pct.className = met ? 'met' : '';
  UI.pct.innerHTML = '<span class="lbl">HEDEF</span><b>%'+Math.floor(G.pct*100)+'</b>'
    + '<span class="of">/ %'+Math.round(L.target*100)+'</span>' + (met ? '<span class="done">TAMAM</span>' : '');
  UI.score.textContent = G.score.toLocaleString('tr-TR');
  // GOAL-013 (madde 7): kalkan eşik geçişlerinde tek seferlik uyarı — artık
  // ne yapılacağını da söylüyor. Mekanik değişmedi.
  const dr = clamp(G.dose/G.doseMax,0,1);
  const newDoseState = dr <= .15 ? 'critical' : dr < .30 ? 'warn' : 'ok';
  if(G.state === 'play' && newDoseState !== doseAlertState){
    if(newDoseState === 'critical') toast('KALKAN BİTİYOR', 'Kes: kapattığın alan kalkanı doldurur');
    else if(newDoseState === 'warn') toast('Kalkan zayıflıyor', 'Kenarda bekleme, kes');
  }
  doseAlertState = newDoseState;
  let lv = '';
  for(let i=0;i<3;i++) lv += '<img class="heart'+(i<G.lives?'':' off')+'" src="'+healthAssetUrl+'" alt="can">';
  UI.lives.innerHTML = lv;

  // koşullu uyarılar: basınç (yükselirken), kalkan bitti, güçlendiriciler
  const pr = clamp(G.pressure,0,1);
  Sound.tension(pr);   // GOAL-020: basınç arttıkça müzik hafifçe parlıyor
  let bf = '';
  if(pr >= .08) bf += '<div class="buff press'+(pr >= .6 ? ' high' : '')+'"><b>⚠ BASINÇ %'+Math.round(pr*100)+' · nefes tıkalı</b>'
    + '<span>Düşmanlar hızlanıyor. Dipten tepeye yol aç.</span><em><u style="width:'+(pr*100).toFixed(0)+'%"></u></em></div>';
  if(G.dose <= 0) bf += '<div class="buff warn">Kalkan bitti · kes</div>';
  for(const k in G.buffs){
    const m = PU_META.find(p=>p.key===k);
    bf += '<div class="buff">'+m.letter+' '+Math.ceil(G.buffs[k])+'s</div>';
  }
  if(UI.buffs.innerHTML !== bf){
    UI.buffs.innerHTML = bf;
    // yan çubukta uyarılar HUD'u uzatıyor: bilgi kartı altta kalan yere yeniden sığsın
    if(document.body.classList.contains('hudSide')){ placeInfoRail(innerWidth, innerHeight); Info.fit(); }
  }

  // GOAL-015: nefes geri sayımı + havanın ulaştığı yol, tek modül
  const ar = clamp(breath.reach,0,1), full = breath.top;
  UI.airFill.style.width = (ar*100).toFixed(1)+'%';
  UI.airMark.style.left  = (ar*100).toFixed(1)+'%';
  // GOAL-027: yüzdenin yanında o anki kazanç — "bunu neden istiyorum" sorusunun cevabı
  const pa = Math.round(ar*100);
  UI.airPct.innerHTML = full ? '<b>Yol açık</b> · puan <i>×' + flowMult().toFixed(2) + '</i>'
    : pa < 1 ? '<b>Yol tıkalı</b> · dipten yukarı kes'
    : 'Yolun <b>%' + pa + "'" + pctPoss(pa) + '</b> açık · puan <i>×' + flowMult().toFixed(2) + '</i>';
  UI.airway.classList.toggle('open', full);
  UI.airway.classList.toggle('partial', !full && ar >= .5);
  UI.breathBar.style.width = (clamp(G.breathT/Math.max(1,G.level.breath),0,1)*100).toFixed(1)+'%';
  UI.breathVal.textContent = Math.max(0,Math.ceil(G.breathT))+' sn';
}
function showPanel(html){ UI.hint.classList.remove('on'); UI.plate.innerHTML = html; UI.overlay.classList.add('on'); UI.overlay.scrollTop = 0;
  const b = UI.plate.querySelector('button[data-a]'); if(b) setTimeout(()=>b.focus({preventScroll:true}), 30); }
function hidePanel(){ UI.overlay.classList.remove('on'); }
UI.overlay.addEventListener('click', e=>{
  const b = e.target.closest('button[data-a]'); if(!b) return;
  Sound.init(); Sound.resume(); Sound.ui();
  doAction(b.dataset.a);
});

/* GOAL-014: gerçek tam ekran menü sistemi — ana menü/bölümler/yüksek skorlar
   artık küçük bir kart olarak oyunun ÜSTÜNE binmiyor, ayrı ve opak bir
   "uygulama ekranı" olarak açılıyor (bkz. #menuScreen, index.html). Pause
   bilinçli olarak bunun dışında bırakıldı — o zaten oyunun üstüne binen,
   duraklatılmış oyunu gösteren bir ekran olmalı. */
function showMenuScreen(html){
  UI.hint.classList.remove('on');
  hidePanel(); // olası açık overlay (pause vb.) ile çakışmasın
  UI.menuContent.innerHTML = html;
  UI.menuScreen.classList.add('on'); UI.menuScreen.scrollTop = 0;   // yeni ekran hep başından açılsın
  /* GOAL-026: menü perdesi artık opak değil, buzlu cam — arkada sahanın
     kendisi duruyor. Bu yüzden HUD ve araç düğmeleri camın ardından sızmasın
     diye gizleniyor (display ile değil opacity ile: layout() HUD yüksekliğini
     ölçüyor, display:none olsa kadraj sıçrardı). */
  document.body.classList.add('menuOn');
  const b = UI.menuContent.querySelector('button[data-a]'); if(b) setTimeout(()=>b.focus({preventScroll:true}), 30);
}
function hideMenuScreen(){
  UI.menuScreen.classList.remove('on');
  document.body.classList.remove('menuOn');
}
/* GOAL-026: menüde ok tuşlarıyla gezinme — bir oyun menüsünden beklenen şey,
   ve masaüstünde fareye hiç dokunmadan OYNA'ya basılabiliyor. Yalnızca menü
   ekranı açıkken devrede olduğu için oyunun kendi yön girdisine karışmıyor.
   (Enter/Space'i tarayıcı zaten düğmeye basmak olarak yorumluyor.) */
addEventListener('keydown', e=>{
  if(!UI.menuScreen.classList.contains('on')) return;
  if(e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const btns = Array.prototype.slice.call(UI.menuContent.querySelectorAll('button[data-a]'));
  if(!btns.length) return;
  e.preventDefault();
  const step = e.key === 'ArrowDown' ? 1 : -1;
  const cur  = btns.indexOf(document.activeElement);
  const next = cur < 0 ? (step > 0 ? 0 : btns.length-1)
                       : (cur + step + btns.length) % btns.length;
  btns[next].focus();
  Sound.init(); Sound.resume(); Sound.ui();
});
/* GOAL-020: ses kaydırıcıları. Ayarlar ekranı iki ayrı kapta (duraklatma
   paneli / tam ekran menü) doğabildiği için ikisinde de delegasyonla
   dinleniyor; değer anında uygulanıp localStorage'a yazılıyor. */
function onVolInput(e){
  const el = e.target.closest ? e.target.closest('input[data-vol]') : null;
  if(!el) return;
  const key = el.dataset.vol, v = (parseInt(el.value,10)||0)/100;
  Sound.set(key, v);
  const read = document.getElementById('vol-'+key+'-read');
  if(read) read.textContent = '%'+Math.round(v*100);
  syncSoundBtn();
}
/* Kaydırıcıyı bırakınca kısa bir örnek ses — kaç desibel olduğunu duymadan
   ayarlamak zor. */
function onVolChange(e){
  const el = e.target.closest ? e.target.closest('input[data-vol]') : null;
  if(!el) return;
  if(el.dataset.vol !== 'music') Sound.pickup();
}
UI.overlay.addEventListener('input', onVolInput);
UI.menuScreen.addEventListener('input', onVolInput);
UI.overlay.addEventListener('change', onVolChange);
UI.menuScreen.addEventListener('change', onVolChange);
UI.menuScreen.addEventListener('click', e=>{
  const b = e.target.closest('button[data-a]'); if(!b) return;
  Sound.init(); Sound.resume(); Sound.ui();
  doAction(b.dataset.a);
});

/* =========================================================================
   8b. YÜKSEK SKORLAR
   GOAL-013: ilk sürüm — sadece localStorage, backend yok.
   GOAL-045: artık gerçekten GLOBAL — Supabase'deki `scores` tablosunda
   (bkz. supabase/schema.sql). VITE_SUPABASE_URL/ANON_KEY tanımlı değilse ya da
   istek başarısız olursa (ağ hatası, proje henüz kurulmadıysa) eski yerel
   listeye sessizce geri düşülüyor — oyun hiçbir zaman bu yüzden kırılmıyor,
   sadece "global" yerine "bu tarayıcıya özel" bir listeye dönüyor.
   ========================================================================= */
const HS_KEY = 'nasodren_highscores_v1';
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function loadHighScoresLocal(){
  try{
    const raw = localStorage.getItem(HS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}
function saveHighScoreLocal(name, score, day){
  const list = loadHighScoresLocal();
  list.push({ name, score, day, done:G.state === 'won' });
  list.sort((a,b)=>b.score-a.score);
  list.length = Math.min(list.length, 10);
  try{ localStorage.setItem(HS_KEY, JSON.stringify(list)); }catch(e){}
}
async function loadHighScores(){
  if(SUPABASE_OK){
    try{
      const { data, error } = await supabase.from('volfied_scores').select('name,score,day').order('score', { ascending:false }).limit(10);
      if(error) throw error;
      if(Array.isArray(data)) return data;
    }catch(e){ console.warn('[scores] Supabase okunamadı, yerel listeye dönülüyor:', e); }
  }
  return loadHighScoresLocal();
}
async function saveHighScore(name, score){
  const day = G.level.day;
  if(SUPABASE_OK){
    try{
      const { error } = await supabase.from('volfied_scores').insert({ name, score, day });
      if(error) throw error;
      return;
    }catch(e){ console.warn('[scores] Supabase\'e kaydedilemedi, yerel listeye yazılıyor:', e); }
  }
  saveHighScoreLocal(name, score, day);
}
async function showHighScores(fromGameOver){
  // GOAL-014: ayrı, tam ekran "Yüksek Skorlar" ekranı — ister ana menüden
  // ister oyun-bitti isim girişinden sonra ulaşılsın, aynı ekran.
  // GOAL-045: Supabase ağ isteği gerektirdiği için önce "Yükleniyor…" ile
  // açılıp veri gelince liste yerine konuyor (ekran kapanmayı beklemiyor).
  showMenuScreen(
    `<div class="menuBrand"><div class="kicker">YÜKSEK SKORLAR</div><div class="title">En İyi Tedaviler</div></div>
     <div class="hsList"><p class="lede">Yükleniyor…</p></div>
     <div class="menuStack">
       ${fromGameOver ? '<button class="menuBtn primary" data-a="restart">YENİDEN OYNA</button>' : ''}
       <button class="menuBtn ghost" data-a="mainmenu">◀ ANA MENÜ</button>
     </div>`);
  const list = await loadHighScores();
  const hsListEl = UI.menuContent.querySelector('.hsList');
  if(!hsListEl) return;   // oyuncu bu sırada başka bir ekrana geçmiş olabilir
  hsListEl.innerHTML = list.length
    ? list.map((r,i)=>'<div class="hsRow"><span class="hsRank">'+(i+1)+'</span><span class="hsName">'+escapeHtml(r.name)+'</span><span class="hsScore">'+r.score.toLocaleString('tr-TR')+'</span></div>').join('')
    : '<p class="lede">Henüz skor yok. İlk sen ol!</p>';
}
function showGameOverNameEntry(){
  Sound.scene('menu');   // GOAL-020
  showPanel(
    `<div class="kicker">TEDAVİ YARIM KALDI</div>
     <div class="title">Gün ${G.level.day}</div>
     <div class="stats">
       <div><span>SKOR</span><b>${G.score.toLocaleString('tr-TR')}</b></div>
       <div><span>TEMİZLENEN</span><b>%${Math.floor(G.pct*100)}</b></div>
     </div>
     ${nameEntryHTML()}`);
  bindNameEntry();
}
/* Oyun sonu ad girişi: hem can bitince hem kür tamamlanınca. Skorlar ödül
   ölçütü olduğu için kürü bitiren oyuncunun skoru da kaydedilmeli (eskiden
   zafer ekranında yalnızca "yeniden oyna" vardı, en yüksek skorlar
   kayboluyordu). */
function nameEntryHTML(){
  return `<p class="lede">Skorunu yüksek skor listesine kaydetmek için adını yaz.</p>
     <div class="acts">
       <input id="nameInput" class="nameInput" maxlength="12" placeholder="ADIN">
       <button class="cta" data-a="submitscore">KAYDET</button>
     </div>`;
}
function bindNameEntry(){
  setTimeout(()=>{
    const inp = document.getElementById('nameInput');
    if(!inp) return;
    inp.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); doAction('submitscore'); } });
  }, 40);
}
function showMainMenu(){
  if(mp.code) mpLeave();   // odadan ana menüye dönülüyorsa odadan da çık
  G.state = 'title';
  ClearReveal.cancel();
  Sound.scene('menu');   // GOAL-020
  /* GOAL-026: ana menü yeniden tasarlandı (biçim tarafı için index.html'deki
     GOAL-026 bloğu). Eski hâli iki satır yazı ve dört düz düğmeydi; oyunun
     hiçbir öğesini taşımadığı için herhangi bir oyunun menüsü olabilirdi.

     Üç değişiklik:
       - Ekranın merkezinde bir marka kilidi var ve amblem olarak oyuncunun
         sahada yönettiği siklamen sprite'ının ta kendisi kullanılıyor.
         Menüdeki çiçek ile oynadığın çiçek aynı; ilacın adı da artık tek
         satır künye değil, ekranın en büyük öğesi.
       - Perde saydam olduğu için arkada gün 1'in burun kesiti nefes almaya
         devam ediyor — menüye ayrı bir arka plan görseli üretmek gerekmiyor.
       - Düğmeler "simge | ad | künye" satırlarına dönüştü: OYNA'nın yanında
         kürün kaç gün sürdüğü, YÜKSEK SKORLAR'ın yanında mevcut rekor yazıyor.
         Menü, oyuna girmeden önce oyun hakkında da bir şey söylüyor.

     GOAL-045: en iyi skor artık Supabase'den (ağ isteği) geliyor; menü bunu
     beklemeden açılıyor (önce bilinen son değer, sonra güncelleniyor). */
  const bestTxt = cachedBestScoreTxt;
  showMenuScreen(
    `<div class="menuHero">
       <span class="heroBreath"></span>
       <div class="heroEmblem"><img src="${playerAssetUrl}" alt="Siklamen"></div>
       <div class="wordmark"><span class="w1">SİNÜS</span><span class="w2">HAREKÂTI</span></div>
       <div class="heroSub"><span>NASODREN · SİKLAMEN EKSTRESİ</span></div>
       <div class="heroTag">Sinüsleri <em>geri kazan</em>.</div>
       <div class="heroRule"></div>
     </div>
     <div class="menuStack">
       <button class="menuBtn nav primary" data-a="start"><span class="mbGlyph">►</span
         ><span class="mbLabel">OYNA</span><span class="mbHint">${LEVELS.length} GÜNLÜK KÜR</span></button>
       ${MP_OK ? `<button class="menuBtn nav" data-a="mp"><span class="mbGlyph">⇄</span
         ><span class="mbLabel">BİRLİKTE OYNA</span><span class="mbHint">2-3 KİŞİ</span></button>` : ''}
       <button class="menuBtn nav" data-a="howto"><span class="mbGlyph">?</span
         ><span class="mbLabel">NASIL OYNANIR</span><span class="mbHint">KİM KİMDİR</span></button>
       <button class="menuBtn nav" data-a="levels"><span class="mbGlyph">◈</span
         ><span class="mbLabel">BÖLÜMLER</span><span class="mbHint">GÜN SEÇ</span></button>
       <button class="menuBtn nav" data-a="scores"><span class="mbGlyph">★</span
         ><span class="mbLabel">YÜKSEK SKORLAR</span><span class="mbHint" id="mmBestHint">${bestTxt}</span></button>
       <button class="menuBtn nav" data-a="settings"><span class="mbGlyph">◑</span
         ><span class="mbLabel">AYARLAR</span><span class="mbHint">SES</span></button>
     </div>
     <div class="menuFoot">
       <span>${isTouch ? 'PARMAĞINI SÜRÜKLE' : 'OK TUŞLARI / WASD'}</span><i>·</i>
       <span>${Object.keys(REGIONS).length} BÖLGE · ${LEVELS.length} GÜN</span><i>·</i>
       <span>EN İYİ <b id="mmBestFoot">${bestTxt}</b></span>
     </div>`);
  refreshBestScore();
}
/* GOAL-045: ana menü açıldıktan sonra Supabase'den en iyi skoru çekip, menü
   hâlâ ekrandaysa (oyuncu bu sırada başka yere geçmediyse) iki göstergeyi de
   günceller. Menünün kendisini yeniden çizmiyor — sadece iki metni değiştiriyor. */
let cachedBestScoreTxt = '—';
async function refreshBestScore(){
  const list = await loadHighScores();
  cachedBestScoreTxt = list.length ? list[0].score.toLocaleString('tr-TR') : '—';
  const hintEl = UI.menuContent.querySelector('#mmBestHint');
  const footEl = UI.menuContent.querySelector('#mmBestFoot');
  if(hintEl) hintEl.textContent = cachedBestScoreTxt;
  if(footEl) footEl.textContent = cachedBestScoreTxt;
}
function showLevelSelect(){
  // GOAL-014 (madde 2): kilit sistemi yok, her gün doğrudan başlatılabilir.
  // GOAL-025: bölge adı kartın başlığı; hangi bölümün hangi sinüste geçtiği
  // listeden okunuyor.
  const cards = LEVELS.map((L,i) =>
    `<button class="levelBtn" data-a="pick-${i}">
       <span class="levelDay">GÜN ${String(L.day).padStart(2,'0')} · ${L.sideName}</span>
       <span class="levelName">${L.regionName}</span>
       <span class="levelName" style="color:var(--muted);font-weight:500">${L.name}</span>
     </button>`).join('');
  showMenuScreen(
    `<div class="menuBrand"><div class="kicker">BÖLÜMLER</div><div class="title">Gün Seç</div></div>
     <div class="levelGrid">${cards}</div>
     <div class="menuStack menuBack">
       <button class="menuBtn ghost" data-a="mainmenu">◀ ANA MENÜ</button>
     </div>`);
}

/* =========================================================================
   8c. SES AYARLARI (GOAL-020)
   Müzik ve efekt seviyeleri ayrı ayrı; hem ana menüden hem duraklatma
   ekranından açılıyor, çünkü "şu müziği biraz kıs" isteği çoğu zaman oyunun
   tam ortasında geliyor ve bunun için oyundan çıkmak gerekmemeli.
   ========================================================================= */
let settingsFrom = 'main';
function volRow(key, label, val){
  const pct = Math.round(val*100);
  return `<div class="volRow">
       <div class="volHead"><span>${label}</span><b id="vol-${key}-read">%${pct}</b></div>
       <input class="volSlider" type="range" min="0" max="100" step="1" value="${pct}"
              data-vol="${key}" aria-label="${label} seviyesi">
     </div>`;
}
function settingsBody(){
  return `<div class="volList">
       ${volRow('master','ANA SES',   AudioPrefs.master)}
       ${volRow('music', 'MÜZİK',     AudioPrefs.music)}
       ${volRow('sfx',   'EFEKTLER',  AudioPrefs.sfx)}
     </div>
     <div class="menuStack">
       <button class="menuBtn ghost" data-a="togglesound">${AudioPrefs.muted ? 'SESİ AÇ' : 'SESİ KAPAT'}</button>
       <button class="menuBtn" data-a="settingsback">◀ GERİ</button>
     </div>`;
}
function showSettings(from){
  settingsFrom = (from === 'pause') ? 'pause' : 'main';
  if(settingsFrom === 'pause'){
    // Duraklatma üstünden açıldığında oyun ekranı arkada kalsın diye panel.
    showPanel(`<div class="kicker">AYARLAR</div><div class="title">Ses</div>${settingsBody()}`);
  } else {
    showMenuScreen(
      `<div class="menuBrand"><div class="kicker">AYARLAR</div><div class="title">Ses</div></div>
       ${settingsBody()}`);
  }
}
/* Alt köşedeki hızlı sus düğmesinin görünümü, ayarlar ekranıyla senkron kalsın */
function syncSoundBtn(){
  const b = $('btnSound');
  b.textContent = Sound.on ? 'SES' : 'SUS';
  b.style.color = Sound.on ? '' : 'rgba(255,255,255,.25)';
}

async function doAction(a){
  if(a === 'start' || a === 'restart'){ hideMenuScreen(); G.levelIdx = 0; G.score = 0; G.lives = 3; introLevel(); }
  else if(a === 'go'){ if(mp.inRound) return; Cine.close(); startLevel(); }   // yarışta tur herkeste aynı anda başlıyor
  // GOAL-037: yeni güne bir can desteğiyle başlanıyor (en fazla 3)
  else if(a === 'next'){ G.levelIdx++; G.lives = Math.min(3, G.lives + 1); introLevel(); }
  else if(a === 'howto') showHowTo();
  else if(a === 'retry') startLevel();
  else if(a === 'resume'){ hidePanel(); G.state = 'play'; }
  else if(a === 'mainmenu') showMainMenu();
  else if(a === 'levels') showLevelSelect();
  else if(a === 'scores') showHighScores(false);
  else if(a === 'settings')      showSettings('main');
  else if(a === 'settingspause')  showSettings('pause');
  else if(a === 'settingsback'){  if(settingsFrom === 'pause') showPausePanel(); else showMainMenu(); }
  else if(a === 'togglesound'){   Sound.toggle(); syncSoundBtn(); showSettings(settingsFrom); }
  else if(a.indexOf('pick-') === 0){
    const idx = parseInt(a.slice(5), 10);
    if(!isNaN(idx) && LEVELS[idx]){ hideMenuScreen(); G.levelIdx = idx; G.score = 0; G.lives = 3; introLevel(); }
  }
  else if(a.indexOf('mp') === 0) mpAction(a);   // çok oyunculu (bölüm 10d)
  else if(a === 'submitscore'){
    const inp = document.getElementById('nameInput');
    const name = inp ? inp.value.trim() : '';
    if(!name){ if(inp){ inp.classList.remove('errorShake'); void inp.offsetWidth; inp.classList.add('errorShake'); inp.focus(); } return; }
    await saveHighScore(name.slice(0,12), G.score);
    await showHighScores(true);
  }
}
$('btnSound').onclick = () => {
  Sound.init(); Sound.resume();
  Sound.toggle();
  syncSoundBtn();
};
syncSoundBtn();   // GOAL-020: kayıtlı ayar (localStorage) açılışta yansısın
$('btnPause').onclick = () => togglePause();
// GOAL-014 (madde 4): yatay buton sırası yerine dikey, büyük, gerçek
// oyun-menüsü hissi veren .menuStack/.menuBtn (ana menüyle aynı bileşen).
// GOAL-020: ayarlardan geri dönebilmek için ayrı fonksiyon.
function showPausePanel(){
  /* Oyun içinde açılmış bilgiler tam metinle: telefonda şeritte sayfalanarak
     geçen bir bilgiyi oyuncu burada sakince okuyabiliyor. */
  const seen = (FACTS[G.level.day-1] || []).slice(0, Info.shown + 1).reverse();
  const learned = seen.length ? `<div class="learned" style="--rc:${ANAT_COL[G.level.region].join(',')}">
       <div class="lk">BUGÜNKÜ BİLGİLER · ${escapeHtml(G.level.regionName.toLocaleUpperCase('tr-TR'))}</div>
       <ul>${seen.map(f => `<li><b>${escapeHtml(f.t)}</b><p>${escapeHtml(f.b)}</p></li>`).join('')}</ul>
     </div>` : '';
  showPanel(
    `<div class="kicker">DURAKLATILDI</div>
     <div class="title">Gün ${G.level.day}</div>
     <p class="lede">${G.level.name} · alanın %${Math.floor(G.pct*100)}’i temizlendi, hedef %${Math.round(G.level.target*100)}.</p>
     ${learned}
     <div class="menuStack">
       <button class="menuBtn primary" data-a="resume">DEVAM ET</button>
       <button class="menuBtn" data-a="settingspause">AYARLAR</button>
       <button class="menuBtn" data-a="restart">YENİDEN BAŞLAT</button>
       <button class="menuBtn ghost" data-a="mainmenu">ANA MENÜ</button>
     </div>`);
}
function togglePause(){
  if(mp.inRound){ if(G.state === 'play') mpPauseMenu(); return; }   // yarışta duraklatma yok
  if(G.state === 'play'){ G.state = 'paused'; showPausePanel(); }
  else if(G.state === 'paused'){ hidePanel(); G.state = 'play'; }
}

/* =========================================================================
   9. GİRDİ
   ========================================================================= */
const keys = {};
addEventListener('keydown', e=>{
  // ad / oda kodu yazılırken boşluk yutulmasın, F ve P oyun kısayolu sayılmasın
  if(e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
  keys[e.key] = true;
  if(e.key==='p'||e.key==='P'||e.key==='Escape') togglePause();
  if(e.key==='f'||e.key==='F') UI.fps.classList.toggle('on');
});
addEventListener('keyup', e=>{ keys[e.key] = false; });

const pad = $('pad'), ring = $('ring'), knob = $('knob');
let touchId = null, ox = 0, oy = 0, tdir = 0;
function padDir(cx,cy){
  let dx = cx-ox, dy = cy-oy;
  const dist = Math.hypot(dx,dy);
  if(dist > 50){ const k = (dist-50)/dist; ox += dx*k; oy += dy*k; dx = cx-ox; dy = cy-oy; }
  knob.style.left = (ox+dx*.85)+'px'; knob.style.top = (oy+dy*.85)+'px';
  if(Math.hypot(dx,dy) < 13) return tdir;
  return Math.abs(dx) > Math.abs(dy)*1.15 ? (dx>0?1:2) : (dy>0?4:3);
}
function startStick(cx,cy){
  retireTouchHint();           // GOAL-022
  ox = cx; oy = cy;
  ring.style.left = ox+'px'; ring.style.top = oy+'px';
  knob.style.left = ox+'px'; knob.style.top = oy+'px';
  ring.classList.add('on'); knob.classList.add('on');
}
function endStick(){ touchId = null; tdir = 0; ring.classList.remove('on'); knob.classList.remove('on'); }
pad.addEventListener('touchstart', e=>{
  Sound.init(); Sound.resume();
  if(touchId !== null){ e.preventDefault(); return; }
  const t = e.changedTouches[0];
  touchId = t.identifier; startStick(t.clientX, t.clientY);
  e.preventDefault();
}, {passive:false});
pad.addEventListener('touchmove', e=>{
  for(const t of e.changedTouches) if(t.identifier === touchId) tdir = padDir(t.clientX,t.clientY);
  e.preventDefault();
}, {passive:false});
function endTouch(e){ for(const t of e.changedTouches) if(t.identifier === touchId) endStick(); }
pad.addEventListener('touchend', endTouch);
pad.addEventListener('touchcancel', endTouch);
pad.addEventListener('pointerdown', e=>{
  if(e.pointerType !== 'mouse') return;
  Sound.init(); Sound.resume();
  touchId = 'm'; startStick(e.clientX, e.clientY);
});
addEventListener('pointermove', e=>{ if(touchId === 'm') tdir = padDir(e.clientX,e.clientY); });
addEventListener('pointerup', ()=>{ if(touchId === 'm') endStick(); });
let botDir = null;   // GOAL-037: yalnızca geliştirme modundaki denge testi yazıyor
function readInput(){
  if(botDir !== null) return botDir;
  if(keys.ArrowRight||keys.d||keys.D) return 1;
  if(keys.ArrowLeft ||keys.a||keys.A) return 2;
  if(keys.ArrowUp   ||keys.w||keys.W) return 3;
  if(keys.ArrowDown ||keys.s||keys.S) return 4;
  return tdir;
}

/* =========================================================================
   10. SEVİYE KURULUMU
   ========================================================================= */
function spawnBoss(L, idx){
  const a = idx*Math.PI + rnd(0,1);
  const tier = L.bossTier|0;
  const s = new PIXI.Sprite(TEX.boss[tier]); s.anchor.set(.5);
  const g = new PIXI.Sprite(TEX.glow);
  g.anchor.set(.5); g.blendMode = BLEND_ADD; g.tint = 0xff5a2c; g.alpha = .4;
  layerEnt.addChild(g, s);
  // GOAL-015: sabit merkez yerine gerçekten boşluk olan, çevresi de açık bir hücre
  const c0 = randomCavityCell(Math.ceil(L.bossR*.7));
  return { x:c0.x, y:c0.y,
           vx:Math.cos(a+1)*L.bossSpd, vy:Math.sin(a+1)*L.bossSpd,
           r:L.bossR, spd:L.bossSpd, t:rnd(0,6), fireT:rnd(1,3), s:s, g:g, ar:BOSS_AR[tier] };
}
function spawnMinion(L){
  const a = rnd(0,7), d = rnd(GH*.12, GH*.4), kind = rand()<.55?0:1;
  const s = new PIXI.Sprite(TEX.mini[kind]);
  s.anchor.set(.5); s.width = 30; s.height = 30 * MINI_AR[kind]; // GOAL-012: en-boy oranı korunuyor, görünür boyut hissi (30) aynı
  layerEnt.addChild(s);
  const c0 = randomCavityCell(3);   // GOAL-015
  return { x:c0.x, y:c0.y,
           vx:Math.cos(a*2.3)*L.miniSpd, vy:Math.sin(a*1.7)*L.miniSpd,
           r:2.4, kind:kind, spin:rnd(-1.6,1.6), s:s };
}
function clearEntities(){
  for(const b of G.bosses){ b.s.destroy(); b.g.destroy(); }
  for(const m of G.minions) m.s.destroy();
  for(const b of G.bullets) b.s.destroy();
  for(const s of G.shots) s.s.destroy();
  for(const p of G.pus){ p.s.destroy(); p.g.destroy(); }
  G.bosses=[]; G.minions=[]; G.bullets=[]; G.shots=[]; G.pus=[];
}
let preparedIdx = -1;
function prepareLevel(idx){
  if(preparedIdx === idx) return;
  const L = LEVELS[idx];
  buildCavity(L);                        // GOAL-015: önce kesit, sonra boyalar
  paintHealthy(L); texUpdate(bgTex);
  paintTissue(L);
  paintWalls(L); texUpdate(wallTex);
  preparedIdx = idx;
}
function startLevel(){
  const L = LEVELS[G.levelIdx];
  G.level = L;
  // GOAL-015: ızgara artık kesite bağlı olduğu için prepareLevel resetGrid'den ÖNCE
  ClearReveal.cancel(); ClearReveal.tok++;
  clearEntities(); prepareLevel(G.levelIdx); resetGrid();
  rasterRegion(0,0,GW,GH);
  G.filled=0; G.pct=0; G.drawing=false; G.trail=[]; G.corners=[];
  const st = playerStart();
  G.dir=0; G.frac=0; G.lastDir=0; G.px=st.x; G.py=st.y; G.startCell=G.py*GW+G.px;
  G.pressure=0; G.breathT=L.breath; G.breathStreak=0; G.breathCue=false; G.beatT=0;
  airPuffs.length = 0;
  G.airAmbT = 0; G.breathFlash = 0; G.blockFlash = 0;
  G.flow = 0; G.flowTarget = 0;   // GOAL-027
  G.waveT = 0; G.waveDur = 0; G.waveOk = 0; G.waveTop = false; G.fullBreath = false;
  UI.airway.classList.remove('soon');
  computeBreath();
  G.doseMax=L.dose; G.dose=L.dose; G.buffs={}; G.invuln=1.2; G.shake=0;
  particles.length = 0;
  // çok oyunculu: düşman ve güçlendiricilerin ilk yerleri herkeste aynı (tohum sunucudan)
  if(mp.inRound) rand = seeded(mp.seed);
  for(let i=0;i<L.bossN;i++) G.bosses.push(spawnBoss(L,i));
  for(let i=0;i<L.mini;i++)  G.minions.push(spawnMinion(L));
  const kinds = [PU.SPEED,PU.FREEZE,PU.LASER,PU.BOMB,PU.DOSE];
  for(let i=0;i<L.pu;i++){
    const k = kinds[i%kinds.length];
    const s = new PIXI.Sprite(TEX.pu[k]); s.anchor.set(.5); s.width = s.height = puW;
    const g = new PIXI.Sprite(TEX.glow);
    g.anchor.set(.5); g.width = g.height = 2.35*puW; g.blendMode = BLEND_ADD; g.alpha = .3;
    g.tint = parseInt(PU_META[k].color.slice(1),16);
    layerEnt.addChild(g, s);
    const pc = randomCavityCell(1);   // GOAL-015
    G.pus.push({ x:pc.x, y:pc.y, k:k, s:s, g:g, t:rnd(0,6) });
  }
  rand = Math.random;
  hidePanel(); Cine.close();
  Info.reset(L);               // GOAL-031: bilgi şeridi ilk kesimde açılıyor
  Guide.levelStart(L);         // GOAL-038: isim etiketleri ve ilk oyun rehberi
  G.state = 'play';
  Sound.scene(L.music, L.day); // GOAL-020/024: bölgenin ritimli müziği
  showTouchHint(isTouch);      // GOAL-022: ilk sürüklemeye kadar
  syncHUD();
}
/* =========================================================================
   10b. BÖLÜM GİRİŞ SAHNESİ (GOAL-031)

   Eskiden her gün uzun metinli bir brifing paneliyle açılıyordu; oyuncu
   hangi sinüsü açacağını ancak okuyarak öğreniyordu. Şimdi ekranı kaplayan
   dört saniyelik bir sahne var:

     1. Yüzün üstünde bütün sinüsler: açılmışlar turkuaz, bugünkü kızarık ve
        nabız atıyor, sıradakiler soluk. Harita aynı zamanda yolculuğun
        kendisi — siklamen burun deliğinden bugünün sinüsüne kadar süzülüyor.
     2. Kamera o sinüse dalıyor.
     3. Yüzdeki biçim, tahtadaki gerçek kesite dönüşüyor: kesitin silüeti
        tahtanın TAM ekrandaki yerine çiziliyor ve yukarıdan aşağı bir tarama
        onu belirginleştiriyor.
     4. Perde inceliyor, arkada hazırlanmış tahta görünüyor; yanında künye.

   Her an dokunarak/tuşla atlanabiliyor; hareket azaltma tercihi olan
   oyuncuya doğrudan son kare gösteriliyor.
   ========================================================================= */
/* Yüz uzayı: x -1..1 (negatif = ekranın solu, oyundaki "sol" taraf),
   y -1.3 (tepe) .. 1.3 (çene). Biçimler sol taraf için; sağ taraf aynası. */
/* GOAL-034: harita, tahtaların çizildiği tek anatomiyi (ANAT) çiziyor — biçim,
   renk (ANAT_COL), kanallar ve bölmeler tahtadakiyle aynı tanımdan. */
/* Etiketler illüstrasyondaki gibi yüzün sağında, ince bir çizgiyle bağlı:
   [etiketin yüksekliği, sağ taraftaki çapa noktası] (yüz birimi) */
const FACE_LABEL = { frontal:[IMG([0,172])[1], IMG([190,170])], ethmoid:[IMG([0,212])[1], IMG([186,214])],
                     nasal:[IMG([0,244])[1], IMG([181,246])], maxillary:[IMG([0,268])[1], IMG([212,258])] };
/* Biçimi harita görselinden gelen sinüste çapa, sağ taraftaki yeni biçimin
   içinde: ağırlık merkezinden sağa, hâlâ boşluğun içinde kalan en uzak nokta. */
for(const rg in FACE_LABEL) if(boardMasks[rg + '_sag'] && boardMasks[rg + '_sag'].win){
  const P = ANAT[rg].sag, m = polyAreaCentroid(P);
  const inside = (x, y) => { let k = false;
    for(let i=0, j=P.length-1; i<P.length; j=i++)
      if((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0]-P[i][0])*(y-P[i][1])/(P[j][1]-P[i][1]) + P[i][0]) k = !k;
    return k; };
  let ax = m.cx;
  for(let t=0; t<1; t+=.02){ const x = m.cx + t*.3; if(inside(x, m.cy)) ax = x; else break; }
  FACE_LABEL[rg][1] = [m.cx + (ax - m.cx)*.6, m.cy];
}
/* "alanın %66'sını": yüzdenin okunuşunun son kelimesine göre iyelik + belirtme
   eki (altı → sını, yetmiş → ini, seksen → ini, yüz → ünü) */
function pctAcc(n){
  const U = ['','ini','sini','ünü','ünü','ini','sını','sini','ini','unu'];
  const T = ['','unu','sini','unu','ını','sini','ını','ini','ini','ını'];
  n = Math.round(n);
  return n % 10 ? U[n % 10] : (n % 100 ? T[(n/10|0) % 10] : 'ünü');
}
/* "yolun %6'sı": iyelik eki (belirtme ekinin son hecesi düşmüş hâli; 0 = sıfır → ı) */
function pctPoss(n){ return Math.round(n) === 0 ? 'ı' : pctAcc(n).slice(0, -2); }
const rgbaA = (c, a) => 'rgba('+c[0]+','+c[1]+','+c[2]+','+a.toFixed(3)+')';
/* Bugünün sinüs(ler)inin yüz haritasındaki sınır kutusu */
function faceBBox(L){
  let x0 = 9, y0 = 9, x1 = -9, y1 = -9;
  for(const sd of daySides(L)) for(const p of ANAT[L.region][sd]){
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1, w:x1-x0, h:y1-y0 };
}
/* Yumuşak, kenarı sönen elips — yüzdeki ışık ve gölgeler için */
function faceSoft(c, x, y, rx, ry, col){
  c.save(); c.translate(x, y); c.scale(rx, ry);
  const g = c.createRadialGradient(0,0,0, 0,0,1);
  g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.beginPath(); c.arc(0,0,1,0,7); c.fill(); c.restore();
}
/* Yüz (GOAL-036): oranlar sinuzit.jfif'teki önden portreden — baş hattı, göz,
   kaş, burun, ağız, kulak ve boyun görsel pikseliyle yerleştirildi (IMG), yani
   sinüsler yüzde görseldeki yerlerinde duruyor. Ten sıcak ama kısık tonda —
   karanlık sahnede parlamasın, üstüne binen renkli sinüsler okunsun. */
const FACE_HEAD = imgPts([[168.5,40],[120,48],[85,70],[62,105],[52,145],[50,190],[54,250],[62,285],[78,320],[100,350],
  [130,375],[168.5,386],[207,375],[237,350],[259,320],[275,285],[283,250],[287,190],[285,145],[275,105],[252,70],[217,48]]);
function paintFace(c){
  const P = (x, y) => IMG([x, y]);
  const mir = x => 337 - x;                         // görselde orta hat 168.5
  // boyun
  let g = c.createLinearGradient(0, P(0,350)[1], 0, P(0,470)[1]);
  g.addColorStop(0,'#8a665d'); g.addColorStop(.6,'#5f4540'); g.addColorStop(1,'rgba(40,28,26,0)');
  c.fillStyle = g;
  blob(c, imgPts([[108,340],[104,400],[80,470],[257,470],[233,400],[229,340]]));
  // kulaklar
  for(const s of [0, 1]){
    const X = x => s ? mir(x) : x;
    const e = imgPts([[52,188],[40,192],[34,210],[36,232],[42,248],[54,256]].map(q => [X(q[0]), q[1]]));
    g = c.createLinearGradient(e[0][0], 0, e[2][0], 0);
    g.addColorStop(0,'#a57f72'); g.addColorStop(1,'#80605a');
    c.fillStyle = g; blob(c, e);
    c.strokeStyle = 'rgba(90,55,50,.45)'; c.lineWidth = .012; c.lineCap = 'round';
    c.beginPath(); splinePath(c, imgPts([[48,198],[41,206],[40,224],[45,240]].map(q => [X(q[0]), q[1]])), false); c.stroke();
  }
  // baş
  const cx = 0, cy = P(0,215)[1];
  g = c.createRadialGradient(cx, cy-.1, .08, cx, cy, 1.45);
  g.addColorStop(0,'#d6b0a0'); g.addColorStop(.5,'#c39b8b'); g.addColorStop(.82,'#9d786c'); g.addColorStop(1,'#77574f');
  c.fillStyle = g; c.beginPath(); splinePath(c, FACE_HEAD, true); c.fill();
  c.save(); c.beginPath(); splinePath(c, FACE_HEAD, true); c.clip();
  g = c.createRadialGradient(cx, cy, .78, cx, cy, 1.4);
  g.addColorStop(0,'rgba(50,28,26,0)'); g.addColorStop(1,'rgba(50,28,26,.42)');
  c.fillStyle = g; c.fillRect(-1.6,-1.8,3.2,3.4);
  const soft = (x, y, rx, ry, col) => { const q = P(x, y); faceSoft(c, q[0], q[1], rx, ry, col); };
  soft(168.5,125, .55,.34, 'rgba(255,240,230,.16)');              // alın ışığı
  soft(168.5,235, .045,.3, 'rgba(255,240,230,.16)');              // burun sırtı
  soft(168.5,266, .06,.035, 'rgba(255,240,230,.22)');             // burun ucu
  for(const s of [0, 1]){
    const X = x => s ? mir(x) : x;
    soft(X(118),196, .24,.12, 'rgba(90,52,48,.22)');               // göz çukuru
    soft(X(100),258, .2,.12, 'rgba(214,112,104,.13)');             // yanak
    soft(X(80),300, .2,.3, 'rgba(80,46,42,.16)');                  // elmacık altı
    soft(X(154),245, .045,.2, 'rgba(90,52,48,.14)');               // burnun yanı
  }
  soft(168.5,285, .12,.035, 'rgba(90,50,45,.28)');                 // burun altı gölgesi
  soft(168.5,355, .22,.12, 'rgba(255,236,226,.12)');               // çene
  soft(168.5,395, .6,.2, 'rgba(60,34,32,.4)');
  c.restore();
  // saç: kısa, alnı açık bırakıyor
  g = c.createLinearGradient(0, P(0,30)[1], 0, P(0,120)[1]);
  g.addColorStop(0,'#3a2a26'); g.addColorStop(1,'#241917');
  c.fillStyle = g;
  blob(c, imgPts([[50,150],[52,105],[76,66],[118,40],[168.5,32],[219,40],[261,66],[285,105],[287,150],
                  [276,122],[258,96],[225,86],[190,88],[168.5,90],[147,88],[112,86],[79,96],[61,122]]));
  c.lineCap = 'round'; c.lineJoin = 'round';
  for(const s of [0, 1]){
    const X = x => s ? mir(x) : x, Q = (x, y) => P(X(x), y);
    // kaş
    c.strokeStyle = 'rgba(70,44,38,.85)'; c.lineWidth = .03;
    c.beginPath(); splinePath(c, [Q(90,184), Q(112,178), Q(134,179), Q(149,184)], false); c.stroke();
    // açık göz: akı, iris, bebek, ışık
    const e0 = Q(95,200), e1 = Q(142,200), ec = Q(118,200), up = Q(118,192)[1], dn = Q(118,207)[1];
    c.save();
    c.beginPath(); c.moveTo(e0[0], e0[1]); c.quadraticCurveTo(ec[0], up - .02, e1[0], e1[1]);
    c.quadraticCurveTo(ec[0], dn + .01, e0[0], e0[1]);
    c.fillStyle = '#ece3de'; c.fill(); c.clip();
    c.fillStyle = '#5d7c90'; c.beginPath(); c.arc(ec[0], ec[1], .042, 0, 7); c.fill();
    c.fillStyle = '#1c2226'; c.beginPath(); c.arc(ec[0], ec[1], .018, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(ec[0] + (s ? .012 : -.012), ec[1]-.014, .008, 0, 7); c.fill();
    faceSoft(c, ec[0], ec[1]-.034, .12,.028, 'rgba(90,52,48,.35)');   // üst kapak gölgesi
    c.restore();
    c.strokeStyle = '#4a2f2a'; c.lineWidth = .012;                  // kirpik çizgisi
    c.beginPath(); c.moveTo(e0[0], e0[1]); c.quadraticCurveTo(ec[0], up - .025, e1[0], e1[1]); c.stroke();
    c.strokeStyle = 'rgba(90,55,50,.35)'; c.lineWidth = .007;       // kapak kıvrımı
    const k0 = Q(97,194), k1 = Q(140,194);
    c.beginPath(); c.moveTo(k0[0], k0[1]); c.quadraticCurveTo(ec[0], up - .06, k1[0], k1[1]); c.stroke();
    // burun kanadı ve deliği
    c.strokeStyle = 'rgba(110,68,60,.6)'; c.lineWidth = .012;
    c.beginPath(); splinePath(c, [Q(152,254), Q(146,262), Q(147,270), Q(154,275)], false); c.stroke();
    const n = Q(157,272);
    c.fillStyle = 'rgba(78,42,38,.65)';
    c.beginPath(); c.ellipse(n[0], n[1], .03, .014, s ? -.35 : .35, 0, 7); c.fill();
  }
  // dudaklar
  const L0 = P(134,312), L1 = P(203,312), Lc = P(168.5,312), U = P(168.5,304)[1], D = P(168.5,324)[1];
  c.fillStyle = '#b06a66';
  c.beginPath(); c.moveTo(L0[0], L0[1]); c.quadraticCurveTo(P(150,303)[0], U, P(161,305)[0], U+.01);
  c.quadraticCurveTo(0, U+.018, P(176,305)[0], U+.01); c.quadraticCurveTo(P(187,303)[0], U, L1[0], L1[1]);
  c.quadraticCurveTo(0, Lc[1]+.012, L0[0], L0[1]); c.fill();
  c.fillStyle = '#bf7a74';
  c.beginPath(); c.moveTo(L0[0]+.01, L0[1]+.002); c.quadraticCurveTo(0, Lc[1]+.012, L1[0]-.01, L1[1]+.002);
  c.quadraticCurveTo(P(185,322)[0], D, 0, D+.004); c.quadraticCurveTo(P(152,322)[0], D, L0[0]+.01, L0[1]+.002); c.fill();
  c.strokeStyle = 'rgba(96,48,46,.8)'; c.lineWidth = .009;
  c.beginPath(); c.moveTo(L0[0], L0[1]); c.quadraticCurveTo(0, Lc[1]+.014, L1[0], L1[1]); c.stroke();
  faceSoft(c, 0, D-.02, .07,.02, 'rgba(255,236,226,.25)');
}

const Cine = {
  el:$('cine'), cv:$('cineCv'), title:$('cineTitle'), card:$('cineCard'), skipBtn:$('cineSkip'),
  ctx:null, faceCv:null, maskCv:makeCanvas(HW,HH),
  active:false, ended:false, t0:0, raf:0, L:null, idx:0, cues:0,
  paths:[], dpr:1, W:0, H:0, s0:1, o0:[0,0],
  END:3.9,
  /* Yüz haritasında sinüs adları ancak ~0,4 sn tam görünüyordu; okunmadan
     yakınlaşma başlıyordu. İlaç hedefe vardığı anda (HOLD_AT) sahne HOLD
     saniye duruyor, etiketler bu sürede tam okunur. Sahnenin geri kalan
     zamanlaması değişmedi: frame() gerçek süreyi bu duraklamayla eşliyor. */
  HOLD_AT:1.35, HOLD:1.2,
  sceneT(raw){ return raw < this.HOLD_AT ? raw : Math.max(this.HOLD_AT, raw - this.HOLD); },
  curtain(){
    this.el.classList.add('on','prep'); this.el.classList.remove('ended');
    this.el.style.background = '#04090d';
    this.title.classList.remove('on','rest'); this.card.classList.remove('on');
    document.body.classList.add('cineOn');
  },
  play(L, idx){
    this.el.classList.remove('prep');
    this.L = L; this.idx = idx; this.cues = 0;
    this.active = true; this.ended = false;
    this.el.classList.add('on'); this.el.classList.remove('ended');
    this.el.style.background = '';
    document.body.classList.add('cineOn');
    const T = this.title;
    T.querySelector('.k').textContent = 'GÜN ' + String(L.day).padStart(2,'0') + ' · ' + L.sideLong;
    T.querySelector('b').textContent = L.regionName;
    T.querySelector('i').textContent = L.name;
    T.classList.remove('on','rest');
    this.buildCard(L);
    this.card.classList.remove('on');
    this.buildMask(L);
    this.resize();
    this.t0 = performance.now();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) this.t0 -= (this.END + this.HOLD)*1000;
    cancelAnimationFrame(this.raf);
    const step = () => { if(!this.active) return; this.frame(); if(!this.ended) this.raf = requestAnimationFrame(step); };
    this.raf = requestAnimationFrame(step);
  },
  /* Künye kartı. Sıra okunma önceliği: önce ne yapılacak (hedef, büyük),
     sonra bugün ne değişti, sonra günün üç oyuncusu ikonla (nefes, virüs,
     mikrop), en son bölge bilgisi ve günün bilgi görseli. Her gün aynı olan
     uzun kural paragrafı ikon satırına indi; değişen tek şey öne çıkıyor. */
  buildCard(L){
    const thumb = plateThumbURL(L), cap = PLATE_CAPS[L.theme] || '';
    const i = L.day-1, P = LEVELS[i-1], pct = Math.round(L.target*100);
    const TIER = ['Küçük hâli', 'Büyüdü', 'En büyük, en hızlı'];
    const BOSS_URL = [bossAssetUrl, boss2AssetUrl, boss3AssetUrl];
    const news = [];
    if(P && P.region !== L.region) news.push({ t:'Yeni bölge: ' + L.regionName });
    if(P && P.bossTier !== L.bossTier) news.push({ t:L.bossTier === 2 ? 'Virüs en büyük ve en hızlı hâlinde' : 'Virüs büyüdü',
                                                   img:BOSS_URL[L.bossTier] });
    if(P && P.region === L.region && P.side !== L.side)
      news.push({ t:L.pair ? 'İki taraf birlikte: sağ ve sol tek alanda' : 'Aynı bölgenin ' + L.sideName.toLocaleLowerCase('tr-TR') + ' tarafı' });
    const newsHtml = news.length ? `<div class="ccNew"><span>BUGÜN YENİ</span>${news.map(n =>
        `<p>${n.img ? `<img src="${n.img}" alt="">` : ''}${escapeHtml(n.t)}</p>`).join('')}</div>` : '';
    this.card.innerHTML =
      `<div class="ccMain">
         <div class="ccK">GÜN ${String(L.day).padStart(2,'0')} &nbsp;·&nbsp; ${L.sideLong}</div>
         <div class="ccT">${escapeHtml(L.regionName)}</div>
         <div class="ccS">${escapeHtml(L.name)}</div>
         <div class="ccGoal"><span>HEDEF</span><b>Alanın <em>%${pct}</em>'${pctAcc(pct)} temizle</b></div>
         ${newsHtml}
         <div class="ccIcons">
           <div><span class="ccIc howBreath"></span><b>Nefes · ${L.breath.toFixed(0)} sn</b><i>Dipten tepeye aç: puan ×1,8</i></div>
           <div><img class="ccIc" src="${BOSS_URL[L.bossTier|0]}" alt=""><b>Virüs</b><i>${TIER[L.bossTier|0]}</i></div>
           <div><span class="ccIc ccPair"><img src="${minionFlagellaAssetUrl}" alt=""><img src="${minionSporeAssetUrl}" alt=""></span>
             <b>Mikrop · ${L.mini}</b><i>Çizgini keser</i></div>
         </div>
         <p class="ccA">${escapeHtml(L.regionAbout)}</p>
       </div>
       <div class="ccSide">
         ${thumb ? `<div class="plateShot"><img src="${thumb}" alt=""><div><b>${cap}</b><p>${L.med}</p></div></div>` : ''}
         ${mp.inRound ? `<div class="acts"><b class="mpCount" id="mpCount" role="timer">Hazırlanın…</b>
           <span class="ccHint">${mp.players.length} kişi yarışıyor · hedefe ilk ulaşan kazanır</span></div>`
         : `<div class="acts"><button class="cta" data-a="go">BAŞLA</button>
           <span class="ccHint">${isTouch ? 'Dokun ve başla' : 'Enter ile başla'}</span></div>`}
       </div>`;
  },
  /* Tahtadaki kesitin silüeti: kızarık dolgu + ince ışıklı kenar. Tahta ile
     aynı maske (cavSoft) kullanıldığı için perde kalkınca birebir örtüşüyor. */
  buildMask(L){
    const c = this.maskCv.getContext('2d'), img = c.createImageData(HW,HH), d = img.data;
    const col = hex2rgb(L.pal[2]);
    for(let i=0;i<HW*HH;i++){
      const v = cavSoft[i]; if(v <= .01) continue;
      const a = sstep(.3,.7,v), rim = 4*v*(1-v);
      d[i*4]   = lerp(col[0], 236, rim*.85);
      d[i*4+1] = lerp(col[1], 252, rim*.85);
      d[i*4+2] = lerp(col[2], 250, rim*.85);
      d[i*4+3] = clamp(a*120 + rim*rim*255, 0, 255);
    }
    c.putImageData(img,0,0);
  },
  resize(){
    if(!this.active) return;
    const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio||1, 2);
    this.W = w; this.H = h; this.dpr = dpr;
    this.cv.width = Math.round(w*dpr); this.cv.height = Math.round(h*dpr);
    this.ctx = this.cv.getContext('2d');
    // yüz, ekran yüksekliğinin ~%84'üne sığıyor; dar ekranda enine
    // baş (saç tepesi -1.53 .. çene 1.12) ekran yüksekliğinin ~%84'ü; dar ekranda enine
    this.s0 = Math.min(h*.84/2.66, w*.94/1.85);
    this.o0 = [w/2, h*.5 + this.s0*.205];
    const fc = this.faceCv || (this.faceCv = document.createElement('canvas'));
    fc.width = this.cv.width; fc.height = this.cv.height;
    const c = fc.getContext('2d');
    c.setTransform(dpr*this.s0,0,0,dpr*this.s0, dpr*this.o0[0], dpr*this.o0[1]);
    c.clearRect(-9,-9,18,18);
    paintFace(c);
    this.buildPath();
    this.placeCard();
    if(this.ended) this.frame();
  },
  /* Siklamenin yolu: o tarafın burun deliğinden, gerçekte izlenen anatomik
     rotayla bugünün sinüsüne — burun boşluğu, sinüslerin ortak kapısı (OMC),
     frontal için etmoidin yanından yukarı. Eğri örneklenip uzunluğu ölçülüyor
     (ilerleyen uç için). İki taraflı günde her tarafa bir yol. */
  buildPath(){
    this.paths = daySides(this.L).map(sd => this.sidePath(this.L.region, sd));
  },
  sidePath(region, sd){
    const D = DRAIN[sd];
    const ctr = rg => { const c = polyAreaCentroid(ANAT[rg][sd]); return [c.cx, c.cy]; };
    const P = q => IMG(q);
    // burun deliği → septum boyunca ortak meatus (konkaların iç ucu ile septum arası)
    const base = [P(D.nostril), P(D.low), P(D.under)];
    let pts;
    if(region === 'nasal') pts = [P(D.nostril), P(D.low), ctr('nasal')];
    else if(region === 'maxillary')       // orta konkanın altından orta meatusa, infundibulumdan ostiuma
      pts = base.concat([P(D.tuck), P(D.meatusLo)], D.maxDuct.slice().reverse(), [ctr('maxillary')]);
    else if(region === 'ethmoid')         // kolonla yukarı, hücre ağzından içeri
      pts = base.concat([P([D.under[0], 234]), P(D.ethDuct), ctr('ethmoid')]);
    else                                   // OMC'den frontal resessle yukarı
      pts = base.concat([P([D.under[0], 234])], D.frDuct.slice().reverse(), [ctr('frontal')]);
    const out = [], Q = i => pts[Math.max(0, Math.min(pts.length-1, i))];
    for(let i=0;i<pts.length-1;i++){
      const p0 = Q(i-1), p1 = Q(i), p2 = Q(i+1), p3 = Q(i+2);
      for(let k=0;k<16;k++){
        const t = k/16, t2 = t*t, t3 = t2*t;
        out.push([0,1].map(j => .5*((2*p1[j]) + (-p0[j]+p2[j])*t + (2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*t2
          + (-p0[j]+3*p1[j]-3*p2[j]+p3[j])*t3)));
      }
    }
    out.push(pts[pts.length-1]);
    let L = 0; const cum = [0];
    for(let i=1;i<out.length;i++){ L += Math.hypot(out[i][0]-out[i-1][0], out[i][1]-out[i-1][1]); cum.push(L); }
    return { pts:out, cum, len:L };
  },
  /* Kartın yeri: tahtanın solunda yer varsa orada (tahta tamamen görünür),
     yoksa altta. Altta durduğunda kart "yalın": başlık kartın içinden çıkıp
     ekranın üstündeki boş banda (oyunda HUD'un yeri) yerleşiyor, kart da
     alçalıp tahtanın daha azını örtüyor. Ekran genişse iki sütun. */
  placeCard(){
    const cd = this.card, fr = scrFrame, side = fr.x0;
    cd.classList.remove('side','bottom','wide','lean','scroll');
    cd.style.width = cd.style.left = cd.style.top = cd.style.maxHeight = '';
    /* Kısa ekranda (yatay telefon, 320 px telefon) kart ekrana sığmıyor,
       BAŞLA ekranın dışında kalıyordu — dokunmatikte günü başlatmanın tek
       yolu o düğme. Sığmıyorsa kart ekran yüksekliğiyle sınırlanıyor, içi
       kaydırılıyor, BAŞLA altta yapışık kalıyor (.scroll). */
    const fitH = () => {
      const room = this.H - 32 - safeB;
      if(cd.offsetHeight > room){ cd.classList.add('scroll'); cd.style.maxHeight = room + 'px'; cd.scrollTop = 0; }
    };
    if(side >= 300){
      cd.classList.add('side');
      const w = Math.min(430, side - 36);
      cd.style.width = w + 'px';
      cd.style.left = Math.max(16, (side - w)/2) + 'px';
      fitH();
      cd.style.top = Math.max(16, Math.min(this.H - cd.offsetHeight - 16, (fr.y0+fr.y1)/2 - cd.offsetHeight/2)) + 'px';
    } else {
      cd.classList.add('bottom','lean');
      if(this.W >= 720) cd.classList.add('wide');
      fitH();
    }
    this.lean = !cd.classList.contains('side');
  },
  /* Bütün sinüsler ve kanalları (tahtalarla aynı tanım).
     Durum: sıradakiler soluk, açılmışlar dolu renk + turkuaz "temiz" kenar,
     bugünkü parlak, nabızlı ve beyaz kenarlı. Bugünün tahtasına girmeyen
     yapılar dalış başlarken sönüyor; tahtanınkiler silüete kadar kalıyor.
     GOAL-039: iki taraflı günde bugünün iki sinüsü önce yüzden öne çıkıyor
     (lift: büyüyüp gölge salıyor), sonra dalışla birlikte orta hatta doğru
     kayıp kaynaşıyor (join) — join 1'de tam olarak tahtanın biçimi. */
  drawAnatomy(c, px, allA, nowA, pulse, lift, join){
    const L = this.L, idx = this.idx, tSides = daySides(L);
    lift = lift || 0; join = join || 0;
    const dayOf = (rg, sd) => { for(let i=0;i<LEVELS.length;i++) if(DAY_REGION[i] === rg && DAY_SIDE[i] === sd) return i; return -1; };
    const isNow = (rg, sd) => rg === L.region && tSides.includes(sd);
    const style = (rg, sd) => {
      const col = ANAT_COL[rg], d = dayOf(rg, sd), now = isNow(rg, sd);
      const a = now ? nowA : allA;
      if(now) return { a, fill:rgbaA(col, .56 + .28*pulse), stroke:'rgba(255,255,255,.95)', lw:2.2, col, fa:.56 + .28*pulse };
      if(d >= 0 && d < idx) return { a, fill:rgbaA(col, .62), stroke:'rgba(120,244,236,.95)', lw:2, col, fa:.62 };
      return { a, fill:rgbaA(col, .42), stroke:rgbaA(col.map(v => v*.55|0), .85), lw:1.3, col, fa:.42 };
    };
    const shape = (rg, sd, st) => {
      c.globalAlpha = st.a;
      c.beginPath(); splinePath(c, ANAT[rg][sd], true);
      c.fillStyle = st.fill; c.fill();
      c.strokeStyle = st.stroke; c.lineWidth = st.lw*px; c.stroke();
    };
    c.lineCap = 'round'; c.lineJoin = 'round';
    const order = ['maxillary','frontal','nasal','ethmoid'];
    for(const sd of ['sol','sag']) for(const rg of order){
      if(isNow(rg, sd)) continue;
      const st = style(rg, sd); if(st.a > .003) shape(rg, sd, st);
    }
    /* Kanallar: kendi sinüsünün renginde, kenarsız — görselde de ince birer
       geçit. Tahtada yoklar; dalışta haritanın geri kalanıyla sönüyorlar. */
    for(const d of ANAT_DUCTS){
      const st = style(d[0], d[1]); if(allA <= .003) continue;
      c.globalAlpha = allA;
      c.strokeStyle = rgbaA(st.col, Math.min(1, st.fa + .15)); c.lineWidth = d[3];
      c.beginPath(); splinePath(c, d[2], false); c.stroke();
    }
    // bugünün sinüsleri en üstte: öne çıkıp birleşenler komşularının altında kalmasın
    const st = style(L.region, tSides[0]);
    if(st.a > .003){
      const pathOf = (u, sd) => {
        const ct = polyAreaCentroid(ANAT[L.region][sd]), k = 1 + .14*lift*(1 - join);
        u.translate(sideDX(L, sd)*join, 0);
        u.translate(ct.cx, ct.cy); u.scale(k, k); u.translate(-ct.cx, -ct.cy);
        u.beginPath(); splinePath(u, ANAT[L.region][sd], true);
      };
      if(tSides.length === 1) shape(L.region, tSides[0], st);
      else {
        /* İki biçim kaynaşırken tek silüet: dolgu ve kenar ayrı bir tuvalde
           birleşimden çiziliyor — üst üste binen yerde iç kenar ve çift
           yoğunlukta dolgu kalmıyor, dalışın sonu tahtanın biçimine akıyor. */
        const uc = this.unionCv || (this.unionCv = document.createElement('canvas'));
        if(uc.width !== this.cv.width || uc.height !== this.cv.height){ uc.width = this.cv.width; uc.height = this.cv.height; }
        const u = uc.getContext('2d'), T = c.getTransform();
        const each = f => { for(const sd of tSides){ u.save(); pathOf(u, sd); f(); u.restore(); } };
        const blit = (alpha, shadow) => {
          c.save(); c.setTransform(1,0,0,1,0,0); c.globalAlpha = alpha;
          if(shadow > .003){ c.shadowColor = 'rgba(0,0,0,' + (.55*shadow).toFixed(3) + ')'; c.shadowBlur = 26*shadow; c.shadowOffsetY = 10*shadow; }
          c.drawImage(uc, 0, 0); c.restore();
        };
        u.setTransform(1,0,0,1,0,0); u.clearRect(0,0,uc.width,uc.height); u.setTransform(T);
        u.fillStyle = rgbaA(st.col, 1); each(() => u.fill());
        blit(st.a*st.fa, lift*(1 - join));
        u.setTransform(1,0,0,1,0,0); u.clearRect(0,0,uc.width,uc.height); u.setTransform(T);
        u.strokeStyle = st.stroke; u.lineWidth = 2*st.lw*px; u.lineJoin = 'round';
        each(() => u.stroke());
        u.globalCompositeOperation = 'destination-out'; u.fillStyle = '#000';
        each(() => u.fill());
        u.globalCompositeOperation = 'source-over';
        blit(st.a, 0);
      }
    }
    c.globalAlpha = 1;
  },
  /* Sinüs adları. Yüzün sağında yer varsa illüstrasyondaki gibi ince çizgili
     etiketler; dar ekranda (telefon) yüzün altında renk anahtarı. Yakınlaşma
     başlamadan sönüyorlar — dalışta yalnızca hedef ve başlık kalsın. */
  drawLabels(c, s, o, t){
    const a = sstep(.3, .8, t) * (1 - sstep(1.35, 1.7, t));   // HOLD boyunca tam görünür
    if(a <= .003) return;
    const dpr = this.dpr, W = this.W, H = this.H, cur = DAY_REGION[this.idx];
    const kinds = ['frontal','ethmoid','nasal','maxillary'];
    const done = rg => DAY_REGION.some((r, i) => r === rg && i < this.idx);
    const face = '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
    c.setTransform(dpr,0,0,dpr,0,0);
    c.globalAlpha = a; c.textBaseline = 'middle';
    const X = o[0] + s*1.1;
    if(W - X >= 170){
      for(const rg of kinds){
        const L = FACE_LABEL[rg], ax = o[0] + s*L[1][0], ay = o[1] + s*L[1][1], ly = o[1] + s*L[0];
        const on = rg === cur;
        c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2.6;          // tende de okunsun
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(X - 30, ly); c.lineTo(X - 8, ly); c.stroke();
        c.strokeStyle = on ? 'rgba(255,255,255,.9)' : 'rgba(220,236,240,.6)'; c.lineWidth = 1.1;
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(X - 30, ly); c.lineTo(X - 8, ly); c.stroke();
        c.fillStyle = on ? '#fff' : 'rgba(210,230,236,.7)';
        c.beginPath(); c.arc(ax, ay, on ? 3 : 2.2, 0, 7); c.fill();
        c.fillStyle = rgbaA(ANAT_COL[rg], on ? 1 : .75);
        c.beginPath(); c.arc(X + 5, ly, 5, 0, 7); c.fill();
        c.font = (on ? '700 15px ' : '600 13.5px ') + face;
        c.fillStyle = on ? '#fff' : (done(rg) ? 'rgba(160,236,230,.9)' : 'rgba(200,222,230,.8)');
        c.fillText(REGIONS[rg].name, X + 17, ly);
      }
    } else {
      const y0 = o[1] + s*1.2 + 14;
      if(H - y0 >= 84){
        const colW = Math.min(180, (W - 32)/2);
        kinds.forEach((rg, k) => {
          const x = W/2 - colW + (k % 2)*colW + 8, y = y0 + ((k/2)|0)*24;
          const on = rg === cur;
          c.fillStyle = rgbaA(ANAT_COL[rg], on ? 1 : .75);
          c.beginPath(); c.arc(x + 5, y, 5, 0, 7); c.fill();
          c.font = (on ? '700 14px ' : '600 13px ') + face;
          c.fillStyle = on ? '#fff' : (done(rg) ? 'rgba(160,236,230,.9)' : 'rgba(200,222,230,.8)');
          c.fillText(REGIONS[rg].name, x + 16, y);
        });
      }
    }
    c.globalAlpha = 1;
  },
  skip(){
    if(!this.active || this.ended) return;
    this.t0 = performance.now() - (this.END + this.HOLD)*1000;
  },
  close(){
    if(!this.active){   // yalnızca perde açıksa (hazırlık sürerken) onu da kaldır
      if(this.el.classList.contains('prep')){ this.el.classList.remove('on','prep'); this.el.style.background = ''; document.body.classList.remove('cineOn'); }
      return;
    }
    this.active = false; this.ended = true;
    cancelAnimationFrame(this.raf);
    this.el.classList.remove('on');
    this.card.classList.remove('on'); this.title.classList.remove('on','rest');
    document.body.classList.remove('cineOn');
  },
  frame(){
    const t = this.sceneT((performance.now() - this.t0)/1000), c = this.ctx, dpr = this.dpr, W = this.W, H = this.H;
    const L = this.L, region = L.region;
    c.setTransform(1,0,0,1,0,0);
    c.clearRect(0,0,this.cv.width,this.cv.height);
    if(t >= this.END){
      /* Son kare: perde yarı saydam, tahta görünüyor. Tuval boşalıyor, perdeyi
         CSS arka planı taşıyor — boyut değişince yeniden çizmeye gerek yok. */
      if(!this.ended){
        this.ended = true;
        this.el.classList.add('ended');
        this.el.style.background = 'rgba(4,9,13,.5)';
        this.card.classList.add('on');
        this.placeCard();
        this.title.classList.toggle('on', this.lean);
        this.title.classList.toggle('rest', this.lean);
        const b = this.card.querySelector('button[data-a]'); if(b) setTimeout(()=>b.focus({preventScroll:true}), 30);
      }
      return;
    }
    // ses işaretleri — sahne akışının iki anı
    if(this.cues === 0 && t > this.HOLD_AT){   // duraklama bitince, yakınlaşmayla birlikte
      this.cues = 1; Sound.air(1.3, 260, 1300, .12, .8); }
    if(this.cues === 1 && t >= 2.5){ this.cues = 2; Sound.tone(392,.5,'sine',.06); setTimeout(()=>Sound.tone(523,.6,'sine',.05), 120); }

    const bgA = 1 - .5*sstep(3.2, 3.9, t);
    c.fillStyle = 'rgba(4,9,13,' + bgA.toFixed(3) + ')';
    c.fillRect(0,0,this.cv.width,this.cv.height);

    /* Kamera: yüzün tamamından bugünün sinüsüne. Ölçek geometrik
       aradeğerleniyor (dalış hissi), hedef nokta tahtanın merkezine kayıyor. */
    const fr = scrFrame, F = L.face, bb = faceBBox(L);
    /* Kamera: yüzün tamamından tahtanın kendisine (GOAL-034). Hedef, tahtanın
       ekrandaki dönüşümünün ta kendisi; dalış bittiğinde haritadaki çizim ile
       tahta üst üste biniyor. Ölçek geometrik aradeğerleniyor (dalış hissi). */
    const s1 = F ? F.k*CS*scrField.s : this.s0*4;
    const o1 = F ? [scrField.x + F.gx0*CS*scrField.s, scrField.y + F.gy0*CS*scrField.s] : this.o0;
    const win = L.win, pin = [(win[0]+win[2])/2, (win[1]+win[3])/2];
    const e = smooth(sstep(1.35, 2.75, t));
    const s = this.s0 * Math.pow(s1/this.s0, e);
    const p0 = [this.o0[0] + this.s0*pin[0], this.o0[1] + this.s0*pin[1]];
    const p1 = [o1[0] + s1*pin[0], o1[1] + s1*pin[1]];
    const ps = [lerp(p0[0], p1[0], e), lerp(p0[1], p1[1], e)];
    const o = [ps[0] - s*pin[0], ps[1] - s*pin[1]];

    const faceA = sstep(0, .5, t) * (1 - sstep(2.0, 2.75, t));
    if(faceA > .003){
      const k = s/this.s0;
      c.globalAlpha = faceA;
      c.drawImage(this.faceCv, (o[0] - k*this.o0[0])*dpr, (o[1] - k*this.o0[1])*dpr, this.cv.width*k, this.cv.height*k);
      c.globalAlpha = 1;
    }
    c.setTransform(dpr*s,0,0,dpr*s, dpr*o[0], dpr*o[1]);
    const px = 1/s;                                   // 1 ekran pikseli, yüz biriminde
    const pulse = .5 + .5*Math.sin(t*5.2);
    const allA = sstep(.1, .6, t) * (1 - sstep(1.7, 2.3, t));    // tahtada olmayan yapılar
    const nowA = sstep(.1, .6, t) * (1 - sstep(2.45, 2.95, t));  // tahtanın yapıları
    if(nowA > .003){
      const q = [(bb.x0+bb.x1)/2, (bb.y0+bb.y1)/2], r = Math.max(bb.w, bb.h)*.9 + .05;
      c.globalAlpha = nowA*(.35 + .25*pulse)*(1 - e);
      c.globalCompositeOperation = 'lighter';
      faceSoft(c, q[0], q[1], r, r, rgbaA(ANAT_COL[region], .5));
      c.globalCompositeOperation = 'source-over';
    }
    /* GOAL-039: iki taraflı günde iki sinüs, siklamen vardığında yüzden öne
       çıkıyor (duraklama boyunca öyle bekliyor), dalışla birlikte birbirine
       yaklaşıp kaynaşıyor ve ekranı kaplayan tahtaya dönüşüyor. */
    const lift = L.pair ? smooth(sstep(.95, 1.35, t)) : 0;
    const join = L.pair ? smooth(sstep(1.45, 2.55, t)) : 0;
    this.drawAnatomy(c, px, allA, nowA, pulse, lift, join);
    c.globalAlpha = 1;
    this.drawLabels(c, s, o, t);
    c.setTransform(dpr*s,0,0,dpr*s, dpr*o[0], dpr*o[1]);

    /* Siklamenin yolu ve ucundaki çiçek (iki taraflı günde iki yol) */
    const pathA = sstep(.2, .6, t) * (1 - sstep(1.5, 2.0, t));
    if(pathA > .003) this.paths.forEach((P, pi) => {
      const head = P.len * smooth(sstep(.35, 1.35, t));
      c.globalAlpha = pathA; c.lineCap = 'round'; c.lineJoin = 'round';
      c.strokeStyle = 'rgba(53,224,216,.55)'; c.lineWidth = 2.2*px;
      c.beginPath(); c.moveTo(P.pts[0][0], P.pts[0][1]);
      let hx = P.pts[0][0], hy = P.pts[0][1];
      for(let i=1;i<P.pts.length;i++){
        if(P.cum[i] > head){
          const k = (head - P.cum[i-1]) / Math.max(1e-6, P.cum[i]-P.cum[i-1]);
          hx = lerp(P.pts[i-1][0], P.pts[i][0], k); hy = lerp(P.pts[i-1][1], P.pts[i][1], k);
          c.lineTo(hx, hy); break;
        }
        hx = P.pts[i][0]; hy = P.pts[i][1]; c.lineTo(hx, hy);
      }
      c.stroke();
      c.globalCompositeOperation = 'lighter';
      faceSoft(c, hx, hy, 34*px, 34*px, 'rgba(255,120,190,.55)');
      c.globalCompositeOperation = 'source-over';
      const iw = 30*px, ih = iw*PLAYER_AR;
      c.drawImage(playerImg, hx - iw/2, hy - ih/2, iw, ih);
      /* GOAL-038: süzülen çiçeğin ne olduğu yazıyla da belli olsun. İki yolda
         etiket bir kez, soldaki çiçeğin solunda (sağdakinin üstüne binmesin). */
      if(pi > 0) return;
      c.save(); c.setTransform(dpr,0,0,dpr,0,0);
      const tag = 'SİKLAMEN ÇİÇEĞİ';
      c.font = '700 13px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
      const tw = c.measureText(tag).width;
      const lx = this.paths.length > 1 ? o[0] + s*hx - 20 - tw : o[0] + s*hx + 20, ly = o[1] + s*hy - 18;
      c.fillStyle = 'rgba(6,14,20,.78)'; roundRectPath(c, lx - 7, ly - 11, lx + tw + 7, ly + 10, 6); c.fill();
      c.fillStyle = '#ffd1e6'; c.textBaseline = 'middle'; c.fillText(tag, lx, ly);
      c.restore();
    });
    c.globalAlpha = 1;

    /* Yüzdeki biçim → tahtadaki gerçek kesit. Silüet tahtanın ekrandaki
       yerine basılıyor; tarama çizgisi yukarıdan aşağı onu netleştiriyor. */
    const maskA = sstep(2.35, 2.95, t) * (1 - sstep(3.3, 3.9, t));
    if(maskA > .003){
      c.setTransform(dpr,0,0,dpr,0,0);
      const fx = scrField.x, fy = scrField.y, fw = PFW*scrField.s, fh = PFH*scrField.s;
      const scanY = lerp(fr.y0 - 20, fr.y1 + 20, sstep(2.5, 3.4, t));
      c.globalAlpha = maskA*.4;
      c.drawImage(this.maskCv, fx, fy, fw, fh);
      c.save(); c.beginPath(); c.rect(0, 0, W, scanY); c.clip();
      c.globalAlpha = maskA;
      c.drawImage(this.maskCv, fx, fy, fw, fh);
      c.restore();
      if(scanY < fr.y1 + 10){
        const g = c.createLinearGradient(0, scanY-26, 0, scanY+26);
        g.addColorStop(0,'rgba(140,240,236,0)'); g.addColorStop(.5,'rgba(170,250,244,.30)'); g.addColorStop(1,'rgba(140,240,236,0)');
        c.globalCompositeOperation = 'lighter'; c.globalAlpha = maskA;
        c.fillStyle = g; c.fillRect(fr.x0, scanY-26, fr.x1-fr.x0, 52);
        c.globalCompositeOperation = 'source-over';
      }
      c.globalAlpha = 1;
    }
    // başlık, etiketler sönünce geliyor: ikisi aynı anda yüzün üstünde karışmasın
    this.title.classList.toggle('on', t >= 1.7 && (t < 3.5 || this.lean));
  }
};
Cine.skipBtn.addEventListener('click', e => { e.stopPropagation(); Sound.init(); Sound.resume(); Cine.skip(); });
Cine.el.addEventListener('click', e => {
  const b = e.target.closest('button[data-a]');
  if(b){ Sound.init(); Sound.resume(); Sound.ui(); doAction(b.dataset.a); return; }
  if(!Cine.ended) Cine.skip();
});
addEventListener('keydown', e => {
  if(!Cine.active) return;
  if(e.key === 'Enter' || e.key === ' ' || e.key === 'Escape'){
    if(!Cine.ended){ e.preventDefault(); Cine.skip(); }
    else if(e.key !== 'Escape' && !(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.a === 'go')){
      e.preventDefault(); doAction('go');
    }
  }
});

/* =========================================================================
   10c. BİLGİ ŞERİDİ (GOAL-031)
   Kestikçe tahtanın yanında beliren kısa bilgiler (metinler: FACTS). Odak
   oyunda kalsın diye kurallar: şerit tahtanın dışında duruyor, yeni bilgi
   yalnızca yavaş bir geçişle geliyor, hiçbir şey yanıp sönmüyor, ve iki
   bilgi arasında en az MIN_DWELL saniye var — tek hamlede büyük bir alan
   alan oyuncu bilgileri art arda kaçırmasın, sırayla görsün.
   ========================================================================= */
const Info = {
  el:$('infoRail'), kick:$('irKick'), idxEl:$('irIdx'), body:$('irBody'), icon:$('irIcon'), pop:$('irPop'),
  facts:[], shown:-1, want:-1, lastT:-99, vis:false, swapT:0, arriveT:0, from:null,
  MIN_DWELL:7,
  reset(L){
    this.facts = FACTS[L.day-1] || [];
    this.shown = -1; this.want = -1; this.lastT = -99; this.from = null;
    this.pages = 1; this.pagesSeen = true;   // önceki günün sayfalaması ilk bilgiyi bekletmesin
    this.cur = null;
    // "BİLGİ" etiketini süzülen işaret ve renk taşıyor; dar şeritte bölge adı kesilmesin
    this.kick.textContent = L.regionName.toLocaleUpperCase('tr-TR');
    // bölgenin haritadaki rengi ve silüeti: şerit neyle ilgili, bir bakışta
    const rc = ANAT_COL[L.region].join(',');
    this.el.style.setProperty('--rc', rc); this.pop.style.setProperty('--rc', rc);
    this.drawIcon(L);
    this.idxEl.innerHTML = this.facts.map(() => '<i></i>').join('');
    this.setVis(false);
  },
  drawIcon(L){
    // iki taraflı günde iki biçim, aradaki boşlukla (haritadaki yerlerinde)
    const c = this.icon.getContext('2d'), S = this.icon.width, Ps = daySides(L).map(sd => ANAT[L.region][sd]);
    let x0 = 9, y0 = 9, x1 = -9, y1 = -9;
    for(const P of Ps) for(const p of P){ x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const k = (S - 8) / Math.max(x1-x0, y1-y0);
    c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,S,S);
    c.setTransform(k,0,0,k, S/2 - k*(x0+x1)/2, S/2 - k*(y0+y1)/2);
    for(const P of Ps){
      c.beginPath(); splinePath(c, P, true);
      c.fillStyle = rgbaA(ANAT_COL[L.region], .9); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 2.5/k; c.stroke();
    }
  },
  /* Her kapanıştan sonra: ilk kesim ilk bilgiyi, sonra hedefin her çeyreği
     bir sonrakini açıyor. (gx, gy): kapanan parçanın ortası — "+ BİLGİ"
     işareti oradan şeride süzülüyor. */
  onCapture(gx, gy){
    const n = this.facts.length; if(!n) return;
    if(gx !== undefined) this.from = [gx, gy];
    const prog = clamp(G.pct / Math.max(.01, G.level.target), 0, 1);
    this.want = Math.max(this.want, Math.min(n-1, Math.floor(prog*n)));
  },
  /* Yeni bilginin gelişi: kesimin yerinden şeride kısa bir süzülme ve
     şeridin kenarında tek, yumuşak bir ışıma. Hareket azaltma tercihinde
     yalnızca ışıma. */
  announce(){
    clearTimeout(this.arriveT);
    this.el.classList.add('arrive');
    this.arriveT = setTimeout(() => this.el.classList.remove('arrive'), 1500);
    if(!this.from || this.el.classList.contains('gone') || !this.pop.animate) return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const a = Guide.toScreen(this.from[0] + .5, this.from[1] + .5), r = this.el.getBoundingClientRect();
    const pw = this.pop.offsetWidth || 80, ph = this.pop.offsetHeight || 28;
    const b = [r.left + Math.min(40, r.width/2), r.top + 10];
    this.pop.animate([
      { transform:`translate(${a[0]-pw/2}px,${a[1]-ph/2}px) scale(.85)`, opacity:0 },
      { transform:`translate(${a[0]-pw/2}px,${a[1]-ph/2-18}px) scale(1)`, opacity:1, offset:.22 },
      { transform:`translate(${a[0]-pw/2}px,${a[1]-ph/2-18}px) scale(1)`, opacity:1, offset:.42 },
      { transform:`translate(${b[0]-pw/2}px,${b[1]-ph/2}px) scale(.7)`, opacity:0 }
    ], { duration:1500, easing:'cubic-bezier(.45,0,.25,1)' });
  },
  tick(){
    // sayfalı metinde yeni bilgi, eldeki bilginin bütün sayfaları bir kez gösterilmeden gelmiyor
    if(this.want > this.shown && G.time - this.lastT >= (this.shown < 0 ? 0 : this.MIN_DWELL) && this.pagesSeen) this.show(this.shown+1);
    if(this.pages > 1 && this.vis && G.time - this.pageT >= this.N*2.6 + 1) this.nextPage();
    this.setVis(this.shown >= 0 && (G.state === 'play' || G.state === 'paused'));
  },
  show(i){
    const f = this.facts[i]; if(!f) return;
    this.shown = i; this.lastT = G.time;
    const fill = () => {
      this.cur = f;               // metni fit() → paginate() yazıyor: kartın hâline göre uzun ya da kısa
      this.idxEl.querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k <= i));
      this.body.classList.remove('swap');
      this.fit();
    };
    clearTimeout(this.swapT);
    if(i === 0 || !this.vis){ fill(); requestAnimationFrame(() => this.announce()); }
    else { this.body.classList.add('swap'); this.swapT = setTimeout(fill, 460); this.announce(); }
  },
  /* Şerit kendisine ayrılan yüksekliğe (avail, bkz. placeInfoRail) sığmıyorsa
     gövde iki satıra kırpılıyor; tamamı gün sonunda okunuyor. */
  avail:0, autoCls:null,
  fit(){
    const el = this.el;
    if(this.autoCls){ el.classList.remove(this.autoCls); this.autoCls = null; }
    this.paginate();
    if(this.avail <= 0 || el.classList.contains('gone')) return;
    // sırayla: tam → iki satır → tek satırlık şerit → hiç (tahtaya taşmaktansa)
    for(const c of ['compact', 'slim', 'gone']){
      // sayfalı iki satırlık kart yerine, sığıyorsa sayfasız şerit yeğleniyor
      if(el.offsetHeight <= this.avail && (!el.classList.contains('paged') || c === 'gone')) return;
      if(el.classList.contains(c)) continue;
      if(this.autoCls) el.classList.remove(this.autoCls);
      el.classList.add(c); this.autoCls = c;
      this.paginate();
    }
  },
  /* Telefonda tam karta yer yokken kart iki satırlık bir hâle iniyor ve
     bilginin kısa metnini (k) gösteriyor: iki satırlı kartta başlık ayrı,
     şeritte (slim) başlık metnin başında kalın — ikisi de bir bakışta
     okunuyor. Çok dar bir ekranda kısa metin bile iki satıra sığmazsa
     kesilmiyor, sayfalanıyor: her sayfa N·2,6 + 1 sn duruyor, yumuşak bir
     solmayla sonrakine geçiyor, sona gelince başa dönüyor. */
  cur:null, pages:1, page:0, N:0, lh:20, pageT:0, pagesSeen:true, pageSwapT:0,
  paginate(){
    const el = this.el, p = this.body.querySelector('p'), sp = p.firstElementChild;
    clearTimeout(this.pageSwapT);
    this.page = 0; sp.style.transform = ''; sp.style.opacity = '';
    const slim = el.classList.contains('slim');
    let N = (slim || el.classList.contains('compact')) ? 2 : 0;
    const f = this.cur;
    if(f){
      const txt = N && f.k ? f.k : f.b;
      this.body.querySelector('b').textContent = f.t;
      if(slim) sp.innerHTML = '<strong>' + escapeHtml(f.t) + '</strong> ' + escapeHtml(txt);
      else sp.textContent = txt;
    }
    el.classList.remove('paged');
    this.N = N; this.pages = 1; this.pagesSeen = true; this.pageT = G.time;
    if(!N || el.classList.contains('gone')){ p.style.height = ''; this.idxPage(); return; }
    const lh = parseFloat(getComputedStyle(p).lineHeight) || 20;
    this.lh = lh;
    p.style.height = (N*lh).toFixed(2) + 'px';
    /* Kartın altında boş yer varsa pencere o kadar satır uzuyor (dar yan
       çubukta kısa metin 3-4 satır tutuyor; sayfalamaya gerek kalmıyor). */
    const total = Math.round(sp.offsetHeight / lh);
    if(this.avail > 0 && total > N){
      N = Math.min(total, N + Math.max(0, Math.floor((this.avail - el.offsetHeight) / lh)));
      this.N = N; p.style.height = (N*lh).toFixed(2) + 'px';
    }
    const count = () => Math.max(1, Math.ceil(Math.round(sp.offsetHeight / lh) / N));
    if(count() > 1){ el.classList.add('paged'); this.pages = count(); }   // sayfa sayacına yer açınca yeniden say
    this.pagesSeen = this.pages <= 1;
    this.idxPage();
  },
  nextPage(){
    const sp = this.body.querySelector('p span');
    const k = (this.page + 1) % this.pages;
    if(k === 0) this.pagesSeen = true;
    this.page = k; this.pageT = G.time;
    sp.style.opacity = '0';
    clearTimeout(this.pageSwapT);
    this.pageSwapT = setTimeout(() => {
      sp.style.transform = 'translateY(' + (-k*this.N*this.lh).toFixed(2) + 'px)';
      sp.style.opacity = '';
      this.idxPage();
    }, 420);
  },
  // metnin devamı olduğu, sağ alttaki küçük "1/3" ile belli
  idxPage(){
    const pg = this.body.querySelector('em');
    pg.textContent = this.pages > 1 ? (this.page + 1) + '/' + this.pages : '';
  },
  setVis(v){
    if(v === this.vis) return;
    this.vis = v; this.el.classList.toggle('on', v);
    // telefonda ikisi tahtanın altındaki aynı bandı paylaşıyor
    if(v) UI.hint.classList.remove('on');
  }
};

/* =========================================================================
   10d. KİM KİMDİR — ANLAŞILIRLIK (GOAL-038)
   Oyunun görsel dili güzel ama ilk bakışta herkes için açık değil: sahada
   yönetilen siklamenin "sen" olduğu, virüsün ve mikropların ne
   olduğu kendiliğinden anlaşılmıyordu. Üç katman:

     - Her günün ilk saniyelerinde öğelerin üstünde kısa isim etiketleri
       (ilk iki gün daha uzun). Sonra sönüyorlar; saha kalabalıklaşmıyor.
     - İlk oyunda, 1. günde üç adımlık rehber balonu: kim olduğun, ne
       yapacağın, neye dikkat edeceğin. Bir kez tamamlanınca bir daha çıkmıyor.
     - Menüde "NASIL OYNANIR" ekranı (bkz. showHowTo).
   ========================================================================= */
const Guide = {
  layer:$('tags'), coach:$('coach'), pool:[], tagT:0, step:-1, stepT:0,
  KEY:'nasodren_tutorial_v1', done:false,
  init(){ try{ this.done = localStorage.getItem(this.KEY) === '1'; }catch(e){} },
  finish(){ this.done = true; this.step = -1; try{ localStorage.setItem(this.KEY, '1'); }catch(e){} this.coach.classList.remove('on'); },
  levelStart(L){
    this.tagT = L.day <= 2 ? 6 : 3.5;
    this.step = (L.day === 1 && !this.done) ? 0 : -1;
    this.stepT = 0; this.shown = -1;
  },
  toScreen(gx, gy){ return [root.x + gx*CS*root.scale.x, root.y + gy*CS*root.scale.y]; },
  tag(i, text, cls){
    let el = this.pool[i];
    if(!el){ el = document.createElement('div'); this.layer.appendChild(el); this.pool[i] = el; }
    if(el._t !== text){ el.textContent = text; el._t = text; }
    if(el._c !== cls){ el.className = 'tag ' + cls; el._c = cls; }
    return el;
  },
  STEPS:[
    'Bu sensin: siklamen çiçeği. Çevrendeki altın halka dolu oldukça kenar çizgisinde güvendesin.',
    'Dokuya gir, bir parça çiz ve kenara geri dön — kapattığın alan temizlenir.',
    'Harika! Çizerken mikroplar çizgine değerse can kaybedersin. Hedefe ulaşınca gün biter.'
  ],
  update(dt){
    const play = G.state === 'play';
    let n = 0;
    if(this.tagT > 0 && play){
      this.tagT -= dt;
      const a = clamp(this.tagT, 0, 1).toFixed(2), sc = root.scale.x;
      /* Çakışan etiket atlanıyor (küçük ekranda mikroplar üst üste binip
         oyuncunun etiketini örtüyordu). Öncelik: sen, virüs, mikroplar. */
      const taken = [], vw = innerWidth, vh = innerHeight;   // döngüden önce: stil yazarken okumak her etikette düzeni yeniden hesaplatıyordu
      const put = (gx, gy, off, text, cls, w) => {
        const p = this.toScreen(gx, gy), x = p[0], y = p[1] - off, hw = w/2 + 4;
        if(taken.some(r => Math.abs(r[0] - x) < r[2] + hw && Math.abs(r[1] - y) < 26)) return;
        if(x < 0 || y < 0 || x > vw || y > vh) return;
        taken.push([x, y, hw]);
        const el = this.tag(n++, text, cls);
        el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-100%)';
        el.style.opacity = a;
      };
      // rehber balonu açıkken "sen" etiketi gereksiz: balon zaten onu söylüyor
      const meOff = playerW*.75*sc + 6;              // kalkan halkasının hemen üstü
      if(this.step < 0) put(G.px + .5, G.py + .5, meOff, 'SEN · SİKLAMEN ÇİÇEĞİ', 'me', 176);
      else taken.push([this.toScreen(G.px + .5, G.py + .5)[0], this.toScreen(G.px + .5, G.py + .5)[1] - meOff, 60]);
      for(const b of G.bosses) put(b.x, b.y, b.r*CS*sc + 6, 'VİRÜS', 'foe', 62);
      for(const m of G.minions) put(m.x, m.y, 15*sc + 4, 'MİKROP', 'foe small', 62);
      // güçlendiriciler en son: yer kalırsa ne işe yaradıkları da yazsın
      for(const p of G.pus) if(!p.collected && cells[p.y*GW+p.x] === EMPTY){
        const m = PU_META[p.k];
        put(p.x + .5, p.y + .5, puW/2*sc + 4, m.letter + ' ' + m.tag, 'small pu' + p.k, m.tag.length*9 + 34);
      }
    }
    for(let i=n;i<this.pool.length;i++) if(this.pool[i].style.opacity !== '0') this.pool[i].style.opacity = '0';
    // rehber
    if(this.step < 0 || !play){ this.coach.classList.remove('on'); return; }
    this.stepT += dt;
    if(this.step === 0 && (G.drawing || this.stepT > 7)){ this.step = 1; this.stepT = 0; }
    if(this.step === 1 && G.pct > 0){ this.step = 2; this.stepT = 0; }
    if(this.step === 2 && this.stepT > 6.5){ this.finish(); return; }
    if(this.shown !== this.step){ this.coach.querySelector('p').textContent = this.STEPS[this.step];
      this.coach.querySelector('b').textContent = (this.step + 1) + '/3'; this.shown = this.step; }
    const p = this.toScreen(G.px + .5, G.py + .5);
    const w = this.coach.offsetWidth || 260, h = this.coach.offsetHeight || 80;
    const x = clamp(p[0] - w/2, 10, innerWidth - w - 10);
    const ra = playerW*.75*root.scale.x;                        // kalkan halkasının yarıçapı, ekranda
    const above = p[1] - ra - 16 - h > 70;                       // yer yoksa altına
    const y = above ? p[1] - ra - 16 - h : p[1] + ra + 10;
    this.coach.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    this.coach.classList.toggle('below', !above);
    this.coach.style.setProperty('--ax', clamp(p[0] - x, 18, w - 18).toFixed(1) + 'px');
    this.coach.classList.add('on');
  }
};
Guide.init();
/* Menüdeki "NASIL OYNANIR" ekranı — sahadaki gerçek görsellerle. */
function showHowTo(){
  const pu = PU_META.map(m => `<span class="howPu" style="--c:${m.color}"><i>${m.letter}</i><b>${escapeHtml(m.tag)}</b>${escapeHtml(m.label)}</span>`).join('');
  showMenuScreen(
    `<div class="menuBrand"><div class="kicker">NASIL OYNANIR</div><div class="title">Kim kimdir?</div></div>
     <div class="howList">
       <div class="howRow"><img src="${playerAssetUrl}" alt=""><div><b>Sen: siklamen çiçeği</b>
         <p>Kenar çizgisinin üstünde güvendesin — çevrendeki altın halka (siklamen kalkanı) dolu oldukça. Halka zamanla azalır, kestikçe dolar; bitince kenarda da vurulursun. ${isTouch ? 'Parmağını sürükleyerek' : 'Ok tuşları ya da WASD ile'} yönlendir.</p></div></div>
       <div class="howRow"><span class="howCut"></span><div><b>Kes ve kapat</b>
         <p>Dokuya gir, bir parça çiz ve kenara geri dön. Kapattığın alan temizlenir; hedef yüzdeye ulaşınca gün biter.</p></div></div>
       <div class="howRow"><span class="howTiers"><img src="${bossAssetUrl}" alt=""><img src="${boss2AssetUrl}" alt=""><img src="${boss3AssetUrl}" alt=""></span><div><b>Virüs</b>
         <p>Büyük düşman. Çizerken çizgine ya da sana değerse can kaybedersin. Virüsün olmadığı taraf temizlenir.
            Kür ilerledikçe evrilir: ${BOSS_TIER_BY_DAY.indexOf(1) + 1}. günde büyür, ${BOSS_TIER_BY_DAY.indexOf(2) + 1}. günde en büyük ve en hızlı hâline gelir.</p></div></div>
       <div class="howRow"><span class="howPair"><img src="${minionFlagellaAssetUrl}" alt=""><img src="${minionSporeAssetUrl}" alt=""></span><div><b>Mikroplar</b>
         <p>Küçük ve hızlı; onlar da çizgini keser. Kapattığın alanın içinde kalan mikrop yok olur.</p></div></div>
       <div class="howRow"><span class="howBreath"></span><div><b>Nefes</b>
         <p>Birkaç saniyede bir hava dipten girer. Dipten yukarı kopuksuz açtığın yol puanı artırır, tıkalı kalırsa basınç yükselir.</p></div></div>
       <div class="howRow howPuRow"><div><b>Güçlendiriciler</b>
         <p>Kapattığın alanın içinde kalınca toplanır.</p><span class="howPus">${pu}</span></div></div>
     </div>
     <div class="menuStack menuBack">
       <button class="menuBtn primary" data-a="start">OYNA</button>
       <button class="menuBtn ghost" data-a="mainmenu">◀ ANA MENÜ</button>
     </div>`);
}

function introLevel(){
  if(G.levelIdx >= LEVELS.length){ winGame(); return; }
  hideMenuScreen(); // GOAL-014: tam ekran menüden (ana menü/bölümler) geliniyorsa kapat
  hidePanel();      // önceki günün sonuç paneli
  const L = LEVELS[G.levelIdx];
  G.state = 'intro';
  // GOAL-020: giriş sakin menü müziğiyle; ritim BAŞLA'ya basınca giriyor
  Sound.scene('menu');
  /* Kesitin hazırlığı (boşluk, doku, duvar boyaları) zayıf telefonda 1-2 sn
     sürüyor ve o sırada ekran donuyordu: dokunuşa hiçbir karşılık yok gibi
     görünüyordu. Önce perde ve "Hazırlanıyor…" çiziliyor, ağır iş bir kare
     sonra. tok: arada ikinci kez çağrılırsa eskisi iptal. */
  Cine.curtain();
  const tok = ++introTok;
  requestAnimationFrame(() => requestAnimationFrame(() => { if(tok === introTok) introPrepared(L); }));
}
let introTok = 0;
function introPrepared(L){
  /* GOAL-031: brifing paneli yerine giriş sahnesi (bkz. Cine). Sahne tahtanın
     gerçek yerine indiği için bugünün kesiti sahneden ÖNCE kuruluyor: perde
     kalktığında arkada hazır, hastalıklı tahta duruyor. startLevel aynı
     hazırlığı yeniden yapıyor; ikisi de idempotent. Günün bilgi görseli
     (GOAL-019) ve kısa kural metni sahnenin künye kartında. */
  G.level = L;
  clearEntities(); prepareLevel(G.levelIdx); resetGrid(); rasterRegion(0,0,GW,GH);
  const st = playerStart();
  G.px = st.x; G.py = st.y; G.dir = 0; G.frac = 0; G.drawing = false; G.trail = []; G.corners = [];
  G.pct = 0; G.pressure = 0; G.flow = 0; G.flowTarget = 0; G.waveDur = 0;
  computeBreath(); Info.reset(L); syncHUD();
  Cine.play(L, G.levelIdx);
}
function winGame(){
  G.state = 'won';
  Sound.scene('win');   // GOAL-020
  showPanel(
    `<div class="kicker">KÜR TAMAMLANDI</div>
     <div class="title">Sinüsler <em>açık</em>.</div>
     <p class="lede">Tutulan mukus tamamen kalktı, ostiumlar açıldı, siliyer temizlik yeniden çalışıyor.</p>
     <div class="stats">
       <div><span>TOPLAM SKOR</span><b>${G.score.toLocaleString('tr-TR')}</b></div>
       <div><span>KALAN CAN</span><b>${G.lives}</b></div>
     </div>
     ${nameEntryHTML()}`);
  bindNameEntry();
  Sound.clear();
}

/* =========================================================================
   10d. ÇOK OYUNCULU (bkz. COK-OYUNCULU.md, server/relay.mjs, src/net.ts)
   Yan yana yarış: 2-3 kişi aynı günü aynı tohumla aynı anda başlatır, herkes
   kendi tahtasında bağımsız oynar. Ağdan gelen tek şey rakiplerin anlık
   görüntüsü (konum, düşmanlar, temizlenen alan, yüzde) — yalnızca çiziliyor,
   senin oyununu etkilemiyor; gecikme oynanışı bozmuyor.
   Bir tur = bir gün. Hedefe ilk ulaşan 3, ikinci 2, üçüncü 1 puan; canı ya da
   süresi biten 0. Ev sahibi sonraki günü başlatır, toplamlar turlar boyunca.
   Yarışta duraklatma yok; sekme arka plana alınınca diğerlerine "ara verdi"
   gidiyor ve tur onu beklemiyor.
   Yarış skorları yüksek skor listesine yazılmıyor: istemci istediği sonucu
   gönderebilir (hile koruması yok) ve ödül listesi tek oyunculu kürün ölçüsü.
   ========================================================================= */
/* GOAL-045: çok oyunculu artık Supabase Realtime üzerinden (bkz. net.ts) —
   barındırma yeri (GitHub Pages, Cloudflare, ...) önemli değil, sadece
   derlemede VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY verilmiş olması gerekiyor.
   Eski kontrol sadece ".github.io" barındırmasını kapatıyordu — Cloudflare'de
   çalışmayan bir aktarım sunucusuyla bile düğmeyi gösteriyordu, asıl hata
   buradaydı. */
const MP_OK = SUPABASE_OK;
const MP_NAME_KEY = 'nasodren_mpname_v1';
const MP_ROUND_SEC = 240;    // hedefe ulaşamayan da bir yerde dursun (ölçülmedi, ayarlanabilir)
const MP_SEND_MS = 100;      // ~10 ileti/sn: sunucunun 40/sn sınırının altında
const MP_POINTS = [3, 2, 1];
const MP_COLORS = ['#ff4d9d', '#ffc24a', '#a98bff'];   // sunucunun verdiği renk 0/1/2

net.on(mpOnMsg);
const mpName = () => { try{ return localStorage.getItem(MP_NAME_KEY) || ''; }catch(e){ return ''; } };
const mpWho = id => mp.players.find(p => p.id === id);
const mpCol = p => MP_COLORS[(p && p.color) | 0] || MP_COLORS[0];
const mpTime = sec => { sec = Math.max(0, Math.ceil(sec)); return ((sec/60)|0) + ':' + String(sec%60).padStart(2,'0'); };
function mpClear(){ for(const t of mp.timers){ clearTimeout(t); clearInterval(t); } mp.timers = []; }
function mpReset(){
  mpClear();
  Object.assign(mp, { code:'', you:0, host:0, players:[], inRound:false, over:false, going:false, view:'',
    totals:{}, fins:{}, order:[], away:{}, live:{}, rv:{}, snap:null, mine:null, result:null });
  UI.rvList.innerHTML = '';
  if(document.body.classList.contains('mpOn')){ document.body.classList.remove('mpOn'); layout(); }
}
function mpLeave(){
  if(mp.code) net.send({ t:'leave' });
  net.close();
  mpReset();
}
/* Bağlantı koptu: oyun durur, oyuncu odaya yeniden katılabileceği ekrana döner
   (mobilde ekran kilitlenince ya da Wi-Fi ↔ mobil veri geçişinde sık). */
function mpDrop(msg){
  const code = mp.code, playing = mp.inRound;
  mpReset();
  if(playing){ ClearReveal.cancel(); introTok++; Cine.close(); hidePanel(); G.state = 'title'; Sound.scene('menu'); }
  showMpHome(msg, code);
}

/* ---- ekranlar: giriş, lobi ---- */
function showMpHome(msg, code){
  mp.view = 'home';
  G.state = 'title';
  showMenuScreen(
    `<div class="menuBrand"><div class="kicker">BİRLİKTE OYNA</div><div class="title">Yarış odası</div></div>
     <ul class="mpRules">
       <li>2-3 kişi aynı günü aynı anda, herkes kendi ekranında oynar.</li>
       <li>Hedefe ilk ulaşan turu kazanır: <b>3</b>, ikinci <b>2</b>, üçüncü <b>1</b> puan.</li>
       <li>Yarışta oyun durmaz; tur ${MP_ROUND_SEC/60} dakika sürer.</li>
     </ul>
     <div class="mpForm">
       <label class="mpLbl" for="mpName">ADIN</label>
       <input id="mpName" class="mpInput" maxlength="12" placeholder="Adın" value="${escapeHtml(mpName())}"
         autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done">
       <button class="menuBtn primary" data-a="mpcreate">ODA KUR</button>
       <div class="mpOr">ya da arkadaşının oda kodunu yaz</div>
       <div class="mpJoin">
         <input id="mpCode" class="mpInput mpCodeIn" maxlength="4" placeholder="KOD" value="${escapeHtml(code || '')}"
           autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" aria-label="Oda kodu">
         <button class="menuBtn" data-a="mpjoin">KATIL</button>
       </div>
       <p class="mpMsg" id="mpMsg" role="status">${msg ? escapeHtml(msg) : ''}</p>
     </div>
     <div class="menuStack menuBack"><button class="menuBtn ghost" data-a="mainmenu">◀ ANA MENÜ</button></div>`);
  const ci = $('mpCode');
  ci.addEventListener('input', () => { const v = ci.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); if(v !== ci.value) ci.value = v; });
  ci.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); mpAction('mpjoin'); } });
  $('mpName').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); $('mpName').blur(); } });
}
function mpSay(msg){ const el = $('mpMsg'); if(el) el.textContent = msg || ''; }
function mpReadName(){
  const inp = $('mpName'), name = inp ? inp.value.replace(/\s+/g, ' ').trim().slice(0, 12) : '';
  if(!name){ if(inp){ inp.classList.remove('errorShake'); void inp.offsetWidth; inp.classList.add('errorShake'); inp.focus(); } mpSay('Önce adını yaz.'); return ''; }
  try{ localStorage.setItem(MP_NAME_KEY, name); }catch(e){}
  return name;
}
function mpDayText(){ const L = LEVELS[mp.pick]; return 'Gün ' + L.day + ' · ' + L.regionName + ' · ' + L.sideName; }
function mpRowsHTML(){
  const rows = mp.players.map(p =>
    `<div class="mpRow" style="--pc:${mpCol(p)}"><i></i><b>${escapeHtml(p.name)}</b>${p.id === mp.you ? '<span class="mpTag">SEN</span>' : ''}${
      p.id === mp.host ? '<span class="mpTag host">EV SAHİBİ</span>' : ''}${p.away ? '<span class="mpTag">ARA VERDİ</span>' : ''}</div>`);
  for(let k = mp.players.length; k < 3; k++) rows.push('<div class="mpRow empty"><i></i><b>Boş yer</b></div>');
  return `<div class="mpList">${rows.join('')}</div>`;
}
function showMpLobby(note){
  mp.view = 'lobby';
  G.state = 'title';
  const host = mp.host === mp.you, can = mp.players.length >= 2;
  showMenuScreen(
    `<div class="menuBrand mpBrand"><div class="kicker">ODA KODU</div><div class="mpCode">${mp.code}</div>
       <p class="mpSub">Arkadaşların ana menüde <b>BİRLİKTE OYNA</b>'ya basıp bu kodu yazsın.</p></div>
     ${mpRowsHTML()}
     ${host ? `<div class="mpDay"><button class="mpStep" data-a="mpday-prev" aria-label="Önceki gün">◀</button>
       <div><span>BAŞLANGIÇ GÜNÜ</span><b id="mpDayTxt">${escapeHtml(mpDayText())}</b></div>
       <button class="mpStep" data-a="mpday-next" aria-label="Sonraki gün">▶</button></div>` : ''}
     <p class="mpMsg" id="mpMsg" role="status">${escapeHtml(note || (host
       ? (can ? 'Herkes hazırsa başlat.' : 'Başlatmak için en az bir arkadaşın katılmalı.')
       : 'Ev sahibi başlatınca oyun herkeste aynı anda başlar.'))}</p>
     <div class="menuStack">
       ${host ? `<button class="menuBtn primary" data-a="mpstart"${can ? '' : ' disabled'}>BAŞLAT</button>` : ''}
       <button class="menuBtn ghost" data-a="mpleave">ODADAN ÇIK</button>
     </div>`);
}
function mpAction(a){
  if(a === 'mp'){ showMpHome(); return; }
  if(a === 'mpcreate' || a === 'mpjoin'){
    const name = mpReadName(); if(!name) return;
    if(a === 'mpcreate'){ mpSay('Bağlanıyor…'); net.send({ t:'create', name }); return; }
    const ci = $('mpCode'), code = ci ? ci.value.trim().toUpperCase() : '';
    if(code.length !== 4){ mpSay('Oda kodu 4 karakter.'); if(ci) ci.focus(); return; }
    mpSay('Bağlanıyor…'); net.send({ t:'join', code, name });
  }
  else if(a === 'mpleave'){ mpLeave(); hidePanel(); ClearReveal.cancel(); showMainMenu(); }
  else if(a === 'mpday-prev' || a === 'mpday-next'){
    mp.pick = (mp.pick + (a === 'mpday-next' ? 1 : LEVELS.length - 1)) % LEVELS.length;
    const el = $('mpDayTxt'); if(el) el.textContent = mpDayText();
  }
  else if(a === 'mpstart') mpStartRound(mp.pick, true);
  else if(a === 'mpnext')  mpStartRound(mp.level + 1, false);
  else if(a === 'mpagain') mpStartRound(0, true);
  else if(a === 'mpresume') hidePanel();
}
function mpStartRound(level, fresh){
  if(mp.host !== mp.you) return;
  net.send({ t:'start', level, fresh, tot:Object.keys(mp.totals).map(id => [+id, mp.totals[id]]) });
}

/* ---- sunucudan gelenler ---- */
function mpOnMsg(m){
  switch(m.t){
    case 'room':
      Object.assign(mp, { code:m.code, you:m.you, host:m.host, players:m.players || [], round:m.round|0,
        totals:{}, away:{}, pick:0, inRound:false, over:false });
      showMpLobby();
      break;
    case 'players': {
      const gone = m.left ? mpWho(m.left) : null;
      mp.host = m.host; mp.players = m.players || [];
      for(const p of mp.players) mp.away[p.id] = !!p.away;
      const note = gone ? gone.name + ' odadan ayrıldı.' : '';
      if(!mp.inRound){ if(mp.view === 'lobby') showMpLobby(note); break; }
      if(gone){
        const v = mp.rv[gone.id]; if(v){ v.el.remove(); delete mp.rv[gone.id]; }
        layout();   // kalanlar yeri paylaşsın
        if(G.state === 'play') toast(gone.name.toLocaleUpperCase('tr-TR'), 'ODADAN AYRILDI');
      }
      mpRoundOver(); mpRefresh();
      break;
    }
    case 'start': mpBegin(m); break;
    case 'st': mpState(m); break;
    case 'fin': mpFin(m); break;
    case 'away': {
      mp.away[m.from] = !!m.on;
      const p = mpWho(m.from); if(p) p.away = !!m.on;
      if(!mp.inRound){ if(mp.view === 'lobby') showMpLobby(); break; }
      if(p && m.on && G.state === 'play') toast(p.name.toLocaleUpperCase('tr-TR'), 'OYUNA ARA VERDİ');
      mpRoundOver(); mpRefresh();
      break;
    }
    case 'error':
      if(mp.view === 'home' || mp.view === 'lobby') mpSay(m.msg);
      else if(G.state === 'play') toast('Uyarı', m.msg);
      else if($('mpNote')) $('mpNote').textContent = m.msg;
      break;
    case 'closed': mpDrop('Bağlantı koptu. Odaya yeniden katılabilirsin.'); break;
  }
}
/* Arka plana alma: tarayıcı sekmede çizimi durdurur, oyun donar. Diğerleri
   "ara verdi" görüp devam eder; ara veren herkes bitirdiyse tur onu beklemez. */
document.addEventListener('visibilitychange', () => {
  if(!mp.code || !net.open) return;
  mp.away[mp.you] = document.hidden;
  net.send({ t:'away', on:document.hidden });
  if(mp.inRound){ mpRoundOver(); if(!document.hidden) mpRefresh(); }
});

/* ---- tur ---- */
function mpBegin(m){
  mpClear();
  if(m.fresh) mp.totals = {};
  else if(Array.isArray(m.tot) && m.tot.length){ mp.totals = {}; for(const e of m.tot) mp.totals[e[0]] = e[1]|0; }
  Object.assign(mp, { inRound:true, over:false, round:m.round|0, level:clamp(m.level|0, 0, LEVELS.length-1), seed:m.seed>>>0,
    fins:{}, order:[], live:{}, mine:null, result:null, view:'play', mapDirty:false, going:false });
  for(const id in mp.rv) mp.rv[id].el.remove();
  mp.rv = {};
  mp.goAt = performance.now() + (m.in|0);
  ClearReveal.cancel(); hidePanel();
  G.levelIdx = mp.level; G.score = 0; G.lives = 3;
  // tahta giriş sahnesinden önce yarıştaki yerine: sahne onun üstüne iniyor
  document.body.classList.add('mpOn'); layout();
  introLevel();   // giriş sahnesi; künye kartında BAŞLA yerine geri sayım
  mp.timers.push(setTimeout(mpGo, Math.max(0, m.in|0)), setInterval(mpCountdown, 200));
}
function mpCountdown(){
  const el = $('mpCount'); if(!el) return;
  const s = Math.ceil((mp.goAt - performance.now())/1000);
  const txt = s > 0 ? 'Başlıyor: ' + s : 'Başla!';
  if(el.textContent !== txt) el.textContent = txt;
}
function mpGo(){
  mpClear();
  introTok++;                 // hazırlık henüz bitmediyse (arka plan sekmesi) sahne sonradan açılmasın
  Cine.close(); startLevel();
  mp.t0 = performance.now(); mp.endsAt = mp.t0 + MP_ROUND_SEC*1000; mp.going = true;
  document.body.classList.add('mpOn');
  mpRivals();
  layout();
  mpSend(true);
}
/* Duraklatma yerine: oyun arkada sürüyor, bunu açıkça söyle. */
function mpPauseMenu(){
  if(UI.overlay.classList.contains('on')){ hidePanel(); return; }
  showPanel(
    `<div class="kicker">YARIŞ · GÜN ${String(G.level.day).padStart(2,'0')}</div>
     <div class="title">Oyun <em>durmuyor</em></div>
     <p class="lede">Yarışta duraklatma yok: bu ekran açıkken de virüs ve mikroplar hareket ediyor. Kalan süre ${mpTime((mp.endsAt - performance.now())/1000)}.</p>
     <div class="menuStack">
       <button class="menuBtn primary" data-a="mpresume">OYUNA DÖN</button>
       <button class="menuBtn ghost" data-a="mpleave">ODADAN ÇIK</button>
     </div>`);
}

/* Anlık durum. Tek harfli alanlar, düz sayı dizileri (kısa JSON):
   p: temizlenen alan ‰, s: skor, l: can, x/y: oyuncu hücresi,
   v: virüsler, m: mikroplar [x0,y0,x1,y1,...], c: kesim köşeleri (çizerken),
   d: gönderim aralığı (karşı taraf ara kareleri buna göre yumuşatıyor),
   g: temizlenen alan haritası — yalnızca bir alan kapanınca. */
function mpSend(force){
  if(!mp.inRound || !net.open) return;
  const now = performance.now();
  if(!force && now - mp.sentAt < MP_SEND_MS) return;
  mp.sentAt = now;
  const v = [], mm = [];
  for(const b of G.bosses) v.push(Math.round(b.x), Math.round(b.y));
  for(const e of G.minions) mm.push(Math.round(e.x), Math.round(e.y));
  const m = { t:'st', p:Math.round(G.pct*1000), s:G.score, l:G.lives, x:G.px, y:G.py, v, m:mm, d:MP_SEND_MS };
  if(G.drawing && G.corners.length){ const c = []; for(const q of G.corners.slice(-40)) c.push(q.x, q.y); m.c = c; }
  if(mp.mapDirty){ m.g = mpMapCode(); mp.mapDirty = false; }
  mp.sentP = m.p/1000; mp.sentS = m.s;
  net.send(m);
}
/* Temizlenen alan, 2x2 hücrelik bloklarla (80x80 bit ≈ 1,1 KB metin, 4 KB
   sınırının çok altında). Tahta herkeste aynı tanımdan kuruluyor ama
   ızgaraya düşerken cihazdan cihaza kenarda bir iki hücre oynayabiliyor;
   hücre hücre değil blok blok gönderilince bu kaymaz. Blok, içindeki boşluk
   hücrelerinin en az yarısı temizse temiz sayılıyor. */
const MPB = 2, MPW = GW/MPB, MPH = GH/MPB, mpBits = new Uint8Array(MPW*MPH/8);
function mpMapCode(){
  mpBits.fill(0);
  for(let by=0;by<MPH;by++) for(let bx=0;bx<MPW;bx++){
    let n = 0, f = 0;
    for(let dy=0;dy<MPB;dy++) for(let dx=0;dx<MPB;dx++){
      const i = (by*MPB+dy)*GW + bx*MPB+dx;
      if(cavity[i]){ n++; if(cells[i] === FILL) f++; }
    }
    if(n && f*2 >= n){ const k = by*MPW+bx; mpBits[k>>3] |= 1 << (k&7); }
  }
  let s = '';
  for(let j=0;j<mpBits.length;j++) s += String.fromCharCode(mpBits[j]);
  return btoa(s);
}

/* ---- rakip tahtaları ----
   Kendi tahtanın yanında (ya da dikey telefonda altında) rakibin tahtası:
   aynı kesit, aynı kadraj, oyunun kendi katmanlarıyla — günün hastalıklı
   dokusu, temizlediği yerde açılan sağlıklı doku, kemik. Üstünde virüsler,
   mikroplar, kesim çizgisi ve oyuncunun kendi renginde halkalı siklamen.
   Katmanlar tur başında bir kez kendi tahtandan alınıyor (tahta herkeste
   aynı); her rakip yalnızca temizlenen alan haritasıyla (g) maskeleniyor.
   Yeri ve ölçeği layout'tan (mpSplit, mpPlaceRivals). */
function mpRivals(){
  UI.rvList.innerHTML = '';
  mp.rv = {};
  mpSnap();
  for(const p of mp.players) if(p.id !== mp.you) mpView(p.id);
  mpPlaceRivals();
}
/* startLevel'dan hemen sonra: dzCanvas o an hiç temizlenmemiş hâli. Kadraja
   kırpılıp en çok 560 piksele küçültülüyor (her karede bu boyuttan
   kopyalanıyor; rakip tahtası ekranda büyük olsa da yeterince keskin). */
function mpSnap(){
  const F = frameCells(), sx = F.x0*SC, sy = F.y0*SC, sw = (F.x1-F.x0)*SC, sh = (F.y1-F.y0)*SC;
  const q = Math.min(1, 560/Math.max(sw, sh)), W = Math.max(1, Math.round(sw*q)), H = Math.max(1, Math.round(sh*q));
  const cut = src => { const cv = makeCanvas(W, H); cv.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, W, H); return cv; };
  const sick = cut(dzCanvas), sc = sick.getContext('2d');
  sc.globalCompositeOperation = 'lighter'; sc.drawImage(rimCanvas, sx, sy, sw, sh, 0, 0, W, H);   // sınır ışıması dokuyla birlikte kalkıyor
  mp.snap = { F, W, H, heal:cut(bgCanvas), sick, wall:cut(wallCanvas), tmp:makeCanvas(W, H), mask:makeCanvas(MPW, MPH) };
}
function mpView(id){
  let v = mp.rv[id];
  if(v) return v;
  const p = mpWho(id); if(!p || !mp.snap) return null;
  const el = document.createElement('div');
  el.className = 'rv'; el.style.setProperty('--pc', mpCol(p));
  el.innerHTML = '<div class="rvTop"><b></b><span><s></s><i class="rvL"></i></span></div><i class="rvBar"><u></u><em></em></i><canvas aria-hidden="true"></canvas>';
  UI.rvList.appendChild(el);
  const cv = el.querySelector('canvas'), mapCv = makeCanvas(mp.snap.W, mp.snap.H);
  v = mp.rv[id] = { id, el, cv, ctx:cv.getContext('2d'), k:1, u:1, mapCv, mapCtx:mapCv.getContext('2d'), col:mpCol(p),
    name:el.querySelector('b'), st:el.querySelector('s'), lv:el.querySelector('.rvL'), bar:el.querySelector('u'), goal:el.querySelector('em'),
    bits:null, full:false, prev:null, cur:null, at:0, d:MP_SEND_MS };
  v.name.textContent = p.name;
  mpSizeRival(v);
  mpPaintMap(v);
  return v;
}
/* Grubun yeri layout'ta hesaplanıyor (mp.lay); burada DOM'a ve tuvallere
   işleniyor. Tuval ekrandaki boyutunun en çok 2 katı çözünürlükte. */
function mpPlaceRivals(){
  const L = mp.lay, el = UI.rivals, st = el.style;
  if(!L){ st.left = st.top = st.width = ''; return; }
  st.left = Math.round(L.gx) + 'px'; st.top = Math.round(L.gy) + 'px'; st.width = (L.gw + 1) + 'px';   // +1: kartlar yuvarlamada alt satıra kaymasın
  el.classList.toggle('below', L.dir === 'col');
  el.classList.toggle('narrow', (L.fx1 - L.fx0)*CS*L.rs < 190);   // dar kartta can sayısı yerine yalnızca yüzde
  UI.rvList.style.gap = L.gr + 'px';
  UI.rvTitle.textContent = L.n > 1 ? 'RAKİPLER' : 'RAKİP';
  for(const id in mp.rv) mpSizeRival(mp.rv[id]);
}
function mpSizeRival(v){
  const L = mp.lay; if(!L) return;
  const cw = Math.round((L.fx1 - L.fx0)*CS*L.rs), ch = Math.round((L.fy1 - L.fy0)*CS*L.rs);
  const r = Math.min(window.devicePixelRatio || 1, 2), bw = Math.max(1, Math.round(cw*r)), bh = Math.max(1, Math.round(ch*r));
  v.el.style.width = cw + 'px';
  v.cv.style.width = cw + 'px'; v.cv.style.height = ch + 'px';
  if(v.cv.width !== bw || v.cv.height !== bh){ v.cv.width = bw; v.cv.height = bh; }
  v.k = bw/(L.fx1 - L.fx0);   // tuval pikseli / ızgara hücresi
  v.u = r;                    // tuval pikseli / ekran pikseli
}
/* Temizlenen alan: 2x2 blokluk harita maskeye, maske yumuşatılarak dokunun
   üstünden siliniyor (kenarlar basamaklı değil). */
function mpPaintMap(v){
  const S = mp.snap; if(!S) return;
  const F = S.F, W = S.W, H = S.H, t = S.tmp.getContext('2d');
  t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, W, H);
  if(!v.full){
    t.drawImage(S.sick, 0, 0);
    if(v.bits){
      const m = S.mask.getContext('2d'), img = m.createImageData(MPW, MPH), d = img.data;
      for(let k=0;k<MPW*MPH;k++) if(v.bits[k>>3] >> (k&7) & 1) d[k*4+3] = 255;
      m.putImageData(img, 0, 0);
      t.globalCompositeOperation = 'destination-out'; t.imageSmoothingEnabled = true;
      t.drawImage(S.mask, F.x0/MPB, F.y0/MPB, (F.x1-F.x0)/MPB, (F.y1-F.y0)/MPB, 0, 0, W, H);
      t.globalCompositeOperation = 'source-over';
    }
  }
  const c = v.mapCtx;
  c.clearRect(0, 0, W, H);
  c.drawImage(S.heal, 0, 0); c.drawImage(S.tmp, 0, 0); c.drawImage(S.wall, 0, 0);
}
function mpPose(v, now){
  const c = v.cur, p = v.prev;
  if(!p) return c;
  const k = clamp((now - v.at)/v.d, 0, 1);
  const arr = (a, b) => a.length === b.length ? b.map((q, j) => Math.abs(q - a[j]) > 6 ? q : lerp(a[j], q, k)) : b;
  const jump = Math.abs(c.x - p.x) + Math.abs(c.y - p.y) > 6;   // ölüm sonrası başa dönüş: süzülmesin
  return { x:jump ? c.x : lerp(p.x, c.x, k), y:jump ? c.y : lerp(p.y, c.y, k), v:arr(p.v, c.v), m:arr(p.m, c.m), c:c.c };
}
function mpState(m){
  if(!mp.going || mp.fins[m.from]) return;   // kartlar tur başlayınca, o günün kesitiyle kuruluyor
  const v = mpView(m.from); if(!v) return;
  const now = performance.now();
  v.prev = v.cur ? mpPose(v, now) : null;
  v.cur = { x:+m.x || 0, y:+m.y || 0, v:Array.isArray(m.v) ? m.v : [], m:Array.isArray(m.m) ? m.m : [], c:Array.isArray(m.c) ? m.c : null };
  v.at = now; v.d = clamp(+m.d || MP_SEND_MS, 30, 400);
  mp.live[m.from] = { p:clamp((m.p|0)/1000, 0, 1), s:m.s|0, l:m.l|0 };
  if(typeof m.g === 'string'){
    try{ const s = atob(m.g), b = new Uint8Array(mpBits.length); for(let j=0;j<b.length && j<s.length;j++) b[j] = s.charCodeAt(j); v.bits = b; mpPaintMap(v); }catch(e){}
  }
  if(mp.view === 'wait' && now - mp.waitAt > 500) mpShowWait();
}
function mpDrawRival(v, now){
  const c = v.ctx, W = v.cv.width, H = v.cv.height, k = v.k, u = v.u, S = mp.snap;
  c.clearRect(0, 0, W, H);
  if(!S) return;
  c.imageSmoothingEnabled = true;
  c.drawImage(v.mapCv, 0, 0, W, H);
  if(isTouch){ c.fillStyle = 'rgba(6,13,20,.16)'; c.fillRect(0, 0, W, H); }   // telefonda biraz sönük: göz kendi tahtanda kalsın
  if(!v.cur || mp.fins[v.id]) return;
  const P = mpPose(v, now), L = G.level, F = S.F;
  const X = gx => (gx - F.x0 + .5)*k, Y = gy => (gy - F.y0 + .5)*k;
  const sprite = (img, x, y, w, ar, rot) => {
    c.save(); c.translate(x, y); if(rot) c.rotate(rot);
    c.drawImage(img, -w/2, -w*ar/2, w, w*ar); c.restore();
  };
  if(P.c && P.c.length >= 2){   // kesim çizgisi: köşeler + oyuncunun şimdiki yeri
    c.strokeStyle = v.col; c.lineWidth = Math.max(2*u, k*.8); c.lineJoin = c.lineCap = 'round';
    c.beginPath(); c.moveTo(X(P.c[0]), Y(P.c[1]));
    for(let j=2;j<P.c.length;j+=2) c.lineTo(X(P.c[j]), Y(P.c[j+1]));
    c.lineTo(X(P.x), Y(P.y)); c.stroke();
  }
  // mikroplar: türü kendi tahtandaki aynı sıradaki mikroptan (başlangıçta herkeste aynı)
  const mw = Math.max(7*u, 30/CS*k), spin = now/1000;
  for(let j=0;j<P.m.length;j+=2){
    const e = G.minions[j>>1], kind = e ? e.kind : 0;
    sprite(kind ? minionSporeImg : minionFlagellaImg, X(P.m[j]), Y(P.m[j+1]), mw, MINI_AR[kind], spin*((j>>1)%2 ? 1.2 : -1.2));
  }
  const tier = L.bossTier|0, bw = Math.max(12*u, L.bossR*2*k);
  for(let j=0;j<P.v.length;j+=2){
    const x = X(P.v[j]), y = Y(P.v[j+1]);
    c.fillStyle = 'rgba(255,90,44,.22)'; c.beginPath(); c.arc(x, y, bw*.78, 0, 7); c.fill();   // kızarıklık
    sprite(BOSS_IMGS[tier], x, y, bw, BOSS_AR[tier], 0);
  }
  // siklamen: rakibin renginde halka, kimin tahtası olduğu bir bakışta belli
  const pw = Math.max(15*u, PLAYER_SIZE/CS*k), px = X(P.x), py = Y(P.y);
  c.beginPath(); c.arc(px, py, pw*.62, 0, 7);
  c.fillStyle = 'rgba(6,13,20,.45)'; c.fill(); c.lineWidth = 2*u; c.strokeStyle = v.col; c.stroke();
  sprite(playerImg, px, py, pw, PLAYER_AR, 0);
}
function mpStatus(id){
  // kendi fin iletin sunucudan dönmeden de aynı yazı
  const f = mp.fins[id] || (id === mp.you && mp.mine ? Object.assign({ pct:Math.round(G.pct*1000) }, mp.mine) : null);
  const lv = mp.live[id], L = G.level;
  if(f) return f.ok ? '✓ Bitirdi · ' + mpTime(f.time) : (f.why === 'time' ? 'Süre doldu' : 'Elendi') + ' · %' + Math.floor(f.pct/10);
  if(mp.away[id]) return 'Ara verdi';
  return lv ? '%' + Math.floor(lv.p*100) + ' / %' + Math.round(L.target*100) : 'Başlıyor…';
}
/* Her karede: durum gönder, süreyi say, rakip kartlarını çiz. DOM yalnızca
   değişince yazılıyor. */
function mpTick(now){
  if(G.state === 'play'){
    if(now >= mp.endsAt){
      G.state = 'over'; G.drawing = false;
      toast('SÜRE DOLDU', 'Alanın %' + Math.floor(G.pct*100) + "'" + pctPoss(Math.floor(G.pct*100)) + ' temizlendi');
      mpFinish(false, 'time'); mpRefresh();
    } else mpSend();
  }
  const left = (mp.endsAt - now)/1000, ct = mp.over ? 'BİTTİ' : 'KALAN ' + mpTime(left);
  if(UI.rvClock._t !== ct){ UI.rvClock.textContent = ct; UI.rvClock._t = ct; UI.rvClock.classList.toggle('low', !mp.over && left < 30); }
  for(const id in mp.rv){
    const v = mp.rv[id], L = G.level, lv = mp.live[id], f = mp.fins[id];
    const st = mpStatus(+id);
    if(v.st._t !== st){ v.st.textContent = st; v.st._t = st; }
    const lt = (lv && !f && !mp.away[id]) ? ' · ' + lv.l + ' can' : '';   // dar kartta gizli
    if(v.lv._t !== lt){ v.lv.textContent = lt; v.lv._t = lt; }
    const pw = ((f ? f.pct/1000 : lv ? lv.p : 0)*100).toFixed(1) + '%';
    if(v.bar._w !== pw){ v.bar.style.width = pw; v.bar._w = pw; }
    if(!v.goal._s){ v.goal.style.left = (L.target*100) + '%'; v.goal._s = 1; }
    const cls = 'rv' + (f ? (f.ok ? ' done' : ' out') : mp.away[id] ? ' away' : '');
    if(v.el.className !== cls) v.el.className = cls;
    mpDrawRival(v, now);
  }
}
function mpFinish(ok, why){
  if(!mp.inRound || mp.mine) return;
  const time = Math.round((performance.now() - mp.t0)/100)/10;
  mp.mine = { ok, why:why || '', time };
  mpSend(true);
  net.send({ t:'fin', ok, time, pct:Math.round(G.pct*1000), score:G.score, why:why || '' });
}
function mpFin(m){
  if(!mp.inRound || mp.fins[m.from]) return;
  mp.fins[m.from] = m;
  if(m.ok) mp.order.push(m.from);
  const p = mpWho(m.from), v = mp.rv[m.from];
  if(v && m.ok){ v.full = true; mpPaintMap(v); }
  if(p && m.from !== mp.you && G.state === 'play')
    toast(p.name.toLocaleUpperCase('tr-TR'), m.ok ? (mp.order.length === 1 ? 'HEDEFE İLK ULAŞTI' : 'HEDEFE ULAŞTI') : m.why === 'time' ? 'SÜRESİ DOLDU' : 'ELENDİ');
  mpRoundOver(); mpRefresh();
}
/* Sonuç her istemcide ayrı hesaplanıyor; girdiler (fin iletileri, sunucudan
   herkese aynı sırayla geçiyor) aynı olduğu için herkes aynı sonucu görüyor.
   over: bir kez — geç gelen ileti ya da oyuncu çıkışı puanı iki kez eklemesin. */
function mpRoundOver(){
  if(!mp.inRound || mp.over || !mp.players.length) return;
  if(!mp.players.every(p => mp.fins[p.id] || mp.away[p.id])) return;
  mp.over = true;
  const rows = mp.players.map(p => {
    const f = mp.fins[p.id], lv = mp.live[p.id], me = p.id === mp.you;
    return { p, f, ok:!!(f && f.ok), ord:f && f.ok ? mp.order.indexOf(p.id) : 99,
      pct:f ? f.pct/1000 : me ? mp.sentP : lv ? lv.p : 0, score:f ? f.score : me ? mp.sentS : lv ? lv.s : 0 };
  });
  // önce bitirenler varış sırasıyla, sonra bitiremeyenler temizledikleri alanla
  rows.sort((a, b) => (b.ok - a.ok) || (a.ord - b.ord) || (b.pct - a.pct) || (b.score - a.score));
  rows.forEach((r, i) => { r.pts = r.ok ? (MP_POINTS[i] || 0) : 0; mp.totals[r.p.id] = (mp.totals[r.p.id] || 0) + r.pts; });
  mp.result = rows;
  if(G.state === 'play'){ G.state = 'over'; G.drawing = false; }   // ara verirken tur bitti
}
/* Oyun bitince hangi panel: tur bittiyse sonuç, sen bitirdiysen bekleme.
   Aynı panel açıksa yalnızca içeriği yenileniyor (bkz. mpPanel), odak kaçmıyor. */
function mpRefresh(){
  if(!mp.inRound || mp.view === 'reveal') return;
  if(mp.over) mpShowResults();
  else if(mp.mine || G.state === 'over') mpShowWait();
}
function mpPanel(html, view){
  const same = mp.view === view && UI.overlay.classList.contains('on');
  mp.view = view;
  if(same){ UI.plate.innerHTML = html; return; }
  showPanel(html);
}
/* Bekleme ve sonuç satırı: ad üstte, durum altında — dar telefonda ad kesilmesin. */
function mpRowHTML(p, side, right, rank){
  return `<div class="mpRow" style="--pc:${mpCol(p)}">${rank ? `<span class="mpRank">${rank}</span>` : ''}<i></i>
    <div class="mpWho"><b><span>${escapeHtml(p.name)}</span>${p.id === mp.you ? '<em class="mpTag">SEN</em>' : ''}</b><small>${side}</small></div>${right || ''}</div>`;
}
function mpShowWait(){
  mp.waitAt = performance.now();
  const me = mp.mine || { ok:false, why:'' }, pct = Math.floor(G.pct*100);
  const title = me.ok ? 'Hedefe <em>ulaştın</em>' : me.why === 'time' ? 'Süre <em>doldu</em>' : 'Canların <em>bitti</em>';
  const lede = me.ok ? mpTime(me.time) + ' içinde bitirdin.' : "Alanın %" + pct + "'" + pctAcc(pct) + ' temizledin.';
  const rows = mp.players.map(p => mpRowHTML(p, escapeHtml(mpStatus(p.id)))).join('');
  mpPanel(
    `<div class="kicker">YARIŞ · GÜN ${String(G.level.day).padStart(2,'0')}</div>
     <div class="title">${title}</div>
     <p class="lede">${lede} Diğerleri bitirince sonuçlar burada.</p>
     <div class="mpList">${rows}</div>
     <div class="menuStack"><button class="menuBtn ghost" data-a="mpleave">ODADAN ÇIK</button></div>`, 'wait');
}
function mpShowResults(){
  if(mp.view !== 'results') Sound.scene('menu');
  const L = LEVELS[mp.level], last = mp.level >= LEVELS.length-1, host = mp.host === mp.you;
  const R = mp.result || [], win = R[0], can = mp.players.length >= 2;
  const name = r => r.p.id === mp.you ? 'Sen' : escapeHtml(r.p.name);
  const title = win && win.ok ? (win.p.id === mp.you ? 'Sen <em>kazandın</em>' : name(win) + ' <em>kazandı</em>') : 'Kimse hedefe <em>ulaşamadı</em>';
  const side = r => r.ok ? '✓ ' + mpTime(r.f.time) : '%' + Math.floor(r.pct*100) + ' · ' +
    (r.f ? (r.f.why === 'time' ? 'süre doldu' : 'elendi') : 'ara verdi');
  const rows = R.map((r, i) => mpRowHTML(r.p, side(r), `<span class="mpPts">+${r.pts}</span><span class="mpTot">${mp.totals[r.p.id] || 0}</span>`, i+1)).join('');
  // genel sıralama: toplam puan
  const lead = mp.players.slice().sort((a, b) => (mp.totals[b.id] || 0) - (mp.totals[a.id] || 0))[0];
  const hostP = mpWho(mp.host);
  mpPanel(
    `<div class="kicker">GÜN ${String(L.day).padStart(2,'0')} SONUCU · ${escapeHtml(L.regionName.toLocaleUpperCase('tr-TR'))} ${L.sideName}</div>
     <div class="title">${title}</div>
     ${last && lead ? `<p class="note">Kür tamamlandı. Genel birinci: <b>${lead.id === mp.you ? 'sen' : escapeHtml(lead.name)}</b> · ${mp.totals[lead.id] || 0} puan.</p>` : ''}
     <div class="mpHead"><span>SIRA</span><span>TUR</span><span>TOPLAM</span></div>
     <div class="mpList mpRes">${rows}</div>
     <p class="mpMsg" id="mpNote" role="status">${!can ? 'Odada yalnız kaldın. Oda kodu <b>' + mp.code + '</b>: arkadaşın katılınca devam edebilirsin.'
       : host ? (mp.players.length < 3 ? 'Oda kodu <b>' + mp.code + '</b>: başka biri şimdi katılabilir.' : '')
       : 'Ev sahibi (' + escapeHtml(hostP ? hostP.name : '') + ') ' + (last ? 'yeni kürü' : 'ertesi günü') + ' başlatınca devam edilecek.'}</p>
     <div class="menuStack">
       ${host ? `<button class="menuBtn primary" data-a="${last ? 'mpagain' : 'mpnext'}"${can ? '' : ' disabled'}>${last ? 'YENİ KÜR · GÜN 1' : 'ERTESİ GÜN ▶'}</button>` : ''}
       <button class="menuBtn ghost" data-a="mpleave">ODADAN ÇIK</button>
     </div>`, 'results');
}

/* =========================================================================
   11. OYUNCU HAREKETİ
   ========================================================================= */
function markTrail(i){ cells[i] = TRAIL; G.trail.push(i); }
/* GOAL-033: VOLFIED KURALI. Oyuncu kesmiyorken yalnızca ÇİZGİNİN üstünde
   yürüyebiliyor: açık (temizlenmemiş) dokunun kenarındaki hücreler, yani
   komşularından (çaprazlar dahil) en az biri açık olan dolu hücreler. Eskiden
   bütün kemikte ve temizlenmiş alanın içinde serbestçe dolaşılabiliyordu;
   orijinal Volfied'da olduğu gibi artık çizgiden çıkılamıyor. Çaprazlar
   sayılıyor ki dış köşelerde çizgi kopmasın. */
function onEdge(i){
  const x = i%GW, y = (i/GW)|0;
  for(let dy=-1;dy<=1;dy++){
    const yy = y+dy; if(yy<0 || yy>=GH) continue;
    for(let dx=-1;dx<=1;dx++){
      const xx = x+dx; if(xx<0 || xx>=GW || (!dx && !dy)) continue;
      if(cells[yy*GW+xx] === EMPTY) return true;
    }
  }
  return false;
}
function canStep(dir){
  const dv = DIRV[dir], nx = G.px+dv[0], ny = G.py+dv[1];
  if(nx<0 || ny<0 || nx>=GW || ny>=GH) return false;
  if(G.drawing) return true;                 // kesim sırasında açık dokuda serbest
  const c = cells[ny*GW+nx];
  return c === EMPTY || (c === FILL && onEdge(ny*GW+nx));
}
/* Kenar izleme. Kesitler eğri olduğu için çizgi ızgarada merdiven basamağı
   gibi ilerliyor; yalnızca basılan yönde yürümek oyuncuyu her basamakta
   durdurup yön değiştirmeye zorluyordu. Basılan yön kapalıysa oyuncu çizgi
   üstünde dik yöne bir adım kayıyor ve konturu kendisi takip ediyor. Yalnızca
   DOLU çizgi hücrelerine kayılıyor — kayarken istemeden kesime girilmesin.
   Kayma yalnızca en fazla dört adım içinde basılan yön yeniden açılıyorsa
   yapılıyor: eğriyi takip ediyor ama düz bir duvara dayanınca Volfied'daki
   gibi duruyor. İki yan da uygunsa daha yakın açılan taraf, eşitse önceki
   kayma tarafı seçiliyor; hâlâ belirsizse oyuncu duruyor. */
function edgeIdx(x, y, dir){
  const dv = DIRV[dir], nx = x+dv[0], ny = y+dv[1];
  return (nx<0 || ny<0 || nx>=GW || ny>=GH) ? -1 : ny*GW+nx;
}
const isLine = i => i >= 0 && cells[i] === FILL && onEdge(i);
function slideDir(dir){
  const perp = (dir === 1 || dir === 2) ? [3,4] : [1,2];
  let pick = 0, best = 9;
  for(const p of perp){
    let x = G.px, y = G.py;
    for(let k=1;k<=4;k++){
      const i = edgeIdx(x, y, p);
      if(!isLine(i)) break;
      x = i%GW; y = (i/GW)|0;
      if(isLine(edgeIdx(x, y, dir))){
        if(k < best || (k === best && p === G.slide)){ best = k; pick = p; }
        else if(k === best) pick = -1;              // iki yan eşit: belirsiz
        break;
      }
    }
  }
  if(pick < 0) pick = 0;
  G.slide = pick;
  return pick;
}
/* Bir kapanış çevreyi tamamen doldurduysa oyuncunun durduğu hücre artık
   çizgi değildir; en yakın çizgi hücresine taşınıyor (ölüm/hapşırık
   sonrasında da, dönülen başlangıç noktası içeride kalmış olabilir). */
function snapToEdge(){
  const s0 = G.py*GW + G.px;
  if(cells[s0] === FILL && onEdge(s0)) return;
  bfsSeen.fill(0);
  let qh = 0, qt = 0;
  bfsQ[qt++] = s0; bfsSeen[s0] = 1;
  while(qh < qt){
    const i = bfsQ[qh++];
    if(cells[i] === FILL && onEdge(i)){ G.px = i%GW; G.py = (i/GW)|0; return; }
    const x = i%GW, y = (i/GW)|0;
    if(x>0    && !bfsSeen[i-1]) { bfsSeen[i-1] = 1;  bfsQ[qt++] = i-1; }
    if(x<GW-1 && !bfsSeen[i+1]) { bfsSeen[i+1] = 1;  bfsQ[qt++] = i+1; }
    if(y>0    && !bfsSeen[i-GW]){ bfsSeen[i-GW] = 1; bfsQ[qt++] = i-GW; }
    if(y<GH-1 && !bfsSeen[i+GW]){ bfsSeen[i+GW] = 1; bfsQ[qt++] = i+GW; }
  }
}
function stepPlayer(dir){
  const dv = DIRV[dir || G.dir], dx = dv[0], dy = dv[1];
  const nx = G.px+dx, ny = G.py+dy;
  if(nx<0||ny<0||nx>=GW||ny>=GH){ G.dir = 0; return; }
  const ni = ny*GW+nx, c = cells[ni];
  if(G.drawing){
    if(c === TRAIL){ die(); return; }
    G.px = nx; G.py = ny;
    if(c === FILL) closeTrail(); else markTrail(ni);
  } else {
    if(c === FILL && !onEdge(ni)){ G.frac = 0; return; }   // GOAL-033: çizgiden çıkılmaz
    G.px = nx; G.py = ny;
    if(c === EMPTY){
      G.drawing = true;
      G.startCell = (ny-dy)*GW + (nx-dx);
      G.corners = [{x:nx-dx, y:ny-dy}];
      markTrail(ni);
    }
  }
}
function movePlayer(dt){
  const want = readInput();
  if(want){
    if(G.dir === 0){
      // GOAL-013 (madde 9): yön girdisi kısa süreliğine bırakılıp tam ters yöne
      // basıldığında (G.dir sıfıra düştüğü an "rev" kontrolü atlanıyordu) oyuncu
      // kendi tazeçizdiği TRAIL hücresine adım atıp anında ölüyordu. Aşağıdaki
      // "else if" dalındaki ile AYNI ters-yön engeli burada da uygulanıyor;
      // gerçek öz-kesişim/kesişme ölümlerine (stepPlayer içindeki TRAIL
      // kontrolü) hiç dokunulmadı.
      const revFromRelease = G.drawing && want === OPP[G.lastDir];
      if(!revFromRelease){
        if(G.drawing && G.corners.length){
          const lc = G.corners[G.corners.length-1];
          if(lc.x !== G.px || lc.y !== G.py) G.corners.push({x:G.px, y:G.py});
        }
        G.dir = want; G.frac = 0; G.lastDir = want;
      }
    } else if(want !== G.dir){
      const rev = want === OPP[G.dir];
      if(!(rev && G.drawing)){
        if(G.frac > .5) stepPlayer(G.moveDir || G.dir);
        G.frac = 0;
        if(G.drawing && G.corners.length) G.corners.push({x:G.px, y:G.py});
        G.dir = want; G.lastDir = want;
      }
    }
  } else { G.dir = 0; G.frac = 0; G.moveDir = 0; G.slide = 0; }
  if(!G.dir) return;
  /* GOAL-033: yön çizginin dışına çıkıyorsa kenar boyunca kay; o da yoksa
     olduğu yerde dur (kıpırdamadan). moveDir, o anki gerçek adım yönü —
     çizim ara konumu onunla hesaplıyor. */
  const effDir = () => {
    if(canStep(G.dir)){ G.slide = 0; return G.dir; }
    return G.drawing ? 0 : slideDir(G.dir);
  };
  let eff = effDir();
  if(!eff){ G.frac = 0; G.moveDir = 0; return; }
  G.moveDir = eff;
  // GOAL-027: akış açıldıkça ilaç dokuda daha hızlı yayılıyor
  const spd = (G.buffs.SPEED ? PLAYER_SPD_FAST : PLAYER_SPD) * (1 + G.flow*.22);
  G.frac += spd*dt;
  let guard = 0;
  while(G.frac >= 1 && guard++ < 8){
    G.frac -= 1; stepPlayer(eff);
    if(!G.dir || G.state !== 'play'){ G.frac = 0; break; }
    eff = effDir();
    if(!eff){ G.frac = 0; G.moveDir = 0; break; }
    G.moveDir = eff;
  }
}

/* =========================================================================
   12. ALAN KAPATMA
   ========================================================================= */
function closeTrail(){
  const newCells = [];
  for(const i of G.trail){ cells[i] = FILL; newCells.push(i); }
  markBuf.fill(0);
  for(const b of G.bosses){
    spanFill(Math.round(b.x), Math.round(b.y));
    for(let a=0;a<8;a++){
      const an = a/8*Math.PI*2;
      spanFill(Math.round(b.x+Math.cos(an)*b.r*.7), Math.round(b.y+Math.sin(an)*b.r*.7));
    }
  }
  for(let i=0;i<cells.length;i++) if(cells[i]===EMPTY && !markBuf[i]){ cells[i]=FILL; newCells.push(i); }

  let gain = 0, minX = GW, minY = GH, maxX = 0, maxY = 0;
  for(const i of newCells){
    const x = i%GW, y = (i/GW)|0;
    if(x<minX) minX = x; if(x>maxX) maxX = x;
    if(y<minY) minY = y; if(y>maxY) maxY = y;
    if(x>=B && y>=B && x<GW-B && y<GH-B && cavity[i]) gain++;   // GOAL-015
  }
  rasterRegion(minX, minY, maxX, maxY);

  let f = 0;
  for(let y=B;y<GH-B;y++){ const row = y*GW; for(let x=B;x<GW-B;x++){ const i = row+x;
    if(cavity[i] && cells[i]===FILL) f++; } }
  G.filled = f;
  const prev = G.pct;
  G.pct = f/Math.max(1,cavCount);   // GOAL-015: payda artık boşluk hücre sayısı
  const share = G.pct - prev;
  mp.mapDirty = true;               // çok oyunculu: rakiplere yeni haritayı gönder

  for(let k=G.minions.length-1;k>=0;k--){
    const m = G.minions[k];
    if(cells[Math.round(m.y)*GW + Math.round(m.x)] === FILL){
      burst(m.x, m.y, 20, m.kind ? 0xffe08a : 0xb7f27a);
      m.s.destroy(); G.minions.splice(k,1); G.score += 250;
    }
  }
  for(let k=G.pus.length-1;k>=0;k--){
    const p = G.pus[k];
    if(!p.collected && cells[p.y*GW+p.x] === FILL){
      grabPowerup(p);
      p.collected = true; p.collectT = 0; // GOAL-009: hemen yok etmek yerine render() içinde büyüyüp sönsün
    }
  }
  const ns = Math.min(110, 14 + ((gain/32)|0));
  for(let n=0;n<ns;n++){
    const i = newCells[(Math.random()*newCells.length)|0];
    burst(i%GW, (i/GW)|0, 1, 0x9ff0ec, .7);
  }
  const areaScore = Math.round(gain*1.2*flowMult());   // GOAL-027: akış çarpanı
  G.score += areaScore;
  G.dose = clamp(G.dose + share*G.doseMax*2.2, 0, G.doseMax);
  Sound.capture(share);
  G.shake = Math.min(7, share*40);
  let popupScore = areaScore;
  if(share >= MEGA_SHARE){
    G.score += 1500;
    popupScore += 1500;
    toast('MÜKEMMEL', 'TEK HAMLEDE %'+Math.round(share*100)+' · +1500');
  } else if(share >= 0.03){
    toast('BÜYÜK TEMİZLİK', '+%'+Math.round(share*100)+' alan');
  } else if(share > 0){
    toast('GÜZEL', '+%'+(share*100).toFixed(1)+' alan');
  }
  spawnScorePopup((minX+maxX)/2, (minY+maxY)/2, popupScore);

  G.drawing = false; G.trail = []; G.corners = [];
  snapToEdge();                              // GOAL-033
  G.startCell = G.py*GW+G.px;

  /* GOAL-028: her kapanıştan sonra nefesi yeniden ölç. Hücreler yalnızca
     burada değiştiği için bu tek nokta yeterli — akış göstergesi anında tepki
     veriyor, yani "dokuyu açtım" anı oyuncuya hemen geri bildiriliyor.
     Nefesin o bölümde ilk kez baştan sona geçtiği an bir kez ödüllendiriliyor. */
  computeBreath();
  if(breath.top && !G.fullBreath){
    G.fullBreath = true;
    G.score += 1500;
    G.breathFlash = 1;
    spawnBreathPuffs(Math.round(lerp(breath.y1, breath.y0, .5)), 14);
    spawnScorePopup(cavCX, breath.y0 + 5, 1500);
    toast('NEFES AÇILDI', 'HAVA DİPTEN TEPEYE ULAŞTI · +1500');
    Sound.breathOpen();
    G.pressure = Math.max(0, G.pressure - .25);
  }

  /* GOAL-027: gün yalnızca alan hedefiyle bitiyor. Hava yolu şartı kalktı —
     oyuncu hedefi tutturmuşken "bir de kanalı bağla" diye tutulmuyor. Kanal
     artık bir kapı değil bir yatırım: açtıkça bütün saha lehine dönüyor
     (bkz. flowMult, movePlayer, updateEnemies, doz yanması) ve gün sonunda
     akış bonusu olarak ayrıca ödüllendiriliyor (bkz. levelClear). */
  Info.onCapture((minX+maxX)/2, (minY+maxY)/2);   // GOAL-031: kestikçe bilgi şeridi ilerliyor
  if(G.pct >= G.level.target) levelClear();
  syncHUD();
}
/* =========================================================================
   12b. NEFES DÖNGÜSÜ (GOAL-015)

   Vücut belirli aralıklarla nefes almayı deniyor. Üç sonuç var:
     AÇIK    — kanal tam: büyük puan, seri bonusu, basınç düşer, doz tazelenir
     SIZINTI — hava yolun yarısından fazlasını geçti: küçük puan, az basınç
     TIKALI  — hava duvara çarptı: basınç zıplar, ekran sarsılır

   Basınç ekranı kızartan tek değişken. Tavana vurduğunda oyuncuyu öldürmüyor;
   bunun yerine hapşırma tetikleniyor. Ölüm spirali yerine gösterişli bir
   tahliye: basınç boşalıyor ama havadaki çizgin dağılıyor.
   ========================================================================= */
function doBreath(){
  const L = G.level;
  G.breathT = L.breath; G.breathCue = false;
  UI.airway.classList.remove('soon');
  computeBreath();
  /* GOAL-028: dalga animasyonunu kur — alttan başlayıp nefesin tükendiği
     satıra kadar çıkacak. Süre mesafeyle orantılı ki uzun bir nefes uzun
     sürsün, daha başlarken tıkanan nefes kısa kesilsin. */
  G.waveT = 0; G.waveDur = .6 + breath.hFrac*1.4;
  G.waveY0 = breath.y1; G.waveY1 = breath.stallY; G.waveOk = breath.reach;
  G.waveTop = breath.top;
  if(breath.top){
    G.breathStreak++;
    const gain = 700 + G.breathStreak*350;
    G.score += gain;
    G.pressure = Math.max(0, G.pressure - .42);
    G.dose = clamp(G.dose + G.doseMax*.22, 0, G.doseMax);
    G.breathFlash = 1;
    spawnScorePopup(cavCX, breath.y0 + 5, gain);
    toast('NEFES GEÇTİ', G.breathStreak > 1
      ? G.breathStreak+'. TEMİZ NEFES · +'+gain
      : 'HAVA BAŞTAN SONA GEÇTİ · +'+gain);
    Sound.breathOpen();
  } else {
    /* GOAL-027: sert eşik yok, eğri var — havanın gittiği yol kadar puan
       alıyorsun, gidemediği yol kadar basınç biriktiriyorsun. Kısmi ilerleme
       gerçekten ilerleme sayılıyor. */
    /* Puan hacimden (reach), basınç cezası mesafeden (hFrac) geliyor: ne kadar
       dokuyu havalandırdığın kazandırıyor, nefesi tepeye çıkaramamak
       cezalandırıyor. Sert eşik yok, ikisi de sürekli. */
    const r = clamp(breath.reach, 0, 1), hf = clamp(breath.hFrac, 0, 1);
    G.breathStreak = 0;
    const gain = Math.round(500*r*r);
    if(gain > 0){ G.score += gain; spawnScorePopup(cavCX, breath.stallY, gain); }
    /* Basınç cezası yalnızca yüksekliğe bakmıyor: temizlenmiş ama henüz dibe
       bağlanmamış doku da bir şey ifade ediyor. Yukarıdan aşağı temizleyen bir
       oyuncu alanın yarısını açmışken nefes hâlâ giremez (kural bu), ama vücut
       da tamamen tıkalı bir dokudaki kadar zorlanmaz. Bağlamak cezayı tamamen
       kaldırıyor, yani teşvik bozulmuyor; sadece ceza eğrisi insaflı. */
    G.pressure = clamp(G.pressure + L.pressGain*(1-hf)*(1 - .6*G.pct), 0, 1);
    G.blockFlash = 1;
    if(hf >= .5){
      toast('YARIM NEFES', 'HAVA %'+Math.round(hf*100)+' YÜKSELDİ' + (gain ? ' · +'+gain : ''));
      Sound.leak(); G.shake = Math.max(G.shake, 3);
    } else {
      toast('TIKALI', 'HAVA %'+Math.round(hf*100)+' · BASINÇ ARTIYOR');
      Sound.blocked(); G.shake = Math.max(G.shake, 6);
    }
  }
  if(G.pressure >= .999) sneezeRelease();
  syncHUD();
}

function sneezeRelease(){
  G.pressure = .3; G.shake = 22;
  Sound.sneeze();
  for(const b of G.bullets) b.s.destroy();
  G.bullets = [];
  for(const m of G.minions){                 // düşmanlar dağılır, ölmez
    const c = randomCavityCell(3);
    burst(m.x, m.y, 8, 0xffb0d2, .8);
    m.x = c.x; m.y = c.y;
  }
  if(G.drawing){                             // havadaki çizgi kaybolur (ölüm yok)
    for(const i of G.trail) cells[i] = EMPTY;
    G.trail = []; G.corners = []; G.drawing = false;
    G.dir = 0; G.frac = 0; G.lastDir = 0;
    if(cells[G.startCell] === FILL){ G.px = G.startCell % GW; G.py = (G.startCell/GW)|0; }
    else { const st = playerStart(); G.px = st.x; G.py = st.y; G.startCell = st.y*GW+st.x; }
    snapToEdge(); G.startCell = G.py*GW+G.px;   // GOAL-033
  }
  G.dose = Math.max(0, G.dose - G.doseMax*.2);
  G.invuln = Math.max(G.invuln, 1.2);
  toast('HAPŞUU!', 'BASINÇ BOŞALDI · ÇİZGİN DAĞILDI');
}

function grabPowerup(p){
  const m = PU_META[p.k];
  Sound.pickup(); G.score += 400;
  burst(p.x, p.y, 16, parseInt(m.color.slice(1),16), 1);
  if(p.k === PU.BOMB){
    for(let k=G.minions.length-1;k>=0;k--){
      const mm = G.minions[k];
      burst(mm.x, mm.y, 26, 0xffb0d2);
      mm.s.destroy(); G.minions.splice(k,1); G.score += 200;
    }
    for(const b of G.bullets) b.s.destroy();
    G.bullets = []; G.shake = 16;
    Sound.sneeze();
    toast('Hapşuu!', 'TRİGEMİNAL REFLEKS · EKRAN TEMİZLENDİ');
  } else if(p.k === PU.DOSE){
    G.dose = G.doseMax; toast(m.label, '24 SAATLİK KORUMA');
  } else {
    G.buffs[m.key] = m.dur; toast(m.label, 'AKTİF · '+m.dur+' SANİYE');
  }
  syncHUD();
}
function levelClear(){
  G.state = 'clear';
  if(Guide.step >= 0) Guide.finish();
  const bonus = Math.round((G.pct-G.level.target)*10000) + G.lives*500;
  const breathBonus = G.breathStreak*600;   // GOAL-015: kesintisiz nefes serisi
  // GOAL-027: hava yolu artık şart değil; karşılığını gün sonunda bonus olarak
  // veriyoruz ki "zorunlu değil ama çok değerli" dengesi rakamla da kurulsun.
  const flowBonus = Math.round(G.flow*4000);
  G.score += Math.max(0,bonus) + breathBonus + flowBonus;
  Sound.clear();
  if(mp.inRound){   // yarış: sonucu hemen bildir, açılıştan sonra bekleme/sonuç ekranı
    mpFinish(true);
    mp.view = 'reveal';
    const tok = ++ClearReveal.tok;
    ClearReveal.start(() => { if(tok === ClearReveal.tok && mp.view === 'reveal'){ mp.view = 'play'; mpRefresh(); } });
    return;
  }
  const last = G.levelIdx >= LEVELS.length-1;
  /* Günün bütün bilgileri, acele etmeden okunacak bir anda — oynarken
     kaçırılanlar da burada. Rengi o bölgenin harita rengi. */
  const facts = FACTS[G.level.day-1] || [];
  const learned = facts.length ? `<div class="learned" style="--rc:${ANAT_COL[G.level.region].join(',')}">
       <div class="lk">BUGÜN ÖĞRENDİKLERİN · ${escapeHtml(G.level.regionName.toLocaleUpperCase('tr-TR'))}</div>
       <ul>${facts.map(f => `<li><b>${escapeHtml(f.t)}</b><p>${escapeHtml(f.b)}</p></li>`).join('')}</ul>
     </div>` : '';
  // panel, kalan doku eriyip iyileşmiş resmin tamamı göründükten sonra
  const tok = ++ClearReveal.tok;
  ClearReveal.start(() => { if(tok === ClearReveal.tok && G.state === 'clear') showPanel(
    `<div class="kicker">GÜN ${String(G.level.day).padStart(2,'0')} TAMAMLANDI</div>
     <div class="title">%${Math.floor(G.pct*100)} <em>temizlendi</em></div>
     <p class="note">${G.level.med}</p>
     <div class="stats">
       <div><span>ALAN BONUSU</span><b>${Math.max(0,bonus).toLocaleString('tr-TR')}</b></div>
       <div><span>AKIŞ BONUSU</span><b>${flowBonus.toLocaleString('tr-TR')}</b></div>
       <div><span>NEFES SERİSİ</span><b>${G.breathStreak}</b></div>
       <div><span>TOPLAM SKOR</span><b>${G.score.toLocaleString('tr-TR')}</b></div>
     </div>
     ${learned}
     <div class="acts"><button class="cta" data-a="next">${last ? 'KÜRÜ TAMAMLA' : G.levelIdx === LEVELS.length-2 ? 'SON GÜNE GEÇ' : 'ERTESİ GÜN'}</button></div>`); });
}
/* Gün sonu açılışı: hedefe ulaşılınca kalan hastalıklı doku dipten tepeye
   (nefesin yönünde) eriyor, düşmanlar sönüyor ve açılan resmin tamamı
   görünüyor — gün %70 civarında bittiği için oyuncu iyileşen dokunun bütününü
   başka türlü hiç görmüyordu. Hareket azaltma tercihinde ve ticker durmuşken
   (denge testi) beklemeden geçiyor. */
const ClearReveal = {
  on:false, p:0, key:null, done:null, puffT:0, tok:0, hold:0, DUR:1.6, HOLD:1.1,   // HOLD: açılan resim panelden önce ekranda
  start(done){
    this.cancel();
    this.done = done;
    const instant = matchMedia('(prefers-reduced-motion: reduce)').matches || !app.ticker.started;
    const key = this.key || (this.key = new Float32Array(GW*GH));
    const y0 = cavBB.y0, h = Math.max(1, cavBB.y1 - cavBB.y0);
    for(let i=0;i<GW*GH;i++){
      const y = (i/GW)|0, hsh = ((i*2654435761)>>>0)/4294967296;
      key[i] = clamp((cavBB.y1 - 1 - y)/h, 0, 1)*.8 + hsh*.2;
    }
    this.p = instant ? 1 : 0; this.on = true; this.puffT = 0; this.hold = instant ? 0 : this.HOLD;
    if(instant) this.tick(0);
  },
  tick(dt){
    if(!this.on) return;
    this.p = Math.min(1, this.p + dt/this.DUR);
    const q = this.p*1.02, key = this.key;
    let y0 = GH, y1 = -1;                 // yalnızca bu karede değişen satır bandı
    for(let i=0;i<GW*GH;i++) if(cavity[i] && cells[i] !== FILL && key[i] <= q){
      cells[i] = FILL; const y = (i/GW)|0; if(y < y0) y0 = y; if(y > y1) y1 = y;
    }
    if(y1 >= 0) rasterRegion(0, y0, GW-1, y1);
    // eriyen cephede yukarı süzülen hava
    this.puffT -= dt;
    if(this.puffT <= 0 && this.p < 1){
      this.puffT = .09;
      spawnBreathPuffs(Math.round(lerp(cavBB.y1 - 1, cavBB.y0, this.p*.9)), 2);
    }
    const a = clamp(1 - this.p*1.8, 0, 1);
    for(const b of G.bosses){ b.s.alpha = a; b.g.alpha *= a; }
    for(const m of G.minions) m.s.alpha = a;
    for(const b of G.bullets) b.s.alpha = a;
    for(const p of G.pus){ p.s.alpha = a; p.g.alpha *= a; }
    if(this.p >= 1 && (this.hold -= dt) <= 0){ const d = this.done; this.on = false; this.done = null; if(d) d(); }
  },
  cancel(){ this.on = false; this.done = null; }
};
function die(){
  if(G.invuln > 0) return;
  G.lives--; Sound.hit(); G.shake = 14;
  burst(G.px, G.py, 46, 0xff5f8f);
  for(const i of G.trail) cells[i] = EMPTY;
  G.trail=[]; G.corners=[]; G.drawing=false; G.dir=0; G.frac=0; G.lastDir=0;
  G.px = G.startCell % GW; G.py = (G.startCell/GW)|0;
  // GOAL-015: geçersiz başlangıçta sabit alt-orta yerine burun deliğinin dibi
  if(cells[G.startCell] !== FILL){ const st = playerStart(); G.px = st.x; G.py = st.y; }
  snapToEdge(); G.startCell = G.py*GW+G.px;   // GOAL-033
  G.invuln = 1.8;
  G.dose = Math.max(G.dose, G.doseMax*.35);
  syncHUD();
  if(G.lives <= 0){
    G.state = 'over';
    if(mp.inRound){ mpFinish(false, 'out'); mpRefresh(); return; }   // yarış: elendin, diğerleri sürüyor
    // GOAL-013 (madde 3): oyun gerçekten sona eriyor — devam etmeden önce
    // zorunlu isim girişi + localStorage'a skor kaydı isteniyor.
    showGameOverNameEntry();
    G.lives = 3;
  }
}

/* =========================================================================
   13. PARÇACIKLAR
   ========================================================================= */
function burst(cx, cy, n, tint, scale){
  for(let i=0;i<n && particles.length < partSprites.length;i++){
    const a = rnd(0,7), sp = rnd(5,30);
    particles.push({ x:cx, y:cy, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp,
      life:rnd(.35,1), size:rnd(7,22)*(scale||1), tint:tint });
  }
}
function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.x += p.vx*dt; p.y += p.vy*dt;
    p.vx *= .93; p.vy = p.vy*.93 + 6*dt;
    p.life -= dt;
    if(p.life <= 0) particles.splice(i,1);
  }
  for(let i=0;i<partSprites.length;i++){
    const s = partSprites[i], p = particles[i];
    if(!p){ s.visible = false; continue; }
    s.visible = true;
    s.x = p.x*CS; s.y = p.y*CS;
    s.width = s.height = p.size * clamp(p.life/.6,.25,1.4);
    s.alpha = clamp(p.life*1.5,0,.85);
    s.tint = p.tint;
  }
}

/* =========================================================================
   14. DÜŞMANLAR
   ========================================================================= */
function solid(x,y){
  x|=0; y|=0;
  if(x<0||y<0||x>=GW||y>=GH) return true;
  return cells[y*GW+x] === FILL;
}
function moveEnemy(e, dt, wobble){
  if(G.buffs.FREEZE) return;
  // GOAL-015: kesit geometrisi yüzünden bir düşman duvarın içinde kalırsa
  // (dar koridor + yüksek hız) boşluğun merkezine doğru nazikçe geri itilir.
  const ci = clamp(Math.round(e.y),0,GH-1)*GW + clamp(Math.round(e.x),0,GW-1);
  if(!cavity[ci]){
    const a = Math.atan2(cavCY-e.y, cavCX-e.x), sp = Math.hypot(e.vx,e.vy) || e.spd;
    e.vx = Math.cos(a)*sp; e.vy = Math.sin(a)*sp;
    e.x += e.vx*dt*1.6; e.y += e.vy*dt*1.6;
    return;
  }
  let nx = e.x+e.vx*dt, ny = e.y+e.vy*dt;
  if(solid(nx + Math.sign(e.vx)*e.r, e.y)){ e.vx = -e.vx; nx = e.x; }
  if(solid(e.x, ny + Math.sign(e.vy)*e.r)){ e.vy = -e.vy; ny = e.y; }
  e.x = clamp(nx, B+e.r*.4, GW-B-e.r*.4);
  e.y = clamp(ny, B+e.r*.4, GH-B-e.r*.4);
  if(wobble){
    const a = Math.atan2(e.vy,e.vx) + rnd(-wobble,wobble)*dt;
    const sp = Math.hypot(e.vx,e.vy) || e.spd;
    e.vx = Math.cos(a)*sp; e.vy = Math.sin(a)*sp;
  }
}
function hitsTrail(e){
  if(!G.trail.length) return false;
  const x0 = Math.max(0,Math.floor(e.x-e.r)), x1 = Math.min(GW-1,Math.ceil(e.x+e.r));
  const y0 = Math.max(0,Math.floor(e.y-e.r)), y1 = Math.min(GH-1,Math.ceil(e.y+e.r));
  const r2 = e.r*e.r;
  for(let y=y0;y<=y1;y++){
    const row = y*GW;
    for(let x=x0;x<=x1;x++){
      if(cells[row+x] !== TRAIL) continue;
      const dx = x-e.x, dy = y-e.y;
      if(dx*dx+dy*dy <= r2) return true;
    }
  }
  return false;
}
function vulnerable(){ return G.invuln <= 0 && (G.drawing || G.dose <= 0); }
function updateEnemies(dt){
  const L = G.level;
  // GOAL-015: basınç yükseldikçe doku öfkeleniyor — tıkanıklığın ikinci bedeli
  // GOAL-027: basınç dokuyu öfkelendiriyor, akış sakinleştiriyor. İki kuvvet
  // aynı çarpanda buluşuyor ki oyuncu "nefes açınca saha yatıştı"yı hissetsin.
  const rage = clamp(1 + G.pressure*.35 - G.flow*.25, .7, 1.4);
  for(const b of G.bosses){
    moveEnemy(b, dt*rage, 1.1); b.t += dt;
    if(L.fire > 0 && !G.buffs.FREEZE){
      b.fireT -= dt;
      if(b.fireT <= 0){
        b.fireT = 1/L.fire*rnd(.7,1.4);
        const a = Math.atan2(G.py-b.y, G.px-b.x) + rnd(-.35,.35);
        const s = new PIXI.Sprite(TEX.spark);
        s.anchor.set(.5); s.width = s.height = 22; s.tint = 0xff7a52; s.blendMode = BLEND_ADD;
        layerEnt.addChild(s);
        G.bullets.push({ x:b.x, y:b.y, vx:Math.cos(a)*34, vy:Math.sin(a)*34, life:6, s:s });
      }
    }
    if(hitsTrail(b)) die();
    const dx = b.x-G.px, dy = b.y-G.py;
    if(vulnerable() && dx*dx+dy*dy < (b.r+1.6)*(b.r+1.6)) die();
  }
  for(const m of G.minions){
    moveEnemy(m, dt*rage, .35);
    if(hitsTrail(m)) die();
    const dx = m.x-G.px, dy = m.y-G.py;
    if(vulnerable() && dx*dx+dy*dy < (m.r+1.4)*(m.r+1.4)) die();
  }
  for(let i=G.bullets.length-1;i>=0;i--){
    const b = G.bullets[i];
    if(!G.buffs.FREEZE){ b.x += b.vx*dt; b.y += b.vy*dt; b.life -= dt; }
    const inSafe = solid(b.x,b.y);
    if(b.life<=0 || b.x<0 || b.y<0 || b.x>GW || b.y>GH || (inSafe && G.dose>0)){
      b.s.destroy(); G.bullets.splice(i,1); continue;
    }
    if(cells[Math.round(b.y)*GW+Math.round(b.x)] === TRAIL){ die(); b.s.destroy(); G.bullets.splice(i,1); continue; }
    const dx = b.x-G.px, dy = b.y-G.py;
    if(vulnerable() && dx*dx+dy*dy < 4){ die(); b.s.destroy(); G.bullets.splice(i,1); }
  }
  if(G.buffs.LASER){
    G.laserCd -= dt;
    if(G.laserCd <= 0 && G.dir){
      G.laserCd = .16;
      const dv = DIRV[G.dir];
      const s = new PIXI.Sprite(TEX.spark);
      s.anchor.set(.5); s.width = s.height = 14; s.tint = 0xc6ff8f; s.blendMode = BLEND_ADD;
      layerEnt.addChild(s);
      G.shots.push({ x:G.px, y:G.py, vx:dv[0]*72, vy:dv[1]*72, life:1.6, s:s });
      Sound.laser();
    }
  }
  for(let i=G.shots.length-1;i>=0;i--){
    const sh = G.shots[i];
    sh.x += sh.vx*dt; sh.y += sh.vy*dt; sh.life -= dt;
    let hit = false;
    for(let k=G.minions.length-1;k>=0;k--){
      const m = G.minions[k];
      const dx = m.x-sh.x, dy = m.y-sh.y;
      if(dx*dx+dy*dy < (m.r+1)*(m.r+1)){
        burst(m.x,m.y,18,0xb7f27a);
        m.s.destroy(); G.minions.splice(k,1); G.score += 300; hit = true; break;
      }
    }
    if(hit || sh.life<=0 || sh.x<0 || sh.y<0 || sh.x>GW || sh.y>GH){ sh.s.destroy(); G.shots.splice(i,1); }
  }
}

/* =========================================================================
   15. ÇİZİM
   ========================================================================= */
function drawTrail(){
  trailGlowG.clear(); trailCoreG.clear();
  if(!G.drawing || !G.corners.length) return;
  // köşeler + oyuncunun bulunduğu (kesirli ilerlemeyle) nokta, saha pikselinde
  const pts = [];
  for(const c of G.corners.concat([{x:G.px, y:G.py}])){
    const p = [(c.x + .5)*CS, (c.y + .5)*CS], q = pts[pts.length-1];
    if(!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
  }
  if(pts.length < 2) return;
  strokePath(trailGlowG, pts, 16, 0x35e0d8, .16);
  strokePath(trailGlowG, pts, 8, 0x35e0d8, .30);
  strokePath(trailCoreG, pts, 3.2, 0xdafffb, 1);
}
function render(dt){
  G.time += dt;
  const t = G.time;

  const dv = DIRV[G.dir ? (G.moveDir || G.dir) : 0];
  const pxp = (G.px + dv[0]*G.frac + .5)*CS, pyp = (G.py + dv[1]*G.frac + .5)*CS;
  playerSprite.x = playerGlow.x = playerLight.x = pxp;
  playerSprite.y = playerGlow.y = playerLight.y = pyp;
  playerSprite.rotation = Math.sin(t*1.1)*.10;
  const blink = G.invuln > 0 ? (Math.sin(t*30) > 0 ? .25 : 1) : 1;
  playerSprite.alpha = blink;
  { const pw = playerW*(1 + Math.sin(t*4.2)*.04); playerSprite.width = pw; playerSprite.height = pw * PLAYER_AR; }
  playerGlow.alpha = (.34 + Math.sin(t*4.2)*.12) * blink * (G.drawing ? 1.5 : 1);
  playerGlow.width = playerGlow.height = playerW*(2.8 + Math.sin(t*4.2)*.35);
  playerLight.alpha = (.14 + Math.sin(t*2.1)*.03) * (G.drawing ? 1.6 : 1);
  drawShield(pxp, pyp, t);
  // iyileşmiş dokuda yukarı süzülen hava (nefes anında parlıyor)
  healLive.tilePosition.y -= dt*9*(1 + G.flow*.8);
  healLive.tilePosition.x = Math.sin(t*.23)*14;
  healLive.alpha = .32 + Math.sin(t*.7)*.06 + G.breathFlash*.4;

  for(const b of G.bosses){
    const pulse = 1 + Math.sin(b.t*2.1)*.045;
    b.s.x = b.g.x = b.x*CS; b.s.y = b.g.y = b.y*CS;
    b.s.width = b.r*2*CS*pulse; b.s.height = b.s.width*b.ar;
    b.s.rotation = Math.sin(b.t*.9)*.16;      // yüzü var: dönmüyor, sallanıyor
    b.g.width = b.g.height = b.r*3.3*CS*pulse;
    b.g.alpha = .28 + Math.sin(b.t*2.7)*.1;
  }
  for(const m of G.minions){
    m.s.x = m.x*CS; m.s.y = m.y*CS;
    m.s.rotation += m.spin*dt;
  }
  for(const b of G.bullets){ b.s.x = b.x*CS; b.s.y = b.y*CS; }
  for(const s of G.shots){ s.s.x = s.x*CS; s.s.y = s.y*CS; }
  for(let i=G.pus.length-1;i>=0;i--){
    const p = G.pus[i];
    p.t += dt;
    if(p.collected){
      // GOAL-009: toplama anı — ikon büyür + glow artar + söner, sonra temizlenir
      p.collectT += dt;
      const k = clamp(p.collectT/0.35, 0, 1);
      p.s.x = p.g.x = (p.x+.5)*CS; p.s.y = p.g.y = (p.y+.5)*CS;
      p.s.visible = p.g.visible = true;
      p.s.width = p.s.height = puW * (1 + k*0.9);
      p.g.width = p.g.height = 2.35*puW * (1 + k*1.4);
      p.s.alpha = p.g.alpha = 1 - k;
      if(p.collectT >= 0.35){ p.s.destroy(); p.g.destroy(); G.pus.splice(i,1); }
      continue;
    }
    const yy = (p.y+.5)*CS + Math.sin(p.t*2.1)*3.5*puW/PU_SIZE;
    p.s.x = p.g.x = (p.x+.5)*CS; p.s.y = p.g.y = yy;
    p.s.width = p.s.height = puW; p.g.width = p.g.height = 2.35*puW;
    p.s.rotation = Math.sin(p.t*1.3)*.14;
    const vis = cells[p.y*GW+p.x] === EMPTY;
    p.s.visible = p.g.visible = vis;
    p.g.alpha = .22 + Math.sin(p.t*3.4)*.1;
  }
  drawTrail();

  /* GOAL-028: NEFES DALGASI — sahayı alttan yukarı tarayan bant.
     Dalga nerede duruyorsa tıkanıklık orada; oyuncunun HUD'a bakması gerekmiyor.
     Geçerken turkuaz, yarı geçerken soluk, tıkanınca kırmızı. */
  if(G.waveDur > 0){
    G.waveT += dt;
    const k = clamp(G.waveT/G.waveDur, 0, 1);
    if(k >= 1){ G.waveDur = 0; waveBand.alpha = 0; }
    else {
      const ease = 1 - (1-k)*(1-k);                 // hızlı çıkıp yavaşlayan
      const gy = lerp(G.waveY0, G.waveY1, ease);
      waveBand.x = PFW/2;
      waveBand.y = (gy+.5)*CS;
      waveBand.width  = PFW;
      waveBand.height = 110 + 70*G.waveOk;
      waveBand.tint = G.waveTop ? 0x9ff6ea
                    : G.waveOk >= .35 ? 0x7fd8dc : 0xff8f88;
      // sonunda sönüyor; tıkalı nefeste duraklama noktasında bir kez şişiyor
      const fade = Math.sin(clamp(k/.94,0,1)*Math.PI);
      waveBand.alpha = (.14 + .34*G.waveOk) * fade;
      // dalga geçtiği satırdan havayı yukarı sürüklüyor
      if(Math.random() < .6) spawnBreathPuffs(Math.round(gy), 1 + (G.waveOk > .5 ? 1 : 0));
    }
  } else waveBand.alpha = 0;
  /* nefes geçti dalgası */
  if(G.breathFlash > 0){
    G.breathFlash = Math.max(0, G.breathFlash - dt*1.6);
    breathWave.alpha = G.breathFlash*.30;
    breathWave.width = PFW*(1.1 + (1-G.breathFlash)*.5);
    breathWave.height = PFH*(1.3 + (1-G.breathFlash)*.5);
  } else breathWave.alpha = 0;
  if(UI.veil){
    /* GOAL-028: ekran iki kaynaktan kızarıyor — biriken basınç (kalıcı, nabız
       atan) ve tıkalı bir nefesin hemen ardından gelen kızarma (blockFlash).
       İkincisi yavaş sönüyor (~1 sn) ki "nefes geçemedi" anı hissedilsin ama
       ekran sürekli kırmızı kalmasın. */
    const beat = .84 + Math.sin(t*(4.0 + G.pressure*3.4))*.16;
    UI.veil.style.opacity =
      clamp(clamp(G.pressure,0,1)*.85*beat + G.blockFlash*.45, 0, .95).toFixed(3);
  }
  if(G.blockFlash > 0) G.blockFlash = Math.max(0, G.blockFlash - dt*1.1);
  /* GOAL-027: akış perdesi. Basıncınkinden bilerek daha sakin bir nabızla
     soluyor — biri tehlike, diğeri rahatlama anlatıyor. */
  if(UI.flowVeil){
    const br = .88 + Math.sin(t*1.7)*.12;
    UI.flowVeil.style.opacity = (clamp(G.flow,0,1)*.42*br).toFixed(3);
  }

  grainSprite.x = -rnd(0, PFW*.18);
  grainSprite.y = -rnd(0, PFH*.18);

  if(G.shake > 0){
    G.shake = Math.max(0, G.shake - dt*26);
    shakeRoot.x = rnd(-G.shake, G.shake);
    shakeRoot.y = rnd(-G.shake, G.shake);
  } else { shakeRoot.x = 0; shakeRoot.y = 0; }
}

/* =========================================================================
   16. YERLEŞİM
   ========================================================================= */
const isTouch = matchMedia('(pointer:coarse)').matches;
/* GOAL-039: EKRANIN TAMAMI. Yatay ekranlarda (masaüstü, yatay telefon) HUD üst
   bantta ekranın beşte birini yiyordu; tahta 768px'lik bir ekranın ancak
   570px'ini kullanıyordu, yatay telefonda ise tahtaya neredeyse yer
   kalmıyordu. Yatayda HUD artık sol kenarda dikey bir çubuk (bilgi şeridi ve
   SES/DUR onun altında), tahta ekranın bütün yüksekliğini kullanıyor. Dikeyde
   HUD üstte kalıyor, tahta enin tamamını kullanıyor, alt bant baş parmağın. */
let hudSide = false, sideW = 0;
/* iPhone'un alt çubuğu (safe-area-inset-bottom). viewport-fit=cover olduğu
   için tuval oraya kadar uzanıyor; alt bant bu payın üstünde kalmalı, yoksa
   bilgi kartına yer kalmıyor ve baş parmak sistemin ana ekran hareketine
   değiyor. */
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none';
document.body.appendChild(safeProbe);
let safeB = 0;
/* Kadraj: boşluğun kutusu + ince bir kemik payı (ızgara birimi). Rakip
   tahtaları da aynı kadrajla çiziliyor. */
function frameCells(){
  const M = 3;                                   // kemik payı, ızgara birimi
  return { x0:Math.max(0, cavBB.x0 - M), x1:Math.min(GW, cavBB.x1 + M),
           y0:Math.max(0, cavBB.y0 - M), y1:Math.min(GH, cavBB.y1 + M) };
}
/* Çok oyunculu: tahtalar yan yana. Rakibin tahtası seninkiyle aynı kesit ve
   aynı kadraj, yalnızca ölçeği farklı. Masaüstünde iki tahta eşit; telefonda
   ve tablette (dokunmatik) rakibinki seninkinin en çok %75'i, en az %60'ı:
   göz kendi tahtanda kalsın, rakip göz ucuyla izlensin. Üç kişide iki rakip,
   en az yarı boyda.
   Dizilimler deneniyor, kendi tahtanı büyük bırakan seçiliyor (yakınsa yan
   yana): rakipler yanda ya da altta; üç kişide kendi aralarında üst üste ya
   da yan yana (uzun kesitte yan yana dizmek çok daha az yer yiyor). Dikey telefonda
   yan yana dizmek kendi tahtanı ~%40 küçültüyor; orada tahtanın altında boş
   kalan dikey pay kullanılıyor. Kısa yatay ekranda rakip sütunu SES/DUR'un
   üstüne kadar uzanıyor, tahtadan alan çalmasın.
   x0, W, H: tahtanın tek başına kullanacağı alan; dönüş ekran pikseli. */
const MP_HEAD = 24, MP_RVHEAD = 30;   // rakip grubunun başlığı (süre), kart başlığı (ad, durum, çubuk); CSS ile aynı
function mpSplit(n, fw, fh, x0, W, H, rightPad){
  if(!n) return null;
  const K = isTouch ? .75 : 1, MIN = isTouch ? .6 : n > 1 ? .5 : 1;
  const gap = isTouch ? 10 : 18, gr = isTouch ? 8 : 12;
  const Wr = W + rightPad, colH = H - (rightPad ? 62 : 0);
  let L = null;
  const pick = o => {
    if(!(o.s > 0 && o.rs > 0)) return;
    const sc = o.s*(o.dir === 'row' ? 1.03 : 1);   // yakınsa yan yana
    if(!L || sc > L.sc){ o.sc = sc; L = o; }
  };
  // rakipler c sütunlu bir ızgarada: üst üste (1) ya da yan yana (n)
  for(const c of n > 1 ? [1, n] : [1]){
    const r = Math.ceil(n/c);
    { // yanda
      const hMax = (colH - MP_HEAD - r*MP_RVHEAD - (r-1)*gr)/(r*fh);
      const s = Math.min(W/fw, H/fh, hMax/MIN, (Wr - gap - (c-1)*gr)/(fw*(1 + c*MIN)));
      pick({ dir:'row', c, r, s, rs:Math.min(K*s, hMax, (Wr - gap - fw*s - (c-1)*gr)/(c*fw)) });
    }
    { // altta
      const wMax = (W - (c-1)*gr)/(c*fw), hh = H - gap - MP_HEAD - r*MP_RVHEAD - (r-1)*gr;
      const s = Math.min(W/fw, wMax/MIN, hh/(fh*(1 + r*MIN)));
      pick({ dir:'col', c, r, s, rs:Math.min(K*s, wMax, (hh - fh*s)/(r*fh)) });
    }
  }
  if(!L){   // ekran çok küçük: rakipsiz yerleşim
    return null;
  }
  const bw = fw*L.s, rw = Math.round(fw*L.rs);
  Object.assign(L, { n, gap, gr, colH, gy:0,
    gw:L.c*rw + (L.c-1)*gr, gh:MP_HEAD + L.r*(MP_RVHEAD + Math.round(fh*L.rs)) + (L.r-1)*gr });
  if(L.dir === 'row'){
    const x = x0 + (Wr - bw - gap - L.gw)/2;
    L.cx = x + bw/2; L.gx = x + bw + gap;
  } else { L.cx = x0 + W/2; L.gx = L.cx - L.gw/2; }
  return L;
}
function layout(pass){
  const w = window.innerWidth, h = window.innerHeight;
  app.renderer.resize(w,h);
  const hudEl = document.getElementById('hud');
  hudSide = w > h*1.15 && w >= 640;
  sideW = hudSide ? clamp(Math.round(w*.21), 230, 300) : 0;
  document.body.classList.toggle('hudSide', hudSide);
  document.documentElement.style.setProperty('--sideW', sideW + 'px');
  const top = hudSide ? 10 : (hudEl ? hudEl.offsetHeight : 110) + 8;
  safeB = safeProbe.offsetHeight || 0;
  const bottom = hudSide ? 10 : (isTouch ? 80 + safeB : 44);   // alt bant: baş parmak + bilgi şeridi
  const left = sideW;
  const rightPad = (hudSide && h <= 520) ? 138 : 0;   // kısa yatayda SES/DUR sağda, tahtaya binmesin
  // GOAL-022: dokunmatikte yan boşluk daraltıldı — telefonda her piksel alan.
  const availW = w - left - rightPad - (isTouch ? 12 : 20), availH = Math.max(60, h - top - bottom);

  /* GOAL-022 (revize): tüm alanı değil, boşluğun kutusunu + ince bir kemik
     payını çerçeveliyoruz. Ölçek her iki eksende de aynı, yani hiçbir şey
     esnemiyor; sadece kadraj sıkılaşıyor. */
  const F = frameCells(), fx0 = F.x0, fx1 = F.x1, fy0 = F.y0, fy1 = F.y1;
  const fw = Math.max(1, (fx1-fx0)*CS), fh = Math.max(1, (fy1-fy0)*CS);
  // çok oyunculu: rakip tahtaları yanda ya da altta (bkz. mpSplit)
  const nR = document.body.classList.contains('mpOn') ? mp.players.filter(p => p.id !== mp.you).length : 0;
  const sp = mpSplit(nR, fw, fh, left + (w - left - rightPad - availW)/2, availW, availH, rightPad);
  const s = sp ? sp.s : Math.min(availW/fw, availH/fh);
  root.scale.set(s);
  root.x = (sp ? sp.cx : left + (w-left-rightPad)/2) - (fx0+fx1)/2*CS*s;
  // Telefonda kadrajı yukarı yaslıyoruz: altta kalan bant baş parmağın
  // oynadığı yer. Masaüstünde ortalı.
  // Dokunmatikte kadraj merkezin biraz üstünde: altta kalan bant baş parmağın
  // oynadığı yer. Masaüstünde tam ortalı.
  const slack = availH - fh*s - (sp && sp.dir === 'col' ? sp.gap + sp.gh : 0);   // altta rakipler: ikisi tek blok
  // Dokunmatikte saha HUD'un hemen altina demirliyor (en fazla 56px bosluk):
  // genis/alcak kesitlerde ortalama, sahayi ekranin ortasinda yuzer birakiyordu.
  // Ust bant oyun, alt bant parmak -- klasik mobil arcade yerlesimi.
  const bias = (isTouch && !hudSide) ? Math.min(slack*.42, 56) : slack/2;
  root.y = top + bias + fh*s/2 - (fy0+fy1)/2*CS*s;
  if(sp){
    // yanda: rakibin tahtası seninkiyle aynı hizadan başlasın; altta: hemen altında
    sp.gy = sp.dir === 'col' ? top + bias + fh*s + sp.gap
      : clamp(top + bias - MP_HEAD - MP_RVHEAD, top, top + sp.colH - sp.gh);
    Object.assign(sp, { fx0, fy0, fx1, fy1 });
  }
  mp.lay = sp;

  /* Saha içi etiketler saha ile birlikte küçülüyor; telefonda 7 piksellik
     yazıya dönüşüyorlardı. Ekrandaki boyutları sabit kalsın diye ters
     ölçekliyoruz. */
  uiScale = clamp(.85/Math.max(.0001,s), 1, 2.6);
  { const k = isTouch ? 'touch' : 'desk', fit = (base, r) => clamp(base*s, r[0], r[1]) / Math.max(.0001, s);
    playerW = fit(PLAYER_SIZE, PLAYER_PX[k]); puW = fit(PU_SIZE, PU_PX[k]); }
  frame = { x0:fx0*CS, y0:fy0*CS, x1:fx1*CS, y1:fy1*CS };

  /* Toast (pembe uyarı yazısı) artık ekranın %26'sına değil sahanın üst
     bandına oturuyor. Sabit yüzde, telefonda yazıyı HUD'un altına sokup
     yarısını görünmez kılıyordu. */
  const fieldTop = root.y + fy0*CS*s, fieldH = fh*s;
  const toastY = Math.max(top + 26, fieldTop + Math.min(fieldH*.2, 96));
  UI.toast.style.top = toastY + 'px';

  /* Kontrol ipucu sahanın hemen altında; sığmıyorsa hiç gösterilmiyor. */
  const hintTop = fieldTop + fieldH + 16;
  UI.hint.style.top = hintTop + 'px';
  UI.hint.style.visibility = (!sp && hintTop + 74 < h - bottom + 40) ? 'visible' : 'hidden';   // yarışta altında rakip var

  /* GOAL-023: HUD'un eni tahtanın enine eşitleniyor. Sabit genişlikte HUD,
     dar tahtanın üstünde metrelerce boş çubuk bırakıyordu; şimdi gösterge
     şeridi tam tahtanın üstüne oturuyor. Genişlik değişimi HUD'un
     yüksekliğini oynatırsa (nadir) tek seferlik ikinci geçişle düzeltiyoruz. */
  UI.hudInner.style.maxWidth = hudSide ? 'none' : clamp(Math.min(PFW*s, w - (isTouch ? 24 : 32)), 320, 1120) + 'px';
  if(!pass && !hudSide && hudEl && Math.abs(hudEl.offsetHeight + 8 - top) > 1){ layout(1); return; }

  /* Dikeyde SES/DUR, HUD'un üst satırının sağ ucuna oturuyor (satır CSS'te
     onlara yer ayırıyor). Yatayda CSS'teki yerlerine dönüyorlar. */
  const tools = $('tools'), topRow = $('topRow');
  if(!hudSide && topRow){
    const r = topRow.getBoundingClientRect();
    tools.style.top = Math.round(r.top + (r.height - tools.offsetHeight)/2) + 'px';
    tools.style.left = Math.round(r.right - tools.offsetWidth) + 'px';
    tools.style.right = tools.style.bottom = 'auto';
  } else tools.style.top = tools.style.left = tools.style.right = tools.style.bottom = '';

  mpPlaceRivals();
  scrField = { x:root.x, y:root.y, s:s };
  scrFrame = { x0:root.x + fx0*CS*s, y0:root.y + fy0*CS*s, x1:root.x + fx1*CS*s, y1:root.y + fy1*CS*s };
  placeInfoRail(w, h);
  Info.fit();
  Cine.resize();
}
/* GOAL-031: bilgi şeridinin yeri. Önce tahtanın solundaki boşluk (masaüstü),
   yoksa tahtanın altı (telefon), o da yoksa alt köşede iki satıra kırpılmış
   hâli. Her durumda tahtanın dışında: göz oyunda kalsın. */
function placeInfoRail(w, h){
  const el = Info.el, fr = scrFrame, st = el.style;
  // Ölçü kadraj: dışındaki kemik payı oynanmayan alan, şerit oraya taşabilir.
  const left = fr.x0;
  el.classList.remove('compact','slim','narrow','gone');
  Info.avail = 0; Info.autoCls = null;
  st.top = st.bottom = st.left = st.right = st.width = 'auto';
  if(hudSide){
    const hudB = (document.getElementById('hud').querySelector('.hudInner').getBoundingClientRect().bottom) + 14;
    const toolsLeft = h > 520;                          // kısa ekranda SES/DUR sağ altta
    const room = h - (toolsLeft ? 80 : 14) - hudB;
    st.left = '16px'; st.width = (sideW - 32) + 'px'; st.bottom = (toolsLeft ? 78 : 12) + 'px';
    if(sideW - 32 < 250) el.classList.add('narrow');   // dar çubukta bölge adı kesilmesin: ikon ve renk yetiyor
    if(room < 96) el.classList.add('gone');
    else if(room < 150) el.classList.add('compact');
    Info.avail = room;
    return;
  }
  if(left >= 250){
    const rw = Math.min(310, left - 48);
    st.width = rw + 'px';
    st.left = Math.max(16, left - rw - 28) + 'px';
    st.bottom = Math.max(16, h - fr.y1) + 'px';
    return;
  }
  /* Dikey telefon: kart tahtanın altındaki bantta, HUD ile aynı hizada.
     Tahtaya hiçbir zaman binmiyor: bandın yüksekliği boşluğun gerçek alt
     kenarından ekranın (alt çubuk payı hariç) altına kadar. Kart sığmazsa
     fit() önce iki satıra (compact), sonra tek satırlık şeride (slim)
     indiriyor; o da sığmazsa göstermiyor — bilgiler gün sonunda tam hâliyle
     okunuyor. */
  const hr = UI.hudInner.getBoundingClientRect();
  const cavBot = scrField.y + cavBB.y1*CS*scrField.s;
  // oyuncu tahtanın dibinde başlıyor: kalkan halkası (yarıçap ~.72·playerW) şeride değmesin
  // çok oyunculu: rakipler yandaysa şerit yalnızca kendi tahtanın altında, alttaysa onların altında
  const R = mp.lay;
  const top = Math.round(R && R.dir === 'col' ? R.gy + R.gh + 10 : cavBot + Math.max(10, playerW*.72*scrField.s + 4));
  st.top = top + 'px';
  st.left = Math.max(12, hr.left) + 'px';
  st.right = Math.max(12, w - (R && R.dir === 'row' ? R.gx - R.gap : hr.right)) + 'px';
  Info.avail = h - safeB - 8 - top;
  if(Info.avail < 44) el.classList.add('gone');
}
addEventListener('resize', layout);
addEventListener('orientationchange', ()=> setTimeout(layout,180));

/* =========================================================================
   17. ANA DÖNGÜ
   ========================================================================= */
let last = performance.now(), fpsAcc = 0, fpsN = 0;
/* UYARLAMALI KALİTE. Zayıf ekran kartlı telefonlarda tam ekran ışıma
   bulanıklığı ve 2x çözünürlük kare hızını düşürebilir. Oyun sürerken kare
   hızı izleniyor; 4 sn boyunca ortalama 42'nin altında kalırsa kalite bir
   kademe iniyor (en fazla iki). Geri çıkmıyor — kalite gidip gelmesin — ve
   cihazda hatırlanıyor, bir sonraki açılışta doğrudan o kademeden başlanıyor.
     1: çözünürlük en fazla 1,5x, ışıma bulanıklığı ve tanecik kapalı
     2: çözünürlük 1x, iyileşmiş dokudaki süzülen zerreler kapalı */
const QUALITY_KEY = 'nasodren_quality_v1';
const Quality = {
  level:0, winT:0, winN:0, holdT:0,
  init(){ let q = 0; try{ q = parseInt(localStorage.getItem(QUALITY_KEY), 10) || 0; }catch(e){} this.apply(clamp(q, 0, 2)); },
  apply(q){
    this.level = q;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const res = q >= 2 ? 1 : q >= 1 ? Math.min(dpr, 1.5) : dpr;
    if(app.renderer.resolution !== res){ app.renderer.resolution = res; app.renderer.resize(window.innerWidth, window.innerHeight); }
    if(q >= 1){ rimBloom.filters = null; rimBloom.alpha = .3; grainSprite.visible = false; }
    if(q >= 2){ healLive.visible = false; }
  },
  tick(realDt){
    if(this.level >= 2 || G.state !== 'play' || document.hidden || realDt > .5){ this.winT = this.winN = 0; return; }
    if(this.holdT > 0){ this.holdT -= realDt; return; }   // değişiklikten sonra yerleşsin
    this.winT += realDt; this.winN++;
    if(this.winT < 4) return;
    const fps = this.winN / this.winT; this.winT = this.winN = 0;
    if(fps < 42){
      this.apply(this.level + 1); this.holdT = 2;
      try{ localStorage.setItem(QUALITY_KEY, String(this.level)); }catch(e){}
    }
  }
};
Quality.init();
app.ticker.add(()=>{
  const now = performance.now();
  let dt = (now-last)/1000; last = now;
  Quality.tick(dt);
  if(dt > 1/20) dt = 1/20;

  fpsAcc += dt; fpsN++;
  if(fpsAcc >= .5){ UI.fps.textContent = Math.round(fpsN/fpsAcc)+' FPS · PIXI '+PIXI.VERSION; fpsAcc = 0; fpsN = 0; }

  if(G.state === 'play') simStep(dt);
  else {
    updateParticles(dt*.4);
    updateAirFlow(dt*.4);
    updateScorePops(dt*.4);
  }
  render(dt);
  ClearReveal.tick(dt);   // render'dan sonra: sönen düşmanların alfası render'ın üstüne
  Info.tick();   // GOAL-031
  Guide.update(dt);   // GOAL-038
  if(mp.inRound) mpTick(now);   // çok oyunculu: durum gönder, rakipleri çiz, süre
});
/* GOAL-037: oynanışın bir adımı. Ana döngüden ayrı çünkü denge testleri
   (geliştirme modunda, bkz. __nd) oyunu gerçek zamanı beklemeden, hızlandırılmış
   oynatabilsin — sayılar tahminle değil ölçümle ayarlanıyor. */
function simStep(dt, headless){
    if(headless) G.time += dt;          // render çağrılmadığında zaman burada ilerliyor
    if(G.invuln > 0) G.invuln -= dt;
    // GOAL-015: basınç dozu daha hızlı yakıyor
    // GOAL-027: açık kanal dozu koruyor, tıkalı kanal yakıyor
    G.dose = Math.max(0, G.dose - dt*Math.max(.35, 1 + G.pressure*.8 - G.flow*.45));
    // Akış ölçülen değere yumuşakça yaklaşıyor (~0.5 sn)
    G.flow += (G.flowTarget - G.flow) * Math.min(1, dt*2.2);
    G.pressure = Math.max(0, G.pressure - dt*.012);   // çok yavaş kendiliğinden düşüş
    G.breathT -= dt;
    if(G.breathT <= 1.3 && !G.breathCue){
      G.breathCue = true; Sound.inhaleCue(); UI.airway.classList.add('soon');
    }
    if(G.breathT <= 0) doBreath();
    // GOAL-016: hava sadece nefes anında değil, sürekli akmaya çalışıyor.
    // Tıkalıyken her birkaç saniyede bir duvara çarpıp geri tepişini görmek,
    // "neresi tıkalı" sorusunun en doğrudan cevabı.
    /* GOAL-028: nefesler arasında da doku soluk alıyor — dalganın ulaşabildiği
       bölgede seyrek hava telleri yukarı süzülüyor. Akış arttıkça hem sıklaşıyor
       hem yukarı doğru genişliyor, yani sahanın canlılığı doğrudan ilerlemenin
       göstergesi oluyor. */
    G.airAmbT -= dt;
    if(G.airAmbT <= 0 && G.flow > .10){
      G.airAmbT = lerp(.6, .2, G.flow);
      const lo = Math.min(breath.y1, breath.stallY + 2);
      spawnBreathPuffs(lo + Math.random()*Math.max(1, breath.y1-lo), 1 + Math.round(G.flow*2));
    }
    if(G.pressure > .45){
      G.beatT -= dt;
      if(G.beatT <= 0){ G.beatT = lerp(1.25,.5,G.pressure); Sound.heartbeat(); }
    }
    let buffChanged = false;
    for(const k in G.buffs){ G.buffs[k] -= dt; if(G.buffs[k] <= 0){ delete G.buffs[k]; buffChanged = true; } }
    movePlayer(dt);
    updateEnemies(dt);
    updateParticles(dt);
    updateAirFlow(dt);
    updateScorePops(dt);
    if(buffChanged || Math.floor(G.time*4) !== Math.floor((G.time-dt)*4)) syncHUD();
}
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden){
    if(G.state === 'play' && !mp.inRound) togglePause();   // yarışta duraklatma yok: away iletisi (bölüm 10d)
    // GOAL-020: arka plandayken müzik de sussun (mobilde zaten beklenen davranış)
    if(Sound.ctx && Sound.ctx.state === 'running'){ try{ Sound.ctx.suspend(); }catch(e){} }
  } else Sound.resume();
});

/* =========================================================================
   18. AÇILIŞ — başlık ekranının arkasında canlı oyun alanı
   ========================================================================= */
buildCavity(LEVELS[0]);                     // GOAL-015
resetGrid();
paintHealthy(LEVELS[0]); texUpdate(bgTex);
paintTissue(LEVELS[0]);
paintWalls(LEVELS[0]); texUpdate(wallTex);
rasterRegion(0,0,GW,GH);
computeBreath();
layout();
syncHUD();
// GOAL-013 (madde 1): eski büyük tanıtım paneli yerine sade ana menü —
// oyuncu OYNA / YÜKSEK SKORLAR / SES tek noktadan seçiyor.
showMainMenu();

/* GOAL-037: denge testi kancası — yalnızca `npm run dev`te var, derlemeye girmez. */
if(import.meta.env && import.meta.env.DEV){
  window.__nd = {
    G, LEVELS, cells, cavity, GW, GH, EMPTY, FILL, TRAIL, DIRV, PLAYER_SPD, Quality, mp,
    step: dt => simStep(dt, true),
    setDir: d => { botDir = d; },
    begin(idx){ hideMenuScreen(); hidePanel(); G.levelIdx = idx; G.score = 0; G.lives = 3;
                prepareLevel(idx); startLevel(); app.ticker.stop(); },
    stopTicker(){ app.ticker.stop(); },
    startTicker(){ app.ticker.start(); },
    // görsel kontrol: boşluğun sol yarısını temizlenmiş say
    revealHalf(){ for(let i=0;i<GW*GH;i++) if(cavity[i] && (i%GW) < cavCX) cells[i] = FILL; rasterRegion(0,0,GW,GH); }
  };
}

};
