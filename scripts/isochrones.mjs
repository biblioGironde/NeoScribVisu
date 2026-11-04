// Isochrones des bibliothèques de typologie A, B et C (temps de trajet en voiture).
// Service : API Géoplateforme de l'IGN (calcul d'isochrone, réseau BD TOPO, moteur Valhalla), gratuite et sans clé.
// Usage : npm run isochrones   (après npm run import ; ne recalcule que les lieux nouveaux ou déplacés)
// Sortie : public/data/isochrones.json  { durees, source, calcule_le, zones: { "lon,lat": { "10": [...], "20": [...] } } }
import fs from 'node:fs';
import path from 'node:path';
import { RACINE } from './lib.mjs';

const DUREES = [10, 20]; // minutes
const TYPOLOGIES = new Set(['A', 'B', 'C']);
const SORTIE = path.join(RACINE, 'public', 'data', 'isochrones.json');
// Tracés bruts de l'IGN, conservés localement pour ne pas refaire les appels (dossier ignoré par git).
const CACHE = path.join(RACINE, 'data', 'cache', 'isochrones-brut.json');
const TOLERANCE = 0.001; // degrés, ≈ 80 m : invisible à l'échelle du département
const API = 'https://data.geopf.fr/navigation/isochrone';
const PARALLELE = 2;
const PAUSE = 400; // ms entre deux appels par travailleur, pour rester sous la limite de débit de l'IGN

const meta = JSON.parse(fs.readFileSync(path.join(RACINE, 'public', 'data', 'meta.json'), 'utf8'));
const cle = (lon, lat) => `${lon.toFixed(5)},${lat.toFixed(5)}`;

// Points à calculer : tous les lieux A, B, C localisés, toutes années confondues.
const points = new Map();
for (const annee of meta.annees) {
  const { etablissements } = JSON.parse(fs.readFileSync(path.join(RACINE, 'public', 'data', `${annee}.json`), 'utf8'));
  for (const e of etablissements) {
    if (e.type === 'lieu' && TYPOLOGIES.has(e.typologie) && e.lat && e.lon) points.set(cle(e.lon, e.lat), [e.lon, e.lat]);
  }
}

const existant = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { zones: {} };
const zones = {};
const aFaire = [];
for (const [k, pt] of points) {
  if (DUREES.every((d) => existant.zones[k]?.[d]?.length)) zones[k] = existant.zones[k];
  else aFaire.push([k, pt]);
}
console.log(`${points.size} lieux A, B, C localisés ; ${aFaire.length} à calculer.`);

/** Simplification de Douglas-Peucker (tolérance en degrés ≈ 40 m) et arrondi à 4 décimales (≈ 10 m). */
function douglasPeucker(points, tol) {
  if (points.length < 3) return points;
  const garder = new Uint8Array(points.length);
  garder[0] = garder[points.length - 1] = 1;
  const pile = [[0, points.length - 1]];
  while (pile.length) {
    const [a, b] = pile.pop();
    const [x1, y1] = points[a], [x2, y2] = points[b];
    const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy);
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i];
      const d = l ? Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / l : Math.hypot(x - x1, y - y1);
      if (d > max) { max = d; idx = i; }
    }
    if (idx > 0 && max > tol) { garder[idx] = 1; pile.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => garder[i]);
}
function simplifier(anneau, tol = TOLERANCE) {
  // Anneau fermé : on le coupe au point le plus éloigné du départ pour simplifier deux lignes ouvertes.
  const ouvert = anneau.slice(0, -1);
  if (ouvert.length < 4) return anneau;
  let loin = 0, dmax = -1;
  ouvert.forEach(([x, y], i) => { const d = Math.hypot(x - ouvert[0][0], y - ouvert[0][1]); if (d > dmax) { dmax = d; loin = i; } });
  const a = douglasPeucker(ouvert.slice(0, loin + 1), tol);
  const b = douglasPeucker([...ouvert.slice(loin), ouvert[0]], tol);
  return [...a, ...b.slice(1)].map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}

/** Polygone ou multipolygone → liste de polygones bruts (coordonnées arrondies à 5 décimales). */
function polygones(g) {
  const liste = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return liste.map((poly) => poly.map((r) => r.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5])));
}
const simplifierPolygones = (liste) => liste.map((poly) => poly.map((r) => simplifier(r)).filter((r) => r.length > 3)).filter((p) => p.length);

async function isochrone([lon, lat], minutes, essai = 1) {
  const url = `${API}?resource=bdtopo-valhalla&profile=car&costType=time&timeUnit=second&costValue=${minutes * 60}`
    + `&direction=arrival&geometryFormat=geojson&point=${lon},${lat}`;
  try {
    const r = await fetch(url);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 5000 * essai)); throw new Error('HTTP 429 (débit limité)'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return polygones((await r.json()).geometry);
  } catch (err) {
    if (essai >= 5) throw err;
    await new Promise((ok) => setTimeout(ok, 1500 * essai));
    return isochrone([lon, lat], minutes, essai + 1);
  }
}

let fait = 0, echecs = 0;
async function travailleur() {
  while (aFaire.length) {
    const [k, pt] = aFaire.shift();
    try {
      zones[k] = {};
      for (const d of DUREES) {
        zones[k][d] = await isochrone(pt, d);
        await new Promise((ok) => setTimeout(ok, PAUSE));
      }
    } catch (err) {
      delete zones[k];
      echecs++;
      console.warn(`  échec pour ${k} : ${err.message}`);
    }
    if (++fait % 20 === 0) console.log(`  ${fait} lieux calculés…`);
  }
}
await Promise.all(Array.from({ length: PARALLELE }, travailleur));

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, JSON.stringify({ zones }));
const publiees = Object.fromEntries(Object.entries(zones).map(([k, z]) => [k, Object.fromEntries(DUREES.map((d) => [d, simplifierPolygones(z[d])]))]));
fs.writeFileSync(SORTIE, JSON.stringify({
  durees: DUREES,
  source: 'IGN, API Géoplateforme de calcul d\'isochrone (BD TOPO, Valhalla), trajet en voiture',
  calcule_le: new Date().toISOString().slice(0, 10),
  zones: publiees,
}));
console.log(`${Object.keys(publiees).length} lieux dans ${path.relative(RACINE, SORTIE)} (${Math.round(fs.statSync(SORTIE).size / 1024)} Ko)${echecs ? `, ${echecs} échecs : relancer la commande` : ''}.`);
