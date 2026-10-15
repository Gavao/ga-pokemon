// Guida alle rarità: per ogni rarità del catalogo (nomi TCGdex in italiano) il simbolo stampato sulla
// carta, un disegno di come appare e una spiegazione. Gli esempi veri li carica app.js dal catalogo:
// "from" limita la ricerca alle carte il cui codice contiene quel testo (es. 'sv0' = Scarlatto e Violetto).
// sym: [forma, colore, quante] con forma circle/diamond/star e colore black/silver/gold; oppure null
// quando il simbolo non serve a riconoscerla (si guarda l'aspetto). look: il disegno della carta.

export const RARITY_GROUPS = [
  {
    title: 'Le basi',
    note: 'Ci sono in tutte le espansioni, dalle prime del 1999 a oggi.',
    items: [
      { name: 'Comune', sym: ['circle', 'black', 1], look: 'plain', from: 'sv0',
        text: 'La più facile da trovare: in ogni bustina ce ne sono diverse. Cornice normale e illustrazione senza riflessi.' },
      { name: 'Non comune', sym: ['diamond', 'black', 1], look: 'plain', from: 'sv0',
        text: 'Un po\' meno frequente, di solito tre per bustina. Spesso evoluzioni intermedie e carte Allenatore.' },
      { name: 'Rara', sym: ['star', 'black', 1], look: 'holo', from: 'sv0',
        text: 'Almeno una per bustina, nel posto della carta rara. Nelle espansioni recenti l\'illustrazione è olografica (brilla).' },
      { name: 'Olografica Rara', sym: ['star', 'black', 1], look: 'holo', from: 'swsh',
        text: 'Come la Rara, ma brilla solo il riquadro dell\'illustrazione, il resto della carta no. Nel catalogo la trovi così nelle espansioni Spada e Scudo.' },
      { name: 'Promo', sym: null, badge: 'PROMO', look: 'promo', from: 'svp',
        text: 'Non esce nelle bustine normali: arriva da box speciali, eventi o riviste. Al posto di numero/totale ha un codice (es. SVP 050) e la scritta PROMO.' },
    ],
  },
  {
    title: 'Scarlatto e Violetto e Megaevoluzione',
    note: 'Dal 2023 il simbolo dice tutto: guarda in basso a sinistra, accanto alla sigla del set e al numero. '
      + 'Più stelle = più rara; nere, argentate o dorate.',
    items: [
      { name: 'Rara doppia', sym: ['star', 'black', 2], look: 'ex', from: 'sv0',
        text: 'Pokémon-ex con la cornice normale, tutta la carta lucida. Due stelle nere.' },
      { name: 'Ultrarara', sym: ['star', 'silver', 2], look: 'full', from: 'sv0',
        text: 'Pokémon-ex o Allenatore a figura intera: l\'illustrazione copre tutta la carta e la superficie è in rilievo. '
          + 'Due stelle argentate, numero più alto del totale (es. 212/198). Nelle espansioni più vecchie è il "full art" con la stella nera.' },
      { name: 'Rara illustrazione', sym: ['star', 'gold', 1], look: 'scene', from: 'sv0',
        text: 'Un Pokémon (di solito non ex) con l\'illustrazione che occupa tutta la carta, spesso una scena con lo sfondo. Una stella dorata, numero oltre il totale.' },
      { name: 'Rara illustrazione speciale', sym: ['star', 'gold', 2], look: 'scene', from: 'sv0',
        text: 'La versione più spettacolare di un Pokémon-ex o di un Allenatore: illustrazione a tutta carta con una scena. Due stelle dorate. Tra le più ricercate e care.' },
      { name: 'Rara iper', sym: ['star', 'gold', 3], look: 'gold', from: 'sv0',
        text: 'Carta tutta dorata, bordo compreso (a volte con riflessi arcobaleno). Tre stelle dorate: è la rarità più alta di ogni espansione Scarlatto e Violetto.' },
      { name: 'rara ASSO TATTICO', sym: null, badge: 'ASSO', look: 'ace', from: 'sv0',
        text: 'Allenatori ed Energie molto forti con la fascia "ASSO TATTICO" (in inglese ACE SPEC) in basso, dai riflessi arcobaleno. Nel mazzo se ne può mettere una sola.' },
      { name: 'Shiny rare', label: 'Rara cromatica', sym: null, look: 'shiny', from: '',
        text: 'Pokémon cromatici: colori diversi dal solito e sfondo argentato scintillante. Solo in Destino di Paldea e nel caveau cromatico di Destino Splendente.' },
      { name: 'ultrarara cromatica', sym: null, look: 'shiny', from: '',
        text: 'Pokémon-ex cromatico a figura intera, con i colori alternativi. Solo in Destino di Paldea.' },
      { name: 'Rara Bianco e Nero', sym: null, look: 'bw', from: '',
        text: 'Rarità speciale delle due espansioni Bianco e Nero del 2025 (Fulmine Nero e Fuoco Bianco): solo 4 carte in tutto, le più rare di quei set.' },
      { name: 'Mega Attack Rare', label: 'Rara Mega Attacco', sym: null, look: 'scene', from: '',
        text: 'Rarità della serie Megaevoluzione con pochissime carte di Mega Pokémon-ex, tutte nella stessa espansione. Guarda gli esempi per riconoscerla.' },
      { name: 'Mega Iper Raro', sym: null, look: 'gold', from: '',
        text: 'La carta più rara delle espansioni Megaevoluzione: di solito una sola per set, un Mega Pokémon-ex. Guarda gli esempi per riconoscerla.' },
    ],
  },
  {
    title: 'Spada e Scudo',
    note: 'Dal 2020 al 2023 quasi tutte le rare hanno la stessa stella nera: le riconosci dall\'aspetto, dal nome (V, VMAX, V ASTRO) e dal numero.',
    items: [
      { name: 'Olografica Rara V', sym: ['star', 'black', 1], look: 'ex', from: 'swsh',
        text: 'Pokémon V: la V dopo il nome, carta tutta lucida con il bordo argentato.' },
      { name: 'Olografica Rara VMAX', sym: ['star', 'black', 1], look: 'ex', from: 'swsh',
        text: 'Pokémon VMAX: il Pokémon gigante che esce dal riquadro, carta tutta lucida, VMAX dopo il nome.' },
      { name: 'Olografica Rara VSTAR', sym: ['star', 'black', 1], look: 'ex', from: 'swsh',
        text: 'Pokémon V ASTRO (VSTAR in inglese): carta lucida con la potenza ASTRO, usabile una sola volta a partita.' },
      { name: 'Rara Lucente', sym: null, look: 'radiant', from: '',
        text: 'Pokémon Lucenti (Radiant): il nome finisce con "Lucente", l\'illustrazione brilla a scaglie. Pochissime carte, una per espansione nelle ultime di Spada e Scudo.' },
      { name: 'Allenatore d\'arte completa', sym: ['star', 'black', 1], look: 'full', from: '',
        text: 'Allenatori a figura intera della Galleria degli Allenatori: le carte con il numero che inizia per TG.' },
      { name: 'Shiny rare V', label: 'Rara cromatica V', sym: null, look: 'shiny', from: '',
        text: 'Pokémon V cromatici del caveau cromatico di Destino Splendente (numeri che iniziano per SV).' },
      { name: 'Shiny rare VMAX', label: 'Rara cromatica VMAX', sym: null, look: 'shiny', from: '',
        text: 'Pokémon VMAX cromatici del caveau cromatico di Destino Splendente.' },
    ],
  },
  {
    title: 'In tutte le epoche',
    note: 'Prima di Scarlatto e Violetto il segnale più sicuro di una carta speciale è il numero: se è più alto del totale del set, è una segreta.',
    items: [
      { name: 'Segreto rara', sym: null, badge: '210/198', look: 'rainbow', from: '',
        text: 'Numero più alto del totale del set (es. 210/198): carte arcobaleno, dorate o a figura intera, che non sono nella lista "ufficiale" del set.' },
    ],
  },
];

// Simboli disegnati su un tassello chiaro, come sono stampati sulla carta (neri, argentati o dorati).
const FILL = { black: '#16181d', silver: '#c3c8d2', gold: '#e2ad12' };
const STAR = 'M5 0.4 6.35 3.6 9.75 3.9 7.15 6.15 7.95 9.5 5 7.7 2.05 9.5 2.85 6.15 0.25 3.9 3.65 3.6Z';
export function raritySymbol(sym, badge) {
  if (!sym) return `<span class="rar-sym text">${badge ?? 'vedi carta'}</span>`;
  const [shape, color, n] = sym;
  const fill = FILL[color];
  const one = i => {
    const x = i * 11;
    if (shape === 'circle') return `<circle cx="${x + 5}" cy="5" r="3.6" fill="${fill}"/>`;
    if (shape === 'diamond') return `<path d="M${x + 5} 0.8 ${x + 9} 5 ${x + 5} 9.2 ${x + 1} 5Z" fill="${fill}"/>`;
    return `<path d="${STAR}" transform="translate(${x} 0)" fill="${fill}" stroke="#5a4a12" stroke-width="${color === 'black' ? 0 : 0.5}"/>`;
  };
  return `<span class="rar-sym"><svg viewBox="0 0 ${n * 11 - 1} 10" width="${(n * 11 - 1) * 1.6}" height="16" aria-hidden="true">
    ${Array.from({ length: n }, (_, i) => one(i)).join('')}</svg></span>`;
}

// Disegno della carta (60×84): cornice, illustrazione e testo, con l'effetto tipico di quella rarità.
// Sfumature condivise dai disegni: una sola volta nella pagina (e non dentro un riquadro chiuso, dove non verrebbero lette).
export const RARITY_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <linearGradient id="g-holo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fd3ff"/><stop offset=".35" stop-color="#d79bff"/>
      <stop offset=".65" stop-color="#ffe17a"/><stop offset="1" stop-color="#8affc1"/></linearGradient>
    <linearGradient id="g-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1b0"/><stop offset=".5" stop-color="#d9a514"/><stop offset="1" stop-color="#8a6508"/></linearGradient>
    <linearGradient id="g-silver" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3f5f9"/><stop offset=".5" stop-color="#aab1bd"/><stop offset="1" stop-color="#e6e9ef"/></linearGradient>
    <linearGradient id="g-scene" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb37a"/><stop offset=".55" stop-color="#ff7ab0"/><stop offset=".56" stop-color="#3f9b6b"/><stop offset="1" stop-color="#25694a"/></linearGradient>
    <linearGradient id="g-art" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc7e8"/><stop offset="1" stop-color="#5d8db5"/></linearGradient>
  </defs></svg>`;

export function rarityLook(look) {
  const text = (y, fill = '#3a3d46') => `<rect x="8" y="${y}" width="44" height="3" rx="1.5" fill="${fill}" opacity=".55"/><rect x="8" y="${y + 6}" width="32" height="3" rx="1.5" fill="${fill}" opacity=".55"/>`;
  const mon = (fill = '#f2c14e') => `<circle cx="30" cy="27" r="9" fill="${fill}"/><circle cx="26.5" cy="25" r="1.4" fill="#222"/><circle cx="33.5" cy="25" r="1.4" fill="#222"/>`;
  const framed = (art, card = '#f4f1e6', border = '#f2cf3a') => `<rect x="1" y="1" width="58" height="82" rx="4" fill="${border}"/>
    <rect x="4" y="4" width="52" height="76" rx="2" fill="${card}"/>
    <rect x="8" y="8" width="44" height="6" rx="1" fill="#3a3d46" opacity=".25"/>
    <rect x="8" y="16" width="44" height="26" fill="${art}"/>${mon()}${text(50)}${text(64)}`;
  const fullBleed = (bg, extra = '', lines = '#ffffff') => `<rect x="1" y="1" width="58" height="82" rx="4" fill="${bg}"/>${extra}
    <circle cx="30" cy="40" r="15" fill="#f2c14e"/><circle cx="25" cy="37" r="2" fill="#222"/><circle cx="35" cy="37" r="2" fill="#222"/>
    <rect x="6" y="6" width="34" height="5" rx="1" fill="${lines}" opacity=".7"/>${text(66, lines)}`;
  const ridges = Array.from({ length: 9 }, (_, i) => `<line x1="${i * 8 - 10}" y1="84" x2="${i * 8 + 20}" y2="0" stroke="#fff" stroke-opacity=".18" stroke-width="1.2"/>`).join('');
  const sparkles = [[12, 18], [46, 14], [50, 52], [10, 58], [40, 30]].map(([x, y]) =>
    `<path d="M${x} ${y - 3} L${x + 1} ${y - 1} ${x + 3} ${y} ${x + 1} ${y + 1} ${x} ${y + 3} ${x - 1} ${y + 1} ${x - 3} ${y} ${x - 1} ${y - 1}Z" fill="#fff"/>`).join('');
  const body = {
    plain: framed('url(#g-art)'),
    holo: framed('url(#g-holo)'),
    promo: framed('url(#g-art)') + '<rect x="34" y="72" width="20" height="7" rx="2" fill="#16181d"/><text x="44" y="77.6" font-size="5" fill="#fff" text-anchor="middle" font-weight="700">PROMO</text>',
    ex: framed('url(#g-holo)', 'url(#g-silver)', '#c9ced8'),
    full: fullBleed('url(#g-silver)', ridges, '#2a2d35'),
    scene: fullBleed('url(#g-scene)', '<circle cx="47" cy="14" r="5" fill="#fff4c2"/>'),
    gold: fullBleed('url(#g-gold)', ridges, '#4d3a05'),
    rainbow: fullBleed('url(#g-holo)', ridges, '#2a2d35'),
    shiny: fullBleed('url(#g-silver)', sparkles, '#2a2d35').replace(/#f2c14e/g, '#8fd0ff'),
    ace: framed('url(#g-holo)') + '<rect x="4" y="72" width="52" height="8" fill="url(#g-holo)"/><text x="30" y="78" font-size="5" fill="#16181d" text-anchor="middle" font-weight="800">ASSO TATTICO</text>',
    radiant: framed('url(#g-holo)', '#f4f1e6', '#c9ced8') + sparkles,
    bw: fullBleed('#16181d', '<rect x="30" y="1" width="29" height="82" rx="4" fill="#f4f1e6"/>', '#8d93a3'),
  }[look] ?? framed('url(#g-art)');
  return `<svg class="rar-look" viewBox="0 0 60 84" aria-hidden="true">${body}</svg>`;
}

// Dove guardare: schema della carta con il riquadro in basso dove ci sono sigla, numero e simbolo.
export const RARITY_WHERE = `<svg class="rar-where" viewBox="0 0 320 150" role="img" aria-label="Il simbolo di rarità è in basso, accanto al numero della carta">
  <rect x="10" y="8" width="96" height="134" rx="7" fill="#f2cf3a"/><rect x="15" y="13" width="86" height="124" rx="3" fill="#f4f1e6"/>
  <rect x="21" y="20" width="74" height="44" fill="#9cc7e8"/><circle cx="58" cy="42" r="13" fill="#f2c14e"/>
  <rect x="21" y="72" width="70" height="4" rx="2" fill="#3a3d46" opacity=".4"/><rect x="21" y="82" width="54" height="4" rx="2" fill="#3a3d46" opacity=".4"/>
  <rect x="18" y="118" width="58" height="15" rx="3" fill="none" stroke="#e3350d" stroke-width="2"/>
  <text x="22" y="129" font-size="8" fill="#16181d" font-weight="700">G</text><text x="31" y="129" font-size="7" fill="#16181d">081/198</text>
  <path d="M69 121.5 70.3 124.6 73.6 124.9 71.1 127.1 71.8 130.3 69 128.6 66.2 130.3 66.9 127.1 64.4 124.9 67.7 124.6Z" fill="#16181d"/>
  <path d="M78 126 H134" stroke="#e3350d" stroke-width="2"/>
  <text x="140" y="112" font-size="12" fill="currentColor" font-weight="700">Guarda qui</text>
  <text x="140" y="128" font-size="10.5" fill="currentColor">lettera, numero/totale</text>
  <text x="140" y="142" font-size="10.5" fill="currentColor">e simbolo di rarità</text>
  <text x="140" y="30" font-size="10.5" fill="currentColor">Da Spada e Scudo in poi:</text>
  <text x="140" y="44" font-size="10.5" fill="currentColor">in basso a sinistra.</text>
  <text x="140" y="64" font-size="10.5" fill="currentColor">Fino a Sole e Luna:</text>
  <text x="140" y="78" font-size="10.5" fill="currentColor">in basso a destra.</text>
</svg>`;
