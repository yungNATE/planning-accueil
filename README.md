# Plannings de l’accueil

Ce dépôt transforme chaque planning mensuel Excel de l’accueil en agendas `.ics`, un par personne, et les publie sur une page web :

**https://yungnate.github.io/planning-accueil/**

Sur la page, chacun choisit le mois, puis son nom, et récupère ses horaires dans son application d’agenda (Google Agenda, Apple Calendrier, Outlook…).

> **À savoir :** le dépôt et la page sont publics. Toute personne qui a l’adresse peut lire les plannings (prénoms et horaires). La page n’est pas référencée par les moteurs de recherche.

## Ajouter le planning du mois

### Depuis le site (le plus simple)

1. En bas de la page des plannings, cliquez sur **Ajouter un planning** (ou ouvrez https://yungnate.github.io/planning-accueil/ajouter.html).
2. La première fois, saisissez le **mot de passe de dépôt** (l’indice affiché sous le champ se règle dans `config/settings.json`) et laissez « Mémoriser sur cet appareil » coché : il ne sera plus demandé.
3. Choisissez un ou plusieurs fichiers. La page les vérifie aussitôt avec le même lecteur que la publication : mois, période, prénoms, nombre de créneaux, et les éventuels problèmes avec la case concernée.
4. Cliquez sur **Publier**. La page suit la mise en ligne et confirme quand les mois sont publiés, en général en moins d’une minute.

Un fichier qui contient une erreur n’est pas envoyé (les autres le sont) : la page indique quoi corriger dans Excel. Les fichiers envoyés depuis la page sont enregistrés avec le mois en tête de leur nom (`2026-12 PLANNING DECEMBRE.xlsx`), pour que deux fichiers nommés pareil (« planning.xlsx ») ne s’écrasent pas.

Aucun compte GitHub ni aucune clé n’est nécessaire pour déposer : c’est le **service de dépôt** (voir plus bas) qui détient l’accès au dépôt.

### Depuis GitHub

1. Vérifiez que le **nom du fichier contient le mois** (par exemple « Planning décembre 2026.xlsx »), puis ouvrez le dossier [`plannings`](plannings) du dépôt.
2. Cliquez sur **Add file**, puis **Upload files**, et déposez le fichier Excel (`.xlsx`).
3. Cliquez sur **Commit changes**.

C’est tout : quelques minutes plus tard, le mois apparaît sur la page. Le suivi se fait dans l’onglet **Actions** (rond orange : en cours, coche verte : publié, croix rouge : problème).

Seul le fichier déposé est converti. Les mois déjà publiés ne sont pas modifiés.

## Classement des mois et dépôts successifs

- Chaque fichier est rangé d’après le **mois indiqué dans son nom**, jamais d’après sa date de dépôt. La page affiche les mois du plus récent au plus ancien, le plus récent étant mis en avant : déposer décembre puis octobre donne bien « Décembre 2026 » en haut.
- **Plusieurs fichiers d’un coup** (plusieurs fichiers dans un même « Upload files » sur GitHub) : une seule publication les traite tous.
- **Plusieurs dépôts d’affilée** (par exemple quatre fichiers envoyés l’un après l’autre depuis la page d’ajout) : chaque dépôt est mis en file d’attente et publié à son tour, environ 30 secondes chacun. Rien n’est perdu ni annulé.
- Si deux fichiers du **même mois** arrivent, celui déposé **en dernier** fait foi.
- `data/etat.json` retient le dernier dépôt traité : si une publication échoue ou est interrompue, la suivante rattrape tous les fichiers en attente.

## Corriger un planning

Déposez la version corrigée, sous le même nom ou un autre (avec toujours le mois dans le nom). Ce mois est **entièrement remplacé** par cette nouvelle version (y compris si une personne a été retirée).

## Supprimer un mois

**Depuis le site** : sur la page https://yungnate.github.io/planning-accueil/ajouter.html (lien « Ajouter ou supprimer un planning » en bas de la page des plannings), section **Supprimer un mois publié**. Cliquez sur **Supprimer** à côté du mois, puis sur **Confirmer la suppression**. La page suit l’opération et confirme quand le mois a disparu du site, en général en moins d’une minute.

**Depuis GitHub** : onglet **Actions**, workflow **Publier les plannings**, **Run workflow**, et indiquez le mois dans le champ « supprimer » au format `AAAA-MM` (par exemple `2026-10`).

La suppression retire :

- le ou les fichiers Excel de ce mois dans `plannings/` ;
- ses données (`data/AAAA-MM.json`) et ses agendas mensuels ;
- ses jours dans les agendas d’abonnement (les abonnés les voient disparaître au prochain rafraîchissement) ;
- le mois de la page des plannings.

Les agendas déjà téléchargés et importés par chacun ne peuvent pas être modifiés à distance. Rien n’est perdu pour autant : l’historique du dépôt garde tous les fichiers, et redéposer le fichier Excel republie le mois.

Si une suppression et un nouveau fichier du même mois arrivent ensemble, l’ordre compte : supprimer puis déposer republie le mois avec le nouveau fichier ; déposer puis supprimer le retire.

Supprimer à la main un fichier Excel dans `plannings/` sur GitHub ne retire pas le mois du site : utilisez l’un des deux moyens ci-dessus.

## Ce que l’outil lit dans le fichier

Formats acceptés : `.xlsx` (et `.xlsm`), ancien Excel `.xls`, LibreOffice `.ods`. Un fichier protégé par un mot de passe doit être enregistré sans protection avant d’être déposé.

**Le mois.** Il est lu **uniquement dans le nom du fichier**, quelles que soient la casse et les accents : `PLANNING_OCTOBRE_26.xlsx`, `planning décembre.xlsx`, `Planning oct. 26.xlsx`, `PLANNINGDECEMBRE2026.xlsx`. Le titre de la feuille et le nom des onglets ne sont pas utilisés. Si le nom n’indique pas l’année, elle est déduite des jours de la semaine. Un nom sans mois (`Classeur1.xlsx`) ou qui en cite plusieurs est refusé avec un message qui demande de renommer le fichier. Si aucun jour de la grille ne tombe dans le mois du nom, le fichier est refusé ; si seule une minorité des jours y tombe, un avertissement le signale.

**Les jours.** Une ligne de jours par semaine : `LUNDI 28`, `JEUDI 1ER`, `Lun. 5`, `MARDI 29/09`, `MERCREDI 30 SEPTEMBRE`, ou de vraies dates Excel. Le planning peut déborder sur le mois précédent et le suivant : ces jours restent dans le planning du mois. Une dernière semaine incomplète est acceptée. Une semaine absente est signalée (ses jours ne sont dans aucun agenda) ; une semaine en double ou dans le désordre est une erreur.

**Les personnes.** Une ligne par personne sous chaque ligne de jours, le prénom dans la colonne juste à gauche du premier jour (ou un peu plus à gauche si une colonne vide est intercalée). Les annotations sont ignorées : `TOM (stagiaire)` et `TOM*` sont Tom. Une faute de frappe d’une lettre (`SYVAIN` pour `SYLVAIN`) est corrigée avec un avertissement, y compris quand elle concerne tout un mois et ressemble à une personne des mois précédents. Si ce sont réellement deux personnes, ajoutez une entrée dans `config/aliases.json`. Deux personnes portant le même prénom doivent être distinguées dans le fichier (`THOMAS B.` et `THOMAS L.`).

**Les horaires.** `8H-15H30`, `15H30-23H`, `8h - 15h`, `8h à 15h`, `de 8h à 15h`, `08:00-12:00`, `8.30-12`, `8-15`. Plusieurs créneaux dans une case se séparent par `/`, `+` ou `et`. Un horaire qui finit après minuit (`22H-6H`) se termine le lendemain. Un texte en plus (`8H-12H FORMATION`) est conservé dans la description de l’événement. Une case fusionnée sur plusieurs jours vaut pour chacun d’eux. Des créneaux qui se chevauchent sont signalés.

**Toute case sans horaire est un jour OFF** : case vide, `RH`, `MA`, `CP`, etc. Aucun événement n’est créé.

Si une case contient des chiffres mais pas un horaire reconnu (par exemple `15H30_23H`), la journée est comptée OFF **et un avertissement indique la case**, pour corriger le fichier.

**Ce qui est ignoré**, comme à l’écran : les lignes, colonnes et onglets masqués. Si le classeur contient plusieurs onglets de planning, seul celui dont les jours correspondent le mieux au mois du nom est publié, avec un avertissement.

## S’abonner plutôt que télécharger chaque mois

Sur la page, le bouton **S’abonner** à côté d’un nom donne une adresse d’agenda qui contient tous les mois publiés pour cette personne. Une fois abonnée, l’application d’agenda ajoute d’elle-même les nouveaux plannings et les corrections.

- **Google Agenda** : sur ordinateur, à côté de « Autres agendas », choisissez « + », puis « À partir de l’URL », et collez l’adresse. Google peut mettre jusqu’à 24 heures, parfois plus, pour afficher les changements.
- **iPhone, iPad, Mac** : touchez « Ouvrir dans mon application d’agenda » et confirmez.
- **Outlook** : « Ajouter un calendrier », puis « S’abonner à partir du web », et collez l’adresse.

Évitez de cumuler un abonnement et des téléchargements mensuels : les horaires apparaîtraient en double.

## Si l’Action est en échec (croix rouge)

1. Onglet **Actions**, cliquez sur l’exécution en échec.
2. Le **résumé** en bas de page indique le fichier, la case et le problème (mois absent du nom du fichier, jour incohérent, horaires sans prénom…).
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
- Le service accepte au plus 40 appels par minute et par adresse, et attend une seconde après chaque mauvais mot de passe : les essais en rafale sont freinés. Le mot de passe est comparé sans tenir compte des espaces autour.
- `ORIGINE_AUTORISEE` (facultatif) : site(s) autorisé(s) à appeler le service, séparés par des virgules, si le site change d’adresse (domaine personnalisé).

## Configuration

- `config/settings.json`
  - `titre` : début du nom des événements et des agendas (`Accueil 15h30–23h`) ;
  - `lieu` : lieu ajouté à chaque événement (vide par défaut) ;
  - `siteUrl` : adresse publique du site ;
  - `depot` : dépôt GitHub (`propriétaire/nom`) ;
  - `serviceDepot` : adresse du service de dépôt utilisé par la page d’ajout ;
  - `indiceMotDePasse` : indication affichée sous le champ du mot de passe (vide pour n’en afficher aucune).
- `config/aliases.json` : correspondances de prénoms, par exemple `{ "SYLV": "SYLVAIN" }`. Une entrée vers lui-même (`{ "LEO": "LEO" }`) empêche tout rapprochement automatique avec un prénom proche.

Après une modification de la configuration, retraitez tous les plannings (voir ci-dessus).

## Fonctionnement technique

- `src/parse-planning.js` lit la grille Excel (SheetJS) sans coordonnées fixes : lignes de jours, cellules fusionnées, prénoms, horaires ; le mois vient du nom du fichier.
- `src/ics.js` écrit les fichiers iCalendar (RFC 5545) avec le fuseau `Europe/Paris` : les horaires restent justes aux changements d’heure.
- `src/process.js` traite les fichiers déposés, écrit `data/<AAAA-MM>.json` et `public/ics/<AAAA-MM>/<prénom>.ics`, puis reconstruit les abonnements `public/ics/<prénom>.ics`, le manifeste et les pages.
- `site/upload.js` (page d’ajout) réutilise dans le navigateur `parse-planning.js`, `util.js`, `names.js` et SheetJS, copiés dans `public/assets/` à chaque publication, puis envoie le fichier au service de dépôt et suit l’exécution de l’Action.
- `depot/netlify/functions/depot.mts` (service de dépôt) : routes `/api/verifier`, `/api/deposer`, `/api/supprimer` et `/api/suivi`, appels à l’API GitHub avec `GITHUB_TOKEN`, accès limité au site des plannings (CORS). Une suppression dépose une demande `demandes/supprimer-AAAA-MM.json`, que la publication traite puis retire.
- `.github/workflows/publier.yml` lance les tests, la conversion, enregistre les fichiers générés dans le dépôt, puis publie `public/` sur GitHub Pages.

En local (Node 22 ou plus) :

```sh
npm ci
npm test
node src/process.js --all   # retraite tous les plannings
```
