// Tableau de bord de la lecture publique en Gironde.
// Toutes les pages sont décrites dans config/indicateurs.json (copiée dans data/meta.json par l'import).

const $ = (s, el = document) => el.querySelector(s);
const nf = (d = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const pct = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, signDisplay: 'always' });

const etat = { page: 'general', annee: null, epci: '', commune: '', typologie: '', reseau: '', tri: null, recherche: '' };
let meta;
const donnees = {}; // année → établissements
let carte; // carte de l'écran { carte, fond, couche }

// ------------------------------------------------------------------ chargement
async function charger() {
  meta = await (await fetch('data/meta.json')).json();
  await Promise.all(meta.annees.map(async (a) => {
    donnees[a] = (await (await fetch(`data/${a}.json`)).json()).etablissements;
  }));
  lireAdresse();
  etat.annee ??= Math.max(...meta.annees);
  preparerInterface();
  afficher();
}

// ------------------------------------------------------------------ état ↔ adresse (liens partageables)
function lireAdresse() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('page')) etat.page = p.get('page');
  // Un filtre absent de l'adresse est un filtre vide (sinon un lien garderait le filtre précédent).
  for (const k of ['epci', 'commune', 'typologie', 'reseau']) etat[k] = p.get(k) ?? '';
  if (p.has('annee') && meta.annees.includes(Number(p.get('annee')))) etat.annee = Number(p.get('annee'));
  if (!meta.pages.some((pg) => pg.id === etat.page)) etat.page = meta.pages[0].id;
}
function ecrireAdresse() {
  const p = new URLSearchParams();
  for (const k of ['page', 'annee', 'epci', 'commune', 'typologie', 'reseau']) if (etat[k] !== '' && etat[k] != null) p.set(k, etat[k]);
  history.replaceState(null, '', `#${p}`);
}

// ------------------------------------------------------------------ sélection et agrégation
function selection(annee) {
  return (donnees[annee] ?? []).filter((e) =>
    (!etat.epci || e.epci === etat.epci) &&
    (!etat.commune || e.insee === etat.commune) &&
    (!etat.typologie || e.typologie === etat.typologie) &&
    (!etat.reseau || String(e.reseau_bg) === etat.reseau));
}

const disponible = (id, annee) => meta.indicateurs[id]?.disponibilite?.[annee] !== false;

/** Population dédoublonnée : une commune n'est comptée qu'une fois, quel que soit son nombre de lieux. */
function population(lignes) {
  const parCommune = new Map();
  for (const e of lignes) {
    const p = e.v.population;
    if (p == null) continue;
    const cle = e.insee ?? e.code;
    parCommune.set(cle, Math.max(parCommune.get(cle) ?? 0, p));
  }
  return parCommune.size ? [...parCommune.values()].reduce((a, b) => a + b, 0) : null;
}

/** Agrège un indicateur sur un ensemble de lignes. Renvoie { valeur, n, total, categories } ou null. */
function agreger(id, lignes, annee) {
  const ind = meta.indicateurs[id];
  if (!ind || !disponible(id, annee)) return null;
  switch (ind.agregation) {
    case 'population': {
      const v = population(lignes);
      return v == null ? null : { valeur: v };
    }
    case 'somme': {
      let s = 0, n = 0;
      for (const e of lignes) if (e.v[id] != null) { s += e.v[id]; n++; }
      return n ? { valeur: s, n } : null;
    }
    case 'moyenne': {
      let s = 0, n = 0;
      for (const e of lignes) if (e.v[id] != null) { s += e.v[id]; n++; }
      return n ? { valeur: s / n, n } : null;
    }
    case 'oui':
    case 'renseigne': {
      const repondants = lignes.filter((e) => e.v[id] != null);
      if (!repondants.length) return null;
      return { valeur: repondants.filter((e) => e.v[id] === 1).length, total: repondants.length };
    }
    case 'categorie': {
      const categories = {};
      for (const e of lignes) if (e.v[id]) categories[e.v[id]] = (categories[e.v[id]] ?? 0) + 1;
      return { categories };
    }
    case 'ratio': {
      const den = ind.denominateur;
      // Pour un rapport entre deux activités, on ne garde que les lignes où les deux sont renseignées.
      const base = den && den !== 'population'
        ? lignes.filter((e) => e.v[ind.numerateur] != null && e.v[den] != null)
        : lignes;
      const num = agreger(ind.numerateur, base, annee)?.valeur;
      const d = den ? agreger(den, base, annee)?.valeur : 1;
      if (num == null || !d) return null;
      return { valeur: (num / d) * (ind.facteur ?? 1) };
    }
  }
  return null;
}

/** Indicateurs de base dont dépend un indicateur (lui-même, ou les termes d'un ratio). */
function champsDe(id) {
  const ind = meta.indicateurs[id];
  if (ind.agregation !== 'ratio') return [id];
  return [ind.numerateur, ind.denominateur].filter(Boolean).flatMap(champsDe);
}

/** Évolution entre deux années sur les seuls établissements renseignés les deux fois. */
function evolution(id, lignes, lignesPrec, precedente) {
  const champs = champsDe(id);
  const complet = (e) => champs.every((c) => e.v[c] != null);
  const avant = new Map(lignesPrec.filter(complet).map((e) => [e.code, e]));
  const communs = lignes.filter((e) => complet(e) && avant.has(e.code));
  if (!communs.length) return null;
  const a = agreger(id, communs.map((e) => avant.get(e.code)), precedente)?.valeur;
  const b = agreger(id, communs, etat.annee)?.valeur;
  if (!a || b == null) return null;
  const taux = ((b - a) / a) * 100;
  return Number.isFinite(taux) ? { taux, n: communs.length } : null;
}

/** Valeur d'un indicateur pour une seule ligne (tableau). */
function valeurLigne(id, e, annee) {
  const ind = meta.indicateurs[id];
  if (!disponible(id, annee)) return undefined;
  if (ind.agregation === 'ratio') return agreger(id, [e], annee)?.valeur ?? null;
  return e.v[id] ?? null;
}

// ------------------------------------------------------------------ mise en forme
function formater(id, valeur) {
  const ind = meta.indicateurs[id];
  if (valeur == null) return '–';
  if (typeof valeur !== 'number') return ind.agregation === 'oui' || ind.agregation === 'renseigne' ? (valeur ? 'Oui' : 'Non') : valeur;
  if (ind.agregation === 'oui' || ind.agregation === 'renseigne') return valeur === 1 ? 'Oui' : 'Non';
  return nf(ind.decimales ?? (Math.abs(valeur) < 10 && valeur % 1 ? 1 : 0)).format(valeur);
}
const unite = (id) => meta.indicateurs[id]?.unite ?? '';
const echapper = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const libelleEpci = (code) => (meta.epci[code] ?? code ?? 'EPCI inconnu')
  .replace(/^Communauté de communes /i, 'CC ')
  .replace(/^Communauté d'agglomération /i, 'CA ');

// ------------------------------------------------------------------ interface fixe
function preparerInterface() {
  const liste = $('#liste-pages');
  liste.innerHTML = meta.pages.map((p) => `<li><a href="#page=${p.id}" data-page="${p.id}">${echapper(p.titre)}</a></li>`).join('');
  liste.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-page]');
    if (!a) return;
    ev.preventDefault();
    etat.page = a.dataset.page;
    etat.tri = null;
    if (matchMedia('(max-width: 860px)').matches) basculerMenu(false);
    afficher();
    $('#contenu').focus({ preventScroll: true });
    scrollTo({ top: 0 });
  });
  $('.bouton-menu').addEventListener('click', () => basculerMenu($('.bouton-menu').getAttribute('aria-expanded') !== 'true'));
  if (matchMedia('(max-width: 860px)').matches) basculerMenu(false);

  const f = $('.filtres');
  f.annee.innerHTML = [...meta.annees].reverse().map((a) => `<option value="${a}">${a}</option>`).join('');
  const epcis = Object.keys(meta.epci).map((c) => [c, libelleEpci(c)])
    .sort((a, b) => a[1].replace(/^(CC|CA) (de |du |des |de l'|d')?/i, '').localeCompare(b[1].replace(/^(CC|CA) (de |du |des |de l'|d')?/i, ''), 'fr'));
  f.epci.insertAdjacentHTML('beforeend', epcis.map(([c, l]) => `<option value="${c}">${echapper(l)}</option>`).join(''));
  if (!meta.referentiel_reseau) {
    const lab = $('.filtre-reseau');
    lab.title = 'Liste à fournir dans config/referentiel.csv';
    f.reseau.disabled = true;
    f.reseau.innerHTML = '<option value="">Liste non fournie</option>';
  }
  f.addEventListener('change', (ev) => {
    const champ = ev.target.name;
    etat[champ] = champ === 'annee' ? Number(ev.target.value) : ev.target.value;
    if (champ === 'epci') etat.commune = '';
    afficher();
  });
  $('.reinitialiser').addEventListener('click', () => {
    Object.assign(etat, { epci: '', commune: '', typologie: '', reseau: '', annee: Math.max(...meta.annees) });
    afficher();
  });
  $('.bloc-tableau input').addEventListener('input', (ev) => { etat.recherche = ev.target.value; afficherTableau(); });
  $('.exporter').addEventListener('click', exporterCsv);
  preparerExport();
}

function basculerMenu(ouvert) {
  $('.bouton-menu').setAttribute('aria-expanded', String(ouvert));
  $('#liste-pages').dataset.ferme = String(!ouvert);
}

function synchroniserFiltres() {
  const f = $('.filtres');
  f.annee.value = etat.annee;
  f.epci.value = etat.epci;
  f.typologie.value = etat.typologie;
  if (!f.reseau.disabled) f.reseau.value = etat.reseau;
  // Liste des communes de l'intercommunalité choisie (ou de toute la Gironde)
  const communes = new Map();
  for (const e of donnees[etat.annee]) if ((!etat.epci || e.epci === etat.epci) && e.insee) communes.set(e.insee, e.commune);
  f.commune.innerHTML = '<option value="">Toutes</option>' + [...communes].sort((a, b) => a[1].localeCompare(b[1], 'fr'))
    .map(([i, n]) => `<option value="${i}">${echapper(n)}</option>`).join('');
  if (!communes.has(etat.commune)) etat.commune = '';
  f.commune.value = etat.commune;
  for (const a of document.querySelectorAll('#liste-pages a')) {
    if (a.dataset.page === etat.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

// ------------------------------------------------------------------ rendu d'une page
const pageCourante = () => meta.pages.find((p) => p.id === etat.page);

function afficher() {
  synchroniserFiltres();
  ecrireAdresse();
  const page = pageCourante();
  const lignes = selection(etat.annee);
  document.title = `${page.titre} – NeoScribVisu`;
  $('.entete-page h1').textContent = page.titre;
  $('.perimetre').textContent = textePerimetre(lignes);
  afficherAvertissement();
  afficherChiffres(page, lignes);
  afficherCarte(page, lignes);
  afficherRepartition(page, lignes);
  afficherTerritoires(page, lignes);
  afficherTableau();
  afficherASavoir(page);
}
const nb = (n, un, plusieurs) => `${nf().format(n)} ${n > 1 ? plusieurs : un}`;

// ------------------------------------------------------------------ fragments HTML (écran et export PDF)
function texteNote(ind, interactif) {
  if (!ind.note) return '';
  return interactif ? ` <span class="note" title="${echapper(ind.note)}" tabindex="0" aria-label="Note : ${echapper(ind.note)}">ⓘ</span>` : ' *';
}

function htmlChiffres(page, lignes, interactif = true) {
  const precedente = meta.annees.filter((a) => a < etat.annee).at(-1);
  const lignesPrec = precedente ? selection(precedente) : null;
  return page.tuiles.map((id) => {
    const ind = meta.indicateurs[id];
    const note = texteNote(ind, interactif);
    if (!disponible(id, etat.annee)) {
      return `<div class="chiffre indisponible"><div class="chiffre-valeur">Non collecté en ${etat.annee}</div>
        <div class="chiffre-libelle">${echapper(ind.libelle)}${note}</div></div>`;
    }
    const r = agreger(id, lignes, etat.annee);
    let valeur, detail = '';
    if (ind.agregation === 'oui' || ind.agregation === 'renseigne') {
      valeur = r ? nf().format(r.valeur) : '–';
      detail = r ? `sur ${nb(r.total, 'répondant', 'répondants')}` : 'aucune réponse';
    } else {
      valeur = formater(id, r?.valeur);
      if (r?.n != null) detail = ind.agregation === 'moyenne'
        ? (r.n > 1 ? `moyenne de ${nf().format(r.n)} lieux` : '')
        : nb(r.n, 'réponse', 'réponses');
    }
    // Évolution à périmètre constant : seuls les établissements qui ont répondu les deux années comptent,
    // sinon une non-réponse se lit comme une baisse.
    if (lignesPrec && r?.valeur != null && disponible(id, precedente) && ind.agregation !== 'categorie') {
      const ev = evolution(id, lignes, lignesPrec, precedente);
      if (ev) {
        detail += `${detail ? ', ' : ''}<span class="${ev.taux >= 0 ? 'evolution-hausse' : 'evolution-baisse'}" title="Calculé sur les ${ev.n} établissements ayant répondu en ${precedente} et en ${etat.annee}">${pct.format(ev.taux)} % sur un an</span>`;
      }
    }
    // Repère (ex. recommandation SLL) : la valeur passe en vert si elle l'atteint, en rouge sinon.
    const rep = repere(id, lignes, r);
    const classeValeur = rep ? (rep.atteint ? ' valeur-atteinte' : ' valeur-insuffisante') : '';
    return `<div class="chiffre"><div class="chiffre-valeur${classeValeur}">${valeur}${unite(id) && r ? `<span class="chiffre-unite">${unite(id)}</span>` : ''}</div>
      <div class="chiffre-libelle">${echapper(ind.libelle)}${note}</div>
      ${rep?.html ?? ''}
      ${detail ? `<div class="chiffre-detail">${detail}</div>` : ''}</div>`;
  }).join('');
}

/** Valeur de comparaison affichée sous une tuile (ex. surface recommandée par le SLL),
 *  calculée sur les seuls établissements qui renseignent l'indicateur principal. */
function repere(id, lignes, r) {
  const ind = meta.indicateurs[id];
  if (!ind.repere || r?.valeur == null || !disponible(ind.repere, etat.annee)) return null;
  const base = lignes.filter((e) => e.v[id] != null);
  const ref = agreger(ind.repere, base, etat.annee)?.valeur;
  if (!ref) return null;
  const taux = Math.round((r.valeur / ref) * 100);
  const atteint = r.valeur >= ref;
  return {
    atteint,
    html: `<div class="chiffre-repere">${echapper(ind.repere_libelle ?? meta.indicateurs[ind.repere].libelle)} : ${formater(ind.repere, ref)}${unite(ind.repere) ? ` ${unite(ind.repere)}` : ''}, soit <span class="${atteint ? 'repere-atteint' : 'repere-insuffisant'}">${nf().format(taux)} %</span> atteints</div>`,
  };
}

function barres(items, max, formatValeur, classe = () => '', style = () => '') {
  return items.map((x) => `
    <div class="barre${classe(x)}"><span class="barre-nom" title="${echapper(x.nom)}">${echapper(x.nom)}</span>
    <span class="barre-piste"><span class="barre-remplie" style="display:block;width:${(x.v / max) * 82}%${style(x)}"></span>
    <span class="barre-valeur" style="left:${(x.v / max) * 82}%">${formatValeur(x.v)}</span></span></div>`).join('');
}

/** Barres par intercommunalité, ou par commune quand une intercommunalité est choisie. */
function territoires(page, lignes) {
  const parCommune = Boolean(etat.epci);
  const groupes = new Map();
  for (const e of lignes) {
    const cle = parCommune ? e.insee : e.epci;
    if (!groupes.has(cle)) groupes.set(cle, { nom: parCommune ? e.commune : libelleEpci(e.epci), lignes: [] });
    groupes.get(cle).lignes.push(e);
  }
  const series = (page.graphique ?? []).map((id) => {
    const ind = meta.indicateurs[id];
    if (!disponible(id, etat.annee)) return `<div class="serie"><h3>${echapper(ind.libelle)}</h3><p class="chiffre-detail">Non collecté en ${etat.annee}.</p></div>`;
    const valeurs = [...groupes].map(([cle, g]) => ({ cle, nom: g.nom, v: agreger(id, g.lignes, etat.annee)?.valeur ?? 0 }))
      .filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    const max = Math.max(...valeurs.map((x) => x.v), 1);
    return `<div class="serie"><h3>${echapper(ind.libelle)}${unite(id) ? ` (${unite(id)})` : ''}</h3>${
      barres(valeurs, max, (v) => formater(id, v), (x) => (parCommune && x.cle === etat.commune ? ' selection' : '')) || '<p class="chiffre-detail">Aucune donnée.</p>'}</div>`;
  });
  return { titre: parCommune ? 'Par commune' : 'Par intercommunalité', html: series.join(''), visible: series.length > 0 && groupes.size > 1 };
}

function repartition(page, lignes) {
  if (!page.repartition) return null;
  let titre, comptes;
  if (page.repartition === 'typologie') {
    titre = 'Lieux de lecture par typologie';
    comptes = {};
    for (const e of lignes) if (e.type === 'lieu' && e.typologie) comptes[e.typologie] = (comptes[e.typologie] ?? 0) + 1;
    comptes = Object.entries(comptes).sort();
  } else {
    titre = meta.indicateurs[page.repartition].libelle;
    comptes = Object.entries(agreger(page.repartition, lignes, etat.annee)?.categories ?? {}).sort((a, b) => b[1] - a[1]);
  }
  const typo = page.repartition === 'typologie';
  const items = comptes.map(([k, n]) => ({ cle: k, nom: typo ? `Typologie ${k}` : k, v: n }));
  const max = Math.max(...items.map((x) => x.v), 1);
  return { titre, html: barres(items, max, (v) => nf().format(v), () => '', (x) => (typo ? `;background:var(--typo-${x.cle.toLowerCase()})` : '')) || '<p class="chiffre-detail">Aucune donnée.</p>' };
}

function trierLignes(lignes, tri) {
  const cle = (e) => {
    if (!tri || tri.col === 'nom') return `${e.commune} ${e.nom}`;
    if (tri.col === 'epci') return libelleEpci(e.epci);
    if (tri.col === 'typologie') return e.typologie ?? '';
    const v = valeurLigne(tri.col, e, etat.annee);
    return v == null ? -Infinity : v;
  };
  return [...lignes].sort((a, b) => {
    const x = cle(a), y = cle(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr');
    return tri?.desc ? -c : c;
  });
}

function htmlTableau(cols, lignes, tri, interactif = true) {
  const entete = (col, lib, texte) => {
    if (!interactif) return `<th class="${texte ? 'texte' : ''}">${echapper(lib)}</th>`;
    const actif = tri?.col === col;
    const sens = actif ? (tri.desc ? 'descending' : 'ascending') : 'none';
    return `<th class="${texte ? 'texte' : ''}" aria-sort="${sens}"><button type="button" data-col="${col}">${echapper(lib)}${actif ? (tri.desc ? ' ▼' : ' ▲') : ''}</button></th>`;
  };
  return `<thead><tr>${entete('nom', 'Établissement', true)}${entete('epci', 'Intercommunalité', true)}${entete('typologie', 'Typo.', true)}
    ${cols.map((c) => entete(c, meta.indicateurs[c].libelle + (unite(c) ? ` (${unite(c)})` : ''))).join('')}</tr></thead>
    <tbody>${lignes.map((e) => `<tr class="${e.type}"><td title="${echapper(e.nom)}">${echapper(e.commune)} – ${echapper(e.nom)}</td>
      <td class="texte">${echapper(libelleEpci(e.epci))}</td><td class="texte td-typo">${e.typologie ? `<span class="pastille" style="background:var(--typo-${e.typologie.toLowerCase()})"></span>${e.typologie}` : ''}</td>
      ${cols.map((c) => {
        const v = valeurLigne(c, e, etat.annee);
        if (v === undefined) return '<td class="vide">non collecté</td>';
        return `<td class="${v == null ? 'vide' : ''}${meta.indicateurs[c].agregation === 'categorie' ? ' texte' : ''}">${formater(c, v)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
}

const NOTES_GENERALES = [
  'Les sommes additionnent les lieux de lecture et, pour les communes multi-sites, la ligne « réseau » où une partie des données (personnel, budgets) est saisie.',
  'La population n\'est comptée qu\'une fois par commune, même si la commune compte plusieurs lieux de lecture.',
  'Les moyennes (entrées par emprunteur, livres par emprunteur, dépense par habitant) divisent des totaux, sur les seuls établissements qui renseignent les deux valeurs.',
  'Les évolutions sur un an sont calculées à périmètre constant : seuls les établissements qui ont renseigné l\'indicateur les deux années sont comparés. Les totaux affichés, eux, dépendent du nombre de répondants de l\'année.',
  'Le questionnaire change selon les années : un indicateur absent est signalé « non collecté », jamais remplacé par zéro.',
];
function notesPour(pages) {
  const notes = [...NOTES_GENERALES];
  for (const page of pages) {
    for (const id of [...page.tuiles, ...(page.graphique ?? [])]) {
      const ind = meta.indicateurs[id];
      if (ind.note && !notes.includes(`${ind.libelle} : ${ind.note}`)) notes.push(`${ind.libelle} : ${ind.note}`);
    }
  }
  return notes;
}

function textePerimetre(lignes) {
  const nbLieux = lignes.filter((e) => e.type === 'lieu').length;
  const nbReseaux = lignes.length - nbLieux;
  const lieu = etat.commune ? lignes[0]?.commune : etat.epci ? libelleEpci(etat.epci) : 'Gironde';
  return `${lieu}, données ${etat.annee} : ${nb(nbLieux, 'lieu de lecture', 'lieux de lecture')}`
    + (nbReseaux ? ` et ${nb(nbReseaux, 'réseau', 'réseaux')} multi-sites` : '')
    + (etat.typologie ? `, typologie ${etat.typologie}` : '')
    + (etat.reseau ? `, ${etat.reseau === '1' ? 'membres' : 'hors'} du réseau biblio.gironde` : '') + '.';
}

function texteProvisoire() {
  const nonValides = donnees[etat.annee].filter((e) => e.avancement && e.avancement !== 'Validé');
  if (!nonValides.length) return '';
  const enCours = nonValides.filter((e) => e.avancement === 'En cours').length;
  return `Données ${etat.annee} provisoires : ${nonValides.length} fiches ne sont pas encore validées`
    + (enCours ? `, dont ${enCours} encore en cours de saisie` : '') + '. Les chiffres peuvent évoluer.';
}

// ------------------------------------------------------------------ rendu à l'écran
function afficherAvertissement() {
  const texte = texteProvisoire();
  const el = $('.avertissement');
  el.hidden = !texte;
  el.textContent = texte;
}

function afficherChiffres(page, lignes) {
  $('.chiffres').innerHTML = htmlChiffres(page, lignes);
}

function afficherTerritoires(page, lignes) {
  const t = territoires(page, lignes);
  $('.bloc-territoires h2').textContent = t.titre;
  $('.territoires').innerHTML = t.html;
  $('.bloc-territoires').hidden = !t.visible;
}

function afficherRepartition(page, lignes) {
  const bloc = $('.bloc-repartition');
  const r = repartition(page, lignes);
  bloc.hidden = !r;
  if (!r) return;
  $('h2', bloc).textContent = r.titre;
  $('.repartition').innerHTML = r.html;
}

const couleurTypo = (t) => getComputedStyle(document.documentElement).getPropertyValue(`--typo-${(t ?? 'e').toLowerCase()}`).trim() || '#888';
const legendeCarte = (points, lignes) => ['A', 'B', 'C', 'D', 'E'].map((t) => `<span><span class="pastille" style="background:var(--typo-${t.toLowerCase()})"></span>Typologie ${t}</span>`).join('')
  + `<span>${nf().format(points.length)} lieux localisés sur ${nf().format(lignes.filter((e) => e.type === 'lieu').length)}</span>`;

/** Dessine les lieux de lecture sur une carte Leaflet. Renvoie la couche de fond (pour attendre son chargement). */
// Fonds de carte : plan OpenStreetMap, ou découpage communal (contours ADEME, fichier généré par npm run contours).
const FONDS = { plan: 'Plan (OpenStreetMap)', communes: 'Découpage communal' };
const URL_COMMUNES = 'data/communes-33.geojson';
let promesseCommunes;
const chargerCommunes = () => (promesseCommunes ??= fetch(URL_COMMUNES)
  .then((r) => { if (!r.ok) throw new Error(`fichier des contours introuvable (${r.status})`); return r.json(); })
  .catch((err) => { promesseCommunes = null; throw err; }));

function fondMemorise() {
  try { return FONDS[localStorage.getItem('neoscribvisu-fond')] ? localStorage.getItem('neoscribvisu-fond') : 'plan'; } catch { return 'plan'; }
}

function dessinerCarte(conteneur, options = {}) {
  const m = L.map(conteneur, { scrollWheelZoom: false, zoomControl: !options.statique, attributionControl: true, ...(options.statique ? { dragging: false, zoomAnimation: false, fadeAnimation: false, zoomSnap: 0.25 } : {}) });
  m.createPane('communes').style.zIndex = 350; // sous les points (overlayPane = 400)
  const c = { carte: m, couche: L.layerGroup().addTo(m), communesSelection: new Set(), communeChoisie: '', epciChoisi: '' };
  c.plan = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© contributeurs OpenStreetMap' });
  c.communes = L.geoJSON(null, {
    pane: 'communes',
    attribution: 'Contours des communes : ADEME',
    style: (f) => styleCommune(c, f),
    onEachFeature: (f, couche) => {
      couche.bindTooltip(f.properties.nom, { sticky: true, direction: 'top' });
      // Un clic sur une commune qui a un lieu de lecture ouvre sa fiche.
      if (!options.statique) couche.on('click', () => {
        if (!donnees[etat.annee].some((e) => e.insee === f.properties.code)) return;
        etat.epci = '';
        etat.commune = f.properties.code;
        afficher();
      });
    },
  });
  if (!options.statique) {
    L.control.layers({ [FONDS.plan]: c.plan, [FONDS.communes]: c.communes }, null, { collapsed: false, position: 'topright' }).addTo(m);
    m.on('baselayerchange', (ev) => {
      const fond = ev.layer === c.communes ? 'communes' : 'plan';
      try { localStorage.setItem('neoscribvisu-fond', fond); } catch { /* stockage indisponible */ }
      if (fond === 'communes') remplirCommunes(c);
    });
  }
  return c;
}

/** Commune en gris clair ; teintée si elle a un lieu de lecture dans la sélection ; contour accentué si choisie. */
function styleCommune(c, f) {
  const code = f.properties.code;
  const horsPerimetre = c.epciChoisi && f.properties.codeEpci !== c.epciChoisi;
  const choisie = code === c.communeChoisie;
  const dansEpci = c.epciChoisi && !horsPerimetre;
  return {
    color: choisie ? '#8c2f4b' : dansEpci ? '#3f4d55' : '#7d8a92',
    weight: choisie ? 2.5 : dansEpci ? 1.1 : 0.7,
    fillColor: c.communesSelection.has(code) ? '#cfe3e1' : '#ffffff',
    fillOpacity: horsPerimetre ? 0.35 : 1,
    opacity: horsPerimetre ? 0.35 : 1,
  };
}

/** Charge les contours si besoin et les affiche. */
async function remplirCommunes(c) {
  if (c.communes.getLayers().length) return;
  const statut = (t) => { if (c.statut) c.statut.textContent = t; };
  statut('Chargement du découpage communal…');
  try {
    c.communes.addData(await chargerCommunes());
    c.communes.setStyle((f) => styleCommune(c, f));
    statut('');
  } catch (err) {
    statut(`Le découpage communal n'a pas pu être chargé (${err.message}). Le plan OpenStreetMap est affiché à la place.`);
    throw err;
  }
}

/** Affiche le fond demandé ; renvoie une promesse résolue quand il est chargé (pour l'impression). */
function choisirFond(c, fond) {
  const autre = fond === 'communes' ? c.plan : c.communes;
  const actif = fond === 'communes' ? c.communes : c.plan;
  if (c.carte.hasLayer(autre)) c.carte.removeLayer(autre);
  if (!c.carte.hasLayer(actif)) actif.addTo(c.carte);
  if (fond === 'communes') return remplirCommunes(c).catch(() => choisirFond(c, 'plan'));
  return new Promise((resoudre) => {
    if (!c.plan.isLoading?.()) setTimeout(resoudre, 300);
    c.plan.once('load', resoudre);
  });
}

function placerPoints(c, lignes, couleurs) {
  c.couche.clearLayers();
  c.communesSelection = new Set(lignes.map((e) => e.insee).filter(Boolean));
  c.communeChoisie = etat.commune;
  c.epciChoisi = etat.epci;
  c.communes.setStyle((f) => styleCommune(c, f));
  const points = lignes.filter((e) => e.type === 'lieu' && e.lat && e.lon);
  for (const e of points) {
    L.circleMarker([e.lat, e.lon], { radius: 6, weight: 1, color: '#1e2a33', fillColor: couleurs(e.typologie), fillOpacity: .9 })
      .bindPopup(`<strong>${echapper(e.nom)}</strong><br>${echapper(e.commune)}<br>Typologie ${e.typologie ?? '–'}`)
      .addTo(c.couche);
  }
  if (points.length) c.carte.fitBounds(points.map((e) => [e.lat, e.lon]), { padding: [20, 20], maxZoom: 13, animate: false });
  else c.carte.setView([44.85, -0.55], 8, { animate: false });
  return points;
}

function afficherCarte(page, lignes) {
  const bloc = $('.bloc-carte');
  if (!page.carte || !window.L) { bloc.hidden = true; return; }
  bloc.hidden = false;
  if (!carte) {
    carte = dessinerCarte('carte');
    carte.statut = $('.etat-carte');
    choisirFond(carte, fondMemorise());
  }
  const points = placerPoints(carte, lignes, couleurTypo);
  setTimeout(() => carte.carte.invalidateSize(), 0);
  $('.legende-carte').innerHTML = legendeCarte(points, lignes);
}

// ---- tableau détaillé
function colonnesTableau() {
  return pageCourante().tableau ?? [];
}
function lignesTableau() {
  const q = etat.recherche.trim().toLowerCase();
  const lignes = selection(etat.annee).filter((e) => !q || `${e.nom} ${e.commune}`.toLowerCase().includes(q));
  return { cols: colonnesTableau(), lignes: trierLignes(lignes, etat.tri) };
}
function afficherTableau() {
  const { cols, lignes } = lignesTableau();
  const table = $('.bloc-tableau table');
  table.innerHTML = htmlTableau(cols, lignes, etat.tri);
  table.onclick = (ev) => {
    const b = ev.target.closest('button[data-col]');
    if (!b) return;
    const col = b.dataset.col;
    const numerique = !['nom', 'epci', 'typologie'].includes(col);
    etat.tri = etat.tri?.col === col ? { col, desc: !etat.tri.desc } : { col, desc: numerique };
    afficherTableau();
  };
}

function exporterCsv() {
  const { cols, lignes } = lignesTableau();
  const cellule = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const tete = ['Code', 'Établissement', 'Commune', 'Type', 'Intercommunalité', 'Typologie', ...cols.map((c) => meta.indicateurs[c].libelle)];
  const corps = lignes.map((e) => [e.code, e.nom, e.commune, e.type, libelleEpci(e.epci), e.typologie,
    ...cols.map((c) => {
      const v = valeurLigne(c, e, etat.annee);
      return typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : (v ?? '');
    })]);
  const csv = '﻿' + [tete, ...corps].map((l) => l.map(cellule).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${pageCourante().id}-${etat.annee}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function afficherASavoir(page) {
  $('.a-savoir ul').innerHTML = notesPour([page]).map((n) => `<li>${echapper(n)}</li>`).join('');
}

// ------------------------------------------------------------------ export PDF (A4 paysage, via l'impression du navigateur)
const ELEMENTS_EXPORT = [
  { id: 'chiffres', libelle: 'Chiffres clés', defaut: true },
  { id: 'carte', libelle: 'Carte des lieux de lecture (page Général)', defaut: true },
  { id: 'repartition', libelle: 'Répartitions (typologie, SIGB)', defaut: true },
  { id: 'graphiques', libelle: 'Graphiques par territoire', defaut: true },
  { id: 'tableau', libelle: 'Tableau par établissement', defaut: false },
];
const COMPLEMENTS_EXPORT = [
  { id: 'garde', libelle: 'Page de garde (titre, périmètre, date)', defaut: true },
  { id: 'methode', libelle: 'Méthode et limites', defaut: true },
];
// Couleurs officielles des typologies (A : 80,208,112 · B : 76,199,219 · C : 251,188,50 · D : 251,136,39 · E : 223,72,36)
const COULEURS_IMPRESSION = { a: '#50d070', b: '#4cc7db', c: '#fbbc32', d: '#fb8827', e: '#df4824' };
const CLE_CHOIX = 'neoscribvisu-export';

function choixMemorises() {
  try { return JSON.parse(localStorage.getItem(CLE_CHOIX)) ?? {}; } catch { return {}; }
}

function ouvrirExport() {
  const dlg = $('#dialogue-export');
  const memo = choixMemorises();
  const coche = (groupe, id, defaut) => (memo[groupe]?.includes(id) ?? defaut) ? 'checked' : '';
  $('.export-pages', dlg).innerHTML = meta.pages.map((p) => `<label><input type="checkbox" name="page" value="${p.id}" ${p.id === etat.page ? 'checked' : ''}> ${echapper(p.titre)}</label>`).join('');
  const nbLignes = selection(etat.annee).length;
  $('.export-elements', dlg).innerHTML = ELEMENTS_EXPORT.map((e) => `<label><input type="checkbox" name="element" value="${e.id}" ${coche('elements', e.id, e.defaut)}> ${echapper(e.libelle)}${e.id === 'tableau' ? ` <span class="aide">${nf().format(nbLignes)} lignes par page cochée, soit plusieurs feuilles</span>` : ''}</label>`).join('');
  $('.export-complements', dlg).innerHTML = COMPLEMENTS_EXPORT.map((e) => `<label><input type="checkbox" name="complement" value="${e.id}" ${coche('complements', e.id, e.defaut)}> ${echapper(e.libelle)}</label>`).join('');
  $('.export-perimetre', dlg).textContent = textePerimetre(selection(etat.annee));
  $('.export-erreur', dlg).hidden = true;
  dlg.showModal();
}

function lireChoix(form) {
  const valeurs = (nom) => [...form.querySelectorAll(`input[name="${nom}"]:checked`)].map((i) => i.value);
  return { pages: valeurs('page'), elements: valeurs('element'), complements: valeurs('complement') };
}

async function genererPdf(choix) {
  const lignes = selection(etat.annee);
  const pages = meta.pages.filter((p) => choix.pages.includes(p.id));
  const avec = (id) => choix.elements.includes(id);
  const perimetre = textePerimetre(lignes);
  const provisoire = texteProvisoire();
  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const sections = [];

  if (choix.complements.includes('garde')) {
    sections.push(`<section class="imp-garde">
      <p class="imp-marque">NeoScribVisu</p>
      <h1>Lecture publique en Gironde</h1>
      <p class="imp-perimetre">${echapper(perimetre)}</p>
      ${provisoire ? `<p class="imp-avertissement">${echapper(provisoire)}</p>` : ''}
      <h2>Contenu</h2>
      <ol class="imp-sommaire">${pages.map((p) => `<li>${echapper(p.titre)}</li>`).join('')}${choix.complements.includes('methode') ? '<li>Méthode et limites</li>' : ''}</ol>
      <p class="imp-source">Édité le ${date}. Source : enquête annuelle sur les bibliothèques des collectivités territoriales, Service du livre et de la lecture, ministère de la Culture.</p>
    </section>`);
  }

  const cartes = [];
  pages.forEach((page, i) => {
    const blocs = [`<header class="imp-entete"><h1>${echapper(page.titre)}</h1><p>${echapper(perimetre)}</p></header>`];
    if (avec('chiffres')) blocs.push(`<div class="chiffres">${htmlChiffres(page, lignes, false)}</div>`);
    if (avec('carte') && page.carte && window.L) {
      cartes.push(`imp-carte-${i}`);
      blocs.push(`<div class="imp-bloc imp-bloc-carte"><h2>Carte des lieux de lecture</h2><div class="imp-carte" id="imp-carte-${i}"></div><p class="legende-carte" data-legende="imp-carte-${i}"></p></div>`);
    }
    const r = avec('repartition') ? repartition(page, lignes) : null;
    if (r) blocs.push(`<div class="imp-bloc"><h2>${echapper(r.titre)}</h2><div class="repartition">${r.html}</div></div>`);
    if (avec('graphiques')) {
      const t = territoires(page, lignes);
      if (t.visible) blocs.push(`<div class="imp-bloc"><h2>${t.titre}</h2><div class="territoires">${t.html}</div></div>`);
    }
    if (avec('tableau')) {
      const tri = page.id === etat.page ? etat.tri : null;
      blocs.push(`<div class="imp-bloc imp-bloc-tableau"><h2>Détail par établissement</h2><table>${htmlTableau(page.tableau ?? [], trierLignes(lignes, tri), tri, false)}</table></div>`);
    }
    const notes = page.tuiles.some((id) => meta.indicateurs[id].note) && avec('chiffres')
      ? `<p class="imp-renvoi">* Voir « Méthode et limites ».</p>` : '';
    sections.push(`<section class="imp-page">${blocs.join('')}${notes}</section>`);
  });

  if (choix.complements.includes('methode')) {
    sections.push(`<section class="imp-page imp-methode"><header class="imp-entete"><h1>Méthode et limites</h1></header>
      <ul>${notesPour(pages).map((n) => `<li>${echapper(n)}</li>`).join('')}</ul></section>`);
  }

  const zone = $('#impression');
  zone.innerHTML = sections.join('');
  // Pied de page imprimé : périmètre, date et numéro de page.
  const pied = `NeoScribVisu – ${perimetre.split(':')[0]} – ${date}`.replace(/["\\]/g, '');
  $('#style-impression').textContent = `@page { @bottom-left { content: "${pied}"; font: 7.5pt "Public Sans", sans-serif; color: #5f6b74; } @bottom-right { content: "Page " counter(page) " sur " counter(pages); font: 7.5pt "Public Sans", sans-serif; color: #5f6b74; } }`;

  // Les cartes sont dessinées hors écran à la taille de la page, puis on attend leurs tuiles.
  const instances = [];
  await Promise.all(cartes.map((id) => new Promise((resoudre) => {
    const c = dessinerCarte(id, { statique: true });
    instances.push(c.carte);
    const points = placerPoints(c, lignes, (t) => COULEURS_IMPRESSION[(t ?? 'e').toLowerCase()] ?? '#888');
    $(`[data-legende="${id}"]`).innerHTML = legendeCarte(points, lignes);
    // Même fond que celui choisi à l'écran ; on attend qu'il soit chargé (6 s au plus).
    const fin = setTimeout(resoudre, 6000);
    choisirFond(c, fondMemorise()).then(() => { clearTimeout(fin); setTimeout(resoudre, 200); });
  })));

  const nettoyer = () => {
    instances.forEach((m) => m.remove());
    zone.innerHTML = '';
    removeEventListener('afterprint', nettoyer);
  };
  addEventListener('afterprint', nettoyer);
  document.title = `NeoScribVisu ${etat.annee} – ${perimetre.split(',')[0]}`;
  print();
  document.title = `${pageCourante().titre} – NeoScribVisu`;
}

function preparerExport() {
  const dlg = $('#dialogue-export');
  $('.ouvrir-export').addEventListener('click', ouvrirExport);
  $('.export-toutes', dlg).addEventListener('click', () => dlg.querySelectorAll('input[name="page"]').forEach((i) => { i.checked = true; }));
  $('.export-aucune', dlg).addEventListener('click', () => dlg.querySelectorAll('input[name="page"]').forEach((i) => { i.checked = false; }));
  $('.export-annuler', dlg).addEventListener('click', () => dlg.close());
  $('form', dlg).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const choix = lireChoix(ev.target);
    const erreur = $('.export-erreur', dlg);
    if (!choix.pages.length) { erreur.textContent = 'Cochez au moins une page.'; erreur.hidden = false; return; }
    if (!choix.elements.length) { erreur.textContent = 'Cochez au moins un élément à intégrer.'; erreur.hidden = false; return; }
    try { localStorage.setItem(CLE_CHOIX, JSON.stringify({ elements: choix.elements, complements: choix.complements })); } catch { /* stockage indisponible */ }
    const bouton = $('button[type="submit"]', dlg);
    bouton.disabled = true;
    bouton.textContent = 'Préparation…';
    try {
      await genererPdf(choix);
      dlg.close();
    } finally {
      bouton.disabled = false;
      bouton.textContent = 'Créer le PDF';
    }
  });
}

addEventListener('hashchange', () => { lireAdresse(); afficher(); });
charger().catch((err) => {
  $('main').innerHTML = `<h1>Données introuvables</h1><p>Lancez <code>npm run import</code> pour générer les données, puis rechargez la page. (${echapper(err.message)})</p>`;
});
