// @ts-check
/**
 * Traitement des plannings déposés : seul ce module touche au disque et à git.
 *
 *   node src/process.js --pending [<sha>] fichiers déposés depuis le dernier traitement (data/etat.json),
 *                                         ou depuis <sha> si aucun traitement n'est encore noté (push)
 *   node src/process.js --file <nom>      un fichier précis (plusieurs --file possibles)
 *   node src/process.js --all             tous les plannings du dossier plannings/
 *   node src/process.js --site-only       aucun planning, page et abonnements régénérés
 *
 * Chaque planning traité (un par onglet) remplace entièrement les données de son mois (data/<AAAA-MM>.json).
 * Les données des autres mois ne sont jamais réécrites. Les agendas (mensuels et d'abonnement), le manifeste
 * et les pages sont reconstruits à partir de data/, sans relire les anciens fichiers Excel : un mois
 * inchangé redonne exactement les mêmes fichiers.
 */
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as XLSXModule from 'xlsx';
import { parseWorkbook } from './parse-planning.js';
import { nameKey } from './names.js';
import { buildCalendar, employeeEvents } from './ics.js';
import { renderIndex, renderUpload } from './site.js';
import { capitalize, formatDateFr, monthLabel } from './util.js';

/** @type {any} */
const XLSX = /** @type {any} */ (XLSXModule).read ? XLSXModule : /** @type {any} */ (XLSXModule).default;

const DEFAULT_SETTINGS = { titre: 'Accueil', lieu: '', siteUrl: '', depot: '', branche: 'main' };
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Modules du parser réutilisés tels quels par la page d'ajout, dans le navigateur. */
const BROWSER_MODULES = ['parse-planning.js', 'util.js', 'names.js'];

/** Dossier racine du paquet SheetJS installé (celui qui contient son package.json). */
function sheetjsDir() {
  let dir = path.dirname(fileURLToPath(import.meta.resolve('xlsx')));
  while (!existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/** Formats lus : Excel récent (.xlsx, .xlsm), ancien Excel (.xls), LibreOffice (.ods). */
export const isPlanningFile = (/** @type {string} */ file) => /\.(xlsx|xlsm|xls|ods)$/i.test(file) && !path.basename(file).startsWith('~$');

/** Erreur de lecture SheetJS → message compréhensible */
function readErrorMessage(/** @type {Error} */ error) {
  if (/password/i.test(error.message)) {
    return 'Le fichier est protégé par un mot de passe : enregistrez-en une copie sans protection (Fichier > Informations > Protéger le classeur), puis déposez cette copie.';
  }
  return `Le fichier n’a pas pu être lu comme un classeur (${error.message}). Ouvrez-le dans Excel, enregistrez-le au format .xlsx, puis déposez-le à nouveau.`;
}

/** @param {string} file @param {any} fallback */
function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} root @param {string[]} args */
const git = (root, args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');

/** @param {string} root @param {string | undefined} sha */
function commitExists(root, sha) {
  if (!sha || /^0+$/.test(sha)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Plannings ajoutés, modifiés ou renommés depuis un commit, dans l'ordre chronologique de leur dernier
 * changement : si deux fichiers du même mois arrivent dans la même fournée, le plus récent l'emporte.
 * files = null : point de départ inconnu, tout retraiter.
 * @param {string} root
 * @param {string | undefined} since
 * @returns {{ files: string[] | null, head: string }}
 */
export function pendingPlannings(root, since) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  if (!commitExists(root, since)) return { files: null, head };
  const out = git(root, ['-c', 'core.quotepath=false', 'log', '--reverse', '--format=@%H', '--name-only', '--diff-filter=AMR', `${since}..HEAD`, '--', 'plannings']);
  /** @type {Map<string, true>} */
  const order = new Map();
  for (const line of out.split('\n')) {
    const file = line.trim();
    if (!file || file.startsWith('@')) continue;
    order.delete(file);
    order.set(file, true);
  }
  const files = [...order.keys()].filter(isPlanningFile).filter((f) => existsSync(path.join(root, f)));
  return { files, head };
}

/**
 * Traite tous les plannings en attente depuis le dernier traitement réussi (data/etat.json),
 * puis note le commit traité. Un dépôt dont l'exécution a été annulée ou a échoué avant
 * l'enregistrement est donc rattrapé par l'exécution suivante.
 * @param {{ root: string, fallbackSince?: string, now?: Date }} options
 */
export function runPending(options) {
  const root = path.resolve(options.root);
  const stateFile = path.join(root, 'data', 'etat.json');
  const state = readJson(stateFile, {});
  const since = commitExists(root, state.dernierCommitTraite) ? state.dernierCommitTraite : options.fallbackSince;
  const { files, head } = pendingPlannings(root, since);
  const report = files === null
    ? runProcess({ root, all: true, now: options.now })
    : runProcess({ root, files, now: options.now });
  writeJson(stateFile, { dernierCommitTraite: head });
  return report;
}

/** @param {string} root */
export function allPlannings(root) {
  const dir = path.join(root, 'plannings');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(isPlanningFile).sort().map((f) => path.join('plannings', f));
  // Ordre de dépôt (date du dernier commit) : en cas de doublon de mois, le fichier le plus récent l'emporte
  /** @param {string} f */
  const committedAt = (f) => {
    try {
      return Number(git(root, ['log', '-1', '--format=%ct', '--', f]).trim()) || Infinity;
    } catch {
      return Infinity;
    }
  };
  const times = new Map(files.map((f) => [f, committedAt(f)]));
  return files.sort((a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0));
}

/**
 * @typedef {import('./parse-planning.js').Issue} Issue
 * @typedef {{ file: string, month: string, start: string, end: string, employees: { name: string, slotCount: number }[], warnings: Issue[], errors: Issue[] }} FileReport
 * @typedef {{ files: FileReport[], overlaps: { months: string[], days: string[] }[], processedMonths: string[], failed: boolean }} Report
 */

/**
 * @param {{ root: string, files?: string[], all?: boolean, now?: Date }} options
 * @returns {Report}
 */
export function runProcess(options) {
  const root = path.resolve(options.root);
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  const icsDir = path.join(publicDir, 'ics');
  const settings = { ...DEFAULT_SETTINGS, ...readJson(path.join(root, 'config', 'settings.json'), {}) };
  const aliases = readJson(path.join(root, 'config', 'aliases.json'), {});
  const now = (options.now ?? new Date()).toISOString();

  const files = options.all ? allPlannings(root) : (options.files ?? []);
  /** @type {Report} */
  const report = { files: [], overlaps: [], processedMonths: [], failed: false };

  /** @returns {any[]} données de tous les mois publiés ; un fichier illisible est signalé et ignoré */
  const loadData = () => (existsSync(dataDir) ? readdirSync(dataDir) : [])
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .flatMap((f) => {
      try {
        const d = readJson(path.join(dataDir, f), null);
        if (!d?.month || !Array.isArray(d.days) || !Array.isArray(d.employees)) throw new Error('contenu inattendu');
        return [d];
      } catch (error) {
        report.files.push({
          file: `data/${f}`, month: f.slice(0, 7), start: '', end: '', employees: [], warnings: [],
          errors: [{ message: `Données du mois illisibles (${/** @type {Error} */ (error).message}) : retraitez le planning de ce mois.` }],
        });
        return [];
      }
    });

  // Personnes déjà publiées : une faute de frappe sur tout un mois est rattachée à la bonne personne
  /** @type {Map<string, string>} */
  const known = new Map();
  for (const d of loadData()) for (const e of d.employees) known.set(e.key ?? nameKey(e.name), e.name);
  report.files = [];

  /* 1. Plannings déposés : chaque planning (un par onglet) remplace entièrement son mois */
  for (const file of files) {
    let abs = path.resolve(root, file);
    if (!existsSync(abs) && existsSync(path.join(root, 'plannings', file))) abs = path.join(root, 'plannings', file);
    const rel = path.relative(root, abs);
    /** @param {Partial<FileReport>} extra */
    const entryFor = (extra = {}) => {
      /** @type {FileReport} */
      const entry = { file: rel, month: '', start: '', end: '', employees: [], warnings: [], errors: [], ...extra };
      report.files.push(entry);
      return entry;
    };

    if (!existsSync(abs)) {
      entryFor({ errors: [{ message: 'Fichier introuvable dans le dépôt.' }] });
      continue;
    }
    let workbook;
    try {
      workbook = XLSX.read(readFileSync(abs), { type: 'buffer', cellNF: true, cellStyles: true });
    } catch (error) {
      entryFor({ errors: [{ message: readErrorMessage(/** @type {Error} */ (error)) }] });
      continue;
    }
    const { plannings, errors } = parseWorkbook(workbook, {
      source: path.basename(rel),
      aliases,
      knownNames: [...known.entries()].map(([key, name]) => ({ key, name })),
      now: options.now,
    });
    if (errors.length) entryFor({ errors });

    for (const parsed of plannings) {
      const entry = entryFor({
        month: parsed.month,
        start: parsed.start,
        end: parsed.end,
        employees: parsed.employees.map((e) => ({ name: e.name, slotCount: e.slotCount })),
        warnings: [...parsed.warnings],
        errors: [...parsed.errors],
      });
      if (plannings.length > 1) entry.file = `${rel} (onglet « ${parsed.sheet} »)`;
      if (!parsed.ok) continue;

      const label = monthLabel(parsed.month);
      const dataFile = path.join(dataDir, `${parsed.month}.json`);
      let previous = null;
      try { previous = readJson(dataFile, null); } catch { /* données illisibles : remplacées */ }
      if (previous && previous.source !== parsed.source) {
        entry.warnings.push({ message: `Ce fichier remplace le planning ${label} publié précédemment depuis « ${previous.source} ».` });
      }
      writeJson(dataFile, {
        version: 1,
        month: parsed.month,
        label,
        title: parsed.title,
        source: parsed.source,
        sheet: parsed.sheet,
        processedAt: now,
        start: parsed.start,
        end: parsed.end,
        days: parsed.days,
        employees: parsed.employees.map(({ name, key, slug, slotCount, days }) => ({ name, key, slug, slotCount, days })),
        warnings: parsed.warnings,
      });
      for (const e of parsed.employees) known.set(e.key, e.name);
      report.processedMonths.push(parsed.month);
    }
  }

  /* 2. Données de tous les mois, dans l'ordre de traitement */
  const all = loadData().sort((a, b) => a.processedAt.localeCompare(b.processedAt) || a.month.localeCompare(b.month));

  /* 3. Agendas mensuels, régénérés depuis data/ : identiques octet pour octet pour les mois inchangés,
        et reconstitués s'ils ont été effacés par erreur */
  mkdirSync(icsDir, { recursive: true });
  const months = new Set(all.map((d) => d.month));
  for (const entry of readdirSync(icsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name) && !months.has(entry.name)) rmSync(path.join(icsDir, entry.name), { recursive: true, force: true });
  }
  for (const d of all) {
    const monthDir = path.join(icsDir, d.month);
    rmSync(monthDir, { recursive: true, force: true });
    mkdirSync(monthDir, { recursive: true });
    for (const employee of d.employees) {
      if (!employee.slotCount) continue;
      const events = employeeEvents(employee, { title: settings.titre, location: settings.lieu, source: d.source, stamp: d.processedAt });
      writeFileSync(
        path.join(monthDir, `${employee.slug}.ics`),
        buildCalendar({ name: `${settings.titre} – ${employee.name} – ${capitalize(d.label ?? monthLabel(d.month))}`, events }),
      );
    }
  }

  // Chevauchements (anormaux : les plannings sont découpés en semaines complètes)
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const shared = all[i].days.filter((/** @type {string} */ d) => all[j].days.includes(d));
      if (shared.length) report.overlaps.push({ months: [all[i].month, all[j].month].sort(), days: shared });
    }
  }

  /* 3. Fichiers d'abonnement : tous les mois, le dernier planning traité décide d'un jour commun */
  /** @type {Map<string, number>} */
  const dayOwner = new Map();
  all.forEach((d, index) => { for (const day of d.days) dayOwner.set(day, index); });

  /** @type {Map<string, { name: string, events: import('./ics.js').CalendarEvent[] }>} */
  const people = new Map();
  all.forEach((d, index) => {
    for (const employee of d.employees) {
      const owned = Object.fromEntries(Object.entries(employee.days).filter(([day]) => dayOwner.get(day) === index));
      const person = people.get(employee.slug) ?? { name: employee.name, events: [] };
      person.name = employee.name;
      person.events.push(...employeeEvents(
        { slug: employee.slug, days: owned },
        { title: settings.titre, location: settings.lieu, source: d.source, stamp: d.processedAt },
      ));
      people.set(employee.slug, person);
    }
  });

  mkdirSync(icsDir, { recursive: true });
  for (const f of readdirSync(icsDir)) if (f.endsWith('.ics')) rmSync(path.join(icsDir, f));
  /** @type {import('./site.js').ManifestSubscription[]} */
  const subscriptions = [];
  for (const [slug, person] of [...people.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'fr'))) {
    if (!person.events.length) continue;
    writeFileSync(path.join(icsDir, `${slug}.ics`), buildCalendar({ name: `${settings.titre} – ${person.name}`, events: person.events, subscription: true }));
    subscriptions.push({ name: person.name, slug, file: `ics/${slug}.ics`, slotCount: person.events.length });
  }

  /* 4. Manifeste et page */
  /** @type {import('./site.js').Manifest} */
  const manifest = {
    updatedAt: all.reduce((max, d) => (d.processedAt > max ? d.processedAt : max), ''),
    months: [...all].sort((a, b) => b.month.localeCompare(a.month)).map((d) => ({
      month: d.month,
      label: d.label,
      title: d.title,
      source: d.source,
      processedAt: d.processedAt,
      start: d.start,
      end: d.end,
      dayCount: d.days.length,
      slotCount: d.employees.reduce((/** @type {number} */ n, /** @type {any} */ e) => n + e.slotCount, 0),
      employees: d.employees.map((/** @type {any} */ e) => ({
        name: e.name, slug: e.slug, slotCount: e.slotCount, file: e.slotCount ? `ics/${d.month}/${e.slug}.ics` : null,
      })),
    })),
    subscriptions,
  };
  writeJson(path.join(publicDir, 'manifest.json'), manifest);
  writeFileSync(path.join(publicDir, 'index.html'), renderIndex(manifest, settings));
  writeFileSync(path.join(publicDir, 'ajouter.html'), renderUpload(manifest, settings, aliases));
  const assetsDir = path.join(publicDir, 'assets');
  for (const dir of ['lib', 'vendor']) mkdirSync(path.join(assetsDir, dir), { recursive: true });
  for (const asset of ['styles.css', 'app.js', 'upload.js']) copyFileSync(path.join(root, 'site', asset), path.join(assetsDir, asset));
  for (const mod of BROWSER_MODULES) copyFileSync(path.join(SRC_DIR, mod), path.join(assetsDir, 'lib', mod));
  copyFileSync(path.join(sheetjsDir(), 'xlsx.mjs'), path.join(assetsDir, 'vendor', 'xlsx.js'));
  const license = path.join(sheetjsDir(), 'LICENSE');
  if (existsSync(license)) copyFileSync(license, path.join(assetsDir, 'vendor', 'LICENSE-sheetjs.txt'));
  writeFileSync(path.join(publicDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

  report.failed = report.files.some((f) => f.errors.length > 0);
  return report;
}

/**
 * Résumé lisible (Markdown) pour le résumé d'exécution de l'Action.
 * @param {Report} report
 */
export function formatReport(report) {
  const out = [];
  if (!report.files.length) {
    out.push('## Aucun planning à traiter', '', 'La page et les abonnements ont été régénérés à partir des plannings déjà publiés.');
  }
  for (const f of report.files) {
    const ok = f.errors.length === 0;
    out.push(`## ${ok ? '✅' : '❌'} ${path.basename(f.file)}${f.month ? ` : ${monthLabel(f.month)}` : ''}`, '');
    if (f.start) out.push(`Période : du ${formatDateFr(f.start)} au ${formatDateFr(f.end)}.`, '');
    if (ok && f.employees.length) {
      out.push('| Nom | Créneaux |', '| --- | ---: |', ...f.employees.map((e) => `| ${e.name} | ${e.slotCount} |`), '');
    }
    if (f.errors.length) {
      out.push('**Erreurs : ce planning n’a pas été publié.**', '', ...f.errors.map((e) => `- ${e.cell ? `\`${e.cell}\` ` : ''}${e.message}`), '');
    }
    if (f.warnings.length) {
      out.push('**Avertissements**', '', ...f.warnings.map((e) => `- ${e.cell ? `\`${e.cell}\` ` : ''}${e.message}`), '');
    }
  }
  if (report.overlaps.length) {
    out.push('## ⚠️ Jours présents dans deux plannings', '');
    for (const o of report.overlaps) {
      out.push(`- ${o.months.map(monthLabel).join(' et ')} : ${o.days.map((d) => formatDateFr(d, { weekday: false })).join(', ')}. Pour l’abonnement, le planning déposé en dernier fait foi.`);
    }
    out.push('');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Ligne de commande                                                   */
/* ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /** @type {string[]} */
  const files = [];
  let all = false;
  let siteOnly = false;
  /** @type {string | null} */
  let pending = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') all = true;
    else if (arg === '--site-only') siteOnly = true;
    else if (arg === '--file') { if (args[i + 1]) files.push(args[++i]); }
    else if (arg === '--pending') pending = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    else {
      console.error(`Option inconnue : ${arg}`);
      process.exit(2);
    }
  }
  let report;
  if (pending !== null) report = runPending({ root, fallbackSince: pending });
  else if (siteOnly) report = runProcess({ root, files: [] });
  else {
    report = runProcess({ root, files, all });
    if (all) writeJson(path.join(root, 'data', 'etat.json'), { dernierCommitTraite: git(root, ['rev-parse', 'HEAD']).trim() });
  }
  const summary = formatReport(report);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `months=${report.processedMonths.join(', ')}\n`);
  }
  for (const f of report.files) {
    for (const e of f.errors) console.log(`::error title=${path.basename(f.file)}::${e.cell ? `${e.cell} : ` : ''}${e.message}`);
    for (const w of f.warnings) console.log(`::warning title=${path.basename(f.file)}::${w.cell ? `${w.cell} : ` : ''}${w.message}`);
  }
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
