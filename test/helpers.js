// @ts-check
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSXModule from 'xlsx';
import { addDays, parseIso, weekdayIndex } from '../src/util.js';

/** @type {any} */
export const XLSX = /** @type {any} */ (XLSXModule).read ? XLSXModule : /** @type {any} */ (XLSXModule).default;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OCTOBER = path.join(ROOT, 'plannings', 'PLANNING_OCTOBRE_26.xlsx');

export function readOctober() {
  return XLSX.read(readFileSync(OCTOBER), { type: 'buffer' });
}

const WEEKDAYS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'];

/** Libellé d'en-tête au format du planning : « JEUDI 1ER », « LUNDI 28 ». */
export function dayLabel(/** @type {string} */ iso) {
  const { d } = parseIso(iso);
  return `${WEEKDAYS[weekdayIndex(iso)]} ${d === 1 ? '1ER' : d}`;
}

/**
 * Construit un planning synthétique au format de l'entreprise : titre, puis un bloc par semaine
 * (ligne de jours, puis une ligne par employé). Chaque employé reçoit une case par jour.
 * @param {{ title: string, start: string, weeks: number, people: Record<string, string[]>, labels?: (iso: string, i: number) => string }} spec
 */
export function buildPlanning({ title, start, weeks, people, labels = (iso) => dayLabel(iso) }) {
  /** @type {any[][]} */
  const rows = [['', '', title], []];
  for (let w = 0; w < weeks; w++) {
    const header = ['', 'JOURS'];
    for (let i = 0; i < 7; i++) header.push(labels(addDays(start, w * 7 + i), w * 7 + i));
    rows.push(header);
    for (const [name, cells] of Object.entries(people)) {
      rows.push(['', name, ...cells.slice(w * 7, w * 7 + 7)]);
    }
    rows.push([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Feuil1');
  return wb;
}

/** Classeur → octets .xlsx */
export function toBuffer(/** @type {any} */ wb) {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Aller-retour par le format .xlsx, comme un vrai fichier déposé. */
export function roundTrip(/** @type {any} */ wb) {
  return XLSX.read(toBuffer(wb), { type: 'buffer' });
}

/** n cases avec la même valeur */
export const fill = (/** @type {number} */ n, /** @type {string} */ value) => Array.from({ length: n }, () => value);
