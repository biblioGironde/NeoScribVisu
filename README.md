# NeoScribVisu

Tableau de bord open source des bibliothèques de Gironde, construit à partir des exports de l'enquête annuelle du Service du livre et de la lecture (SLL, ministère de la Culture). Il remplace le rapport Looker Studio « TB Gironde » et en reprend les 17 pages, avec des calculs corrigés.

- Aucun serveur ni base de données : un script Node prépare des fichiers JSON, une page web statique les affiche.
- Filtres : année, intercommunalité, commune, typologie, réseau biblio.gironde.
- Évolution sur un an à périmètre constant, carte des lieux de lecture, tableau par établissement exportable en CSV.

## Démarrer

Prérequis : Node.js 18 ou plus récent.

```bash
npm install
# déposer les exports de l'enquête dans data/raw/<année>/ (voir ci-dessous)
npm run import     # prépare public/data/ et rapport-import.md
npm run verifier   # contrôle les totaux 2024 contre le Looker d'origine
npm start          # http://localhost:8080
```

## Fonds de carte

La carte de la page Général propose deux fonds, au choix en haut à droite : le plan OpenStreetMap et le découpage communal. Le choix est mémorisé dans le navigateur et repris dans l'export PDF. En découpage communal, les communes qui ont au moins un lieu de lecture dans la sélection sont teintées ; un clic sur l'une d'elles ouvre sa fiche.

Les contours viennent du référentiel SIG « Contours des communes » de l'ADEME (data-interne.ademe.fr, mis à jour chaque année). Ils sont stockés dans `public/data/communes-33.geojson` et `public/data/epci-33.geojson` ; pour les rafraîchir, après `npm run import` : `npm run contours`.

## Cartographies

L'onglet « Cartographies » reprend les cartes thématiques produites jusqu'ici à la main (série 2024) :

- **par commune** : gratuité, accès public à internet, heures d'ouverture, accessibilité, emprunteurs actifs, surface pour 100 habitants ;
- **par intercommunalité, population desservie** (série A, population des communes qui ont un lieu de lecture) et **population totale** (série B) : emprunteurs, surface, bénévoles, ETP salariés, budget d'acquisition, fonds propre, part du fonds biblio.gironde, budget d'action culturelle.

Les cartes sont dessinées en SVG à partir des contours ADEME des communes et des intercommunalités (`npm run contours`). Le filtre d'intercommunalité recadre la carte ; un clic sur une commune ouvre sa fiche. Le bouton « Exporter les cartes en PDF » produit une carte par page en A4 portrait, au choix dans une liste.

Les cartes, leurs classes et leurs couleurs sont décrites dans `config/indicateurs.json`, rubrique `cartographies`.

## Export PDF

Le bouton « Exporter en PDF » ouvre une liste de choix : pages à intégrer, contenu de chaque page (chiffres clés, carte, répartitions, graphiques par territoire, tableau par établissement), page de garde et méthode. Le document est mis en page en A4 paysage avec les filtres en cours, puis la fenêtre d'impression du navigateur s'ouvre : choisir « Enregistrer au format PDF ». Les choix de contenu sont mémorisés dans le navigateur pour l'export suivant.

Le pied de page (périmètre, date, numéro de page) s'affiche avec Chrome et Edge.

## Publication

Le site est publié sur GitHub Pages : https://bibliogironde.github.io/NeoScribVisu/

Les données générées (`public/data/*.json`) sont versionnées : elles ne contiennent aucune donnée nominative. Pour mettre le site à jour, relancer `npm run import` puis committer et pousser `public/data/`. La GitHub Action « Publication GitHub Pages » redéploie automatiquement le dossier `public/` à chaque modification sur `main`.

Le dossier `public/` peut aussi être copié tel quel sur n'importe quel autre hébergement statique.

## Données attendues

Pour chaque année, un dossier `data/raw/<année>/` avec les exports CSV de la plateforme d'enquête. Les fichiers sont reconnus à leurs colonnes, leur nom n'a pas d'importance :

| Export | Reconnu par | Usage |
|---|---|---|
| Enquête complète (de préférence la version **avec les réseaux**, lignes `UC…`) | colonnes `Code`, `A101`… | toutes les valeurs ; la 1re ligne contient les libellés des variables |
| Annuaire des lieux | colonne `GenUID` | coordonnées GPS pour la carte |
| Typologie | colonne `code_lieu` | nouvelle typologie A–E |

Les exports bruts contiennent des données nominatives (responsables, courriels, téléphones) : ils restent dans `data/raw/`, ignoré par git. L'import n'en reprend aucune.

Facultatif : `config/referentiel.csv` (modèle : `referentiel.exemple.csv`), une ligne par établissement.
- La colonne `reseau_biblio_gironde` (oui/non) active le filtre du même nom.
- La colonne `nom` corrige un nom mal saisi dans l'enquête. Quand le nom saisi ne ressemble pas à celui d'une bibliothèque (un nom de personne, par exemple), l'import affiche « Bibliothèque de <commune> ».

## Ajouter une année

1. Déposer les exports dans `data/raw/<année>/` puis lancer `npm run import`.
2. Lire `rapport-import.md` : il liste les variables ajoutées, retirées ou renommées par rapport à l'année précédente, et les indicateurs que la configuration ne sait pas encore calculer.
3. Si besoin, compléter `config/indicateurs.json` : chaque indicateur a un identifiant stable et, pour chaque année, le ou les codes de l'enquête.

```json
"non_titulaires": {
  "libelle": "Non titulaires",
  "agregation": "somme",
  "source": { "2024": "G123", "2025": "G146+G149+G152" }
}
```

- `"*"` vaut pour toutes les années non citées ; `null` ou une année absente signifie « non collecté » (affiché comme tel, jamais 0).
- `A+B` additionne des codes ; `A|B` vaut « Oui » si l'un des deux vaut « Oui ».
- Agrégations : `somme`, `oui`, `renseigne`, `categorie`, `population`, `ratio` (`numerateur`, `denominateur`, `facteur`).

Les pages sont décrites dans le même fichier (`pages` : tuiles, graphiques par territoire, colonnes du tableau).

## Règles de calcul

- **Réseaux multi-sites** : pour 13 communes, une partie des données (personnel, budgets, usagers) n'est saisie que sur la ligne « réseau » (`UC…`). Les sommes additionnent lieux et réseaux, comme le faisait le Looker. Le rapport d'import signale les indicateurs remplis aux deux niveaux, à vérifier avec les bibliothèques.
- **Population** : comptée une seule fois par commune, même quand la commune a plusieurs lieux de lecture (le Looker l'additionnait pour chaque lieu).
- **Moyennes** : division de totaux, sur les établissements qui renseignent les deux valeurs (le Looker additionnait des ratios ligne à ligne).
- **Évolutions** : calculées sur les seuls établissements qui ont répondu les deux années, pour qu'une non-réponse ne se lise pas comme une baisse.

## Vérification

`npm run verifier` recalcule 90 totaux 2024 et la répartition des 10 principaux SIGB, et les compare aux valeurs relevées dans le Looker d'origine le 03/11/2026 (filtre année 2024, toute la Gironde). Tous doivent être identiques.

## Licence

Code sous licence MIT. Données : ministère de la Culture, enquête annuelle sur les bibliothèques des collectivités territoriales.
