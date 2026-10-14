import { db } from './db.js';
import { getCatalog, getSet, getCard, searchCards, getSetVariants, filterCards } from './api.js';
import { DEFAULT_ALBUM, loadAlbums, saveAlbums, albumLayout, spot, columns } from './albums.js';
import { LOGOS } from './logos.js';
import { IMAGES } from './images.js';
import { APP_VERSION } from './version.js';
import { captureFromVideo, canvasFromFile, readCard, findCards, parseNumber } from './scan.js';

// ---------------------------------------------------------------------------
// Personalizzazioni rapide: cambia queste liste per adattare l'app.
// ---------------------------------------------------------------------------
const VARIANTS = {
  normal: 'Normale',
  holo: 'Holo',
  reverse: 'Reverse',
  firstEdition: 'Prima Edizione',
  wPromo: 'Promo W',
};
const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
const LANGS = ['IT', 'EN', 'JP', 'DE', 'FR', 'ES'];
const SET_FILTERS = { all: 'Tutte', own: 'Possedute', miss: 'Mancanti', dup: 'Doppioni' };

// ---------------------------------------------------------------------------
const $ = sel => document.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const options = (list, sel) => list.map(([v, label]) =>
  `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`).join('');

// Collezione in memoria (cardId -> record), specchio dello store "cards".
// Record: { cardId, setId, name, localId, image, rarity, variants, price, wish,
//           copies: [{ variant, qty, condition, lang, grade, note }] }
const coll = new Map();
// Dati minimi delle carte viste a schermo, per aprirle senza altre richieste.
const briefs = new Map();

const qty = rec => rec ? rec.copies.reduce((a, c) => a + c.qty, 0) : 0;

function unitPrice(rec, variant) {
  const p = rec.price;
  if (!p) return 0;
  // Cardmarket distingue solo "non foil" e "foil". Una carta che esiste solo
  // holo ha il suo prezzo nel campo non foil.
  const plain = variant === 'normal' || (variant !== 'reverse' && rec.variants && !rec.variants.normal);
  return (plain ? p.nonFoil || p.foil : p.foil || p.nonFoil) || 0;
}
const recValue = rec => rec.copies.reduce((a, c) => a + c.qty * unitPrice(rec, c.variant), 0);

function applyDetail(rec, d) {
  rec.rarity = d.rarity;
  rec.category = d.category;
  rec.variants = d.variants;
  rec.types = d.types ?? [];
  rec.illustrator = d.illustrator ?? '';
  rec.dexId = d.dexId ?? [];
  rec.detailV = 2;   // dettagli completi (tipi, illustratore, Pokédex): servono alla ricerca avanzata
  rec.setId ??= d.set?.id;
  const cm = d.pricing?.cardmarket;
  rec.price = cm ? {
    nonFoil: cm.trend || cm.avg || null,
    foil: cm['trend-holo'] || cm['avg-holo'] || null,
    updated: cm.updated,
  } : null;
}

function recFor(id) {
  const b = briefs.get(id) ?? {};
  return coll.get(id) ?? {
    cardId: id, setId: b.setId, name: b.name, localId: b.localId, image: b.image,
    wish: false, copies: [],
  };
}

function newCopy(rec) {
  const variant = rec.variants ? Object.keys(VARIANTS).find(k => rec.variants[k]) ?? 'normal' : 'normal';
  return { variant, qty: 1, condition: 'NM', lang: 'IT', grade: '', note: '' };
}

// Piccoli contatori fuori dal database: data dell'ultimo backup e modifiche fatte da allora.
const meta = {
  get: k => { try { return +localStorage.getItem(k) || 0; } catch { return 0; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* memoria non disponibile */ } },
};
// Dopo quante modifiche non salvate compare il promemoria nella schermata iniziale.
const BACKUP_REMINDER = 20;

// Presente solo dentro l'APK Android (vedi android/…/MainActivity.java): lì la copia di sicurezza
// la scrive l'app da sola, poco dopo ogni modifica, nella cartella Download/GAPokemon del telefono.
const native = window.Android;
let autoBackupTimer;
function autoBackup() {
  if (!native) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => {
    if (native.saveBackup(backupJson())) {
      meta.set('lastBackup', Date.now());
      meta.set('dirty', 0);
    }
  }, 1500);
}

// Aggiornamenti dell'APK: all'avvio si confronta la versione installata con l'ultima release
// su GitHub; se ce n'è una più nuova compare un avviso e l'APK la scarica e la installa.
// (Il contenuto dell'app invece si aggiorna da solo, arriva da GitHub Pages.)
const RELEASES = 'https://api.github.com/repos/Gavao/ga-pokemon/releases/latest';
let apkUpdate = null;   // { version, url } se c'è un APK più nuovo
const apkVersion = () => native && (native.appVersion ? native.appVersion() : '1.0');

function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function checkApkUpdate() {
  if (!native) return;
  try {
    const rel = await (await fetch(RELEASES)).json();
    const version = rel.tag_name.replace(/^v/, '');
    const asset = rel.assets.find(a => a.name.endsWith('.apk'));
    apkUpdate = asset && isNewer(version, apkVersion()) ? { version, url: asset.browser_download_url } : null;
  } catch { /* offline o GitHub non raggiungibile: si riprova al prossimo avvio */ }
  const slot = $('#updateSlot');
  if (slot) slot.innerHTML = updateBanner();
}

function updateBanner() {
  if (!apkUpdate) return '';
  // Il primo APK (1.0) non sa ancora aggiornarsi da solo: va scaricato a mano un'ultima volta.
  return native.installUpdate
    ? `<button class="warn" data-act="update">È disponibile la versione ${esc(apkUpdate.version)} dell'app. Tocca per aggiornare.</button>`
    : `<p class="warn">È disponibile la versione ${esc(apkUpdate.version)} dell'app: scaricala da GitHub
        (github.com/Gavao/ga-pokemon, sezione Releases) e installala sopra a questa.</p>`;
}

async function save(rec) {
  meta.set('dirty', meta.get('dirty') + 1);
  autoBackup();
  invalidateLayouts();
  rec.copies = rec.copies.filter(c => c.qty > 0);
  if (!rec.copies.length && !rec.wish) {
    coll.delete(rec.cardId);
    await db.del('cards', rec.cardId);
  } else {
    coll.set(rec.cardId, rec);
    await db.put('cards', rec);
    if (qty(rec) && albums.length && ownedBySet().get(rec.setId) === 1) await fileNewSet(rec.setId);
  }
  recordValue();
}

function ownedBySet() {
  const m = new Map();
  for (const rec of coll.values())
    if (qty(rec)) m.set(rec.setId, (m.get(rec.setId) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------
// Componenti
// ---------------------------------------------------------------------------
// Immagine della carta: quella italiana di TCGdex, altrimenti l'alternativa da js/images.js.
// Ogni fonte ha il suo formato di indirizzo. Limitless e TCGplayer non mandano gli header CORS,
// quindi lì niente crossorigin. L'immagine non parte subito: la carica imageQueue (più sotto).
/** Indirizzo dell'immagine di una carta nella misura voluta ('low' o 'high'); cors = si può salvare offline. */
function cardImageUrl(id, image, size) {
  // IMAGES contiene solo carte senza immagine italiana o con l'immagine italiana rotta: vince lei.
  const src = IMAGES[id] ?? image;
  if (!src) return null;
  const limitless = src.includes('limitlesstcg'), tcgplayer = src.includes('tcgplayer');
  const url = src.startsWith('img/') ? src   // copia dentro l'app (tools/mirror-images.ps1): una sola misura
    : limitless ? (size === 'high' ? src.replace('_SM.png', '_LG.png') : src)
    : tcgplayer ? (size === 'high' ? src : src.replace('.com/', '.com/fit-in/437x437/'))
    : src.includes('scrydex') ? `${src}/${size === 'high' ? 'large' : 'small'}`
    : `${src}/${size}.webp`;
  return { url, cors: !limitless && !tcgplayer };
}

function cardImg(id, image, size, cls = '') {
  const img = cardImageUrl(id, image, size);
  if (!img) return '';
  // Riserva: se l'immagine italiana non arriva, la stessa carta dall'archivio inglese.
  const alt = img.url.includes('assets.tcgdex.net/it/') ? img.url.replace('/it/', '/en/') : '';
  return `<img class="${cls}" ${img.cors ? 'crossorigin="anonymous"' : ''}
    data-src="${esc(img.url)}" ${alt ? `data-alt="${esc(alt)}"` : ''} alt="">`;
}

// Caricamento delle immagini delle carte. Aprendo un set ne servono centinaia: chiederle tutte
// insieme fa rifiutare dal server parte delle richieste, e quelle carte restavano senza immagine.
// Qui si caricano solo quelle vicine allo schermo, poche alla volta; se una fallisce si riprova a
// intervalli crescenti, poi si passa alla versione inglese, e solo alla fine si mostra il nome.
const imageQueue = (() => {
  // 6 tentativi a 1, 2, 4… 32 secondi: quando il server è carico risponde "occupato" anche per un
  // minuto, e passare subito all'inglese vorrebbe dire perdere l'immagine italiana che c'è.
  const MAX_ACTIVE = 6, RETRIES = 6;
  const waiting = [];
  let active = 0;

  const near = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      near.unobserve(e.target);
      waiting.push(e.target);
    }
    pump();
  }, { rootMargin: '800px 0px' });

  function pump() {
    while (active < MAX_ACTIVE && waiting.length) {
      const img = waiting.shift();
      if (img.isConnected) start(img);
    }
  }

  function start(img) {
    active++;
    // Se il caricamento non dà né "fatto" né "errore" (es. pagina cambiata a metà), dopo 20 secondi
    // il posto in coda si libera comunque: altrimenti la coda si bloccava e le immagini smettevano di arrivare.
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(watchdog);
      img.onload = img.onerror = null;
      active--;
      return true;
    };
    const watchdog = setTimeout(() => { if (release() && img.isConnected) { failed(); } pump(); }, 20000);
    img.onload = () => {
      if (release()) pump();
    };
    img.onerror = () => {
      if (!release()) return;
      failed();
      pump();
    };
    function failed() {
      const tries = +(img.dataset.tries ?? 0);
      if (tries < RETRIES) {
        img.dataset.tries = tries + 1;
        setTimeout(() => { if (img.isConnected) { waiting.unshift(img); pump(); } }, 1000 * 2 ** tries);
      } else if (img.dataset.alt) {
        img.dataset.src = img.dataset.alt;
        delete img.dataset.alt;
        img.dataset.tries = 0;
        waiting.unshift(img);
      } else if (img.closest('.tile')) {
        img.closest('.tile').classList.add('noimg');
      } else {
        img.style.visibility = 'hidden';
      }
      pump();
    }
    img.removeAttribute('src');
    img.src = img.dataset.src;
  }

  // Ogni immagine nuova nella pagina entra in osservazione.
  new MutationObserver(() => {
    for (const img of document.querySelectorAll('img[data-src]:not([data-queued])')) {
      img.dataset.queued = '';
      near.observe(img);
    }
  }).observe(document.body, { childList: true, subtree: true });

  return { state: () => ({ waiting: waiting.length, active }) };
})();
window.__imageQueue = imageQueue;   // per la diagnosi dalla console

function tile(b) {
  const rec = coll.get(b.id);
  const n = qty(rec);
  const img = cardImg(b.id, b.image, 'low');
  return `<div class="tile ${n ? 'own' : ''} ${img ? '' : 'noimg'}" data-card="${esc(b.id)}">
    ${img}
    <span class="name">${esc(b.name)}</span>
    <span class="num">${esc(b.localId)}</span>
    ${n ? `<span class="qty">×${n}</span>` : ''}
    ${rec?.wish ? '<span class="wish">★</span>' : ''}
    <button class="add" data-add="${esc(b.id)}" aria-label="Aggiungi una copia">+</button>
  </div>`;
}

const recBrief = rec => {
  const b = { id: rec.cardId, setId: rec.setId, name: rec.name, localId: rec.localId, image: rec.image };
  briefs.set(b.id, b);
  return b;
};

// Logo del set: alternativa da js/logos.js, poi logo italiano di TCGdex, altrimenti un'etichetta.
function setLogo(s) {
  const url = LOGOS[s.id] ?? (s.logo && s.logo + '.webp');
  if (url) return `<img crossorigin="anonymous" loading="lazy" src="${esc(url)}" alt="">`;
  const label = s.name.match(/\d+/)?.[0] ?? s.name.split(/\s+/).map(w => w[0]).join('').slice(0, 4).toUpperCase();
  return `<span class="badge">${esc(label)}</span>`;
}

const bar = (n, tot) => `<div class="bar"><i style="width:${tot ? Math.min(100, n / tot * 100) : 0}%"></i></div>`;
const loading = '<p class="empty">Caricamento…</p>';
const failed = err => `<p class="empty">Impossibile caricare i dati.<br><small>${esc(err.message)}</small><br>
  Serve la connessione la prima volta che apri una pagina.</p>`;

// ---------------------------------------------------------------------------
// Viste
// ---------------------------------------------------------------------------
let catalog = null, homeQuery = '', searchSeq = 0, searchTimer;
const setNames = new Map();
// Serie aperte dall'utente: valgono solo finché l'app resta aperta, all'avvio sono tutte chiuse.
const openSeries = new Set();

const setRow = (s, owned) => {
  const n = owned.get(s.id) ?? 0, tot = s.cardCount.total;
  return `<a class="setrow" href="#/set/${encodeURIComponent(s.id)}">
    <span class="logo">${setLogo(s)}</span>
    <span class="info"><b>${esc(s.name)}</b>${bar(n, tot)}</span>
    <span class="count">${n}/${tot}</span>
  </a>`;
};

async function home() {
  view.innerHTML = loading;
  catalog = await getCatalog();
  for (const serie of catalog) for (const s of serie.sets) setNames.set(s.id, s.name);
  const dirty = meta.get('dirty');
  view.innerHTML = `<header class="top"><h1>GA Pokémon</h1>
      <button class="chip" data-act="pack">Bustina</button>
      <button class="chip on" data-act="scan">Scansiona</button></header>
    <div id="updateSlot">${updateBanner()}</div>
    <div id="alertSlot">${alertBanner()}</div>
    ${navigator.onLine ? '' : `<p class="note warnline">Sei senza connessione: funzionano la collezione, i set già aperti
      e quelli scaricati per la modalità fiera (in Altro).</p>`}
    ${!native && coll.size && dirty >= BACKUP_REMINDER
      ? `<a class="warn" href="#/more">${dirty} modifiche non ancora salvate in un backup. Tocca per salvarle.</a>` : ''}
    <div class="tools searchrow"><input id="hq" type="search" placeholder="Cerca un set o una carta" value="${esc(homeQuery)}">
      <a class="chip" href="#/search">Filtri</a></div>
    <div id="homeBody"></div>`;
  renderHome();
  renderPackbar();   // ora i nomi dei set sono noti
}

// Senza testo: elenco delle serie. Con testo: set e carte trovati in tutte le espansioni.
function renderHome() {
  const body = $('#homeBody');
  if (!body) return;
  const owned = ownedBySet();
  const q = homeQuery.trim().toLowerCase();
  const seq = ++searchSeq;

  if (!q) {
    body.innerHTML = catalog.map(serie => {
      const started = serie.sets.filter(s => owned.get(s.id)).length;
      return `<details class="serie" data-serie="${esc(serie.id)}" ${openSeries.has(serie.id) ? 'open' : ''}>
        <summary>${esc(serie.name)}<small>${started ? `${started}/` : ''}${serie.sets.length} set</small></summary>
        ${serie.sets.map(s => setRow(s, owned)).join('')}
      </details>`;
    }).join('');
    return;
  }

  const sets = catalog.flatMap(serie => serie.sets).filter(s => s.name.toLowerCase().includes(q));
  body.innerHTML = `<h2>Set</h2>${sets.map(s => setRow(s, owned)).join('') || '<p class="note">Nessun set trovato.</p>'}
    <h2>Carte</h2><div id="cardResults"><p class="note">${q.length < 3 ? 'Scrivi almeno 3 lettere per cercare le carte.' : 'Ricerca…'}</p></div>`;
  if (q.length < 3) return;

  searchCards(q).then(found => {
    if (seq !== searchSeq) return;
    const cards = found.map(c => ({ ...c, setId: c.id.slice(0, c.id.lastIndexOf('-')) }))
      .filter(c => setNames.has(c.setId));
    for (const c of cards) briefs.set(c.id, c);
    const shown = cards.slice(0, 150);
    $('#cardResults').innerHTML = cards.length
      ? `<p class="note">${cards.length} carte trovate${cards.length > shown.length ? `, mostrate le prime ${shown.length}` : ''}.</p>
         <div class="grid">${shown.map(tile).join('')}</div>`
      : '<p class="note">Nessuna carta trovata.</p>';
  }).catch(() => {
    if (seq === searchSeq) $('#cardResults').innerHTML = '<p class="note">Per cercare le carte serve la connessione.</p>';
  });
}

let curSet = null, setFilter = 'all', setQuery = '';

async function setView(id) {
  if (curSet?.id !== id) {
    view.innerHTML = loading;
    curSet = await getSet(id);
    setFilter = 'all';
    setQuery = '';
    for (const c of curSet.cards) briefs.set(c.id, { ...c, setId: id });
    setNames.set(id, curSet.name);
  }
  view.innerHTML = `<header class="top">
      <a class="back" href="#/" aria-label="Indietro">‹</a>
      <div><h1>${esc(curSet.name)}</h1><div id="prog"></div></div>
    </header>
    <div class="tools">
      <input id="q" type="search" placeholder="Cerca per nome o numero" value="${esc(setQuery)}">
      <div class="chips"><button class="chip" data-act="shopping">Lista della spesa</button>${Object.entries(SET_FILTERS).map(([k, label]) =>
        `<button class="chip ${k === setFilter ? 'on' : ''}" data-filter="${k}">${label}</button>`).join('')}</div>
    </div>
    <div class="grid" id="grid"></div>`;
  renderProgress();
  renderGrid();
}

function renderProgress() {
  const el = $('#prog');
  if (!el || !curSet) return;
  const cards = curSet.cards.filter(c => qty(coll.get(c.id)));
  const value = cards.reduce((a, c) => a + recValue(coll.get(c.id)), 0);
  el.innerHTML = `${bar(cards.length, curSet.cards.length)}
    <small>${cards.length}/${curSet.cards.length} carte · ${eur(value)}</small>`;
}

function renderGrid() {
  const q = setQuery.trim().toLowerCase();
  const cards = curSet.cards.filter(c => {
    const n = qty(coll.get(c.id));
    if (setFilter === 'own' && !n) return false;
    if (setFilter === 'miss' && n) return false;
    if (setFilter === 'dup' && n < 2) return false;
    return !q || c.name.toLowerCase().includes(q) || c.localId.toLowerCase().includes(q);
  });
  $('#grid').innerHTML = cards.map(tile).join('') || '<p class="empty">Nessuna carta.</p>';
}

// Rarità TCGdex in italiano, dalla più comune alla più pregiata (le sconosciute vanno in fondo).
const RARITY_ORDER = ['Comune', 'Non comune', 'Rara', 'Olografica Rara', 'Rara Lucente', 'Rara doppia',
  'Olografica Rara V', 'Olografica Rara VMAX', 'Olografica Rara VSTAR', 'rara ASSO TATTICO',
  'Allenatore d\'arte completa', 'Rara illustrazione', 'Ultrarara', 'Shiny rare', 'Shiny rare V',
  'Shiny rare VMAX', 'ultrarara cromatica', 'Rara Bianco e Nero', 'Segreto rara',
  'Rara illustrazione speciale', 'Mega Attack Rare', 'Rara iper', 'Mega Iper Raro'];
const rarityRank = r => RARITY_ORDER.indexOf(r);
const rarityLabel = r => !r || r === 'Nessuna' ? 'Senza rarità' : r[0].toUpperCase() + r.slice(1);

// Tipo di carta, dal nome: Charizard ex, Mewtwo EX, Pikachu V, Mega Lucario…
function cardKind(rec) {
  const words = (rec.name ?? '').split(/[\s-]+/);
  const last = words.at(-1);
  if (words[0] === 'Mega' || /^M$/.test(words[0])) return 'Mega';
  const kinds = { ex: 'Pokémon-ex', EX: 'Pokémon-EX', GX: 'Pokémon-GX', V: 'Pokémon V', VMAX: 'Pokémon VMAX',
    VSTAR: 'Pokémon VSTAR', BREAK: 'Pokémon BREAK', 'LV.X': 'Pokémon LV.X', Prime: 'Pokémon Prime' };
  if (kinds[last]) return kinds[last];
  if (rec.category === 'Allenatore') return 'Allenatore';
  if (rec.category === 'Energia') return 'Energia';
  return rec.category ? 'Pokémon base' : 'Da scoprire';
}

// Rarità e tipo arrivano dal dettaglio della carta: per le carte aggiunte senza connessione o
// importate da un backup lo si scarica qui, poche alla volta, senza contarle come modifiche.
const detailsTried = new Set();   // una sola volta per carta e per sessione, anche se offline
async function fillDetails(recs, onProgress) {
  const queue = recs.filter(r => r.detailV !== 2 && !detailsTried.has(r.cardId));
  if (!queue.length) return;
  for (const r of queue) detailsTried.add(r.cardId);
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let rec; (rec = queue.shift());) {
      try {
        applyDetail(rec, await getCard(rec.cardId));
        await db.put('cards', rec);
      } catch { /* offline: resterà "Da scoprire" */ }
    }
  }));
  onProgress?.();
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Gruppo apribile di carte: riga con conteggi e valore, sotto le carte del gruppo.
function group(label, recs, extra = '') {
  const copies = recs.reduce((a, r) => a + qty(r), 0);
  const value = recs.reduce((a, r) => a + recValue(r), 0);
  return `<details class="group">
    <summary><span>${esc(label)}</span><small>${plural(recs.length, 'carta', 'carte')} · ${plural(copies, 'copia', 'copie')}${extra}${value ? ' · ' + eur(value) : ''}</small></summary>
    <div class="grid">${recs.sort((a, b) => recValue(b) - recValue(a)).map(r => tile(recBrief(r))).join('')}</div>
  </details>`;
}

async function stats() {
  const recs = [...coll.values()].filter(qty);
  const copies = recs.reduce((a, r) => a + qty(r), 0);
  const value = recs.reduce((a, r) => a + recValue(r), 0);
  const names = new Map();
  try {
    for (const serie of await getCatalog())
      for (const s of serie.sets) { names.set(s.id, s); setNames.set(s.id, s.name); }
  } catch { /* offline senza catalogo: si mostrano gli id */ }

  const bySet = new Map();
  for (const r of recs) {
    const s = bySet.get(r.setId) ?? { n: 0, value: 0 };
    s.n++;
    s.value += recValue(r);
    bySet.set(r.setId, s);
  }
  const top = recs.map(r => ({ r, v: recValue(r) })).filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, 12);

  const groupBy = keyOf => {
    const m = new Map();
    for (const r of recs) for (const k of [].concat(keyOf(r))) m.set(k, [...(m.get(k) ?? []), r]);
    return m;
  };
  const byRarity = [...groupBy(r => rarityLabel(r.rarity))]
    .sort((a, b) => rarityRank(b[1][0].rarity) - rarityRank(a[1][0].rarity));
  const byKind = [...groupBy(cardKind)].sort((a, b) => b[1].length - a[1].length);
  // Per variante contano le copie: la stessa carta può esserci sia normale sia reverse.
  const byVariant = Object.entries(VARIANTS).map(([k, label]) => {
    const withVariant = recs.filter(r => r.copies.some(c => c.variant === k));
    const n = withVariant.reduce((a, r) => a + r.copies.filter(c => c.variant === k).reduce((s, c) => s + c.qty, 0), 0);
    return [label, withVariant, n];
  }).filter(([, list]) => list.length);
  const missingDetails = recs.filter(r => r.detailV !== 2 && !detailsTried.has(r.cardId)).length;

  // Speso contro valore, solo sulle copie di cui hai indicato il prezzo pagato.
  const paid = recs.flatMap(r => r.copies.filter(c => c.paid != null).map(c => ({ r, c })));
  const spent = paid.reduce((a, { c }) => a + c.paid * c.qty, 0);
  const paidValue = paid.reduce((a, { r, c }) => a + unitPrice(r, c.variant) * c.qty, 0);
  const paidCount = paid.reduce((a, { c }) => a + c.qty, 0);
  const balance = paidValue - spent;

  view.innerHTML = `<header class="top"><h1>Collezione</h1></header>
    <div class="kpis">
      <div><b>${eur(value)}</b><small>Valore stimato</small></div>
      <div><b>${recs.length}</b><small>Carte diverse</small></div>
      <div><b>${copies}</b><small>Copie totali</small></div>
      <div><b>${copies - recs.length}</b><small>Doppioni</small></div>
      ${paidCount ? `<div><b>${eur(spent)}</b><small>Speso (${plural(paidCount, 'copia', 'copie')} con prezzo)</small></div>
      <div><b class="${balance >= 0 ? 'up' : 'down'}">${balance >= 0 ? '+' : '−'}${eur(Math.abs(balance))}</b>
        <small>Oggi valgono ${eur(paidValue)}</small></div>` : ''}
    </div>
    ${recs.length && !paidCount ? `<p class="note">Indica il prezzo pagato nella scheda di una carta
      (campo "Pagata €") per vedere quanto hai speso e quanto ci guadagni.</p>` : ''}
    ${recs.length ? `<h2>Valore nel tempo</h2>${valueChart(valueLog)}` : ''}
    ${recs.length ? goalsSection(names) : ''}
    ${packsSection()}
    ${dealsSection()}
    ${recs.length ? `<p class="note">Valori: prezzo medio di vendita su Cardmarket (trend) per una copia
      in buone condizioni. Sono indicativi: lingua, condizione e gradazione possono cambiarli molto.</p>`
      : '<p class="empty">Non hai ancora aggiunto carte.<br>Apri un set e tocca + su una carta.</p>'}
    ${top.length ? `<h2>Carte di maggior valore</h2><div class="grid">${top.map(x => tile(recBrief(x.r))).join('')}</div>` : ''}
    ${missingDetails ? `<p class="note" id="detailsNote">Recupero rarità e tipo di ${missingDetails} carte…</p>` : ''}
    ${byRarity.length ? `<h2>Per rarità</h2>${byRarity.map(([label, list]) => group(label, list)).join('')}` : ''}
    ${byVariant.length ? `<h2>Per variante</h2>${byVariant.map(([label, list, n]) => group(label, list, ` · ${plural(n, 'copia', 'copie')} in questa variante`)).join('')}` : ''}
    ${byKind.length ? `<h2>Per tipo di carta</h2>${byKind.map(([label, list]) => group(label, list)).join('')}` : ''}
    ${bySet.size ? `<h2>Per set</h2>` + [...bySet].sort((a, b) => b[1].value - a[1].value).map(([id, s]) => {
      const tot = names.get(id)?.cardCount.total;
      return `<a class="setrow" href="#/set/${encodeURIComponent(id)}">
        <span class="logo">${names.has(id) ? setLogo(names.get(id)) : ''}</span>
        <span class="info"><b>${esc(names.get(id)?.name ?? id)}</b>${bar(s.n, tot)}</span>
        <span class="count">${s.n}${tot ? '/' + tot : ''}<br>${eur(s.value)}</span>
      </a>`;
    }).join('') : ''}`;

  if (missingDetails) fillDetails(recs, () => { if (location.hash === '#/stats' && !sheet.open) stats(); });
}

// ---------------------------------------------------------------------------
// Album: come sistemare fisicamente le carte
// ---------------------------------------------------------------------------
// Soglie di protezione, modificabili dalla pagina e ricordate sul dispositivo.
const protection = {
  get toploader() { return meta.get('tlEuro') || 10; },
  get sleeve() { return meta.get('slEuro') || 1; },
};
// Rarità che meritano comunque la bustina / il toploader, a prescindere dal prezzo.
const SLEEVE_RARITY = rarityRank('Rara illustrazione');
const TOPLOADER_RARITY = rarityRank('Rara illustrazione speciale');

// Dove tenere una carta: in base alla copia di valore più alto e alla rarità.
function protectionOf(rec) {
  const best = Math.max(0, ...rec.copies.map(c => unitPrice(rec, c.variant)));
  const rank = rarityRank(rec.rarity);
  if (best >= protection.toploader || rank >= TOPLOADER_RARITY) return 'toploader';
  if (best >= protection.sleeve || rank >= SLEEVE_RARITY) return 'sleeve';
  return 'album';
}

// Album fisici (calcolo delle posizioni in js/albums.js). Gli album stanno nel database e nel backup.
let albums = [];                 // caricati all'avvio
let currentAlbum = '', albumSet = '', todoLimit = 30;
const layoutCache = new Map();   // album.id -> disposizione; si svuota a ogni modifica di carte o album

const invalidateLayouts = () => layoutCache.clear();

// La carta c'è? Negli album master conta la variante, altrimenti basta una copia qualsiasi.
const ownsVariant = (cardId, variant) => {
  const rec = coll.get(cardId);
  return variant ? !!rec?.copies.some(c => c.variant === variant && c.qty > 0) : qty(rec) > 0;
};

function layoutFor(album) {
  if (!layoutCache.has(album.id)) layoutCache.set(album.id, albumLayout(album, ownsVariant));
  return layoutCache.get(album.id);
}

// Primo uso: nel primo album vanno i set di cui hai già carte, dal più vecchio al più recente.
async function ensureAlbumInit() {
  if (albums[0].sets !== null) return;
  let order = [];
  try { order = (await getCatalog()).flatMap(s => s.sets.map(x => x.id)); } catch { /* offline */ }
  albums[0].sets = [...ownedBySet().keys()].sort((a, b) => order.indexOf(b) - order.indexOf(a));
  await persistAlbums();
}

// Prima carta di un set nuovo: il set va in fondo al primo album dove c'è ancora spazio (in fondo,
// così le carte già sistemate non si spostano). Se non entra da nessuna parte va nell'ultimo
// album, che lo segnalerà come "serve più spazio".
async function fileNewSet(setId) {
  await ensureAlbumInit();
  if (albums.some(a => a.sets.includes(setId))) return;
  for (const a of albums) {
    if (!(await albumLayout({ ...a, sets: [...a.sets, setId] }, ownsVariant)).overflow) {
      a.sets.push(setId);
      return persistAlbums();
    }
  }
  albums.at(-1).sets.push(setId);
  return persistAlbums();
}

async function persistAlbums() {
  invalidateLayouts();
  meta.set('dirty', meta.get('dirty') + 1);
  await saveAlbums(albums);
  autoBackup();
}

// Negli album "una copia per numero" va la copia più bella: prima edizione, holo, reverse, poi la
// normale; a parità, quella in condizioni migliori.
const BEAUTY = { firstEdition: 4, holo: 3, reverse: 2, wPromo: 1, normal: 0 };
function bestCopy(rec) {
  return rec.copies.filter(c => c.qty > 0).sort((a, b) => (BEAUTY[b.variant] ?? 0) - (BEAUTY[a.variant] ?? 0)
    || CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition))[0];
}

const placeText = (album, slot) => {
  const p = spot(album, slot);
  return `${album.name} · facciata ${p.side} (foglio ${p.sheet} ${p.front ? 'fronte' : 'retro'}) · riga ${p.row}, posto ${p.col}`;
};

/**
 * Dove va fisicamente una carta: un elemento per ogni copia che ha un posto (negli album master una
 * per variante). kind: 'slot' (posto nell'album), 'toploader', 'none' (set in nessun album), 'full'.
 * key identifica il posto: se cambia (album riordinato, copia migliore…) la carta torna da sistemare.
 */
async function placementsOf(rec) {
  if (!qty(rec)) return [];
  await ensureAlbumInit();
  if (protectionOf(rec) === 'toploader') return [{ kind: 'toploader', key: 'tl', text: 'Nel toploader, fuori dall\'album' }];
  const album = albums.find(a => a.sets?.includes(rec.setId));
  if (!album) return [{ kind: 'none', key: '', text: 'Il suo set non è in nessun album' }];
  const row = (await layoutFor(album)).rows.find(r => r.setId === rec.setId);
  if (!row || row.error) return [{ kind: 'none', key: '', text: 'Posizione non disponibile: serve la connessione' }];
  if (!row.fits) return [{ kind: 'full', key: '', text: `Non entra in ${album.name}: serve più spazio o un altro album` }];
  const owned = [...new Set(rec.copies.filter(c => c.qty > 0).map(c => c.variant))];
  const variants = album.master ? owned : [bestCopy(rec).variant];
  return variants.map(v => {
    const i = row.slots.findIndex(s => s.card.id === rec.cardId && (!album.master || s.variant === v));
    if (i < 0) return { kind: 'none', key: '', text: `${VARIANTS[v] ?? v}: nessun posto in questo album` };
    const slot = row.start + i;
    const which = album.master || owned.length > 1 ? ` · la ${VARIANTS[v] ?? v}` : '';
    return { kind: 'slot', key: `${album.id}:${slot}:${v}`, album, slot, text: placeText(album, slot) + which };
  });
}

const isPlaced = (rec, p) => (rec.placed ?? []).includes(p.key);

/** Carte con un posto (o un toploader) dove non risultano ancora sistemate, in ordine di album e posto. */
async function toPlace() {
  const items = [];
  for (const rec of coll.values()) {
    for (const p of await placementsOf(rec)) {
      if ((p.kind === 'slot' || p.kind === 'toploader') && !isPlaced(rec, p)) items.push({ rec, p });
    }
  }
  const albumIndex = p => (p.album ? albums.indexOf(p.album) : albums.length);
  return items.sort((a, b) => albumIndex(a.p) - albumIndex(b.p) || (a.p.slot ?? 0) - (b.p.slot ?? 0));
}

async function markPlaced(rec) {
  rec.placed = (await placementsOf(rec)).filter(p => p.key).map(p => p.key);
  await save(rec);
}

// Avviso breve in basso: dopo aver aggiunto una carta dice dove va messa.
let toastTimer;
function toast(html) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
  }
  // Dentro la finestra aperta (es. la fotocamera), altrimenti resterebbe nascosto sotto.
  (document.querySelector('dialog[open]') ?? document.body).append(el);
  el.innerHTML = html;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 5000);
}

async function toastPlacement(rec) {
  const p = (await placementsOf(rec))[0];
  if (p) toast(`<b>${esc(rec.name)}</b><br>${esc(p.kind === 'slot' || p.kind === 'toploader' ? 'Dove va: ' + p.text : p.text)}`);
}

async function album() {
  const recs = [...coll.values()].filter(qty);
  if (!recs.length) {
    view.innerHTML = `<header class="top"><h1>Album</h1></header>
      <p class="empty">Aggiungi qualche carta alla collezione:<br>qui ti aiuto a sistemarle.</p>`;
    return;
  }
  const names = new Map(), order = [];
  try {
    for (const serie of await getCatalog()) for (const s of serie.sets) { names.set(s.id, s); order.push(s.id); }
  } catch { /* offline */ }
  const owned = ownedBySet();
  const setName = id => names.get(id)?.name ?? id;

  await ensureAlbumInit();
  const cur = albums.find(a => a.id === currentAlbum) ?? albums[0];
  currentAlbum = cur.id;

  // Master set: la prima volta si leggono le varianti di ogni carta dei suoi set (poi restano in memoria).
  if (cur.master) {
    for (const id of cur.sets) {
      try {
        await getSetVariants(id, (done, total) => {
          view.innerHTML = `<header class="top"><h1>Album</h1></header>
            <p class="empty">Preparo il master set: leggo le varianti di ${esc(setName(id))}… ${done}/${total}</p>`;
        });
      } catch { /* senza connessione: il set risulterà "posizione non disponibile" */ }
    }
  }

  const layout = await layoutFor(cur);
  if (!cur.sets.includes(albumSet)) albumSet = cur.sets[0] ?? '';
  const inAlbum = new Set(albums.flatMap(a => a.sets ?? []));
  const addable = order.filter(id => !inAlbum.has(id));
  const homeless = [...owned.keys()].filter(id => !inAlbum.has(id));
  const todo = await toPlace();

  const tiers = { toploader: [], sleeve: [], album: [] };
  for (const r of recs) tiers[protectionOf(r)].push(r);
  const copiesOf = list => list.reduce((a, r) => a + qty(r), 0);
  const doubles = recs.filter(r => qty(r) > 1);
  const toComplete = [...owned.keys()].map(id => {
    const tot = names.get(id)?.cardCount.total ?? 0;
    return { id, n: owned.get(id), tot, pct: tot ? owned.get(id) / tot : 0 };
  }).sort((a, b) => b.pct - a.pct);

  view.innerHTML = `<header class="top"><h1>Album</h1></header>
    <div class="chips albums">
      ${albums.map(a => `<button class="chip ${a.id === cur.id ? 'on' : ''}" data-album-act="pick" data-album-id="${esc(a.id)}">${esc(a.name)}</button>`).join('')}
      <button class="chip" data-album-act="new">+ Nuovo album</button>
    </div>

    <h2>Da sistemare ${todo.length ? `<span class="count">${todo.length}</span>` : ''}</h2>
    ${todo.length ? `<p class="note">Carte aggiunte che non hai ancora messo al loro posto: sistemale e tocca Fatto.</p>
      <div class="todo">${todo.slice(0, todoLimit).map(({ rec, p }) => `<div class="todo-row">
        <div class="thumb" data-card="${esc(rec.cardId)}">${cardImg(rec.cardId, rec.image, 'low')}</div>
        <span class="info"><b>${esc(rec.name)}</b><small>${esc(setName(rec.setId))} · N° ${esc(rec.localId)}</small>
          <small class="place">${esc(p.text)}</small></span>
        <button class="chip" data-placed="${esc(rec.cardId)}">Fatto</button>
      </div>`).join('')}</div>
      <div class="settings">
        ${todo.length > todoLimit ? `<button class="chip" data-album-act="more">Mostra tutte (${todo.length})</button>` : ''}
        <button class="chip" data-album-act="allPlaced">Segna tutte come sistemate</button>
      </div>` : '<p class="note">Tutto al suo posto.</p>'}
    ${homeless.length ? `<p class="note warnline">Set di cui hai carte ma che non sono in nessun album:
      ${homeless.map(id => esc(setName(id))).join(', ')}. Aggiungili a un album qui sotto.</p>` : ''}

    <h2>${esc(cur.name)}</h2>
    <div class="settings">
      <label>Nome <input type="text" maxlength="30" data-album="name" value="${esc(cur.name)}"></label>
      <label>Tasche totali <input type="number" min="4" step="1" data-album="capacity" value="${cur.capacity}"></label>
      <select data-album="perSide">${options([[4, '4 per facciata (2×2)'], [9, '9 per facciata (3×3)'], [12, '12 per facciata (3×4)']], cur.perSide)}</select>
      <label><input type="checkbox" data-album="newSide" ${cur.newSide ? 'checked' : ''}> Ogni set su una facciata nuova</label>
      <label><input type="checkbox" data-album="gaps" ${cur.gaps ? 'checked' : ''}> Lascia i posti per le mancanti</label>
      <label><input type="checkbox" data-album="master" ${cur.master ? 'checked' : ''}> Master set: un posto per ogni variante</label>
    </div>
    <p class="note">${plural(layout.totalSides, 'facciata', 'facciate')} da ${cur.perSide} tasche
      (${plural(Math.ceil(layout.totalSides / 2), 'foglio', 'fogli')} fronte e retro) ·
      ${plural(Math.min(layout.usedSides, layout.totalSides), 'occupata', 'occupate')} ·
      ${layout.overflow ? `<b class="bad">non entra tutto: mancano ${plural(layout.overflow, 'tasca', 'tasche')}.</b>
        Sposta un set in un altro album (+ Nuovo album, poi ✕ qui e Aggiungi là), oppure togli
        "Lascia i posti per le mancanti".`
        : `libere ${layout.totalSides - layout.usedSides} (${(layout.totalSides - layout.usedSides) * cur.perSide} tasche)`}</p>
    ${bar(Math.min(layout.usedSides, layout.totalSides), layout.totalSides)}
    <div class="albumsets">
      ${layout.rows.map((r, i) => `<div class="setrow ${r.fits ? '' : 'over'}">
        <span class="logo">${names.has(r.setId) ? setLogo(names.get(r.setId)) : ''}</span>
        <span class="info"><b>${esc(setName(r.setId))}</b>
          <small>${r.error ? 'serve la connessione per leggere il set' : `${plural(r.slots.length, 'tasca', 'tasche')} · ${r.fits
            ? (r.firstSide === r.lastSide ? `facciata ${r.firstSide}` : `facciate ${r.firstSide}–${r.lastSide}`)
            : 'non entra in questo album'}`}</small></span>
        <span class="order">
          <button class="icon" data-album-act="up" data-set="${esc(r.setId)}" ${i ? '' : 'disabled'} aria-label="Sposta su">↑</button>
          <button class="icon" data-album-act="down" data-set="${esc(r.setId)}" ${i < layout.rows.length - 1 ? '' : 'disabled'} aria-label="Sposta giù">↓</button>
          <button class="icon" data-album-act="remove" data-set="${esc(r.setId)}" aria-label="Togli dall'album">✕</button>
        </span>
      </div>`).join('') || '<p class="note">Nessun set in questo album: aggiungine uno qui sotto.</p>'}
    </div>
    <div class="settings">
      <select id="albumAdd">
        <optgroup label="Set di cui hai carte">${options(addable.filter(id => owned.has(id)).map(id => [id, setName(id)]))}</optgroup>
        <optgroup label="Tutti gli altri set">${options(addable.filter(id => !owned.has(id)).map(id => [id, setName(id)]))}</optgroup>
      </select>
      <button class="chip" data-album-act="add">Aggiungi a ${esc(cur.name)}</button>
      ${albums.length > 1 ? `<button class="chip danger" data-album-act="delete">Elimina ${esc(cur.name)}</button>` : ''}
    </div>

    ${cur.sets.length ? `<h2>Pagine</h2>
    <p class="note">Come le vedi aprendo l'album: a sinistra il retro di un foglio, a destra il fronte del
      successivo. I posti vuoti sono le carte che ti mancano; quelli tratteggiati in giallo le carte ancora
      da sistemare; TL le carte nel toploader (lascia il posto libero o un segnaposto).</p>
    <div class="settings"><select id="albumSet">${options(cur.sets.map(id => [id, setName(id)]), albumSet)}</select>
      <button class="chip on" data-act="flip">Sfoglia l'album</button></div>
    <div id="albumPages"></div>` : ''}

    <h2>Protezione consigliata</h2>
    <p class="note">In base al valore della copia migliore e alla rarità. Il toploader (custodia rigida) va
      sempre usato con la bustina dentro.</p>
    ${group(`Toploader + bustina`, tiers.toploader, ` · ${copiesOf(tiers.toploader)} toploader`)}
    ${group('Bustina (sleeve) nell\'album', tiers.sleeve, ` · ${plural(copiesOf(tiers.sleeve), 'bustina', 'bustine')}`)}
    ${group('Album, senza bustina', tiers.album)}
    <div class="settings">
      <label>Toploader da <input type="number" min="1" step="1" data-setting="tlEuro" value="${protection.toploader}"> €</label>
      <label>Bustina da <input type="number" min="0" step="0.5" data-setting="slEuro" value="${protection.sleeve}"> €</label>
    </div>

    <h2>Set da completare</h2>
    ${toComplete.map(s => `<div class="setrow">
      <span class="logo">${names.has(s.id) ? setLogo(names.get(s.id)) : ''}</span>
      <span class="info"><a href="#/set/${encodeURIComponent(s.id)}"><b>${esc(setName(s.id))}</b></a>
        ${bar(s.n, s.tot)}<small data-cost="${esc(s.id)}">${s.tot - s.n === 1 ? 'manca 1 carta' : `mancano ${s.tot - s.n} carte`}</small></span>
      <button class="chip" data-act="cost" data-set="${esc(s.id)}">Quanto costa?</button>
    </div>`).join('')}

    <h2>Doppioni</h2>
    ${doubles.length ? group('Copie in più, da scambiare', doubles,
      ` · ${copiesOf(doubles) - doubles.length} in più`)
      + '<div class="settings"><button class="chip" data-act="shareDoubles">Condividi la lista dei doppioni</button></div>'
      : '<p class="note">Nessun doppione.</p>'}`;

  renderSpreads(cur, layout.rows.find(r => r.setId === albumSet));
}

const VARIANT_TAG = { holo: 'H', reverse: 'R', firstEdition: '1ª' };

/** Le facciate di un set, a coppie come appaiono aprendo l'album. */
function renderSpreads(album, row) {
  const box = $('#albumPages');
  if (!box || !row) return;
  if (row.error) { box.innerHTML = '<p class="note">Pagine non disponibili: serve la connessione per leggere il set.</p>'; return; }
  if (!row.slots.length) { box.innerHTML = '<p class="note">Nessuna carta di questo set da mettere nell\'album.</p>'; return; }
  for (const s of row.slots) briefs.set(s.card.id, { ...s.card, setId: row.setId });

  const sides = new Map();   // numero facciata -> posti
  row.slots.forEach((s, i) => {
    const slot = row.start + i, side = Math.floor(slot / album.perSide) + 1;
    if (!sides.has(side)) sides.set(side, Array(album.perSide).fill(null));
    sides.get(side)[slot % album.perSide] = { ...s, slot };
  });
  // Facciata 1 da sola a destra; poi coppie (2,3), (4,5)…: retro di un foglio e fronte del successivo.
  const spreads = [...new Set([...sides.keys()].map(side => Math.floor(side / 2)))];
  const cols = columns(album.perSide);

  const pocket = s => albumPocket(album, s, 'altro set');
  const side = n => {
    if (n < 1) return '<div class="side blank"></div>';
    if (!sides.has(n)) return `<div class="side other"><small>Facciata ${n}</small><p>altro set</p></div>`;
    return `<div class="side"><small>Facciata ${n}</small>
      <div class="pockets" style="grid-template-columns:repeat(${cols},1fr)">${sides.get(n).map(pocket).join('')}</div></div>`;
  };
  box.innerHTML = spreads.map(k => `<div class="spread"><small class="spread-label">${spreadLabel(k)}</small>
      <div class="spread-sides">${side(2 * k)}${side(2 * k + 1)}</div></div>`).join('');
}

const spreadLabel = k => (k === 0 ? 'Prima pagina (fronte del foglio 1)' : `Retro del foglio ${k} e fronte del foglio ${k + 1}`);

/** Una tasca dell'album: carta (con TL/B e variante), posto vuoto della mancante o tasca libera. */
function albumPocket(album, s, freeLabel) {
  if (!s) return `<div class="pocket other"><span>${freeLabel}</span></div>`;
  const rec = coll.get(s.card.id);
  const tag = VARIANT_TAG[s.variant] ? `<i class="vtag">${VARIANT_TAG[s.variant]}</i>` : '';
  if (!ownsVariant(s.card.id, s.variant)) {
    return `<div class="pocket empty" data-card="${esc(s.card.id)}"><b>${esc(s.card.localId)}</b><span>${esc(s.card.name)}</span>${tag}</div>`;
  }
  const tier = protectionOf(rec);
  if (tier === 'toploader') {
    return `<div class="pocket tl" data-card="${esc(s.card.id)}"><b>${esc(s.card.localId)}</b><span>nel toploader</span><i class="tag">TL</i></div>`;
  }
  const variant = s.variant ?? bestCopy(rec).variant;
  const todo = !(rec.placed ?? []).includes(`${album.id}:${s.slot}:${variant}`);
  return `<div class="pocket ${todo ? 'todo' : ''}" data-card="${esc(s.card.id)}">${cardImg(s.card.id, s.card.image, 'low')}
    ${tag}${tier === 'sleeve' ? '<i class="tag sl">B</i>' : ''}</div>`;
}

// ---------------------------------------------------------------------------
// Sfoglia l'album: tutte le doppie pagine a schermo intero, da scorrere col dito.
// ---------------------------------------------------------------------------
const flip = $('#flip');

async function openFlip(startSet) {
  const album = albums.find(a => a.id === currentAlbum) ?? albums[0];
  const layout = await layoutFor(album);
  const slots = new Map();   // posto nell'album -> carta
  for (const row of layout.rows) {
    if (!row.fits) continue;
    row.slots.forEach((s, i) => {
      slots.set(row.start + i, { ...s, slot: row.start + i });
      briefs.set(s.card.id, { ...s.card, setId: row.setId });
    });
  }
  const lastSide = Math.max(1, Math.min(layout.usedSides, layout.totalSides));
  const cols = columns(album.perSide);
  const side = n => {
    if (n < 1 || n > layout.totalSides) return '<div class="side blank"></div>';
    const from = (n - 1) * album.perSide;
    const pockets = Array.from({ length: album.perSide }, (_, i) => albumPocket(album, slots.get(from + i), 'libera'));
    return `<div class="side"><small>Facciata ${n}</small>
      <div class="pockets" style="grid-template-columns:repeat(${cols},1fr)">${pockets.join('')}</div></div>`;
  };
  const spreads = Array.from({ length: Math.floor(lastSide / 2) + 1 }, (_, k) => k);
  flip.innerHTML = `<div class="flip-head">
      <div><h2>${esc(album.name)}</h2><small id="flipLabel"></small></div>
      <button class="icon" data-flip="-1" aria-label="Pagina precedente">‹</button>
      <button class="icon" data-flip="1" aria-label="Pagina successiva">›</button>
      <button class="icon" data-close-flip aria-label="Chiudi">✕</button>
    </div>
    <div class="flip-track">${spreads.map(k => `<section class="flip-page" data-k="${k}">
      <div class="spread-sides">${side(2 * k)}${side(2 * k + 1)}</div></section>`).join('')}</div>`;
  flip.showModal();
  const track = flip.querySelector('.flip-track');
  const label = () => {
    const k = Math.round(track.scrollLeft / track.clientWidth);
    $('#flipLabel').textContent = `${spreadLabel(k)} · ${k + 1} di ${spreads.length}`;
  };
  track.addEventListener('scroll', label, { passive: true });
  // Si apre sulla prima doppia pagina del set che stavi guardando.
  const row = layout.rows.find(r => r.setId === startSet && r.fits);
  if (row) track.scrollLeft = Math.floor(row.firstSide / 2) * track.clientWidth;
  label();
}

flip.addEventListener('click', e => {
  if (e.target === flip || e.target.closest('[data-close-flip]')) return flip.close();
  const step = e.target.closest('[data-flip]');
  if (step) {
    const track = flip.querySelector('.flip-track');
    track.scrollBy({ left: +step.dataset.flip * track.clientWidth, behavior: 'smooth' });
    return;
  }
  const card = e.target.closest('[data-card]');
  if (card) openCard(card.dataset.card);   // la scheda si apre sopra l'album
});

// Stima del costo per completare un set: somma dei prezzi trend delle carte mancanti.
async function completionCost(setId, label) {
  const set = await getSet(setId);
  const missing = set.cards.filter(c => !qty(coll.get(c.id)));
  let total = 0, unpriced = 0, done = 0;
  const queue = [...missing];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c; (c = queue.shift());) {
      try {
        const cm = (await getCard(c.id)).pricing?.cardmarket;
        const price = cm && (cm.trend || cm.avg || cm['trend-holo'] || cm['avg-holo']);
        if (price) total += price; else unpriced++;
      } catch { unpriced++; }
      label.textContent = `calcolo… ${++done}/${missing.length}`;
    }
  }));
  label.textContent = (missing.length === 1 ? 'manca 1 carta' : `mancano ${missing.length} carte`) + ` · circa ${eur(total)}`
    + (unpriced ? ` (${unpriced} senza prezzo)` : '');
}

// ---------------------------------------------------------------------------
// Ricerca avanzata: nome, tipo, rarità, illustratore, categoria e prezzo, nel catalogo o nella
// collezione. Il catalogo filtra lato TCGdex; la collezione si filtra qui.
// ---------------------------------------------------------------------------
const TYPES = ['Erba', 'Fuoco', 'Acqua', 'Lampo', 'Psico', 'Lotta', 'Oscurità', 'Metallo', 'Folletto', 'Drago', 'Incolore'];
let adv = { name: '', types: '', rarity: '', illustrator: '', category: '', scope: 'all', min: '', max: '' };
let advSeq = 0;

function advancedSearch() {
  view.innerHTML = `<header class="top"><a class="back" href="#/" aria-label="Indietro">‹</a><h1>Ricerca avanzata</h1></header>
    <form id="advForm" class="advform">
      <input id="advName" type="search" placeholder="Nome (es. Pikachu)" value="${esc(adv.name)}">
      <select id="advTypes"><option value="">Tutti i tipi</option>${options(TYPES.map(t => [t, t]), adv.types)}</select>
      <select id="advRarity"><option value="">Tutte le rarità</option>${options([...RARITY_ORDER].reverse().map(r => [r, rarityLabel(r)]), adv.rarity)}</select>
      <select id="advCategory"><option value="">Pokémon, Allenatori, Energie</option>${options([['Pokémon', 'Solo Pokémon'], ['Allenatore', 'Solo Allenatori'], ['Energia', 'Solo Energie']], adv.category)}</select>
      <input id="advIllustrator" placeholder="Illustratore (es. Mitsuhiro Arita)" value="${esc(adv.illustrator)}">
      <div class="advprice"><input id="advMin" inputmode="decimal" placeholder="Prezzo da €" value="${esc(adv.min)}">
        <input id="advMax" inputmode="decimal" placeholder="a €" value="${esc(adv.max)}"></div>
      <select id="advScope">${options([['all', 'In tutto il catalogo'], ['missing', 'Solo quelle che mi mancano'], ['mine', 'Solo nella mia collezione']], adv.scope)}</select>
      <button class="primary">Cerca</button>
    </form>
    <div id="advResults"></div>`;
}

const normText = s => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function runAdvanced() {
  adv = {
    name: $('#advName').value.trim(), types: $('#advTypes').value, rarity: $('#advRarity').value,
    illustrator: $('#advIllustrator').value.trim(), category: $('#advCategory').value,
    scope: $('#advScope').value, min: $('#advMin').value.trim(), max: $('#advMax').value.trim(),
  };
  const out = $('#advResults'), seq = ++advSeq;
  const min = parseFloat(adv.min.replace(',', '.')) || 0, max = parseFloat(adv.max.replace(',', '.')) || Infinity;
  const priced = min > 0 || max < Infinity;
  const names = await catalogNames();
  let found = [];

  if (adv.scope === 'mine') {
    const recs = [...coll.values()].filter(qty);
    out.innerHTML = '<p class="note">Recupero i dettagli delle tue carte…</p>';
    await fillDetails(recs);
    found = recs.filter(r => (!adv.name || normText(r.name).includes(normText(adv.name)))
      && (!adv.types || r.types?.includes(adv.types))
      && (!adv.rarity || r.rarity === adv.rarity)
      && (!adv.category || r.category === adv.category)
      && (!adv.illustrator || normText(r.illustrator).includes(normText(adv.illustrator))))
      .map(r => ({ ...recBrief(r), price: Math.max(...r.copies.map(c => unitPrice(r, c.variant))) }));
  } else {
    if (!adv.name && !adv.types && !adv.rarity && !adv.illustrator && !adv.category) {
      out.innerHTML = '<p class="note">Scegli almeno un filtro oltre al prezzo.</p>';
      return;
    }
    out.innerHTML = '<p class="note">Cerco nel catalogo…</p>';
    try {
      found = (await filterCards({ name: adv.name, types: adv.types, rarity: adv.rarity, illustrator: adv.illustrator, category: adv.category }))
        .map(c => ({ ...c, setId: c.id.slice(0, c.id.lastIndexOf('-')) }))
        .filter(c => names.has(c.setId) && (adv.scope !== 'missing' || !qty(coll.get(c.id))));
    } catch {
      out.innerHTML = '<p class="note">Per cercare nel catalogo serve la connessione.</p>';
      return;
    }
    if (priced) {   // il prezzo non è nei risultati: si legge dalle schede (al massimo 120 carte)
      found = found.slice(0, 120);
      const queue = [...found];
      let done = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        for (let c; (c = queue.shift());) {
          try { c.price = cardPrice(await getCard(c.id)); } catch { c.price = 0; }
          if (seq === advSeq) out.innerHTML = `<p class="note">Controllo i prezzi… ${++done}/${found.length}</p>`;
        }
      }));
    }
  }
  if (seq !== advSeq) return;
  if (priced) found = found.filter(c => c.price >= min && c.price <= max);
  for (const c of found) briefs.set(c.id, c);
  const shown = found.slice(0, 200);
  out.innerHTML = found.length
    ? `<p class="note">${plural(found.length, 'carta trovata', 'carte trovate')}${found.length > shown.length ? `, mostrate le prime ${shown.length}` : ''}.</p>
       <div class="grid">${shown.map(c => `<div class="result">${tile(c)}<small>${esc(names.get(c.setId)?.name ?? c.setId)}${c.price ? ' · ' + eur(c.price) : ''}</small></div>`).join('')}</div>`
    : '<p class="note">Nessuna carta con questi filtri.</p>';
}

view.addEventListener('submit', e => {
  if (e.target.id !== 'advForm') return;
  e.preventDefault();
  runAdvanced();
});

// ---------------------------------------------------------------------------
// Obiettivi (scelti da te) e traguardi (automatici). Obiettivi e traguardi raggiunti stanno nel
// database e nel backup; quando se ne raggiunge uno nuovo compare un avviso.
// ---------------------------------------------------------------------------
let goals = [], earnedBadges = null;

/** Numeri della collezione su cui si misurano obiettivi e traguardi. */
function collectionFacts(names) {
  const recs = [...coll.values()].filter(qty);
  const owned = ownedBySet();
  return {
    cards: recs.length,
    value: recs.reduce((a, r) => a + recValue(r), 0),
    foil: recs.reduce((a, r) => a + r.copies.filter(c => c.variant !== 'normal').reduce((s, c) => s + c.qty, 0), 0),
    sets: owned.size,
    // Set completato: tutte le carte numerate (quelle "segrete" oltre il totale stampato non servono).
    complete: [...owned].filter(([id, n]) => names.get(id) && n >= (names.get(id).cardCount.official || names.get(id).cardCount.total)).length,
    maxCard: Math.max(0, ...recs.map(r => Math.max(...r.copies.map(c => unitPrice(r, c.variant))))),
    packs: packs.length,
    deals: deals.length,
    charizard: recs.some(r => /charizard/i.test(r.name)) ? 1 : 0,
  };
}

const BADGES = [
  ...[10, 50, 100, 250, 500, 1000, 2500].map(n => ({ id: 'cards' + n, label: `${n} carte diverse`, of: f => f.cards, target: n })),
  ...[25, 100, 250, 500, 1000, 5000].map(n => ({ id: 'value' + n, label: `Collezione da ${n} €`, of: f => f.value, target: n, money: true })),
  ...[10, 50, 100, 250].map(n => ({ id: 'foil' + n, label: `${n} copie holo o reverse`, of: f => f.foil, target: n })),
  ...[5, 10, 25, 50].map(n => ({ id: 'sets' + n, label: `Carte di ${n} set diversi`, of: f => f.sets, target: n })),
  { id: 'complete1', label: 'Primo set completato', of: f => f.complete, target: 1 },
  { id: 'complete5', label: '5 set completati', of: f => f.complete, target: 5 },
  { id: 'big50', label: 'Una carta da 50 € o più', of: f => f.maxCard, target: 50, money: true },
  { id: 'big200', label: 'Una carta da 200 € o più', of: f => f.maxCard, target: 200, money: true },
  ...[1, 10, 50, 100].map(n => ({ id: 'packs' + n, label: n === 1 ? 'Prima bustina registrata' : `${n} bustine aperte`, of: f => f.packs, target: n })),
  { id: 'charizard', label: 'Un Charizard in collezione', of: f => f.charizard, target: 1 },
  { id: 'deal1', label: 'Primo scambio o vendita', of: f => f.deals, target: 1 },
];

async function catalogNames() {
  const names = new Map();
  try { for (const serie of await getCatalog()) for (const s of serie.sets) names.set(s.id, s); } catch { /* offline */ }
  return names;
}

/** Controlla i traguardi dopo le modifiche: i nuovi si annunciano (la prima volta si registrano in silenzio). */
async function checkBadges() {
  const facts = collectionFacts(await catalogNames());
  const now = BADGES.filter(b => b.of(facts) >= b.target).map(b => b.id);
  if (earnedBadges === null) {
    earnedBadges = now;
  } else {
    const fresh = now.filter(id => !earnedBadges.includes(id));
    if (!fresh.length) return;
    earnedBadges = [...earnedBadges, ...fresh];
    toast(`Traguardo raggiunto: <b>${esc(BADGES.find(b => b.id === fresh.at(-1)).label)}</b>`);
  }
  await db.put('settings', { key: 'badges', value: earnedBadges });
}

const goalLabel = (g, names) => g.kind === 'set' ? `Completa ${names.get(g.setId)?.name ?? g.setId}`
  : g.kind === 'cards' ? `Arriva a ${g.target} carte diverse` : `Collezione da ${eur(g.target)}`;

function goalProgress(g, names, facts) {
  if (g.kind === 'set') {
    const tot = names.get(g.setId)?.cardCount.official || names.get(g.setId)?.cardCount.total || 0;
    return [ownedBySet().get(g.setId) ?? 0, tot];
  }
  return [g.kind === 'cards' ? facts.cards : facts.value, g.target];
}

async function saveGoals() {
  meta.set('dirty', meta.get('dirty') + 1);
  await db.put('settings', { key: 'goals', value: goals });
  autoBackup();
}

function goalsSection(names) {
  const facts = collectionFacts(names);
  const earned = BADGES.filter(b => b.of(facts) >= b.target);
  // Prossimi traguardi: per ogni famiglia il primo non ancora raggiunto, dal più vicino.
  const next = Object.values(BADGES.filter(b => b.of(facts) < b.target)
    .reduce((acc, b) => { const fam = b.id.replace(/\d+$/, ''); acc[fam] ??= b; return acc; }, {}))
    .sort((a, b) => b.of(facts) / b.target - a.of(facts) / a.target).slice(0, 4);
  const amount = (b, v) => b.money ? eur(v) : Math.floor(v);
  return `<h2>Obiettivi</h2>
    ${goals.map(g => {
      const [n, tot] = goalProgress(g, names, facts);
      const done = tot && n >= tot;
      return `<div class="goal ${done ? 'done' : ''}"><span class="info"><b>${esc(goalLabel(g, names))}${done ? ' ✓' : ''}</b>
        ${bar(n, tot)}<small>${g.kind === 'value' ? `${eur(n)} su ${eur(tot)}` : `${Math.floor(n)} su ${tot}`}</small></span>
        <button class="icon" data-goal-del="${g.id}" aria-label="Elimina obiettivo">✕</button></div>`;
    }).join('') || '<p class="note">Nessun obiettivo: aggiungine uno qui sotto.</p>'}
    <div class="settings">
      <select id="goalKind">${options([['set', 'Completa un set'], ['cards', 'Numero di carte'], ['value', 'Valore collezione (€)']], 'set')}</select>
      <select id="goalSet">${options([...ownedBySet().keys()].map(id => [id, names.get(id)?.name ?? id]))}</select>
      <input id="goalTarget" type="number" min="1" placeholder="Quante / quanti €" hidden>
      <button class="chip" data-act="addGoal">Aggiungi obiettivo</button>
    </div>
    <h2>Traguardi <span class="count">${earned.length}/${BADGES.length}</span></h2>
    <div class="badges">
      ${earned.map(b => `<span class="badge-on">${esc(b.label)}</span>`).join('')}
    </div>
    ${next.map(b => `<div class="goal"><span class="info"><b>${esc(b.label)}</b>${bar(b.of(facts), b.target)}
      <small>${amount(b, b.of(facts))} su ${amount(b, b.target)}</small></span></div>`).join('')}`;
}

// ---------------------------------------------------------------------------
// Avvisi di prezzo: per le carte in wishlist puoi indicare a quanto le compreresti. A ogni apertura
// dell'app i loro prezzi si ricontrollano; quelle scese sotto compaiono in cima alla wishlist.
// ---------------------------------------------------------------------------
let priceAlerts = [];   // [{ rec, price }]
const wishPrice = r => unitPrice(r, r.variants && !r.variants.normal ? 'holo' : 'normal');

async function checkPriceAlerts() {
  const recs = [...coll.values()].filter(r => r.wish && r.alert > 0);
  const hits = [];
  for (const r of recs) {
    try {
      applyDetail(r, await getCard(r.cardId));   // scheda al massimo di un giorno fa
      await db.put('cards', r);
    } catch { /* offline: si usa l'ultimo prezzo noto */ }
    const price = wishPrice(r);
    if (price && price <= r.alert) hits.push({ rec: r, price });
  }
  priceAlerts = hits;
  const slot = $('#alertSlot');
  if (slot) slot.innerHTML = alertBanner();
}

const alertBanner = () => priceAlerts.length
  ? `<a class="warn" href="#/wish">${priceAlerts.length === 1
    ? `${esc(priceAlerts[0].rec.name)}: ora ${eur(priceAlerts[0].price)}, sotto il tuo prezzo`
    : `${priceAlerts.length} carte della wishlist sono scese sotto il tuo prezzo`}. Guarda la wishlist.</a>` : '';

const wishCaption = r => {
  const p = wishPrice(r);
  return `<small>${p ? '~' + eur(p) : 'prezzo n.d.'}${r.alert ? ` · avviso a ${eur(r.alert)}` : ''}</small>`;
};

function wish() {
  const recs = [...coll.values()].filter(r => r.wish);
  const below = new Set(priceAlerts.map(a => a.rec.cardId));
  const under = recs.filter(r => below.has(r.cardId)), rest = recs.filter(r => !below.has(r.cardId));
  const grid = list => `<div class="grid">${list.map(r => `<div class="result">${tile(recBrief(r))}${wishCaption(r)}</div>`).join('')}</div>`;
  view.innerHTML = `<header class="top"><h1>Wishlist</h1>
      ${recs.length ? '<button class="chip" data-act="shareWish">Condividi</button>' : ''}</header>` + (recs.length
    ? `${under.length ? `<h2>Sotto il tuo prezzo</h2>${grid(under)}<h2>Le altre</h2>` : ''}${grid(rest)}
       <p class="note">Apri una carta per indicare il prezzo a cui la compreresti: quando scende sotto, te lo
         segnalo all'apertura dell'app.</p>`
    : '<p class="empty">Nessuna carta in wishlist.<br>Apri una carta e tocca ★.</p>');
}

function backupStatus() {
  const last = meta.get('lastBackup'), dirty = meta.get('dirty');
  if (!coll.size) return 'La collezione è vuota: niente da salvare.';
  const when = last && new Date(last).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  if (native) return 'Copia automatica attiva: Download/GAPokemon/ga-pokemon-backup.json'
    + (last ? ` · ultimo salvataggio ${when}` : '');
  if (!last) return 'Non hai ancora fatto un backup.';
  return `Ultimo backup: ${when} · ` + (dirty ? `${dirty} modifiche da allora` : 'tutto salvato');
}

async function more() {
  try {
    catalog ??= await getCatalog();
    for (const serie of catalog) for (const s of serie.sets) setNames.set(s.id, s.name);
  } catch { /* offline: menu dei set vuoto */ }
  view.innerHTML = `<header class="top"><h1>Altro</h1></header>
    <h2>Backup della collezione</h2>
    <p class="note" id="backupStatus">${backupStatus()}</p>
    <div class="list">
      ${shareFile() ? '<button data-act="share">Salva backup su Drive, email o altra app</button>' : ''}
      <button data-act="export">${native ? 'Salva adesso la copia di sicurezza' : 'Scarica backup come file'}</button>
      ${native ? '<button data-act="drive">Invia il backup a Google Drive (o altra app)</button>' : ''}
      <button data-act="import">Ripristina da un backup</button>
      <button data-act="csv">Esporta la collezione per Excel</button>
      <input type="file" id="file" accept="application/json,text/plain,.json,.txt" hidden>
    </div>
    ${native ? `<p class="note">Backup automatico su Google Drive: se nel telefono è attivo il backup Google
      (Impostazioni → Google → Backup), Android salva da solo anche i dati di GA Pokémon e li ripristina
      quando reinstalli l'app o cambi telefono con lo stesso account.</p>` : ''}
    ${native ? `<h2>App</h2>
    <p class="note">Versione installata: ${esc(apkVersion())} · contenuti: ${esc(APP_VERSION)}</p>
    <div class="list"><button data-act="checkUpdate">Controlla aggiornamenti</button></div>` : ''}
    <h2>Modalità fiera (senza internet)</h2>
    <p class="note">Scarica in anticipo i set che ti servono: elenco delle carte, immagini e prezzi. In fiera
      o in negozio l'app li mostra anche senza rete, e con la lista della spesa sai subito cosa ti manca.</p>
    <div class="settings">
      <select id="offSet">${options((catalog ?? []).flatMap(s => s.sets).map(s => [s.id, s.name]))}</select>
      <label><input type="checkbox" id="offPrices" checked> anche i prezzi</label>
      <button class="chip" data-act="offline">Scarica il set</button>
      <button class="chip" data-act="offlineMine">Scarica i set della mia collezione</button>
    </div>
    <p class="note" id="offMsg"></p>
    ${offlineSets.length ? `<div class="deals">${offlineSets.map(o => `<div class="deal-row"><span class="info">
      <b>${esc(setNames.get(o.id) ?? o.id)}</b><small>scaricato il ${shortDate(o.date)} · ${plural(o.cards, 'carta', 'carte')}${o.prices ? ' con prezzi' : ''}${o.missing ? ` · ${o.missing} immagini non scaricate` : ''}</small></span>
      <button class="chip" data-offline-again="${esc(o.id)}">Aggiorna</button></div>`).join('')}</div>` : ''}
    <h2>Manutenzione</h2>
    <div class="list">
      <button data-act="prices">Aggiorna i prezzi della collezione</button>
      <button data-act="cache">Svuota la cache del catalogo</button>
    </div>
    <p class="note" id="msg"></p>
    <p class="note">La collezione resta salvata su questo dispositivo anche chiudendo l'app. Il backup serve
      se cambi telefono o cancelli i dati del browser.<br>
      Dati e immagini: TCGdex. Prezzi: trend Cardmarket.</p>`;
}

// ---------------------------------------------------------------------------
// Modalità fiera: un set scaricato ha elenco carte e prezzi in IndexedDB e le immagini nella cache
// del service worker, quindi si consulta senza connessione.
// ---------------------------------------------------------------------------
let offlineSets = [];   // [{ id, date, cards, prices, missing }]

async function downloadSet(setId, withPrices, msg) {
  const set = await getSet(setId);
  const name = set.name;
  const jobs = set.cards.map(c => ({ c, img: cardImageUrl(c.id, c.image, 'low') }));
  let done = 0, missing = 0;
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let j; (j = queue.shift());) {
      // Passando dalla rete, il service worker salva l'immagine; le schede finiscono in IndexedDB.
      if (j.img) {
        try {
          const res = await fetch(j.img.url, { mode: j.img.cors ? 'cors' : 'no-cors' });
          if (j.img.cors && !res.ok) missing++;
        } catch { missing++; }
      }
      if (withPrices) { try { await getCard(j.c.id); } catch { /* si riprova con Aggiorna */ } }
      msg.textContent = `${name}: ${++done}/${jobs.length}`;
    }
  }));
  offlineSets = [{ id: setId, date: new Date().toISOString().slice(0, 10), cards: jobs.length, prices: withPrices, missing },
    ...offlineSets.filter(o => o.id !== setId)];
  await db.put('settings', { key: 'offlineSets', value: offlineSets });
}

async function downloadSets(ids, withPrices) {
  const msg = $('#offMsg');
  for (const id of ids) {
    try { await downloadSet(id, withPrices, msg); } catch { msg.textContent = 'Download interrotto: serve la connessione.'; return; }
  }
  msg.textContent = `Pronto: ${plural(ids.length, 'set scaricato', 'set scaricati')} per l'uso senza internet.`;
  if (location.hash === '#/more') more();
}

// ---------------------------------------------------------------------------
// Scheda carta
// ---------------------------------------------------------------------------
let cur = null;

async function openCard(id) {
  dealFor = null;
  cur = structuredClone(recFor(id));
  renderSheet();
  sheet.showModal();
  try {
    const d = await getCard(id);
    if (cur?.cardId !== id) return;
    applyDetail(cur, d);
    if (coll.has(id)) await save(cur);
    renderSheet();
  } catch { /* offline: si lavora con quello che c'è */ }
}

function renderSheet() {
  const p = cur.price;
  const variantList = Object.entries(VARIANTS);
  sheet.innerHTML = `<div class="sheet-head">
      <div><h2>${esc(cur.name)}</h2><small>${setNames.has(cur.setId) ? esc(setNames.get(cur.setId)) + ' · ' : ''}N° ${esc(cur.localId)}${cur.rarity && cur.rarity !== 'Nessuna' ? ' · ' + esc(cur.rarity) : ''}</small></div>
      <button class="icon ${cur.wish ? 'on' : ''}" data-wish aria-label="Wishlist">★</button>
      <button class="icon" data-close aria-label="Chiudi">✕</button>
    </div>
    ${cardImg(cur.cardId, cur.image, 'high', 'big')}
    <p class="prices">${p && (p.nonFoil || p.foil)
      ? [p.nonFoil && `${cur.variants && !cur.variants.normal ? 'Prezzo' : 'Normale'} ${eur(p.nonFoil)}`, p.foil && `Foil ${eur(p.foil)}`].filter(Boolean).join(' · ')
      : 'Prezzo non disponibile'}</p>
    <p class="where" id="where"></p>
    ${cur.wish ? `<label class="alertline">Avvisami quando scende sotto
      <input id="alertInput" inputmode="decimal" placeholder="€" value="${cur.alert ?? ''}"> €</label>` : ''}
    <h3>Le mie copie <span>${qty(cur)}</span></h3>
    ${cur.copies.map((c, i) => `<div class="copy" data-i="${i}">
      <select data-f="variant">${options(variantList.filter(([k]) =>
        !cur.variants || cur.variants[k] || k === c.variant), c.variant)}</select>
      <select data-f="condition">${options(CONDITIONS.map(x => [x, x]), c.condition)}</select>
      <select data-f="lang">${options(LANGS.map(x => [x, x]), c.lang)}</select>
      <div class="stepper"><button data-step="-1">−</button><b>${c.qty}</b><button data-step="1">+</button></div>
      <input data-f="grade" placeholder="Gradazione (es. PSA 10)" value="${esc(c.grade)}">
      <input data-f="paid" inputmode="decimal" placeholder="Pagata € (a copia)" value="${c.paid ?? ''}">
      <input data-f="note" class="wide" placeholder="Note" value="${esc(c.note)}">
      ${dealFor === i ? '' : `<button class="chip deal" data-deal="${i}">Vendi, scambia o regala</button>`}
    </div>
    ${dealFor === i ? dealForm(c, i) : ''}`).join('')}
    <button class="primary" data-newcopy>+ Aggiungi copia</button>`;
  fillWhere();
}

// ---------------------------------------------------------------------------
// Vendite, scambi e regali: tolgono la copia dalla collezione e restano nel registro
// (nel database e nel backup), con incasso e guadagno rispetto al prezzo pagato.
// ---------------------------------------------------------------------------
let deals = [], dealFor = null;
const DEAL_KINDS = { sold: 'Venduta', traded: 'Scambiata', gift: 'Regalata' };

function dealForm(c, i) {
  return `<div class="dealform" data-i="${i}">
    <select id="dealKind">${options(Object.entries(DEAL_KINDS), 'sold')}</select>
    <label>Copie <input id="dealQty" type="number" min="1" max="${c.qty}" value="1"></label>
    <input id="dealPrice" inputmode="decimal" placeholder="Incassati € (in totale)">
    <input id="dealWho" placeholder="Con chi">
    <input id="dealNote" class="wide" placeholder="Note (es. cosa hai ricevuto in cambio)">
    <button class="primary" data-deal-ok>Conferma</button>
    <button class="chip" data-deal-cancel>Annulla</button>
  </div>`;
}

async function saveDeals() {
  meta.set('dirty', meta.get('dirty') + 1);
  await db.put('settings', { key: 'deals', value: deals });
  autoBackup();
}

async function confirmDeal(i) {
  const c = cur.copies[i];
  const n = Math.min(c.qty, Math.max(1, Math.round(+$('#dealQty').value || 1)));
  const price = parseFloat($('#dealPrice').value.replace(',', '.'));
  const kind = $('#dealKind').value;
  deals.unshift({
    id: Date.now(), date: new Date().toISOString().slice(0, 10), kind, qty: n,
    cardId: cur.cardId, name: cur.name, setId: cur.setId, localId: cur.localId, image: cur.image,
    variant: c.variant, condition: c.condition, lang: c.lang, paid: c.paid ?? null,
    value: unitPrice(cur, c.variant), price: kind === 'sold' && price >= 0 ? price : null,
    who: $('#dealWho').value.trim(), note: $('#dealNote').value.trim(),
  });
  c.qty -= n;
  dealFor = null;
  await saveDeals();
  await save(cur);
  toast(`${DEAL_KINDS[kind]}: ${esc(cur.name)} ×${n}. La trovi in Collezione → Vendite e scambi.`);
}

/** Annulla una vendita registrata per errore: la copia torna nella collezione. */
async function undoDeal(id) {
  const d = deals.find(x => x.id === id);
  if (!d) return;
  const rec = structuredClone(coll.get(d.cardId) ?? recFor(d.cardId));
  Object.assign(rec, { name: rec.name ?? d.name, setId: rec.setId ?? d.setId, localId: rec.localId ?? d.localId, image: rec.image ?? d.image });
  rec.copies.push({ variant: d.variant, qty: d.qty, condition: d.condition ?? 'NM', lang: d.lang ?? 'IT', grade: '', note: '', paid: d.paid });
  deals.splice(deals.indexOf(d), 1);
  await saveDeals();
  await save(rec);
}

function dealsSection() {
  if (!deals.length) return '';
  const sold = deals.filter(d => d.kind === 'sold');
  const cashed = sold.reduce((a, d) => a + (d.price ?? 0), 0);
  const withCost = sold.filter(d => d.price != null && d.paid != null);
  const gain = withCost.reduce((a, d) => a + d.price - d.paid * d.qty, 0);
  return `<h2>Vendite e scambi</h2>
    <div class="kpis">
      <div><b>${eur(cashed)}</b><small>Incassato (${plural(sold.length, 'vendita', 'vendite')})</small></div>
      <div><b class="${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : '−'}${eur(Math.abs(gain))}</b>
        <small>Guadagno sul pagato${withCost.length < sold.length ? ` (${withCost.length} con prezzo pagato)` : ''}</small></div>
    </div>
    <div class="deals">${deals.slice(0, 50).map(d => `<div class="deal-row">
      <span class="info"><b>${esc(d.name)}</b> <small>${esc(setNames.get(d.setId) ?? d.setId ?? '')} · N° ${esc(d.localId ?? '')} · ${esc(VARIANTS[d.variant] ?? d.variant)}</small>
        <small>${shortDate(d.date)} · ${DEAL_KINDS[d.kind]} ×${d.qty}${d.price != null ? ' a ' + eur(d.price) : ''}${d.who ? ' · ' + esc(d.who) : ''}${d.note ? ' · ' + esc(d.note) : ''}</small></span>
      <button class="icon" data-undo-deal="${d.id}" aria-label="Annulla e rimetti la copia nella collezione">↶</button>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Bustine aperte: mentre una bustina è "aperta", ogni carta aggiunta (scansione, +, scheda) le
// viene associata. Alla fine resta nel registro (database e backup) con spesa e valore trovato.
// ---------------------------------------------------------------------------
let packs = [], openPack = null;
// Carta "forte": ex/V e rarità superiori, oppure che vale almeno 2 €.
const HIT_RARITY = rarityRank('Rara doppia');
const isHit = c => rarityRank(c.rarity) >= HIT_RARITY || c.value >= 2;

async function savePacks() {
  meta.set('dirty', meta.get('dirty') + 1);
  await db.put('settings', { key: 'packs', value: packs });
  await db.put('settings', { key: 'openPack', value: openPack });
  autoBackup();
}

async function openPackDialog() {
  if (openPack) return toast('C\'è già una bustina aperta: tocca Fine nella barra in basso per chiuderla.');
  let order = [];
  try { order = (await getCatalog()).flatMap(s => s.sets); } catch { /* offline */ }
  const recent = [...new Set(packs.map(p => p.setId))];
  const pick = recent[0] ?? order[0]?.id;
  $('#packSet').innerHTML = (recent.length ? `<optgroup label="Aperte di recente">${options(recent.map(id => [id, setNames.get(id) ?? id]), pick)}</optgroup>` : '')
    + `<optgroup label="Tutti i set">${options(order.map(s => [s.id, s.name]), recent.length ? '' : pick)}</optgroup>`;
  $('#packPrice').value = packs[0]?.price ?? '';
  $('#packDialog').showModal();
}

$('#packForm').addEventListener('submit', async e => {
  e.preventDefault();
  const setId = $('#packSet').value;
  const price = parseFloat($('#packPrice').value.replace(',', '.'));
  openPack = { id: Date.now(), date: new Date().toISOString().slice(0, 10), setId, price: price >= 0 ? price : null, cards: [] };
  $('#packDialog').close();
  await savePacks();
  renderPackbar();
  location.hash = '#/set/' + encodeURIComponent(setId);   // si parte dal set della bustina
});
$('#packDialog').addEventListener('click', e => {
  if (e.target === $('#packDialog') || e.target.closest('[data-close-pack]')) $('#packDialog').close();
});

/** Chiamata a ogni copia aggiunta: se c'è una bustina aperta, la carta finisce lì. */
async function recordInPack(rec, variant) {
  if (!openPack) return;
  openPack.cards.push({ cardId: rec.cardId, name: rec.name, setId: rec.setId, localId: rec.localId,
    image: rec.image, variant, rarity: rec.rarity, value: unitPrice(rec, variant) });
  await savePacks();
  renderPackbar();
}

function renderPackbar() {
  const bar = $('#packbar');
  bar.hidden = !openPack;
  if (!openPack) return;
  const value = openPack.cards.reduce((a, c) => a + c.value, 0);
  bar.innerHTML = `<span><b>Bustina di ${esc(setNames.get(openPack.setId) ?? openPack.setId)}</b>
      <small>${plural(openPack.cards.length, 'carta', 'carte')} · ${eur(value)}${openPack.price != null ? ` su ${eur(openPack.price)} spesi` : ''}</small></span>
    ${openPack.cards.length ? '<button class="chip" data-pack-undo>Togli ultima</button>' : '<button class="chip" data-pack-cancel>Annulla</button>'}
    <button class="chip on" data-pack-done>Fine</button>`;
}

$('#packbar').addEventListener('click', async e => {
  if (e.target.closest('[data-pack-done]')) {
    const p = openPack, value = p.cards.reduce((a, c) => a + c.value, 0);
    if (p.cards.length) packs.unshift(p);
    openPack = null;
    await savePacks();
    renderPackbar();
    toast(p.cards.length ? `Bustina registrata: ${plural(p.cards.length, 'carta', 'carte')}, ${eur(value)}`
      + (p.price != null ? ` (${value >= p.price ? '+' : '−'}${eur(Math.abs(value - p.price))} sul prezzo)` : '')
      : 'Bustina vuota: non registrata.');
    if (location.hash === '#/stats') stats();
  }
  if (e.target.closest('[data-pack-cancel]')) {
    openPack = null;
    await savePacks();
    renderPackbar();
  }
  if (e.target.closest('[data-pack-undo]')) {   // ultima carta registrata per sbaglio: la si toglie anche dalla collezione
    const last = openPack.cards.pop();
    await savePacks();
    await removeOne(last.cardId);
    renderPackbar();
  }
});

function packsSection() {
  if (!packs.length) return '';
  const spent = packs.reduce((a, p) => a + (p.price ?? 0), 0);
  const pulled = packs.reduce((a, p) => a + p.cards.reduce((s, c) => s + c.value, 0), 0);
  const hits = packs.flatMap(p => p.cards.filter(isHit));
  const best = packs.flatMap(p => p.cards).sort((a, b) => b.value - a.value)[0];
  const bySet = new Map();
  for (const p of packs) {
    const s = bySet.get(p.setId) ?? { n: 0, spent: 0, value: 0, hits: 0 };
    s.n++;
    s.spent += p.price ?? 0;
    s.value += p.cards.reduce((a, c) => a + c.value, 0);
    s.hits += p.cards.filter(isHit).length;
    bySet.set(p.setId, s);
  }
  return `<h2>Bustine aperte</h2>
    <div class="kpis">
      <div><b>${packs.length}</b><small>Bustine · ${eur(spent)} spesi</small></div>
      <div><b class="${pulled >= spent ? 'up' : 'down'}">${eur(pulled)}</b><small>Valore trovato</small></div>
      <div><b>${hits.length ? `1 ogni ${(packs.length / hits.length).toFixed(1).replace('.', ',')}` : '—'}</b><small>Carte forti (ex, V e superiori, o da 2 € in su)</small></div>
      <div><b>${best ? eur(best.value) : '—'}</b><small>Colpo migliore${best ? ': ' + esc(best.name) : ''}</small></div>
    </div>
    ${[...bySet].map(([id, s]) => `<div class="deal-row"><span class="info"><b>${esc(setNames.get(id) ?? id)}</b>
      <small>${plural(s.n, 'bustina', 'bustine')} · ${eur(s.spent)} spesi · ${eur(s.value)} trovati
        (${eur(s.value / s.n)} a bustina) · ${plural(s.hits, 'carta forte', 'carte forti')}</small></span></div>`).join('')}`;
}

// Prezzo indicativo di una carta (trend Cardmarket della versione normale, altrimenti foil).
const cardPrice = d => {
  const cm = d?.pricing?.cardmarket;
  return cm ? cm.trend || cm.avg || cm['trend-holo'] || cm['avg-holo'] || 0 : 0;
};

// Lista della spesa: le carte che mancano di un set, con prezzo indicativo e totale.
async function shareMissing(setId) {
  const set = await getSet(setId);
  const missing = set.cards.filter(c => !qty(coll.get(c.id)));
  if (!missing.length) return toast(`Hai completato ${esc(set.name)}!`);
  const prices = new Map(), queue = [...missing];
  let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c; (c = queue.shift());) {
      try { prices.set(c.id, cardPrice(await getCard(c.id))); } catch { /* senza prezzo */ }
      toast(`Preparo la lista… ${++done}/${missing.length}`);
    }
  }));
  const total = [...prices.values()].reduce((a, p) => a + p, 0);
  const lines = missing.map(c => `• ${c.localId} ${c.name}${prices.get(c.id) ? ` — ~${eur(prices.get(c.id))}` : ''}`);
  toast('Lista pronta.');
  shareText(`Mi mancano di ${set.name}`,
    `Carte che mi mancano di ${set.name} (${missing.length}):\n\n${lines.join('\n')}\n\nTotale indicativo: ~${eur(total)} (prezzi trend Cardmarket)`);
}

async function shareWishlist() {
  try { for (const serie of await getCatalog()) for (const s of serie.sets) setNames.set(s.id, s.name); } catch { /* offline */ }
  const recs = [...coll.values()].filter(r => r.wish);
  if (!recs.length) return toast('La wishlist è vuota.');
  const lines = recs.map(r => {
    const p = unitPrice(r, r.variants && !r.variants.normal ? 'holo' : 'normal');
    return `• ${r.name} — ${setNames.get(r.setId) ?? r.setId} n° ${r.localId}${p ? ` (~${eur(p)})` : ''}`;
  });
  shareText('La mia wishlist Pokémon', `Le carte che cerco:\n\n${lines.join('\n')}`);
}

// Lista dei doppioni da mandare a chi scambia con te.
async function shareDoubles() {
  try { for (const serie of await getCatalog()) for (const s of serie.sets) setNames.set(s.id, s.name); } catch { /* offline */ }
  const lines = [...coll.values()].filter(r => qty(r) > 1)
    .sort((a, b) => (setNames.get(a.setId) ?? '').localeCompare(setNames.get(b.setId) ?? '') || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }))
    .map(r => {
      const v = unitPrice(r, bestCopy(r).variant);
      return `• ${r.name} — ${setNames.get(r.setId) ?? r.setId} n° ${r.localId} ×${qty(r) - 1}${v ? ` (~${eur(v)})` : ''}`;
    });
  if (!lines.length) return toast('Non hai doppioni da condividere.');
  shareText('Doppioni da scambiare', `I miei doppioni Pokémon da scambiare:\n\n${lines.join('\n')}`);
}

/** Condivisione di un testo: nell'APK il menu di Android, nel browser quello del telefono, altrimenti appunti. */
async function shareText(title, text) {
  if (native?.shareText) return native.shareText(title, text);
  if (navigator.share) {
    try { return await navigator.share({ title, text }); } catch (err) { if (err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Testo copiato: incollalo dove vuoi (WhatsApp, email…).');
  } catch {
    toast('Condivisione non disponibile su questo dispositivo.');
  }
}

// "Dove va": posto nell'album (o toploader) della carta aperta, con il pulsante per segnarla sistemata.
async function fillWhere() {
  const rec = cur;
  if (!rec || !qty(rec)) return;
  const places = await placementsOf(rec);
  const el = $('#where');
  if (!el || cur !== rec || !places.length) return;
  const pending = places.some(p => p.key && !isPlaced(rec, p));
  el.innerHTML = `<b>Dove va</b> ${places.map(p => esc(p.text)).join('<br>')}
    ${pending ? '<button class="chip" data-mark-placed>Sistemata</button>' : places.some(p => p.key) ? '<small>✓ già sistemata</small>' : ''}`;
}

sheet.addEventListener('click', async e => {
  if (e.target === sheet || e.target.closest('[data-close]')) {
    sheet.close();
    return afterClose();
  }
  if (!cur) return;
  if (e.target.closest('[data-mark-placed]')) {
    await markPlaced(cur);
    return renderSheet();
  }
  const deal = e.target.closest('[data-deal]');
  if (deal) {
    dealFor = +deal.dataset.deal;
    return renderSheet();
  }
  if (e.target.closest('[data-deal-cancel]')) {
    dealFor = null;
    return renderSheet();
  }
  if (e.target.closest('[data-deal-ok]')) {
    await confirmDeal(+e.target.closest('.dealform').dataset.i);
    return renderSheet();
  }
  let added = null;   // copia aggiunta, da registrare nella bustina aperta
  if (e.target.closest('[data-wish]')) cur.wish = !cur.wish;
  else if (e.target.closest('[data-newcopy]')) cur.copies.push(added = newCopy(cur));
  else if (e.target.closest('[data-step]')) {
    const i = +e.target.closest('.copy').dataset.i, step = +e.target.closest('[data-step]').dataset.step;
    cur.copies[i].qty += step;
    if (step > 0) added = cur.copies[i];
  } else return;
  await save(cur);
  renderSheet();
  if (added) await recordInPack(cur, added.variant);
});

sheet.addEventListener('change', async e => {
  if (e.target.id === 'alertInput' && cur) {
    const v = parseFloat(e.target.value.replace(',', '.'));
    cur.alert = v > 0 ? v : null;
    await save(cur);
    checkPriceAlerts();
    return;
  }
  const f = e.target.dataset.f;
  if (!f || !cur) return;
  const value = e.target.value.trim();
  // Prezzo pagato: numero con virgola o punto; vuoto = non indicato.
  cur.copies[+e.target.closest('.copy').dataset.i][f] = f === 'paid'
    ? (value ? Math.max(0, parseFloat(value.replace(',', '.'))) || 0 : null)
    : value;
  await save(cur);
});

// Alla chiusura si aggiorna solo la carta toccata, così la pagina sotto non salta in cima.
// Collezione e Wishlist invece vanno ricalcolate per intero.
function afterClose() {
  if (!cur) return;
  const id = cur.cardId;
  cur = null;
  const page = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (page === 'stats' || page === 'wish' || page === 'album') route();
  else refreshCard(id);
}
// L'evento "close" copre il tasto Indietro del telefono; può arrivare in ritardo, quindi
// la chiusura dal pulsante aggiorna subito senza aspettarlo.
sheet.addEventListener('close', afterClose);

// Chiamata dall'APK quando si preme Indietro: true = gestito qui (c'era la scheda carta aperta).
window.appBack = () => {
  if (sheet.open) {
    sheet.close();
    afterClose();
    return true;
  }
  if (scanner.open) {
    closeScanner();
    return true;
  }
  for (const d of [flip, $('#packDialog')]) {
    if (d.open) {
      d.close();
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// Scansione di una carta con la fotocamera (riconoscimento in js/scan.js)
// ---------------------------------------------------------------------------
const scanner = $('#scanner');
const scanVideo = scanner.querySelector('video');
let scanStream = null;

async function openScanner() {
  $('#scanMsg').textContent = '';
  $('#scanResults').innerHTML = '';
  burstLog = [];
  renderBurstLog();
  scanner.showModal();
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    scanVideo.srcObject = scanStream;
    await scanVideo.play();
    scanner.classList.remove('nocam');
  } catch {
    scanner.classList.add('nocam');
    // Le versioni dell'APK prima della 1.2 non hanno il permesso per la fotocamera.
    $('#scanMsg').textContent = apkUpdate
      ? 'Per usare la fotocamera aggiorna l\'app (avviso nella schermata iniziale). Intanto puoi usare una foto della carta.'
      : 'Fotocamera non disponibile o permesso negato: puoi usare una foto della carta.';
  }
}

function stopCamera() {
  scanStream?.getTracks().forEach(t => t.stop());
  scanStream = null;
}

function closeScanner() {
  stopCamera();
  if (scanner.open) scanner.close();
}

let scanning = false, lastReading = null;
async function recognize(card) {
  if (scanning) return;
  scanning = true;
  const msg = $('#scanMsg');
  $('#scanResults').innerHTML = '';
  $('#scanFix').hidden = true;
  try {
    lastReading = await readCard(card, status => { msg.textContent = status; });
    await showMatches(lastReading);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    scanning = false;
  }
}

async function showMatches(reading) {
  const msg = $('#scanMsg');
  msg.textContent = 'Cerco nel catalogo…';
  const found = await findCards(reading);
  for (const c of found) briefs.set(c.id, c);
  const n = reading.number;
  const numberText = n ? `Ho letto il numero ${n.prefix}${n.num}${n.total ? '/' + n.total : ''}. ` : 'Non sono riuscito a leggere il numero. ';
  msg.textContent = found.length
    ? numberText + 'Tocca la carta giusta per aprirla, oppure + per aggiungerla subito.'
    : numberText + 'Nessuna carta trovata: riprova con più luce e la carta dritta e ferma, o scrivi il numero qui sotto.';
  $('#scanFix').hidden = false;
  $('#scanNumber').value = '';
  $('#scanResults').innerHTML = found.length ? `<div class="grid">${found.map(c =>
    `<div class="result">${tile(c)}<small>${esc(c.setName)}</small></div>`).join('')}</div>` : '';

  // Raffica: se il riconoscimento è sicuro (numero e nome tornano, e nessun'altra carta ci si
  // avvicina) la carta si aggiunge da sola e si passa alla prossima; altrimenti si sceglie a mano.
  const [best, second] = found;
  if ($('#scanBurst').checked && best && best.score >= 1.6 && (!second || best.score - second.score >= 0.3)) {
    await quickAdd(best.id);
    burstLog.unshift({ id: best.id, name: best.name, setName: best.setName, localId: best.localId });
    msg.textContent = `Aggiunta: ${best.name} (${best.setName} n° ${best.localId}). Inquadra la prossima.`;
    $('#scanResults').innerHTML = '';
    $('#scanFix').hidden = true;
    renderBurstLog();
  }
}

// Carte aggiunte in raffica in questa sessione, con la possibilità di toglierle se sbagliate.
let burstLog = [];
function renderBurstLog() {
  $('#scanLog').innerHTML = burstLog.length ? `<h3>Aggiunte in raffica <span>${burstLog.length}</span></h3>
    ${burstLog.map((b, i) => `<div class="burst-row"><span>${esc(b.name)} <small>${esc(b.setName)} n° ${esc(b.localId)}</small></span>
      <button class="chip" data-burst-undo="${i}">Togli</button></div>`).join('')}` : '';
}

/** Toglie una copia aggiunta per sbaglio (l'ultima della prima riga di copie). */
async function removeOne(id) {
  const rec = structuredClone(coll.get(id));
  if (!rec?.copies.length) return;
  rec.copies[rec.copies.length - 1].qty--;
  await save(rec);
  refreshCard(id);
}

// Correzione a mano del numero letto male: stessa ricerca, con il nome letto dalla foto.
$('#scanFix').addEventListener('submit', async e => {
  e.preventDefault();
  const number = parseNumber($('#scanNumber').value);
  if (!number) {
    $('#scanMsg').textContent = 'Scrivi il numero come sulla carta, es. 81/198 oppure TG12/TG30.';
    return;
  }
  await showMatches({ number, nameText: lastReading?.nameText ?? '' });
});

scanner.addEventListener('click', e => {
  if (e.target === scanner || e.target.closest('[data-close-scan]')) return closeScanner();
  if (e.target.closest('[data-shot]')) {
    if (!scanStream) return $('#scanFile').click();
    return recognize(captureFromVideo(scanVideo, scanner.querySelector('.frame')));
  }
  const undo = e.target.closest('[data-burst-undo]');
  if (undo) {
    const [b] = burstLog.splice(+undo.dataset.burstUndo, 1);
    removeOne(b.id).then(renderBurstLog);
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) return quickAdd(add.dataset.add);
  const card = e.target.closest('[data-card]');
  if (card) openCard(card.dataset.card);   // la scheda si apre sopra: chiudendola si torna a scansionare
});

scanner.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (e.target.id !== 'scanFile' || !file) return;
  e.target.value = '';
  recognize(await canvasFromFile(file));
});

scanner.addEventListener('close', stopCamera);

function refreshCard(id) {
  const b = briefs.get(id);
  if (b) for (const el of document.querySelectorAll(`[data-card="${CSS.escape(id)}"]`)) el.outerHTML = tile(b);
  renderProgress();
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
// Le aggiunte rapide vanno in fila: due tocchi veloci sulla stessa carta devono contare due copie.
let addQueue = Promise.resolve();
const quickAdd = id => (addQueue = addQueue.then(() => addCopy(id)).catch(() => {}));

async function addCopy(id) {
  const rec = structuredClone(recFor(id));
  if (!rec.variants) {
    try { applyDetail(rec, await getCard(id)); } catch { /* offline */ }
  }
  if (rec.copies[0]) rec.copies[0].qty++;
  else rec.copies.push(newCopy(rec));
  await save(rec);
  refreshCard(id);
  toastPlacement(rec);
  await recordInPack(rec, rec.copies[0].variant);
}

async function refreshPrices(msg) {
  const recs = [...coll.values()];
  let done = 0, errors = 0;
  const queue = [...recs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let rec; (rec = queue.shift());) {
      try {
        applyDetail(rec, await getCard(rec.cardId, true));
        await db.put('cards', rec);
      } catch { errors++; }
      msg.textContent = `Aggiornamento prezzi… ${++done}/${recs.length}`;
    }
  }));
  msg.textContent = `Prezzi aggiornati: ${done - errors} carte` + (errors ? `, ${errors} non riuscite.` : '.');
  meta.set('pricesAt', Date.now());
  recordValue();
}

// ---------------------------------------------------------------------------
// Valore nel tempo: un punto al giorno (valore totale e copie), nel database e nel backup.
// I prezzi si riaggiornano da soli una volta a settimana, così la curva segue il mercato.
// ---------------------------------------------------------------------------
let valueLog = [];
const PRICE_REFRESH_EVERY = 7 * 24 * 60 * 60 * 1000;
let logTimer;

function recordValue() {
  clearTimeout(logTimer);
  logTimer = setTimeout(async () => {
    const recs = [...coll.values()];
    const v = Math.round(recs.reduce((a, r) => a + recValue(r), 0) * 100) / 100;
    const n = recs.reduce((a, r) => a + qty(r), 0);
    const d = new Date().toISOString().slice(0, 10);
    const last = valueLog.at(-1);
    if (last?.d === d) Object.assign(last, { v, n });
    else valueLog.push({ d, v, n });
    await db.put('settings', { key: 'valueLog', value: valueLog });
    await checkBadges();
  }, 2000);
}

const shortDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' });

/** Grafico a linea del valore della collezione; toccandolo si leggono data e valore di ogni giorno. */
function valueChart(log) {
  if (log.length < 2) {
    return `<p class="note">Il grafico si forma giorno dopo giorno: l'app segna il valore della collezione
      ogni giorno in cui la usi${log.length ? ` (primo punto: ${shortDate(log[0].d)}, ${eur(log[0].v)})` : ''}.</p>`;
  }
  const W = 600, H = 170, L = 6, R = 6, T = 10, B = 10;
  const t0 = Date.parse(log[0].d), t1 = Date.parse(log.at(-1).d);
  const values = log.map(p => p.v);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = (max - min) * 0.12 || max * 0.05 || 1;
  const lo = Math.max(0, min - pad), hi = max + pad;
  const x = d => L + (Date.parse(d) - t0) / (t1 - t0 || 1) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const pts = log.map(p => [x(p.d), y(p.v)]);
  const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
  const change = log.at(-1).v - log[0].v;
  const data = esc(JSON.stringify(log.map((p, i) => [pts[i][0], pts[i][1], shortDate(p.d), eur(p.v)])));
  return `<div class="vchart">
    <p class="vchart-read"><b>${eur(log.at(-1).v)}</b>
      <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : '−'}${eur(Math.abs(change))}</span>
      dal ${shortDate(log[0].d)}</p>
    <svg viewBox="0 0 ${W} ${H}" data-points="${data}" role="img"
      aria-label="Valore della collezione dal ${shortDate(log[0].d)} al ${shortDate(log.at(-1).d)}">
      <line class="grid" x1="0" x2="${W}" y1="${y(max).toFixed(1)}" y2="${y(max).toFixed(1)}"/>
      <line class="grid" x1="0" x2="${W}" y1="${y(min).toFixed(1)}" y2="${y(min).toFixed(1)}"/>
      <path class="area" d="${line}L${pts.at(-1)[0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z"/>
      <path class="line" d="${line}"/>
      <line class="cross" y1="0" y2="${H}" x1="-10" x2="-10"/>
      <circle class="dot" r="5" cx="-10" cy="-10"/>
    </svg>
    <div class="vchart-axis"><small>${shortDate(log[0].d)}</small><small>max ${eur(max)} · min ${eur(min)}</small><small>${shortDate(log.at(-1).d)}</small></div>
  </div>`;
}

// Toccando o scorrendo sul grafico si legge il punto più vicino.
view.addEventListener('pointermove', e => {
  const svg = e.target.closest?.('.vchart svg');
  if (!svg) return;
  const points = JSON.parse(svg.dataset.points);
  const box = svg.getBoundingClientRect();
  const px = (e.clientX - box.left) / box.width * svg.viewBox.baseVal.width;
  const [cx, cy, date, value] = points.reduce((best, p) => Math.abs(p[0] - px) < Math.abs(best[0] - px) ? p : best);
  svg.querySelector('.cross').setAttribute('x1', cx);
  svg.querySelector('.cross').setAttribute('x2', cx);
  svg.querySelector('.dot').setAttribute('cx', cx);
  svg.querySelector('.dot').setAttribute('cy', cy);
  svg.closest('.vchart').querySelector('.vchart-read').innerHTML = `<b>${value}</b> il ${date}`;
});

const backupJson = () => JSON.stringify({ app: 'pokecollezione', version: 2, cards: [...coll.values()], albums, valueLog, deals, packs, goals });
const backupName = ext => `ga-pokemon-${new Date().toISOString().slice(0, 10)}.${ext}`;

// File di backup che il telefono accetta di condividere con altre app (Drive, email, WhatsApp…),
// oppure null se la condivisione di file non è disponibile. Non tutti accettano i .json: si prova anche .txt.
function shareFile() {
  for (const [ext, type] of [['json', 'application/json'], ['txt', 'text/plain']]) {
    const file = new File([backupJson()], backupName(ext), { type });
    if (navigator.canShare?.({ files: [file] })) return file;
  }
  return null;
}

function backupDone() {
  meta.set('lastBackup', Date.now());
  meta.set('dirty', 0);
  $('#backupStatus').textContent = backupStatus();
}

async function shareBackup(msg) {
  try {
    await navigator.share({ files: [shareFile()], title: 'Backup GA Pokémon' });
    backupDone();
  } catch (err) {
    if (err.name !== 'AbortError') msg.textContent = 'Condivisione non riuscita: prova a scaricare il file.';
  }
}

function exportBackup(msg) {
  if (native) {
    const path = native.saveBackup(backupJson());
    msg.textContent = path ? `Copia salvata in ${path}.` : 'Salvataggio non riuscito.';
    if (path) backupDone();
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([backupJson()], { type: 'application/json' }));
  a.download = backupName('json');
  a.click();
  URL.revokeObjectURL(a.href);
  backupDone();
}

// Esportazione per Excel: una riga per ogni gruppo di copie (CSV con ";" e BOM, come lo vuole Excel in italiano).
async function exportCsv(msg) {
  const names = await catalogNames();
  const cell = v => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = n => (n == null || n === '' ? '' : String(Math.round(n * 100) / 100).replace('.', ','));
  const rows = [['Set', 'Numero', 'Nome', 'Rarità', 'Variante', 'Condizione', 'Lingua', 'Gradazione', 'Copie',
    'Pagata € (a copia)', 'Valore € (a copia)', 'Valore € (totale)', 'Note', 'Wishlist']];
  const recs = [...coll.values()].sort((a, b) => (names.get(a.setId)?.name ?? '').localeCompare(names.get(b.setId)?.name ?? '')
    || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
  for (const r of recs) {
    const base = [names.get(r.setId)?.name ?? r.setId, r.localId, r.name, rarityLabel(r.rarity)];
    if (!r.copies.length) rows.push([...base, '', '', '', '', 0, '', '', '', '', r.wish ? 'sì' : '']);
    for (const c of r.copies) {
      const unit = unitPrice(r, c.variant);
      rows.push([...base, VARIANTS[c.variant] ?? c.variant, c.condition, c.lang, c.grade, c.qty,
        num(c.paid), num(unit), num(unit * c.qty), c.note, r.wish ? 'sì' : '']);
    }
  }
  const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
  const name = `ga-pokemon-collezione-${new Date().toISOString().slice(0, 10)}.csv`;
  if (native?.shareFile) {
    if (!native.shareFile(name, 'text/csv', csv)) msg.textContent = 'Esportazione non riuscita.';
  } else if (native?.saveFile) {
    const path = native.saveFile(name, 'text/csv', csv);
    msg.textContent = path ? `File salvato in ${path}: aprilo con Excel o Fogli Google.` : 'Esportazione non riuscita.';
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

async function importBackup(file, msg) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'pokecollezione' || !Array.isArray(data.cards)) throw new Error('formato non riconosciuto');
    for (const rec of data.cards) {
      if (!rec.cardId || !Array.isArray(rec.copies)) continue;
      coll.set(rec.cardId, rec);
      await db.put('cards', rec);
    }
    if (Array.isArray(data.albums) && data.albums.length) {   // backup dalla versione 2: anche gli album
      albums = data.albums;
      await saveAlbums(albums);
    }
    if (Array.isArray(data.valueLog) && data.valueLog.length > valueLog.length) {
      valueLog = data.valueLog;
      await db.put('settings', { key: 'valueLog', value: valueLog });
    }
    if (Array.isArray(data.deals) && data.deals.length > deals.length) {
      deals = data.deals;
      await db.put('settings', { key: 'deals', value: deals });
    }
    if (Array.isArray(data.goals) && data.goals.length > goals.length) {
      goals = data.goals;
      await db.put('settings', { key: 'goals', value: goals });
    }
    if (Array.isArray(data.packs) && data.packs.length > packs.length) {
      packs = data.packs;
      await db.put('settings', { key: 'packs', value: packs });
    }
    invalidateLayouts();
    autoBackup();
    msg.textContent = `Carte importate: ${data.cards.length}.`;
    $('#backupStatus').textContent = backupStatus();
  } catch (err) {
    msg.textContent = 'Importazione non riuscita: ' + err.message;
  }
}

view.addEventListener('click', async e => {
  const add = e.target.closest('[data-add]');
  if (add) return quickAdd(add.dataset.add);
  const card = e.target.closest('[data-card]');
  if (card) return openCard(card.dataset.card);
  const filter = e.target.closest('[data-filter]');
  if (filter) {
    setFilter = filter.dataset.filter;
    for (const c of view.querySelectorAll('[data-filter]')) c.classList.toggle('on', c === filter);
    return renderGrid();
  }
  const again = e.target.closest('[data-offline-again]');
  if (again) {
    const o = offlineSets.find(x => x.id === again.dataset.offlineAgain);
    return downloadSets([o.id], o.prices);
  }
  const goalDel = e.target.closest('[data-goal-del]');
  if (goalDel) {
    goals = goals.filter(g => g.id !== +goalDel.dataset.goalDel);
    await saveGoals();
    return stats();
  }
  const undo = e.target.closest('[data-undo-deal]');
  if (undo) {
    if (!confirm('Annullare questa operazione e rimettere la copia nella collezione?')) return;
    await undoDeal(+undo.dataset.undoDeal);
    return stats();
  }
  const placed = e.target.closest('[data-placed]');
  if (placed) {
    placed.disabled = true;
    await markPlaced(coll.get(placed.dataset.placed));
    return album();
  }
  const albumAct = e.target.closest('[data-album-act]');
  if (albumAct) {
    const what = albumAct.dataset.albumAct;
    const cur = albums.find(a => a.id === currentAlbum) ?? albums[0];
    const i = cur.sets.indexOf(albumAct.dataset.set);
    const move = (from, to) => cur.sets.splice(to, 0, cur.sets.splice(from, 1)[0]);
    if (what === 'pick') currentAlbum = albumAct.dataset.albumId;
    if (what === 'more') todoLimit = Infinity;
    if (what === 'up' && i > 0) move(i, i - 1);
    if (what === 'down' && i < cur.sets.length - 1) move(i, i + 1);
    if (what === 'remove') cur.sets.splice(i, 1);
    if (what === 'add' && $('#albumAdd').value) {
      cur.sets.push($('#albumAdd').value);
      albumSet = $('#albumAdd').value;
    }
    if (what === 'new') {
      const created = { id: 'a' + Date.now(), name: `Album ${albums.length + 1}`, ...DEFAULT_ALBUM, sets: [] };
      albums.push(created);
      currentAlbum = created.id;
    }
    if (what === 'delete') {
      if (!confirm(`Eliminare ${cur.name}? I suoi set torneranno "senza album"; le carte restano nella collezione.`)) return;
      albums.splice(albums.indexOf(cur), 1);
      currentAlbum = albums[0].id;
    }
    if (what === 'allPlaced') {
      if (!confirm('Segnare tutte le carte come già sistemate al loro posto?')) return;
      albumAct.disabled = true;
      for (const { rec } of await toPlace()) await markPlaced(rec);
    }
    if (['up', 'down', 'remove', 'add', 'new', 'delete'].includes(what)) await persistAlbums();
    return album();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const msg = $('#msg');
  if (act === 'prices') await refreshPrices(msg);
  if (act === 'scan') openScanner();
  if (act === 'shareDoubles') shareDoubles();
  if (act === 'addGoal') {
    const kind = $('#goalKind').value, target = Math.round(+$('#goalTarget').value);
    if (kind === 'set' && $('#goalSet').value) goals.push({ id: Date.now(), kind, setId: $('#goalSet').value });
    else if (kind !== 'set' && target > 0) goals.push({ id: Date.now(), kind, target });
    else return toast('Indica un numero per l\'obiettivo.');
    await saveGoals();
    return stats();
  }
  if (act === 'pack') openPackDialog();
  if (act === 'drive') {
    if (!native.shareBackup) msg.textContent = 'Aggiorna l\'app alla versione 1.4 (Altro → Controlla aggiornamenti) per inviare il backup a Drive.';
    else if (native.shareBackup(backupJson())) backupDone();
    else msg.textContent = 'Invio non riuscito.';
  }
  if (act === 'csv') exportCsv(msg);
  if (act === 'offline') downloadSets([$('#offSet').value], $('#offPrices').checked);
  if (act === 'offlineMine') {
    const mine = [...ownedBySet().keys()];
    if (!mine.length) return toast('Non hai ancora carte: scegli un set dal menu.');
    downloadSets(mine, $('#offPrices').checked);
  }
  if (act === 'flip') openFlip(albumSet);
  if (act === 'shareWish') shareWishlist();
  if (act === 'shopping' && curSet) shareMissing(curSet.id);
  if (act === 'cost') {
    const btn = e.target.closest('[data-act]');
    btn.remove();
    await completionCost(btn.dataset.set, view.querySelector(`[data-cost="${CSS.escape(btn.dataset.set)}"]`));
  }
  if (act === 'update') {
    const button = e.target.closest('[data-act]');
    button.removeAttribute('data-act');   // un solo download anche con più tocchi
    setTimeout(() => button.setAttribute('data-act', 'update'), 10000);
    native.installUpdate(apkUpdate.url);
    button.textContent = 'Download in corso: al termine si apre l\'installazione. '
      + 'Se Android chiede il permesso di installare app, attivalo e tocca di nuovo qui.';
  }
  if (act === 'checkUpdate') {
    msg.textContent = 'Controllo in corso…';
    await checkApkUpdate();
    msg.innerHTML = apkUpdate ? updateBanner() : 'Hai già l\'ultima versione.';
  }
  if (act === 'share') await shareBackup(msg);
  if (act === 'export') exportBackup(msg);
  if (act === 'import') $('#file').click();
  if (act === 'cache') {
    if (offlineSets.length && !confirm('Svuotando la cache perdi anche i set scaricati per la modalità fiera. Continuare?')) return;
    await db.clear('cache');
    curSet = null;
    offlineSets = [];
    await db.put('settings', { key: 'offlineSets', value: offlineSets });
    await more();
    $('#msg').textContent = 'Cache svuotata: il catalogo verrà riscaricato.';
  }
});

view.addEventListener('input', e => {
  if (e.target.id === 'hq') {
    homeQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHome, 300);
    return;
  }
  if (e.target.id !== 'q') return;
  setQuery = e.target.value;
  renderGrid();
});

view.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'file' && t.files[0]) importBackup(t.files[0], $('#msg'));
  if (t.id === 'albumSet') { albumSet = t.value; album(); }
  if (t.id === 'goalKind') {   // per "completa un set" si sceglie il set, per gli altri si scrive un numero
    $('#goalSet').hidden = t.value !== 'set';
    $('#goalTarget').hidden = t.value === 'set';
  }
  if (t.dataset.album) {
    const cur = albums.find(a => a.id === currentAlbum) ?? albums[0], key = t.dataset.album;
    if (t.type === 'checkbox') cur[key] = t.checked;
    else if (key === 'name') cur.name = t.value.trim() || cur.name;
    else if (+t.value > 0) cur[key] = Math.round(+t.value);
    persistAlbums().then(album);
  }
  if (t.dataset.setting && +t.value >= 0) { meta.set(t.dataset.setting, +t.value); album(); }
});

// Loghi dei set non caricati: si riprova qualche volta, poi si nasconde l'icona di immagine rotta.
// (Le immagini delle carte hanno la loro coda, imageQueue.)
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || img.dataset.src !== undefined) return;
  const tries = +(img.dataset.tries ?? 0);
  if (tries < 3) {
    img.dataset.tries = tries + 1;
    setTimeout(() => { if (img.isConnected) img.src = img.src; }, 1500 * (tries + 1));
  } else {
    img.style.visibility = 'hidden';
  }
}, true);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route() {
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = page === 'set' ? 'home' : page || 'home';
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === tab);
  try {
    if (page === 'set') await setView(decodeURIComponent(arg));
    else if (page === 'stats') await stats();
    else if (page === 'wish') wish();
    else if (page === 'album') await album();
    else if (page === 'search') advancedSearch();
    else if (page === 'more') await more();
    else await home();
  } catch (err) {
    view.innerHTML = failed(err);
  }
}

// Ogni pagina ricorda dov'era lo scorrimento: tornando indietro da un set si ritrova il punto di prima.
const scrollPos = new Map();
addEventListener('hashchange', async e => {
  scrollPos.set(new URL(e.oldURL).hash, scrollY);
  await route();
  scrollTo(0, scrollPos.get(location.hash) ?? 0);
});

// Apertura e chiusura delle serie ("toggle" non risale la pagina, quindi si ascolta in cattura).
view.addEventListener('toggle', e => {
  const id = e.target.dataset?.serie;
  if (!id) return;
  if (e.target.open) openSeries.add(id);
  else openSeries.delete(id);
}, true);

// Nuova versione pubblicata (version.txt diverso da quella caricata): si ricarica l'app, così la
// modifica arriva anche se l'app era rimasta aperta in secondo piano. Mai con una scheda o la
// fotocamera aperte, e una sola volta per versione (se qualcosa va storto non si entra in un ciclo).
async function checkWebUpdate() {
  if (APP_VERSION === 'dev') return;
  try {
    const latest = (await (await fetch('version.txt', { cache: 'no-store' })).text()).trim();
    if (!latest || latest === APP_VERSION || sheet.open || scanner.open) return;
    if (sessionStorage.getItem('reloadedFor') === latest) return;
    sessionStorage.setItem('reloadedFor', latest);
    location.reload();
  } catch { /* offline: si riprova al prossimo ritorno */ }
}

// Se l'app resta in secondo piano più di qualche minuto, al ritorno riparte da capo come appena
// aperta: schermata iniziale, serie chiuse, ricerca vuota. Le uscite brevi (fotocamera, scelta
// di un file, un messaggio) invece non toccano nulla.
const RESET_AFTER = 5 * 60 * 1000;
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  checkWebUpdate();
  if (!hiddenAt || Date.now() - hiddenAt < RESET_AFTER) return;
  openSeries.clear();
  scrollPos.clear();
  homeQuery = '';
  if (sheet.open) {
    sheet.close();
    afterClose();
  }
  if (location.hash === '#/') route();
  else location.hash = '#/';
  scrollTo(0, 0);
});

// All'avvio si parte sempre dalla schermata iniziale, anche se l'app era rimasta su un set.
history.replaceState(null, '', location.pathname + location.search + '#/');

for (const rec of await db.all('cards')) coll.set(rec.cardId, rec);
albums = await loadAlbums();
valueLog = (await db.get('settings', 'valueLog'))?.value ?? [];
deals = (await db.get('settings', 'deals'))?.value ?? [];
packs = (await db.get('settings', 'packs'))?.value ?? [];
goals = (await db.get('settings', 'goals'))?.value ?? [];
offlineSets = (await db.get('settings', 'offlineSets'))?.value ?? [];
earnedBadges = (await db.get('settings', 'badges'))?.value ?? null;
openPack = (await db.get('settings', 'openPack'))?.value ?? null;
renderPackbar();
if (coll.size) recordValue();
if (coll.size && Date.now() - meta.get('pricesAt') > PRICE_REFRESH_EVERY) {
  refreshPrices({ textContent: '' }).then(() => { if (location.hash === '#/stats') stats(); });
}
navigator.storage?.persist?.();
// updateViaCache "none": il telefono controlla sempre sul server se il service worker è cambiato.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
route();
checkApkUpdate();
checkWebUpdate();
checkPriceAlerts();
