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
 * Chaque planning traité remplace entièrement son mois (data/<AAAA-MM>.json et public/ics/<AAAA-MM>/).
 * Les autres mois ne sont jamais réécrits. Les fichiers d'abonnement, le manifeste et la page sont
 * reconstruits à partir de data/, sans relire les anciens fichiers Excel.
 */
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as XLSXModule from 'xlsx';
import { parsePlanning } from './parse-planning.js';
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

/** @param {string} file */
export const isPlanningFile = (file) => /\.xlsx$/i.test(file) && !path.basename(file).startsWith('~$');

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
const git = (root, args) => execFileSync('git', args, { cwd: root }).toString('utf8');

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
  return readdirSync(dir).filter(isPlanningFile).sort().map((f) => path.join('plannings', f));
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

  /* 1. Plannings déposés : un mois remplacé par fichier */
  for (const file of files) {
    let abs = path.resolve(root, file);
    if (!existsSync(abs) && existsSync(path.join(root, 'plannings', file))) abs = path.join(root, 'plannings', file);
    const rel = path.relative(root, abs);
    /** @type {FileReport} */
    const entry = { file: rel, month: '', start: '', end: '', employees: [], warnings: [], errors: [] };
    report.files.push(entry);

    if (!existsSync(abs)) {
      entry.errors.push({ message: 'Fichier introuvable dans le dépôt.' });
      continue;
    }
    let workbook;
    try {
      workbook = XLSX.read(readFileSync(abs), { type: 'buffer' });
    } catch (error) {
      entry.errors.push({ message: `Le fichier n’a pas pu être lu comme un classeur Excel (${/** @type {Error} */ (error).message}).` });
      continue;
    }
    const parsed = parsePlanning(workbook, { source: path.basename(rel), aliases });
    Object.assign(entry, {
      month: parsed.month,
      start: parsed.start,
      end: parsed.end,
      employees: parsed.employees.map((e) => ({ name: e.name, slotCount: e.slotCount })),
    });
    entry.warnings.push(...parsed.warnings);
    entry.errors.push(...parsed.errors);
    if (!parsed.ok) continue;

    const label = monthLabel(parsed.month);
    const dataFile = path.join(dataDir, `${parsed.month}.json`);
    const previous = readJson(dataFile, null);
    if (previous && previous.source !== parsed.source) {
      entry.warnings.push({ message: `Ce fichier remplace le planning ${label} publié précédemment depuis « ${previous.source} ».` });
    }
    writeJson(dataFile, {
      version: 1,
      month: parsed.month,
      label,
      title: parsed.title,
      source: parsed.source,
      processedAt: now,
      start: parsed.start,
      end: parsed.end,
      days: parsed.days,
      employees: parsed.employees.map(({ name, slug, slotCount, days }) => ({ name, slug, slotCount, days })),
      warnings: parsed.warnings,
    });

    const monthDir = path.join(icsDir, parsed.month);
    rmSync(monthDir, { recursive: true, force: true });
    mkdirSync(monthDir, { recursive: true });
    for (const employee of parsed.employees) {
      if (!employee.slotCount) continue;
      const events = employeeEvents(employee, { title: settings.titre, location: settings.lieu, source: parsed.source, stamp: now });
      writeFileSync(
        path.join(monthDir, `${employee.slug}.ics`),
        buildCalendar({ name: `${settings.titre} – ${employee.name} – ${capitalize(label)}`, events }),
      );
    }
    report.processedMonths.push(parsed.month);
  }

  /* 2. Données de tous les mois, dans l'ordre de traitement */
  const all = (existsSync(dataDir) ? readdirSync(dataDir) : [])
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => readJson(path.join(dataDir, f), null))
    .filter(Boolean)
    .sort((a, b) => a.processedAt.localeCompare(b.processedAt) || a.month.localeCompare(b.month));

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
