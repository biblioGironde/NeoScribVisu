// Tableau de bord de la lecture publique en Gironde.
// Toutes les pages sont décrites dans config/indicateurs.json (copiée dans data/meta.json par l'import).

const $ = (s, el = document) => el.querySelector(s);
const nf = (d = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const pct = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, signDisplay: 'always' });

const etat = { page: 'general', annee: null, epci: '', commune: '', typologie: '', reseau: '', tri: null, recherche: '' };
let meta;
const donnees = {}; // année → établissements
let carte, coucheCarte;

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
  for (const k of ['page', 'epci', 'commune', 'typologie', 'reseau']) if (p.has(k)) etat[k] = p.get(k);
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
  document.title = `${page.titre} – Lecture publique en Gironde`;
  $('.entete-page h1').textContent = page.titre;
  const nbLieux = lignes.filter((e) => e.type === 'lieu').length;
  const nbReseaux = lignes.length - nbLieux;
  const perimetre = etat.commune ? lignes[0]?.commune : etat.epci ? libelleEpci(etat.epci) : 'Gironde';
  $('.perimetre').textContent = `${perimetre}, données ${etat.annee} : ${nb(nbLieux, 'lieu de lecture', 'lieux de lecture')}`
    + (nbReseaux ? ` et ${nb(nbReseaux, 'réseau', 'réseaux')} multi-sites` : '') + (etat.typologie ? `, typologie ${etat.typologie}` : '') + '.';
  afficherAvertissement();
  afficherChiffres(page, lignes);
  afficherCarte(page, lignes);
  afficherRepartition(page, lignes);
  afficherTerritoires(page, lignes);
  afficherTableau();
  afficherASavoir(page);
}
const nb = (n, un, plusieurs) => `${nf().format(n)} ${n > 1 ? plusieurs : un}`;

function afficherAvertissement() {
  const toutes = donnees[etat.annee];
  const nonValides = toutes.filter((e) => e.avancement && e.avancement !== 'Validé');
  const el = $('.avertissement');
  if (!nonValides.length) { el.hidden = true; return; }
  const enCours = nonValides.filter((e) => e.avancement === 'En cours').length;
  el.hidden = false;
  el.textContent = `Données ${etat.annee} provisoires : ${nonValides.length} fiches ne sont pas encore validées`
    + (enCours ? `, dont ${enCours} encore en cours de saisie` : '') + '. Les chiffres peuvent évoluer.';
}

function afficherChiffres(page, lignes) {
  const precedente = meta.annees.filter((a) => a < etat.annee).at(-1);
  const lignesPrec = precedente ? selection(precedente) : null;
  $('.chiffres').innerHTML = page.tuiles.map((id) => {
    const ind = meta.indicateurs[id];
    const note = ind.note ? ` <span class="note" title="${echapper(ind.note)}" tabindex="0" aria-label="Note : ${echapper(ind.note)}">ⓘ</span>` : '';
    if (!disponible(id, etat.annee)) {
      return `<div class="chiffre indisponible"><div class="chiffre-valeur">Non collecté en ${etat.annee}</div>
        <div class="chiffre-libelle">${echapper(ind.libelle)}${note}</div></div>`;
    }
    const r = agreger(id, lignes, etat.annee);
    let valeur, detail = '';
    if (ind.agregation === 'oui' || ind.agregation === 'renseigne') {
      valeur = r ? nf().format(r.valeur) : '–';
      detail = r ? `sur ${nf().format(r.total)} répondants` : 'aucune réponse';
    } else {
      valeur = formater(id, r?.valeur);
      if (r?.n != null) detail = `${nf().format(r.n)} réponses`;
    }
    // Évolution à périmètre constant : seuls les établissements qui ont répondu les deux années comptent,
    // sinon une non-réponse se lit comme une baisse.
    if (lignesPrec && r?.valeur != null && disponible(id, precedente) && ind.agregation !== 'categorie') {
      const ev = evolution(id, lignes, lignesPrec, precedente);
      if (ev) {
        detail += `${detail ? ', ' : ''}<span class="${ev.taux >= 0 ? 'evolution-hausse' : 'evolution-baisse'}" title="Calculé sur les ${ev.n} établissements ayant répondu en ${precedente} et en ${etat.annee}">${pct.format(ev.taux)} % sur un an</span>`;
      }
    }
    return `<div class="chiffre"><div class="chiffre-valeur">${valeur}${unite(id) && r ? `<span class="chiffre-unite">${unite(id)}</span>` : ''}</div>
      <div class="chiffre-libelle">${echapper(ind.libelle)}${note}</div>
      ${detail ? `<div class="chiffre-detail">${detail}</div>` : ''}</div>`;
  }).join('');
}

// ---- barres par territoire : par intercommunalité, ou par commune quand une intercommunalité est choisie
function afficherTerritoires(page, lignes) {
  const parCommune = Boolean(etat.epci);
  $('.bloc-territoires h2').textContent = parCommune ? 'Par commune' : 'Par intercommunalité';
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
    return `<div class="serie"><h3>${echapper(ind.libelle)}${unite(id) ? ` (${unite(id)})` : ''}</h3>${valeurs.map((x) => `
      <div class="barre${parCommune && x.cle === etat.commune ? ' selection' : ''}"><span class="barre-nom" title="${echapper(x.nom)}">${echapper(x.nom)}</span>
      <span class="barre-piste"><span class="barre-remplie" style="display:block;width:${(x.v / max) * 82}%"></span>
      <span class="barre-valeur" style="left:${(x.v / max) * 82}%">${formater(id, x.v)}</span></span></div>`).join('') || '<p class="chiffre-detail">Aucune donnée.</p>'}</div>`;
  });
  $('.territoires').innerHTML = series.join('');
  $('.bloc-territoires').hidden = !series.length || groupes.size < 2;
}

function afficherRepartition(page, lignes) {
  const bloc = $('.bloc-repartition');
  if (!page.repartition) { bloc.hidden = true; return; }
  bloc.hidden = false;
  let titre, comptes;
  if (page.repartition === 'typologie') {
    titre = 'Lieux de lecture par typologie';
    comptes = {};
    for (const e of lignes) if (e.type === 'lieu' && e.typologie) comptes[e.typologie] = (comptes[e.typologie] ?? 0) + 1;
    comptes = Object.fromEntries(Object.entries(comptes).sort());
  } else {
    titre = meta.indicateurs[page.repartition].libelle;
    comptes = agreger(page.repartition, lignes, etat.annee)?.categories ?? {};
    comptes = Object.fromEntries(Object.entries(comptes).sort((a, b) => b[1] - a[1]));
  }
  $('h2', bloc).textContent = titre;
  const max = Math.max(...Object.values(comptes), 1);
  $('.repartition').innerHTML = Object.entries(comptes).map(([k, n]) => `
    <div class="barre"><span class="barre-nom">${page.repartition === 'typologie' ? `Typologie ${k}` : echapper(k)}</span>
    <span class="barre-piste"><span class="barre-remplie" style="display:block;width:${(n / max) * 82}%${page.repartition === 'typologie' ? `;background:var(--typo-${k.toLowerCase()})` : ''}"></span>
    <span class="barre-valeur" style="left:${(n / max) * 82}%">${nf().format(n)}</span></span></div>`).join('') || '<p class="chiffre-detail">Aucune donnée.</p>';
}

function afficherCarte(page, lignes) {
  const bloc = $('.bloc-carte');
  if (!page.carte || !window.L) { bloc.hidden = true; return; }
  bloc.hidden = false;
  if (!carte) {
    carte = L.map('carte', { scrollWheelZoom: false }).setView([44.85, -0.55], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© contributeurs OpenStreetMap',
    }).addTo(carte);
    coucheCarte = L.layerGroup().addTo(carte);
  }
  coucheCarte.clearLayers();
  const couleur = (t) => getComputedStyle(document.documentElement).getPropertyValue(`--typo-${(t ?? 'e').toLowerCase()}`).trim() || '#888';
  const points = lignes.filter((e) => e.type === 'lieu' && e.lat && e.lon);
  for (const e of points) {
    L.circleMarker([e.lat, e.lon], { radius: 6, weight: 1, color: '#1e2a33', fillColor: couleur(e.typologie), fillOpacity: .9 })
      .bindPopup(`<strong>${echapper(e.nom)}</strong><br>${echapper(e.commune)}<br>Typologie ${e.typologie ?? '–'}`)
      .addTo(coucheCarte);
  }
  if (points.length) carte.fitBounds(points.map((e) => [e.lat, e.lon]), { padding: [20, 20], maxZoom: 13 });
  setTimeout(() => carte.invalidateSize(), 0);
  $('.legende-carte').innerHTML = ['A', 'B', 'C', 'D', 'E'].map((t) => `<span><span class="pastille" style="background:var(--typo-${t.toLowerCase()})"></span>Typologie ${t}</span>`).join('')
    + `<span>${nf().format(points.length)} lieux localisés sur ${nf().format(lignes.filter((e) => e.type === 'lieu').length)}</span>`;
}

// ---- tableau détaillé
function colonnesTableau() {
  return pageCourante().tableau ?? [];
}
function lignesTableau() {
  const cols = colonnesTableau();
  const q = etat.recherche.trim().toLowerCase();
  let lignes = selection(etat.annee).filter((e) => !q || `${e.nom} ${e.commune}`.toLowerCase().includes(q));
  const t = etat.tri;
  const cle = (e) => {
    if (!t || t.col === 'nom') return `${e.commune} ${e.nom}`;
    if (t.col === 'epci') return libelleEpci(e.epci);
    if (t.col === 'typologie') return e.typologie ?? '';
    const v = valeurLigne(t.col, e, etat.annee);
    return v == null ? -Infinity : v;
  };
  lignes = [...lignes].sort((a, b) => {
    const x = cle(a), y = cle(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr');
    return t?.desc ? -c : c;
  });
  return { cols, lignes };
}
function afficherTableau() {
  const { cols, lignes } = lignesTableau();
  const entete = (col, lib, texte) => {
    const actif = etat.tri?.col === col;
    const sens = actif ? (etat.tri.desc ? 'descending' : 'ascending') : 'none';
    return `<th class="${texte ? 'texte' : ''}" aria-sort="${sens}"><button type="button" data-col="${col}">${echapper(lib)}${actif ? (etat.tri.desc ? ' ▼' : ' ▲') : ''}</button></th>`;
  };
  const html = `<thead><tr>${entete('nom', 'Établissement', true)}${entete('epci', 'Intercommunalité', true)}${entete('typologie', 'Typo.', true)}
    ${cols.map((c) => entete(c, meta.indicateurs[c].libelle + (unite(c) ? ` (${unite(c)})` : ''))).join('')}</tr></thead>
    <tbody>${lignes.map((e) => `<tr class="${e.type}"><td title="${echapper(e.nom)}">${echapper(e.commune)} – ${echapper(e.nom)}</td>
      <td class="texte">${echapper(libelleEpci(e.epci))}</td><td class="texte">${e.typologie ?? ''}</td>
      ${cols.map((c) => {
        const v = valeurLigne(c, e, etat.annee);
        if (v === undefined) return '<td class="vide">non collecté</td>';
        return `<td class="${v == null ? 'vide' : ''}${meta.indicateurs[c].agregation === 'categorie' ? ' texte' : ''}">${formater(c, v)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
  const table = $('.bloc-tableau table');
  table.innerHTML = html;
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
  const notes = [
    'Les sommes additionnent les lieux de lecture et, pour les communes multi-sites, la ligne « réseau » où une partie des données (personnel, budgets) est saisie.',
    'La population n\'est comptée qu\'une fois par commune, même si la commune compte plusieurs lieux de lecture.',
    'Les moyennes (entrées par emprunteur, livres par emprunteur, dépense par habitant) divisent des totaux, sur les seuls établissements qui renseignent les deux valeurs.',
    'Les évolutions sur un an sont calculées à périmètre constant : seuls les établissements qui ont renseigné l\'indicateur les deux années sont comparés. Les totaux affichés, eux, dépendent du nombre de répondants de l\'année.',
    'Le questionnaire change selon les années : un indicateur absent est signalé « non collecté », jamais remplacé par zéro.',
  ];
  for (const id of [...page.tuiles, ...(page.graphique ?? [])]) {
    const ind = meta.indicateurs[id];
    if (ind.note && !notes.includes(`${ind.libelle} : ${ind.note}`)) notes.push(`${ind.libelle} : ${ind.note}`);
  }
  $('.a-savoir ul').innerHTML = notes.map((n) => `<li>${echapper(n)}</li>`).join('');
}

addEventListener('hashchange', () => { lireAdresse(); afficher(); });
charger().catch((err) => {
  $('main').innerHTML = `<h1>Données introuvables</h1><p>Lancez <code>npm run import</code> pour générer les données, puis rechargez la page. (${echapper(err.message)})</p>`;
});
