// @ts-check
/**
 * Outils purs (sans API Node) : normalisation de texte et dates civiles.
 * Les dates sont des chaînes « AAAA-MM-JJ » : aucun fuseau horaire n'intervient.
 */

export const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

export const WEEKDAYS_FR = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/**
 * Majuscules, sans accents, tirets typographiques remplacés par « - », espaces simples.
 * @param {unknown} value
 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * @param {number} y
 * @param {number} m mois de 1 à 12
 * @param {number} d
 */
export function toIso(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** @param {string} iso */
export function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/**
 * @param {string} iso
 * @param {number} n
 */
export function addDays(iso, n) {
  const { y, m, d } = parseIso(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Jour de la semaine, 0 = lundi … 6 = dimanche.
 * @param {string} iso
 */
export function weekdayIndex(iso) {
  const { y, m, d } = parseIso(iso);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * @param {number} y
 * @param {number} m mois de 1 à 12
 */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * « 2026-10 » → « octobre 2026 »
 * @param {string} monthKey
 */
export function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS_FR[m - 1]} ${y}`;
}

/**
 * « 2026-11-01 » → « dimanche 1er novembre 2026 »
 * @param {string} iso
 * @param {{ year?: boolean, weekday?: boolean }} [opts]
 */
export function formatDateFr(iso, opts = {}) {
  const { year = true, weekday = true } = opts;
  const { y, m, d } = parseIso(iso);
  const day = d === 1 ? '1er' : String(d);
  const parts = [];
  if (weekday) parts.push(WEEKDAYS_FR[weekdayIndex(iso)]);
  parts.push(day, MONTHS_FR[m - 1]);
  if (year) parts.push(String(y));
  return parts.join(' ');
}

/**
 * « 08:00 » → « 8h », « 15:30 » → « 15h30 »
 * @param {string} hhmm
 */
export function formatHour(hhmm) {
  const [h, m] = hhmm.split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
}

/** @param {string} s */
export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
