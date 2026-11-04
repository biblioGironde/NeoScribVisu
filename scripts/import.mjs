// Import des exports de l'enquête SLL → données de l'application.
// Usage : npm run import   (lit data/raw/<année>/*.csv, écrit public/data/ et rapport-import.md)
import fs from 'node:fs';
import path from 'node:path';
import {
  RACINE, lireCsv, typeExport, estCodeVariable, nombre, sourcePour, codesDe, evaluer, familleSigb, lireConfig,
} from './lib.mjs';

const DOSSIER_BRUT = path.join(RACINE, 'data', 'raw');
const DOSSIER_SORTIE = path.join(RACINE, 'public', 'data');
const REFERENTIEL = path.join(RACINE, 'config', 'referentiel.csv');

const config = lireConfig();
const indicateurs = config.indicateurs;
const rapport = [];
const log = (...l) => rapport.push(...l);

// ---------------------------------------------------------------- référentiel local (facultatif)
// config/referentiel.csv : code;reseau_biblio_gironde  (ex. LI1294;oui)
const referentiel = new Map();
if (fs.existsSync(REFERENTIEL)) {
  for (const l of lireCsv(REFERENTIEL)) {
    const code = (l.code ?? '').trim();
    if (!code) continue;
    const reseau = (l.reseau_biblio_gironde ?? '').trim().toLowerCase();
    referentiel.set(code, {
      reseau_bg: reseau === 'oui' ? 1 : reseau === 'non' ? 0 : null,
      nom: (l.nom ?? '').trim() || null,
    });
  }
}

// Nom affiché d'un établissement. Il arrive qu'un nom de personne soit saisi à la place du nom du lieu :
// si le nom ne ressemble pas à celui d'une bibliothèque, on affiche « Bibliothèque de <commune> ».
// Le référentiel (colonne facultative « nom ») permet d'imposer un nom.
const RE_NOM_LIEU = /(bibl|bili|m[ée]dia|ludo|lecture|livre|point|espace|maison|club|assoc|salle|graine|a[iï]ga|quincaillerie|poly[eè]dre|salvath|ekla|m\.270|lire|chasseloup|poste|communaut)/i;
function nomEtablissement(l) {
  const impose = referentiel.get(l.Code)?.nom;
  if (impose) return impose;
  const nom = (l.A101 || l.BM || '').trim();
  const commune = (l.A108 || l.BM || '').trim();
  return RE_NOM_LIEU.test(nom) ? nom : `Bibliothèque de ${commune}`;
}

// ---------------------------------------------------------------- lecture des années disponibles
const annees = fs.existsSync(DOSSIER_BRUT)
  ? fs.readdirSync(DOSSIER_BRUT).filter((d) => /^\d{4}$/.test(d)).sort()
  : [];
if (!annees.length) {
  console.error(`Aucun dossier d'année dans ${DOSSIER_BRUT}. Déposez les exports dans data/raw/<année>/.`);
  process.exit(1);
}

fs.mkdirSync(DOSSIER_SORTIE, { recursive: true });
const epciLibelles = {}; // code → libellé le plus récent
const disponibilite = {}; // indicateur → { année: bool }
const dictionnaires = {}; // année → { code: libellé }

log('# Rapport d\'import', '', `Généré le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}.`, '');

for (const annee of annees) {
  const dossier = path.join(DOSSIER_BRUT, annee);
  const fichiers = fs.readdirSync(dossier).filter((f) => f.toLowerCase().endsWith('.csv'));
  const exports = { enquete: [], annuaire: [], typologie: [] };
  for (const f of fichiers) {
    const lignes = lireCsv(path.join(dossier, f));
    const t = typeExport(lignes);
    if (exports[t]) exports[t].push({ fichier: f, lignes });
    else log(`> ⚠️ ${annee} : fichier non reconnu, ignoré : ${f}`);
  }
  if (!exports.enquete.length) {
    log(`## ${annee}`, '', '> ⚠️ Aucun export de l\'enquête trouvé : année ignorée.', '');
    continue;
  }

  // L'export « avec réseaux » contient les lignes UC en plus des lieux : on le préfère.
  const avecUc = (e) => e.lignes.some((l) => String(l.Code).startsWith('UC'));
  const enquete = exports.enquete.find(avecUc) ?? exports.enquete[0];

  // 1re ligne = libellés des codes.
  const ligneLibelles = enquete.lignes.find((l) => l.Code === 'Code');
  const dico = {};
  for (const [c, v] of Object.entries(ligneLibelles ?? {})) if (estCodeVariable(c)) dico[c] = v;
  dictionnaires[annee] = dico;
  const donnees = enquete.lignes.filter((l) => l !== ligneLibelles && l.Code && l.Code !== 'Code');
  const colonnes = new Set(Object.keys(enquete.lignes[0]));

  const annuaire = new Map((exports.annuaire[0]?.lignes ?? []).map((l) => [l.Code, l]));
  const typologie = new Map((exports.typologie[0]?.lignes ?? []).filter((l) => l.code_lieu).map((l) => [l.code_lieu, l]));

  // Indicateurs calculables cette année
  const actifs = [];
  const manquants = [];
  for (const [id, ind] of Object.entries(indicateurs)) {
    disponibilite[id] ??= {};
    if (ind.agregation === 'ratio') continue; // dépend d'autres indicateurs
    const expr = sourcePour(ind, annee);
    if (!expr) { disponibilite[id][annee] = false; continue; }
    const absents = codesDe(expr).filter((c) => !colonnes.has(c));
    if (absents.length) {
      manquants.push(`\`${id}\` (${absents.join(', ')})`);
      disponibilite[id][annee] = false;
      continue;
    }
    disponibilite[id][annee] = true;
    actifs.push([id, ind, expr]);
  }
  for (const [id, ind] of Object.entries(indicateurs)) {
    if (ind.agregation !== 'ratio') continue;
    const deps = [ind.numerateur, ind.denominateur].filter(Boolean);
    disponibilite[id][annee] = deps.every((d) => disponibilite[d]?.[annee]);
  }

  const etablissements = donnees.map((l) => {
    const an = annuaire.get(l.Code);
    const ty = typologie.get(l.Code);
    if (l['Code EPCI'] && l['Libellé EPCI']) epciLibelles[l['Code EPCI']] = l['Libellé EPCI'];
    const v = {};
    for (const [id, ind, expr] of actifs) {
      let val = evaluer(expr, ind.agregation, l);
      if (id === 'sigb') val = familleSigb(val);
      if (id === 'population') val = nombre(l.A200) ?? nombre(l.A203);
      if (val !== null) v[id] = val;
    }
    return {
      code: l.Code,
      type: String(l.Code).startsWith('UC') ? 'reseau' : 'lieu',
      nom: nomEtablissement(l),
      commune: (l.A108 || l.BM || '').trim(),
      insee: l.insee || an?.['Code insee commune'] || null,
      epci: l['Code EPCI'] || an?.['Code EPCI'] || null,
      typologie: l.Typologie2C || null,
      nouvelle_typologie: ty?.['Nouvelle typologie'] || null,
      avancement: l.Avancement || null,
      completude: nombre(String(l['Taux de complétude'] ?? '').replace('%', '')),
      lat: nombre(an?.Latitude),
      lon: nombre(an?.Longitude),
      rattachement: an?.['Rattachement administratif'] || null,
      reseau_bg: referentiel.get(l.Code)?.reseau_bg ?? null,
      v,
    };
  });

  // SIGB des bibliothèques intercommunales : il n'est déclaré que sur la ligne du réseau (UC).
  // Comme dans le Looker, les lieux rattachés à l'EPCI qui n'ont pas de SIGB reprennent celui du réseau
  // de leur intercommunalité, quand ce réseau est unique ou que tous ses réseaux ont le même SIGB.
  const sigbReseau = new Map();
  for (const r of etablissements.filter((e) => e.type === 'reseau' && e.v.sigb && e.epci)) {
    const deja = sigbReseau.get(r.epci);
    sigbReseau.set(r.epci, deja === undefined || deja === r.v.sigb ? r.v.sigb : null);
  }
  let herites = 0;
  for (const e of etablissements) {
    if (e.type !== 'lieu' || e.v.sigb || e.rattachement !== 'EPCI' || !sigbReseau.get(e.epci)) continue;
    e.v.sigb = sigbReseau.get(e.epci);
    e.sigb_herite = 'epci';
    herites++;
  }
  // Réseaux communaux (Bordeaux, Pessac, Mérignac…) : les lieux de la commune sans SIGB déclaré
  // reprennent celui de la ligne réseau de leur commune. Règle ajoutée par rapport au Looker.
  const sigbCommune = new Map();
  for (const r of etablissements.filter((e) => e.type === 'reseau' && e.v.sigb && e.insee)) sigbCommune.set(r.insee, r.v.sigb);
  let heritesCommune = 0;
  for (const e of etablissements) {
    if (e.type !== 'lieu' || e.v.sigb || !sigbCommune.get(e.insee)) continue;
    e.v.sigb = sigbCommune.get(e.insee);
    e.sigb_herite = 'commune';
    heritesCommune++;
  }

  // Population totale de chaque intercommunalité (annuaire) : cartes intercommunales « population totale ».
  const population_epci = {};
  for (const l of annuaire.values()) {
    const p = nombre(l['Population EPCI']);
    if (l['Code EPCI'] && p) population_epci[l['Code EPCI']] = p;
  }

  fs.writeFileSync(path.join(DOSSIER_SORTIE, `${annee}.json`), JSON.stringify({ annee: Number(annee), etablissements, population_epci }));

  // ------------------------------------------------------------ rapport de l'année
  const nbLieux = etablissements.filter((e) => e.type === 'lieu').length;
  const nbReseaux = etablissements.length - nbLieux;
  const avancement = {};
  for (const e of etablissements) avancement[e.avancement ?? 'non renseigné'] = (avancement[e.avancement ?? 'non renseigné'] ?? 0) + 1;
  log(`## ${annee}`, '',
    `- Export de l'enquête : \`${enquete.fichier}\` — ${nbLieux} lieux, ${nbReseaux} réseaux, ${Object.keys(dico).length} variables`,
    `- Annuaire : ${exports.annuaire[0] ? `\`${exports.annuaire[0].fichier}\`` : '**absent** (pas de carte)'}`,
    `- Typologie : ${exports.typologie[0] ? `\`${exports.typologie[0].fichier}\`` : 'absente'}`,
    `- Avancement : ${Object.entries(avancement).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `- SIGB repris du réseau pour les lieux sans SIGB déclaré : ${herites} lieux intercommunaux, ${heritesCommune} lieux de réseaux communaux`,
    `- Indicateurs non disponibles cette année : ${Object.entries(disponibilite).filter(([, d]) => d[annee] === false).map(([id]) => `\`${id}\``).join(', ') || 'aucun'}`,
  );
  if (manquants.length) log('', `> ⚠️ Codes prévus dans la configuration mais absents de l'export : ${manquants.join(', ')}. Corrigez \`config/indicateurs.json\`.`);

  // Double compte possible : même indicateur rempli sur la ligne réseau et sur ses lieux.
  const doubles = [];
  for (const r of etablissements.filter((e) => e.type === 'reseau')) {
    const lieux = etablissements.filter((e) => e.type === 'lieu' && e.insee === r.insee);
    for (const [id, ind] of Object.entries(indicateurs)) {
      if (ind.agregation !== 'somme' || !r.v[id]) continue;
      if (lieux.some((li) => li.v[id])) doubles.push(`${r.commune} : \`${id}\``);
    }
  }
  if (doubles.length) log('', `> ℹ️ Valeurs saisies à la fois sur le réseau et sur ses lieux (à vérifier, risque de double compte) : ${doubles.join(' ; ')}.`);
  log('');
}

// ---------------------------------------------------------------- comparaison des questionnaires
log('## Évolution du questionnaire', '');
for (let i = 1; i < annees.length; i++) {
  const a = annees[i - 1], b = annees[i];
  const da = dictionnaires[a], db = dictionnaires[b];
  if (!da || !db) continue;
  const ajouts = Object.keys(db).filter((c) => !(c in da));
  const retraits = Object.keys(da).filter((c) => !(c in db));
  const norm = (s) => String(s).replace(/20\d\d/g, '').replace(/\s+/g, ' ').trim();
  const changes = Object.keys(db).filter((c) => c in da && norm(da[c]) !== norm(db[c]));
  const utilises = new Set(Object.values(indicateurs).flatMap((ind) => Object.values(ind.source ?? {}).flatMap(codesDe)));
  log(`### ${a} → ${b}`, '',
    `- ${Object.keys(da).length} → ${Object.keys(db).length} variables ; ${Object.keys(db).length - ajouts.length} communes, ${retraits.length} retirées, ${ajouts.length} nouvelles.`,
    `- Retirées et utilisées par l'application : ${retraits.filter((c) => utilises.has(c)).join(', ') || 'aucune'}.`,
    `- Libellés modifiés pour un même code : ${changes.map((c) => `${c} (« ${da[c]} » → « ${db[c]} »)`).join(' ; ') || 'aucun'}.`,
    '', '<details><summary>Nouvelles variables</summary>', '',
    ...ajouts.map((c) => `- ${c} — ${db[c]}`), '', '</details>', '');
}

// ---------------------------------------------------------------- méta-données pour l'interface
const meta = {
  genere_le: new Date().toISOString(),
  annees: annees.filter((a) => fs.existsSync(path.join(DOSSIER_SORTIE, `${a}.json`))).map(Number),
  epci: epciLibelles,
  referentiel_reseau: [...referentiel.values()].some((r) => r.reseau_bg !== null),
  indicateurs: Object.fromEntries(Object.entries(indicateurs).map(([id, ind]) => [id, {
    ...ind,
    disponibilite: disponibilite[id] ?? {},
  }])),
  pages: config.pages,
  cartographies: config.cartographies,
};
fs.writeFileSync(path.join(DOSSIER_SORTIE, 'meta.json'), JSON.stringify(meta, null, 1));
fs.writeFileSync(path.join(RACINE, 'rapport-import.md'), rapport.join('\n'));
console.log(`Import terminé : ${meta.annees.join(', ')}. Rapport : rapport-import.md`);
