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

/** Options de lecture utilisées par la publication et la page d'ajout */
export const READ_OPTIONS = { cellNF: true, cellStyles: true };

export function readOctober() {
  return XLSX.read(readFileSync(OCTOBER), { type: 'buffer', ...READ_OPTIONS });
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
  return XLSX.read(toBuffer(wb), { type: 'buffer', ...READ_OPTIONS });
}

/**
 * Classeur d'une ou plusieurs feuilles construites à partir de tableaux.
 * @param {{ name?: string, rows: any[][], merges?: any[], hiddenRows?: number[], hidden?: boolean, cells?: Record<string, any> }[]} sheets
 */
export function workbookOf(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [i, sheet] of sheets.entries()) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    if (sheet.merges) ws['!merges'] = sheet.merges;
    if (sheet.hiddenRows) ws['!rows'] = sheet.hiddenRows.reduce((acc, r) => { acc[r] = { hidden: true }; return acc; }, []);
    Object.assign(ws, sheet.cells ?? {});
    XLSX.utils.book_append_sheet(wb, ws, sheet.name ?? `Feuil${i + 1}`);
  }
  wb.Workbook = { Sheets: sheets.map((sheet, i) => ({ name: sheet.name ?? `Feuil${i + 1}`, Hidden: sheet.hidden ? 1 : 0 })) };
  return roundTrip(wb);
}

/** Libellés d'une semaine à partir d'un lundi */
export const week = (/** @type {string} */ monday) => Array.from({ length: 7 }, (_, i) => dayLabel(addDays(monday, i)));

/** Numéro de série Excel d'une date */
export const serial = (/** @type {string} */ iso) => (Date.UTC(...(/** @type {[number, number, number]} */ (iso.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))))) - Date.UTC(1899, 11, 30)) / 86400000;

/** n cases avec la même valeur */
export const fill = (/** @type {number} */ n, /** @type {string} */ value) => Array.from({ length: n }, () => value);
