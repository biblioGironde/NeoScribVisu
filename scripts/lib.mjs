// Fonctions partagées par l'import et la vérification.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

export const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function lireCsv(fichier) {
  const texte = fs.readFileSync(fichier, 'utf8');
  return parse(texte, {
    delimiter: ';',
    bom: true,
    columns: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
  });
}

/** Identifie le type d'un export à partir de ses colonnes. */
export function typeExport(lignes) {
  const cols = Object.keys(lignes[0] ?? {});
  if (cols.includes('A101') && cols.includes('Code')) return 'enquete';
  if (cols.includes('GenUID')) return 'annuaire';
  if (cols.includes('code_lieu')) return 'typologie';
  return 'inconnu';
}

export const estCodeVariable = (c) => /^[A-K]\d{3}$/.test(c);

/** Nombre au format français (« 1 234,5 ») ou null. */
export function nombre(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Oui/Non → 1/0, sinon null. */
export function ouiNon(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'oui') return 1;
  if (s === 'non') return 0;
  return null;
}

/** Codes utilisés par une expression de source (« G146+G149+G152 », « H437|H441 »). */
export const codesDe = (expr) => (expr ? expr.split(/[+|]/).map((c) => c.trim()).filter(Boolean) : []);

/** Expression applicable à une année donnée, ou null si non collecté. */
export function sourcePour(indicateur, annee) {
  const s = indicateur.source;
  if (!s) return null;
  if (Object.hasOwn(s, String(annee))) return s[String(annee)];
  return s['*'] ?? null;
}

/** Valeur d'une expression pour une ligne de l'enquête. */
export function evaluer(expr, agregation, ligne) {
  const codes = codesDe(expr);
  if (agregation === 'oui') {
    const vals = codes.map((c) => ouiNon(ligne[c])).filter((v) => v !== null);
    if (!vals.length) return null;
    return vals.some((v) => v === 1) ? 1 : 0;
  }
  if (agregation === 'renseigne') {
    return codes.some((c) => String(ligne[c] ?? '').trim() !== '') ? 1 : 0;
  }
  if (agregation === 'categorie') {
    const v = String(ligne[codes[0]] ?? '').trim();
    return v || null;
  }
  const vals = codes.map((c) => nombre(ligne[c])).filter((v) => v !== null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) * 1000) / 1000;
}

/** Regroupe les intitulés de SIGB saisis librement par éditeur. */
export function familleSigb(v) {
  if (!v) return null;
  const s = v.toLowerCase();
  const regles = [
    [/decalog/, 'Decalog'],
    [/orph[ée]e/, 'Orphée'],
    [/waterbear/, 'WaterBear'],
    [/\bpmb\b/, 'PMB'],
    [/\bbgm\b/, 'BGM'],
    [/nanook|\bafi\b/, 'AFI Nanook'],
    [/syracuse/, 'Syracuse'],
    // Regroupement repris du Looker de Blandine : Novalys, Sapentia et Oxalys comptés avec Microbib.
    [/novalys|microbib|sapentia|oxalys/, 'Microbib'],
    [/portfolio|inm[ée]dia/, 'InMédia / PortFolio'],
    [/cassiop/, 'Cassiopée'],
    [/colibris/, 'CoLibris'],
    [/karvi/, 'Karvi'],
    [/v-?smart/, 'V-smart'],
  ];
  for (const [re, nom] of regles) if (re.test(s)) return nom;
  return 'Autre';
}

export function lireConfig() {
  return JSON.parse(fs.readFileSync(path.join(RACINE, 'config', 'indicateurs.json'), 'utf8'));
}
