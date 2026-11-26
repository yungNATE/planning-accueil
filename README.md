# Plannings de l’accueil

Ce dépôt transforme chaque planning mensuel Excel de l’accueil en agendas `.ics`, un par personne, et les publie sur une page web :

**https://yungnate.github.io/planning-accueil/**

Sur la page, chacun choisit le mois, puis son nom, et récupère ses horaires dans son application d’agenda (Google Agenda, Apple Calendrier, Outlook…).

> **À savoir :** le dépôt et la page sont publics. Toute personne qui a l’adresse peut lire les plannings (prénoms et horaires). La page n’est pas référencée par les moteurs de recherche.

## Ajouter le planning du mois

1. Ouvrez le dossier [`plannings`](plannings) du dépôt.
2. Cliquez sur **Add file**, puis **Upload files**, et déposez le fichier Excel (`.xlsx`).
3. Cliquez sur **Commit changes**.

C’est tout : quelques minutes plus tard, le mois apparaît sur la page. Le suivi se fait dans l’onglet **Actions** (rond orange : en cours, coche verte : publié, croix rouge : problème).

Seul le fichier déposé est converti. Les mois déjà publiés ne sont pas modifiés.

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

## Configuration

- `config/settings.json`
  - `titre` : début du nom des événements et des agendas (`Accueil 15h30–23h`) ;
  - `lieu` : lieu ajouté à chaque événement (vide par défaut) ;
  - `siteUrl` : adresse publique du site.
- `config/aliases.json` : correspondances de prénoms, par exemple `{ "SYLV": "SYLVAIN" }`. Une entrée vers lui-même (`{ "LEO": "LEO" }`) empêche tout rapprochement automatique avec un prénom proche.

Après une modification de la configuration, retraitez tous les plannings (voir ci-dessus).

## Fonctionnement technique

- `src/parse-planning.js` lit la grille Excel (SheetJS) sans coordonnées fixes : titre, lignes de jours, cellules fusionnées, prénoms, horaires.
- `src/ics.js` écrit les fichiers iCalendar (RFC 5545) avec le fuseau `Europe/Paris` : les horaires restent justes aux changements d’heure.
- `src/process.js` traite les fichiers déposés, écrit `data/<AAAA-MM>.json` et `public/ics/<AAAA-MM>/<prénom>.ics`, puis reconstruit les abonnements `public/ics/<prénom>.ics`, le manifeste et la page.
- `.github/workflows/publier.yml` lance les tests, la conversion, enregistre les fichiers générés dans le dépôt, puis publie `public/` sur GitHub Pages.

En local (Node 22 ou plus) :

```sh
npm ci
npm test
node src/process.js --all   # retraite tous les plannings
```
