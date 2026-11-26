// Service de dépôt des plannings (fonction Netlify).
//
// La page « Ajouter un planning » (GitHub Pages) envoie ici le fichier Excel avec le mot de passe de dépôt.
// La fonction garde la clé GitHub côté serveur et enregistre le fichier dans plannings/ :
// la personne qui dépose n'a aucune clé à configurer.
//
// Variables d'environnement Netlify (portée « Functions ») :
//   GITHUB_TOKEN       clé GitHub (fine-grained) : Contents en lecture/écriture, Actions en lecture, sur le seul dépôt
//   MOT_DE_PASSE       mot de passe demandé sur la page d'ajout
//   DEPOT              facultatif, « propriétaire/dépôt » (défaut : yungNATE/planning-accueil)
//   BRANCHE            facultatif (défaut : main)
//   ORIGINE_AUTORISEE  facultatif, site autorisé à appeler le service (défaut : https://yungnate.github.io)
//
// Routes (POST, JSON) :
//   /api/verifier  { motDePasse }                          → { ok: true }
//   /api/deposer   { motDePasse, nom, contenu, mois? }     → { sha }      contenu : fichier encodé en base64
//   /api/suivi     { motDePasse, sha }                     → { etat: attente | en-cours | publie | echec, lien? }

import type { Config } from "@netlify/functions";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BYTES = 4 * 1024 * 1024; // limite des fonctions Netlify : 6 Mo encodés en base64
const FAILED_PASSWORD_DELAY_MS = 1000;
const GITHUB_API = "https://api.github.com";

type Settings = { token: string; password: string; repo: string; branch: string; origin: string };
type Body = Record<string, unknown>;

function env(key: string, fallback = ""): string {
  const netlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify;
  return netlify?.env.get(key) ?? process.env[key] ?? fallback;
}

function settings(): Settings {
  return {
    token: env("GITHUB_TOKEN"),
    password: env("MOT_DE_PASSE"),
    repo: env("DEPOT", "yungNATE/planning-accueil"),
    branch: env("BRANCHE", "main"),
    origin: env("ORIGINE_AUTORISEE", "https://yungnate.github.io"),
  };
}

// La page d'ajout est hébergée sur un autre domaine (GitHub Pages) : seul ce site est autorisé à appeler le service.
function headers(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

function reply(status: number, body: unknown, origin: string): Response {
  return Response.json(body, { status, headers: headers(origin) });
}

const fail = (status: number, erreur: string, message: string, origin: string) => reply(status, { erreur, message }, origin);

function samePassword(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = createHash("sha256").update(given.normalize("NFC")).digest();
  const b = createHash("sha256").update(expected.normalize("NFC")).digest();
  return timingSafeEqual(a, b);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function github(s: Settings, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${s.token}`,
      "User-Agent": "planning-accueil-depot",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

/** Erreur GitHub → réponse compréhensible pour la page d'ajout */
function githubFailure(status: number, origin: string): Response {
  if (status === 401) {
    return fail(502, "cle-github", "La clé GitHub du service de dépôt a expiré ou a été supprimée.", origin);
  }
  if (status === 403 || status === 404) {
    return fail(502, "droits-github", "La clé GitHub du service de dépôt n’a pas le droit d’écrire dans le dépôt.", origin);
  }
  if (status === 409 || status === 422) {
    return fail(409, "conflit", "Le dépôt a changé pendant l’envoi. Cliquez à nouveau sur « Publier ce planning ».", origin);
  }
  return fail(502, "github", `GitHub a renvoyé une erreur (${status}). Réessayez dans quelques instants.`, origin);
}

async function deposer(body: Body, s: Settings): Promise<Response> {
  const name = typeof body.nom === "string" ? body.nom.normalize("NFC").trim() : "";
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _().,'’-]{0,99}\.xlsx$/iu.test(name)) {
    return fail(400, "nom", "Nom de fichier refusé : choisissez un fichier .xlsx dont le nom ne contient que des lettres, chiffres, espaces et tirets.", s.origin);
  }
  const bytes = typeof body.contenu === "string" ? Buffer.from(body.contenu, "base64") : Buffer.alloc(0);
  if (bytes.length === 0) return fail(400, "contenu", "Le fichier est vide.", s.origin);
  if (bytes.length > MAX_BYTES) return fail(413, "taille", "Le fichier dépasse 4 Mo : ce n’est sans doute pas un planning.", s.origin);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return fail(400, "format", "Ce fichier n’est pas un classeur Excel (.xlsx).", s.origin);
  }
  const label = typeof body.mois === "string" && /^[\p{L}\p{N} ]{3,40}$/u.test(body.mois) ? body.mois : name;
  const path = `/repos/${s.repo}/contents/plannings/${encodeURIComponent(name)}`;

  const existing = await github(s, `${path}?ref=${encodeURIComponent(s.branch)}`);
  if (!existing.ok && existing.status !== 404) return githubFailure(existing.status, s.origin);
  const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;

  const saved = await github(s, path, {
    method: "PUT",
    body: JSON.stringify({
      message: `Planning ${label} déposé depuis le site`,
      content: bytes.toString("base64"),
      branch: s.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!saved.ok) return githubFailure(saved.status, s.origin);
  const commit = ((await saved.json()) as { commit?: { sha?: string } }).commit;
  return reply(200, { sha: commit?.sha ?? "" }, s.origin);
}

async function suivi(body: Body, s: Settings): Promise<Response> {
  const sha = typeof body.sha === "string" ? body.sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return fail(400, "sha", "Identifiant de dépôt invalide.", s.origin);
  const response = await github(s, `/repos/${s.repo}/actions/runs?head_sha=${sha}&per_page=1`);
  if (!response.ok) return githubFailure(response.status, s.origin);
  const run = ((await response.json()) as { workflow_runs?: { status: string; conclusion: string | null; html_url: string }[] }).workflow_runs?.[0];
  if (!run) return reply(200, { etat: "attente" }, s.origin);
  if (run.status !== "completed") return reply(200, { etat: "en-cours", lien: run.html_url }, s.origin);
  return reply(200, { etat: run.conclusion === "success" ? "publie" : "echec", lien: run.html_url }, s.origin);
}

export default async (req: Request): Promise<Response> => {
  const s = settings();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(s.origin) });
  if (req.method !== "POST") return fail(405, "methode", "Méthode non autorisée.", s.origin);
  if (!s.password || !s.token) {
    return fail(503, "configuration", "Le service de dépôt n’est pas encore configuré (mot de passe ou clé GitHub manquant).", s.origin);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return fail(400, "requete", "Requête illisible.", s.origin);
  }
  if (!body || typeof body !== "object") return fail(400, "requete", "Requête illisible.", s.origin);
  if (!samePassword(body.motDePasse, s.password)) {
    await sleep(FAILED_PASSWORD_DELAY_MS);
    return fail(401, "mot-de-passe", "Mot de passe incorrect.", s.origin);
  }

  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  try {
    if (route === "verifier") return reply(200, { ok: true }, s.origin);
    if (route === "deposer") return await deposer(body, s);
    if (route === "suivi") return await suivi(body, s);
  } catch {
    return fail(502, "reseau", "GitHub ne répond pas. Réessayez dans quelques instants.", s.origin);
  }
  return fail(404, "route", "Adresse inconnue.", s.origin);
};

export const config: Config = {
  path: ["/api/verifier", "/api/deposer", "/api/suivi"],
  method: ["POST", "OPTIONS"],
};
