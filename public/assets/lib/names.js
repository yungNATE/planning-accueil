// @ts-check
/** Normalisation et rapprochement des noms d'employés (module pur). */

/**
 * Clé de comparaison : majuscules, sans accents, tirets et apostrophes remplacés par des espaces.
 * « Jean-Pierre », « JEAN PIERRE » et « jean  pierre » donnent la même clé.
 * @param {unknown} raw
 */
export function nameKey(raw) {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[-'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nom lisible à partir de la saisie : « JEAN-PIERRE » → « Jean-Pierre ». Les accents saisis sont conservés.
 * @param {string} raw
 */
export function displayName(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr')
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep, letter) => sep + letter.toLocaleUpperCase('fr'));
}

/**
 * Identifiant pour les noms de fichiers : « Jean-Pierre » → « jean-pierre ».
 * @param {string} raw
 */
export function slugify(raw) {
  return nameKey(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Une cellule de la colonne des noms ressemble-t-elle à un nom ? (lettres, espaces, tirets, apostrophes)
 * @param {string} raw
 */
export function looksLikeName(raw) {
  const s = raw.trim();
  return s.length >= 2 && s.length <= 40 && /^[\p{L}][\p{L}\s\-'’.]*$/u.test(s);
}

/**
 * Distance de Levenshtein.
 * @param {string} a
 * @param {string} b
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Prépare la table d'alias (clés et valeurs normalisées).
 * @param {Record<string, string>} aliases
 */
export function normalizeAliases(aliases) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const [from, to] of Object.entries(aliases ?? {})) {
    if (from.startsWith('_')) continue; // clés de commentaire
    map.set(nameKey(from), nameKey(to));
  }
  return map;
}
