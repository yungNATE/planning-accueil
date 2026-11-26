// Traitement incrémental : seul le planning déposé est traité, les autres mois ne bougent pas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatReport, runProcess } from '../src/process.js';
import { OCTOBER, ROOT, buildPlanning, fill, toBuffer } from './helpers.js';

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'planning-'));
  for (const dir of ['config', 'site']) cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  cpSync(OCTOBER, path.join(root, 'plannings', 'PLANNING_OCTOBRE_26.xlsx'));
  return root;
}

/** Contenu de tous les fichiers d'un dossier */
function snapshot(/** @type {string} */ dir) {
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));
}

const read = (/** @type {string} */ root, /** @type {string} */ rel) => readFileSync(path.join(root, rel), 'utf8');

/** Planning de novembre 2026 : du lundi 2 au dimanche 29 novembre */
function november(/** @type {string} */ root, people = { NATHAN: fill(28, '9H-17H'), TOM: fill(28, 'RH') }) {
  const file = path.join(root, 'plannings', 'PLANNING_NOVEMBRE_26.xlsx');
  writeFileSync(file, toBuffer(buildPlanning({ title: 'PLG ACCUEIL NOVEMBRE 2026', start: '2026-11-02', weeks: 4, people })));
  return path.relative(root, file);
}

test('un nouveau mois ne réécrit pas les mois déjà publiés', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = runProcess({ root, all: true, now: new Date('2026-11-24T10:00:00Z') });
  assert.equal(first.failed, false);
  const octoberIcs = snapshot(path.join(root, 'public', 'ics', '2026-10'));
  const octoberData = read(root, 'data/2026-10.json');
  assert.deepEqual(Object.keys(octoberIcs), ['louna.ics', 'nathan.ics', 'sylvain.ics', 'tom.ics']);

  const report = runProcess({ root, files: [november(root)], now: new Date('2026-12-01T10:00:00Z') });
  assert.deepEqual(report.processedMonths, ['2026-11']);
  assert.deepEqual(report.overlaps, []);
  assert.deepEqual(snapshot(path.join(root, 'public', 'ics', '2026-10')), octoberIcs);
  assert.equal(read(root, 'data/2026-10.json'), octoberData);

  // Tom n'a que des RH en novembre : pas de fichier mensuel, mais il reste listé
  assert.deepEqual(readdirSync(path.join(root, 'public', 'ics', '2026-11')), ['nathan.ics']);
  const manifest = JSON.parse(read(root, 'public/manifest.json'));
  assert.deepEqual(manifest.months.map((m) => m.month), ['2026-11', '2026-10']);
  assert.deepEqual(manifest.months[0].employees.map((e) => [e.name, e.file]), [['Nathan', 'ics/2026-11/nathan.ics'], ['Tom', null]]);

  // Abonnement : octobre + novembre
  const subscription = read(root, 'public/ics/nathan.ics');
  assert.equal(subscription.match(/BEGIN:VEVENT/g)?.length, 25 + 28);
  assert.match(subscription, /REFRESH-INTERVAL;VALUE=DURATION:PT6H/);

  const html = read(root, 'public/index.html');
  assert.match(html, /Planning de novembre 2026/);
  assert.match(html, /Planning d’octobre 2026/);
  assert.ok(formatReport(report).includes('novembre 2026'));
});

test('redéposer un mois remplace entièrement ce mois', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runProcess({ root, all: true, now: new Date('2026-11-24T10:00:00Z') });

  // Version corrigée d'octobre : Louna n'y figure plus
  const fixed = path.join(root, 'plannings', 'PLANNING_OCTOBRE_26_V2.xlsx');
  writeFileSync(fixed, toBuffer(buildPlanning({ title: 'PLANNING OCTOBRE 2026', start: '2026-09-28', weeks: 5, people: { TOM: fill(35, '8H-15H') } })));
  const report = runProcess({ root, files: ['plannings/PLANNING_OCTOBRE_26_V2.xlsx'], now: new Date('2026-11-25T10:00:00Z') });

  assert.ok(report.files[0].warnings.some((w) => w.message.includes('remplace le planning octobre 2026')));
  assert.deepEqual(readdirSync(path.join(root, 'public', 'ics', '2026-10')), ['tom.ics']);
  assert.equal(existsSync(path.join(root, 'public', 'ics', 'louna.ics')), false);
});

test('un jour présent dans deux plannings est signalé, le dernier traité fait foi pour l’abonnement', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runProcess({ root, all: true, now: new Date('2026-11-24T10:00:00Z') });

  // Planning de novembre qui commence par erreur le lundi 26 octobre
  const file = path.join(root, 'plannings', 'PLANNING_NOVEMBRE_26.xlsx');
  writeFileSync(file, toBuffer(buildPlanning({ title: 'PLANNING NOVEMBRE 2026', start: '2026-10-26', weeks: 5, people: { NATHAN: fill(35, '9H-10H') } })));
  const report = runProcess({ root, files: [path.relative(root, file)], now: new Date('2026-12-01T10:00:00Z') });

  assert.equal(report.overlaps.length, 1);
  assert.deepEqual(report.overlaps[0].days, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  const subscription = read(root, 'public/ics/nathan.ics');
  assert.match(subscription, /DTSTART;TZID=Europe\/Paris:20261026T090000/);
  assert.doesNotMatch(subscription, /DTSTART;TZID=Europe\/Paris:20261026T153000/);
  // Le fichier mensuel d'octobre, lui, n'a pas bougé
  assert.match(read(root, 'public/ics/2026-10/nathan.ics'), /DTSTART;TZID=Europe\/Paris:20261026T153000/);
});

test('un fichier illisible n’empêche pas la publication des autres', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'plannings', 'CASSE.xlsx'), 'pas un classeur');
  const report = runProcess({ root, all: true, now: new Date('2026-11-24T10:00:00Z') });
  assert.equal(report.failed, true);
  assert.deepEqual(report.processedMonths, ['2026-10']);
  assert.ok(existsSync(path.join(root, 'public', 'index.html')));
});
