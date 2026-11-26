// @ts-check
/**
 * Rendu de la page d'accueil à partir du manifeste (module pur).
 * La page est entièrement générée par l'Action : le navigateur ne parse et ne génère rien.
 */
import {
  capitalize, formatDateFr, monthLabel, parseIso,
} from './util.js';

/** @param {unknown} value */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** « octobre 2026 » → « d’octobre 2026 », « mars 2026 » → « de mars 2026 » */
function ofMonth(/** @type {string} */ label) {
  return /^[aeiouyh]/i.test(label.normalize('NFD').replace(/[̀-ͯ]/g, '')) ? `d’${label}` : `de ${label}`;
}

const DOWNLOAD_ICON = '<svg class="icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M10 3v9m0 0-4-4m4 4 4-4M4 15.5h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f5c5a"/><g fill="#fff"><rect x="7" y="9" width="5" height="5" rx="1"/><rect x="14" y="9" width="5" height="5" rx="1"/><rect x="21" y="9" width="5" height="5" rx="1"/><rect x="7" y="17" width="5" height="5" rx="1"/><rect x="14" y="17" width="5" height="5" rx="1"/></g></svg>');

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/**
 * @typedef {{ name: string, slug: string, slotCount: number, file: string | null }} ManifestPerson
 * @typedef {{
 *   month: string, label: string, title: string, source: string, processedAt: string,
 *   start: string, end: string, dayCount: number, slotCount: number, employees: ManifestPerson[]
 * }} ManifestMonth
 * @typedef {{ name: string, slug: string, file: string, slotCount: number }} ManifestSubscription
 * @typedef {{ updatedAt: string, months: ManifestMonth[], subscriptions: ManifestSubscription[] }} Manifest
 */

/**
 * Mini-calendrier décoratif : une case par jour du planning, pleine si le jour est dans le mois du titre.
 * @param {ManifestMonth} m
 */
function weekGrid(m) {
  const cells = [];
  for (let i = 0; i < m.dayCount; i++) {
    const { y, m: mm, d } = parseIso(m.start);
    const date = new Date(Date.UTC(y, mm - 1, d + i));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    cells.push(`<span class="grid__day${key === m.month ? ' grid__day--in' : ''}"></span>`);
  }
  return `<span class="grid" aria-hidden="true">${cells.join('')}</span>`;
}

/**
 * @param {Manifest} manifest
 * @param {{ siteUrl?: string, titre?: string }} settings
 */
export function renderIndex(manifest, settings = {}) {
  const base = (settings.siteUrl ?? '').replace(/\/?$/, '/');
  const subs = new Map(manifest.subscriptions.map((s) => [s.slug, s]));
  const updated = manifest.updatedAt
    ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' }).format(new Date(manifest.updatedAt))
    : '';

  const monthButtons = manifest.months.map((m, i) => {
    const people = m.employees.length;
    return `
        <li>
          <button type="button" class="month${i === 0 ? ' month--latest' : ''}" data-open="mois-${esc(m.month)}" aria-haspopup="dialog">
            <span class="month__text">
              <span class="month__name">${esc(capitalize(m.label))}</span>
              <span class="month__period">Du ${esc(formatDateFr(m.start, { weekday: false, year: false }))} au ${esc(formatDateFr(m.end, { weekday: false, year: false }))}</span>
              <span class="month__meta">${esc(plural(people, 'personne', 'personnes'))}, ${esc(plural(m.slotCount, 'créneau', 'créneaux'))}</span>
            </span>
            ${weekGrid(m)}
          </button>
        </li>`;
  }).join('');

  const dialogs = manifest.months.map((m) => {
    const id = `mois-${m.month}`;
    const items = m.employees.map((p) => {
      const sub = subs.get(p.slug);
      const subId = `abo-${m.month}-${p.slug}`;
      const download = p.file
        ? `<a class="person__download" href="${esc(p.file)}" download="Accueil-${esc(p.name.replace(/\s+/g, '-'))}-${esc(m.month)}.ics" data-slug="${esc(p.slug)}">
                <span class="visually-hidden">Télécharger l’agenda de </span><span class="person__name">${esc(p.name)}</span><span class="visually-hidden">, </span>
                <span class="person__count">${esc(plural(p.slotCount, 'créneau', 'créneaux'))}${DOWNLOAD_ICON}</span>
              </a>`
        : `<span class="person__download person__download--empty">
                <span class="person__name">${esc(p.name)}</span>
                <span class="person__count">aucun créneau</span>
              </span>`;
      const subscribe = sub
        ? `<button type="button" class="person__subscribe" aria-expanded="false" aria-controls="${esc(subId)}">S’abonner<span class="visually-hidden"> à l’agenda de ${esc(p.name)}</span></button>
              <div class="subscription" id="${esc(subId)}" hidden>
                <p>Avec un abonnement, votre application d’agenda ajoute d’elle-même les prochains plannings : plus besoin de télécharger chaque mois.</p>
                <label for="url-${esc(subId)}">Adresse de l’agenda de ${esc(p.name)}</label>
                <div class="subscription__row">
                  <input id="url-${esc(subId)}" type="text" readonly value="${esc(base + sub.file)}" data-path="${esc(sub.file)}">
                  <button type="button" class="button-secondary" data-copy="url-${esc(subId)}">Copier</button>
                </div>
                <p><a class="webcal" href="${esc(base.replace(/^https?:/, 'webcal:') + sub.file)}" data-path="${esc(sub.file)}">Ouvrir dans mon application d’agenda</a></p>
              </div>`
        : '';
      return `
            <li class="person">
              ${download}
              ${subscribe}
            </li>`;
    }).join('');

    return `
    <dialog class="sheet" id="${esc(id)}" aria-labelledby="${esc(id)}-titre">
      <div class="sheet__inner">
        <div class="sheet__head">
          <h2 id="${esc(id)}-titre">Planning ${esc(ofMonth(m.label))}</h2>
          <button type="button" class="button-secondary" data-close>Fermer</button>
        </div>
        <p class="sheet__period">Du ${esc(formatDateFr(m.start))} au ${esc(formatDateFr(m.end))}</p>
        <p class="sheet__hint">Choisissez votre nom pour télécharger votre agenda du mois.</p>
        <ul class="people" role="list">${items}
        </ul>
        <details class="howto">
          <summary>Comment s’abonner selon son application ?</summary>
          <dl>
            <dt>Google Agenda</dt>
            <dd>Sur ordinateur, à côté de « Autres agendas », choisissez « + », puis « À partir de l’URL », et collez l’adresse copiée. L’agenda apparaît ensuite aussi sur le téléphone. Google peut mettre jusqu’à 24 heures, parfois plus, pour afficher un nouveau planning.</dd>
            <dt>iPhone, iPad et Mac</dt>
            <dd>Touchez « Ouvrir dans mon application d’agenda » et confirmez l’abonnement.</dd>
            <dt>Outlook</dt>
            <dd>Dans le calendrier, choisissez « Ajouter un calendrier », puis « S’abonner à partir du web », et collez l’adresse copiée.</dd>
          </dl>
        </details>
        <p class="visually-hidden" aria-live="polite" data-announce></p>
      </div>
    </dialog>`;
  }).join('');

  const fallbackRows = manifest.months.flatMap((m) => m.employees.map((p) => `
            <tr>
              <th scope="row">${esc(capitalize(m.label))}</th>
              <td>${esc(p.name)}</td>
              <td>${p.file ? `<a href="${esc(p.file)}" download>Télécharger (${esc(plural(p.slotCount, 'créneau', 'créneaux'))})</a>` : 'aucun créneau'}</td>
              <td>${subs.has(p.slug) ? `<a href="${esc(subs.get(p.slug)?.file)}">Adresse d’abonnement</a>` : ''}</td>
            </tr>`)).join('');

  const empty = manifest.months.length === 0
    ? '<p class="empty">Aucun planning n’a encore été publié. Déposez un fichier Excel dans le dossier « plannings » du dépôt pour le voir apparaître ici.</p>'
    : '';

  return `<!doctype html>
<html lang="fr" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="color-scheme" content="light dark">
  <title>Plannings de l’accueil</title>
  <link rel="icon" href="${FAVICON}">
  <script>document.documentElement.classList.replace('no-js', 'js');</script>
  <link rel="stylesheet" href="assets/styles.css">
  <script type="module" src="assets/app.js"></script>
</head>
<body>
  <main class="page">
    <header class="intro">
      <h1>Plannings de l’accueil</h1>
      <p>Choisissez un mois, puis votre nom : vos horaires s’ajoutent à votre application d’agenda.</p>
    </header>

    <section aria-labelledby="titre-mois">
      <h2 id="titre-mois" class="section-title">Mois disponibles</h2>
      ${empty}
      <ul class="months" role="list">${monthButtons}
      </ul>
      <noscript>
        <table class="fallback">
          <caption>Tous les agendas</caption>
          <thead><tr><th scope="col">Mois</th><th scope="col">Nom</th><th scope="col">Agenda du mois</th><th scope="col">Abonnement</th></tr></thead>
          <tbody>${fallbackRows}
          </tbody>
        </table>
      </noscript>
    </section>

    <footer class="footer">
      <p>${updated ? `Dernière mise à jour le ${esc(updated)}.` : ''}</p>
      <p><a href="ajouter.html">Ajouter un planning</a></p>
    </footer>
  </main>
${dialogs}
</body>
</html>
`;
}

/**
 * Page d'ajout d'un planning : le navigateur vérifie le fichier avec le même parser que l'Action,
 * puis l'envoie au service de dépôt (fonction Netlify) qui l'enregistre dans le dépôt GitHub.
 * La personne qui dépose n'a qu'un mot de passe à saisir.
 * @param {Manifest} manifest
 * @param {{ serviceDepot?: string, depot?: string }} settings
 * @param {Record<string, string>} aliases
 */
export function renderUpload(manifest, settings = {}, aliases = {}) {
  const service = (settings.serviceDepot ?? '').replace(/\/+$/, '');
  const serviceOrigin = service ? new URL(service).origin : '';
  const repo = settings.depot ?? '';
  const published = manifest.months.map((m) => m.month);
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${esc(serviceOrigin)}; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <title>Ajouter un planning – Plannings de l’accueil</title>
  <link rel="icon" href="${FAVICON}">
  <link rel="stylesheet" href="assets/styles.css">
  <script type="module" src="assets/upload.js"></script>
</head>
<body>
  <main class="page" data-upload data-service="${esc(service)}" data-repo="${esc(repo)}" data-published="${esc(JSON.stringify(published))}" data-aliases="${esc(JSON.stringify(aliases))}">
    <p class="back"><a href="./">Retour aux plannings</a></p>
    <header class="intro">
      <h1>Ajouter un planning</h1>
      <p>Choisissez le fichier Excel du mois : il est vérifié ici, puis mis en ligne. Les agendas de chacun sont prêts dans la minute qui suit.</p>
    </header>

    <noscript><p class="notice notice--error">Cette page a besoin de JavaScript pour fonctionner.</p></noscript>

    <section class="step" id="etape-cle" aria-labelledby="titre-cle" hidden>
      <h2 id="titre-cle">Mot de passe</h2>
      <p>Saisissez le mot de passe de dépôt des plannings. Si vous cochez « Mémoriser », il ne sera plus demandé sur cet appareil.</p>
      <form class="token-form" data-token-form novalidate>
        <input type="text" name="identifiant" value="plannings-accueil" autocomplete="username" hidden>
        <label for="cle">Mot de passe de dépôt</label>
        <div class="field-row">
          <input id="cle" name="cle" type="password" autocomplete="current-password" spellcheck="false" required aria-describedby="cle-erreur">
          <button type="submit" class="button-primary">Continuer</button>
        </div>
        <p class="checkbox">
          <input id="memoriser" name="memoriser" type="checkbox" checked>
          <label for="memoriser">Mémoriser sur cet appareil</label>
        </p>
        <p class="field-error" id="cle-erreur" data-token-error></p>
      </form>
    </section>

    <section class="step" id="etape-fichier" aria-labelledby="titre-fichier" hidden>
      <h2 id="titre-fichier">Fichier du planning</h2>
      <label class="dropzone" data-dropzone>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-file>
        <span class="dropzone__title">Choisir le fichier Excel</span>
        <span class="dropzone__hint">ou le glisser ici (.xlsx)</span>
      </label>
      <div class="preview" data-preview hidden></div>
      <p class="actions" data-publish-row hidden>
        <button type="button" class="button-primary" data-publish>Publier ce planning</button>
      </p>
      <div class="status" role="status" data-status></div>
      <p class="token-info" data-token-info hidden>Mot de passe mémorisé sur cet appareil. <button type="button" class="link-button" data-forget>Oublier le mot de passe</button></p>
    </section>
  </main>
</body>
</html>
`;
}
