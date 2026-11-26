// Suppression d'un mois : fichiers Excel, données, agendas mensuels, abonnements, page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatReport, runPending, runProcess } from '../src/process.js';
import {
  OCTOBER, ROOT, buildPlanning, fill, toBuffer,
} from './helpers.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const november = () => toBuffer(buildPlanning({ title: 'PLANNING NOVEMBRE 2026', start: '2026-11-02', weeks: 4, people: { NATHAN: fill(28, '9H-17H') } }));
const october = (cell) => toBuffer(buildPlanning({ title: 'PLANNING OCTOBRE 2026', start: '2026-09-28', weeks: 5, people: { NATHAN: fill(35, cell) } }));

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'planning-suppr-'));
  for (const dir of ['config', 'site']) cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  mkdirSync(path.join(root, 'plannings'));
  return root;
}
const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => existsSync(path.join(root, rel));

test('supprimer un mois retire son fichier Excel, ses données, ses agendas et ses jours des abonnements', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(OCTOBER, path.join(root, 'plannings', 'PLANNING_OCTOBRE_26.xlsx'));
  writeFileSync(path.join(root, 'plannings', 'PLANNING_NOVEMBRE_26.xlsx'), november());
  runProcess({ root, all: true, now: NOW });
  const novemberIcs = read(root, 'public/ics/2026-11/nathan.ics');
  assert.equal(read(root, 'public/ics/nathan.ics').match(/BEGIN:VEVENT/g)?.length, 25 + 28);
  // Fichiers Excel d'origine proposés au téléchargement, octet pour octet
  assert.ok(readFileSync(path.join(root, 'public/excel/2026-10.xlsx')).equals(readFileSync(OCTOBER)));
  assert.match(read(root, 'public/index.html'), /href="excel\/2026-10\.xlsx" download="PLANNING_OCTOBRE_26\.xlsx"/);

  const report = runProcess({ root, files: [], deleteMonths: ['2026-10'], now: NOW });
  assert.deepEqual(report.deleted, [{ month: '2026-10', removed: ['data/2026-10.json', path.join('plannings', 'PLANNING_OCTOBRE_26.xlsx')] }]);
  assert.equal(exists(root, 'data/2026-10.json'), false);
  assert.equal(exists(root, 'plannings/PLANNING_OCTOBRE_26.xlsx'), false);
  assert.equal(exists(root, 'public/ics/2026-10'), false);
  assert.equal(exists(root, 'public/excel/2026-10.xlsx'), false, 'Excel d’origine retiré du site');
  assert.ok(exists(root, 'public/excel/2026-11.xlsx'));
  // Louna n'existait qu'en octobre : son agenda d'abonnement disparaît
  assert.equal(exists(root, 'public/ics/louna.ics'), false);
  assert.equal(read(root, 'public/ics/nathan.ics').match(/BEGIN:VEVENT/g)?.length, 28);
  // Novembre n'a pas bougé
  assert.equal(read(root, 'public/ics/2026-11/nathan.ics'), novemberIcs);
  assert.ok(exists(root, 'plannings/PLANNING_NOVEMBRE_26.xlsx'));
  const manifest = JSON.parse(read(root, 'public/manifest.json'));
  assert.deepEqual(manifest.months.map((m) => m.month), ['2026-11']);
  assert.doesNotMatch(read(root, 'public/index.html'), /octobre 2026/i);
  assert.match(formatReport(report), /octobre 2026 : supprimé/);
});

test('fichier sans année dans le nom : retrouvé grâce aux données publiées', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'plannings', 'Planning octobre.xlsx'), october('8H-12H'));
  runProcess({ root, all: true, now: NOW });
  assert.ok(exists(root, 'data/2026-10.json'));
  const report = runProcess({ root, files: [], deleteMonths: ['2026-10'], now: NOW });
  assert.deepEqual(report.deleted[0].removed, ['data/2026-10.json', path.join('plannings', 'Planning octobre.xlsx')]);
  assert.deepEqual(readdirSync(path.join(root, 'plannings')), []);
});

test('mois non publié ou mal écrit : rien n’est supprimé, le rapport le dit', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runProcess({ root, files: [], deleteMonths: ['2026-03', 'octobre'], now: NOW });
  assert.deepEqual(report.deleted, [{ month: '2026-03', removed: [] }]);
  assert.match(formatReport(report), /Rien à supprimer/);
  assert.match(report.files[0].errors[0].message, /format AAAA-MM/);
  assert.equal(report.failed, true);
});

function makeRepo() {
  const root = makeRoot();
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@e.st', ...args], { cwd: root }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'Initial');
  const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  const request = (month) => {
    mkdirSync(path.join(root, 'demandes'), { recursive: true });
    writeFileSync(path.join(root, 'demandes', `supprimer-${month}.json`), JSON.stringify({ mois: month }));
    return commit(`Suppression ${month}`);
  };
  return { root, git, commit, request };
}

test('demande de suppression déposée dans le dépôt : traitée puis retirée', (t) => {
  const { root, git, commit, request } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const start = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'plannings', 'PLANNING OCTOBRE 2026.xlsx'), october('8H-12H'));
  commit('Octobre');
  runPending({ root, fallbackSince: start, now: NOW });
  commit('Planning généré');
  assert.ok(exists(root, 'data/2026-10.json'));

  request('2026-10');
  const report = runPending({ root, now: NOW });
  assert.deepEqual(report.deleted.map((d) => d.month), ['2026-10']);
  assert.equal(exists(root, 'data/2026-10.json'), false);
  assert.equal(exists(root, 'plannings/PLANNING OCTOBRE 2026.xlsx'), false);
  assert.equal(exists(root, 'demandes/supprimer-2026-10.json'), false, 'demande retirée une fois traitée');
});

test('dans un même lot, l’ordre des dépôts décide : suppression puis nouveau fichier, ou l’inverse', (t) => {
  const { root, git, commit, request } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'plannings', 'PLANNING OCTOBRE 2026.xlsx'), october('8H-12H'));
  commit('Octobre v1');
  runProcess({ root, all: true, now: NOW });
  commit('Planning généré');
  const base = git('rev-parse', 'HEAD');

  // Suppression demandée, puis nouvelle version d'octobre déposée : octobre est republié avec la nouvelle version
  request('2026-10');
  writeFileSync(path.join(root, 'plannings', 'PLANNING OCTOBRE 2026 V2.xlsx'), october('14H-18H'));
  commit('Octobre v2');
  const first = runPending({ root, fallbackSince: base, now: NOW });
  assert.deepEqual(first.deleted.map((d) => d.removed.length), [2], 'ancienne version et données retirées');
  assert.deepEqual(first.processedMonths, ['2026-10']);
  assert.match(read(root, 'public/ics/2026-10/nathan.ics'), /T140000/);
  assert.ok(exists(root, 'plannings/PLANNING OCTOBRE 2026 V2.xlsx'));
  commit('Planning généré');

  // Nouvelle version déposée, puis suppression demandée : octobre disparaît
  writeFileSync(path.join(root, 'plannings', 'PLANNING OCTOBRE 2026 V3.xlsx'), october('9H-10H'));
  commit('Octobre v3');
  request('2026-10');
  const second = runPending({ root, now: NOW });
  assert.deepEqual(second.processedMonths, ['2026-10']);
  assert.equal(exists(root, 'data/2026-10.json'), false);
  assert.deepEqual(readdirSync(path.join(root, 'plannings')), []);
});
