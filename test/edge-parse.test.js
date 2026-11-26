// Cas limites de lecture des plannings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanning, parseWorkbook } from '../src/parse-planning.js';
import { buildPlanning, fill, roundTrip, serial, week, workbookOf } from './helpers.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const octoberWeeks = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];

/** Planning d'octobre au format habituel, titre et libellés personnalisables */
function october({ title = 'PLANNING OCTOBRE 2026', labels = week, people = { ALICE: '8H-12H' }, mondays = octoberWeeks } = {}) {
  const rows = [['', '', title], []];
  for (const monday of mondays) {
    rows.push(['', 'JOURS', ...labels(monday)]);
    for (const [name, cell] of Object.entries(people)) rows.push(['', name, ...fill(7, cell)]);
    rows.push([]);
  }
  return rows;
}

const parse = (rows, options = {}) => parsePlanning(workbookOf([{ rows }]), { now: NOW, ...options });

test('titres : abréviation et année sur deux chiffres, minuscules, anglais, espace invisible', () => {
  for (const title of ['PLANNING OCT. 26', 'Planning accueil – octobre 2026', 'ROSTER OCTOBER 2026', 'PLG OCTOBRE​ 2026']) {
    const p = parse(october({ title }));
    assert.equal(p.month, '2026-10', title);
    assert.deepEqual(p.errors, [], title);
  }
});

test('titre absent : mois lu dans le nom du fichier, avec avertissement', () => {
  const p = parse(october({ title: 'PLANNING ACCUEIL' }), { source: 'PLANNING_OCTOBRE_26.xlsx' });
  assert.equal(p.month, '2026-10');
  assert.ok(p.warnings.some((w) => /nom du fichier/.test(w.message)));
});

test('titre sans année : année déduite des jours de la semaine', () => {
  const p = parse(october({ title: 'PLANNING OCTOBRE' }));
  assert.equal(p.month, '2026-10');
  assert.equal(p.start, '2026-09-28');
  assert.ok(p.warnings.some((w) => /n’indique pas l’année/.test(w.message)));
});

test('titre saisi comme une date Excel au format « mmmm yyyy »', () => {
  const rows = october({ title: '' });
  const wb = workbookOf([{ rows, cells: { C1: { t: 'n', v: serial('2026-10-01'), z: 'mmmm yyyy' } } }]);
  assert.equal(parsePlanning(wb, { now: NOW }).month, '2026-10');
});

test('libellés de jours : abréviations, anglais, mois précisé', () => {
  const abbr = (monday) => week(monday).map((l) => l.replace(/^(\w{3})\w*/, '$1.'));
  assert.equal(parse(october({ labels: abbr })).ok, true);
  const english = (monday) => week(monday).map((l) => l.replace('LUNDI', 'MONDAY').replace('MARDI', 'TUESDAY').replace('MERCREDI', 'WEDNESDAY').replace('JEUDI', 'THURSDAY').replace('VENDREDI', 'FRIDAY').replace('SAMEDI', 'SATURDAY').replace('DIMANCHE', 'SUNDAY').replace('1ER', '1'));
  assert.equal(parse(october({ labels: english })).ok, true);
  const withMonth = (monday) => week(monday).map((l, i) => `${l} ${['SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE'][Number(addMonth(monday, i))]}`);
  const p = parse(october({ labels: withMonth }));
  assert.deepEqual(p.errors, []);
  assert.equal(p.days.length, 35);
});
/** 0 = septembre, 1 = octobre, 2 = novembre pour le jour i de la semaine commençant le lundi donné */
function addMonth(monday, i) {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.getUTCMonth() - 8;
}

test('jours saisis comme vraies dates Excel (affichées en anglais par la lecture)', () => {
  const rows = october();
  const cells = {};
  rows.forEach((row, r) => {
    if (row[1] !== 'JOURS') return;
    row.slice(2).forEach((_, k) => {
      const monday = octoberWeeks[(r - 2) / 3];
      const d = new Date(`${monday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + k);
      cells[`${String.fromCharCode(67 + k)}${r + 1}`] = { t: 'n', v: serial(d.toISOString().slice(0, 10)), z: 'dddd d' };
    });
  });
  const p = parsePlanning(workbookOf([{ rows, cells }]), { now: NOW });
  assert.deepEqual(p.errors, []);
  assert.equal(p.start, '2026-09-28');
  assert.equal(p.end, '2026-11-01');
});

test('dernière semaine incomplète (2 jours) : prise en compte', () => {
  const rows = october({ mondays: octoberWeeks.slice(0, 4) });
  rows.push(['', 'JOURS', 'LUNDI 26', 'MARDI 27'], ['', 'ALICE', '9H-10H', '9H-10H']);
  const p = parse(rows);
  assert.equal(p.end, '2026-10-27');
  assert.equal(p.employees[0].slotCount, 30);
});

test('semaine absente : dates justes et avertissement', () => {
  const p = parse(october({ mondays: ['2026-09-28', '2026-10-12'] }));
  assert.deepEqual(p.errors, []);
  assert.equal(p.days[7], '2026-10-12');
  assert.ok(p.warnings.some((w) => /Jours absents du planning : du 5 octobre 2026 au 11 octobre 2026/.test(w.message)));
});

test('semaine en double : erreur', () => {
  const p = parse(october({ mondays: ['2026-09-28', '2026-09-28'] }));
  assert.equal(p.ok, false);
  assert.match(p.errors[0].message, /incohérent/);
});

test('colonne vide entre les noms et les jours', () => {
  const rows = october().map((row) => (row.length ? [row[0], row[1], '', ...row.slice(2)] : row));
  const p = parse(rows);
  assert.deepEqual(p.errors, []);
  assert.equal(p.employees[0].name, 'Alice');
});

test('annotations dans les noms : « TOM (stagiaire) » et « TOM* » sont Tom', () => {
  const rows = october({ people: { 'TOM (stagiaire)': '8H-12H' } });
  assert.equal(rows[6][1], 'TOM (stagiaire)');
  rows[6][1] = 'TOM*'; // deuxième semaine
  const p = parse(rows);
  assert.deepEqual(p.employees.map((e) => e.name), ['Tom']);
});

test('case fusionnée sur deux jours : l’horaire vaut pour les deux', () => {
  const rows = october({ people: { ALICE: 'RH' } });
  rows[3][2] = '8H-12H';
  rows[3][3] = '';
  const p = parsePlanning(workbookOf([{ rows, merges: [{ s: { r: 3, c: 2 }, e: { r: 3, c: 3 } }] }]), { now: NOW });
  assert.equal(p.employees[0].days['2026-09-28'].slots.length, 1);
  assert.equal(p.employees[0].days['2026-09-29'].slots.length, 1);
});

test('ligne masquée : ignorée comme à l’écran, avec avertissement', () => {
  const rows = october({ people: { ALICE: '8H-12H', ANCIEN: '8H-12H' } });
  const hiddenRows = rows.flatMap((row, r) => (row[1] === 'ANCIEN' ? [r] : []));
  const p = parsePlanning(workbookOf([{ rows, hiddenRows }]), { now: NOW });
  assert.deepEqual(p.employees.map((e) => e.name), ['Alice']);
  assert.ok(p.warnings.some((w) => /masquées/.test(w.message)));
});

test('même prénom deux fois dans la semaine : erreur qui explique comment distinguer', () => {
  const rows = october();
  rows.splice(4, 0, ['', 'ALICE', ...fill(7, '14H-18H')]);
  const p = parse(rows);
  assert.equal(p.ok, false);
  assert.match(p.errors[0].message, /distinguez-les/);
});

test('créneaux qui se chevauchent et horaires en partie reconnus : avertissements', () => {
  const rows = october({ people: { ALICE: '8H-12H / 10H-14H' } });
  rows[3][3] = '8H-12H / 14H';
  const p = parse(rows);
  assert.ok(p.warnings.some((w) => /chevauchent/.test(w.message)));
  assert.ok(p.warnings.some((w) => /en partie reconnu/.test(w.message) && w.cell === 'D4'));
});

test('faute de frappe sur tout un mois : rattachée à la personne des mois précédents', () => {
  const p = parse(october({ people: { SYLVIN: '8H-12H' } }), { knownNames: [{ key: 'SYLVAIN', name: 'Sylvain' }] });
  assert.deepEqual(p.employees.map((e) => [e.name, e.slug]), [['Sylvain', 'sylvain']]);
  assert.ok(p.warnings.some((w) => /ressemble à « Sylvain »/.test(w.message)));
});

test('titre qui ne correspond pas à la majorité des jours : avertissement', () => {
  const p = parse(october({ title: 'PLANNING SEPTEMBRE 2026' }));
  assert.equal(p.month, '2026-09');
  assert.ok(p.warnings.some((w) => /la plupart des jours sont en octobre 2026/.test(w.message)));
});

test('prénom sans lettre latine : identifiant de fichier de secours', () => {
  const p = parse(october({ people: { 李雷: '8H-12H' } }));
  assert.match(p.employees[0].slug, /^personne-[a-z0-9]+$/);
});

test('classeur à plusieurs onglets : un planning par mois, onglet masqué ignoré', () => {
  const nov = buildPlanning({ title: 'PLANNING NOVEMBRE 2026', start: '2026-11-02', weeks: 4, people: { ALICE: fill(28, '9H-17H') } });
  const wb = workbookOf([
    { name: 'Octobre', rows: october() },
    { name: 'Novembre', rows: XLSXRows(nov) },
    { name: 'Brouillon', rows: october({ title: 'PLANNING DECEMBRE 2026' }), hidden: true },
  ]);
  const { plannings, errors } = parseWorkbook(wb, { now: NOW });
  assert.deepEqual(errors, []);
  assert.deepEqual(plannings.map((p) => [p.sheet, p.month, p.ok]), [['Octobre', '2026-10', true], ['Novembre', '2026-11', true]]);
});

test('deux onglets pour le même mois : erreur', () => {
  const wb = workbookOf([{ name: 'V1', rows: october() }, { name: 'V2', rows: october() }]);
  const { plannings } = parseWorkbook(wb, { now: NOW });
  assert.equal(plannings[1].ok, false);
  assert.match(plannings[1].errors[0].message, /« V1 » et « V2 »/);
});

test('fichier sans planning : message explicite', () => {
  const { plannings, errors } = parseWorkbook(workbookOf([{ rows: [['Liste de courses'], ['pain']] }]));
  assert.equal(plannings.length, 0);
  assert.match(errors[0].message, /ne ressemble pas à un planning/);
});

/** Lignes d'une feuille construite par buildPlanning */
function XLSXRows(wb) {
  const ws = wb.Sheets.Feuil1;
  return roundTripRows(ws);
}
function roundTripRows(ws) {
  const rows = [];
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(key);
    const r = Number(m[2]) - 1;
    const c = m[1].charCodeAt(0) - 65;
    rows[r] = rows[r] ?? [];
    rows[r][c] = ws[key].v;
  }
  return Array.from(rows, (row) => Array.from(row ?? [], (v) => v ?? ''));
}

test('planning sans aucun nom de mois : mois déduit des jours s’il n’y a qu’une possibilité', () => {
  // Du lundi 30 novembre au dimanche 3 janvier : seul décembre 2026 colle, autour du 26 novembre 2026
  const rows = [['', '', 'PLANNING ACCUEIL'], []];
  for (const monday of ['2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']) {
    rows.push(['', 'JOURS', ...week(monday)], ['', 'ALICE', ...fill(7, '8H-12H')], []);
  }
  const p = parsePlanning(workbookOf([{ rows }]), { source: 'Classeur1.xlsx', now: NOW });
  assert.equal(p.month, '2026-12');
  assert.equal(p.start, '2026-11-30');
  assert.ok(p.warnings.some((w) => /décembre 2026 a été déduit des jours/.test(w.message)));
});

test('planning sans aucun nom de mois et jours ambigus : refusé, avec la marche à suivre', () => {
  // « LUNDI 28 » : octobre 2026 (du 28 septembre) comme janvier 2027 (du 28 décembre)
  const p = parsePlanning(workbookOf([{ rows: october({ title: 'PLANNING ACCUEIL' }) }]), { source: 'Classeur1.xlsx', now: NOW });
  assert.equal(p.ok, false);
  assert.match(p.errors[0].message, /octobre 2026 ou janvier 2027/);
  assert.match(p.errors[0].message, /Ajoutez en haut de la feuille un titre/);
});

test('planning sans nom de mois mais jours saisis en dates Excel : mois certain', () => {
  const rows = october({ title: '' });
  const cells = {};
  rows.forEach((row, r) => {
    if (row[1] !== 'JOURS') return;
    const monday = octoberWeeks[(r - 2) / 3];
    for (let k = 0; k < 7; k++) {
      const d = new Date(`${monday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + k);
      cells[`${String.fromCharCode(67 + k)}${r + 1}`] = { t: 'n', v: serial(d.toISOString().slice(0, 10)), z: 'dddd d' };
    }
  });
  const p = parsePlanning(workbookOf([{ rows, cells }]), { source: 'Classeur1.xlsx', now: NOW });
  assert.equal(p.month, '2026-10');
  assert.deepEqual(p.errors, []);
});
