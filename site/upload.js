// Page « Ajouter un planning ».
// 1. Chaque fichier est lu dans le navigateur avec le même lecteur que la publication (tous ses onglets),
//    pour signaler les erreurs avant l'envoi.
// 2. Les fichiers valides sont envoyés un par un au service de dépôt (fonction Netlify) avec le mot de passe ;
//    le service garde la clé GitHub et les enregistre dans plannings/.
// 3. La page suit la publication déclenchée par le dernier envoi : elle traite tous les fichiers en attente.

const root = document.querySelector('[data-upload]');
const SERVICE = root.dataset.service;
const REPO = root.dataset.repo;
const PUBLISHED = new Set(JSON.parse(root.dataset.published || '[]'));
const ALIASES = JSON.parse(root.dataset.aliases || '{}');
const PASSWORD_KEY = 'planning-accueil:mot-de-passe';
const POLL_MS = Number(root.dataset.pollMs) || 5000;
const FOLLOW_LIMIT_MS = 8 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const EXTENSION_RE = /\.(xlsx|xlsm|xls|ods)$/i;
const SERVICE_PROBLEMS = ['cle-github', 'droits-github', 'configuration'];

const $ = (selector) => root.querySelector(selector);
const stepPassword = $('#etape-cle');
const stepFile = $('#etape-fichier');
const passwordForm = $('[data-token-form]');
const passwordError = $('[data-token-error]');
const fileInput = $('[data-file]');
const dropzone = $('[data-dropzone]');
const preview = $('[data-preview]');
const publishRow = $('[data-publish-row]');
const publishButton = $('[data-publish]');
const statusBox = $('[data-status]');
const passwordInfo = $('[data-token-info]');

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const ofMonth = (label) => (/^[ao]/.test(label) ? `d’${label}` : `de ${label}`);
const link = (href, text) => el('a', { href, rel: 'noopener' }, text);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** fetch avec délai maximal (les anciens navigateurs sans AbortSignal.timeout attendent sans limite) */
function fetchWithin(url, options, ms) {
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined;
  return fetch(url, { ...options, ...(signal ? { signal } : {}) });
}

function setStatus(kind, ...content) {
  statusBox.className = `status${kind ? ` notice notice--${kind}` : ''}`;
  statusBox.replaceChildren(...content);
}

/* ------------------------------------------------------------------ */
/* Mot de passe                                                        */
/* ------------------------------------------------------------------ */

function storedPassword() {
  try {
    localStorage.removeItem('planning-accueil:cle-github'); // ancienne version de la page
    return sessionStorage.getItem(PASSWORD_KEY) || localStorage.getItem(PASSWORD_KEY) || '';
  } catch {
    return '';
  }
}

function storePassword(value, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(PASSWORD_KEY, value);
  } catch { /* stockage indisponible (navigation privée) : le mot de passe reste en mémoire pour cette page */ }
}

function forgetPassword() {
  try {
    localStorage.removeItem(PASSWORD_KEY);
    sessionStorage.removeItem(PASSWORD_KEY);
  } catch { /* rien à faire */ }
}

let password = storedPassword();

/**
 * Appel au service de dépôt. Rejette si le service est injoignable ou ne répond pas à temps.
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
async function service(route, payload = {}, timeoutMs = 20000) {
  const response = await fetchWithin(`${SERVICE}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motDePasse: password, ...payload }),
  }, timeoutMs);
  let data = {};
  try { data = await response.json(); } catch { /* réponse sans JSON */ }
  return { ok: response.ok, status: response.status, data };
}

const UNREACHABLE = 'Le service de dépôt ne répond pas. Vérifiez la connexion internet, puis réessayez.';

function showStep() {
  stepPassword.hidden = Boolean(password);
  stepFile.hidden = !password;
  passwordInfo.hidden = !password;
}

function askPassword(message) {
  const input = passwordForm.elements.cle;
  passwordError.textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  input.focus();
}

let checking = false;
passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checking) return;
  const input = passwordForm.elements.cle;
  const value = input.value.trim();
  askPassword('');
  if (!value) {
    askPassword('Saisissez le mot de passe de dépôt.');
    return;
  }
  checking = true;
  password = value;
  let result;
  try {
    result = await service('verifier');
  } catch {
    result = null;
  } finally {
    checking = false;
  }
  if (!result) {
    password = '';
    askPassword(UNREACHABLE);
    return;
  }
  if (!result.ok) {
    password = '';
    askPassword(result.status === 429
      ? 'Trop d’essais en peu de temps : patientez une minute, puis réessayez.'
      : result.data.message || `Le service de dépôt a renvoyé une erreur (${result.status}).`);
    return;
  }
  storePassword(value, passwordForm.elements.memoriser.checked);
  input.value = '';
  passwordError.textContent = '';
  showStep();
  fileInput.focus();
});

$('[data-forget]').addEventListener('click', () => {
  forgetPassword();
  password = '';
  resetFiles();
  showStep();
  passwordForm.elements.cle.focus();
});

/* ------------------------------------------------------------------ */
/* Lecture et vérification des fichiers                                */
/* ------------------------------------------------------------------ */

let libs;
async function loadLibs() {
  if (!libs) {
    const [xlsx, parser, util, names] = await Promise.all([
      import('./vendor/xlsx.js'),
      import('./lib/parse-planning.js'),
      import('./lib/util.js'),
      import('./lib/names.js'),
    ]);
    libs = { XLSX: xlsx.read ? xlsx : xlsx.default, ...parser, ...util, ...names };
  }
  return libs;
}

/** Personnes des mois déjà publiés (même rattachement des fautes de frappe que la publication) */
let knownNames = [];
fetchWithin('manifest.json', { cache: 'no-store' }, 10000)
  .then((r) => (r.ok ? r.json() : null))
  .then(async (manifest) => {
    if (!manifest) return;
    for (const m of manifest.months ?? []) PUBLISHED.add(m.month);
    const { nameKey } = await import('./lib/names.js');
    const byKey = new Map();
    for (const m of manifest.months ?? []) for (const e of m.employees ?? []) byKey.set(nameKey(e.name), e.name);
    knownNames = [...byKey].map(([key, name]) => ({ key, name }));
  })
  .catch(() => { /* manifeste indisponible : la liste intégrée à la page suffit */ });

/**
 * @typedef {{ file: File, buffer: ArrayBuffer | null, plannings: any[], errors: string[], card: HTMLElement, line: HTMLElement }} Item
 * @type {Item[]}
 */
let items = [];
/** Envoi en cours : on ne change pas de fichiers au milieu */
let busy = false;
/** Incrémenté à chaque nouvelle sélection : le suivi d'une publication précédente s'arrête alors */
let generation = 0;

function resetFiles() {
  generation += 1;
  items = [];
  fileInput.value = '';
  preview.hidden = true;
  preview.replaceChildren();
  publishRow.hidden = true;
  publishButton.disabled = false;
  setStatus('');
}

function issueList(title, issues, kind) {
  return el('div', { class: `notice notice--${kind}` },
    el('p', { class: 'notice__title' }, title),
    el('ul', {}, ...issues.map((issue) => el('li', {}, issue.cell ? `Case ${issue.cell} : ${issue.message}` : issue.message))));
}

/** Lit un fichier et prépare sa carte d'aperçu */
async function readItem(file, lib) {
  /** @type {Item} */
  const item = { file, buffer: null, plannings: [], errors: [], card: el('section', { class: 'file-card' }), line: el('p', { class: 'file-card__status' }) };
  if (!EXTENSION_RE.test(file.name)) {
    item.errors.push('Ce n’est pas un fichier Excel ou LibreOffice (.xlsx, .xls, .ods). Dans Excel : Fichier > Enregistrer sous > Classeur Excel.');
  } else if (file.size > MAX_BYTES) {
    item.errors.push('Le fichier dépasse 4 Mo : ce n’est sans doute pas un planning.');
  } else if (file.size === 0) {
    item.errors.push('Le fichier est vide.');
  } else {
    try {
      item.buffer = await file.arrayBuffer();
      const workbook = lib.XLSX.read(item.buffer, { type: 'array', cellNF: true, cellStyles: true });
      const { plannings, errors } = lib.parseWorkbook(workbook, { source: file.name, aliases: ALIASES, knownNames });
      item.plannings = plannings;
      item.errors.push(...errors.map((e) => e.message));
    } catch (error) {
      item.errors.push(/password/i.test(String(error?.message))
        ? 'Le fichier est protégé par un mot de passe : enregistrez-en une copie sans protection, puis choisissez cette copie.'
        : 'Ce fichier n’a pas pu être lu. Ouvrez-le dans Excel, enregistrez-le au format .xlsx, puis choisissez-le à nouveau.');
    }
  }

  const blocks = [el('h3', { class: 'file-card__name' }, file.name)];
  if (item.errors.length) blocks.push(issueList('Ce fichier ne peut pas être publié :', item.errors.map((message) => ({ message })), 'error'));
  for (const p of item.plannings) {
    const label = p.month ? lib.monthLabel(p.month) : '';
    const group = el('div', { class: 'planning' });
    if (label) group.append(el('h4', {}, `Planning ${ofMonth(label)}${item.plannings.length > 1 ? ` (onglet « ${p.sheet} »)` : ''}`));
    if (p.start) group.append(el('p', { class: 'preview__period' }, `Du ${lib.formatDateFr(p.start)} au ${lib.formatDateFr(p.end)}`));
    if (p.month && PUBLISHED.has(p.month)) group.append(el('p', { class: 'notice notice--warning' }, `Le planning ${ofMonth(label)} est déjà en ligne : ce fichier le remplacera entièrement.`));
    if (p.ok) {
      const total = p.employees.reduce((n, e) => n + e.slotCount, 0);
      group.append(el('table', { class: 'preview__table' },
        el('caption', {}, `${plural(p.employees.length, 'personne', 'personnes')}, ${plural(total, 'créneau', 'créneaux')}`),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Nom'), el('th', { scope: 'col' }, 'Créneaux'))),
        el('tbody', {}, ...p.employees.map((e) => el('tr', {}, el('th', { scope: 'row' }, e.name), el('td', {}, String(e.slotCount)))))));
    }
    if (p.errors.length) group.append(issueList('Ce planning ne peut pas être publié. Corrigez le fichier dans Excel, puis choisissez-le à nouveau :', p.errors, 'error'));
    if (p.warnings.length) group.append(issueList('À vérifier (la publication reste possible) :', p.warnings, 'warning'));
    blocks.push(group);
  }
  blocks.push(item.line);
  item.card.replaceChildren(...blocks);
  return item;
}

const publishable = (item) => item.buffer && !item.errors.length && item.plannings.length > 0 && item.plannings.every((p) => p.ok);

async function handleFiles(fileList) {
  if (busy) return;
  const files = [...(fileList ?? [])];
  resetFiles();
  if (!files.length) return;
  setStatus('', files.length > 1 ? `Lecture de ${files.length} fichiers…` : 'Lecture du fichier…');
  let lib;
  try {
    lib = await loadLibs();
  } catch {
    setStatus('error', 'Le lecteur de fichiers Excel n’a pas pu être chargé. Rechargez la page et réessayez.');
    return;
  }
  for (const file of files) items.push(await readItem(file, lib));
  setStatus('');

  const ready = items.filter(publishable);
  const blocks = items.map((item) => item.card);
  // Même mois dans plusieurs fichiers : le dernier envoyé fera foi
  const seen = new Map();
  const duplicates = new Set();
  for (const item of ready) {
    for (const p of item.plannings) {
      if (seen.has(p.month)) duplicates.add(p.month);
      seen.set(p.month, item.file.name);
    }
  }
  for (const month of duplicates) {
    blocks.push(el('p', { class: 'notice notice--warning' }, `Plusieurs fichiers concernent ${lib.monthLabel(month)} : celui placé en dernier dans la liste (« ${seen.get(month)} ») fera foi.`));
  }
  const excluded = items.filter((item) => !publishable(item));
  if (excluded.length && ready.length) {
    blocks.push(el('p', { class: 'notice notice--warning' }, `${excluded.length > 1 ? 'Ces fichiers ne seront pas envoyés' : 'Ce fichier ne sera pas envoyé'} : ${excluded.map((i) => `« ${i.file.name} »`).join(', ')}.`));
  }
  preview.replaceChildren(...blocks);
  preview.hidden = false;

  const months = ready.flatMap((item) => item.plannings);
  publishRow.hidden = ready.length === 0;
  publishButton.textContent = months.length > 1 ? `Publier les ${months.length} plannings` : 'Publier ce planning';
  if (ready.length) {
    publishButton.focus();
  } else {
    const errorBox = preview.querySelector('.notice--error');
    errorBox?.setAttribute('tabindex', '-1');
    errorBox?.focus();
  }
}

fileInput.addEventListener('change', () => handleFiles(fileInput.files));

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dropzone--over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dropzone--over'));
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  handleFiles(event.dataTransfer?.files);
});

/* ------------------------------------------------------------------ */
/* Publication                                                         */
/* ------------------------------------------------------------------ */

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Avertit avant de quitter la page tant qu'un envoi n'est pas confirmé */
const guardLeave = (event) => {
  event.preventDefault();
  event.returnValue = '';
};

publishButton.addEventListener('click', async () => {
  const ready = items.filter(publishable);
  if (!ready.length || busy) return;
  busy = true;
  publishButton.disabled = true;
  fileInput.disabled = true;
  window.addEventListener('beforeunload', guardLeave);
  const lib = libs;

  /** @type {{ sha: string, labels: string[] }[]} */
  const sent = [];
  let stopped = false;
  for (const [index, item] of ready.entries()) {
    const labels = item.plannings.map((p) => lib.monthLabel(p.month));
    setStatus('', ready.length > 1 ? `Envoi du fichier ${index + 1} sur ${ready.length}…` : 'Envoi du fichier…');
    item.line.textContent = 'Envoi…';
    let result;
    try {
      result = await service('deposer', {
        nom: item.file.name,
        contenu: toBase64(item.buffer),
        mois: labels.join(', '),
        moisCles: item.plannings.map((p) => p.month),
      }, 45000);
    } catch {
      result = null;
    }
    if (result?.ok) {
      item.line.textContent = 'Fichier enregistré.';
      sent.push({ sha: result.data.sha, labels });
      continue;
    }
    if (!result) {
      item.line.textContent = 'Non envoyé : le service de dépôt ne répond pas.';
      continue;
    }
    const { erreur, message = `Le service de dépôt a renvoyé une erreur (${result.status}).` } = result.data;
    item.line.textContent = `Non envoyé : ${result.status === 429 ? 'trop d’envois en peu de temps, réessayez dans une minute.' : message}`;
    if (erreur === 'mot-de-passe') {
      // Le mot de passe a été changé depuis qu'il a été mémorisé sur cet appareil
      forgetPassword();
      password = '';
      window.removeEventListener('beforeunload', guardLeave);
      busy = false;
      fileInput.disabled = false;
      resetFiles();
      showStep();
      askPassword('Le mot de passe a changé : saisissez le nouveau, puis choisissez à nouveau les fichiers.');
      return;
    }
    if (SERVICE_PROBLEMS.includes(erreur)) {
      stopped = true;
      setStatus('error',
        `${message} Prévenez la personne qui gère l’outil. En attendant, quelqu’un qui a accès au dépôt GitHub peut y déposer le fichier : `,
        link(`https://github.com/${REPO}/upload/main/plannings`, 'dossier plannings'),
        '.');
      break;
    }
  }
  window.removeEventListener('beforeunload', guardLeave);
  fileInput.disabled = false;
  busy = false;
  const myGeneration = generation;

  if (!sent.length) {
    publishButton.disabled = stopped;
    if (!stopped) setStatus('error', 'Aucun fichier n’a pu être envoyé : le détail est indiqué sous chaque fichier. Corrigez, puis cliquez à nouveau sur le bouton.');
    return;
  }

  const labels = sent.flatMap((s) => s.labels);
  const what = labels.length > 1 ? `Plannings ${labels.map(ofMonth).join(', ').replace(/, ([^,]*)$/, ' et $1')}` : `Planning ${ofMonth(labels[0])}`;
  const failedCount = ready.length - sent.length;
  const partNote = failedCount ? ` ${plural(failedCount, 'fichier n’a pas été envoyé', 'fichiers n’ont pas été envoyés')} : voir ci-dessus.` : '';
  setStatus('progress', `${sent.length > 1 ? 'Fichiers enregistrés' : 'Fichier enregistré'}. Génération des agendas et mise en ligne en cours, environ une minute…${partNote}`);

  // La publication déclenchée par le dernier envoi traite tous les fichiers en attente
  const { sha } = sent[sent.length - 1];
  const started = Date.now();
  let lastState = '';
  while (Date.now() - started < FOLLOW_LIMIT_MS) {
    await sleep(POLL_MS);
    if (myGeneration !== generation) return; // autres fichiers choisis entre-temps
    let follow;
    try {
      follow = await service('suivi', { sha }, 15000);
    } catch {
      continue;
    }
    if (!follow.ok) continue;
    const { etat, lien } = follow.data;
    if (etat === 'file' && lastState !== 'file') {
      setStatus('progress', `En attente de la fin d’une autre publication, puis mise en ligne…${partNote}`);
    } else if (etat === 'en-cours' && lastState !== 'en-cours') {
      setStatus('progress', `Génération des agendas et mise en ligne en cours…${partNote}`);
    }
    lastState = etat;
    if (myGeneration !== generation) return;
    if (etat === 'publie') {
      for (const p of ready.flatMap((i) => i.plannings)) PUBLISHED.add(p.month);
      setStatus('success',
        `${what} ${labels.length > 1 ? 'publiés' : 'publié'}. `,
        link('./', 'Voir les plannings'),
        ` (si le mois n’apparaît pas encore, rechargez la page dans quelques minutes).${partNote}`);
      return;
    }
    if (etat === 'echec') {
      setStatus('error',
        'Les fichiers sont bien enregistrés, mais la mise en ligne a échoué. Prévenez la personne qui gère l’outil (',
        link(lien, 'détail de l’erreur'),
        ').');
      return;
    }
  }
  if (myGeneration !== generation) return;
  setStatus('warning', 'Les fichiers sont enregistrés, mais la mise en ligne n’est pas encore terminée. Revenez sur la page des plannings dans quelques minutes.');
});

showStep();
