// Contrôle de non-régression : les totaux 2024 doivent retrouver ceux du Looker Studio de Blandine
// (relevés le 03/11/2026, filtre « Année des données = 2024 », toute la Gironde).
// Usage : npm run verifier
import fs from 'node:fs';
import path from 'node:path';
import { RACINE } from './lib.mjs';

const LOOKER_2024 = {
  heures_hebdo: 3932, jours_annuels: 38254, jours_hebdo: 958,
  dep_informatique: 288734, consoles: 53, tablettes: 289, liseuses: 80,
  personnel_total: 1835, salaries: 972, benevoles: 863, benevoles_qualifies: 107.5,
  formation_jours: 3222, formation_participants: 323,
  conservateurs: 13, etp_conservateurs: 12.7, bibliothecaires: 67, etp_bibliothecaires: 65.3,
  assistants: 210, etp_assistants: 189.29, adjoints: 361, etp_adjoints: 328.13,
  fpt_a: 8, etp_fpt_a: 7.3, fpt_b: 24, etp_fpt_b: 22.1, fpt_c: 134, etp_fpt_c: 104.28,
  non_titulaires: 155, etp_non_titulaires: 94.22, etp_total: 895.22, etp_benevoles: 71.9, etp_benevoles_qualifies: 21.97,
  livres_fonds: 3631484, livres_fonds_adultes: 2200345, livres_fonds_enfants: 1431139,
  livres_acq_adultes: 99329, livres_acq_enfants: 101000, livres_pilons_adultes: 113566, livres_pilons_enfants: 92335,
  cd_fonds: 308284, cd_acq: 8436, cd_pilons: 23295, dvd_fonds: 237048, dvd_acq: 10553, dvd_pilons: 6654,
  presse_abonnements: 5957, jv_fonds: 6921, jv_acq: 688, jv_pilons: 308,
  nouveaux_inscrits: 65671, emprunteurs: 212152, emprunteurs_residents: 143141, frequentation: 3290988,
  prets_livres: 5587341, prets_presse: 387465, prets_sonores: 223348, prets_video: 570473, prets_autres: 66151,
  dep_investissement: 2595612, dep_personnel: 31937619, dep_action_culturelle: 1164498, dep_equipement: 323086, dep_communication: 94246,
  acq_total: 3894326, acq_numerique: 82762, acq_livres: 2733424, acq_presse: 389705, acq_sonores: 118614, acq_dvd: 419452, acq_jv: 35783, acq_autres: 74190,
  subventions: 1049939, ressources_privees: 49448, recettes_propres: 210949, droits_inscription: 114474, droits_usage: 45495,
  expo_public: 121044, conferences_public: 32355, concerts_public: 15129, contes_public: 19628, clubs_public: 11168, fetes_public: 66374, autres_public: 34825,
  hors_murs_actions: 1023, hors_murs_public: 30949, portage_actions: 1032, portage_public: 907,
  ecoles_classes: 3395, ecoles_accueils: 14389, ecoles_public: 91970,
};

const fichier = path.join(RACINE, 'public', 'data', '2024.json');
if (!fs.existsSync(fichier)) { console.error('Lancez d\'abord npm run import avec les exports 2024.'); process.exit(1); }
const lignes = JSON.parse(fs.readFileSync(fichier, 'utf8')).etablissements;

let ok = 0;
const ecarts = [];
for (const [id, attendu] of Object.entries(LOOKER_2024)) {
  const total = Math.round(lignes.reduce((s, e) => s + (e.v[id] ?? 0), 0) * 100) / 100;
  if (Math.abs(total - attendu) < 0.01) ok++;
  else ecarts.push(`  ${id} : ${total} au lieu de ${attendu}`);
}
console.log(`${ok}/${Object.keys(LOOKER_2024).length} indicateurs identiques au Looker 2024.`);
if (ecarts.length) { console.log('Écarts :\n' + ecarts.join('\n')); process.exit(1); }
