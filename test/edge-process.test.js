// Cas limites du traitement : formats, onglets multiples, données abîmées, ordre des dépôts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allPlannings, runProcess } from '../src/process.js';
import { OCTOBER, ROOT, XLSX, buildPlanning, fill } from './helpers.js';

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'planning-'));
  for (const dir of ['config', 'site']) cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  mkdirSync(path.join(root, 'plannings'));
  return root;
}
const NOW = new Date('2026-11-26T12:00:00Z');
const november = buildPlanning({ title: 'PLANNING NOVEMBRE 2026', start: '2026-11-02', weeks: 4, people: { NATHAN: fill(28, '9H-17H') } });

test('anciens formats : .xls et .ods sont lus', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'plannings', 'NOVEMBRE.xls'), XLSX.write(november, { type: 'buffer', bookType: 'biff8' }));
  writeFileSync(path.join(root, 'plannings', 'NOVEMBRE.ods'), XLSX.write(november, { type: 'buffer', bookType: 'ods' }));
  const report = runProcess({ root, files: ['plannings/NOVEMBRE.xls', 'plannings/NOVEMBRE.ods'], now: NOW });
  assert.equal(report.failed, false, JSON.stringify(report.files));
  assert.deepEqual(report.processedMonths, ['2026-11', '2026-11']);
});

test('fichier illisible ou mal nommé : message qui explique quoi faire', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'plannings', 'CASSE.xlsx'), Buffer.from('504b0304', 'hex'));
  const report = runProcess({ root, files: ['plannings/CASSE.xlsx', 'plannings/ABSENT.xlsx'], now: NOW });
  assert.match(report.files[0].errors[0].message, /enregistrez-le au format \.xlsx/);
  assert.match(report.files[1].errors[0].message, /introuvable/);
});

test('classeur à plusieurs onglets : seul l’onglet du mois indiqué par le nom est publié', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wb = XLSX.read(readFileSync(OCTOBER), { type: 'buffer', cellNF: true, cellStyles: true });
  XLSX.utils.book_append_sheet(wb, november.Sheets.Feuil1, 'Novembre');
  writeFileSync(path.join(root, 'plannings', 'PLANNING NOVEMBRE 2026.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const report = runProcess({ root, files: ['plannings/PLANNING NOVEMBRE 2026.xlsx'], now: NOW });
  assert.deepEqual(report.processedMonths, ['2026-11']);
  assert.ok(report.files[0].warnings.some((w) => /seul l’onglet « Novembre »/.test(w.message)));
  const manifest = JSON.parse(readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.months.map((m) => m.month), ['2026-11']);
});

test('agendas mensuels effacés par erreur : reconstitués à la publication suivante', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(OCTOBER, path.join(root, 'plannings', 'OCTOBRE.xlsx'));
  runProcess({ root, all: true, now: NOW });
  const before = readFileSync(path.join(root, 'public', 'ics', '2026-10', 'nathan.ics'), 'utf8');
  rmSync(path.join(root, 'public', 'ics', '2026-10'), { recursive: true });
  runProcess({ root, files: [], now: new Date('2026-12-01T00:00:00Z') });
  assert.equal(readFileSync(path.join(root, 'public', 'ics', '2026-10', 'nathan.ics'), 'utf8'), before, 'contenu identique');
});

test('données d’un mois abîmées : signalées, les autres mois restent publiés', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(OCTOBER, path.join(root, 'plannings', 'OCTOBRE.xlsx'));
  runProcess({ root, all: true, now: NOW });
  writeFileSync(path.join(root, 'data', '2026-09.json'), '{ pas du json');
  const report = runProcess({ root, files: [], now: NOW });
  assert.equal(report.failed, true);
  assert.match(report.files[0].errors[0].message, /illisibles/);
  assert.ok(existsSync(path.join(root, 'public', 'ics', '2026-10', 'nathan.ics')));
  assert.deepEqual(readdirSync(path.join(root, 'public', 'ics')).filter((f) => /^\d/.test(f)), ['2026-10']);
});

test('tout retraiter : les fichiers d’un même mois passent dans l’ordre de leur dépôt', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@e.st', ...args], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: args.at(-1), GIT_AUTHOR_DATE: args.at(-1) } });
  git('init', '-q', '-b', 'main');
  const oct = (cell) => buildPlanning({ title: 'PLANNING OCTOBRE 2026', start: '2026-09-28', weeks: 5, people: { NATHAN: fill(35, cell) } });
  writeFileSync(path.join(root, 'plannings', 'Z_OCTOBRE_ANCIEN.xlsx'), XLSX.write(oct('8H-12H'), { type: 'buffer', bookType: 'xlsx' }));
  git('add', '-A');
  git('commit', '-q', '-m', 'ancien', '--date', '2026-10-01T10:00:00Z');
  writeFileSync(path.join(root, 'plannings', 'A_OCTOBRE_NOUVEAU.xlsx'), XLSX.write(oct('14H-18H'), { type: 'buffer', bookType: 'xlsx' }));
  git('add', '-A');
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@e.st', 'commit', '-q', '-m', 'nouveau'], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: '2026-10-05T10:00:00Z', GIT_AUTHOR_DATE: '2026-10-05T10:00:00Z' } });
  assert.deepEqual(allPlannings(root), ['plannings/Z_OCTOBRE_ANCIEN.xlsx', 'plannings/A_OCTOBRE_NOUVEAU.xlsx']);
  runProcess({ root, all: true, now: NOW });
  assert.match(readFileSync(path.join(root, 'public', 'ics', '2026-10', 'nathan.ics'), 'utf8'), /T140000/);
});
