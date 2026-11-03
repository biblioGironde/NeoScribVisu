// Contours des communes de Gironde pour le fond de carte « Communes ».
// Source : ADEME, référentiel SIG « Contours des communes » (portail data-interne.ademe.fr, mise à jour annuelle).
// Usage : npm run contours            (télécharge depuis l'API de l'ADEME)
//         npm run contours -- fichier.geojson   (part d'un fichier déjà téléchargé)
import fs from 'node:fs';
import path from 'node:path';
import { RACINE } from './lib.mjs';

const DEPARTEMENT = '33';
const URL_API = 'https://data-interne.ademe.fr/data-fair/api/v1/datasets/geo-contours-communes/lines'
  + `?DDEP_C_COD_eq=${DEPARTEMENT}&format=geojson&size=1000&select=DCOE_C_COD,DCOE_L_LIB,EPCI_CODE`;
const SORTIE = path.join(RACINE, 'public', 'data', `communes-${DEPARTEMENT}.geojson`);

const source = process.argv[2];
const geo = source
  ? JSON.parse(fs.readFileSync(source, 'utf8'))
  : await (await fetch(URL_API)).json();

if (!geo?.features?.length) {
  console.error('Aucune commune reçue : vérifiez l\'accès à l\'API de l\'ADEME.');
  process.exit(1);
}

// 5 décimales ≈ 1 m : largement suffisant pour une carte départementale, et deux fois plus léger.
const arrondir = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5] : c.map(arrondir));

const resultat = {
  type: 'FeatureCollection',
  source: 'ADEME, référentiel SIG « Contours des communes »',
  features: geo.features.map((f) => ({
    type: 'Feature',
    properties: { code: f.properties.DCOE_C_COD, nom: f.properties.DCOE_L_LIB, codeEpci: f.properties.EPCI_CODE },
    geometry: { type: f.geometry.type, coordinates: arrondir(f.geometry.coordinates) },
  })).sort((a, b) => a.properties.code.localeCompare(b.properties.code)),
};
fs.writeFileSync(SORTIE, JSON.stringify(resultat));
console.log(`${resultat.features.length} communes écrites dans ${path.relative(RACINE, SORTIE)} (${Math.round(fs.statSync(SORTIE).size / 1024)} Ko).`);
