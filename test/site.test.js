// Page d'ajout et modules réutilisés dans le navigateur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/process.js';
import { renderIndex, renderUpload } from '../src/site.js';
import { OCTOBER, ROOT } from './helpers.js';

test('la page d’ajout connaît le service de dépôt, les mois publiés, et ne se connecte qu’au site et à ce service', () => {
  const html = renderUpload(
    { updatedAt: '', subscriptions: [], months: [{ month: '2026-10' }] },
    { serviceDepot: 'https://planning-accueil-depot.netlify.app/', depot: 'yungNATE/planning-accueil', indiceMotDePasse: 'mdp wifi versailles' },
    { SYVAIN: 'SYLVAIN' },
  );
  assert.match(html, /<p class="field-hint" id="cle-indice">Indice : mdp wifi versailles<\/p>/);
  assert.match(html, /aria-describedby="cle-indice cle-erreur"/);
  assert.ok(html.indexOf('id="cle"') < html.indexOf('id="cle-indice"'), 'indice sous le champ');
  assert.match(html, /type="file" multiple/);
  assert.match(html, /data-service="https:\/\/planning-accueil-depot\.netlify\.app"/);
  assert.match(html, /data-published="\[&quot;2026-10&quot;\]"/);
  assert.match(html, /data-aliases="\{&quot;SYVAIN&quot;:&quot;SYLVAIN&quot;\}"/);
  assert.match(html, /connect-src 'self' https:\/\/planning-accueil-depot\.netlify\.app;/);
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

test('page des plannings : au-delà de six mois, les plus anciens sont repliés', () => {
  const months = Array.from({ length: 8 }, (_, i) => ({
    month: `2026-${String(12 - i).padStart(2, '0')}`, label: 'mois', title: '', source: '', processedAt: '', start: '2026-01-05', end: '2026-01-11', dayCount: 7, slotCount: 1, employees: [],
  }));
  const html = renderIndex({ updatedAt: '', subscriptions: [], months }, {});
  assert.match(html, /<summary>Mois précédents \(2\)<\/summary>/);
  assert.match(html, /class="fallback-wrap"/);
  assert.match(html, /HTMLDialogElement/);
});

test('page d’ajout : section de suppression avec un bouton par mois publié', () => {
  const html = renderUpload(
    { updatedAt: '', subscriptions: [], months: [{ month: '2026-11', label: 'novembre 2026' }, { month: '2026-10', label: 'octobre 2026' }] },
    { serviceDepot: 'https://planning-accueil-depot.netlify.app' },
  );
  assert.match(html, /<h2 id="titre-suppression">Supprimer un mois publié<\/h2>/);
  assert.match(html, /data-delete="2026-10">Supprimer<span class="visually-hidden"> le planning d’octobre 2026<\/span>/);
  assert.match(html, /data-delete="2026-11">Supprimer<span class="visually-hidden"> le planning de novembre 2026<\/span>/);
  assert.match(html, /<p class="empty" data-delete-empty hidden>/);
});
