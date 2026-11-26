// Page d'ajout et modules réutilisés dans le navigateur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/process.js';
import { renderUpload } from '../src/site.js';
import { OCTOBER, ROOT } from './helpers.js';

test('la page d’ajout connaît le service de dépôt, les mois publiés et ne se connecte qu’à ce service', () => {
  const html = renderUpload(
    { updatedAt: '', subscriptions: [], months: [{ month: '2026-10' }] },
    { serviceDepot: 'https://planning-accueil-depot.netlify.app/', depot: 'yungNATE/planning-accueil' },
    { SYVAIN: 'SYLVAIN' },
  );
  assert.match(html, /data-service="https:\/\/planning-accueil-depot\.netlify\.app"/);
  assert.match(html, /data-published="\[&quot;2026-10&quot;\]"/);
  assert.match(html, /data-aliases="\{&quot;SYVAIN&quot;:&quot;SYLVAIN&quot;\}"/);
  assert.match(html, /connect-src https:\/\/planning-accueil-depot\.netlify\.app;/);
  assert.match(html, /script-src 'self';/);
  assert.match(html, /autocomplete="current-password"/);
  assert.doesNotMatch(html, /github_pat_|personal-access-tokens/);
});

test('les modules du parser utilisés dans le navigateur n’importent aucune API Node', () => {
  for (const mod of ['parse-planning.js', 'util.js', 'names.js']) {
    const source = readFileSync(path.join(ROOT, 'src', mod), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:|require\(/, mod);
    for (const [, spec] of source.matchAll(/from ['"]([^'"]+)['"]/g)) assert.match(spec, /^\.\/[\w-]+\.js$/, `${mod} importe ${spec}`);
  }
});

test('la publication copie la page d’ajout, le parser et SheetJS', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['config', 'site']) cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  cpSync(OCTOBER, path.join(root, 'plannings', 'PLANNING_OCTOBRE_26.xlsx'));
  runProcess({ root, all: true, now: new Date('2026-11-24T10:00:00Z') });
  for (const file of ['ajouter.html', 'assets/upload.js', 'assets/lib/parse-planning.js', 'assets/lib/util.js', 'assets/lib/names.js', 'assets/vendor/xlsx.js']) {
    assert.ok(existsSync(path.join(root, 'public', file)), file);
  }
  assert.match(readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), /href="ajouter\.html"/);
});
