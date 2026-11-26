// Plusieurs dépôts d'affilée : tous les fichiers en attente sont traités, dans l'ordre de leur dépôt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pendingPlannings, runPending } from '../src/process.js';
import { ROOT, buildPlanning, fill, toBuffer } from './helpers.js';

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'planning-git-'));
  for (const dir of ['config', 'site']) cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  mkdirSync(path.join(root, 'plannings'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial');
  /** Dépose un planning dans un commit, comme la page d'ajout */
  const deposit = (name, spec) => {
    writeFileSync(path.join(root, 'plannings', name), toBuffer(buildPlanning(spec)));
    git('add', '-A');
    git('commit', '-q', '-m', `Dépôt ${name}`);
    return git('rev-parse', 'HEAD');
  };
  return { root, git, deposit };
}

const october = (cell) => ({ title: 'PLANNING OCTOBRE 2026', start: '2026-09-28', weeks: 5, people: { NATHAN: fill(35, cell) } });
const november = (cell) => ({ title: 'PLANNING NOVEMBRE 2026', start: '2026-11-02', weeks: 4, people: { TOM: fill(28, cell) } });
const december = { title: 'PLANNING DÉCEMBRE 2026', start: '2026-11-30', weeks: 5, people: { TOM: fill(35, '9H-17H') } };

test('quatre dépôts d’affilée : ordre chronologique, la dernière version d’un mois l’emporte', (t) => {
  const { root, git, deposit } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const start = git('rev-parse', 'HEAD');
  deposit('B_NOVEMBRE.xlsx', november('8H-12H'));
  deposit('Z_OCTOBRE.xlsx', october('8H-12H'));
  deposit('A_OCTOBRE_CORRIGE.xlsx', october('14H-18H'));
  deposit('B_NOVEMBRE.xlsx', november('13H-17H')); // modification du même fichier

  const { files } = pendingPlannings(root, start);
  assert.deepEqual(files, ['plannings/Z_OCTOBRE.xlsx', 'plannings/A_OCTOBRE_CORRIGE.xlsx', 'plannings/B_NOVEMBRE.xlsx']);

  const report = runPending({ root, fallbackSince: start, now: new Date('2026-11-26T12:00:00Z') });
  assert.deepEqual(report.processedMonths, ['2026-10', '2026-10', '2026-11']);
  // Octobre : la version corrigée, déposée en dernier, fait foi (malgré son nom alphabétiquement premier)
  assert.match(readFileSync(path.join(root, 'public/ics/2026-10/nathan.ics'), 'utf8'), /T140000/);
  assert.match(readFileSync(path.join(root, 'public/ics/2026-11/tom.ics'), 'utf8'), /T130000/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'data/etat.json'), 'utf8')).dernierCommitTraite, git('rev-parse', 'HEAD'));
});

test('exécution annulée : la suivante rattrape les fichiers qu’elle n’a pas traités', (t) => {
  const { root, git, deposit } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const start = git('rev-parse', 'HEAD');
  const first = deposit('OCTOBRE.xlsx', october('8H-12H'));
  // Premier passage, déclenché par le dépôt d'octobre
  runPending({ root, fallbackSince: start, now: new Date('2026-11-26T12:00:00Z') });
  git('add', '-A');
  git('commit', '-q', '-m', 'Planning 2026-10 généré');

  // Novembre puis décembre arrivent ; l'exécution de novembre est annulée, seule celle de décembre tourne,
  // avec comme commit déclencheur précédent celui de novembre.
  const nov = deposit('NOVEMBRE.xlsx', november('8H-12H'));
  deposit('DECEMBRE.xlsx', december);
  const report = runPending({ root, fallbackSince: nov, now: new Date('2026-11-26T12:05:00Z') });
  assert.deepEqual(report.processedMonths, ['2026-11', '2026-12'], 'novembre est rattrapé grâce à data/etat.json');
  assert.ok(first);

  // Exécution suivante sans nouveau fichier : rien à traiter
  git('add', '-A');
  git('commit', '-q', '-m', 'Plannings générés');
  assert.deepEqual(runPending({ root, now: new Date('2026-11-26T12:10:00Z') }).processedMonths, []);
});

test('premier passage sans point de départ connu : tout est traité', (t) => {
  const { root, deposit } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  deposit('OCTOBRE.xlsx', october('8H-12H'));
  deposit('NOVEMBRE.xlsx', november('8H-12H'));
  assert.deepEqual(runPending({ root, now: new Date('2026-11-26T12:00:00Z') }).processedMonths.sort(), ['2026-10', '2026-11']);
});
