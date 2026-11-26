# Plannings de l’accueil

Ce dépôt transforme chaque planning mensuel Excel de l’accueil en agendas `.ics`, un par personne, et les publie sur une page web :

**https://yungnate.github.io/planning-accueil/**

Sur la page, chacun choisit le mois, puis son nom, et récupère ses horaires dans son application d’agenda (Google Agenda, Apple Calendrier, Outlook…).

> **À savoir :** le dépôt et la page sont publics. Toute personne qui a l’adresse peut lire les plannings (prénoms et horaires). La page n’est pas référencée par les moteurs de recherche.

## Ajouter le planning du mois

### Depuis le site (le plus simple)

1. En bas de la page des plannings, cliquez sur **Ajouter un planning** (ou ouvrez https://yungnate.github.io/planning-accueil/ajouter.html).
2. La première fois, saisissez le **mot de passe de dépôt** et laissez « Mémoriser sur cet appareil » coché : il ne sera plus demandé.
3. Choisissez le fichier Excel. La page le vérifie aussitôt avec le même lecteur que la publication : mois, période, prénoms, nombre de créneaux, et les éventuels problèmes avec la case concernée.
4. Cliquez sur **Publier ce planning**. La page suit la mise en ligne et confirme quand le mois est publié, en général en moins d’une minute.

Un fichier qui contient une erreur ne peut pas être publié : la page indique quoi corriger dans Excel.

Aucun compte GitHub ni aucune clé n’est nécessaire pour déposer : c’est le **service de dépôt** (voir plus bas) qui détient l’accès au dépôt.

### Depuis GitHub

1. Ouvrez le dossier [`plannings`](plannings) du dépôt.
2. Cliquez sur **Add file**, puis **Upload files**, et déposez le fichier Excel (`.xlsx`).
3. Cliquez sur **Commit changes**.

C’est tout : quelques minutes plus tard, le mois apparaît sur la page. Le suivi se fait dans l’onglet **Actions** (rond orange : en cours, coche verte : publié, croix rouge : problème).

Seul le fichier déposé est converti. Les mois déjà publiés ne sont pas modifiés.

## Classement des mois et dépôts successifs

- Chaque fichier est rangé d’après le **mois de son titre**, jamais d’après son nom ni sa date de dépôt. La page affiche les mois du plus récent au plus ancien, le plus récent étant mis en avant : déposer décembre puis octobre donne bien « Décembre 2026 » en haut.
- **Plusieurs fichiers d’un coup** (plusieurs fichiers dans un même « Upload files » sur GitHub) : une seule publication les traite tous.
- **Plusieurs dépôts d’affilée** (par exemple quatre fichiers envoyés l’un après l’autre depuis la page d’ajout) : chaque dépôt est mis en file d’attente et publié à son tour, environ 30 secondes chacun. Rien n’est perdu ni annulé.
- Si deux fichiers du **même mois** arrivent, celui déposé **en dernier** fait foi.
- `data/etat.json` retient le dernier dépôt traité : si une publication échoue ou est interrompue, la suivante rattrape tous les fichiers en attente.

## Corriger un planning

Déposez la version corrigée dans `plannings/`, sous le même nom ou un autre. Le mois indiqué dans son titre est **entièrement remplacé** par cette nouvelle version (y compris si une personne a été retirée).

## Ce que l’outil lit dans le fichier

Le fichier doit garder la mise en forme habituelle :

- un **titre** qui contient le mois et l’année, par exemple `PLG ACCUEIL OCTOBRE 2026` : c’est lui qui fixe le mois, pas le nom du fichier ;
- des **lignes de jours** (`LUNDI 28`, `MARDI 29`, `JEUDI 1ER`…), une par semaine. Le planning peut commencer en fin de mois précédent et finir en début de mois suivant : ces jours restent dans le planning du mois ;
- sous chaque ligne de jours, **une ligne par personne**, avec le prénom dans la colonne juste à gauche du premier jour ;
- dans les cases, des **horaires** comme `8H-15H30`, `15H30-23H`, `8h - 15h` ou `08:00-12:00`. Deux créneaux dans une même case se séparent par `/` ou `+` (`8H-12H / 14H-18H`). Un horaire qui finit après minuit (`22H-6H`) se termine le lendemain.

**Toute case sans horaire est un jour OFF** : case vide, `RH`, `MA`, `CP`, etc. Aucun événement n’est créé.

Si une case contient des chiffres mais pas un horaire reconnu (par exemple `15H30_23H`), la journée est comptée OFF **et un avertissement est affiché** dans le résumé de l’Action, avec la case concernée, pour corriger le fichier.

Une faute de frappe d’une lettre sur un prénom (par exemple `SYVAIN` au lieu de `SYLVAIN`) est corrigée automatiquement, avec un avertissement. Si ce sont en réalité deux personnes différentes, ajoutez la ligne correspondante dans `config/aliases.json` (voir plus bas).

## S’abonner plutôt que télécharger chaque mois

Sur la page, le bouton **S’abonner** à côté d’un nom donne une adresse d’agenda qui contient tous les mois publiés pour cette personne. Une fois abonnée, l’application d’agenda ajoute d’elle-même les nouveaux plannings et les corrections.

- **Google Agenda** : sur ordinateur, à côté de « Autres agendas », choisissez « + », puis « À partir de l’URL », et collez l’adresse. Google peut mettre jusqu’à 24 heures, parfois plus, pour afficher les changements.
- **iPhone, iPad, Mac** : touchez « Ouvrir dans mon application d’agenda » et confirmez.
- **Outlook** : « Ajouter un calendrier », puis « S’abonner à partir du web », et collez l’adresse.

Évitez de cumuler un abonnement et des téléchargements mensuels : les horaires apparaîtraient en double.

## Si l’Action est en échec (croix rouge)

1. Onglet **Actions**, cliquez sur l’exécution en échec.
2. Le **résumé** en bas de page indique le fichier, la case et le problème (titre introuvable, jour incohérent, horaires sans prénom…).
3. Corrigez le fichier Excel et redéposez-le.

Un fichier en erreur n’est pas publié, mais il ne bloque pas les autres : les mois déjà en ligne restent disponibles.

## Retraiter tous les plannings

Utile après une modification de l’outil ou de la configuration : onglet **Actions**, workflow **Publier les plannings**, bouton **Run workflow**. Laissez le champ vide pour tout retraiter, ou indiquez le nom d’un fichier de `plannings/`.

## Service de dépôt (Netlify)

La page d’ajout envoie le fichier à une petite fonction hébergée gratuitement sur Netlify (projet `planning-accueil-depot`, code dans [`depot/`](depot)). Elle vérifie le mot de passe, puis enregistre le fichier dans `plannings/` avec une clé GitHub qu’elle est seule à connaître. Netlify redéploie la fonction automatiquement quand le dossier `depot/` change.

Réglages dans Netlify, projet `planning-accueil-depot` → **Project configuration** → **Environment variables** (portée « Functions ») :

| Variable | Contenu |
| --- | --- |
| `GITHUB_TOKEN` | clé GitHub *fine-grained* : dépôt `planning-accueil` uniquement, **Contents** en « Read and write », **Actions** en « Read-only », sans expiration |
| `MOT_DE_PASSE` | mot de passe demandé sur la page d’ajout |

Après toute modification d’une variable : **Deploys** → **Trigger deploy** → **Deploy project**, sinon l’ancienne valeur reste active.

- **Changer le mot de passe** : modifiez `MOT_DE_PASSE`, redéployez, communiquez le nouveau. Sur les appareils où l’ancien était mémorisé, la page redemande simplement le mot de passe.
- **Si la page affiche « La clé GitHub du service de dépôt a expiré ou a été supprimée »** : créez une nouvelle clé GitHub avec les mêmes réglages (https://github.com/settings/personal-access-tokens/new), remplacez `GITHUB_TOKEN`, redéployez.
- **En secours**, le dépôt direct sur GitHub (ci-dessous) fonctionne toujours, pour qui a accès au dépôt.

## Configuration

- `config/settings.json`
  - `titre` : début du nom des événements et des agendas (`Accueil 15h30–23h`) ;
  - `lieu` : lieu ajouté à chaque événement (vide par défaut) ;
  - `siteUrl` : adresse publique du site ;
  - `depot` : dépôt GitHub (`propriétaire/nom`) ;
  - `serviceDepot` : adresse du service de dépôt utilisé par la page d’ajout.
- `config/aliases.json` : correspondances de prénoms, par exemple `{ "SYLV": "SYLVAIN" }`. Une entrée vers lui-même (`{ "LEO": "LEO" }`) empêche tout rapprochement automatique avec un prénom proche.

Après une modification de la configuration, retraitez tous les plannings (voir ci-dessus).

## Fonctionnement technique

- `src/parse-planning.js` lit la grille Excel (SheetJS) sans coordonnées fixes : titre, lignes de jours, cellules fusionnées, prénoms, horaires.
- `src/ics.js` écrit les fichiers iCalendar (RFC 5545) avec le fuseau `Europe/Paris` : les horaires restent justes aux changements d’heure.
- `src/process.js` traite les fichiers déposés, écrit `data/<AAAA-MM>.json` et `public/ics/<AAAA-MM>/<prénom>.ics`, puis reconstruit les abonnements `public/ics/<prénom>.ics`, le manifeste et les pages.
- `site/upload.js` (page d’ajout) réutilise dans le navigateur `parse-planning.js`, `util.js`, `names.js` et SheetJS, copiés dans `public/assets/` à chaque publication, puis envoie le fichier au service de dépôt et suit l’exécution de l’Action.
- `depot/netlify/functions/depot.mts` (service de dépôt) : routes `/api/verifier`, `/api/deposer` et `/api/suivi`, appels à l’API GitHub avec `GITHUB_TOKEN`, accès limité au site des plannings (CORS).
- `.github/workflows/publier.yml` lance les tests, la conversion, enregistre les fichiers générés dans le dépôt, puis publie `public/` sur GitHub Pages.

En local (Node 22 ou plus) :

```sh
npm ci
npm test
node src/process.js --all   # retraite tous les plannings
```
