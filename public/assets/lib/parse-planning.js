// @ts-check
/**
 * Lecture d'un planning mensuel « grille » (jours en colonnes, employés en lignes).
 * Module pur : il reçoit un classeur déjà lu par SheetJS (XLSX.read) et n'utilise aucune API Node,
 * il peut donc aussi tourner dans un navigateur.
 */
import {
  normalizeText, toIso, parseIso, addDays, weekdayIndex, daysInMonth, formatDateFr,
} from './util.js';
import {
  nameKey, displayName, slugify, looksLikeName, levenshtein, normalizeAliases,
} from './names.js';

const MONTH_KEYS = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE'];
const WEEKDAY_KEYS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'];
const TITLE_RE = new RegExp(`(?:^|\\s)(${MONTH_KEYS.join('|')})\\s+(\\d{4})(?:\\s|$)`);
const HEADER_RE = new RegExp(`^(${WEEKDAY_KEYS.join('|')})\\s+(\\d{1,2})\\s*(?:ER)?$`);
const SLOT_RE = /^(\d{1,2})\s*(?:H|:)\s*(\d{2})?\s*-\s*(\d{1,2})\s*(?:H|:)\s*(\d{2})?$/;
const NOT_A_NAME = new Set(['JOURS', 'JOUR', 'NOM', 'NOMS', 'EMPLOYE', 'EMPLOYES', 'PRENOM', 'PRENOMS', 'TOTAL']);
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
 * - « 15H30-23H », « 8h - 15h », « 08:00-12:00 », plusieurs créneaux séparés par « / » ou « + » → work
 * - vide, « RH », « MA », tout texte sans chiffre → off
 * - texte avec des chiffres mais au format inconnu → invalid (à signaler)
 * @param {unknown} value
 * @returns {{ status: 'work' | 'off' | 'invalid', slots: Slot[] }}
 */
export function parseCell(value) {
  const text = normalizeText(value);
  if (!text) return { status: 'off', slots: [] };
  const invalid = /\d/.test(text) ? { status: /** @type {const} */ ('invalid'), slots: [] } : { status: /** @type {const} */ ('off'), slots: [] };
  /** @type {Slot[]} */
  const slots = [];
  for (const part of text.split(/\s*[/+]\s*/).filter(Boolean)) {
    const m = SLOT_RE.exec(part);
    if (!m) return invalid;
    const [sh, sm, eh, em] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
    if (sh > 23 || eh > 24 || sm > 59 || em > 59 || (eh === 24 && em > 0)) return invalid;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) return invalid;
    slots.push({ start: hhmm(sh, sm), end: hhmm(eh, em), overnight: endMin < startMin });
  }
  slots.sort((a, b) => a.start.localeCompare(b.start));
  return { status: 'work', slots };
}

/* ------------------------------------------------------------------ */
/* Feuille                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {any} cell cellule SheetJS
 */
function cellText(cell) {
  if (!cell || cell.t === 'e' || cell.t === 'z') return '';
  const v = cell.w ?? cell.v;
  return v == null ? '' : String(v).trim();
}

/** @param {any} ws */
function hasContent(ws) {
  return !!ws && Object.keys(ws).some((k) => !k.startsWith('!') && cellText(ws[k]) !== '');
}

/**
 * Indexe les cellules non vides et les fusions d'une feuille.
 * @param {any} ws
 */
function readSheet(ws) {
  /** @type {Map<string, { r: number, c: number, addr: string, text: string }>} */
  const cells = new Map();
  let maxRow = 0;
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue;
    const pos = decodeAddress(key);
    const text = cellText(ws[key]);
    if (!pos || !text) continue;
    cells.set(`${pos.r},${pos.c}`, { ...pos, addr: key, text });
    maxRow = Math.max(maxRow, pos.r);
  }
  const ordered = [...cells.values()].sort((a, b) => a.r - b.r || a.c - b.c);
  /** @type {Map<string, { s: { r: number, c: number }, e: { r: number, c: number } }>} */
  const mergeOf = new Map();
  for (const mg of ws['!merges'] ?? []) {
    for (let r = mg.s.r; r <= mg.e.r; r++) for (let c = mg.s.c; c <= mg.e.c; c++) mergeOf.set(`${r},${c}`, mg);
    maxRow = Math.max(maxRow, mg.e.r);
  }
  return {
    ordered,
    maxRow,
    /** @param {number} r @param {number} c */
    text: (r, c) => cells.get(`${r},${c}`)?.text ?? '',
    /** @param {number} r @param {number} c */
    merge: (r, c) => mergeOf.get(`${r},${c}`),
    /** Valeur affichée d'une case, fusions comprises. @param {number} r @param {number} c */
    shown(r, c) {
      const mg = mergeOf.get(`${r},${c}`);
      return mg ? cells.get(`${mg.s.r},${mg.s.c}`)?.text ?? '' : cells.get(`${r},${c}`)?.text ?? '';
    },
    /** @param {number} r */
    row: (r) => ordered.filter((cell) => cell.r === r),
  };
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {any} workbook classeur renvoyé par XLSX.read
 * @param {{ source?: string, aliases?: Record<string, string> }} [options]
 * @returns {ParsedPlanning}
 */
export function parsePlanning(workbook, options = {}) {
  const { source = '', aliases = {} } = options;
  /** @type {Issue[]} */ const errors = [];
  /** @type {Issue[]} */ const warnings = [];
  /** @type {ParsedPlanning} */
  const result = {
    ok: false, source, sheet: '', title: '', month: '', start: '', end: '', days: [], employees: [], warnings, errors,
  };
  /** @param {string} message @param {string} [cell] */
  const fail = (message, cell) => { errors.push(cell ? { message, cell } : { message }); };
  /** @param {string} message @param {string} [cell] */
  const warn = (message, cell) => { warnings.push(cell ? { message, cell } : { message }); };

  const sheetName = (workbook?.SheetNames ?? []).find((/** @type {string} */ n) => hasContent(workbook.Sheets[n]));
  if (!sheetName) {
    fail('Le fichier ne contient aucune feuille remplie.');
    return result;
  }
  result.sheet = sheetName;
  const sheet = readSheet(workbook.Sheets[sheetName]);

  /* 1. Titre → mois et année */
  let year = 0;
  let month = 0;
  for (const cell of sheet.ordered) {
    const m = TITLE_RE.exec(normalizeText(cell.text));
    if (m) {
      month = MONTH_KEYS.indexOf(m[1]) + 1;
      year = Number(m[2]);
      result.title = cell.text.replace(/\s+/g, ' ');
      break;
    }
  }
  if (!month) {
    fail('Titre introuvable : aucune cellule n’indique le mois et l’année (par exemple « PLANNING OCTOBRE 2026 »).');
    return result;
  }
  result.month = `${year}-${String(month).padStart(2, '0')}`;

  /* 2. Lignes d'en-têtes de jours */
  /** @typedef {{ r: number, c: number, addr: string, label: string, weekday: number, day: number, date: string }} DayColumn */
  /** @type {{ r: number, cols: DayColumn[] }[]} */
  const headers = [];
  const rowsWithCells = [...new Set(sheet.ordered.map((cell) => cell.r))];
  for (const r of rowsWithCells) {
    /** @type {DayColumn[]} */
    const cols = [];
    for (const cell of sheet.row(r)) {
      const m = HEADER_RE.exec(normalizeText(cell.text));
      if (m) cols.push({ r, c: cell.c, addr: cell.addr, label: cell.text.replace(/\s+/g, ' '), weekday: WEEKDAY_KEYS.indexOf(m[1]), day: Number(m[2]), date: '' });
    }
    if (cols.length >= 3) headers.push({ r, cols });
  }
  if (!headers.length) {
    fail('Aucune ligne de jours trouvée (cellules du type « LUNDI 28 », « MARDI 29 »…).');
    return result;
  }

  /* 3. Dates : la première colonne fixe le point de départ, puis un jour de plus par colonne */
  const allCols = headers.flatMap((h) => h.cols);
  const first = allCols[0];
  const candidates = [-1, 0, 1].flatMap((delta) => {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    if (first.day > daysInMonth(y, m)) return [];
    const iso = toIso(y, m, first.day);
    if (weekdayIndex(iso) !== first.weekday) return [];
    // Nombre de jours de la période qui tombent dans le mois du titre
    let overlap = 0;
    for (let i = 0; i < allCols.length; i++) if (addDays(iso, i).startsWith(result.month)) overlap++;
    return [{ iso, overlap }];
  });
  if (!candidates.length) {
    fail(`L’en-tête « ${first.label} » ne correspond à aucune date autour du mois du titre (${result.title}).`, first.addr);
    return result;
  }
  const start = candidates.sort((a, b) => b.overlap - a.overlap)[0].iso;
  allCols.forEach((col, i) => {
    const iso = addDays(start, i);
    if (parseIso(iso).d !== col.day || weekdayIndex(iso) !== col.weekday) {
      fail(`En-tête « ${col.label} » incohérent : à cette position, le planning devrait être au ${formatDateFr(iso)}.`, col.addr);
    }
    col.date = iso;
  });
  if (errors.length) return result;
  result.start = allCols[0].date;
  result.end = allCols[allCols.length - 1].date;
  result.days = allCols.map((col) => col.date);

  /* 4. Lignes d'employés, bloc par bloc */
  /** @typedef {{ date: string, cell: string, texts: { text: string, cell: string }[] }} RawDay */
  /** @typedef {{ block: number, rawName: string, nameCell: string, key: string, days: RawDay[] }} RawRow */
  /** @type {RawRow[]} */
  const rows = [];
  headers.forEach((header, blockIndex) => {
    const lastRow = blockIndex + 1 < headers.length ? headers[blockIndex + 1].r - 1 : sheet.maxRow;
    const nameCol = header.cols[0].c - 1;
    if (nameCol < 0) {
      fail('Les jours commencent en colonne A : il n’y a pas de colonne pour les noms.', header.cols[0].addr);
      return;
    }
    const nameLetter = columnLetters(nameCol);
    /** @type {Set<number>} */
    const consumed = new Set();

    for (let r = header.r + 1; r <= lastRow; r++) {
      if (consumed.has(r)) continue;
      if (!header.cols.some((col) => sheet.text(r, col.c))) continue;

      // Hauteur de la ligne d'employé : étendue verticale des fusions qui commencent sur cette ligne
      let bottom = r;
      for (const c of [nameCol, ...header.cols.map((col) => col.c)]) {
        const mg = sheet.merge(r, c);
        if (mg && mg.s.r === r) bottom = Math.max(bottom, mg.e.r);
      }
      bottom = Math.min(bottom, lastRow);
      for (let rr = r; rr <= bottom; rr++) consumed.add(rr);

      /** @type {Map<string, { raw: string, cell: string }>} */
      const names = new Map();
      for (let rr = r; rr <= bottom; rr++) {
        const raw = sheet.shown(rr, nameCol);
        if (raw && !names.has(nameKey(raw))) names.set(nameKey(raw), { raw, cell: cellAddress(rr, nameCol) });
      }
      const span = bottom > r ? `lignes ${r + 1} à ${bottom + 1}` : `ligne ${r + 1}`;
      if (names.size === 0) {
        fail(`Des horaires sont saisis ${span}, mais aucun nom n’a été trouvé en colonne ${nameLetter}.`, cellAddress(r, nameCol));
        continue;
      }
      if (names.size > 1) {
        fail(`Plusieurs noms pour une même ligne d’horaires (${span}) : ${[...names.values()].map((n) => n.raw).join(', ')}.`, cellAddress(r, nameCol));
        continue;
      }
      const [[key, name]] = [...names.entries()];
      rows.push({
        block: blockIndex,
        rawName: name.raw,
        nameCell: name.cell,
        key,
        days: header.cols.map((col) => {
          const texts = [];
          for (let rr = r; rr <= bottom; rr++) {
            const text = sheet.text(rr, col.c);
            if (text) texts.push({ text, cell: cellAddress(rr, col.c) });
          }
          return { date: col.date, cell: col.addr.replace(/\d+$/, String(r + 1)), texts };
        }),
      });
    }

    // Noms sans aucune case remplie dans ce bloc : semaine entièrement OFF
    for (let r = header.r + 1; r <= lastRow; r++) {
      if (consumed.has(r)) continue;
      const raw = sheet.text(r, nameCol);
      if (!raw || !looksLikeName(raw) || NOT_A_NAME.has(nameKey(raw))) continue;
      const mg = sheet.merge(r, nameCol);
      const bottom = mg && mg.s.r === r ? Math.min(mg.e.r, lastRow) : r;
      for (let rr = r; rr <= bottom; rr++) consumed.add(rr);
      rows.push({
        block: blockIndex,
        rawName: raw,
        nameCell: cellAddress(r, nameCol),
        key: nameKey(raw),
        days: header.cols.map((col) => ({ date: col.date, cell: col.addr.replace(/\d+$/, String(r + 1)), texts: [] })),
      });
    }
  });

  /* 5. Alias, puis rapprochement des noms à une lettre près (faute de frappe) */
  const aliasMap = normalizeAliases(aliases);
  const pinned = new Set([...aliasMap.keys(), ...aliasMap.values()]);
  for (const row of rows) row.key = aliasMap.get(row.key) ?? row.key;

  /** @type {Map<string, number>} */
  const freq = new Map();
  for (const row of rows) freq.set(row.key, (freq.get(row.key) ?? 0) + 1);
  /** @param {string} key */
  const blocksOf = (key) => new Set(rows.filter((row) => row.key === key).map((row) => row.block));
  for (const key of [...freq.keys()]) {
    if (pinned.has(key) || key.length < FUZZY_MIN_LENGTH) continue;
    const target = [...freq.keys()]
      .filter((k) => k !== key && k.length >= FUZZY_MIN_LENGTH && !pinned.has(k) && levenshtein(k, key) === 1 && (freq.get(k) ?? 0) > (freq.get(key) ?? 0))
      .sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))[0];
    if (!target) continue;
    const sameBlock = [...blocksOf(key)].some((b) => blocksOf(target).has(b));
    const affected = rows.filter((row) => row.key === key);
    if (sameBlock) {
      warn(`« ${affected[0].rawName} » et un nom très proche apparaissent dans la même semaine : ils sont traités comme deux personnes différentes.`, affected[0].nameCell);
      continue;
    }
    for (const row of affected) {
      warn(`« ${row.rawName} » a été considéré comme « ${displayName(target)} » (une lettre de différence). Si ce sont deux personnes différentes, ajoutez "${row.rawName}": "${row.rawName}" dans config/aliases.json.`, row.nameCell);
      row.key = target;
    }
    freq.set(target, (freq.get(target) ?? 0) + (freq.get(key) ?? 0));
    freq.delete(key);
  }

  /* 6. Assemblage par employé et lecture des horaires */
  /** @type {Map<string, { key: string, rawForms: Map<string, number>, days: Record<string, DayEntry> }>} */
  const people = new Map();
  for (const row of rows) {
    let person = people.get(row.key);
    if (!person) {
      person = { key: row.key, rawForms: new Map(), days: {} };
      people.set(row.key, person);
    }
    if (nameKey(row.rawName) === row.key) person.rawForms.set(row.rawName, (person.rawForms.get(row.rawName) ?? 0) + 1);
    for (const day of row.days) {
      if (person.days[day.date]) {
        fail(`« ${row.rawName} » apparaît deux fois pour le ${formatDateFr(day.date)} (cellules ${person.days[day.date].cell} et ${day.cell}).`, day.cell);
        continue;
      }
      /** @type {Slot[]} */
      const slots = [];
      for (const { text, cell } of day.texts) {
        const parsed = parseCell(text);
        if (parsed.status === 'invalid') {
          warn(`Horaire non reconnu « ${text} » (${displayName(row.rawName)}, ${formatDateFr(day.date)}) : la journée est considérée comme OFF.`, cell);
        }
        slots.push(...parsed.slots);
      }
      slots.sort((a, b) => a.start.localeCompare(b.start));
      person.days[day.date] = {
        raw: day.texts.map((t) => t.text).join(' / '),
        cell: day.texts[0]?.cell ?? day.cell,
        slots,
      };
    }
  }

  /** @type {Set<string>} */
  const slugs = new Set();
  result.employees = [...people.values()].map((person) => {
    const preferred = [...person.rawForms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? person.key;
    const name = displayName(preferred);
    const slug = slugify(person.key);
    if (slugs.has(slug)) fail(`Deux noms différents donnent le même identifiant de fichier « ${slug} ».`);
    slugs.add(slug);
    const ordered = Object.fromEntries(Object.entries(person.days).sort(([a], [b]) => a.localeCompare(b)));
    const slotCount = Object.values(ordered).reduce((n, d) => n + d.slots.length, 0);
    return { name, key: person.key, slug, slotCount, days: ordered };
  }).sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  if (!result.employees.length) fail('Aucun employé trouvé sous les lignes de jours.');
  result.ok = errors.length === 0;
  return result;
}
