# Lecture publique en Gironde : tableau de bord

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

Pour publier, il suffit de copier le dossier `public/` sur n'importe quel hébergement statique (serveur du Département, GitHub Pages…).

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

`npm run verifier` recalcule 90 totaux 2024 et les compare aux valeurs relevées dans le Looker d'origine le 03/11/2026 (filtre année 2024, toute la Gironde). Tous doivent être identiques.

## Licence

Code sous licence MIT. Données : ministère de la Culture, enquête annuelle sur les bibliothèques des collectivités territoriales.
