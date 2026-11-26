// Plannings synthétiques : cas limites du parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parsePlanning } from '../src/parse-planning.js';
import { XLSX, buildPlanning, dayLabel, fill, roundTrip } from './helpers.js';

test('passage d’année : planning de décembre du lundi 30 novembre 2026 au dimanche 3 janvier 2027', () => {
  const wb = roundTrip(buildPlanning({
    title: 'PLG ACCUEIL DÉCEMBRE 2026', start: '2026-11-30', weeks: 5, people: { ALICE: fill(35, '8H-15H') },
  }));
  const p = parsePlanning(wb);
  assert.deepEqual(p.errors, []);
  assert.equal(p.month, '2026-12');
  assert.equal(p.start, '2026-11-30');
  assert.equal(p.end, '2027-01-03');
  assert.equal(p.employees[0].slotCount, 35);
});

test('en-tête incohérent : erreur avec la cellule concernée', () => {
  const wb = roundTrip(buildPlanning({
    title: 'PLANNING OCTOBRE 2026',
    start: '2026-09-28',
    weeks: 1,
    people: { ALICE: fill(7, 'RH') },
    labels: (iso, i) => (i === 3 ? 'JEUDI 2' : dayLabel(iso)),
  }));
  const p = parsePlanning(wb);
  assert.equal(p.ok, false);
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].cell, 'F3');
  assert.match(p.errors[0].message, /jeudi 1er octobre 2026/);
});

test('horaire mal saisi : avertissement et journée OFF', () => {
  const cells = fill(7, 'RH');
  cells[2] = '15H30_23H';
  const p = parsePlanning(roundTrip(buildPlanning({ title: 'PLANNING OCTOBRE 2026', start: '2026-09-28', weeks: 1, people: { ALICE: cells } })));
  assert.equal(p.ok, true);
  assert.equal(p.warnings.length, 1);
  assert.equal(p.warnings[0].cell, 'E4');
  assert.deepEqual(p.employees[0].days['2026-09-30'].slots, []);
});

test('lecture des cases', () => {
  assert.deepEqual(parseCell('8H-15H30').slots, [{ start: '08:00', end: '15:30', overnight: false }]);
  assert.deepEqual(parseCell(' 8h - 15h ').slots, [{ start: '08:00', end: '15:00', overnight: false }]);
  assert.deepEqual(parseCell('08:00–12:00').slots, [{ start: '08:00', end: '12:00', overnight: false }]);
  assert.equal(parseCell('8H-12H / 14H-18H').slots.length, 2);
  assert.deepEqual(parseCell('22H-6H').slots, [{ start: '22:00', end: '06:00', overnight: true }]);
  assert.equal(parseCell('RH').status, 'off');
  assert.equal(parseCell('').status, 'off');
  assert.equal(parseCell('Congés').status, 'off');
  assert.equal(parseCell('8H-8H').status, 'invalid');
  assert.equal(parseCell('25H-26H').status, 'invalid');
});

test('nom décalé d’une ligne sous des cases fusionnées verticalement', () => {
  const rows = [
    ['', '', 'PLANNING OCTOBRE 2026'],
    [],
    ['', 'JOURS', 'LUNDI 28', 'MARDI 29', 'MERCREDI 30'],
    ['', '', '8H-15H', 'RH', '15H-22H'],
    ['', 'NATHAN', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [2, 3, 4].map((c) => ({ s: { r: 3, c }, e: { r: 4, c } }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Feuil1');
  const p = parsePlanning(roundTrip(wb));
  assert.deepEqual(p.errors, []);
  assert.equal(p.employees[0].name, 'Nathan');
  assert.equal(p.employees[0].slotCount, 2);
});

test('horaires sans nom : erreur', () => {
  const rows = [
    ['', '', 'PLANNING OCTOBRE 2026'],
    ['', 'JOURS', 'LUNDI 28', 'MARDI 29', 'MERCREDI 30'],
    ['', '', '8H-15H', 'RH', '15H-22H'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Feuil1');
  const p = parsePlanning(roundTrip(wb));
  assert.equal(p.ok, false);
  assert.match(p.errors[0].message, /aucun nom/);
});

test('semaine entièrement vide : OFF pour une personne présente ailleurs, ignorée sinon', () => {
  const p = parsePlanning(roundTrip(buildPlanning({
    title: 'PLANNING OCTOBRE 2026',
    start: '2026-09-28',
    weeks: 2,
    people: { ALICE: [...fill(7, '8H-12H'), ...fill(7, '')], BRUNO: fill(14, '') },
  })));
  assert.deepEqual(p.employees.map((e) => [e.name, e.slotCount]), [['Alice', 7]]);
  assert.equal(p.employees[0].days['2026-10-10'].slots.length, 0, 'semaine vide d’Alice comptée OFF');
});

test('alias : un nom épinglé n’est pas rapproché automatiquement', () => {
  const two = buildPlanning({
    title: 'PLANNING OCTOBRE 2026', start: '2026-09-28', weeks: 3, people: { SYLVAIN: fill(21, '8H-12H') },
  });
  // Troisième semaine (ligne 10) : « SYVAIN » au lieu de « SYLVAIN », écrit deux fois correctement avant
  two.Sheets.Feuil1.B10 = { t: 's', v: 'SYVAIN' };
  const auto = parsePlanning(roundTrip(two));
  assert.deepEqual(auto.employees.map((e) => e.name), ['Sylvain']);
  const pinned = parsePlanning(roundTrip(two), { aliases: { SYVAIN: 'SYVAIN' } });
  assert.deepEqual(pinned.employees.map((e) => e.name), ['Sylvain', 'Syvain']);
});

test('titre introuvable et jours loin d’aujourd’hui : erreur explicite', () => {
  const p = parsePlanning(roundTrip(buildPlanning({ title: 'PLANNING ACCUEIL', start: '2026-09-28', weeks: 1, people: { ALICE: fill(7, 'RH') } })), { now: new Date('2026-05-15T12:00:00Z') });
  assert.equal(p.ok, false);
  assert.match(p.errors[0].message, /Titre introuvable/);
});
