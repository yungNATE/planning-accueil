// @ts-check
/**
 * Lecture d'un planning mensuel « grille » (jours en colonnes, employés en lignes).
 * Module pur : il reçoit un classeur déjà lu par SheetJS (XLSX.read) et n'utilise aucune API Node,
 * il tourne aussi dans le navigateur (page d'ajout).
 *
 * Le mois du planning vient uniquement du nom du fichier (options.source) ; les jours de la grille
 * servent à fixer l'année si elle manque et à vérifier la cohérence.
 * Pour que les lignes et colonnes masquées et les dates Excel soient reconnues,
 * lire le classeur avec { cellNF: true, cellStyles: true }.
 */
import {
  normalizeText, toIso, parseIso, addDays, weekdayIndex, daysInMonth, formatDateFr, monthLabel, excelSerialToIso,
} from './util.js';
import {
  nameKey, cleanName, displayName, slugify, looksLikeName, levenshtein, normalizeAliases,
} from './names.js';

/* ------------------------------------------------------------------ */
/* Vocabulaire                                                         */
/* ------------------------------------------------------------------ */

/** Mois en toutes lettres ou abrégés, en français et en anglais (sans accents, en majuscules). */
const MONTH_TOKENS = new Map([
  ['JANVIER', 1], ['JANV', 1], ['JAN', 1], ['JANUARY', 1],
  ['FEVRIER', 2], ['FEVR', 2], ['FEV', 2], ['FEB', 2], ['FEBRUARY', 2],
  ['MARS', 3], ['MARCH', 3],
  ['AVRIL', 4], ['AVR', 4], ['APRIL', 4], ['APR', 4],
  ['MAI', 5], ['MAY', 5],
  ['JUIN', 6], ['JUNE', 6], ['JUN', 6],
  ['JUILLET', 7], ['JUIL', 7], ['JULY', 7], ['JUL', 7],
  ['AOUT', 8], ['AUGUST', 8], ['AUG', 8],
  ['SEPTEMBRE', 9], ['SEPT', 9], ['SEP', 9], ['SEPTEMBER', 9],
  ['OCTOBRE', 10], ['OCT', 10], ['OCTOBER', 10],
  ['NOVEMBRE', 11], ['NOV', 11], ['NOVEMBER', 11],
  ['DECEMBRE', 12], ['DEC', 12], ['DECEMBER', 12],
]);

/** Jours de la semaine (0 = lundi), en toutes lettres ou abrégés, en français et en anglais. */
const WEEKDAY_TOKENS = new Map([
  ['LUNDI', 0], ['LUN', 0], ['MONDAY', 0], ['MON', 0],
  ['MARDI', 1], ['MAR', 1], ['TUESDAY', 1], ['TUE', 1],
  ['MERCREDI', 2], ['MER', 2], ['WEDNESDAY', 2], ['WED', 2],
  ['JEUDI', 3], ['JEU', 3], ['THURSDAY', 3], ['THU', 3],
  ['VENDREDI', 4], ['VEN', 4], ['FRIDAY', 4], ['FRI', 4],
  ['SAMEDI', 5], ['SAM', 5], ['SATURDAY', 5], ['SAT', 5],
  ['DIMANCHE', 6], ['DIM', 6], ['SUNDAY', 6], ['SUN', 6],
]);

const byLength = (/** @type {string[]} */ words) => [...words].sort((a, b) => b.length - a.length).join('|');

/** « LUNDI 28 », « JEUDI 1ER », « LUN. 5 », « MARDI 29/09 », « MERCREDI 30 SEPTEMBRE », « MONDAY 28 » */
const HEADER_RE = new RegExp(
  `^(${byLength([...WEEKDAY_TOKENS.keys()])})\\.?\\s*(\\d{1,2})\\s*(?:ER|E)?`
  + '(?:\\s*[/.-]\\s*(\\d{1,2})(?:\\s*[/.-]\\s*(\\d{2,4}))?|\\s+([A-Z]+)\\.?(?:\\s+(\\d{2,4}))?)?$',
);

/** Une heure : « 8 », « 8H », « 8H30 », « 08:30 », « 8.30 » */
const TIME = '(\\d{1,2})(?:\\s*(?:H|:|\\.)\\s*(\\d{2})?)?(?!\\d)';
/**
 * Un créneau : « 8H-15H30 », « 8h à 15h », « de 8h à 15h », « 8H>15H », « 08:00 – 12:00 ».
 * Le premier groupe (début de texte ou caractère non numérique) remplace un lookbehind,
 * non pris en charge par Safari avant iOS 16.4.
 */
const RANGE_RE = new RegExp(`(^|[^\\d])(?:DE\\s+)?${TIME}\\s*(?:-|>|~|→|\\bAU\\b|\\bA\\b|\\bJUSQU\\s*A\\b)\\s*${TIME}`, 'g');

/** Textes de la colonne des noms qui ne sont pas des personnes */
const NOT_A_NAME = new Set(['JOURS', 'JOUR', 'NOM', 'NOMS', 'EMPLOYE', 'EMPLOYES', 'PRENOM', 'PRENOMS', 'TOTAL', 'SEMAINE', 'LEGENDE']);
/** Longueur minimale des deux noms pour un rapprochement automatique à une lettre près. */
const FUZZY_MIN_LENGTH = 5;

/**
 * @typedef {{ start: string, end: string, overnight: boolean }} Slot
 *   start et end au format « HH:MM » (heure locale de Paris) ; end peut valoir « 24:00 ».
 *   overnight = la fin tombe le lendemain.
 * @typedef {{ raw: string, cell: string, slots: Slot[] }} DayEntry
 * @typedef {{ name: string, key: string, slug: string, slotCount: number, days: Record<string, DayEntry> }} Employee
 * @typedef {{ message: string, cell?: string }} Issue
 * @typedef {{
 *   ok: boolean, source: string, sheet: string, title: string,
 *   month: string, start: string, end: string, days: string[],
 *   employees: Employee[], warnings: Issue[], errors: Issue[]
 * }} ParsedPlanning
 * @typedef {{ key: string, name: string }} KnownName  personne déjà présente dans un planning publié
 * @typedef {{ source?: string, aliases?: Record<string, string>, knownNames?: KnownName[], now?: Date }} ParseOptions
 */

/* ------------------------------------------------------------------ */
/* Cellules                                                            */
/* ------------------------------------------------------------------ */

/** @param {number} c index de colonne (0 = A) */
export function columnLetters(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * @param {number} r index de ligne (0 = ligne 1)
 * @param {number} c index de colonne (0 = A)
 */
export function cellAddress(r, c) {
  return `${columnLetters(c)}${r + 1}`;
}

/** @param {string} addr « C7 » → { r: 6, c: 2 } */
function decodeAddress(addr) {
  const m = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

/** @param {number} h @param {number} m */
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * Interprète le contenu d'une case.
 * - un ou plusieurs créneaux (« 15H30-23H », « 8h à 15h », « 08:00-12:00 », « 8H-12H / 14H-18H », « 8-15 ») → work
 * - créneaux accompagnés de chiffres non reconnus (« 8H-12H / 14H ») → partial : créneaux gardés, à signaler
 * - vide, « RH », « MA », « CP », tout texte sans chiffre → off
 * - texte avec des chiffres mais aucun créneau reconnu → invalid (journée OFF, à signaler)
 * @param {unknown} value
 * @returns {{ status: 'work' | 'partial' | 'off' | 'invalid', slots: Slot[] }}
 */
export function parseCell(value) {
  const text = normalizeText(value);
  if (!text) return { status: 'off', slots: [] };
  const bare = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text);
  /** @type {{ whole: string, parts: (string | undefined)[] }[]} */
  const matches = bare
    ? [{ whole: text, parts: [bare[1], undefined, bare[2], undefined] }]
    : [...text.matchAll(RANGE_RE)]
      .filter((m) => /[H:.]/.test(m[0].slice(m[1].length))) // « 10-05 » au milieu d'un texte n'est pas un créneau
      .map((m) => ({ whole: m[0], parts: [m[2], m[3], m[4], m[5]] }));
  if (!matches.length) return { status: /\d/.test(text) ? 'invalid' : 'off', slots: [] };

  /** @type {Slot[]} */
  const slots = [];
  let doubtful = false;
  let rest = text;
  for (const { whole, parts } of matches) {
    rest = rest.replace(whole, ' ');
    const [sh, sm, eh, em] = parts.map((x) => Number(x ?? 0));
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (sh > 23 || eh > 24 || sm > 59 || em > 59 || (eh === 24 && em > 0) || startMin === endMin) {
      doubtful = true;
      continue;
    }
    slots.push({ start: hhmm(sh, sm), end: hhmm(eh, em), overnight: endMin < startMin });
  }
  if (/\d/.test(rest)) doubtful = true;
  if (!slots.length) return { status: 'invalid', slots: [] };
  slots.sort((a, b) => a.start.localeCompare(b.start));
  return { status: doubtful ? 'partial' : 'work', slots };
}

/** Format de nombre Excel qui affiche une date (jour ou année), et non une heure ou un nombre. */
function isDateFormat(/** @type {unknown} */ z) {
  if (typeof z !== 'string' || !z || z === 'General') return false;
  const stripped = z.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dy]/i.test(stripped);
}

/** @param {any} cell cellule SheetJS */
function cellText(cell) {
  if (!cell || cell.t === 'e' || cell.t === 'z') return '';
  const v = cell.w ?? cell.v;
  return v == null ? '' : String(v).trim();
}

/** Contenu visible d'une feuille (sans les lignes, colonnes ni cellules vides) */
function hasContent(/** @type {any} */ ws) {
  return !!ws && Object.keys(ws).some((k) => !k.startsWith('!') && cellText(ws[k]) !== '');
}

/**
 * Indexe les cellules non vides et visibles, et les fusions.
 * @param {any} ws
 * @param {boolean} date1904
 */
function readSheet(ws, date1904) {
  const hiddenRows = new Set((ws['!rows'] ?? []).flatMap((/** @type {any} */ row, /** @type {number} */ i) => (row?.hidden ? [i] : [])));
  const hiddenCols = new Set((ws['!cols'] ?? []).flatMap((/** @type {any} */ col, /** @type {number} */ i) => (col?.hidden ? [i] : [])));
  /** @typedef {{ r: number, c: number, addr: string, text: string, date: string | null }} SheetCell */
  /** @type {Map<string, SheetCell>} */
  const cells = new Map();
  /** @type {Map<number, SheetCell[]>} */
  const byRow = new Map();
  let maxRow = 0;
  let hiddenWithContent = 0;
  let formulasWithoutValue = 0;
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue;
    const pos = decodeAddress(key);
    if (!pos) continue;
    const raw = ws[key];
    if (raw?.f && (raw.t === 'z' || raw.v == null)) formulasWithoutValue++;
    const text = cellText(raw);
    if (!text) continue;
    if (hiddenRows.has(pos.r) || hiddenCols.has(pos.c)) {
      hiddenWithContent++;
      continue;
    }
    const date = raw.t === 'n' && isDateFormat(raw.z) && raw.v > 20000 && raw.v < 80000 ? excelSerialToIso(raw.v, date1904) : null;
    const cell = { ...pos, addr: key, text, date };
    cells.set(`${pos.r},${pos.c}`, cell);
    if (!byRow.has(pos.r)) byRow.set(pos.r, []);
    byRow.get(pos.r)?.push(cell);
    maxRow = Math.max(maxRow, pos.r);
  }
  for (const list of byRow.values()) list.sort((a, b) => a.c - b.c);
  /** @type {Map<string, { s: { r: number, c: number }, e: { r: number, c: number } }>} */
  const mergeOf = new Map();
  for (const mg of ws['!merges'] ?? []) {
    for (let r = mg.s.r; r <= mg.e.r; r++) for (let c = mg.s.c; c <= mg.e.c; c++) mergeOf.set(`${r},${c}`, mg);
    if (!hiddenRows.has(mg.s.r)) maxRow = Math.max(maxRow, mg.e.r);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  return {
    rows,
    maxRow,
    hiddenRows,
    hiddenWithContent,
    formulasWithoutValue,
    /** @param {number} r */
    row: (r) => byRow.get(r) ?? [],
    /** @param {number} r @param {number} c */
    cell: (r, c) => cells.get(`${r},${c}`),
    /** @param {number} r @param {number} c */
    text: (r, c) => cells.get(`${r},${c}`)?.text ?? '',
    /** @param {number} r @param {number} c */
    merge: (r, c) => mergeOf.get(`${r},${c}`),
    /** Valeur affichée d'une case, fusions comprises. @param {number} r @param {number} c */
    shown(r, c) {
      const mg = mergeOf.get(`${r},${c}`);
      return mg ? cells.get(`${mg.s.r},${mg.s.c}`)?.text ?? '' : cells.get(`${r},${c}`)?.text ?? '';
    },
  };
}

/* ------------------------------------------------------------------ */
/* Titre et jours                                                      */
/* ------------------------------------------------------------------ */

/** Noms de mois cherchés aussi à l'intérieur d'un mot (« PLANNINGOCTOBRE2026 ») ; les noms courts et ambigus
    (MAI, MARS, MAY…) et les abréviations ne sont reconnus que comme mots entiers. */
const MONTH_SUBSTRINGS = ['JANVIER', 'FEVRIER', 'AVRIL', 'JUILLET', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE',
  'JANUARY', 'FEBRUARY', 'APRIL', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/**
 * Mois (et année si présente) indiqués par le nom du fichier, quelles que soient la casse et les accents :
 * « PLANNING_OCTOBRE_26.xlsx », « Planning décembre.xlsx », « 2026-12 planning Décembre 2026.xlsx ».
 * @param {string} fileName
 * @returns {{ month: number, year: number | null } | { error: string }}
 */
export function monthFromFileName(fileName) {
  const name = String(fileName ?? '').split(/[\\/]/).pop() ?? '';
  const stem = normalizeText(name.replace(/\.[^.]+$/, ''));
  const tokens = stem.split(/[^A-Z0-9]+/).filter(Boolean);
  /** @type {Map<number, number>} mois → position du mot */
  const months = new Map();
  tokens.forEach((t, i) => {
    const m = MONTH_TOKENS.get(t);
    if (m && !months.has(m)) months.set(m, i);
  });
  if (!months.size) {
    for (const word of MONTH_SUBSTRINGS) {
      const m = MONTH_TOKENS.get(word);
      if (m && stem.includes(word) && !months.has(m)) months.set(m, -1);
    }
  }
  const shown = name || '(sans nom)';
  if (!months.size) {
    return { error: `Le nom du fichier « ${shown} » n’indique pas le mois : renommez-le, par exemple « Planning décembre 2026.xlsx ».` };
  }
  if (months.size > 1) {
    const list = [...months.keys()].map((m) => monthLabel(`2000-${String(m).padStart(2, '0')}`).replace(/ 2000$/, '')).join(', ');
    return { error: `Le nom du fichier « ${shown} » cite plusieurs mois (${list}) : gardez seulement celui du planning.` };
  }
  const [[month, at]] = [...months.entries()];
  // Année : juste après le mois (« OCTOBRE 26 », « OCTOBRE 2026 »), sinon n'importe où (« 2026-10 … », « …OCTOBRE2026 »)
  const next = at >= 0 ? tokens[at + 1] ?? '' : '';
  let year = /^\d{4}$/.test(next) ? Number(next) : /^\d{2}$/.test(next) ? 2000 + Number(next) : null;
  if (year === null) {
    const any = /(?:^|[^0-9])(20\d{2})(?![0-9])/.exec(stem);
    if (any) year = Number(any[1]);
  }
  return { month, year };
}

/**
 * Libellé de jour d'une cellule : texte « LUNDI 28 » ou vraie date Excel.
 * @param {{ text: string, date: string | null }} cell
 * @returns {{ weekday: number, day: number, month: number | null, exact: string | null } | null}
 */
function dayLabelOf(cell) {
  if (cell.date) {
    const { m, d } = parseIso(cell.date);
    return { weekday: weekdayIndex(cell.date), day: d, month: m, exact: cell.date };
  }
  const m = HEADER_RE.exec(normalizeText(cell.text));
  if (!m) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  let month = null;
  if (m[3]) month = Number(m[3]);
  else if (m[5]) {
    month = MONTH_TOKENS.get(m[5]) ?? null;
    if (!month) return null; // « LUNDI 5 RH » n'est pas un libellé de jour
  }
  if (month !== null && (month < 1 || month > 12)) return null;
  return { weekday: WEEKDAY_TOKENS.get(m[1]) ?? 0, day, month, exact: null };
}

/* ------------------------------------------------------------------ */
/* Planning d'une feuille                                              */
/* ------------------------------------------------------------------ */

/**
 * Lit une feuille. Renvoie null si elle ne ressemble pas à un planning (aucune ligne de jours).
 * @param {any} ws
 * @param {string} sheetName
 * @param {ParseOptions & { date1904?: boolean }} options
 * @returns {ParsedPlanning | null}
 */
function parseSheet(ws, sheetName, options) {
  const { source = '', aliases = {}, knownNames = [], now = new Date(), date1904 = false } = options;
  /** @type {Issue[]} */ const errors = [];
  /** @type {Issue[]} */ const warnings = [];
  /** @type {ParsedPlanning} */
  const result = {
    ok: false, source, sheet: sheetName, title: '', month: '', start: '', end: '', days: [], employees: [], warnings, errors,
  };
  /** @param {string} message @param {string} [cell] */
  const fail = (message, cell) => { errors.push(cell ? { message, cell } : { message }); };
  /** @param {string} message @param {string} [cell] */
  const warn = (message, cell) => { warnings.push(cell ? { message, cell } : { message }); };

  const sheet = readSheet(ws, date1904);

  /* 1. Lignes de jours : au moins 3 libellés pour ouvrir un planning ; ensuite, 1 ou 2 libellés suffisent
        (dernière semaine incomplète) si les dates suivent. */
  /** @typedef {{ r: number, c: number, addr: string, label: string, weekday: number, day: number, month: number | null, exact: string | null, date: string }} DayColumn */
  /** @type {{ r: number, cols: DayColumn[], strong: boolean }[]} */
  const headers = [];

  for (const r of sheet.rows) {
    /** @type {DayColumn[]} */
    const cols = [];
    for (const cell of sheet.row(r)) {
      const label = dayLabelOf(cell);
      if (label) cols.push({ r, c: cell.c, addr: cell.addr, label: cell.text.replace(/\s+/g, ' '), ...label, date: '' });
    }
    if (cols.length >= 3 || (cols.length >= 1 && headers.length > 0)) {
      headers.push({ r, cols, strong: cols.length >= 3 });
    }
  }
  if (!headers.some((h) => h.strong)) return null;
  // Les lignes faibles avant la première ligne de jours franche ne comptent pas
  while (!headers[0].strong) headers.shift();

  /* 2. Mois (et année éventuelle) : nom du fichier uniquement */
  const fromName = monthFromFileName(source);
  if ('error' in fromName) {
    fail(fromName.error);
    return result;
  }
  const titleInfo = { ...fromName, text: String(source).replace(/\.[^.]+$/, '') };
  result.title = titleInfo.text.replace(/\s+/g, ' ');

  /* 3. Dates : la première colonne fixe le départ ; chaque colonne suivante vaut un jour de plus,
        un saut (semaine absente) est accepté et signalé, un retour en arrière est une erreur. */
  const allCols = headers.flatMap((h) => h.cols);
  const first = allCols[0];
  const month = titleInfo.month;
  /** @param {number} y */
  const startCandidates = (y) => [-1, 0, 1].flatMap((delta) => {
    let m = month + delta;
    let yy = y;
    if (m < 1) { m = 12; yy -= 1; }
    if (m > 12) { m = 1; yy += 1; }
    if (first.month !== null && first.month !== m) return [];
    if (first.day > daysInMonth(yy, m)) return [];
    const iso = toIso(yy, m, first.day);
    if (weekdayIndex(iso) !== first.weekday) return [];
    let overlap = 0;
    for (let i = 0; i < allCols.length; i++) if (addDays(iso, i).startsWith(`${y}-${String(month).padStart(2, '0')}`)) overlap++;
    return [{ iso, overlap, year: y }];
  });

  let year = titleInfo.year;
  let start = '';
  if (first.exact) {
    start = first.exact;
    if (!year) year = parseIso(start).m === month ? parseIso(start).y : parseIso(addDays(start, 15)).y;
  } else if (year) {
    start = startCandidates(year).sort((a, b) => b.overlap - a.overlap)[0]?.iso ?? '';
  } else {
    // Année absente : celle, autour d'aujourd'hui, où les jours de la semaine correspondent
    const thisYear = now.getUTCFullYear();
    const found = [thisYear, thisYear + 1, thisYear - 1].flatMap(startCandidates).sort((a, b) => b.overlap - a.overlap)[0];
    if (found) {
      start = found.iso;
      year = found.year;
      warn(`Le nom du fichier n’indique pas l’année : ${year} a été retenue d’après les jours de la semaine.`);
    }
  }
  if (!start || !year) {
    fail(`L’en-tête « ${first.label} » ne correspond à aucune date autour de ${monthLabel(`${year ?? now.getUTCFullYear()}-${String(month).padStart(2, '0')}`)}, le mois indiqué par le nom du fichier : vérifiez le fichier ou son nom.`, first.addr);
    return result;
  }
  result.month = `${year}-${String(month).padStart(2, '0')}`;

  /** @type {Set<number>} */
  const ignoredRows = new Set();
  let previous = '';
  for (const header of headers) {
    for (let i = 0; i < header.cols.length; i++) {
      const col = header.cols[i];
      const expected = previous ? addDays(previous, 1) : start;
      /** @param {string} iso */
      const fits = (iso) => parseIso(iso).d === col.day && weekdayIndex(iso) === col.weekday && (col.month === null || parseIso(iso).m === col.month);
      let date = '';
      if (col.exact) date = col.exact;
      else if (fits(expected)) date = expected;
      else {
        for (let k = 1; k <= 62 && !date; k++) if (fits(addDays(expected, k))) date = addDays(expected, k);
      }
      if (!date || (previous && date <= previous)) {
        if (!header.strong && i === 0) {
          // Ligne qui ressemble à des jours mais ne suit pas la séquence (note, légende…) : ignorée
          warn(`Ligne ${header.r + 1} ignorée : « ${col.label} » ne suit pas les jours précédents.`, col.addr);
          ignoredRows.add(header.r);
          break;
        }
        fail(`En-tête « ${col.label} » incohérent : à cette position, le planning devrait être au ${formatDateFr(expected)} ou après.`, col.addr);
        date = expected;
      } else if (date !== expected && previous) {
        const lastMissing = addDays(date, -1);
        warn(`Jours absents du planning : du ${formatDateFr(expected, { weekday: false })} au ${formatDateFr(lastMissing, { weekday: false })}. Ces jours ne seront dans aucun agenda.`, col.addr);
      }
      col.date = date;
      previous = date;
    }
  }
  if (errors.length) return result;
  const usedHeaders = headers.filter((h) => !ignoredRows.has(h.r));
  const usedCols = usedHeaders.flatMap((h) => h.cols);
  result.start = usedCols[0].date;
  result.end = usedCols[usedCols.length - 1].date;
  result.days = usedCols.map((col) => col.date);

  // Le nom du fichier désigne-t-il bien le mois qui occupe l'essentiel du planning ?
  /** @type {Map<string, number>} */
  const perMonth = new Map();
  for (const d of result.days) perMonth.set(d.slice(0, 7), (perMonth.get(d.slice(0, 7)) ?? 0) + 1);
  const [mainMonth, mainCount] = [...perMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!perMonth.has(result.month)) {
    fail(`Aucun jour de ce planning (du ${formatDateFr(result.start, { weekday: false })} au ${formatDateFr(result.end, { weekday: false })}) ne tombe en ${monthLabel(result.month)}, le mois indiqué par le nom du fichier : vérifiez le fichier ou son nom.`);
    return result;
  }
  if (mainMonth !== result.month && mainCount > (perMonth.get(result.month) ?? 0)) {
    warn(`Le nom du fichier indique ${monthLabel(result.month)}, mais la plupart des jours sont en ${monthLabel(mainMonth)}. Le planning est classé en ${monthLabel(result.month)} : vérifiez le nom du fichier.`);
  }

  /* 4. Lignes d'employés, bloc par bloc */
  /** @typedef {{ date: string, cell: string, texts: { text: string, cell: string }[] }} RawDay */
  /** @typedef {{ block: number, rawName: string, nameCell: string, key: string, hasData: boolean, days: RawDay[] }} RawRow */
  /** @type {RawRow[]} */
  const rows = [];
  usedHeaders.forEach((header, blockIndex) => {
    const nextHeader = usedHeaders.find((h) => h.r > header.r);
    const lastRow = nextHeader ? nextHeader.r - 1 : sheet.maxRow;
    const firstDayCol = header.cols[0].c;
    const dayCols = new Set(header.cols.map((col) => col.c));
    if (firstDayCol === 0) {
      fail('Les jours commencent en colonne A : il n’y a pas de colonne pour les noms.', header.cols[0].addr);
      return;
    }
    const nameLetter = columnLetters(firstDayCol - 1);
    /** @type {Set<number>} */
    const consumed = new Set();

    /** Texte d'une case de jour, en tenant compte d'une fusion horizontale sur plusieurs jours */
    const dayText = (/** @type {number} */ r, /** @type {number} */ c) => {
      const own = sheet.text(r, c);
      if (own) return { text: own, cell: cellAddress(r, c) };
      const mg = sheet.merge(r, c);
      if (mg && mg.s.r === r && mg.s.c < c && dayCols.has(mg.s.c)) {
        const text = sheet.text(mg.s.r, mg.s.c);
        if (text) return { text, cell: cellAddress(mg.s.r, mg.s.c) };
      }
      return null;
    };

    /** Nom d'une ligne : colonne juste avant les jours, sinon plus à gauche (colonne vide intercalée) */
    const findName = (/** @type {number} */ top, /** @type {number} */ bottom) => {
      for (let c = firstDayCol - 1; c >= 0; c--) {
        /** @type {Map<string, { raw: string, cell: string }>} */
        const names = new Map();
        for (let rr = top; rr <= bottom; rr++) {
          if (sheet.hiddenRows.has(rr)) continue;
          const raw = sheet.shown(rr, c);
          if (!raw || dayLabelOf({ text: raw, date: null })) continue;
          // Plus à gauche que la colonne habituelle : seulement un vrai prénom (pas un numéro de semaine…)
          if (c < firstDayCol - 1 && (!looksLikeName(cleanName(raw)) || NOT_A_NAME.has(nameKey(cleanName(raw))))) continue;
          const key = nameKey(cleanName(raw));
          if (key && !names.has(key)) names.set(key, { raw, cell: cellAddress(rr, c) });
        }
        if (names.size) return names;
      }
      return new Map();
    };

    for (let r = header.r + 1; r <= lastRow; r++) {
      if (consumed.has(r) || sheet.hiddenRows.has(r)) continue;
      if (!header.cols.some((col) => dayText(r, col.c))) continue;

      // Hauteur de la ligne d'employé : étendue verticale des fusions qui commencent sur cette ligne
      let bottom = r;
      for (const c of [firstDayCol - 1, ...header.cols.map((col) => col.c)]) {
        const mg = sheet.merge(r, c);
        if (mg && mg.s.r === r) bottom = Math.max(bottom, mg.e.r);
      }
      bottom = Math.min(bottom, lastRow);
      for (let rr = r; rr <= bottom; rr++) consumed.add(rr);

      const names = findName(r, bottom);
      const span = bottom > r ? `lignes ${r + 1} à ${bottom + 1}` : `ligne ${r + 1}`;
      if (names.size === 0) {
        fail(`Des horaires sont saisis ${span}, mais aucun nom n’a été trouvé en colonne ${nameLetter}.`, cellAddress(r, firstDayCol - 1));
        continue;
      }
      if (names.size > 1) {
        fail(`Plusieurs noms pour une même ligne d’horaires (${span}) : ${[...names.values()].map((n) => n.raw).join(', ')}.`, cellAddress(r, firstDayCol - 1));
        continue;
      }
      const [[key, name]] = [...names.entries()];
      rows.push({
        block: blockIndex,
        rawName: name.raw,
        nameCell: name.cell,
        key,
        hasData: true,
        days: header.cols.map((col) => {
          const texts = [];
          for (let rr = r; rr <= bottom; rr++) {
            if (sheet.hiddenRows.has(rr)) continue;
            const t = rr === r ? dayText(rr, col.c) : (sheet.text(rr, col.c) ? { text: sheet.text(rr, col.c), cell: cellAddress(rr, col.c) } : null);
            if (t) texts.push(t);
          }
          return { date: col.date, cell: cellAddress(r, col.c), texts };
        }),
      });
    }

    // Noms sans aucune case remplie dans ce bloc (semaine entièrement vide)
    for (let r = header.r + 1; r <= lastRow; r++) {
      if (consumed.has(r) || sheet.hiddenRows.has(r)) continue;
      const raw = sheet.text(r, firstDayCol - 1);
      if (!raw || !looksLikeName(cleanName(raw)) || NOT_A_NAME.has(nameKey(cleanName(raw)))) continue;
      const mg = sheet.merge(r, firstDayCol - 1);
      const bottom = mg && mg.s.r === r ? Math.min(mg.e.r, lastRow) : r;
      for (let rr = r; rr <= bottom; rr++) consumed.add(rr);
      rows.push({
        block: blockIndex,
        rawName: raw,
        nameCell: cellAddress(r, firstDayCol - 1),
        key: nameKey(cleanName(raw)),
        hasData: false,
        days: header.cols.map((col) => ({ date: col.date, cell: cellAddress(r, col.c), texts: [] })),
      });
    }
  });
  if (errors.length) return result;

  /* 5. Alias, puis rapprochement des noms à une lettre près (faute de frappe),
        dans le fichier puis avec les personnes des plannings déjà publiés */
  const aliasMap = normalizeAliases(aliases);
  const pinned = new Set([...aliasMap.keys(), ...aliasMap.values()]);
  for (const row of rows) row.key = aliasMap.get(row.key) ?? row.key;

  const known = new Map(knownNames.map((k) => [k.key, k.name]));
  /** @type {Map<string, number>} */
  const freq = new Map();
  for (const row of rows) if (row.hasData) freq.set(row.key, (freq.get(row.key) ?? 0) + 1);
  /** @param {string} key */
  const blocksOf = (key) => new Set(rows.filter((row) => row.key === key).map((row) => row.block));
  for (const key of [...freq.keys()]) {
    if (pinned.has(key) || key.length < FUZZY_MIN_LENGTH || !freq.has(key)) continue;
    const target = [...freq.keys()]
      .filter((k) => k !== key && k.length >= FUZZY_MIN_LENGTH && !pinned.has(k) && levenshtein(k, key) === 1 && (freq.get(k) ?? 0) > (freq.get(key) ?? 0))
      .sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))[0];
    if (!target) continue;
    const affected = rows.filter((row) => row.key === key);
    if ([...blocksOf(key)].some((b) => blocksOf(target).has(b))) {
      warn(`« ${affected[0].rawName} » et un nom très proche apparaissent dans la même semaine : ils sont traités comme deux personnes différentes.`, affected[0].nameCell);
      continue;
    }
    for (const row of affected) {
      warn(`« ${row.rawName} » a été considéré comme « ${displayName(target)} » (une lettre de différence). Si ce sont deux personnes différentes, il faut l’indiquer dans config/aliases.json.`, row.nameCell);
      row.key = target;
    }
    freq.set(target, (freq.get(target) ?? 0) + (freq.get(key) ?? 0));
    freq.delete(key);
  }
  // Faute de frappe sur tout le mois : nom inconnu à une lettre d'une personne des mois précédents
  for (const key of [...freq.keys()]) {
    if (known.has(key) || pinned.has(key) || key.length < FUZZY_MIN_LENGTH) continue;
    const matches = [...known.keys()].filter((k) => k.length >= FUZZY_MIN_LENGTH && !freq.has(k) && levenshtein(k, key) === 1);
    if (matches.length !== 1) continue;
    const affected = rows.filter((row) => row.key === key);
    warn(`« ${affected[0].rawName} » n’apparaît dans aucun planning précédent et ressemble à « ${known.get(matches[0])} » : il a été considéré comme « ${known.get(matches[0])} ». Si c’est une nouvelle personne, il faut l’indiquer dans config/aliases.json.`, affected[0].nameCell);
    for (const row of affected) row.key = matches[0];
    freq.set(matches[0], freq.get(key) ?? 0);
    freq.delete(key);
  }

  /* 6. Assemblage par employé et lecture des horaires. Une personne sans aucune case remplie
        dans tout le planning est ignorée (texte isolé de la colonne des noms, légende…). */
  /** @type {Map<string, { key: string, rawForms: Map<string, number>, days: Record<string, DayEntry> }>} */
  const people = new Map();
  for (const row of rows) {
    if (!freq.has(row.key)) continue;
    let person = people.get(row.key);
    if (!person) {
      person = { key: row.key, rawForms: new Map(), days: {} };
      people.set(row.key, person);
    }
    const clean = cleanName(row.rawName);
    if (nameKey(clean) === row.key) person.rawForms.set(clean, (person.rawForms.get(clean) ?? 0) + 1);
    for (const day of row.days) {
      if (person.days[day.date]) {
        fail(`« ${clean} » apparaît deux fois pour le ${formatDateFr(day.date)} (cellules ${person.days[day.date].cell} et ${day.cell}). Si ce sont deux personnes, distinguez-les dans le fichier, par exemple « ${clean} B. » et « ${clean} L. ».`, day.cell);
        continue;
      }
      /** @type {Slot[]} */
      const slots = [];
      for (const { text, cell } of day.texts) {
        const parsed = parseCell(text);
        const who = `${displayName(clean)}, ${formatDateFr(day.date)}`;
        if (parsed.status === 'invalid') warn(`Horaire non reconnu « ${text} » (${who}) : la journée est considérée comme OFF.`, cell);
        if (parsed.status === 'partial') warn(`Horaire en partie reconnu « ${text} » (${who}) : seuls ${parsed.slots.map((s) => `${s.start}–${s.end}`).join(' et ')} sont retenus.`, cell);
        slots.push(...parsed.slots);
      }
      slots.sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < slots.length; i++) {
        const prev = slots[i - 1];
        if (!prev.overnight && slots[i].start < prev.end) {
          warn(`Créneaux qui se chevauchent (${displayName(clean)}, ${formatDateFr(day.date)}) : ${prev.start}–${prev.end} et ${slots[i].start}–${slots[i].end}.`, day.texts[0]?.cell ?? day.cell);
        }
      }
      person.days[day.date] = {
        raw: day.texts.map((t) => t.text).join(' / '),
        cell: day.texts[0]?.cell ?? day.cell,
        slots,
      };
    }
  }

  if (sheet.hiddenWithContent) warn(`${sheet.hiddenWithContent} case(s) remplie(s) dans des lignes ou colonnes masquées ont été ignorées, comme à l’affichage.`);
  if (sheet.formulasWithoutValue) warn('Le fichier contient des formules dont le résultat n’est pas enregistré : ouvrez-le dans Excel et enregistrez-le à nouveau pour qu’elles soient lues.');

  /** @type {Set<string>} */
  const slugs = new Set();
  result.employees = [...people.values()].map((person) => {
    const preferred = [...person.rawForms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const name = preferred ? displayName(preferred) : known.get(person.key) ?? displayName(person.key);
    const slug = slugify(person.key);
    if (slugs.has(slug)) fail(`Deux noms différents donnent le même identifiant de fichier « ${slug} » : distinguez-les dans le fichier.`);
    slugs.add(slug);
    const ordered = Object.fromEntries(Object.entries(person.days).sort(([a], [b]) => a.localeCompare(b)));
    const slotCount = Object.values(ordered).reduce((n, d) => n + d.slots.length, 0);
    return { name, key: person.key, slug, slotCount, days: ordered };
  }).sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  if (!result.employees.length) fail('Aucun employé trouvé sous les lignes de jours.');
  result.ok = errors.length === 0;
  return result;
}

/* ------------------------------------------------------------------ */
/* Classeur                                                            */
/* ------------------------------------------------------------------ */

/**
 * Lit le planning d'un classeur. Le mois vient du nom du fichier (options.source) ; si plusieurs onglets
 * visibles contiennent un planning, celui dont les jours correspondent le mieux à ce mois est retenu.
 * @param {any} workbook classeur renvoyé par XLSX.read
 * @param {ParseOptions} [options]
 * @returns {{ plannings: ParsedPlanning[], errors: Issue[] }}
 *   plannings : zéro ou un planning ; errors : problèmes qui concernent tout le fichier (aucun planning…)
 */
export function parseWorkbook(workbook, options = {}) {
  const names = /** @type {string[]} */ (workbook?.SheetNames ?? []);
  const hidden = new Set((workbook?.Workbook?.Sheets ?? []).filter((/** @type {any} */ s) => s?.Hidden).map((/** @type {any} */ s) => s.name));
  const date1904 = Boolean(workbook?.Workbook?.WBProps?.date1904);
  /** @param {string[]} list */
  const read = (list) => list
    .filter((n) => hasContent(workbook.Sheets[n]))
    .map((n) => parseSheet(workbook.Sheets[n], n, { ...options, date1904 }))
    .filter(/** @returns {p is ParsedPlanning} */ (p) => p !== null);

  let plannings = read(names.filter((n) => !hidden.has(n)));
  if (!plannings.length) plannings = read(names.filter((n) => hidden.has(n)));

  /** @type {Issue[]} */
  const errors = [];
  if (!plannings.length) {
    errors.push({
      message: names.some((n) => hasContent(workbook.Sheets[n]))
        ? 'Aucune ligne de jours trouvée (cellules du type « LUNDI 28 », « MARDI 29 »…) : ce fichier ne ressemble pas à un planning.'
        : 'Le fichier ne contient aucune feuille remplie.',
    });
  }
  // Plusieurs onglets de planning : le mois vient du nom du fichier, on garde l'onglet dont les jours y correspondent le mieux
  if (plannings.length > 1) {
    const score = (/** @type {ParsedPlanning} */ p) => (p.month ? p.days.filter((d) => d.startsWith(p.month)).length : -1);
    const best = [...plannings].sort((a, b) => Number(b.ok) - Number(a.ok) || score(b) - score(a))[0];
    if (best.month) {
      const others = plannings.filter((p) => p !== best).map((p) => `« ${p.sheet} »`).join(', ');
      best.warnings.push({ message: `Le classeur contient d’autres onglets de planning (${others}) : seul l’onglet « ${best.sheet} », dont les jours correspondent le mieux à ${monthLabel(best.month)}, est publié.` });
    }
    plannings = [best];
  }
  return { plannings, errors };
}

/**
 * Lit le planning d'un classeur (raccourci de parseWorkbook).
 * @param {any} workbook
 * @param {ParseOptions} [options]
 * @returns {ParsedPlanning}
 */
export function parsePlanning(workbook, options = {}) {
  const { plannings, errors } = parseWorkbook(workbook, options);
  if (plannings.length) return plannings[0];
  return {
    ok: false, source: options.source ?? '', sheet: '', title: '', month: '', start: '', end: '', days: [], employees: [], warnings: [], errors,
  };
}
