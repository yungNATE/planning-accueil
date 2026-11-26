// Page « Ajouter un planning ».
// 1. Le fichier est lu dans le navigateur avec le même parser que l'Action, pour signaler les erreurs avant l'envoi.
// 2. Il est envoyé au service de dépôt (fonction Netlify) avec le mot de passe de dépôt ;
//    le service garde la clé GitHub et enregistre le fichier dans plannings/.
// 3. La page suit l'exécution de l'Action déclenchée par ce dépôt jusqu'à la mise en ligne.

const root = document.querySelector('[data-upload]');
const SERVICE = root.dataset.service;
const REPO = root.dataset.repo;
const PUBLISHED = new Set(JSON.parse(root.dataset.published || '[]'));
const ALIASES = JSON.parse(root.dataset.aliases || '{}');
const PASSWORD_KEY = 'planning-accueil:mot-de-passe';
const POLL_MS = Number(root.dataset.pollMs) || 5000;
const FOLLOW_LIMIT_MS = 6 * 60 * 1000;
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
  } catch { /* stockage indisponible : le mot de passe reste en mémoire pour cette page */ }
}

function forgetPassword() {
  try {
    localStorage.removeItem(PASSWORD_KEY);
    sessionStorage.removeItem(PASSWORD_KEY);
  } catch { /* rien à faire */ }
}

let password = storedPassword();

/**
 * Appel au service de dépôt. Rejette une TypeError si le service est injoignable.
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
async function service(route, payload = {}) {
  const response = await fetch(`${SERVICE}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motDePasse: password, ...payload }),
  });
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

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = passwordForm.elements.cle;
  const value = input.value;
  askPassword('');
  if (!value.trim()) {
    askPassword('Saisissez le mot de passe de dépôt.');
    return;
  }
  password = value;
  let result;
  try {
    result = await service('verifier');
  } catch {
    password = '';
    askPassword(UNREACHABLE);
    return;
  }
  if (!result.ok) {
    password = '';
    askPassword(result.data.message || `Le service de dépôt a renvoyé une erreur (${result.status}).`);
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
  resetFile();
  showStep();
  passwordForm.elements.cle.focus();
});

/* ------------------------------------------------------------------ */
/* Lecture et vérification du fichier                                  */
/* ------------------------------------------------------------------ */

let libs;
async function loadLibs() {
  if (!libs) {
    const [xlsx, parser, util] = await Promise.all([
      import('./vendor/xlsx.js'),
      import('./lib/parse-planning.js'),
      import('./lib/util.js'),
    ]);
    libs = { XLSX: xlsx.read ? xlsx : xlsx.default, ...parser, ...util };
  }
  return libs;
}

/** @type {{ file: File, buffer: ArrayBuffer, parsed: any } | null} */
let current = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function setStatus(kind, ...content) {
  statusBox.className = `status${kind ? ` notice notice--${kind}` : ''}`;
  statusBox.replaceChildren(...content);
}

function resetFile() {
  current = null;
  fileInput.value = '';
  preview.hidden = true;
  preview.replaceChildren();
  publishRow.hidden = true;
  publishButton.disabled = false;
  setStatus('');
}

const ofMonth = (label) => (/^[ao]/.test(label) ? `d’${label}` : `de ${label}`);
const link = (href, text) => el('a', { href, rel: 'noopener' }, text);

function issueList(title, issues, kind) {
  return el('div', { class: `notice notice--${kind}` },
    el('p', { class: 'notice__title' }, title),
    el('ul', {}, ...issues.map((issue) => el('li', {}, issue.cell ? `Case ${issue.cell} : ${issue.message}` : issue.message))));
}

async function handleFile(file) {
  resetFile();
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) {
    setStatus('error', 'Choisissez un fichier Excel au format .xlsx.');
    return;
  }
  setStatus('', 'Lecture du fichier…');
  let lib;
  try {
    lib = await loadLibs();
  } catch {
    setStatus('error', 'Le lecteur de fichiers Excel n’a pas pu être chargé. Rechargez la page et réessayez.');
    return;
  }
  const buffer = await file.arrayBuffer();
  let workbook;
  try {
    workbook = lib.XLSX.read(buffer, { type: 'array' });
  } catch {
    setStatus('error', `« ${file.name} » n’est pas un classeur Excel lisible.`);
    return;
  }
  const parsed = lib.parsePlanning(workbook, { source: file.name, aliases: ALIASES });
  current = { file, buffer, parsed };
  setStatus('');

  const blocks = [];
  if (parsed.month) {
    const label = lib.monthLabel(parsed.month);
    blocks.push(el('h3', {}, `Planning ${ofMonth(label)}`));
    if (parsed.start) blocks.push(el('p', { class: 'preview__period' }, `Du ${lib.formatDateFr(parsed.start)} au ${lib.formatDateFr(parsed.end)}`));
    if (PUBLISHED.has(parsed.month)) {
      blocks.push(el('p', { class: 'notice notice--warning' }, `Le planning ${ofMonth(label)} est déjà en ligne : ce fichier le remplacera entièrement.`));
    }
  }
  if (parsed.ok) {
    const total = parsed.employees.reduce((n, e) => n + e.slotCount, 0);
    blocks.push(el('table', { class: 'preview__table' },
      el('caption', {}, `${parsed.employees.length} personne${parsed.employees.length > 1 ? 's' : ''}, ${total} créneau${total > 1 ? 'x' : ''}`),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Nom'), el('th', { scope: 'col' }, 'Créneaux'))),
      el('tbody', {}, ...parsed.employees.map((e) => el('tr', {}, el('th', { scope: 'row' }, e.name), el('td', {}, String(e.slotCount)))))));
  }
  if (parsed.errors.length) blocks.push(issueList('Ce fichier ne peut pas être publié. Corrigez-le dans Excel, puis choisissez-le à nouveau :', parsed.errors, 'error'));
  if (parsed.warnings.length) blocks.push(issueList('À vérifier (la publication reste possible) :', parsed.warnings, 'warning'));

  preview.replaceChildren(...blocks);
  preview.hidden = false;
  publishRow.hidden = !parsed.ok;
  if (parsed.ok) {
    publishButton.focus();
  } else {
    const errorBox = preview.querySelector('.notice--error');
    errorBox?.setAttribute('tabindex', '-1');
    errorBox?.focus();
  }
}

fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));

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
  handleFile(event.dataTransfer?.files?.[0]);
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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

publishButton.addEventListener('click', async () => {
  if (!current?.parsed.ok) return;
  const { file, buffer, parsed } = current;
  const label = libs.monthLabel(parsed.month);
  publishButton.disabled = true;
  setStatus('', 'Envoi du fichier…');

  let result;
  try {
    result = await service('deposer', { nom: file.name, contenu: toBase64(buffer), mois: label });
  } catch {
    publishButton.disabled = false;
    setStatus('error', UNREACHABLE);
    return;
  }

  if (!result.ok) {
    const { erreur, message = `Le service de dépôt a renvoyé une erreur (${result.status}).` } = result.data;
    if (erreur === 'mot-de-passe') {
      // Le mot de passe a été changé depuis qu'il a été mémorisé sur cet appareil
      forgetPassword();
      password = '';
      resetFile();
      showStep();
      askPassword('Le mot de passe a changé : saisissez le nouveau, puis choisissez à nouveau le fichier.');
      return;
    }
    if (SERVICE_PROBLEMS.includes(erreur)) {
      // Problème durable côté service : la personne qui dépose ne peut pas le régler elle-même
      setStatus('error',
        `${message} Prévenez la personne qui gère l’outil. En attendant, quelqu’un qui a accès au dépôt GitHub peut y déposer le fichier : `,
        link(`https://github.com/${REPO}/upload/main/plannings`, 'dossier plannings'),
        '.');
      return;
    }
    publishButton.disabled = false;
    setStatus('error', message);
    return;
  }

  const { sha } = result.data;
  setStatus('progress', 'Fichier enregistré. Génération des agendas et mise en ligne en cours, environ une minute…');
  const started = Date.now();
  while (Date.now() - started < FOLLOW_LIMIT_MS) {
    await sleep(POLL_MS);
    let follow;
    try {
      follow = await service('suivi', { sha });
    } catch {
      continue;
    }
    if (!follow.ok) continue;
    const { etat, lien } = follow.data;
    if (etat === 'publie') {
      setStatus('success',
        `Planning ${ofMonth(label)} publié. `,
        link('./', 'Voir les plannings'),
        ' (si le mois n’apparaît pas encore, rechargez la page dans quelques minutes).');
      PUBLISHED.add(parsed.month);
      return;
    }
    if (etat === 'echec') {
      setStatus('error',
        'Le fichier est bien enregistré, mais la mise en ligne a échoué. Prévenez la personne qui gère l’outil (',
        link(lien, 'détail de l’erreur'),
        ').');
      return;
    }
  }
  setStatus('warning', 'Le fichier est enregistré, mais la mise en ligne n’est pas encore terminée. Revenez sur la page des plannings dans quelques minutes.');
});

showStep();
