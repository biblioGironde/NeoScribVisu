// Contours des communes et des intercommunalités de Gironde, pour la carte et l'onglet Cartographies.
// Source : ADEME, référentiel SIG « Contours des communes » et « Contours des EPCI »
// (portail data-interne.ademe.fr, mise à jour annuelle).
// Usage : npm run contours                                   (télécharge depuis l'API de l'ADEME)
//         npm run contours -- communes.geojson epci.geojson  (part de fichiers déjà téléchargés)
// À lancer après npm run import : la liste des intercommunalités vient de public/data/meta.json.
import fs from 'node:fs';
import path from 'node:path';
import { RACINE } from './lib.mjs';

const DEPARTEMENT = '33';
const API = 'https://data-interne.ademe.fr/data-fair/api/v1/datasets';
const DOSSIER = path.join(RACINE, 'public', 'data');
const codesEpci = Object.keys(JSON.parse(fs.readFileSync(path.join(DOSSIER, 'meta.json'), 'utf8')).epci);

async function lire(fichier, url) {
  const geo = fichier ? JSON.parse(fs.readFileSync(fichier, 'utf8')) : await (await fetch(url)).json();
  if (!geo?.features?.length) {
    console.error(`Aucun contour reçu (${fichier ?? url}) : vérifiez l'accès à l'API de l'ADEME.`);
    process.exit(1);
  }
  return geo;
}

// 5 décimales ≈ 1 m : largement suffisant pour une carte départementale.
const arrondir = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5] : c.map(arrondir));

/** Ramène Polygon, MultiPolygon ou GeometryCollection à un MultiPolygon. */
function multiPolygone(g) {
  if (g.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [arrondir(g.coordinates)] };
  if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: arrondir(g.coordinates) };
  if (g.type === 'GeometryCollection') {
    return { type: 'MultiPolygon', coordinates: g.geometries.flatMap((s) => multiPolygone(s).coordinates) };
  }
  return { type: 'MultiPolygon', coordinates: [] };
}

function ecrire(nom, features, source) {
  const sortie = path.join(DOSSIER, nom);
  fs.writeFileSync(sortie, JSON.stringify({ type: 'FeatureCollection', source, features }));
  console.log(`${features.length} contours écrits dans ${path.relative(RACINE, sortie)} (${Math.round(fs.statSync(sortie).size / 1024)} Ko).`);
}

const [fichierCommunes, fichierEpci] = process.argv.slice(2);

const communes = await lire(fichierCommunes,
  `${API}/geo-contours-communes/lines?DDEP_C_COD_eq=${DEPARTEMENT}&format=geojson&size=1000&select=DCOE_C_COD,DCOE_L_LIB,EPCI_CODE`);
ecrire(`communes-${DEPARTEMENT}.geojson`, communes.features.map((f) => ({
  type: 'Feature',
  properties: { code: f.properties.DCOE_C_COD, nom: f.properties.DCOE_L_LIB, codeEpci: f.properties.EPCI_CODE },
  geometry: multiPolygone(f.geometry),
})).sort((a, b) => a.properties.code.localeCompare(b.properties.code)), 'ADEME, référentiel SIG « Contours des communes »');

const epci = await lire(fichierEpci,
  `${API}/epci/lines?EPCI_CODE_in=${codesEpci.join(',')}&format=geojson&size=100&select=EPCI_CODE,EPCI`);
ecrire(`epci-${DEPARTEMENT}.geojson`, epci.features.map((f) => ({
  type: 'Feature',
  properties: { code: f.properties.EPCI_CODE, nom: f.properties.EPCI },
  geometry: multiPolygone(f.geometry),
})).sort((a, b) => a.properties.code.localeCompare(b.properties.code)), 'ADEME, référentiel SIG « Contours des EPCI »');
