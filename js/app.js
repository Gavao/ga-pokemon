import { db } from './db.js';
import { getCatalog, getSet, getCard, searchCards, getSetVariants, filterCards, rarityCards } from './api.js';
import { RARITY_GROUPS, RARITY_DEFS, RARITY_WHERE, raritySymbol, rarityLook } from './rarity.js';
import { DEFAULT_ALBUM, loadAlbums, saveAlbums, albumLayout, spot, columns } from './albums.js';
import { POKEDEX, GENERATIONS } from './pokedex.js';
import { bars, lines, hbars } from './charts.js';
import { LOGOS } from './logos.js';
import { IMAGES } from './images.js';
import { APP_VERSION } from './version.js';
import { captureFromVideo, canvasFromFile, readCard, findCards, parseNumber, sharpness } from './scan.js';

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
  if (!qty(rec) && freeAlbumOf(rec.cardId)) await removeFromFree(rec.cardId);   // venduta o tolta: libera la tasca
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
const loading = '<div class="loader"><span class="pokeball"></span><p>Caricamento…</p></div>';
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
  view.innerHTML = `<header class="top"><span class="spacer"></span></header>
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

  view.innerHTML = `<header class="top"><h1>Collezione</h1><a class="chip" href="#/statistics">Statistiche</a></header>
    <div class="kpis">
      <div><b>${eur(value)}</b><small>Valore stimato</small></div>
      <div><b>${recs.length}</b><small>Carte diverse</small></div>
      <div><b>${copies}</b><small>Copie totali</small></div>
      <a href="#/doubles"><b>${doublesCount()}</b><small>Doppioni ›</small></a>
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
// Regole di conservazione e scatole, nel database e nel backup:
//  - auto: se spento l'app non assegna nulla da sola, propone e tu confermi;
//  - soglie in euro e rarità che vanno sempre in bustina o nel toploader;
//  - scatole con nome: ognuna contiene certi set, i doppioni, oppure "tutto il resto".
const DEFAULT_STORAGE = {
  auto: true, tl: 10, sl: 1,
  tlRarities: RARITY_ORDER.slice(RARITY_ORDER.indexOf('Rara illustrazione speciale')),
  slRarities: RARITY_ORDER.slice(RARITY_ORDER.indexOf('Rara illustrazione'), RARITY_ORDER.indexOf('Rara illustrazione speciale')),
  boxes: [],
};
let storage = structuredClone(DEFAULT_STORAGE);
const protection = { get toploader() { return storage.tl; }, get sleeve() { return storage.sl; } };

async function saveStorage() {
  meta.set('dirty', meta.get('dirty') + 1);
  invalidateLayouts();
  await db.put('settings', { key: 'storage', value: storage });
  autoBackup();
}

/** Protezione per una copia: in base al suo valore e alla rarità della carta. */
function unitTier(rec, variant) {
  const value = unitPrice(rec, variant);
  if (value >= storage.tl || storage.tlRarities.includes(rec.rarity)) return 'toploader';
  if (value >= storage.sl || storage.slRarities.includes(rec.rarity)) return 'sleeve';
  return 'album';
}

// Protezione della carta nel suo insieme (la copia più importante): per riepiloghi e tasche.
function protectionOf(rec) {
  const tiers = rec.copies.filter(c => c.qty > 0).map(c => unitTier(rec, c.variant));
  return tiers.includes('toploader') ? 'toploader' : tiers.includes('sleeve') ? 'sleeve' : 'album';
}

// "Dove la tengo" scelto su una copia: 'album:<id>', 'box:<id>', 'toploader', 'slab'; vuoto = automatico.
const WHERE_LABELS = { toploader: 'Toploader', slab: 'Gradata (slab)' };
function whereOptions(rec) {
  return [['', 'Automatico'],
    ...albums.filter(a => !a.closed || a.sets?.includes(rec.setId) || a.cards?.some(e => e?.cardId === rec.cardId))
      .map(a => [`album:${a.id}`, `Album: ${a.name}`]),
    ...storage.boxes.map(b => [`box:${b.id}`, `Scatola: ${b.name}`]),
    ['toploader', 'Toploader'], ['slab', 'Gradata (slab)']];
}

/** Scatola per una carta che non va in album: quella del suo set, poi quella dei doppioni, poi "tutto il resto". */
function boxFor(rec, isDouble) {
  const bySet = storage.boxes.find(b => b.sets?.includes(rec.setId));
  const doubles = storage.boxes.find(b => b.doubles);
  const rest = storage.boxes.find(b => b.rest);
  return (isDouble ? doubles ?? bySet : bySet) ?? rest ?? null;
}

// Album fisici (calcolo delle posizioni in js/albums.js). Gli album stanno nel database e nel backup.
let albums = [];                 // caricati all'avvio
let currentAlbum = '', albumSet = '', todoLimit = 30;
const layoutCache = new Map();   // album.id -> disposizione; si svuota a ogni modifica di carte o album

const invalidateLayouts = () => { layoutCache.clear(); dexCache = null; };
const setAlbums = () => albums.filter(a => !a.kind || a.kind === 'sets');

// ---- Album liberi: le carte le metti tu ("Metti in…"). Ogni carta nuova va nella prima tasca vuota,
// così con le pagine fisse nessuna si sposta; togliendone una il suo posto resta libero.
const freeAlbums = () => albums.filter(a => a.kind === 'free');
const freeAlbumOf = cardId => freeAlbums().find(a => a.cards?.some(e => e?.cardId === cardId));

async function putInFree(album, rec) {
  const from = freeAlbumOf(rec.cardId);
  if (from === album) return;
  if (from) from.cards[from.cards.findIndex(e => e?.cardId === rec.cardId)] = null;
  const entry = { cardId: rec.cardId, name: rec.name, localId: rec.localId, image: rec.image, setId: rec.setId };
  album.cards ??= [];
  const hole = album.cards.indexOf(null);
  if (hole >= 0) album.cards[hole] = entry;
  else album.cards.push(entry);
  await persistAlbums();
}

async function removeFromFree(cardId) {
  const album = freeAlbumOf(cardId);
  if (!album) return;
  album.cards[album.cards.findIndex(e => e?.cardId === cardId)] = null;
  // Le tasche vuote in fondo non servono a tenere fermo nulla: si tolgono.
  while (album.cards.length && album.cards.at(-1) === null) album.cards.pop();
  await persistAlbums();
}

// ---- Album Pokédex: un posto per ogni Pokémon. In ogni posto va la carta scelta da te ("Usa per il
// Pokédex") o, se non hai scelto, la tua carta più pregiata di quel Pokémon.
let dexCache = null;   // { albumId, choice: Map(numero -> rec), byCard: Map(cardId -> numero) }
const dexAlbum = () => albums.find(a => a.kind === 'dex');

function dexChoices(album) {
  if (dexCache?.albumId === album.id) return dexCache;
  const byDex = new Map();
  for (const r of coll.values()) {
    if (!qty(r) || r.category === 'Allenatore' || r.category === 'Energia') continue;
    if (qty(r) < 2 && freeAlbumOf(r.cardId)) continue;   // unica copia già in un album libero
    for (const n of r.dexId ?? []) {
      if (n < album.from || n > album.to) continue;
      if (!byDex.has(n)) byDex.set(n, []);
      byDex.get(n).push(r);
    }
  }
  const best = r => Math.max(...r.copies.map(c => unitPrice(r, c.variant)));
  const choice = new Map(), byCard = new Map();
  for (const [n, recs] of [...byDex].sort((a, b) => a[0] - b[0])) {
    // Una carta fisica sta in un posto solo: le carte già usate per un altro numero si saltano.
    const free = recs.filter(r => !byCard.has(r.cardId));
    if (!free.length) continue;
    const picked = free.find(r => r.cardId === album.picks?.[n]);
    const rec = picked ?? free.sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || best(b) - best(a))[0];
    choice.set(n, rec);
    byCard.set(rec.cardId, n);
  }
  dexCache = { albumId: album.id, choice, byCard };
  return dexCache;
}

const dexLabel = n => `#${String(n).padStart(3, '0')} ${POKEDEX[n] ?? ''}`;

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
  // Serve sempre almeno un album per i set (può restare solo quello Pokédex dopo un'eliminazione).
  if (!setAlbums().length) albums.unshift({ id: 'a' + Date.now(), name: 'Album 1', ...DEFAULT_ALBUM, sets: [] });
  const first = setAlbums()[0];
  if (first.sets !== null) return;
  let order = [];
  try { order = (await getCatalog()).flatMap(s => s.sets.map(x => x.id)); } catch { /* offline */ }
  first.sets = [...ownedBySet().keys()].sort((a, b) => order.indexOf(b) - order.indexOf(a));
  await persistAlbums();
}

// Prima carta di un set nuovo: il set va in fondo al primo album dove c'è ancora spazio (in fondo,
// così le carte già sistemate non si spostano). Se non entra da nessuna parte va nell'ultimo
// album, che lo segnalerà come "serve più spazio".
async function fileNewSet(setId) {
  await ensureAlbumInit();
  if (setAlbums().some(a => a.sets.includes(setId))) return;
  const open = setAlbums().filter(a => !a.closed);   // gli album chiusi non ricevono set nuovi
  for (const a of open) {
    if (!(await albumLayout({ ...a, sets: [...a.sets, setId] }, ownsVariant)).overflow) {
      a.sets.push(setId);
      return persistAlbums();
    }
  }
  (open.at(-1) ?? setAlbums().at(-1)).sets.push(setId);
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
/**
 * Dove va fisicamente ogni copia di una carta: un elemento per copia, con
 * kind 'slot' (tasca di un album), 'toploader', 'slab', 'box' (scatola), 'none' (nessun posto adatto)
 * o 'suggest' (automatico spento: solo una proposta, in "where", da confermare).
 * Prima valgono le scelte fatte sulla copia ("Dove la tengo"), poi le regole, a partire dalla copia
 * più bella: toploader, album libero, Pokédex, album del set; tutto il resto va in scatola.
 * key identifica il posto: se cambia (album riordinato, nuova copia migliore…) la copia torna da sistemare.
 */
async function placementsOf(rec) {
  if (!qty(rec)) return [];
  await ensureAlbumInit();
  const units = rec.copies.flatMap((c, ci) => Array.from({ length: c.qty }, () => ({ c, ci, v: c.variant })));
  const manual = units.filter(u => u.c.where), auto = units.filter(u => !u.c.where)
    .sort((a, b) => unitPrice(rec, b.v) - unitPrice(rec, a.v) || (BEAUTY[b.v] ?? 0) - (BEAUTY[a.v] ?? 0));
  const used = new Set();   // posti già occupati da un'altra copia di questa carta
  const count = { tl: 0, slab: 0, box: 0 };
  const sleeveNote = u => (u.c.sleeve || unitTier(rec, u.v) === 'sleeve' ? ' · in bustina' : '');
  const variantNote = u => (new Set(units.map(x => x.v)).size > 1 ? ` · la ${VARIANTS[u.v] ?? u.v}` : '');

  const toploader = () => ({ kind: 'toploader', key: count.tl++ ? `tl:${count.tl - 1}` : 'tl', text: 'Nel toploader, fuori dall\'album' });
  const slab = () => ({ kind: 'slab', key: `slab:${count.slab++}`, text: 'Gradata (slab), fuori dall\'album' });
  const box = (b, u) => (b
    ? { kind: 'box', box: b, key: `box:${b.id}:${u.v}:${count.box++}`, text: `Scatola ${b.name} · ${setNames.get(rec.setId) ?? rec.setId}, n° ${rec.localId}${variantNote(u)}` }
    : { kind: 'box', key: '', text: 'In scatola (nessuna scatola adatta: creane una in Album → Scatole)' });

  // Tasca in un album per questa copia, se c'è e non è già presa da un'altra copia.
  async function slotIn(album, u) {
    if (album.kind === 'free') {
      const slot = album.cards?.findIndex(e => e?.cardId === rec.cardId) ?? -1;
      if (slot < 0 || used.has(`${album.id}:${slot}`)) return null;
      used.add(`${album.id}:${slot}`);
      return { kind: 'slot', key: `${album.id}:${slot}:free`, album, slot, text: placeText(album, slot) + sleeveNote(u) };
    }
    if (album.kind === 'dex') {
      const n = dexChoices(album).byCard.get(rec.cardId);
      if (!n || used.has(`${album.id}:${n}`) || !(await layoutFor(album)).rows[0].fits) return null;
      used.add(`${album.id}:${n}`);
      const slot = n - album.from;
      return { kind: 'slot', key: `${album.id}:${slot}:dex`, album, slot, text: `${placeText(album, slot)} · ${dexLabel(n)}${sleeveNote(u)}` };
    }
    const row = album.sets?.includes(rec.setId) && (await layoutFor(album)).rows.find(r => r.setId === rec.setId);
    if (!row || row.error || !row.fits) return null;
    const i = row.slots.findIndex(s => s.card.id === rec.cardId && (!album.master || s.variant === u.v));
    if (i < 0 || used.has(`${album.id}:${row.start + i}`)) return null;
    used.add(`${album.id}:${row.start + i}`);
    const slot = row.start + i;
    return { kind: 'slot', key: `${album.id}:${slot}:${u.v}`, album, slot, text: placeText(album, slot) + variantNote(u) + sleeveNote(u) };
  }

  const out = [];
  for (const u of manual) {   // le tue scelte
    const [kind, id] = u.c.where.split(':');
    let p = null;
    if (kind === 'toploader') p = toploader();
    else if (kind === 'slab') p = slab();
    else if (kind === 'box') p = box(storage.boxes.find(b => b.id === id), u);
    else if (kind === 'album') {
      const album = albums.find(a => a.id === id);
      p = album && await slotIn(album, u);
      p ??= { kind: 'none', key: '', text: album ? `Nessun posto libero per questa copia in ${album.name}` : 'Album non più esistente' };
    }
    out.push({ ...(p ?? { kind: 'none', key: '', text: 'Posto non valido' }), unit: u, manual: true });
  }

  const setAlbum = setAlbums().find(a => a.sets?.includes(rec.setId));
  for (const u of auto) {   // le regole
    let p = null;
    if (unitTier(rec, u.v) === 'toploader') p = toploader();
    else {
      const free = freeAlbumOf(rec.cardId), dex = dexAlbum();
      for (const album of [free, dex, setAlbum].filter(Boolean)) {
        if ((p = await slotIn(album, u))) break;
      }
      if (!p) {
        // Doppione = un'altra copia della stessa versione già sistemata; le altre versioni fanno parte
        // della collezione e vanno nella scatola del loro set (o in "tutto il resto").
        const isDouble = out.some(x => x.unit?.v === u.v);
        if (!isDouble && !setAlbum) p = { ...box(boxFor(rec, false), u), note: 'Il suo set non è in nessun album' };
        else p = box(boxFor(rec, isDouble), u);
      }
    }
    // Automatico spento: è solo una proposta, da confermare.
    if (!storage.auto) {
      const where = p.kind === 'slot' ? `album:${p.album.id}` : p.kind === 'toploader' ? 'toploader' : p.box ? `box:${p.box.id}` : '';
      p = { kind: 'suggest', key: '', where, text: `Proposta: ${p.text}`, album: p.album };
    }
    out.push({ ...p, unit: u });
  }
  return out;
}

/** Le copie con lo stesso posto si mostrano una volta sola, con il numero di copie. */
function groupPlaces(places) {
  const groups = [];
  for (const p of places) {
    const g = groups.find(x => x.text === p.text);
    if (g) g.n++;
    else groups.push({ ...p, n: 1 });
  }
  return groups.map(g => ({ ...g, label: g.n > 1 ? `${g.text} (×${g.n})` : g.text }));
}

const isPlaced = (rec, p) => (rec.placed ?? []).includes(p.key);

// Ultimi posti calcolati per ogni carta: servono alle tasche degli album, che si disegnano subito.
const placementCache = new Map();

/**
 * Copie che hanno un posto (tasca, toploader, scatola, slab) dove non risultano ancora sistemate, più
 * le proposte da confermare quando l'automatico è spento. Copie con lo stesso posto = una riga.
 */
async function toPlace() {
  const items = [];
  placementCache.clear();
  for (const rec of coll.values()) {
    const places = await placementsOf(rec);
    placementCache.set(rec.cardId, places);
    for (const p of groupPlaces(places)) {
      if (p.kind === 'suggest' || (p.key && !isPlaced(rec, p))) items.push({ rec, p });
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
  const groups = groupPlaces(await placementsOf(rec));
  if (groups.length) {
    toast(`<b>${esc(rec.name)}</b><br>Dove va: ${groups.slice(0, 2).map(g => esc(g.label)).join('<br>')}
      <button class="chip" data-toast-card="${esc(rec.cardId)}">Cambia</button>`);
  }
}

// "Cambia" nell'avviso: apre la scheda della carta, dove si sceglie un altro posto.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-toast-card]');
  if (!b) return;
  $('#toast')?.classList.remove('on');
  openCard(b.dataset.toastCard);
});

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

  // Album Pokédex: serve il numero di Pokédex di ogni carta, che sta nel suo dettaglio.
  if (dexAlbum()) {
    await fillDetails(recs);
    invalidateLayouts();
  }
  const layout = await layoutFor(cur);
  if (cur.kind === 'dex' || cur.kind === 'free') albumSet = cur.kind;
  else if (!cur.sets.includes(albumSet)) albumSet = cur.sets[0] ?? '';
  const inAlbum = new Set(albums.flatMap(a => a.sets ?? []));
  const addable = order.filter(id => !inAlbum.has(id));
  const homeless = [...owned.keys()].filter(id => !inAlbum.has(id));
  // Da sistemare: ogni album mostra solo le sue carte; i toploader hanno una lista a parte.
  const todoAll = await toPlace();
  const suggested = todoAll.filter(t => t.p.kind === 'suggest');
  const placeable = todoAll.filter(t => t.p.kind !== 'suggest');
  const todo = placeable.filter(t => t.p.album?.id === cur.id);
  const todoTl = placeable.filter(t => t.p.kind === 'toploader' || t.p.kind === 'slab');
  const todoBoxes = storage.boxes.map(b => [b, placeable.filter(t => t.p.box?.id === b.id)]).filter(([, l]) => l.length);
  const pendingIn = a => placeable.filter(t => t.p.album?.id === a.id).length;
  const todoRows = (list, action = 'placed', label = 'Fatto') => `<div class="todo">${list.slice(0, todoLimit).map(({ rec, p }) => `<div class="todo-row">
        <div class="thumb" data-card="${esc(rec.cardId)}">${cardImg(rec.cardId, rec.image, 'low')}</div>
        <span class="info"><b>${esc(rec.name)}</b><small>${esc(setName(rec.setId))} · N° ${esc(rec.localId)}</small>
          <small class="place">${esc(p.label ?? p.text)}</small></span>
        <button class="chip" data-${action}="${esc(rec.cardId)}">${label}</button>
      </div>`).join('')}</div>
      ${list.length > todoLimit ? `<div class="settings"><button class="chip" data-album-act="more">Mostra tutte (${list.length})</button></div>` : ''}`;

  const tiers = { toploader: [], sleeve: [], album: [] };
  for (const r of recs) tiers[protectionOf(r)].push(r);
  const copiesOf = list => list.reduce((a, r) => a + qty(r), 0);
  const toComplete = [...owned.keys()].map(id => {
    const tot = names.get(id)?.cardCount.total ?? 0;
    return { id, n: owned.get(id), tot, pct: tot ? owned.get(id) / tot : 0 };
  }).sort((a, b) => b.pct - a.pct);

  view.innerHTML = `<header class="top"><h1>Album</h1></header>
    <div class="chips albums">
      ${albums.map(a => `<button class="chip ${a.id === cur.id ? 'on' : ''}" data-album-act="pick" data-album-id="${esc(a.id)}">${esc(a.name)}${a.closed ? ' (chiuso)' : ''}${pendingIn(a) ? ` · ${pendingIn(a)}` : ''}</button>`).join('')}
      <button class="chip" data-album-act="new">+ Album dei set</button>
      <button class="chip" data-album-act="newFree">+ Album libero</button>
      ${dexAlbum() ? '' : '<button class="chip" data-album-act="newDex">+ Album Pokédex</button>'}
    </div>

    <h2>Da sistemare in ${esc(cur.name)} ${todo.length ? `<span class="count">${todo.length}</span>` : ''}</h2>
    ${todo.length ? `<p class="note">Carte aggiunte che non hai ancora messo al loro posto: sistemale e tocca Fatto.</p>
      ${todoRows(todo)}
      <div class="settings"><button class="chip" data-album-act="allPlaced">Segna tutte come sistemate</button></div>`
      : `<p class="note">In ${esc(cur.name)} è tutto al suo posto.</p>`}
    ${todoTl.length ? `<h2>Da mettere nel toploader <span class="count">${todoTl.length}</span></h2>${todoRows(todoTl)}` : ''}
    ${todoBoxes.map(([b, list]) => `<h2>Da mettere in ${esc(b.name)} <span class="count">${list.length}</span></h2>${todoRows(list)}`).join('')}
    ${suggested.length ? `<h2>Da decidere <span class="count">${suggested.length}</span></h2>
      <p class="note">L'automatico è spento: per queste copie ti propongo un posto. Conferma, oppure apri la carta
        e scegli tu "Dove la tengo".</p>${todoRows(suggested, 'confirm', 'Conferma')}` : ''}
    ${homeless.length ? `<p class="note warnline">Set di cui hai carte ma che non sono in nessun album:
      ${homeless.map(id => esc(setName(id))).join(', ')}. Aggiungili a un album qui sotto.</p>` : ''}

    <div class="album-head">
      <h2>${esc(cur.name)} <small>${cur.kind === 'dex' ? 'Pokédex' : cur.kind === 'free' ? 'album libero' : 'album dei set'}${cur.closed ? ' · chiuso' : ''}</small></h2>
      <button class="icon" data-album-act="rename" aria-label="Rinomina">✎</button>
      <button class="icon" data-album-act="left" ${albums.indexOf(cur) ? '' : 'disabled'} aria-label="Sposta prima">‹</button>
      <button class="icon" data-album-act="right" ${albums.indexOf(cur) < albums.length - 1 ? '' : 'disabled'} aria-label="Sposta dopo">›</button>
    </div>
    ${cur.kind === 'dex' ? dexSettings(cur, layout) : cur.kind === 'free' ? freeSettings(cur, layout) : `<div class="settings">
      <label>Tasche totali <input type="number" min="4" step="1" data-album="capacity" value="${cur.capacity}"></label>
      <select data-album="perSide">${options([[4, '4 per facciata (2×2)'], [9, '9 per facciata (3×3)'], [12, '12 per facciata (3×4)']], cur.perSide)}</select>
      <label><input type="checkbox" data-album="newSide" ${cur.newSide ? 'checked' : ''}> Ogni set su una facciata nuova</label>
      <label><input type="checkbox" data-album="gaps" ${cur.gaps ? 'checked' : ''}> Lascia i posti per le mancanti</label>
      <label><input type="checkbox" data-album="master" ${cur.master ? 'checked' : ''}> Master set: un posto per ogni variante</label>
      <label><input type="checkbox" data-album="closed" ${cur.closed ? 'checked' : ''}> Chiuso: non riceve set nuovi</label>
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
    </div>`}

    ${cur.kind === 'dex' || cur.kind === 'free' || cur.sets.length ? `<h2>Pagine</h2>
    <p class="note">Come le vedi aprendo l'album: a sinistra il retro di un foglio, a destra il fronte del
      successivo. I posti vuoti sono le carte che ti mancano; quelli tratteggiati in giallo le carte ancora
      da sistemare; TL le carte nel toploader (lascia il posto libero o un segnaposto).</p>
    <div class="settings">${cur.kind === 'dex' || cur.kind === 'free' ? '' : `<select id="albumSet">${options(cur.sets.map(id => [id, setName(id)]), albumSet)}</select>`}
      <button class="chip on" data-act="flip">Sfoglia l'album</button></div>
    <div id="albumPages"></div>` : ''}

    <h2>Protezione consigliata</h2>
    <p class="note">In base al valore della copia migliore e alla rarità. Il toploader (custodia rigida) va
      sempre usato con la bustina dentro.</p>
    ${group(`Toploader + bustina`, tiers.toploader, ` · ${copiesOf(tiers.toploader)} toploader`)}
    ${group('Bustina (sleeve) nell\'album', tiers.sleeve, ` · ${plural(copiesOf(tiers.sleeve), 'bustina', 'bustine')}`)}
    ${group('Album, senza bustina', tiers.album)}

    <h2>Regole</h2>
    <div class="settings">
      <label><input type="checkbox" data-storage="auto" ${storage.auto ? 'checked' : ''}> Assegna i posti in automatico</label>
      <label>Toploader da <input type="number" min="0" step="1" data-storage="tl" value="${storage.tl}"> €</label>
      <label>Bustina da <input type="number" min="0" step="0.5" data-storage="sl" value="${storage.sl}"> €</label>
    </div>
    <p class="note">${storage.auto ? 'Le copie senza una tua scelta vanno dove dicono le regole.'
      : 'Automatico spento: per ogni copia ti propongo un posto e tu confermi (lista "Da decidere").'}
      Una scelta fatta su una copia ("Dove la tengo" nella scheda della carta) vale sempre più delle regole.</p>
    <details class="group"><summary><span>Rarità che vanno sempre nel toploader</span><small>${storage.tlRarities.length}</small></summary>
      <div class="rarities">${RARITY_ORDER.map(r => `<label><input type="checkbox" data-rarity="tl" value="${esc(r)}" ${storage.tlRarities.includes(r) ? 'checked' : ''}> ${esc(rarityLabel(r))}</label>`).join('')}</div></details>
    <details class="group"><summary><span>Rarità che vanno sempre in bustina</span><small>${storage.slRarities.length}</small></summary>
      <div class="rarities">${RARITY_ORDER.map(r => `<label><input type="checkbox" data-rarity="sl" value="${esc(r)}" ${storage.slRarities.includes(r) ? 'checked' : ''}> ${esc(rarityLabel(r))}</label>`).join('')}</div></details>

    <h2>Scatole</h2>
    ${storage.boxes.map(b => `<div class="box-row">
      <div class="box-head"><b>${esc(b.name)}</b>
        <button class="icon" data-box-act="rename" data-box="${esc(b.id)}" aria-label="Rinomina">✎</button>
        <button class="icon" data-box-act="delete" data-box="${esc(b.id)}" aria-label="Elimina">✕</button></div>
      <div class="settings">
        <label><input type="checkbox" data-box-flag="doubles" data-box="${esc(b.id)}" ${b.doubles ? 'checked' : ''}> Doppioni</label>
        <label><input type="checkbox" data-box-flag="rest" data-box="${esc(b.id)}" ${b.rest ? 'checked' : ''}> Tutto il resto</label>
      </div>
      <div class="chips">${(b.sets ?? []).map(id => `<button class="chip" data-box-act="unset" data-box="${esc(b.id)}" data-set="${esc(id)}">${esc(setName(id))} ✕</button>`).join('')}</div>
      <div class="settings"><select data-box-add="${esc(b.id)}"><option value="">Aggiungi un set…</option>${options(order.filter(id => !storage.boxes.some(x => x.sets?.includes(id))).map(id => [id, setName(id)]))}</select></div>
    </div>`).join('') || '<p class="note">Nessuna scatola. Le carte fuori dagli album (doppioni, set che non metti in album) vanno in scatola: creane una e scegli cosa contiene.</p>'}
    <div class="settings"><button class="chip" data-box-act="new">+ Nuova scatola</button></div>

    <h2>Set da completare</h2>
    ${toComplete.slice(0, 3).map(s => `<a class="setrow" href="#/set/${encodeURIComponent(s.id)}">
      <span class="logo">${names.has(s.id) ? setLogo(names.get(s.id)) : ''}</span>
      <span class="info"><b>${esc(setName(s.id))}</b>${bar(s.n, s.tot)}
        <small>${s.tot - s.n === 1 ? 'manca 1 carta' : `mancano ${s.tot - s.n} carte`}</small></span>
    </a>`).join('')}
    <div class="settings"><a class="chip on" href="#/complete">Consigli: costi, facilità e classifiche</a></div>

    <h2>Doppioni</h2>
    ${doublesCount() ? `<p class="note">${plural(doublesCount(), 'doppione', 'doppioni')}: copie in più della stessa versione.</p>
      <div class="settings"><a class="chip on" href="#/doubles">Gestisci i doppioni</a>
        <button class="chip" data-act="shareDoubles">Condividi la lista</button></div>`
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
  for (const s of row.slots) if (s.card) briefs.set(s.card.id, { ...s.card, setId: row.setId });

  const sides = new Map();   // numero facciata -> posti
  row.slots.forEach((s, i) => {
    const slot = row.start + i, side = Math.floor(slot / album.perSide) + 1;
    if (!sides.has(side)) sides.set(side, Array(album.perSide).fill(null));
    sides.get(side)[slot % album.perSide] = { ...s, slot };
  });
  // Facciata 1 da sola a destra; poi coppie (2,3), (4,5)…: retro di un foglio e fronte del successivo.
  const spreads = [...new Set([...sides.keys()].map(side => Math.floor(side / 2)))];
  const cols = columns(album.perSide);

  const pocket = s => albumPocket(album, s, album.kind === 'free' ? 'libera' : 'altro set');
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
  if (s.dex !== undefined) return dexPocket(album, s);
  const rec = coll.get(s.card.id);
  const tag = VARIANT_TAG[s.variant] ? `<i class="vtag">${VARIANT_TAG[s.variant]}</i>` : '';
  if (!ownsVariant(s.card.id, s.variant)) {
    return `<div class="pocket empty" data-card="${esc(s.card.id)}"><b>${esc(s.card.localId)}</b><span>${esc(s.card.name)}</span>${tag}</div>`;
  }
  // Quale copia sta in questa tasca, secondo il calcolo dei posti (placementsOf, fatto da toPlace).
  const places = placementCache.get(rec.cardId) ?? [];
  const here = places.find(p => p.kind === 'slot' && p.album?.id === album.id && p.slot === s.slot);
  if (!here) {   // la carta c'è, ma nessuna copia va qui: il posto resta libero e si dice dov'è
    const w = places.find(p => !['none', 'suggest'].includes(p.kind)) ?? places[0];
    const label = !w ? '' : w.kind === 'toploader' ? 'nel toploader' : w.kind === 'slab' ? 'gradata'
      : w.kind === 'box' ? `in ${w.box?.name ?? 'scatola'}` : w.kind === 'slot' ? `in ${w.album.name}`
      : w.kind === 'suggest' ? 'da decidere' : '';
    return `<div class="pocket tl dexmark" data-card="${esc(s.card.id)}"><b>${esc(s.card.localId)}</b><span>${esc(label)}</span>
      ${w?.kind === 'toploader' ? '<i class="tag">TL</i>' : ''}</div>`;
  }
  const todo = !isPlaced(rec, here);
  return `<div class="pocket ${todo ? 'todo' : ''}" data-card="${esc(s.card.id)}">${cardImg(s.card.id, s.card.image, 'low')}
    ${tag}${here.text.includes('in bustina') ? '<i class="tag sl">B</i>' : ''}</div>`;
}

/** Impostazioni dell'album libero: capienza, tasche e quante carte ci sono. */
function freeSettings(album, layout) {
  const n = (album.cards ?? []).filter(Boolean).length, holes = (album.cards ?? []).filter(e => e === null).length;
  return `<div class="settings">
      <label>Tasche totali <input type="number" min="4" step="1" data-album="capacity" value="${album.capacity}"></label>
      <select data-album="perSide">${options([[4, '4 per facciata (2×2)'], [9, '9 per facciata (3×3)'], [12, '12 per facciata (3×4)']], album.perSide)}</select>
      <label><input type="checkbox" data-album="closed" ${album.closed ? 'checked' : ''}> Chiuso: non riceve carte nuove</label>
    </div>
    <p class="note">${plural(n, 'carta', 'carte')}${holes ? ` · ${plural(holes, 'tasca libera', 'tasche libere')} in mezzo (le riempie la prossima carta)` : ''}
      · ${plural(layout.usedSides, 'facciata', 'facciate')} su ${layout.totalSides}
      ${layout.overflow ? `· <b class="bad">pieno: ${plural(layout.overflow, 'carta', 'carte')} di troppo</b>` : ''}</p>
    ${bar(Math.min(layout.usedSides, layout.totalSides), layout.totalSides)}
    <p class="note">Qui decidi tu cosa c'è: apri una carta e tocca "Metti in ${esc(album.name)}". Ogni carta nuova
      va nella prima tasca libera, quindi quelle già sistemate non si spostano mai.</p>
    <div class="settings"><button class="chip danger" data-album-act="delete">Elimina ${esc(album.name)}</button></div>`;
}

/** Impostazioni dell'album Pokédex: nome, capienza, tasche e quali generazioni contiene. */
function dexSettings(album, layout) {
  const ranges = [[`1-${POKEDEX.length - 1}`, `Tutti (1–${POKEDEX.length - 1})`],
    ...GENERATIONS.map(([a, b], i) => [`${a}-${b}`, `${i + 1}ª generazione (${a}–${b})`]),
    ...GENERATIONS.slice(1).map(([, b], i) => [`1-${b}`, `Dalla 1ª alla ${i + 2}ª generazione (1–${b})`])];
  const have = dexChoices(album).choice.size, total = album.to - album.from + 1;
  return `<div class="settings">
      <label>Tasche totali <input type="number" min="4" step="1" data-album="capacity" value="${album.capacity}"></label>
      <select data-album="perSide">${options([[4, '4 per facciata (2×2)'], [9, '9 per facciata (3×3)'], [12, '12 per facciata (3×4)']], album.perSide)}</select>
      <select data-album="range">${options(ranges, `${album.from}-${album.to}`)}</select>
    </div>
    <p class="note">Hai ${have} Pokémon su ${total} (${Math.floor(have / total * 100)}%) ·
      ${plural(layout.usedSides, 'facciata', 'facciate')} su ${layout.totalSides}
      ${layout.overflow ? `· <b class="bad">non entra: mancano ${plural(layout.overflow, 'tasca', 'tasche')}</b>, scegli meno generazioni o più tasche` : ''}</p>
    ${bar(have, total)}
    <p class="note">Per ogni Pokémon va la tua carta più pregiata; per sceglierne un'altra apri la carta e
      tocca "Usa per il Pokédex".</p>
    <div class="settings"><button class="chip danger" data-album-act="delete">Elimina ${esc(album.name)}</button></div>`;
}

/** Tasca dell'album Pokédex: la carta scelta per quel Pokémon, oppure il posto vuoto con numero e nome. */
function dexPocket(album, s) {
  const rec = dexChoices(album).choice.get(s.dex);
  if (!rec) return `<div class="pocket empty"><b>#${String(s.dex).padStart(3, '0')}</b><span>${esc(POKEDEX[s.dex] ?? '')}</span></div>`;
  briefs.set(rec.cardId, recBrief(rec));
  if (protectionOf(rec) === 'toploader') {
    return `<div class="pocket tl" data-card="${esc(rec.cardId)}"><b>#${String(s.dex).padStart(3, '0')}</b><span>${esc(rec.name)} nel toploader</span><i class="tag">TL</i></div>`;
  }
  const todo = !(rec.placed ?? []).includes(`${album.id}:${s.slot}:dex`);
  return `<div class="pocket ${todo ? 'todo' : ''}" data-card="${esc(rec.cardId)}">${cardImg(rec.cardId, rec.image, 'low')}</div>`;
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
      if (s.card) briefs.set(s.card.id, { ...s.card, setId: row.setId });
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

// ---------------------------------------------------------------------------
// Set da completare: per ogni set di cui hai carte, cosa manca e quanto costa finirlo.
// I prezzi delle mancanti si leggono una volta (Aggiorna i calcoli) e restano in "setAnalysis";
// le carte che aggiungi dopo spariscono da sole dalle mancanti.
// setGoals: per set, se lo segui (★), cosa vuol dire completo (tutte / solo numerate) e il budget.
// ---------------------------------------------------------------------------
let setAnalysis = {}, setGoals = {}, completeSort = 'near', onlyFollowed = false, analyzing = false;
const CHEAP = 1;   // "economica": sotto 1 €

// Carta numerata: numero semplice entro il totale stampato (le segrete hanno numero più alto o un prefisso).
const isNumbered = (localId, official) => /^\d+$/.test(localId) && +localId <= official;

async function analyzeSets(ids, msg) {
  if (analyzing) return;
  analyzing = true;
  let done = 0;
  for (const id of ids) {
    try {
      const set = await getSet(id);
      const missing = set.cards.filter(c => !qty(coll.get(c.id)));
      const queue = [...missing], out = [];
      await Promise.all(Array.from({ length: 6 }, async () => {
        for (let c; (c = queue.shift());) {
          let price = null;
          try { price = cardPrice(await getCard(c.id)) || null; } catch { /* resta senza prezzo */ }
          out.push({ id: c.id, name: c.name, localId: c.localId, image: c.image, price });
        }
      }));
      setAnalysis[id] = { date: new Date().toISOString().slice(0, 10), missing: out };
      await db.put('settings', { key: 'setAnalysis', value: setAnalysis });
    } catch { /* offline: si riprova la prossima volta */ }
    if (msg) msg.textContent = `Calcolo… ${++done}/${ids.length} set`;
  }
  analyzing = false;
}

/** Numeri di un set secondo cosa vuol dire "completo" per te. */
function setReport(id, set) {
  const goal = setGoals[id] ?? {};
  const official = set.cardCount.official || set.cardCount.total;
  const numberedOnly = goal.scope === 'official';
  const total = numberedOnly ? official : set.cardCount.total;
  const owned = [...coll.values()].filter(r => r.setId === id && qty(r) && (!numberedOnly || isNumbered(r.localId, official))).length;
  const a = setAnalysis[id];
  const missing = a?.missing.filter(m => !qty(coll.get(m.id)) && (!numberedOnly || isNumbered(m.localId, official))) ?? null;
  const cost = missing?.reduce((s, m) => s + (m.price ?? 0), 0) ?? null;
  const missingN = Math.max(0, total - owned);
  const pct = total ? owned / total : 0;
  // Facilità 0–100: scende con il numero di mancanti e con quanto costano.
  const ease = missing ? Math.round(100 * Math.exp(-(missingN / 40 + cost / 50))) : null;
  // Miglior rapporto: euro da spendere per ogni 1% di completamento in più.
  const perPoint = missing && missingN ? cost / (missingN / total * 100) : null;
  const top = missing ? [...missing].filter(m => m.price).sort((x, y) => y.price - x.price).slice(0, 3) : [];
  const cheap = missing?.filter(m => m.price != null && m.price < CHEAP).length ?? null;
  // Budget: quante mancanti ci stanno, dalle più economiche.
  let inBudget = null;
  if (goal.budget && missing) {
    let left = goal.budget;
    inBudget = 0;
    for (const m of missing.filter(x => x.price).sort((x, y) => x.price - y.price)) {
      if (m.price > left) break;
      left -= m.price;
      inBudget++;
    }
  }
  return { id, set, goal, total, owned, missingN, pct, cost, ease, perPoint, top, cheap, inBudget, analyzed: !!a, date: a?.date };
}

async function completePage() {
  const names = await catalogNames();
  for (const [id, s] of names) setNames.set(id, s.name);
  const owned = ownedBySet();
  const ids = [...new Set([...owned.keys(), ...Object.keys(setGoals).filter(id => setGoals[id].follow)])].filter(id => names.has(id));
  let reports = ids.map(id => setReport(id, names.get(id))).filter(r => !onlyFollowed || r.goal.follow);
  const sorters = {
    near: (a, b) => b.pct - a.pct,
    cheap: (a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity),
    ratio: (a, b) => (a.perPoint ?? Infinity) - (b.perPoint ?? Infinity),
    easy: (a, b) => (b.ease ?? -1) - (a.ease ?? -1),
  };
  reports.sort((a, b) => (b.goal.follow ? 1 : 0) - (a.goal.follow ? 1 : 0) || sorters[completeSort](a, b));
  const missingAnalysis = ids.filter(id => !setAnalysis[id]);

  view.innerHTML = `<header class="top"><a class="back" href="#/album" aria-label="Indietro">‹</a><h1>Set da completare</h1></header>
    <div class="chips dup-chips">
      ${[['near', 'Più vicini'], ['cheap', 'Più economici'], ['ratio', 'Miglior rapporto'], ['easy', 'Più facili']]
        .map(([k, l]) => `<button class="chip ${completeSort === k ? 'on' : ''}" data-complete-sort="${k}">${l}</button>`).join('')}
      <button class="chip ${onlyFollowed ? 'on' : ''}" data-complete-followed>★ Solo quelli che seguo</button>
    </div>
    <div class="settings"><button class="chip" data-act="analyze">${missingAnalysis.length ? `Calcola i costi (${plural(missingAnalysis.length, 'set', 'set')} da calcolare)` : 'Aggiorna i calcoli'}</button>
      <small id="analyzeMsg"></small></div>
    ${reports.map(r => `<div class="complete-row ${r.goal.follow ? 'followed' : ''}">
      <div class="complete-head">
        <span class="logo">${setLogo(r.set)}</span>
        <a href="#/set/${encodeURIComponent(r.id)}"><b>${esc(r.set.name)}</b></a>
        <button class="icon ${r.goal.follow ? 'on' : ''}" data-follow="${esc(r.id)}" aria-label="Segui questo set">★</button>
      </div>
      ${bar(r.owned, r.total)}
      <small>${r.owned}/${r.total} (${Math.floor(r.pct * 100)}%) · ${r.missingN === 1 ? 'manca 1 carta' : `mancano ${r.missingN} carte`}</small>
      ${r.analyzed ? `<div class="complete-stats">
        <span><b>${eur(r.cost)}</b><small>per finirlo${r.missingN ? ` · ${eur(r.cost / r.missingN)} a carta` : ''}</small></span>
        <span><b>${r.ease}</b><small>facilità su 100</small></span>
        <span><b>${r.cheap}</b><small>mancanti sotto ${eur(CHEAP)}</small></span>
        <span><b>${r.perPoint != null ? eur(r.perPoint) : '—'}</b><small>per ogni 1% in più</small></span>
      </div>
      ${r.top.length ? `<small class="top-missing">Le più care che mancano: ${r.top.map(m =>
        `<a data-card="${esc(m.id)}">${esc(m.localId)} ${esc(m.name)} ${eur(m.price)}</a>`).join(' · ')}</small>` : ''}
      ${r.goal.follow ? `<div class="settings"><label>Budget <input type="number" min="0" step="5" data-budget="${esc(r.id)}" value="${r.goal.budget ?? ''}"> €</label>
        ${r.inBudget != null ? `<small>ci stanno ${plural(r.inBudget, 'carta', 'carte')} mancanti, partendo dalle più economiche</small>` : ''}</div>` : ''}
      <small class="note">Prezzi calcolati il ${shortDate(r.date)}</small>` : '<small class="note">Costi non ancora calcolati.</small>'}
      <div class="settings">
        <select data-scope="${esc(r.id)}">${options([['all', 'Completo = tutte le carte'], ['official', 'Completo = solo le numerate']], r.goal.scope ?? 'all')}</select>
        <button class="chip" data-shopping-set="${esc(r.id)}">Lista della spesa</button>
      </div>
    </div>`).join('') || '<p class="empty">Nessun set: aggiungi qualche carta o segui un set con ★.</p>'}`;
  for (const r of reports) for (const m of r.top) briefs.set(m.id, { ...m, setId: r.id });
}

async function saveSetGoals() {
  meta.set('dirty', meta.get('dirty') + 1);
  await db.put('settings', { key: 'setGoals', value: setGoals });
  autoBackup();
}

// ---------------------------------------------------------------------------
// Statistiche: spesa, valore, resa per set, affari, distribuzioni, crescita, vendite, bustine.
// ---------------------------------------------------------------------------
const C_CARDS = '#ffcb05', C_PACKS = '#4f8cff';   // giallo dell'app e blu: distinguibili anche per chi non vede i colori

const monthKey = d => d.slice(0, 7);
const monthLabel = k => new Date(k + '-15').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
function lastMonths(n) {
  const out = [], now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

// Prezzo pagato medio per una versione di una carta (dalle copie in cui l'hai indicato).
function paidOf(rec, variant) {
  const rows = rec?.copies.filter(c => c.variant === variant && c.paid != null) ?? [];
  const n = rows.reduce((a, c) => a + c.qty, 0);
  return n ? rows.reduce((a, c) => a + c.paid * c.qty, 0) / n : 0;
}

async function statisticsPage() {
  view.innerHTML = loading;
  const names = await catalogNames();
  const serieOf = new Map();
  try { for (const serie of await getCatalog()) for (const s of serie.sets) serieOf.set(s.id, serie.name); } catch { /* offline */ }
  const recs = [...coll.values()].filter(qty);
  await fillDetails(recs);   // tipi e rarità per le distribuzioni
  const months = lastMonths(12);
  const log = addsLog ?? [];

  // Spesa per mese: carte (copie aggiunte × prezzo pagato), bustine e spese segnate nei Costi.
  const manualIn = (m, group) => sumOf(expenses.filter(e => e.date && monthKey(e.date) === m && costGroup(e) === group));
  const cardSpend = months.map(m => log.filter(e => e.d !== 'prima' && monthKey(e.d) === m)
    .reduce((a, e) => a + e.n * paidOf(coll.get(e.id), e.v), 0) + manualIn(m, 'carte'));
  const packSpend = months.map(m => packs.filter(p => monthKey(p.date) === m).reduce((a, p) => a + (p.price ?? 0), 0) + manualIn(m, 'bustine'));
  const gearSpend = months.map(m => manualIn(m, 'gear'));
  const costs = costTotals();

  // Speso contro valore: speso cumulato (dalle carte di "prima" e dalle spese senza data in poi) e valore a fine mese.
  const spentBefore = log.filter(e => e.d === 'prima').reduce((a, e) => a + e.n * paidOf(coll.get(e.id), e.v), 0)
    + packs.filter(p => monthKey(p.date) < months[0]).reduce((a, p) => a + (p.price ?? 0), 0)
    + log.filter(e => e.d !== 'prima' && monthKey(e.d) < months[0]).reduce((a, e) => a + e.n * paidOf(coll.get(e.id), e.v), 0)
    + sumOf(expenses.filter(e => !e.date || monthKey(e.date) < months[0]));
  let run = spentBefore;
  const spentCum = months.map((m, i) => (run += cardSpend[i] + packSpend[i] + gearSpend[i]));
  const valueAt = months.map(m => valueLog.filter(p => monthKey(p.d) <= m).at(-1)?.v ?? null);

  // Resa per set: speso (copie con prezzo + bustine di quel set) contro valore attuale.
  const bySet = new Map();
  for (const r of recs) {
    const s = bySet.get(r.setId) ?? { spent: 0, value: 0 };
    s.spent += r.copies.reduce((a, c) => a + (c.paid ?? 0) * c.qty, 0);
    s.value += recValue(r);
    bySet.set(r.setId, s);
  }
  for (const p of packs) {
    const s = bySet.get(p.setId) ?? { spent: 0, value: 0 };
    s.spent += p.price ?? 0;
    bySet.set(p.setId, s);
  }
  const setYield = [...bySet].filter(([, s]) => s.spent > 0).sort((a, b) => (b[1].value - b[1].spent) - (a[1].value - a[1].spent));

  // Affari: per ogni gruppo di copie con prezzo pagato, valore di oggi meno quanto l'hai pagata.
  const affairs = recs.flatMap(r => r.copies.filter(c => c.paid != null)
    .map(c => ({ r, c, diff: (unitPrice(r, c.variant) - c.paid) * c.qty })));
  const best = [...affairs].sort((a, b) => b.diff - a.diff).filter(a => a.diff > 0).slice(0, 5);
  const worst = [...affairs].sort((a, b) => a.diff - b.diff).filter(a => a.diff < 0).slice(0, 5);

  // Distribuzioni (copie).
  const count = keyOf => {
    const m = new Map();
    for (const r of recs) for (const c of r.copies) for (const k of [].concat(keyOf(r, c))) m.set(k, (m.get(k) ?? 0) + c.qty);
    return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  };
  const byRarity = count(r => rarityLabel(r.rarity)).slice(0, 10);
  const byType = count(r => (r.types?.length ? r.types : [r.category === 'Allenatore' ? 'Allenatore' : r.category === 'Energia' ? 'Energia' : 'Senza tipo']));
  const byEra = count(r => serieOf.get(r.setId) ?? 'Altro');
  const byLang = count((r, c) => c.lang || '—');

  // Crescita: copie aggiunte per mese.
  const growth = months.map(m => log.filter(e => e.d !== 'prima' && monthKey(e.d) === m).reduce((a, e) => a + e.n, 0));
  const before = log.filter(e => e.d === 'prima').reduce((a, e) => a + e.n, 0);

  // Vendite e scambi per mese.
  const sales = months.map(m => deals.filter(d => monthKey(d.date) === m && d.kind === 'sold').reduce((a, d) => a + (d.price ?? 0), 0));
  const tradesN = months.map(m => deals.filter(d => monthKey(d.date) === m && d.kind !== 'sold').reduce((a, d) => a + d.qty, 0));

  // Bustine: per mese spesa e valore trovato; colpi migliori.
  const packValue = months.map(m => packs.filter(p => monthKey(p.date) === m)
    .reduce((a, p) => a + p.cards.reduce((s, c) => s + c.value, 0), 0));
  const bestPulls = packs.flatMap(p => p.cards.map(c => ({ ...c, date: p.date }))).sort((a, b) => b.value - a.value).slice(0, 5);

  const labels = months.map(monthLabel);
  const money = v => eur(v);
  const affairRow = a => `<div class="deal-row"><span class="info"><b>${esc(a.r.name)}</b>
    <small>${esc(names.get(a.r.setId)?.name ?? a.r.setId)} · ${esc(VARIANTS[a.c.variant] ?? a.c.variant)} ×${a.c.qty} · pagata ${eur(a.c.paid)}, oggi ${eur(unitPrice(a.r, a.c.variant))}</small></span>
    <b class="${a.diff >= 0 ? 'up' : 'down'}">${a.diff >= 0 ? '+' : '−'}${eur(Math.abs(a.diff))}</b></div>`;

  view.innerHTML = `<header class="top"><h1>Statistiche</h1></header>
    ${recs.length || expenses.length ? '' : '<p class="empty">Aggiungi qualche carta per vedere le statistiche.</p>'}

    <h2>Costi</h2>
    ${costKpis(costs)}
    ${costs.total ? costBars(costs) : ''}
    <a class="primary" href="#/costs">Aggiungi o vedi le spese (album, sleeve, toploader…)</a>

    <h2>Spesa per mese</h2>
    ${bars({ labels, series: [{ name: 'Carte', color: C_CARDS, values: cardSpend }, { name: 'Bustine', color: C_PACKS, values: packSpend },
      { name: 'Accessori e altro', color: C_GEAR, values: gearSpend }], fmt: money })}
    <p class="note">Le carte contano nel mese in cui le aggiungi, con il prezzo pagato che indichi nella loro scheda.
      Le spese segnate nei Costi contano nel loro mese (quelle senza data solo nel totale).</p>

    <h2>Speso contro valore</h2>
    ${lines({ labels, series: [{ name: 'Speso (totale)', color: C_PACKS, values: spentCum }, { name: 'Valore collezione', color: C_CARDS, values: valueAt }], fmt: money })}

    <h2>Resa per set</h2>
    ${setYield.length ? setYield.map(([id, s]) => `<div class="deal-row"><span class="info"><b>${esc(names.get(id)?.name ?? id)}</b>
      <small>speso ${eur(s.spent)} · vale ${eur(s.value)}</small></span>
      <b class="${s.value >= s.spent ? 'up' : 'down'}">${s.value >= s.spent ? '+' : '−'}${eur(Math.abs(s.value - s.spent))}</b></div>`).join('')
      : '<p class="note">Indica il prezzo pagato delle carte (o registra le bustine) per vedere la resa di ogni set.</p>'}

    <h2>Migliori affari</h2>
    ${best.map(affairRow).join('') || '<p class="note">Nessuna carta vale più di quanto l\'hai pagata (o non hai indicato prezzi pagati).</p>'}
    <h2>Peggiori affari</h2>
    ${worst.map(affairRow).join('') || '<p class="note">Nessuna carta vale meno di quanto l\'hai pagata.</p>'}

    <h2>Distribuzione</h2>
    <details class="group" open><summary><span>Per rarità</span><small>copie</small></summary>${hbars(byRarity, v => v, C_CARDS)}</details>
    <details class="group"><summary><span>Per tipo</span><small>copie</small></summary>${hbars(byType, v => v, C_CARDS)}</details>
    <details class="group"><summary><span>Per era</span><small>copie</small></summary>${hbars(byEra, v => v, C_CARDS)}</details>
    <details class="group"><summary><span>Per lingua</span><small>copie</small></summary>${hbars(byLang, v => v, C_CARDS)}</details>

    <h2>Crescita della collezione</h2>
    ${bars({ labels, series: [{ name: 'Copie aggiunte', color: C_CARDS, values: growth }], fmt: v => `${v} copie` })}
    ${before ? `<p class="note">Più ${plural(before, 'copia', 'copie')} che avevi già prima che l'app registrasse le date.</p>` : ''}

    <h2>Vendite e scambi nel tempo</h2>
    ${deals.length ? bars({ labels, series: [{ name: 'Incassi', color: C_CARDS, values: sales }], fmt: money })
      + bars({ labels, series: [{ name: 'Copie scambiate o regalate', color: C_PACKS, values: tradesN }], fmt: v => `${v} copie` })
      : '<p class="note">Nessuna vendita o scambio registrato.</p>'}

    <h2>Bustine nel dettaglio</h2>
    ${packs.length ? bars({ labels, series: [{ name: 'Spesa', color: C_PACKS, values: packSpend }, { name: 'Valore trovato', color: C_CARDS, values: packValue }], fmt: money })
      + `<h3 class="subhead">Colpi migliori</h3>${bestPulls.map(c => `<div class="deal-row"><span class="info"><b>${esc(c.name)}</b>
        <small>${esc(names.get(c.setId)?.name ?? c.setId)} · ${shortDate(c.date)}</small></span><b>${eur(c.value)}</b></div>`).join('')}
      ${packsSection()}`
      : '<p class="note">Nessuna bustina registrata: apri il menu ☰ e tocca "Apri una bustina" quando ne apri una.</p>'}`;
}

// ---------------------------------------------------------------------------
// Guida alle rarità: simbolo, disegno e spiegazione per ogni rarità; aprendo una voce arrivano
// tre carte vere di quella rarità dal catalogo (toccandole si apre la scheda), con "Altri esempi".
// ---------------------------------------------------------------------------
function rarityGuide() {
  view.innerHTML = `<header class="top"><h1>Guida alle rarità</h1></header>${RARITY_DEFS}
    <p class="note">Quando trovi una carta, guarda il simbolo in basso e confrontalo con questa pagina.
      Tocca una rarità per vedere esempi veri.</p>
    <div class="rar-where-box">${RARITY_WHERE}</div>
    ${RARITY_GROUPS.map(g => `<h2>${esc(g.title)}</h2><p class="note">${esc(g.note)}</p>
      ${g.items.map(r => `<details class="group rar" data-rarity-guide="${esc(r.name)}" data-from="${esc(r.from)}">
        <summary>${rarityLook(r.look)}<span class="rar-head"><b>${esc(r.label ?? rarityLabel(r.name))}</b>${raritySymbol(r.sym, r.badge)}</span></summary>
        <p class="rar-text">${esc(r.text)}</p>
        <div class="rar-examples"></div>
      </details>`).join('')}`).join('')}
    <h2>Non sono rarità: le versioni</h2>
    <p class="note">Reverse (tutta la carta brilla tranne l'illustrazione), Holo e Prima Edizione sono versioni
      della stessa carta, non rarità diverse: le scegli nella scheda della carta quando la aggiungi.</p>`;
}

const shuffle = list => list.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

async function loadRarityExamples(box) {
  const out = box.querySelector('.rar-examples');
  out.innerHTML = '<p class="note">Cerco gli esempi…</p>';
  try {
    const [list, names] = await Promise.all([rarityCards(box.dataset.rarityGuide, box.dataset.from), catalogNames()]);
    const withImage = list.filter(c => c.image || IMAGES[c.id]);
    const setOf = c => c.id.replace(/-[^-]+$/, '');
    const pick = shuffle(withImage).slice(0, 3).map(c => ({ ...c, setId: setOf(c) }));
    for (const c of pick) briefs.set(c.id, c);   // per aprirne la scheda o aggiungerla con +
    const sets = [...new Set(list.map(setOf))].map(id => names.get(id)?.name).filter(Boolean);
    out.innerHTML = pick.length
      ? `<div class="grid rar-grid">${pick.map(c => `<div class="result">${tile(c)}<small>${esc(names.get(c.setId)?.name ?? c.setId)}</small></div>`).join('')}</div>
        <p class="note">${list.length > 3 ? `${plural(list.length, 'carta', 'carte')} di questa rarità` : ''}${sets.length ? ` · per esempio in ${esc(sets.slice(0, 4).join(', '))}${sets.length > 4 ? ` e altre ${sets.length - 4} espansioni` : ''}` : ''}</p>
        ${withImage.length > 3 ? '<button class="chip" data-more-examples>Altri esempi</button>' : ''}`
      : '<p class="note">Nessun esempio con immagine nel catalogo.</p>';
  } catch {
    out.innerHTML = '<p class="note">Esempi non disponibili senza connessione.</p>';
  }
}

view.addEventListener('toggle', e => {
  if (e.target.dataset?.rarityGuide && e.target.open && !e.target.dataset.loaded) {
    e.target.dataset.loaded = '1';
    loadRarityExamples(e.target);
  }
}, true);
view.addEventListener('click', e => {
  const more = e.target.closest('[data-more-examples]');
  if (more) loadRarityExamples(more.closest('[data-rarity-guide]'));
});

// ---------------------------------------------------------------------------
// Costi: le spese segnate a mano (accessori, ma anche carte e bustine comprate prima di usare l'app),
// sommate a quelle che l'app conosce già: prezzo pagato delle carte e bustine registrate.
// Spesa: { id, date: 'AAAA-MM-GG' oppure '' se non la ricordi, cat, desc, amount }.
// ---------------------------------------------------------------------------
const COST_CATS = [
  ['carte', 'Carte singole'], ['bustine', 'Bustine, box e confezioni'], ['album', 'Album e raccoglitori'],
  ['sleeve', 'Bustine protettive (sleeve)'], ['toploader', 'Toploader e card saver'],
  ['scatole', 'Scatole e porta mazzi'], ['gradazione', 'Gradazione (PSA, CGC…)'], ['spedizioni', 'Spedizioni'], ['altro', 'Altro'],
];
const costCat = id => COST_CATS.find(([k]) => k === id)?.[1] ?? 'Altro';
const C_GEAR = '#f0569a';   // terzo colore dei grafici: si distingue da giallo e blu anche per chi non vede i colori
let expenses = [];

const saveExpenses = () => db.put('settings', { key: 'expenses', value: expenses });
const sumOf = list => list.reduce((a, e) => a + e.amount, 0);
// Gruppo del grafico mensile: carte, bustine o accessori (tutto il resto).
const costGroup = e => (e.cat === 'carte' ? 'carte' : e.cat === 'bustine' ? 'bustine' : 'gear');

/** Totali per categoria: spese a mano più carte con prezzo pagato e bustine registrate. */
function costTotals() {
  const cardsPaid = [...coll.values()].reduce((a, r) => a + r.copies.reduce((s, c) => s + (c.paid ?? 0) * c.qty, 0), 0);
  const packsPaid = packs.reduce((a, p) => a + (p.price ?? 0), 0);
  const byCat = COST_CATS.map(([k, label]) => {
    const manual = sumOf(expenses.filter(e => e.cat === k));
    const auto = k === 'carte' ? cardsPaid : k === 'bustine' ? packsPaid : 0;
    return { id: k, label, value: manual + auto, manual, auto };
  });
  const total = byCat.reduce((a, c) => a + c.value, 0);
  const gear = byCat.filter(c => c.id !== 'carte' && c.id !== 'bustine').reduce((a, c) => a + c.value, 0);
  return { byCat, total, gear, cards: byCat[0].value, packs: byCat[1].value };
}

function costKpis(t) {
  return `<div class="kpis">
    <div><b>${eur(t.total)}</b><small>speso in tutto</small></div>
    <div><b>${eur(t.cards)}</b><small>carte singole</small></div>
    <div><b>${eur(t.packs)}</b><small>bustine e box</small></div>
    <div><b>${eur(t.gear)}</b><small>accessori e altro</small></div></div>`;
}

const costBars = t => hbars(t.byCat.filter(c => c.value > 0).sort((a, b) => b.value - a.value), eur, C_GEAR);

function costsPage() {
  const t = costTotals();
  const today = new Date().toISOString().slice(0, 10);
  // Dalla più recente; quelle senza data in fondo.
  const list = [...expenses].sort((a, b) => (b.date || '0').localeCompare(a.date || '0') || b.id - a.id);
  const autoNote = [t.byCat[0].auto ? `${eur(t.byCat[0].auto)} di carte dal prezzo pagato nelle schede` : '',
    t.byCat[1].auto ? `${eur(t.byCat[1].auto)} di bustine registrate` : ''].filter(Boolean);
  view.innerHTML = `<header class="top"><a class="back" href="#/statistics" aria-label="Indietro">‹</a><h1>Costi</h1></header>
    ${costKpis(t)}
    ${autoNote.length ? `<p class="note">Comprende già ${autoNote.join(' e ')}: quelle non segnarle di nuovo qui.</p>` : ''}

    <h2>Aggiungi una spesa</h2>
    <form id="costForm" class="advform">
      <select id="costCat">${options(COST_CATS, 'album')}</select>
      <input id="costDesc" placeholder="Cosa (es. Album 9 tasche, 100 sleeve)" autocomplete="off">
      <div class="advprice"><input id="costAmount" inputmode="decimal" placeholder="Prezzo €" required>
        <input id="costDate" type="date" value="${today}" max="${today}"></div>
      <button class="primary">Aggiungi</button>
    </form>
    <p class="note">Per le spese di prima: metti la data se te la ricordi, altrimenti cancellala e conta solo nel totale.</p>

    ${t.total ? `<h2>Per categoria</h2>${costBars(t)}` : ''}

    <h2>Spese segnate</h2>
    ${list.map(e => `<div class="deal-row"><span class="info"><b>${esc(e.desc || costCat(e.cat))}</b>
      <small>${esc(costCat(e.cat))} · ${e.date ? shortDate(e.date) : 'data non indicata'}</small></span>
      <b>${eur(e.amount)}</b><button class="icon" data-del-expense="${e.id}" aria-label="Elimina la spesa">✕</button></div>`).join('')
      || '<p class="note">Ancora nessuna spesa segnata.</p>'}`;
}

view.addEventListener('submit', async e => {
  if (e.target.id !== 'costForm') return;
  e.preventDefault();
  const amount = parseFloat($('#costAmount').value.replace(',', '.'));
  if (!(amount > 0)) return $('#costAmount').focus();
  expenses.push({ id: Date.now(), date: $('#costDate').value, cat: $('#costCat').value, desc: $('#costDesc').value.trim(), amount });
  await saveExpenses();
  autoBackup();
  const cat = $('#costCat').value;
  costsPage();
  $('#costCat').value = cat;   // spesso si segnano più cose della stessa categoria di fila
  toast(`Spesa aggiunta: ${eur(amount)}`);
});

view.addEventListener('click', async e => {
  const del = e.target.closest('[data-del-expense]');
  if (!del) return;
  const item = expenses.find(x => x.id === +del.dataset.delExpense);
  if (!item || !confirm(`Eliminare "${item.desc || costCat(item.cat)}" (${eur(item.amount)})?`)) return;
  expenses = expenses.filter(x => x !== item);
  await saveExpenses();
  autoBackup();
  costsPage();
});

// ---------------------------------------------------------------------------
// Menu laterale: tutte le funzioni dell'app, raggruppate in sezioni che si aprono e si chiudono.
// Si apre con ☰ in alto a sinistra di ogni pagina; la barra in basso resta per le voci più usate.
// Voce: [etichetta, indirizzo '#/…'] oppure [etichetta, null, azione].
// ---------------------------------------------------------------------------
const MENU = [
  ['◓', 'Catalogo', [['Espansioni', '#/'], ['Ricerca avanzata', '#/search'], ['Guida alle rarità', '#/rarity'], ['Scansiona una carta', null, 'scan'], ['Wishlist', '#/wish']]],
  ['▤', 'La mia collezione', [['Riepilogo', '#/stats'], ['Statistiche', '#/statistics'], ['Costi e spese', '#/costs'], ['Doppioni', '#/doubles']]],
  ['▦', 'Album e conservazione', [['Album e scatole', '#/album'], ['Set da completare', '#/complete'], ['Sfoglia l\'album', null, 'flip']]],
  ['◈', 'Acquisti', [['Apri una bustina', null, 'pack'], ['Modalità fiera', '#/more']]],
  ['⚙', 'Impostazioni', [['Backup e ripristino', '#/more'], ['Aggiornamenti e manutenzione', '#/more']]],
];
const drawer = $('#drawer');
const openGroups = new Set([0]);   // sezioni aperte: valgono finché l'app resta aperta

function renderDrawer() {
  const here = location.hash || '#/';
  drawer.innerHTML = `<div class="drawer-head"><img src="icons/icon-192.png" alt=""><div><b>GA Pokémon</b>
      <small>${plural([...coll.values()].filter(qty).length, 'carta', 'carte')} · ${eur([...coll.values()].reduce((a, r) => a + recValue(r), 0))}</small></div></div>
    ${MENU.map(([icon, title, items], g) => `<div class="drawer-group ${openGroups.has(g) ? 'open' : ''}">
      <button class="drawer-title" data-group="${g}"><span class="drawer-icon">${icon}</span>${esc(title)}<span class="chev">‹</span></button>
      <div class="drawer-items">${items.map(([label, href, act]) => href
        ? `<a href="${href}" class="${href === here ? 'on' : ''}">${esc(label)}</a>`
        : `<button data-menu-act="${act}">${esc(label)}</button>`).join('')}</div>
    </div>`).join('')}`;
}

function openDrawer() {
  renderDrawer();
  document.body.classList.add('drawer-open');
}
function closeDrawer() {
  document.body.classList.remove('drawer-open');
}

drawer.addEventListener('click', e => {
  const title = e.target.closest('[data-group]');
  if (title) {
    const g = +title.dataset.group;
    if (openGroups.has(g)) openGroups.delete(g);
    else openGroups.add(g);
    title.parentElement.classList.toggle('open');
    return;
  }
  const act = e.target.closest('[data-menu-act]')?.dataset.menuAct;
  if (e.target.closest('a') || act) closeDrawer();
  if (act === 'scan') openScanner();
  if (act === 'pack') openPackDialog();
  if (act === 'flip') {
    if (location.hash !== '#/album') location.hash = '#/album';
    setTimeout(() => openFlip(albumSet), 600);
  }
});
$('#drawerBackdrop').addEventListener('click', closeDrawer);
$('#nav').addEventListener('click', e => { if (e.target.closest('[data-nav-scan]')) openScanner(); });

// Ogni pagina ha il pulsante ☰ all'inizio della sua intestazione.
new MutationObserver(() => {
  const head = view.querySelector('.top');
  if (head && !head.querySelector('.menu-btn')) {
    head.insertAdjacentHTML('afterbegin', '<button class="menu-btn" data-menu aria-label="Apri il menu">☰</button>');
  }
}).observe(view, { childList: true });
view.addEventListener('click', e => { if (e.target.closest('[data-menu]')) openDrawer(); });

// Riga di lettura dei grafici: toccando una barra o un punto compare il suo valore.
view.addEventListener('click', e => {
  const tip = e.target.closest?.('[data-tip]');
  if (tip) tip.closest('.chart').querySelector('.chart-read').textContent = tip.dataset.tip;
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
    <p class="where" id="dexline"></p>
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
      <label class="where-copy">Dove la tengo <select data-f="where">${options(whereOptions(cur), c.where ?? '')}</select></label>
      <label class="sleeve-copy"><input type="checkbox" data-f="sleeve" ${c.sleeve ? 'checked' : ''}> Bustina</label>
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

/** Registra una vendita/scambio/regalo di n copie di una riga e le toglie dalla collezione. */
async function addDeal(rec, c, n, kind, price, who, note) {
  deals.unshift({
    id: Date.now(), date: new Date().toISOString().slice(0, 10), kind, qty: n,
    cardId: rec.cardId, name: rec.name, setId: rec.setId, localId: rec.localId, image: rec.image,
    variant: c.variant, condition: c.condition, lang: c.lang, paid: c.paid ?? null,
    value: unitPrice(rec, c.variant), price: kind === 'sold' && price >= 0 ? price : null, who, note,
  });
  c.qty -= n;
  await saveDeals();
  await save(rec);
  toast(`${DEAL_KINDS[kind]}: ${esc(rec.name)} ×${n}. La trovi in Collezione → Vendite e scambi.`);
}

async function confirmDeal(i) {
  const c = cur.copies[i];
  const n = Math.min(c.qty, Math.max(1, Math.round(+$('#dealQty').value || 1)));
  const price = parseFloat($('#dealPrice').value.replace(',', '.'));
  dealFor = null;
  await addDeal(cur, c, n, $('#dealKind').value, price, $('#dealWho').value.trim(), $('#dealNote').value.trim());
}

// ---------------------------------------------------------------------------
// Doppioni: copie oltre la prima della stessa versione (normale, holo, reverse…). Ogni versione fa
// parte della collezione; i doppioni hanno uno stato (da scambiare, in vendita con prezzo, da tenere)
// salvato sulla carta, quindi anche nel backup.
// ---------------------------------------------------------------------------
const DUP_STATES = { trade: 'Da scambiare', sale: 'In vendita', keep: 'Da tenere' };
let dupSort = 'set', dupFilter = 'all';

function doublesOf(rec) {
  const byVariant = new Map();
  for (const c of rec.copies) byVariant.set(c.variant, (byVariant.get(c.variant) ?? 0) + c.qty);
  return [...byVariant].filter(([, n]) => n > 1).map(([variant, n]) => ({
    variant, n: n - 1, state: rec.dups?.[variant]?.state ?? 'trade', price: rec.dups?.[variant]?.price ?? null,
  }));
}
const doublesCount = () => [...coll.values()].reduce((a, r) => a + doublesOf(r).reduce((s, d) => s + d.n, 0), 0);

async function doublesPage() {
  const names = await catalogNames();
  for (const [id, s] of names) setNames.set(id, s.name);
  const all = [...coll.values()].flatMap(r => doublesOf(r).map(d => ({ r, ...d, value: unitPrice(r, d.variant) })));
  const items = all.filter(d => dupFilter === 'all' || d.state === dupFilter);
  const total = (list, f) => list.reduce((a, d) => a + f(d), 0);
  const row = d => `<div class="dup-row">
      <div class="thumb" data-card="${esc(d.r.cardId)}">${cardImg(d.r.cardId, d.r.image, 'low')}</div>
      <span class="info"><b>${esc(d.r.name)}</b>
        <small>${esc(setNames.get(d.r.setId) ?? d.r.setId)} · n° ${esc(d.r.localId)} · ${esc(VARIANTS[d.variant] ?? d.variant)} · ×${d.n}${d.value ? ` · ~${eur(d.value)} cad.` : ''}</small>
        <span class="dup-controls">
          <select data-dup-state="${esc(d.r.cardId)}|${esc(d.variant)}">${options(Object.entries(DUP_STATES), d.state)}</select>
          ${d.state === 'sale' ? `<input data-dup-price="${esc(d.r.cardId)}|${esc(d.variant)}" inputmode="decimal" placeholder="Prezzo €" value="${d.price ?? (d.value ? d.value.toFixed(2).replace('.', ',') : '')}">` : ''}
        </span>
        <span class="dup-controls">${Object.entries(DEAL_KINDS).map(([k, label]) =>
          `<button class="chip" data-dup-deal="${k}|${esc(d.r.cardId)}|${esc(d.variant)}">${label}</button>`).join('')}</span>
      </span>
    </div>`;
  let body;
  if (dupSort === 'value') {
    body = items.sort((a, b) => b.value - a.value).map(row).join('');
  } else {
    const bySet = new Map();
    for (const d of items) bySet.set(d.r.setId, [...(bySet.get(d.r.setId) ?? []), d]);
    body = [...bySet].sort((a, b) => (setNames.get(a[0]) ?? '').localeCompare(setNames.get(b[0]) ?? '')).map(([id, list]) =>
      `<h2>${esc(setNames.get(id) ?? id)} <span class="count">${total(list, d => d.n)}</span> <small>${eur(total(list, d => d.n * d.value))}</small></h2>
       ${list.sort((a, b) => String(a.r.localId).localeCompare(String(b.r.localId), undefined, { numeric: true })).map(row).join('')}`).join('');
  }
  view.innerHTML = `<header class="top"><a class="back" href="#/stats" aria-label="Indietro">‹</a><h1>Doppioni</h1>
      ${all.length ? '<button class="chip" data-act="shareDoubles">Condividi</button>' : ''}</header>
    <div class="kpis">
      <div><b>${total(all, d => d.n)}</b><small>Doppioni · ${eur(total(all, d => d.n * d.value))}</small></div>
      <div><b>${eur(total(all.filter(d => d.state === 'sale'), d => d.n * (d.price ?? d.value)))}</b><small>In vendita (prezzi richiesti)</small></div>
    </div>
    <div class="chips dup-chips">
      ${[['set', 'Per set'], ['value', 'Per valore']].map(([k, l]) => `<button class="chip ${dupSort === k ? 'on' : ''}" data-dup-sort="${k}">${l}</button>`).join('')}
      ${[['all', 'Tutti'], ...Object.entries(DUP_STATES)].map(([k, l]) => `<button class="chip ${dupFilter === k ? 'on' : ''}" data-dup-filter="${k}">${l}</button>`).join('')}
    </div>
    ${body || `<p class="empty">${all.length ? 'Nessun doppione con questo stato.' : 'Non hai doppioni: una seconda copia della stessa versione di una carta comparirà qui.'}</p>`}
    <p class="note">Doppione = una copia in più della stessa versione: normale, holo e reverse della stessa carta
      fanno tutte parte della collezione.</p>`;
}

/** Stato o prezzo richiesto di un doppione: salvati sulla carta. */
async function setDup(key, field, value) {
  const [cardId, variant] = key.split('|');
  const rec = structuredClone(coll.get(cardId));
  rec.dups = { ...rec.dups, [variant]: { ...rec.dups?.[variant], [field]: value } };
  await save(rec);
}

/** Venduta / scambiata / regalata dalla lista: si dà via la copia in condizioni peggiori di quella versione. */
async function quickDeal(kind, cardId, variant) {
  const rec = structuredClone(coll.get(cardId));
  const c = rec.copies.filter(x => x.variant === variant && x.qty > 0)
    .sort((a, b) => CONDITIONS.indexOf(b.condition) - CONDITIONS.indexOf(a.condition))[0];
  if (!c) return;
  let price = null;
  if (kind === 'sold') {
    const ask = rec.dups?.[variant]?.price ?? unitPrice(rec, variant);
    const v = prompt('Prezzo incassato (€)', ask ? String(Math.round(ask * 100) / 100).replace('.', ',') : '');
    if (v === null) return;
    price = parseFloat(v.replace(',', '.'));
  }
  const who = prompt(kind === 'gift' ? 'A chi? (facoltativo)' : 'Con chi? (facoltativo)', '');
  if (who === null) return;
  const note = kind === 'traded' ? (prompt('Cosa hai ricevuto in cambio? (facoltativo)', '') ?? '') : '';
  await addDeal(rec, c, 1, kind, price, who.trim(), note.trim());
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
  // Solo i doppioni disponibili (non quelli "da tenere"), raggruppati per set.
  const items = [...coll.values()].flatMap(r => doublesOf(r).filter(d => d.state !== 'keep').map(d => ({ r, ...d })))
    .sort((a, b) => (setNames.get(a.r.setId) ?? '').localeCompare(setNames.get(b.r.setId) ?? '')
      || String(a.r.localId).localeCompare(String(b.r.localId), undefined, { numeric: true }));
  if (!items.length) return toast('Non hai doppioni disponibili da condividere.');
  const lines = [];
  let lastSet = null;
  for (const d of items) {
    if (d.r.setId !== lastSet) lines.push(`\n${setNames.get(d.r.setId) ?? d.r.setId}`);
    lastSet = d.r.setId;
    const value = unitPrice(d.r, d.variant);
    const price = d.state === 'sale' ? ` — in vendita a ${eur(d.price ?? value)}` : value ? ` (~${eur(value)})` : '';
    lines.push(`• ${d.r.localId} ${d.r.name}${d.variant !== 'normal' ? ` (${VARIANTS[d.variant] ?? d.variant})` : ''} ×${d.n}${price}`);
  }
  shareText('I miei doppioni', `I miei doppioni Pokémon (scambio o vendita):\n${lines.join('\n')}`);
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
  // Album Pokédex: se la carta è di un Pokémon nell'intervallo, si può scegliere per il suo posto.
  const dex = dexAlbum();
  const n = dex && (rec.dexId ?? []).find(d => d >= dex.from && d <= dex.to);
  if (n && rec.category !== 'Allenatore' && rec.category !== 'Energia') {
    const chosen = dexChoices(dex).choice.get(n);
    $('#dexline').innerHTML = chosen?.cardId === rec.cardId
      ? `<b>Pokédex</b> È la carta di ${esc(dexLabel(n))} nel ${esc(dex.name)} ✓`
      : `<b>Pokédex</b> Per ${esc(dexLabel(n))} ora c'è ${chosen ? esc(chosen.name) + ` (${esc(setNames.get(chosen.setId) ?? chosen.setId)})` : 'un posto vuoto'}
         <button class="chip" data-dex-pick="${n}">Usa questa per il Pokédex</button>`;
  }
  const places = await placementsOf(rec);
  const el = $('#where');
  if (!el || cur !== rec || !places.length) return;
  const pending = places.some(p => p.key && !isPlaced(rec, p));
  // Album liberi: metti la carta in uno di quelli aperti, o toglila da quello dove l'hai messa.
  const inFree = freeAlbumOf(rec.cardId);
  const targets = freeAlbums().filter(a => !a.closed && a !== inFree);
  const manual = inFree
    ? `<div class="where-actions"><button class="chip" data-free-remove>Togli da ${esc(inFree.name)}</button></div>`
    : '';
  const put = targets.length
    ? `<div class="where-actions"><select id="freeTarget">${options(targets.map(a => [a.id, a.name]))}</select>
        <button class="chip" data-free-put>${inFree ? 'Sposta' : 'Metti'} qui</button></div>`
    : '';
  el.innerHTML = `<b>Dove va</b> ${groupPlaces(places).map(g => esc(g.label)).join('<br>')}
    ${pending ? '<button class="chip" data-mark-placed>Sistemata</button>' : places.some(p => p.key) ? '<small>✓ già sistemata</small>' : ''}
    ${manual}${put}`;
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
  if (e.target.closest('[data-free-put]')) {   // la copia più bella va nell'album scelto
    const album = albums.find(a => a.id === $('#freeTarget').value);
    const copy = cur.copies.filter(c => c.qty > 0).sort((a, b) => unitPrice(cur, b.variant) - unitPrice(cur, a.variant))[0];
    for (const c of cur.copies) if (c.where?.startsWith('album:') && freeAlbums().some(a => c.where === `album:${a.id}`)) delete c.where;
    copy.where = `album:${album.id}`;
    await save(cur);
    await putInFree(album, cur);
    toast(`${esc(cur.name)} → ${esc(album.name)}`);
    return renderSheet();
  }
  if (e.target.closest('[data-free-remove]')) {   // torna al posto deciso dalle regole
    const inFree = freeAlbumOf(cur.cardId);
    for (const c of cur.copies) if (c.where === `album:${inFree?.id}`) delete c.where;
    await save(cur);
    await removeFromFree(cur.cardId);
    return renderSheet();
  }
  const dexPick = e.target.closest('[data-dex-pick]');
  if (dexPick) {
    const dex = dexAlbum();
    dex.picks = { ...dex.picks, [dexPick.dataset.dexPick]: cur.cardId };
    await persistAlbums();
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
  if (added) {
    recordAdd(cur, added.variant);
    await recordInPack(cur, added.variant);
  }
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
  const copy = cur.copies[+e.target.closest('.copy').dataset.i];
  const value = e.target.value.trim();
  if (f === 'sleeve') copy.sleeve = e.target.checked;
  else if (f === 'where') {
    const before = copy.where;
    if (value) copy.where = value;
    else delete copy.where;   // torna all'automatico
    await save(cur);
    await syncFreeAlbums(cur, before);
    return renderSheet();
  } else {
    // Prezzo pagato: numero con virgola o punto; vuoto = non indicato.
    copy[f] = f === 'paid' ? (value ? Math.max(0, parseFloat(value.replace(',', '.'))) || 0 : null) : value;
  }
  await save(cur);
  if (f === 'sleeve') fillWhere();
});

/**
 * Gli album liberi tengono l'elenco delle loro carte: se una copia ora sceglie un album libero la carta
 * ci entra (prima tasca libera); se nessuna copia lo sceglie più, ne esce e la tasca resta libera.
 */
async function syncFreeAlbums(rec, before) {
  for (const a of freeAlbums()) {
    const wanted = rec.copies.some(c => c.where === `album:${a.id}`);
    const inside = a.cards?.some(e => e?.cardId === rec.cardId);
    if (wanted && !inside) await putInFree(a, rec);
    else if (!wanted && inside && before === `album:${a.id}`) await removeFromFree(rec.cardId);
  }
}

// Alla chiusura si aggiorna solo la carta toccata, così la pagina sotto non salta in cima.
// Collezione e Wishlist invece vanno ricalcolate per intero.
function afterClose() {
  if (!cur) return;
  const id = cur.cardId;
  cur = null;
  const page = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (['stats', 'wish', 'album', 'doubles', 'complete'].includes(page)) route();
  else refreshCard(id);
}
// L'evento "close" copre il tasto Indietro del telefono; può arrivare in ritardo, quindi
// la chiusura dal pulsante aggiorna subito senza aspettarlo.
sheet.addEventListener('close', afterClose);

// Chiamata dall'APK quando si preme Indietro: true = gestito qui (c'era la scheda carta aperta).
window.appBack = () => {
  if (document.body.classList.contains('drawer-open')) {
    closeDrawer();
    return true;
  }
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
  scanner.classList.add('camwait');   // Poké Ball che oscilla finché la fotocamera non manda le prime immagini
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    scanVideo.srcObject = scanStream;
    await scanVideo.play();
    scanner.classList.remove('nocam', 'camwait');
    await setupCameraTools().catch(() => {});   // senza flash e zoom si scatta lo stesso
  } catch {
    scanner.classList.remove('camwait');
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
  camTrack = null;
}

// Strumenti della fotocamera, quando il telefono li offre: flash, zoom e messa a fuoco.
// Lo zoom serve soprattutto a mettere a fuoco: da troppo vicino i telefoni non ci riescono, così
// si tiene la carta a una ventina di centimetri e la si ingrandisce.
const SCAN_HINT = 'Carta dritta dentro il riquadro, con buona luce';
let camTrack = null, camCaps = {}, torchOn = false;
const applyCam = settings => camTrack?.applyConstraints({ advanced: [settings] }).then(() => true, () => false);

async function setupCameraTools() {
  camTrack = scanStream.getVideoTracks()[0];
  camCaps = camTrack.getCapabilities?.() ?? {};
  torchOn = false;
  const torch = scanner.querySelector('[data-torch]');
  torch.hidden = !camCaps.torch;
  torch.classList.remove('on');
  torch.setAttribute('aria-pressed', 'false');
  if (camCaps.focusMode?.includes('continuous')) await applyCam({ focusMode: 'continuous' });
  const zoom = camCaps.zoom;
  const steps = zoom ? [1, 1.5, 2, 3].filter(z => z >= zoom.min && z <= zoom.max) : [];
  $('#camZoom').innerHTML = steps.length > 1
    ? steps.map(z => `<button class="cam-btn" data-zoom="${z}">${String(z).replace('.', ',')}×</button>`).join('') : '';
  if (steps.length > 1) {
    await setZoom(steps.includes(2) ? 2 : steps.at(-1));
    $('#scanHint').textContent = 'Tieni la carta a circa 20 cm: lo zoom la ingrandisce e così mette a fuoco';
  } else {
    $('#scanHint').textContent = SCAN_HINT;
  }
}

async function setZoom(z) {
  await applyCam({ zoom: z });
  for (const b of $('#camZoom').children) b.classList.toggle('on', +b.dataset.zoom === z);
}

/** Messa a fuoco una volta (sul punto toccato, se si può), poi si torna a quella continua. */
async function focusOnce(x = 0.5, y = 0.5) {
  if (!camCaps.focusMode?.includes('single-shot')) return false;
  if (camCaps.pointsOfInterest !== undefined) await applyCam({ pointsOfInterest: [{ x, y }] });
  await applyCam({ focusMode: 'single-shot' });
  await new Promise(r => setTimeout(r, 700));
  if (camCaps.focusMode.includes('continuous')) applyCam({ focusMode: 'continuous' });
  return true;
}

/** Scatto: alcuni fotogrammi in un attimo, e si tiene il più nitido (meno mosso e più a fuoco). */
async function sharpestShot() {
  await focusOnce();
  let best = null;
  for (let i = 0; i < 6; i++) {
    const card = captureFromVideo(scanVideo, scanner.querySelector('.frame'));
    const s = sharpness(card);
    if (!best || s > best.s) best = { card, s };
    await new Promise(r => setTimeout(r, 120));
  }
  return best;
}

function closeScanner() {
  stopCamera();
  if (scanner.open) scanner.close();
}

let scanning = false, lastReading = null;
const BLURRY = 100;   // sotto questa nitidezza (vedi sharpness in scan.js) la foto è quasi sempre illeggibile
async function recognize(card, blurry = false) {
  if (scanning) return;
  scanning = true;
  scanner.classList.add('busy');
  const msg = $('#scanMsg');
  $('#scanResults').innerHTML = '';
  $('#scanFix').hidden = true;
  try {
    lastReading = await readCard(card, status => { msg.textContent = status; });
    const found = await showMatches(lastReading);
    if (blurry && !found) {
      msg.textContent += ' La foto era sfocata: allontana un po’ il telefono (o usa lo zoom), tocca la carta sullo schermo per mettere a fuoco e riprova.';
    }
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    scanning = false;
    scanner.classList.remove('busy');
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
  return found.length;
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
    if (!scanStream) return $('#scanCamera').click();
    if (scanning) return;
    $('#scanMsg').textContent = 'Metto a fuoco…';
    scanner.classList.add('busy');
    sharpestShot().then(({ card, s }) => recognize(card, s < BLURRY));
    return;
  }
  const torch = e.target.closest('[data-torch]');
  if (torch) {
    applyCam({ torch: !torchOn }).then(ok => {
      if (!ok) return;
      torchOn = !torchOn;
      torch.classList.toggle('on', torchOn);
      torch.setAttribute('aria-pressed', String(torchOn));
    });
    return;
  }
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) return setZoom(+zoom.dataset.zoom);
  if (e.target === scanVideo || e.target.classList.contains('frame')) {   // tocco sull'immagine: mette a fuoco lì
    const r = scanVideo.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const ring = $('#camFocus');
    Object.assign(ring.style, { left: `${x * 100}%`, top: `${y * 100}%` });
    ring.hidden = false;
    focusOnce(x, y).finally(() => setTimeout(() => { ring.hidden = true; }, 300));
    return;
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
  if ((e.target.id !== 'scanFile' && e.target.id !== 'scanCamera') || !file) return;
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
  recordAdd(rec, rec.copies[0].variant);
  await recordInPack(rec, rec.copies[0].variant);
}

// Registro delle aggiunte (giorno, carta, versione, copie): serve alle statistiche "spesa per mese"
// e "crescita della collezione". Le carte che c'erano prima del registro stanno in una voce "prima".
let addsLog = null;
let addsTimer;
function recordAdd(rec, variant, n = 1) {
  addsLog ??= [];
  addsLog.push({ d: new Date().toISOString().slice(0, 10), id: rec.cardId, v: variant, n });
  clearTimeout(addsTimer);
  addsTimer = setTimeout(() => db.put('settings', { key: 'addsLog', value: addsLog }), 1000);
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

const backupJson = () => JSON.stringify({ app: 'pokecollezione', version: 2, cards: [...coll.values()], albums, valueLog, deals, packs, goals, storage, setGoals, expenses });
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
    if (data.setGoals && typeof data.setGoals === 'object') {   // set seguiti, budget, cosa vuol dire completo
      setGoals = { ...setGoals, ...data.setGoals };
      await db.put('settings', { key: 'setGoals', value: setGoals });
    }
    if (data.storage?.boxes) {   // regole e scatole
      storage = { ...structuredClone(DEFAULT_STORAGE), ...data.storage };
      await db.put('settings', { key: 'storage', value: storage });
    }
    if (Array.isArray(data.goals) && data.goals.length > goals.length) {
      goals = data.goals;
      await db.put('settings', { key: 'goals', value: goals });
    }
    if (Array.isArray(data.packs) && data.packs.length > packs.length) {
      packs = data.packs;
      await db.put('settings', { key: 'packs', value: packs });
    }
    if (Array.isArray(data.expenses) && data.expenses.length > expenses.length) {   // spese segnate nei Costi
      expenses = data.expenses;
      await saveExpenses();
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
  const confirmBtn = e.target.closest('[data-confirm]');
  if (confirmBtn) {   // automatico spento: la proposta diventa la tua scelta, copia per copia
    confirmBtn.disabled = true;
    const rec = structuredClone(coll.get(confirmBtn.dataset.confirm));
    // Una riga con più copie può avere proposte diverse (es. una in album, due in scatola): si divide
    // in una riga per proposta, così ogni copia tiene il suo posto.
    const byRow = new Map();
    for (const p of await placementsOf(rec)) {
      if (p.kind !== 'suggest' || !p.where) continue;
      const counts = byRow.get(p.unit.ci) ?? new Map();
      counts.set(p.where, (counts.get(p.where) ?? 0) + 1);
      byRow.set(p.unit.ci, counts);
    }
    rec.copies = rec.copies.flatMap((c, ci) => {
      const counts = byRow.get(ci);
      if (!counts || c.where) return [c];
      const rows = [...counts].map(([where, n]) => ({ ...c, qty: n, where }));
      const rest = c.qty - [...counts.values()].reduce((a, n) => a + n, 0);
      return rest > 0 ? [...rows, { ...c, qty: rest }] : rows;
    });
    await save(rec);
    return album();
  }
  const cSort = e.target.closest('[data-complete-sort]');
  if (cSort) { completeSort = cSort.dataset.completeSort; return completePage(); }
  if (e.target.closest('[data-complete-followed]')) { onlyFollowed = !onlyFollowed; return completePage(); }
  const follow = e.target.closest('[data-follow]');
  if (follow) {
    const id = follow.dataset.follow;
    setGoals[id] = { ...setGoals[id], follow: !setGoals[id]?.follow };
    await saveSetGoals();
    return completePage();
  }
  const shopSet = e.target.closest('[data-shopping-set]');
  if (shopSet) return shareMissing(shopSet.dataset.shoppingSet);
  if (e.target.closest('[data-act="analyze"]')) {
    const names = await catalogNames();
    const ids = [...new Set([...ownedBySet().keys(), ...Object.keys(setGoals).filter(id => setGoals[id].follow)])].filter(id => names.has(id));
    const todo = ids.filter(id => !setAnalysis[id]);
    await analyzeSets(todo.length ? todo : ids, $('#analyzeMsg'));
    return completePage();
  }
  const dupSortBtn = e.target.closest('[data-dup-sort]');
  if (dupSortBtn) { dupSort = dupSortBtn.dataset.dupSort; return doublesPage(); }
  const dupFilterBtn = e.target.closest('[data-dup-filter]');
  if (dupFilterBtn) { dupFilter = dupFilterBtn.dataset.dupFilter; return doublesPage(); }
  const dupDeal = e.target.closest('[data-dup-deal]');
  if (dupDeal) {
    const [kind, cardId, variant] = dupDeal.dataset.dupDeal.split('|');
    await quickDeal(kind, cardId, variant);
    return doublesPage();
  }
  const boxAct = e.target.closest('[data-box-act]');
  if (boxAct) {
    const what = boxAct.dataset.boxAct, box = storage.boxes.find(b => b.id === boxAct.dataset.box);
    if (what === 'new') {
      const name = prompt('Nome della scatola', `Scatola ${storage.boxes.length + 1}`)?.trim();
      if (!name) return;
      storage.boxes.push({ id: 'b' + Date.now(), name: name.slice(0, 30), sets: [], doubles: false, rest: !storage.boxes.some(b => b.rest) });
    }
    if (what === 'rename') {
      const name = prompt('Nuovo nome della scatola', box.name)?.trim();
      if (!name) return;
      box.name = name.slice(0, 30);
    }
    if (what === 'unset') box.sets = box.sets.filter(id => id !== boxAct.dataset.set);
    if (what === 'delete') {
      if (!confirm(`Eliminare ${box.name}? Le copie che avevi messo lì tornano all'automatico.`)) return;
      storage.boxes = storage.boxes.filter(b => b !== box);
      for (const rec of coll.values()) {
        if (!rec.copies.some(c => c.where === `box:${box.id}`)) continue;
        const copy = structuredClone(rec);
        for (const c of copy.copies) if (c.where === `box:${box.id}`) delete c.where;
        await save(copy);
      }
    }
    await saveStorage();
    return album();
  }
  const albumAct = e.target.closest('[data-album-act]');
  if (albumAct) {
    const what = albumAct.dataset.albumAct;
    const cur = albums.find(a => a.id === currentAlbum) ?? albums[0];
    const i = cur.sets?.indexOf(albumAct.dataset.set) ?? -1;
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
    if (what === 'newFree') {
      const created = { id: 'f' + Date.now(), name: `Album libero ${freeAlbums().length + 1}`, kind: 'free', capacity: 432, perSide: 9, cards: [] };
      albums.push(created);
      currentAlbum = created.id;
    }
    if (what === 'rename') {
      const name = prompt('Nuovo nome dell\'album', cur.name)?.trim();
      if (!name) return;
      cur.name = name.slice(0, 30);
    }
    if (what === 'left' || what === 'right') {   // ordine degli album, come sullo scaffale
      const from = albums.indexOf(cur), to = from + (what === 'left' ? -1 : 1);
      if (to < 0 || to >= albums.length) return;
      albums.splice(to, 0, albums.splice(from, 1)[0]);
    }
    if (what === 'newDex') {
      const created = { id: 'd' + Date.now(), name: 'Pokédex', kind: 'dex', capacity: 432, perSide: 9, from: 1, to: 151, picks: {} };
      albums.push(created);
      currentAlbum = created.id;
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
      for (const { rec } of (await toPlace()).filter(t => t.p.album?.id === currentAlbum)) await markPlaced(rec);
    }
    if (['up', 'down', 'remove', 'add', 'new', 'newDex', 'newFree', 'rename', 'left', 'right', 'delete'].includes(what)) await persistAlbums();
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
    else if (key === 'range') [cur.from, cur.to] = t.value.split('-').map(Number);
    else if (+t.value > 0) cur[key] = Math.round(+t.value);
    persistAlbums().then(album);
  }
  if (t.dataset.scope) {
    setGoals[t.dataset.scope] = { ...setGoals[t.dataset.scope], scope: t.value };
    saveSetGoals().then(completePage);
  }
  if (t.dataset.budget) {
    const v = parseFloat(t.value);
    setGoals[t.dataset.budget] = { ...setGoals[t.dataset.budget], budget: v > 0 ? v : null };
    saveSetGoals().then(completePage);
  }
  if (t.dataset.dupState) setDup(t.dataset.dupState, 'state', t.value).then(doublesPage);
  if (t.dataset.dupPrice) {
    const v = parseFloat(t.value.replace(',', '.'));
    setDup(t.dataset.dupPrice, 'price', v >= 0 ? v : null).then(doublesPage);
  }
  if (t.dataset.storage) {   // regole: automatico e soglie in euro
    const key = t.dataset.storage;
    if (key === 'auto') storage.auto = t.checked;
    else if (+t.value >= 0) storage[key] = +t.value;
    saveStorage().then(album);
  }
  if (t.dataset.rarity) {
    const list = t.dataset.rarity === 'tl' ? 'tlRarities' : 'slRarities';
    storage[list] = t.checked ? [...storage[list], t.value] : storage[list].filter(r => r !== t.value);
    saveStorage().then(album);
  }
  if (t.dataset.boxFlag) {   // una sola scatola per i doppioni e una per tutto il resto
    for (const b of storage.boxes) if (t.checked && b.id !== t.dataset.box) b[t.dataset.boxFlag] = false;
    storage.boxes.find(b => b.id === t.dataset.box)[t.dataset.boxFlag] = t.checked;
    saveStorage().then(album);
  }
  if (t.dataset.boxAdd && t.value) {
    const b = storage.boxes.find(x => x.id === t.dataset.boxAdd);
    b.sets = [...(b.sets ?? []), t.value];
    saveStorage().then(album);
  }
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
  const tab = page === 'set' || page === 'search' || page === 'rarity' ? 'home' : page === 'doubles' || page === 'statistics' || page === 'costs' ? 'stats' : page === 'complete' ? 'album' : page || 'home';
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === tab);
  try {
    if (page === 'set') await setView(decodeURIComponent(arg));
    else if (page === 'stats') await stats();
    else if (page === 'wish') wish();
    else if (page === 'album') await album();
    else if (page === 'search') advancedSearch();
    else if (page === 'doubles') await doublesPage();
    else if (page === 'complete') await completePage();
    else if (page === 'statistics') await statisticsPage();
    else if (page === 'costs') costsPage();
    else if (page === 'rarity') rarityGuide();
    else if (page === 'more') await more();
    else await home();
  } catch (err) {
    view.innerHTML = failed(err);
  }
}

// Ogni pagina ricorda dov'era lo scorrimento: tornando indietro da un set si ritrova il punto di prima.
const scrollPos = new Map();
addEventListener('hashchange', async e => {
  closeDrawer();
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
expenses = (await db.get('settings', 'expenses'))?.value ?? [];
goals = (await db.get('settings', 'goals'))?.value ?? [];
setGoals = (await db.get('settings', 'setGoals'))?.value ?? {};
setAnalysis = (await db.get('settings', 'setAnalysis'))?.value ?? {};
addsLog = (await db.get('settings', 'addsLog'))?.value ?? null;
if (!addsLog && coll.size) {   // prima volta: le carte che ci sono già finiscono nella voce "prima"
  addsLog = [...coll.values()].flatMap(r => r.copies.map(c => ({ d: 'prima', id: r.cardId, v: c.variant, n: c.qty })));
  await db.put('settings', { key: 'addsLog', value: addsLog });
}
// Regole e scatole; la prima volta si riprendono le soglie che c'erano prima.
storage = { ...structuredClone(DEFAULT_STORAGE), ...(await db.get('settings', 'storage'))?.value };
if (meta.get('tlEuro') && !(await db.get('settings', 'storage'))) storage.tl = meta.get('tlEuro');
if (meta.get('slEuro') && !(await db.get('settings', 'storage'))) storage.sl = meta.get('slEuro');
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
