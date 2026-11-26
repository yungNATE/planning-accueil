// Page « Ajouter un planning ».
// 1. Le fichier est lu dans le navigateur avec le même parser que l'Action, pour signaler les erreurs avant l'envoi.
// 2. Il est enregistré dans plannings/ via l'API GitHub, avec la clé d'accès de la personne qui publie.
// 3. La page suit l'exécution de l'Action déclenchée par ce commit jusqu'à la mise en ligne.

const root = document.querySelector('[data-upload]');
const REPO = root.dataset.repo;
const BRANCH = root.dataset.branch || 'main';
const PUBLISHED = new Set(JSON.parse(root.dataset.published || '[]'));
const ALIASES = JSON.parse(root.dataset.aliases || '{}');
const TOKEN_KEY = 'planning-accueil:cle-github';
const POLL_MS = Number(root.dataset.pollMs) || 5000;
const FOLLOW_LIMIT_MS = 6 * 60 * 1000;

const $ = (selector) => root.querySelector(selector);
const stepToken = $('#etape-cle');
const stepFile = $('#etape-fichier');
const tokenForm = $('[data-token-form]');
const tokenError = $('[data-token-error]');
const fileInput = $('[data-file]');
const dropzone = $('[data-dropzone]');
const preview = $('[data-preview]');
const publishRow = $('[data-publish-row]');
const publishButton = $('[data-publish]');
const statusBox = $('[data-status]');
const tokenInfo = $('[data-token-info]');

/* ------------------------------------------------------------------ */
/* Clé d'accès                                                         */
/* ------------------------------------------------------------------ */

function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(token, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch { /* stockage indisponible : la clé reste en mémoire pour cette page */ }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* rien à faire */ }
}

let token = storedToken();

async function github(path, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

function showStep() {
  stepToken.hidden = Boolean(token);
  stepFile.hidden = !token;
  tokenInfo.hidden = !token;
}

tokenForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = tokenForm.elements.cle;
  const value = input.value.trim();
  tokenError.textContent = '';
  input.removeAttribute('aria-invalid');
  if (!value) {
    tokenError.textContent = 'Collez la clé créée sur GitHub.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  token = value;
  let response;
  try {
    response = await github(`/repos/${REPO}`);
  } catch {
    token = '';
    tokenError.textContent = 'GitHub ne répond pas. Vérifiez la connexion internet, puis réessayez.';
    return;
  }
  if (!response.ok) {
    token = '';
    tokenError.textContent = response.status === 401
      ? 'GitHub refuse cette clé : elle est incorrecte ou expirée.'
      : `Cette clé ne donne pas accès au dépôt ${REPO}.`;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  storeToken(value, tokenForm.elements.memoriser.checked);
  input.value = '';
  showStep();
  fileInput.focus();
});

$('[data-forget]').addEventListener('click', () => {
  forgetToken();
  token = '';
  resetFile();
  showStep();
  tokenForm.elements.cle.focus();
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

function issueList(title, issues, kind) {
  return el('div', { class: `notice notice--${kind}` },
    el('p', { class: 'notice__title' }, title),
    el('ul', {}, ...issues.map((issue) => el('li', {}, issue.cell ? `${issue.cell} : ${issue.message}` : issue.message))));
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

const ofMonth = (label) => (/^[ao]/.test(label) ? `d’${label}` : `de ${label}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const actionsUrl = () => `https://github.com/${REPO}/actions`;
const link = (href, text) => el('a', { href, rel: 'noopener' }, text);

function apiError(status) {
  if (status === 401) return 'GitHub refuse la clé : elle est incorrecte ou expirée. Utilisez « Oublier la clé », puis enregistrez-en une nouvelle.';
  if (status === 403 || status === 404) return 'La clé n’a pas le droit d’écrire dans le dépôt. Vérifiez sur GitHub que la permission « Contents » est réglée sur « Read and write ».';
  if (status === 409 || status === 422) return 'Le dépôt a changé pendant l’envoi. Cliquez à nouveau sur « Publier ce planning ».';
  return `GitHub a renvoyé une erreur (${status}). Réessayez dans quelques instants.`;
}

publishButton.addEventListener('click', async () => {
  if (!current?.parsed.ok) return;
  const { file, buffer, parsed } = current;
  const label = libs.monthLabel(parsed.month);
  const path = `plannings/${file.name}`.split('/').map(encodeURIComponent).join('/');
  publishButton.disabled = true;
  setStatus('', 'Envoi du fichier…');

  let commitSha;
  try {
    const existing = await github(`/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`);
    if (!existing.ok && existing.status !== 404) throw new Error(apiError(existing.status));
    const sha = existing.ok ? (await existing.json()).sha : undefined;
    const response = await github(`/repos/${REPO}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Planning ${label} déposé depuis le site`,
        content: toBase64(buffer),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!response.ok) throw new Error(apiError(response.status));
    commitSha = (await response.json()).commit?.sha;
  } catch (error) {
    publishButton.disabled = false;
    setStatus('error', error instanceof TypeError ? 'GitHub ne répond pas. Vérifiez la connexion internet, puis réessayez.' : error.message);
    return;
  }

  setStatus('progress', 'Fichier enregistré. Génération des agendas et mise en ligne en cours, environ une minute…');
  const started = Date.now();
  while (Date.now() - started < FOLLOW_LIMIT_MS) {
    await sleep(POLL_MS);
    let run;
    try {
      const response = await github(`/repos/${REPO}/actions/runs?head_sha=${commitSha}&per_page=1`);
      if (!response.ok) continue;
      run = (await response.json()).workflow_runs?.[0];
    } catch {
      continue;
    }
    if (!run || run.status !== 'completed') continue;
    if (run.conclusion === 'success') {
      setStatus('success',
        `Planning ${ofMonth(label)} publié. `,
        link('./', 'Voir les plannings'),
        ' (si le mois n’apparaît pas encore, rechargez la page dans une ou deux minutes).');
      PUBLISHED.add(parsed.month);
    } else {
      setStatus('error', 'Le fichier est enregistré, mais la publication a échoué. ', link(run.html_url, 'Voir le détail sur GitHub'), '.');
    }
    return;
  }
  setStatus('warning', 'Le fichier est enregistré, mais la publication n’est pas encore terminée. ', link(actionsUrl(), 'Suivre la publication sur GitHub'), '.');
});

showStep();
