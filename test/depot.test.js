// Service de dépôt (fonction Netlify) : GitHub est simulé.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler, { config, storedName } from '../depot/netlify/functions/depot.mts';
import { OCTOBER } from './helpers.js';

const SERVICE = 'https://planning-accueil-depot.netlify.app';
const xlsx = readFileSync(OCTOBER);
const realFetch = globalThis.fetch;
/** @type {{ method: string, url: string, body: any, auth: string | null }[]} */
let calls;
/** @type {(url: string, init: RequestInit) => Response} */
let github;

beforeEach(() => {
  process.env.GITHUB_TOKEN = 'github_pat_service';
  process.env.MOT_DE_PASSE = 'Jardin Lune 42';
  delete process.env.ORIGINE_AUTORISEE;
  calls = [];
  github = () => Response.json({}, { status: 500 });
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({
      method: init.method ?? 'GET',
      url: href,
      body: init.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init.headers).get('authorization'),
    });
    return github(href, init);
  };
});

afterEach(() => { globalThis.fetch = realFetch; });

/** @param {string} route @param {object} body */
const post = (route, body, origin = 'https://yungnate.github.io') => handler(new Request(`${SERVICE}/api/${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify(body),
}));

test('routes déclarées', () => {
  assert.deepEqual(config.path, ['/api/verifier', '/api/deposer', '/api/supprimer', '/api/suivi']);
});

test('pré-vérification CORS limitée au site des plannings', async () => {
  const res = await handler(new Request(`${SERVICE}/api/deposer`, { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://yungnate.github.io');
});

test('mot de passe : correct, incorrect, absent', async () => {
  assert.equal((await post('verifier', { motDePasse: 'Jardin Lune 42' })).status, 200);
  const wrong = await post('verifier', { motDePasse: 'jardin lune 42' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).message, 'Mot de passe incorrect.');
  assert.equal((await post('deposer', { nom: 'a.xlsx', contenu: '' })).status, 401);
  assert.equal(calls.length, 0, 'aucun appel à GitHub sans mot de passe');
});

test('service non configuré : message explicite', async () => {
  delete process.env.GITHUB_TOKEN;
  const res = await post('verifier', { motDePasse: 'Jardin Lune 42' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).erreur, 'configuration');
});

test('dépôt d’un nouveau fichier : enregistré dans plannings/ avec la clé du service', async () => {
  github = (url, init) => {
    if (init.method === 'PUT') return Response.json({ commit: { sha: 'a'.repeat(40) } }, { status: 201 });
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const res = await post('deposer', {
    motDePasse: 'Jardin Lune 42', nom: 'PLANNING NOVEMBRE 26.xlsx', contenu: xlsx.toString('base64'), mois: 'novembre 2026',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sha: 'a'.repeat(40), fichier: 'PLANNING NOVEMBRE 26.xlsx' });
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, 'https://api.github.com/repos/yungNATE/planning-accueil/contents/plannings/PLANNING%20NOVEMBRE%2026.xlsx');
  assert.equal(put.auth, 'Bearer github_pat_service');
  assert.equal(put.body.message, 'Planning novembre 2026 déposé depuis le site');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.sha, undefined);
  assert.ok(Buffer.from(put.body.content, 'base64').equals(xlsx));
});

test('remplacement d’un fichier existant : le sha actuel est transmis', async () => {
  github = (url, init) => (init.method === 'PUT'
    ? Response.json({ commit: { sha: 'b'.repeat(40) } }, { status: 200 })
    : Response.json({ sha: 'ancien' }));
  await post('deposer', { motDePasse: 'Jardin Lune 42', nom: 'PLANNING_OCTOBRE_26.xlsx', contenu: xlsx.toString('base64') });
  assert.equal(calls.find((c) => c.method === 'PUT').body.sha, 'ancien');
});

test('fichiers refusés avant tout envoi à GitHub', async () => {
  const pass = { motDePasse: 'Jardin Lune 42' };
  assert.equal((await post('deposer', { ...pass, nom: 'planning.pdf', contenu: xlsx.toString('base64') })).status, 400);
  assert.equal((await post('deposer', { ...pass, nom: 'planning', contenu: xlsx.toString('base64') })).status, 400);
  assert.equal((await post('deposer', { ...pass, nom: 'planning.xlsx', contenu: Buffer.from('pas un zip').toString('base64') })).status, 400);
  assert.equal((await post('deposer', { ...pass, nom: 'planning.xlsx', contenu: '' })).status, 400);
  assert.equal(calls.length, 0);
});

test('clé GitHub expirée : message clair', async () => {
  github = () => Response.json({ message: 'Bad credentials' }, { status: 401 });
  const res = await post('deposer', { motDePasse: 'Jardin Lune 42', nom: 'planning.xlsx', contenu: xlsx.toString('base64') });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).erreur, 'cle-github');
});

test('suivi de la publication', async () => {
  const sha = 'c'.repeat(40);
  let runs = [];
  github = () => Response.json({ workflow_runs: runs });
  const etat = async () => (await (await post('suivi', { motDePasse: 'Jardin Lune 42', sha })).json()).etat;
  assert.equal(await etat(), 'attente');
  runs = [{ status: 'in_progress', conclusion: null, html_url: 'https://github.com/run' }];
  assert.equal(await etat(), 'en-cours');
  runs = [{ status: 'completed', conclusion: 'success', html_url: 'https://github.com/run' }];
  assert.equal(await etat(), 'publie');
  runs = [{ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/run' }];
  assert.equal(await etat(), 'echec');
  assert.match(calls.at(-1).url, new RegExp(`actions/runs\\?head_sha=${sha}`));
  assert.equal((await post('suivi', { motDePasse: 'Jardin Lune 42', sha: 'x' })).status, 400);
});

test('exécution annulée et remplacée : le suivi passe à l’exécution suivante', async () => {
  const sha = 'e'.repeat(40);
  let latest = { status: 'in_progress', conclusion: null, html_url: 'https://github.com/run/2' };
  github = (url) => (url.includes('head_sha=')
    ? Response.json({ workflow_runs: [{ status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com/run/1' }] })
    : Response.json({ workflow_runs: [latest] }));
  const etat = async () => (await (await post('suivi', { motDePasse: 'Jardin Lune 42', sha })).json());
  assert.deepEqual(await etat(), { etat: 'en-cours', lien: 'https://github.com/run/2' });
  latest = { status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/2' };
  assert.deepEqual(await etat(), { etat: 'publie', lien: 'https://github.com/run/2' });
  assert.match(calls.at(-1).url, /actions\/workflows\/publier\.yml\/runs\?branch=main/);
});

test('noms de fichiers : préfixe du mois, caractères spéciaux, chemins, formats', () => {
  assert.equal(storedName('PLANNING OCTOBRE 26.xlsx', ['2026-10']), '2026-10 PLANNING OCTOBRE 26.xlsx');
  assert.equal(storedName('planning n°3 & co.XLSX', ['2026-11', '2026-10']), '2026-10+2026-11 planning n-3 - co.xlsx');
  assert.equal(storedName('../../config/settings.xlsx', []), 'settings.xlsx');
  assert.equal(storedName('2026-10 planning.xlsx', ['2026-10']), '2026-10 planning.xlsx');
  assert.equal(storedName('ancien.xls', []), 'ancien.xls');
  assert.equal(storedName('libre.ods', []), 'libre.ods');
  assert.equal(storedName('a.pdf', []), null);
});

test('dépôt : nom préfixé par le mois, ancien format .xls accepté', async () => {
  github = (url, init) => (init.method === 'PUT' ? Response.json({ commit: { sha: 'a'.repeat(40) } }, { status: 201 }) : Response.json({}, { status: 404 }));
  const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(100)]);
  const res = await post('deposer', { motDePasse: 'Jardin Lune 42', nom: 'planning.xls', contenu: ole.toString('base64'), moisCles: ['2026-12'] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).fichier, '2026-12 planning.xls');
  assert.match(calls.find((c) => c.method === 'PUT').url, /plannings\/2026-12%20planning\.xls$/);
});

test('mot de passe saisi avec des espaces autour : accepté', async () => {
  assert.equal((await post('verifier', { motDePasse: '  Jardin Lune 42 ' })).status, 200);
});

test('plusieurs sites autorisés : l’origine de la requête est renvoyée si elle est autorisée', async () => {
  process.env.ORIGINE_AUTORISEE = 'https://yungnate.github.io, https://plannings.exemple.fr';
  const res = await post('verifier', { motDePasse: 'Jardin Lune 42' }, 'https://plannings.exemple.fr');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://plannings.exemple.fr');
  const other = await post('verifier', { motDePasse: 'Jardin Lune 42' }, 'https://pirate.exemple');
  assert.equal(other.headers.get('access-control-allow-origin'), 'https://yungnate.github.io');
});

test('dépôts simultanés du même fichier : nouvel essai automatique', async () => {
  let puts = 0;
  github = (url, init) => {
    if (init.method !== 'PUT') return Response.json({ sha: `version-${puts}` });
    puts += 1;
    return puts === 1 ? Response.json({ message: 'conflict' }, { status: 409 }) : Response.json({ commit: { sha: 'f'.repeat(40) } });
  };
  const res = await post('deposer', { motDePasse: 'Jardin Lune 42', nom: 'planning.xlsx', contenu: xlsx.toString('base64') });
  assert.equal(res.status, 200);
  assert.equal(puts, 2);
  assert.equal(calls.filter((c) => c.method === 'PUT').at(-1).body.sha, 'version-1');
});

test('publication en file d’attente : état « file »', async () => {
  github = () => Response.json({ workflow_runs: [{ status: 'queued', conclusion: null, html_url: 'https://github.com/run' }] });
  const res = await post('suivi', { motDePasse: 'Jardin Lune 42', sha: '1'.repeat(40) });
  assert.equal((await res.json()).etat, 'file');
});

test('GitHub qui ne répond pas : message réseau, pas de plantage', async () => {
  github = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const res = await post('deposer', { motDePasse: 'Jardin Lune 42', nom: 'planning.xlsx', contenu: xlsx.toString('base64') });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).erreur, 'reseau');
});

test('limitation des appels en rafale déclarée pour Netlify', () => {
  assert.deepEqual(config.rateLimit, { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] });
});

test('suppression : une demande est déposée dans demandes/, avec la clé du service', async () => {
  github = (url, init) => (init.method === 'PUT' ? Response.json({ commit: { sha: '9'.repeat(40) } }, { status: 201 }) : Response.json({}, { status: 404 }));
  const res = await post('supprimer', { motDePasse: 'Jardin Lune 42', mois: '2026-10' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sha: '9'.repeat(40) });
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, 'https://api.github.com/repos/yungNATE/planning-accueil/contents/demandes/supprimer-2026-10.json');
  assert.equal(put.body.message, 'Suppression du planning octobre 2026 demandée depuis le site');
  assert.equal(JSON.parse(Buffer.from(put.body.content, 'base64').toString()).mois, '2026-10');
  assert.equal(put.auth, 'Bearer github_pat_service');
});

test('suppression : mois invalide ou mot de passe faux refusés sans appel à GitHub', async () => {
  assert.equal((await post('supprimer', { motDePasse: 'Jardin Lune 42', mois: '2026-13' })).status, 400);
  assert.equal((await post('supprimer', { motDePasse: 'Jardin Lune 42', mois: '../../x' })).status, 400);
  assert.equal((await post('supprimer', { motDePasse: 'faux', mois: '2026-10' })).status, 401);
  assert.equal(calls.length, 0);
});
