/* Club No Nut November — logique du site (Supabase) */
(() => {
const YEAR = 2026, MONTH = 11, N = 30, TZ = 'Europe/Paris';
const EMOJIS = ['🔥', '💪', '😂', '🫡'];
// Clé publique des notifications (la clé privée reste côté serveur).
const VAPID_PUBLIC = 'BM82FmYq0Po_1W3-f4zCWROBq4mRQcjibckFcjoxKSF-5yRY_OceMA9KUI6mfax_XqWwM0filADXG-DjBgCeub8';
const VOTE_MS = 24 * 3600e3; // durée d'un vote de contestation
const $ = id => document.getElementById(id);

const cfg = window.NNN_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes('XXXX');
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

/* ---------- état ---------- */
let session = null, me = null, admin = false, loaded = false;
// Groupes : ceux dont je suis membre, le groupe affiché, ses membres et ses exclus.
let myGroups = new Map();            // id -> { id, name, invite_code, owner, role }
let gid = null;                      // groupe affiché
let gmembers = new Map();            // id -> { role, joined_at } (groupe affiché)
let gbans = new Set();               // exclus du groupe affiché
let verdicts = new Map();            // "uid_day" -> état (toutes les contestations du site)
let reports = [];                    // signalements visibles (organisateurs, modération)
let pendingInvite = null;            // { code, name, members } lien d'invitation en attente
const otherNews = new Set();         // groupes ayant reçu un message pendant qu'on en regarde un autre
let profiles = new Map();            // id -> {pseudo, created_at}
let banned = new Set();              // membres retirés par l'organisateur (historique conservé)
let recovery = false;                // ouverture depuis le lien « mot de passe oublié »
let checkins = new Map();            // id -> {day: {status, late}}
let contests = new Map();            // "uid_day" -> {target, day, resolution, opened_by, votes:{voter:vote}}
let posts = [], reactions = new Map(), quoted = new Map(); // quoted : messages plus anciens cités par une réponse
const drafts = {};
let reads = new Map();               // id -> dernière visite de la discussion (ms)
let online = new Set();              // membres connectés en ce moment
const typing = new Map();            // id -> minuterie « écrit… »
const imgUrls = new Map();           // chemin photo -> { url signée, date }
let pendingImg = null;               // photo prête à partir { blob, url }
let room = null, lastTyping = 0, lastReadSent = 0;
let busy = false, oathOk = false, confessOpen = false, freshStamp = false;
let tab = 'today', lastSeenPost = +(saved('nnn-seen') || 0);
let feedFilter = saved('nnn-filter') || 'all', postLimit = 100, morePosts = false, editing = null;
let selected = null, reveal = false, replyTo = null, unreadMark = null, atBottomTs = 0, stick = null, keepFrom = null, pinIdx = 0;
const openGroups = new Set(), showWho = new Set();
let authMode = 'login';

/* ---------- utilitaires ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }

function paris(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function phase() {
  const p = paris();
  if (p.y < YEAR || (p.y === YEAR && p.m < MONTH)) return { s: 'before', day: 0, last: 0 };
  if (p.y === YEAR && p.m === MONTH) return { s: 'live', day: p.d, last: p.d };
  return { s: 'after', day: 0, last: N };
}
function untilMidnight() { const p = paris(); const left = 86400 - (p.h * 3600 + p.mi * 60 + p.s); return { h: Math.floor(left / 3600), m: Math.floor(left % 3600 / 60) }; }
const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function when(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return 'il y a ' + Math.floor(diff / 60) + ' min';
  if (diff < 6 * 3600) return 'il y a ' + Math.floor(diff / 3600) + ' h';
  return fmt.format(new Date(ts));
}
function nm(id) { return profiles.get(id)?.pseudo || 'Ancien membre'; }
function members() { return [...gmembers.keys()].filter(id => profiles.has(id) && !banned.has(id)); }
const grp = () => myGroups.get(gid) || null;
// Organisateur du groupe affiché (propriétaire ou admin), ou modérateur du site.
function gadmin() { const r = gmembers.get(me)?.role; return admin || r === 'owner' || r === 'admin'; }
function joinedAt(id) { return new Date(gmembers.get(id)?.joined_at || profiles.get(id)?.created_at || 0); }
// Contestations et votes ouverts pendant novembre et le 1er décembre (comme nnn_votes_open() côté serveur).
// Votants d'une contestation : membres actifs inscrits avant son ouverture, hors personne contestée.
// Un compte créé après l'ouverture ne compte pas ; un compte retiré par l'organisateur perd sa voix.
function electors(c) { const t0 = new Date(c.created_at); return members().filter(id => id !== c.target && joinedAt(id) <= t0); }
function tally(c) { const el = new Set(electors(c)); let yes = 0, no = 0; for (const [v, x] of Object.entries(c.votes)) { if (!el.has(v)) continue; x === 'invalid' ? no++ : yes++; } return { yes, no, others: el.size }; }
function votesOpen() { const p = paris(); return p.y === YEAR && (p.m === MONTH || (p.m === MONTH + 1 && p.d === 1)); }
function hue(id) { let x = 2166136261; for (const c of String(id)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } return Math.round((x % 12) * 30); }
function avatarUrl(id) { const a = profiles.get(id)?.avatar; return a ? cfg.SUPABASE_URL + '/storage/v1/object/public/avatars/' + a : null; }
// link : l'avatar ouvre la fiche du membre.
function avatar(id, cls = '', link = false) {
  const n = nm(id).trim(); const ini = n.split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?', u = avatarUrl(id);
  return h('span', { class: 'avatar ' + cls + (online.has(id) && id !== me ? ' on' : ''), style: '--h:' + hue(id),
    ...(link ? { 'data-uid': id, role: 'button', tabindex: '0', 'aria-label': 'Profil de ' + nm(id) } : { 'aria-hidden': 'true' }) },
    u ? h('img', { src: u, alt: '', loading: 'lazy', decoding: 'async', onerror: e => e.target.replaceWith(ini) }) : ini);
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }
function rand(seed) { let x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }

/* ---------- calculs ---------- */
function voteEnds(c) { return new Date(c.created_at).getTime() + VOTE_MS; }
function contestState(c) {
  if (!c) return null;
  if (c.resolution) return c.resolution;
  const { yes, no, others } = tally(c);
  if (others > 0 && no * 2 > others) return 'invalid';
  if (others > 0 && yes * 2 >= others) return 'valid';
  // Au bout de 24 h, la majorité des votants décide ; à égalité, le jour est maintenu.
  if (Date.now() >= voteEnds(c) || !votesOpen()) return no > yes ? 'invalid' : 'valid';
  return 'open';
}
// Verdict d'un jour contesté : calculé en direct pour le groupe affiché, sinon celui du serveur.
function dayState(uid, d) { const k = uid + '_' + d, c = contests.get(k); return c && c.group_id === gid ? contestState(c) : verdicts.get(k) || null; }
function stat(uid) {
  const ph = phase(), days = checkins.get(uid) || {};
  let ok = 0, run = 0, best = 0, out = null; const cells = [];
  for (let d = 1; d <= N; d++) {
    let st;
    if (d > ph.last) st = 'future';
    else {
      const v = days[d]?.status;
      if (v === 'ok' && dayState(uid, d) === 'invalid') st = 'voided';
      else if (v === 'ok') st = 'ok';
      else if (v === 'fail') st = 'fail';
      else if (ph.s === 'after' || d < ph.day) st = 'missed';
      else st = 'pending';
    }
    cells.push(st);
    if (st === 'ok') { ok++; run++; best = Math.max(best, run); }
    else if (st !== 'pending' && st !== 'future') { run = 0; if (!out) out = { d, st }; }
  }
  return { cells, ok, best, cur: run, out, honest: Object.values(days).some(x => x.status === 'fail'), today: ph.s === 'live' ? days[ph.day]?.status : null };
}
function ranked(ids = members()) {
  return ids.map(id => ({ id, st: stat(id) }))
    .sort((a, b) => (!!a.st.out - !!b.st.out) || (b.st.cur - a.st.cur) || (b.st.ok - a.st.ok) || nm(a.id).localeCompare(nm(b.id)));
}
function badges(st) {
  const b = [];
  if (!st.out) b.push(h('span', { class: 'badge ok', text: 'En lice' }));
  else b.push(h('span', { class: 'badge bad', text: { fail: 'Craqué', missed: 'Manqué', voided: 'Annulé' }[st.out.st] + ' J' + st.out.d }));
  if (st.honest) b.push(h('span', { class: 'badge ice', text: 'Honnête' }));
  if (st.best >= 30) b.push(h('span', { class: 'badge gold', text: 'Légende 30' }));
  else if (st.best >= 15) b.push(h('span', { class: 'badge gold', text: 'Mur de 15' }));
  else if (st.best >= 7) b.push(h('span', { class: 'badge gold', text: 'Semaine 7' }));
  return b;
}

/* ---------- le mur de bâtons ---------- */
function bundle(cells, g) {
  const svg = s('svg', { viewBox: '0 0 92 66', role: 'img', 'aria-label': `Jours ${g * 5 + 1} à ${g * 5 + 5}` });
  for (let i = 0; i < 5; i++) {
    const d = g * 5 + i + 1, st = cells[d - 1];
    const j = k => (rand(d * 7 + k) - .5);
    let path;
    if (i < 4) { const x = 14 + i * 16; path = `M${x + j(1) * 4} ${8 + j(2) * 3} Q${x + j(3) * 6} 33 ${x + j(4) * 4} ${58 + j(5) * 3}`; }
    else path = `M${3 + j(1) * 3} ${50 + j(2) * 4} Q46 ${30 + j(3) * 8} ${86 + j(4) * 3} ${16 + j(5) * 4}`;
    const p = s('path', { d: path, class: 'stroke ' + st });
    const t = s('title', {}); t.textContent = `Jour ${d} · ${{ ok: 'tenu', fail: 'craqué', voided: 'annulé par vote', missed: 'manqué', pending: 'à valider aujourd\'hui', future: 'à venir' }[st]}`;
    p.append(t); svg.append(p);
  }
  return h('div', { class: 'bundle' }, svg, h('span', { class: 'lbl', text: `${g * 5 + 1}–${g * 5 + 5}` }));
}
function wall(cells) { return Array.from({ length: 6 }, (_, g) => bundle(cells, g)); }

/* ---------- rendu ---------- */
let queued = false;
function queue() { if (!queued) { queued = true; requestAnimationFrame(render); } }
function render() {
  queued = false;
  const ae = document.activeElement, aeId = ae?.id, sel = ae && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  const ph = phase();
  $('daypill').textContent = ph.s === 'live' ? `Jour ${ph.day} / 30` : ph.s === 'before' ? 'J-' + daysBefore() : 'Terminé';
  const authed = !!session, isBanned = authed && banned.has(me), hasProfile = authed && profiles.has(me) && !isBanned && !recovery;
  $('v-auth').hidden = authed;
  $('v-reset').hidden = !authed || !recovery;
  $('v-banned').hidden = !isBanned || recovery;
  $('v-setup').hidden = !authed || !loaded || recovery || isBanned || profiles.has(me);
  $('tabs').hidden = !hasProfile;
  // Le classement n'existe que dans un groupe : en solo, l'onglet disparaît.
  const boardBtn = document.querySelector('nav.tabs [data-tab=board]');
  boardBtn.hidden = !gid; $('tabs').classList.toggle('two', !gid);
  if (!gid && loaded && tab === 'board') { tab = 'today'; if (location.hash === '#board') history.replaceState(null, '', '#today'); }
  $('me-btn').hidden = !authed;
  for (const t of ['today', 'board', 'feed']) $('v-' + t).hidden = !hasProfile || tab !== t;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  if (authed) { $('me-av').replaceWith(Object.assign(avatar(me), { id: 'me-av' })); $('me-name').textContent = hasProfile ? nm(me) : (session.user.email || ''); }
  if (!authed) renderPoster();
  if (hasProfile) { renderGroupBars(); renderToday(); renderBoard(); renderFeed(); }
  $('site-foot').hidden = hasProfile && tab === 'feed';
  $('mod-btn').hidden = !admin; $('mod-btn').textContent = 'Modération' + (reports.length ? ` (${new Set(reports.map(r => r.post_id)).size})` : '');
  if (!authed) renderLanding();
  renderRemind(hasProfile); renderNotifCta(hasProfile);
  if (sheetView?.type === 'profile' && $('sheet').open && !$('sheet').contains(document.activeElement)) renderSheet();
  document.body.classList.toggle('chat-on', hasProfile && tab === 'feed');
  if (aeId) { const n = $(aeId); if (n && n !== document.activeElement) { n.focus(); if (sel) try { n.setSelectionRange(...sel); } catch (_) {} } }
}
// Rappel avant minuit : à partir de 18 h (heure de Paris), tant que le jour n'est pas validé.
function renderRemind(hasProfile) {
  const box = $('remind'), ph = phase();
  const st = hasProfile && ph.s === 'live' ? stat(me) : null;
  const show = st && !st.today && paris().h >= 18 && tab !== 'today';
  box.hidden = !show; if (!show) return;
  const mid = untilMidnight(), late = mid.h < 2;
  box.className = 'remind' + (late ? ' late' : '');
  box.replaceChildren(h('span', {}, h('b', { text: `Jour ${ph.day} pas encore validé. ` }), `Il te reste ${mid.h} h ${String(mid.m).padStart(2, '0')} avant minuit.`),
    h('button', { class: 'btn', type: 'button', onclick: () => { tab = 'today'; location.hash = 'today'; window.scrollTo(0, 0); queue(); }, text: 'Valider' }));
}

// Récap du mois (en cours pendant novembre, final ensuite), partageable.
function recapData() {
  const ph = phase(), r = ranked(), alive = r.filter(x => !x.st.out);
  const sticks = r.reduce((n, x) => n + x.st.ok, 0);
  const best = r.slice().sort((a, b) => b.st.best - a.st.best)[0];
  const honest = r.filter(x => x.st.honest).length;
  const voided = r.reduce((n, x) => n + x.st.cells.filter(c => c === 'voided').length, 0);
  const legends = r.filter(x => x.st.best >= 30).map(x => nm(x.id));
  return { ph, r, alive, sticks, best, honest, voided, legends };
}
function renderRecap() {
  const d = recapData(), done = d.ph.s === 'after';
  $('recap').hidden = d.ph.s === 'before' || !d.r.length;
  if ($('recap').hidden) return;
  $('recap-title').textContent = done ? 'Le récap de novembre' : `Le récap au jour ${d.ph.day}`;
  const tile = (v, l) => h('div', {}, h('b', { text: v }), h('span', { text: l }));
  $('recap-grid').replaceChildren(
    tile(`${d.alive.length}/${d.r.length}`, done ? 'ont tenu les 30 jours' : 'encore en lice'),
    tile(d.sticks, 'bâtons tracés par le groupe'),
    tile(d.best && d.best.st.best ? d.best.st.best : 0, 'meilleure série (jours)'),
    tile(d.honest, d.honest > 1 ? 'aveux honnêtes' : 'aveu honnête'));
  const li = [];
  if (d.best && d.best.st.best) li.push(h('li', {}, 'Meilleure série : ', h('b', { text: nm(d.best.id) }), ` (${d.best.st.best} j)`));
  d.r.slice(0, 3).forEach((x, i) => li.push(h('li', {}, `${i + 1}${i ? 'e' : 'er'} du classement : `, h('b', { text: nm(x.id) }), ` (${x.st.cur} j de série, ${x.st.ok} au total)`)));
  if (d.voided) li.push(h('li', { text: `${d.voided} jour${d.voided > 1 ? 's' : ''} annulé${d.voided > 1 ? 's' : ''} par vote du groupe` }));
  if (d.legends.length) li.push(h('li', {}, 'Légendes 30 : ', h('b', { text: d.legends.join(', ') })));
  $('recap-list').replaceChildren(...li);
}
function recapText() {
  const d = recapData(), done = d.ph.s === 'after';
  const lines = [done ? 'Club No Nut November : le récap' : `Club No Nut November : jour ${d.ph.day}/30`,
    `${d.alive.length}/${d.r.length} ${done ? 'ont tenu les 30 jours' : 'encore en lice'}, ${d.sticks} bâtons tracés.`];
  if (d.best && d.best.st.best) lines.push(`Meilleure série : ${nm(d.best.id)} (${d.best.st.best} j).`);
  if (d.legends.length) lines.push(`Légendes 30 : ${d.legends.join(', ')}.`);
  lines.push(location.origin);
  return lines.join('\n');
}
async function shareRecap() {
  const text = recapText();
  try { if (navigator.share) { await navigator.share({ title: 'Club NNN', text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Récap copié, colle-le où tu veux.'); } catch (_) { prompt('Copie le récap :', text); }
}

function daysBefore() { const now = new Date(); const start = new Date(Date.UTC(YEAR, MONTH - 1, 1)); return Math.max(1, Math.ceil((start - now) / 864e5)); }

function renderPoster() {
  const w = $('poster-wall'); if (w.childElementCount) return;
  const cells = Array.from({ length: N }, (_, i) => i < 17 ? 'ok' : i === 17 ? 'pending' : 'future');
  wall(cells).forEach(b => { b.querySelector('.lbl').remove(); w.append(b.firstChild); });
}

function renderToday() {
  const ph = phase(), st = stat(me), hero = $('hero');
  hero.replaceChildren();
  const mid = untilMidnight();
  hero.append(h('div', { class: 'hero-top' },
    h('div', { class: 'hero-day' }, h('i', { text: 'J' }), h('b', { text: ph.s === 'live' ? ph.day : ph.s === 'before' ? 0 : 30 }), h('small', { text: '/30' })),
    ph.s === 'live' ? h('div', { class: 'clock' }, h('b', { text: `${mid.h} h ${String(mid.m).padStart(2, '0')}` }), h('span', { text: 'avant minuit' })) : null));

  if (ph.s === 'before') { hero.append(h('p', { text: 'Le défi commence le 1er novembre à minuit, heure de Paris. Prépare-toi.' })); }
  else if (ph.s === 'after') { hero.append(h('p', { text: 'Novembre est terminé. Le classement est figé, va voir qui a tenu le mur.' })); }
  else if (st.today === 'ok') {
    hero.append(h('div', { class: 'stamp' + (freshStamp ? ' fresh' : '') }, 'Tenu', h('small', { text: 'JOUR ' + ph.day })));
    hero.append(h('span', { class: 'status ok', text: 'Jour ' + ph.day + ' validé' }));
    hero.append(h('p', { text: 'Bâton tracé. Le prochain se débloque à minuit.' }));
  } else if (st.today === 'fail') {
    hero.append(h('div', { class: 'stamp bad' + (freshStamp ? ' fresh' : '') }, 'Craqué', h('small', { text: 'JOUR ' + ph.day })));
    hero.append(h('span', { class: 'status bad', text: 'Aveu enregistré' }));
    hero.append(h('p', { text: 'Respect pour la franchise, tu gagnes le badge Honnête. Ta série repart de zéro, mais tu peux continuer à tracer des bâtons dès demain.' }));
  } else {
    hero.append(h('span', { class: 'status wait', text: 'À valider avant minuit' }));
    const cb = h('input', { type: 'checkbox', id: 'oath' }); cb.checked = oathOk;
    cb.addEventListener('change', () => { oathOk = cb.checked; queue(); });
    hero.append(h('label', { class: 'oath', for: 'oath' }, cb, h('span', { text: `Je jure sur l'honneur avoir tenu aujourd'hui, jour ${ph.day} de novembre.` })));
    hero.append(h('button', { class: 'btn big', id: 'validate-btn', disabled: !oathOk || busy, onclick: () => mark('ok'), text: 'Tracer le bâton ' + ph.day }));
  }
  if (ph.s === 'live' && st.today !== 'fail') {
    if (!confessOpen) hero.append(h('button', { class: 'btn ghost', disabled: busy, onclick: () => { confessOpen = true; queue(); }, text: 'J\'ai craqué' }));
    else hero.append(h('div', { class: 'confirm' },
      h('b', { text: 'Tu confirmes avoir craqué aujourd\'hui ?' }),
      h('span', { class: 'dim', text: 'Ta série s\'arrête et tout le groupe le verra. C\'est définitif.' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', disabled: busy, onclick: () => mark('fail'), text: 'Oui, j\'avoue' }), h('button', { class: 'btn ghost', onclick: () => { confessOpen = false; queue(); }, text: 'Annuler' }))));
  }
  freshStamp = false;

  $('my-tag').className = 'tag ' + (st.out ? 'bad' : 'ok');
  $('my-tag').textContent = st.out ? 'Éliminé J' + st.out.d : 'En lice';
  $('my-wall').replaceChildren(...wall(st.cells));
  $('my-stats').replaceChildren(
    h('div', { class: 'stat' }, h('b', { text: st.cur }), h('span', { text: 'Série en cours' })),
    h('div', { class: 'stat' }, h('b', { text: st.ok }), h('span', { text: 'Bâtons au total' })),
    h('div', { class: 'stat' }, h('b', { text: st.best }), h('span', { text: 'Meilleure série' })));
}

function renderBoard() {
  // Sans groupe, on fait le défi seul : on ne voit que son propre mur.
  const solo = !gid;
  $('nogroup-board').hidden = !solo;
  $('v-board').classList.toggle('solo', solo); $('lb-sum').hidden = solo;
  if (solo) $('nogroup-board').replaceChildren(...noGroupPanel());
  $('groupbar-board').hidden = $('podium').hidden = $('lb').hidden = $('recap').hidden = solo;
  $('grid-title').textContent = solo ? 'Ton mur' : 'Le mur du groupe';
  $('grid-sub').textContent = solo ? 'Une case par jour de novembre.' : 'Une ligne par membre, une case par jour de novembre.';
  const all = solo ? ranked([me]) : ranked();
  const r = all;
  const alive = all.filter(x => !x.st.out).length;
  $('lb-sum').textContent = solo ? '' : `${alive} en lice / ${all.length}`;
  const order = [1, 0, 2];
  $('podium').replaceChildren(...order.map(i => {
    const x = r[i];
    if (!x) return h('div', { class: 'pod empty' });
    return h('div', { class: 'pod p' + (i + 1) }, h('span', { class: 'place', text: ['1er', '2e', '3e'][i] }), avatar(x.id, 'xl', true), h('span', { class: 'nm', text: nm(x.id) }),
      h('div', { class: 'block' }, h('b', { text: x.st.cur }), h('span', { text: 'jours de série' })));
  }));
  const lb = $('lb'); lb.replaceChildren();
  if (!r.length) lb.append(h('div', { class: 'empty', text: 'Personne sur le mur pour l\'instant.' }));
  r.forEach((x, i) => lb.append(h('div', { class: 'lb-row' + (x.id === me ? ' me' : '') },
    h('span', { class: 'rank', text: all.indexOf(x) + 1 }), avatar(x.id, '', true),
    h('div', { class: 'lb-name' }, h('b', { text: nm(x.id) + (x.id === me ? ' (toi)' : '') }), h('div', { class: 'badges' }, badges(x.st)),
      gadmin() && x.id !== me && gmembers.get(x.id)?.role !== 'owner' ? h('button', { class: 'linkbtn', onclick: () => removeMember(x.id), text: 'Retirer du groupe' }) : null),
    h('div', { class: 'lb-score' }, h('b', { text: x.st.cur }), h('small', { text: x.st.ok + ' au total' })))));
  const out = solo ? [] : [...gbans].filter(id => profiles.has(id));
  if (out.length) lb.append(h('div', { class: 'retired' }, h('span', { class: 'dim', text: 'Retirés du groupe :' }),
    out.map(id => h('span', { class: 'badge bad' }, nm(id),
      gadmin() ? h('button', { class: 'linkbtn ok', style: 'margin:0 0 0 6px', onclick: () => reinstate(id), text: 'autoriser à revenir' }) : null))));
  if (!solo) renderRecap();
  const g = $('grid'); g.replaceChildren();
  if (!r.length) return;
  const head = h('tr', {}, h('th', { class: 'nm' }));
  for (let d = 1; d <= N; d++) head.append(h('th', { text: d }));
  const tb = h('tbody');
  r.forEach(x => { const tr = h('tr', {}, h('th', { class: 'nm', text: nm(x.id) })); x.st.cells.forEach((c, i) => tr.append(h('td', { class: c, title: nm(x.id) + ' · jour ' + (i + 1) }))); tb.append(tr); });
  g.append(h('thead', {}, head), tb);
}

/* ---------- la discussion du groupe (façon messagerie) ---------- */
const FILTERS = [['all', 'Tout'], ['text', 'Messages'], ['ok', 'Validations'], ['contest', 'Contestations'], ['me', '@ Moi']];
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hm = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayKey = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLong = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
function dayLabel(ts) {
  const k = dayKey.format(new Date(ts)), today = dayKey.format(new Date()), y = dayKey.format(new Date(Date.now() - 864e5));
  if (k === today) return 'Aujourd\'hui'; if (k === y) return 'Hier';
  const s = dayLong.format(new Date(ts)); return s[0].toUpperCase() + s.slice(1);
}
// Découpe un texte en morceaux, en repérant les @pseudo des membres (le plus long d'abord).
function richText(text) {
  const names = [...profiles.values()].map(x => x.pseudo).sort((a, b) => b.length - a.length);
  if (!names.length || !text.includes('@')) return [text];
  const re = new RegExp('@(' + names.map(reEsc).join('|') + ')(?![\\p{L}\\p{N}_])', 'giu');
  const out = []; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const mine = m[1].toLowerCase() === nm(me).toLowerCase();
    out.push(h('span', { class: 'mention' + (mine ? ' me' : ''), text: m[0] }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function mentionsMe(text) {
  if (!text || !profiles.has(me)) return false;
  return new RegExp('@' + reEsc(nm(me)) + '(?![\\p{L}\\p{N}_])', 'iu').test(text);
}
function postById(id) { return posts.find(p => p.id === id) || quoted.get(id) || null; }
function repliesToMe(p) { const o = p.reply_to && postById(p.reply_to); return !!o && o.author === me && p.author !== me; }
function concernsMe(p) { return mentionsMe(p.text) || (p.kind === 'contest' && p.target === me) || repliesToMe(p); }
// Texte court d'un message, pour les citations et la barre d'épinglage.
function snippet(p) {
  if (!p) return 'Message supprimé';
  if (p.kind === 'text') { const t = p.text || ''; return (p.image ? '📷 ' : '') + (t ? (t.length > 120 ? t.slice(0, 118) + '…' : t) : 'Photo'); }
  return { ok: 'tient le jour ' + p.day, fail: 'avoue au jour ' + p.day, join: 'entre sur le mur', contest: 'conteste le jour ' + p.day + ' de ' + nm(p.target) }[p.kind] || '';
}
function setFilter(f) { feedFilter = f; try { localStorage.setItem('nnn-filter', f); } catch (_) {} stick = 'bottom'; queue(); }
function markSeen() {
  const newest = Math.max(0, ...posts.map(p => +new Date(p.created_at)));
  if (newest > lastSeenPost) { lastSeenPost = newest; try { localStorage.setItem('nnn-seen', String(newest)); } catch (_) {} }
  // « Vu par » : on signale sa visite (au plus toutes les 20 s).
  const mine = reads.get(me) || 0;
  if (document.visibilityState === 'visible' && (newest > mine || Date.now() - lastReadSent > 6e4) && Date.now() - lastReadSent > 2e4) {
    lastReadSent = Date.now(); reads.set(me, Date.now());
    if (gid) sb.from('group_reads').upsert({ group_id: gid, user_id: me }, { onConflict: 'group_id,user_id' }).then(() => {}, () => {});
  }
}
function feedBadge() {
  const fresh = x => +new Date(x.created_at) > lastSeenPost && x.author !== me;
  const newPost = posts.some(fresh), atMe = posts.some(p => fresh(p) && concernsMe(p));
  const dot = $('feed-dot');
  dot.hidden = tab === 'feed' || !(newPost || atMe);
  dot.className = 'dot' + (atMe ? ' at' : '');
  dot.textContent = atMe ? '@' : '';
}
const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
function toBottom() { window.scrollTo(0, document.documentElement.scrollHeight); }
function jumpTo(id) {
  const el = document.querySelector(`#feed [data-id="${CSS.escape(id)}"]`);
  if (!el) { toast('Ce message est trop ancien pour être affiché.'); return; }
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
function select(id) { selected = selected === id ? null : id; reveal = !!selected; queue(); }
function startReply(p) {
  replyTo = p.id; selected = null; queue();
  const c = $('composer'); c.focus();
}

function renderFeed() {
  const f = $('feed');
  const wasBottom = tab === 'feed' && nearBottom();
  f.replaceChildren();
  const seenBefore = unreadMark ?? lastSeenPost;
  if (tab === 'feed' && loaded) { if (unreadMark == null) { unreadMark = atBottomTs = lastSeenPost; stick ||= 'unread'; } markSeen(); }
  feedBadge(); renderPresence();
  $('feed-filters').replaceChildren(...FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': feedFilter === k ? 'true' : 'false', onclick: () => setFilter(k), text: label })));

  // Barre d'épinglage : le dernier message épinglé, un appui l'affiche (et passe au suivant).
  const pins = posts.filter(p => p.pinned).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const pb = $('pinbar'); pb.hidden = !pins.length;
  if (pins.length) {
    const p = pins[pinIdx % pins.length];
    pb.replaceChildren(h('span', { class: 'pin-ic', 'aria-hidden': 'true', text: '📌' }),
      h('span', { class: 'pin-tx' }, h('b', { text: 'Épinglé' + (pins.length > 1 ? ` ${pinIdx % pins.length + 1}/${pins.length}` : '') }), h('span', { text: nm(p.author) + ' : ' + snippet(p) })));
    pb.onclick = () => { const id = pins[pinIdx % pins.length].id; pinIdx++; if (feedFilter !== 'all' && feedFilter !== 'text') feedFilter = 'all'; render(); jumpTo(id); };
  }

  // Composer : réponse en cours
  const rb = $('replybar'), rp = replyTo && postById(replyTo);
  if (replyTo && !rp) replyTo = null;
  rb.hidden = !rp;
  if (rp) rb.replaceChildren(h('div', { class: 'quote', style: '--h:' + hue(rp.author) }, h('b', { text: 'Réponse à ' + (rp.author === me ? 'toi-même' : nm(rp.author)) }), h('span', { text: snippet(rp) })),
    h('button', { type: 'button', class: 'x', 'aria-label': 'Annuler la réponse', onclick: () => { replyTo = null; queue(); }, text: '✕' }));

  if (!posts.length) { f.append(h('div', { class: 'empty', text: loaded ? 'La discussion est vide. Écris le premier message ou trace ton premier bâton pour l\'annoncer.' : 'Chargement de la discussion…' })); return; }

  const keep = p => feedFilter === 'all' || (feedFilter === 'text' && p.kind === 'text') || (feedFilter === 'ok' && (p.kind === 'ok' || p.kind === 'fail'))
    || (feedFilter === 'contest' && p.kind === 'contest') || (feedFilter === 'me' && concernsMe(p));
  const list = posts.filter(keep).slice().reverse(); // du plus ancien au plus récent

  // Vue « Tout » : les validations d'un même jour forment une seule pastille, placée à la dernière.
  const items = [];
  if (feedFilter === 'all') {
    const byDay = {}; list.forEach(p => { if (p.kind === 'ok') (byDay[p.day] ||= []).push(p); });
    for (const p of list) {
      const g = p.kind === 'ok' && byDay[p.day];
      if (g && g.length > 1) { if (g[g.length - 1] === p) items.push({ group: g, day: p.day, at: p.created_at }); }
      else items.push({ post: p, at: p.created_at });
    }
  } else list.forEach(p => items.push({ post: p, at: p.created_at }));

  if (morePosts) f.append(h('button', { class: 'older', type: 'button', onclick: () => { postLimit += 100; keepFrom = document.documentElement.scrollHeight - window.scrollY; loadAll(); }, text: 'Voir les messages plus anciens' }));
  if (!items.length) f.append(h('div', { class: 'empty', text: feedFilter === 'me' ? 'Rien pour toi pour l\'instant : ici s\'affichent les messages qui te mentionnent ou te répondent.' : 'Rien à afficher avec ce filtre.' }));
  let lastDay = null, prev = null, unreadShown = false;
  for (const it of items) {
    const dk = dayKey.format(new Date(it.at));
    if (dk !== lastDay) { f.append(h('div', { class: 'daysep' }, h('span', { text: dayLabel(it.at) }))); lastDay = dk; prev = null; }
    const p = it.post;
    if (!unreadShown && seenBefore && +new Date(it.at) > seenBefore && (it.group ? it.group.some(x => x.author !== me) : p.author !== me)) {
      f.append(h('div', { class: 'unread', id: 'unread' }, h('span', { text: 'Nouveaux messages' }))); unreadShown = true; prev = null;
    }
    if (it.group) { f.append(groupPill(it.group, it.day)); prev = null; continue; }
    if (p.kind === 'text') {
      const cont = prev && prev.kind === 'text' && prev.author === p.author && new Date(p.created_at) - new Date(prev.created_at) < 5 * 60e3;
      f.append(bubble(p, cont)); prev = p;
    } else { f.append(p.kind === 'contest' ? contestCard(p) : sysPill(p)); prev = null; }
  }
  // « Vu par » sous mon dernier message.
  const myLast = list.findLast(p => p.kind === 'text' && p.author === me);
  if (myLast) { const el = f.querySelector(`.msg[data-id="${CSS.escape(myLast.id)}"] .mcol`); if (el) el.append(seenLine(myLast)); }

  if (tab !== 'feed') return;
  if (keepFrom != null) { window.scrollTo(0, document.documentElement.scrollHeight - keepFrom); keepFrom = null; }
  else if (stick) { const u = stick === 'unread' && $('unread'); stick = null; u ? u.scrollIntoView({ block: 'start' }) : toBottom(); }
  else if (wasBottom) toBottom();
  if (reveal) { reveal = false; f.querySelector('.sel .msg-actions')?.scrollIntoView({ block: 'nearest' }); }
  updateToBottom();
}
function seenLine(p) {
  const t = +new Date(p.created_at), others = members().filter(id => id !== me);
  const seen = others.filter(id => (reads.get(id) || 0) >= t);
  let txt = 'Envoyé';
  if (seen.length && seen.length === others.length) txt = others.length > 1 ? 'Vu par tout le monde' : 'Vu par ' + nm(seen[0]);
  else if (seen.length) txt = 'Vu par ' + (seen.length <= 3 ? seen.map(nm).join(', ') : seen.slice(0, 2).map(nm).join(', ') + ` et ${seen.length - 2} autres`);
  return h('span', { class: 'seen' + (seen.length ? ' yes' : ''), text: (seen.length ? '✓✓ ' : '✓ ') + txt });
}
// En ligne / en train d'écrire, sous les filtres.
function renderPresence() {
  const el = $('presence'); if (!el) return;
  const tp = [...typing.keys()].filter(id => id !== me && profiles.has(id));
  const on = [...online].filter(id => id !== me && profiles.has(id) && !banned.has(id));
  el.classList.toggle('typing', !!tp.length);
  if (tp.length) el.replaceChildren(h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), (tp.length === 1 ? nm(tp[0]) + ' écrit' : tp.slice(0, 2).map(nm).join(' et ') + (tp.length > 2 ? ' et d\'autres' : '') + ' écrivent') + '…');
  else if (on.length) el.replaceChildren(h('span', { class: 'live', 'aria-hidden': 'true' }), `En ligne : ${on.length <= 3 ? on.map(nm).join(', ') : on.slice(0, 2).map(nm).join(', ') + ` et ${on.length - 2} autres`}`);
  else el.replaceChildren('Personne d\'autre en ligne pour l\'instant');
}
// Bouton « derniers messages » quand on remonte, avec le nombre de messages reçus depuis.
function updateToBottom() {
  const b = $('tobottom'), atB = nearBottom();
  if (atB) atBottomTs = Math.max(atBottomTs, ...posts.map(p => +new Date(p.created_at)));
  b.hidden = tab !== 'feed' || atB;
  const n = posts.filter(p => +new Date(p.created_at) > atBottomTs && p.author !== me).length;
  $('tobottom-n').hidden = !n; $('tobottom-n').textContent = n > 99 ? '99+' : n;
}

function canContest(p) {
  return p.kind === 'ok' && gmembers.has(p.author) && checkins.get(p.author)?.[p.day]?.status === 'ok' && votesOpen() && p.author !== me
    && !banned.has(p.author) && !contests.has(p.author + '_' + p.day);
}
// Réactions affichées sous un message ; un appui montre qui a réagi.
function rxBar(p) {
  const rx = reactions.get(p.id) || {}, counts = {}; Object.values(rx).forEach(e => counts[e] = (counts[e] || 0) + 1);
  const n = Object.keys(rx).length; if (!n) return null;
  const open = showWho.has(p.id);
  const box = h('div', { class: 'rxwrap' }, h('button', { type: 'button', class: 'rxsum' + (rx[me] ? ' mine' : ''), 'aria-expanded': open ? 'true' : 'false', 'aria-label': 'Voir qui a réagi',
    onclick: e => { e.stopPropagation(); open ? showWho.delete(p.id) : showWho.add(p.id); queue(); } },
    EMOJIS.filter(e => counts[e]).join(''), n > 1 ? h('small', { text: n }) : null));
  if (open) box.append(h('div', { class: 'whorx' }, EMOJIS.filter(e => counts[e]).map(e => h('div', {}, e + ' ', Object.entries(rx).filter(([, x]) => x === e).map(([u]) => u === me ? 'Toi' : nm(u)).join(', ')))));
  return box;
}
// Barre d'actions d'un message sélectionné : réactions rapides puis actions.
function actionBar(p) {
  const rx = reactions.get(p.id) || {}, mine = p.kind === 'text' && p.author === me;
  const bar = h('div', { class: 'msg-actions', onclick: e => e.stopPropagation() },
    h('div', { class: 'quick' }, EMOJIS.map(e => h('button', { type: 'button', class: 'react', 'aria-pressed': rx[me] === e ? 'true' : 'false', 'aria-label': 'Réagir ' + e, onclick: () => { selected = null; react(p.id, e); } }, e))),
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => startReply(p), text: 'Répondre' }),
      p.kind === 'text' && p.text ? h('button', { type: 'button', onclick: () => copyText(p.text), text: 'Copier' }) : null,
      mine && p.text && editing !== p.id ? h('button', { type: 'button', onclick: () => { editing = p.id; selected = null; queue(); }, text: 'Modifier' }) : null,
      gadmin() && p.kind === 'text' ? h('button', { type: 'button', onclick: () => { selected = null; pinPost(p); }, text: p.pinned ? 'Désépingler' : 'Épingler' }) : null,
      !mine && p.author !== me && p.kind === 'text' ? h('button', { type: 'button', onclick: () => { selected = null; reportPost(p); }, text: 'Signaler' }) : null,
      canContest(p) ? h('button', { class: 'warn', type: 'button', onclick: () => { selected = null; contest(p); }, text: 'Contester' }) : null,
      mine || gadmin() ? h('button', { class: 'del', type: 'button', onclick: () => { selected = null; delPost(p.id); }, text: 'Supprimer' }) : null));
  return bar;
}
function copyText(t) { selected = null; queue(); (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => toast('Message copié'), () => toast('Copie impossible sur cet appareil')); }
function quoteBox(p) {
  if (!p.reply_to) return null;
  const o = postById(p.reply_to);
  return h('button', { type: 'button', class: 'quote', style: o ? '--h:' + hue(o.author) : null, onclick: e => { e.stopPropagation(); if (o) jumpTo(o.id); } },
    h('b', { text: o ? (o.author === me ? 'Toi' : nm(o.author)) : '' }), h('span', { text: snippet(o) }));
}

function bubble(p, cont) {
  const mine = p.author === me, sel = selected === p.id, atMe = !mine && (mentionsMe(p.text) || repliesToMe(p));
  const b = h('div', { class: 'bubble', role: 'button', tabindex: '0', 'aria-label': 'Message de ' + nm(p.author) + ', options',
    onclick: e => { if (e.target.closest('textarea,.btn,a,.mention,.photo,[data-uid]')) return; select(p.id); }, onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === b) { e.preventDefault(); select(p.id); } } });
  if (!mine && !cont) b.append(h('b', { class: 'author', style: '--h:' + hue(p.author), 'data-uid': p.author, text: nm(p.author) }));
  const q = quoteBox(p); if (q) b.append(q);
  if (p.image) b.append(photo(p));
  if (editing === p.id) {
    const ta = h('textarea', { id: 'e-' + p.id, rows: '3', maxlength: '500', 'aria-label': 'Modifier le message' }); ta.value = drafts['e-' + p.id] ?? p.text;
    ta.addEventListener('input', () => drafts['e-' + p.id] = ta.value);
    b.append(h('div', { class: 'stack-s edit' }, ta, h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => saveEdit(p, ta.value), text: 'Enregistrer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { editing = null; delete drafts['e-' + p.id]; queue(); }, text: 'Annuler' }))));
  } else {
    const meta = h('span', { class: 'meta', text: (p.pinned ? '📌 ' : '') + (p.edited_at ? 'modifié · ' : '') + hm.format(new Date(p.created_at)) });
    b.append(p.text ? h('p', { class: 'p-text' }, richText(p.text), meta) : h('div', { class: 'img-meta' }, meta));
  }
  if (p.image) b.classList.add('has-img');
  return h('div', { class: 'msg' + (mine ? ' mine' : '') + (cont ? ' cont' : '') + (atMe ? ' atme' : '') + (sel ? ' sel' : ''), 'data-id': p.id },
    !mine ? (cont ? h('span', { class: 'avspace' }) : avatar(p.author, 'sm', true)) : null,
    h('div', { class: 'mcol' }, b, rxBar(p), sel ? actionBar(p) : null));
}
function photo(p) {
  const u = imgUrls.get(p.image)?.url;
  return h('button', { type: 'button', class: 'photo', 'aria-label': 'Agrandir la photo de ' + nm(p.author), onclick: e => { e.stopPropagation(); if (u) openViewer(u); } },
    u ? h('img', { src: u, alt: 'Photo envoyée par ' + nm(p.author), loading: 'lazy', decoding: 'async' }) : h('span', { class: 'ph-wait', text: 'Photo…' }));
}
function openViewer(u) { $('viewer-img').src = u; const d = $('viewer'); if (!d.open) d.showModal(); }
// Adresses temporaires des photos (privées : visibles par les membres seulement).
async function signImages() {
  const paths = [...new Set([...posts, ...quoted.values()].map(p => p.image).filter(x => x && (!imgUrls.has(x) || Date.now() - imgUrls.get(x).at > 5 * 3600e3)))];
  if (!paths.length) return;
  const { data } = await sb.storage.from('photos').createSignedUrls(paths, 6 * 3600);
  (data || []).forEach(x => { if (x.signedUrl) imgUrls.set(x.path, { url: x.signedUrl, at: Date.now() }); });
  queue();
}
function sysPill(p) {
  const sel = selected === p.id;
  const line = { ok: ['✅ ', h('b', { text: nm(p.author) }), ' tient le jour ' + p.day], fail: ['🧊 ', h('b', { text: nm(p.author) }), ' avoue au jour ' + p.day + ' · honnête'], join: ['👋 ', h('b', { text: nm(p.author) }), ' entre sur le mur'] }[p.kind] || [snippet(p)];
  return h('div', { class: 'sysmsg' + (sel ? ' sel' : ''), 'data-id': p.id },
    h('button', { type: 'button', class: 'pill ' + p.kind, onclick: () => select(p.id) }, line, p.late ? h('span', { class: 'badge gold', text: 'après 23 h' }) : null, h('span', { class: 'meta', text: hm.format(new Date(p.created_at)) })),
    rxBar(p), sel ? actionBar(p) : null);
}
function groupPill(group, day) {
  const open = openGroups.has(day), n = group.length, late = group.filter(p => p.late).length;
  const names = group.map(p => p.author === me ? 'Toi' : nm(p.author));
  const who = n <= 3 ? names.slice(0, -1).join(', ') + ' et ' + names[n - 1] : names.slice(0, 2).join(', ') + ` et ${n - 2} autres`;
  const box = h('div', { class: 'sysmsg group', 'data-id': 'g' + day },
    h('button', { type: 'button', class: 'pill ok', 'aria-expanded': open ? 'true' : 'false', onclick: () => { open ? openGroups.delete(day) : openGroups.add(day); queue(); } },
      h('span', { class: 'stackav' }, group.slice(0, 3).map(p => avatar(p.author, 'xs'))), '✅ ', h('b', { text: who }), ` tiennent le jour ${day}`,
      late ? h('span', { class: 'badge gold', text: `${late} après 23 h` }) : null, h('span', { class: 'meta', text: hm.format(new Date(group[n - 1].created_at)) })));
  if (open) box.append(h('div', { class: 'glist' }, group.map(p => h('div', { class: 'grow', 'data-id': p.id }, avatar(p.author, 'sm'),
    h('div', { class: 'gname' }, h('b', { text: nm(p.author) }), ' ', h('span', { class: 'when', text: hm.format(new Date(p.created_at)) }), p.late ? h('span', { class: 'badge gold', text: 'après 23 h' }) : null),
    canContest(p) ? h('button', { class: 'linkbtn warn', type: 'button', onclick: () => contest(p), text: 'Contester' }) : null))));
  return box;
}
function contestCard(p) {
  const sel = selected === p.id;
  return h('div', { class: 'sysmsg' + (sel ? ' sel' : ''), 'data-id': p.id },
    h('article', { class: 'contest-card' },
      h('button', { type: 'button', class: 'c-head', onclick: () => select(p.id) }, '⚖️ ', h('b', { text: nm(p.author) }), ' conteste le jour ' + p.day + ' de ', h('b', { text: p.target === me ? 'toi' : nm(p.target) }), h('span', { class: 'meta', text: hm.format(new Date(p.created_at)) })),
      voteBox(contests.get(p.target + '_' + p.day))),
    rxBar(p), sel ? actionBar(p) : null);
}

/* ---------- saisie : réponse, mentions, envoi ---------- */
function mentionQuery() {
  const c = $('composer'), upto = c.value.slice(0, c.selectionStart), m = /(^|\s)@([^@\n]{0,24})$/u.exec(upto);
  return m ? { q: m[2], start: upto.length - m[2].length - 1 } : null;
}
function renderMentions() {
  const box = $('mention-list'), mq = mentionQuery();
  const cands = mq ? members().filter(id => id !== me && nm(id).toLowerCase().startsWith(mq.q.toLowerCase())).slice(0, 5) : [];
  box.hidden = !cands.length;
  box.replaceChildren(...cands.map(id => h('button', { type: 'button', role: 'option', onmousedown: e => e.preventDefault(), onclick: () => insertMention(nm(id)) }, avatar(id, 'xs'), '@' + nm(id))));
}
function insertMention(n) {
  const c = $('composer'), mq = mentionQuery(); if (!mq) return;
  const before = c.value.slice(0, mq.start), after = c.value.slice(c.selectionStart);
  c.value = before + '@' + n + ' ' + after; const pos = (before + '@' + n + ' ').length;
  c.focus(); c.setSelectionRange(pos, pos); composerChanged();
}
function composerChanged() {
  const c = $('composer');
  c.style.height = ''; if (c.offsetParent && c.value) c.style.height = Math.min(c.scrollHeight + 2, 150) + 'px';
  const n = c.value.length; $('ccount').hidden = n < 400; $('ccount').textContent = n + '/500';
  $('post-btn').disabled = !c.value.trim() && !pendingImg;
  if (c.value && room && Date.now() - lastTyping > 2500) { lastTyping = Date.now(); room.send({ type: 'broadcast', event: 'typing', payload: { id: me } }); }
  try { localStorage.setItem('nnn-draft', c.value); } catch (_) {}
  renderMentions();
}
async function sendMessage() {
  const c = $('composer'), t = c.value.trim(), img = pendingImg; if ((!t && !img) || busy) return;
  if (!gid) return;
  const row = { author: me, kind: 'text', text: t ? t.slice(0, 500) : null, group_id: gid };
  if (replyTo && postById(replyTo)) row.reply_to = replyTo;
  $('post-btn').classList.add('sending');
  const ok = await run(async () => {
    if (img) {
      const path = me + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
      const up = await sb.storage.from('photos').upload(path, img.blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
      if (up.error) return up;
      row.image = path; imgUrls.set(path, { url: img.url, at: Date.now() });
    }
    const res = await sb.from('posts').insert(row).select().single();
    if (!res.error && res.data) onPost({ eventType: 'INSERT', new: res.data });
    return res;
  }, null, false);
  $('post-btn').classList.remove('sending');
  if (ok) {
    c.value = ''; replyTo = null; pendingImg = null; renderImgBar(); stick = 'bottom'; composerChanged(); queue(); try { localStorage.removeItem('nnn-draft'); } catch (_) {}
    if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {}
  }
}
// Photo : réduite à 1600 px en JPEG avant l'envoi (rapide même en 4G).
async function shrink(file, max = 1600, q = 0.82) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image illisible')); i.src = URL.createObjectURL(file); }); }
  const w = src.width, hh = src.height, r = Math.min(1, max / Math.max(w, hh));
  const cv = document.createElement('canvas'); cv.width = Math.round(w * r); cv.height = Math.round(hh * r);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(src, 0, 0, cv.width, cv.height);
  return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('image')), 'image/jpeg', q));
}
async function pickPhoto(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) { toast('Choisis une image.'); return; }
  try {
    const blob = await shrink(file);
    if (blob.size > 6e6) { toast('Photo trop lourde.'); return; }
    if (pendingImg) URL.revokeObjectURL(pendingImg.url);
    pendingImg = { blob, url: URL.createObjectURL(blob) }; renderImgBar(); composerChanged(); $('composer').focus();
  } catch (_) { toast('Impossible de lire cette photo. Essaie une capture d\'écran ou une photo JPEG.'); }
}
function renderImgBar() {
  const bar = $('imgbar'); bar.hidden = !pendingImg;
  if (pendingImg) bar.replaceChildren(h('img', { src: pendingImg.url, alt: 'Photo à envoyer' }), h('span', { class: 'dim', text: 'Ajoute une légende si tu veux, puis envoie.' }),
    h('button', { type: 'button', class: 'x', 'aria-label': 'Retirer la photo', onclick: () => { URL.revokeObjectURL(pendingImg.url); pendingImg = null; renderImgBar(); composerChanged(); }, text: '✕' }));
}

function voteBox(c) {
  const box = h('div', { class: 'vote' });
  if (!c) { box.append(h('span', { class: 'dim', text: 'Contestation clôturée.' })); return box; }
  const state = contestState(c), t = tally(c), yes = t.yes, no = t.no, others = Math.max(1, t.others);
  const left = voteEnds(c) - Date.now(), timeUp = left <= 0;
  const canVote = votesOpen() && !timeUp && !banned.has(me) && gmembers.has(me) && joinedAt(me) <= new Date(c.created_at);
  box.append(h('div', { class: 'row-between' },
    h('b', { text: { open: 'Vote en cours', valid: 'Jour maintenu', invalid: 'Jour annulé' }[state] + (c.resolution ? ' par l\'organisateur' : '')
      + (state === 'open' && !timeUp ? ` · encore ${Math.floor(left / 3600e3)} h ${String(Math.floor(left % 3600e3 / 60e3)).padStart(2, '0')}` : '') }),
    h('span', { class: 'mono dim', text: `${yes} y croient · ${no} doutent · ${others} votants` })));
  box.append(h('div', { class: 'meter', title: 'Le trait central marque la majorité' }, h('i', { style: `width:${Math.min(100, Math.round(no / others * 100))}%` })));
  box.append(h('span', { class: 'dim', style: 'font-size:13px', text: timeUp ? 'Vote clos après 24 h : la majorité des votants a décidé (égalité = jour maintenu).' : 'Annulé tout de suite si plus de la moitié des votants possibles doutent. Sinon, au bout de 24 h, la majorité des votes décide.' }));
  if (me !== c.target && !c.resolution && !canVote) box.append(h('span', { class: 'dim', style: 'font-size:13px', text: timeUp || !votesOpen() ? 'Les votes sont clos.' : 'Tu as rejoint le groupe après l\'ouverture de cette contestation : tu ne votes pas.' }));
  if (me !== c.target && !c.resolution && canVote) {
    const mv = c.votes[me];
    box.append(h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost' + (mv === 'valid' ? ' sel' : ''), onclick: () => vote(c, 'valid'), text: 'Je le crois' }),
      h('button', { class: 'btn ghost' + (mv === 'invalid' ? ' sel' : ''), onclick: () => vote(c, 'invalid'), text: 'Je doute' })));
  }
  if (me === c.target && !c.resolution) box.append(h('span', { class: 'dim', style: 'font-size:13px', text: 'Tu ne votes pas sur ton propre jour. Défends-toi en répondant dans la discussion.' }));
  if (gadmin() && me !== c.target) box.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn ghost', onclick: () => resolve(c, 'valid'), text: 'Maintenir' }),
    h('button', { class: 'btn ghost', onclick: () => resolve(c, 'invalid'), text: 'Annuler le jour' }),
    c.resolution ? h('button', { class: 'btn ghost', onclick: () => resolve(c, null), text: 'Rendre au vote' }) : null));
  return box;
}

/* ---------- données ---------- */
async function loadAll() {
  if (!sb || !session) return;
  const [p, c, mg, ct, v, bn, vd, rp] = await Promise.all([
    sb.from('profiles').select('id,pseudo,created_at,avatar'),
    sb.from('checkins').select('user_id,day,status,late'),
    sb.from('group_members').select('group_id,role,groups(id,name,invite_code,owner)').eq('user_id', me),
    sb.from('contests').select('*'),
    sb.from('votes').select('*'),
    sb.from('banned').select('user_id'),
    sb.rpc('contest_verdicts'),
    sb.from('reports').select('*'),
  ]);
  myGroups = new Map((mg.data || []).filter(x => x.groups).map(x => [x.group_id, { ...x.groups, role: x.role }]));
  // Groupe affiché : celui demandé (lien, notification), sinon le dernier ouvert, sinon le premier.
  if (!myGroups.has(gid)) { const last = saved('nnn-group'); gid = myGroups.has(last) ? last : myGroups.keys().next().value || null; }
  if (gid) try { localStorage.setItem('nnn-group', gid); } catch (_) {}
  let po = { data: [] }, pin = { data: [] }, gm = { data: [] }, gb = { data: [] }, rd = { data: [] };
  if (gid) [po, pin, gm, gb, rd] = await Promise.all([
    sb.from('posts').select('*').eq('group_id', gid).order('created_at', { ascending: false }).limit(postLimit + 1),
    sb.from('posts').select('*').eq('group_id', gid).eq('pinned', true),
    sb.from('group_members').select('user_id,role,joined_at').eq('group_id', gid),
    sb.from('group_bans').select('user_id').eq('group_id', gid),
    sb.from('group_reads').select('user_id,seen_at').eq('group_id', gid),
  ]);
  const recent = po.data || [];
  morePosts = recent.length > postLimit;
  const loadedPosts = recent.slice(0, postLimit);
  (pin.data || []).forEach(x => { if (!loadedPosts.some(y => y.id === x.id)) loadedPosts.push(x); });
  const ids = loadedPosts.map(x => x.id);
  // Réactions des messages chargés, et messages plus anciens cités par une réponse.
  const missing = [...new Set(loadedPosts.map(x => x.reply_to).filter(id => id && !ids.includes(id)))];
  const [r, qt] = await Promise.all([
    ids.length ? sb.from('reactions').select('post_id,user_id,emoji').in('post_id', ids) : { data: [] },
    missing.length ? sb.from('posts').select('*').in('id', missing) : { data: [] },
  ]);
  const errs = [p, c, mg, po, pin, gm, r, qt, ct, v, bn, vd].map(x => x.error).filter(Boolean);
  if (errs.length) { console.error(errs); banner('Impossible de lire les données.', 'Recharge la page dans un instant.'); }
  profiles = new Map((p.data || []).map(x => [x.id, x]));
  banned = new Set((bn.data || []).map(x => x.user_id));
  gmembers = new Map((gm.data || []).map(x => [x.user_id, x]));
  gbans = new Set((gb.data || []).map(x => x.user_id));
  checkins = new Map(); (c.data || []).forEach(x => { if (!checkins.has(x.user_id)) checkins.set(x.user_id, {}); checkins.get(x.user_id)[x.day] = { status: x.status, late: x.late }; });
  posts = loadedPosts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  reactions = new Map(); (r.data || []).forEach(x => { if (!reactions.has(x.post_id)) reactions.set(x.post_id, {}); reactions.get(x.post_id)[x.user_id] = x.emoji; });
  quoted = new Map((qt.data || []).map(x => [x.id, x]));
  if (selected && !loadedPosts.some(x => x.id === selected)) selected = null;
  contests = new Map(); (ct.data || []).forEach(x => contests.set(x.target + '_' + x.day, { ...x, votes: {} }));
  (v.data || []).forEach(x => { const k = contests.get(x.target + '_' + x.day); if (k) k.votes[x.voter] = x.vote; });
  verdicts = new Map((vd.data || []).map(x => [x.target + '_' + x.day, x.state]));
  reads = new Map((rd.data || []).map(x => [x.user_id, +new Date(x.seen_at)]));
  reports = rp.data || [];
  loaded = true; joinRoom(); queue(); signImages();
}
let reloadT = null;
function scheduleReload() { clearTimeout(reloadT); reloadT = setTimeout(loadAll, 250); }
let channel = null;
function subscribe() {
  if (channel) return;
  channel = sb.channel('nnn');
  for (const t of ['profiles', 'banned', 'checkins', 'contests', 'votes', 'groups', 'group_members'])
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, scheduleReload);
  // Messages, réactions et « vu » : mis à jour sur place, sans tout recharger.
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, onPost);
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, onReaction);
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'group_reads' }, e => { if (e.new?.user_id && e.new.group_id === gid) { reads.set(e.new.user_id, +new Date(e.new.seen_at)); queue(); } });
  channel.subscribe(st => { if (st === 'SUBSCRIBED' && loaded) scheduleReload(); });
}
// Présence (en ligne) et « … écrit » : un salon par groupe.
let roomGid = null;
function joinRoom() {
  if (!sb || roomGid === gid) return;
  if (room) { try { sb.removeChannel(room); } catch (_) {} room = null; online = new Set(); typing.clear(); }
  roomGid = gid; if (!gid) return;
  room = sb.channel('nnn-room-' + gid, { config: { presence: { key: me } } });
  room.on('presence', { event: 'sync' }, () => { online = new Set(Object.keys(room.presenceState())); queue(); });
  room.on('broadcast', { event: 'typing' }, ({ payload }) => {
    const id = payload?.id; if (!id || id === me || !online.has(id)) return;
    clearTimeout(typing.get(id)); typing.set(id, setTimeout(() => { typing.delete(id); renderPresence(); }, 4000)); renderPresence();
  });
  room.subscribe(st => { if (st === 'SUBSCRIBED') room.track({ at: Date.now() }); });
}
function onPost(e) {
  if (e.eventType === 'DELETE') { const id = e.old?.id; if (!id) return scheduleReload(); posts = posts.filter(p => p.id !== id); if (selected === id) selected = null; queue(); return; }
  const p = e.new; if (!p?.id) return scheduleReload();
  if (p.group_id && p.group_id !== gid) { otherNews.add(p.group_id); queue(); return; }
  const i = posts.findIndex(x => x.id === p.id);
  if (i >= 0) posts[i] = { ...posts[i], ...p };
  else { posts.unshift(p); posts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); }
  if (typing.has(p.author)) { clearTimeout(typing.get(p.author)); typing.delete(p.author); }
  if (p.reply_to && !postById(p.reply_to)) scheduleReload();
  if (p.kind === 'contest') scheduleReload();
  if (p.image) signImages();
  queue();
}
function onReaction(e) {
  const r = e.eventType === 'DELETE' ? e.old : e.new; if (!r?.post_id) return scheduleReload();
  if (e.eventType !== 'DELETE' && !posts.some(p => p.id === r.post_id)) return;
  const rx = reactions.get(r.post_id) || {};
  if (e.eventType === 'DELETE') delete rx[r.user_id]; else rx[r.user_id] = r.emoji;
  reactions.set(r.post_id, rx); queue();
}

/* ---------- actions ---------- */
function friendly(e) {
  const m = (e && (e.message || e.error_description)) || '';
  if (/NNN_BAD_INVITE/.test(m)) return 'Ce lien d\'invitation n\'est plus valable. Demande-en un nouveau.';
  if (/NNN_GROUP_BANNED/.test(m)) return 'Tu as été retiré de ce groupe.';
  if (/NNN_GROUP_FULL/.test(m)) return 'Ce groupe est complet (200 membres).';
  if (/NNN_TOO_MANY_GROUPS/.test(m)) return 'Tu as déjà créé 5 groupes, c\'est le maximum.';
  if (/NNN_FORBIDDEN/.test(m)) return 'Seuls les organisateurs du groupe peuvent faire ça.';
  if (/NNN_SLOW/.test(m)) return 'Doucement : 8 messages par minute maximum. Réessaie dans un instant.';
  if (/NNN_BAD_PATH/.test(m)) return 'Photo refusée.';
  if (/Payload too large|exceeded the maximum/i.test(m)) return 'Photo trop lourde.';
  if (/NNN_BANNED/.test(m)) return 'Tu as été retiré du défi par l\'organisateur.';
  if (/duplicate key.*pseudo|profiles_pseudo_unique/i.test(m)) return 'Ce pseudo est déjà pris.';
  if (/row-level security|violates/i.test(m)) return 'Action refusée : elle ne respecte pas les règles du défi.';
  if (/duplicate key/i.test(m)) return 'C\'est déjà enregistré.';
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(m)) return 'Confirme d\'abord ton e-mail avec le lien reçu.';
  if (/already registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail. Connecte-toi.';
  if (/rate limit/i.test(m)) return 'Trop de tentatives. Réessaie dans quelques minutes.';
  if (/Password should be/i.test(m)) return 'Le mot de passe doit faire au moins 6 caractères.';
  if (/fetch|network/i.test(m)) return 'Pas de connexion. Vérifie ton réseau.';
  return m || 'Action impossible pour le moment.';
}
async function run(fn, ok, reload = true) {
  if (busy) return false; busy = true; queue();
  let success = false;
  try { const res = await fn(); if (res && res.error) throw res.error; success = true; if (ok) toast(ok); }
  catch (e) { console.error(e); toast(friendly(e)); }
  busy = false; if (reload || !success) await loadAll(); else queue(); return success;
}
async function mark(val) {
  const ph = phase(); if (ph.s !== 'live') return;
  const day = ph.day, cur = checkins.get(me)?.[day]?.status;
  if (cur === 'fail' || (val === 'ok' && cur === 'ok')) return;
  const done = await run(() => cur === 'ok'
    ? sb.from('checkins').update({ status: 'fail' }).eq('user_id', me).eq('day', day)
    : sb.from('checkins').insert({ user_id: me, day, status: val }),
    val === 'ok' ? 'Bâton ' + day + ' tracé. Tiens bon.' : 'C\'est noté. Respect pour ta franchise.');
  if (done) { freshStamp = true; confessOpen = false; oathOk = false; queue(); if (navigator.vibrate) try { navigator.vibrate(val === 'ok' ? 40 : [30, 60, 30]); } catch (_) {} }
}
function react(postId, e) {
  const rx = reactions.get(postId) || {}, mine = rx[me];
  if (mine === e) delete rx[me]; else rx[me] = e;
  reactions.set(postId, rx); queue();
  run(() => mine === e ? sb.from('reactions').delete().eq('post_id', postId).eq('user_id', me)
    : sb.from('reactions').upsert({ post_id: postId, user_id: me, emoji: e }, { onConflict: 'post_id,user_id' }), null, false);
}
async function saveEdit(p, text) {
  const t = text.trim(); if (!t) { toast('Le message ne peut pas être vide.'); return; }
  if (t === p.text) { editing = null; queue(); return; }
  if (await run(() => sb.from('posts').update({ text: t.slice(0, 500) }).eq('id', p.id), 'Message modifié')) { editing = null; delete drafts['e-' + p.id]; }
}
function pinPost(p) { run(() => sb.from('posts').update({ pinned: !p.pinned }).eq('id', p.id), p.pinned ? 'Message désépinglé' : 'Message épinglé en haut du fil'); }
async function delPost(id) {
  if (!confirm('Supprimer ce message pour tout le groupe ?')) return;
  const img = postById(id)?.image;
  if (await run(() => sb.from('posts').delete().eq('id', id), 'Message supprimé') && img) sb.storage.from('photos').remove([img]).then(() => {}, () => {});
}
async function contest(p) {
  const ok = await run(() => sb.from('contests').insert({ target: p.author, day: p.day, opened_by: me, group_id: gid }), 'Contestation ouverte. Le groupe vote.');
  if (ok) run(() => sb.from('votes').insert({ target: p.author, day: p.day, voter: me, vote: 'invalid' }));
}
function vote(c, v) { run(() => sb.from('votes').upsert({ target: c.target, day: c.day, voter: me, vote: v }, { onConflict: 'target,day,voter' })); }
function resolve(c, r) { run(() => sb.from('contests').update({ resolution: r }).eq('target', c.target).eq('day', c.day), r ? 'Décision enregistrée' : 'Rendu au vote'); }
function removeMember(id) {
  if (!confirm(`Retirer ${nm(id)} du défi ? Son historique reste visible, mais il ne pourra plus valider, écrire ni voter. Tu pourras le réintégrer.`)) return;
  run(() => sb.rpc('ban_member', { g: gid, u: id }), nm(id) + ' a été retiré du groupe');
}
function reinstate(id) { run(() => sb.rpc('unban_member', { g: gid, u: id }), nm(id) + ' peut revenir avec le lien d\'invitation'); }
function joinClub(pseudo) { return sb.rpc('join_club', { p_pseudo: pseudo }); }
function saved(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } }
function forget(...ks) { try { ks.forEach(k => localStorage.removeItem(k)); } catch (_) {} }

/* ---------- formulaires ---------- */
function banner(title, text) { const b = $('banner'); b.replaceChildren(h('b', { text: title + ' ' }), text); b.hidden = false; }
function setAuthMode(m) {
  authMode = m;
  $('tab-login').setAttribute('aria-selected', m === 'login'); $('tab-signup').setAttribute('aria-selected', m === 'signup');
  $('f-pseudo').hidden = m !== 'signup'; $('f-terms').hidden = m !== 'signup';
  $('forgot-btn').hidden = m === 'signup';
  $('in-pass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('auth-submit').textContent = m === 'signup' ? 'Créer mon compte' : 'Entrer';
  $('auth-msg').textContent = ''; $('auth-msg').className = 'form-msg';
}
$('tab-login').onclick = () => setAuthMode('login');
$('tab-signup').onclick = () => setAuthMode('signup');
$('auth-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!sb) return;
  const email = $('in-email').value.trim(), password = $('in-pass').value, pseudo = $('in-pseudo').value.trim();
  const msg = $('auth-msg'); msg.className = 'form-msg'; msg.textContent = '';
  if (!email || password.length < 6) { msg.textContent = 'Indique ton e-mail et un mot de passe de 6 caractères minimum.'; return; }
  if (authMode === 'signup' && pseudo.length < 2) { msg.textContent = 'Choisis un pseudo de 2 caractères minimum.'; return; }
  if (authMode === 'signup' && !$('in-terms').checked) { msg.textContent = 'Coche la case : le site est réservé aux 18 ans et plus.'; return; }
  $('auth-submit').disabled = true;
  try {
    if (authMode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
    } else {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { pseudo }, emailRedirectTo: location.origin } });
      if (error) throw error;
      try { localStorage.setItem('nnn-pseudo', pseudo); localStorage.setItem('nnn-terms', '1'); } catch (_) {}
      if (!data.session) { setAuthMode('login'); msg.className = 'form-msg ok'; msg.textContent = 'Compte créé. Ouvre le lien reçu par e-mail, puis connecte-toi ici.'; }
    }
  } catch (err) { msg.textContent = friendly(err); }
  $('auth-submit').disabled = false;
});
$('setup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pseudo = $('setup-pseudo').value.trim(), msg = $('setup-msg');
  msg.textContent = '';
  if (pseudo.length < 2) { msg.textContent = 'Choisis un pseudo de 2 caractères minimum.'; return; }
  if (!$('setup-terms').checked) { msg.textContent = 'Coche la case : le site est réservé aux 18 ans et plus.'; return; }
  $('setup-submit').disabled = true;
  const { error } = await joinClub(pseudo);
  $('setup-submit').disabled = false;
  if (error) { msg.textContent = friendly(error); return; }
  forget('nnn-pseudo');
  await loadAll(); toast('Bienvenue, ' + pseudo); await afterJoin();
});
$('composer').addEventListener('input', composerChanged);
$('composer').addEventListener('click', renderMentions);
$('composer').addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('mention-list').hidden) $('mention-list').hidden = true; else if (replyTo) { replyTo = null; queue(); } return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    const first = !$('mention-list').hidden && $('mention-list').querySelector('button');
    if (first) { e.preventDefault(); first.click(); return; }
    if (!matchMedia('(pointer: coarse)').matches) { e.preventDefault(); sendMessage(); }
  }
});
try { const d = localStorage.getItem('nnn-draft'); if (d) $('composer').value = d; } catch (_) {}
composerChanged(); $('mention-list').hidden = true;
$('composer-form').addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
// Garder le clavier ouvert : appuyer sur Envoyer ou sur ✕ ne fait pas perdre le focus de la saisie.
$('composer-form').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('tobottom').onclick = () => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); };
let scrollT = null;
window.addEventListener('scroll', () => { if (tab !== 'feed') return; clearTimeout(scrollT); scrollT = setTimeout(updateToBottom, 80); }, { passive: true });
document.addEventListener('click', e => { if (selected && !e.target.closest('.msg, .sysmsg')) { selected = null; queue(); } });
$('me-btn').onclick = ev => { ev.stopPropagation(); $('me-menu').hidden = !$('me-menu').hidden; };
document.addEventListener('click', ev => { if (!$('me-menu').contains(ev.target)) $('me-menu').hidden = true; });
$('rename-btn').onclick = async () => {
  $('me-menu').hidden = true;
  const cur = nm(me), next = (prompt('Ton nouveau pseudo (2 à 24 caractères) :', cur) || '').trim();
  if (!next || next === cur) return;
  if (next.length < 2 || next.length > 24) { toast('Le pseudo doit faire entre 2 et 24 caractères.'); return; }
  run(() => sb.from('profiles').update({ pseudo: next }).eq('id', me), 'Pseudo changé : ' + next);
};
/* ---------- groupes ---------- */
function inviteUrl(g) { return location.origin + '/?invite=' + g.invite_code; }
async function shareInvite() {
  const g = grp(); if (!g) return;
  const url = inviteUrl(g), text = `Rejoins « ${g.name} » sur NNN club : on tient le mur ensemble en novembre.`;
  if (navigator.share) { try { await navigator.share({ title: 'NNN club', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Lien d\'invitation copié'); } catch (_) { prompt('Copie ce lien et envoie-le :', url); }
}
function renderGroupBars() {
  const g = grp(), n = members().length, news = otherNews.size;
  const bar = () => g ? [
    h('button', { type: 'button', class: 'gname-btn', 'aria-label': 'Changer de groupe', onclick: () => openSheet({ type: 'groups' }) },
      h('b', { text: g.name }), h('span', { class: 'dim', text: `${n} membre${n > 1 ? 's' : ''}` }), news ? h('i', { class: 'gdot', title: 'Nouveaux messages dans un autre groupe' }) : null, h('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' })),
    h('button', { type: 'button', class: 'btn invite', onclick: shareInvite, text: 'Inviter' }),
    h('button', { type: 'button', class: 'gear', 'aria-label': 'Réglages du groupe', onclick: () => openSheet({ type: 'gsettings' }) }, '⚙')] : [];
  $('groupbar-feed').replaceChildren(...bar()); $('groupbar-board').replaceChildren(...bar());
  $('nogroup-feed').hidden = !!gid; if (!gid) $('nogroup-feed').replaceChildren(...noGroupPanel());
  document.querySelector('#v-feed .chat-top').hidden = $('feed').hidden = $('composer-form').hidden = !gid;
}
// Pas encore de groupe : en créer un ou en rejoindre un.
function noGroupPanel() {
  const name = h('input', { type: 'text', maxlength: '40', placeholder: 'Ex. Les moines de novembre', 'aria-label': 'Nom du groupe' });
  const code = h('input', { type: 'text', maxlength: '120', placeholder: 'Lien ou code d\'invitation', 'aria-label': 'Lien ou code d\'invitation' });
  return [h('p', { class: 'kicker', text: 'Ton groupe' }), h('h2', { class: 'h2', text: 'Tu fais le défi seul' }),
    h('p', { class: 'dim', text: 'Pour le faire avec des amis, crée un groupe et invite-les, ou rejoins le leur avec le lien qu\'ils t\'ont envoyé. Seuls les membres d\'un même groupe se voient entre eux.' }),
    h('form', { class: 'stack-s', onsubmit: e => { e.preventDefault(); createGroup(name.value); } }, h('label', { class: 'field' }, h('span', { text: 'Créer un groupe' }), name), h('button', { class: 'btn', type: 'submit', text: 'Créer le groupe' })),
    h('form', { class: 'stack-s', onsubmit: e => { e.preventDefault(); joinByCode(code.value); } }, h('label', { class: 'field' }, h('span', { text: 'Rejoindre un groupe' }), code), h('button', { class: 'btn ghost', type: 'submit', text: 'Rejoindre' }))];
}
function codeFrom(v) { v = (v || '').trim(); const m = /invite=([a-z0-9]+)/i.exec(v); return (m ? m[1] : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
async function switchGroup(id) {
  if (!myGroups.has(id) || id === gid) { closeSheet(); return; }
  gid = id; otherNews.delete(id); try { localStorage.setItem('nnn-group', id); } catch (_) {}
  posts = []; reactions = new Map(); reads = new Map(); gmembers = new Map(); selected = null; replyTo = null; editing = null; unreadMark = null; postLimit = 100;
  closeSheet(); stick = 'bottom'; loaded = false; queue(); await loadAll();
}
async function createGroup(name) {
  name = (name || '').trim();
  if (name.length < 2) { toast('Donne un nom de 2 caractères minimum à ton groupe.'); return; }
  let id = null;
  const ok = await run(async () => { const r = await sb.rpc('create_group', { p_name: name.slice(0, 40) }); id = r.data; return r; }, null, false);
  if (ok && id) { await loadAll(); await switchGroup(id); location.hash = 'feed'; goTab('feed'); toast('Groupe créé. Invite tes amis avec le bouton « Inviter ».'); }
}
async function joinByCode(v) {
  const code = codeFrom(v); if (!code) { toast('Colle le lien ou le code reçu.'); return; }
  let id = null;
  const ok = await run(async () => { const r = await sb.rpc('join_group', { p_code: code }); id = r.data; return r; }, null, false);
  if (ok && id) { await loadAll(); await switchGroup(id); location.hash = 'feed'; goTab('feed'); toast('Bienvenue dans « ' + (grp()?.name || 'le groupe') + ' »'); }
}
// Lien d'invitation : ?invite=code (gardé jusqu'à la connexion). ?g=id : ouvrir ce groupe (notifications).
(function readLinks() {
  const u = new URL(location.href), inv = u.searchParams.get('invite'), g = u.searchParams.get('g');
  if (inv) try { localStorage.setItem('nnn-invite', codeFrom(inv)); } catch (_) {}
  if (g) try { localStorage.setItem('nnn-group', g); } catch (_) {}
  if (inv || g) { u.searchParams.delete('invite'); u.searchParams.delete('g'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
})();
async function loadInvitePreview() {
  const code = saved('nnn-invite'); if (!code || !sb) return;
  const { data } = await sb.rpc('group_preview', { p_code: code });
  const g = Array.isArray(data) ? data[0] : data;
  pendingInvite = g ? { code, name: g.name, members: g.members } : null;
  if (!g) forget('nnn-invite');
  queue();
}
async function afterJoin() {
  const code = saved('nnn-invite'); if (!code || !profiles.has(me)) return;
  forget('nnn-invite'); pendingInvite = null;
  await joinByCode(code);
}
let pubStats = null;
async function renderLanding() {
  const ic = $('invite-card');
  ic.hidden = !pendingInvite;
  if (pendingInvite) ic.replaceChildren(h('p', { class: 'kicker', text: 'Invitation' }),
    h('p', {}, 'Tu es invité à rejoindre ', h('b', { text: '« ' + pendingInvite.name + ' »' }), ` (${pendingInvite.members} membre${pendingInvite.members > 1 ? 's' : ''}). Crée ton compte ou connecte-toi : tu y entreras directement.`));
  const ps = $('pub-stats');
  if (pubStats) {
    ps.hidden = false;
    ps.replaceChildren(...[[pubStats.participants, 'participants'], [pubStats.groups, 'groupes'], [pubStats.held_today, 'ont tenu aujourd\'hui']].map(([v, l]) => h('div', {}, h('b', { text: v }), h('span', { text: l }))));
  }
}
async function loadPublicStats() { if (!sb) return; const { data } = await sb.rpc('public_stats'); if (data) { pubStats = data; queue(); } }

function renderGroupsSheet() {
  const d = $('sheet');
  const list = [...myGroups.values()].sort((a, b) => a.name.localeCompare(b.name));
  const name = h('input', { type: 'text', maxlength: '40', placeholder: 'Nom du nouveau groupe', 'aria-label': 'Nom du nouveau groupe' });
  const code = h('input', { type: 'text', maxlength: '120', placeholder: 'Lien ou code d\'invitation', 'aria-label': 'Lien ou code d\'invitation' });
  d.replaceChildren(sheetHead('Mes groupes'),
    list.length ? h('div', { class: 'glist2' }, list.map(g => h('button', { type: 'button', class: 'opt' + (g.id === gid ? ' cur' : ''), 'aria-pressed': g.id === gid ? 'true' : 'false', onclick: () => switchGroup(g.id) },
      h('b', {}, g.name, otherNews.has(g.id) ? h('i', { class: 'gdot' }) : null), h('span', { text: { owner: 'Propriétaire', admin: 'Organisateur', member: 'Membre' }[g.role] })))) : h('p', { class: 'dim', text: 'Tu n\'as pas encore de groupe.' }),
    h('form', { class: 'row-form', onsubmit: e => { e.preventDefault(); closeSheet(); createGroup(name.value); } }, name, h('button', { class: 'btn', type: 'submit', text: 'Créer' })),
    h('form', { class: 'row-form', onsubmit: e => { e.preventDefault(); closeSheet(); joinByCode(code.value); } }, code, h('button', { class: 'btn ghost', type: 'submit', text: 'Rejoindre' })));
}
function renderGroupSettings() {
  const d = $('sheet'), g = grp(); if (!g) { closeSheet(); return; }
  const isOwner = g.owner === me, ga = gadmin();
  const kids = [sheetHead('Réglages du groupe')];
  if (ga) {
    const inp = h('input', { type: 'text', maxlength: '40', 'aria-label': 'Nom du groupe' }); inp.value = g.name;
    kids.push(h('form', { class: 'row-form', onsubmit: e => { e.preventDefault(); const v = inp.value.trim(); if (v.length >= 2 && v !== g.name) run(() => sb.from('groups').update({ name: v }).eq('id', g.id), 'Groupe renommé'); } }, inp, h('button', { class: 'btn ghost', type: 'submit', text: 'Renommer' })));
  } else kids.push(h('p', {}, h('b', { text: g.name })));
  kids.push(h('div', { class: 'stack-s' }, h('p', { class: 'kicker', text: 'Invitation' }), h('code', { class: 'invite-url', text: inviteUrl(g) }),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: shareInvite, text: 'Partager le lien' }),
      ga ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (confirm('Créer un nouveau lien ? L\'ancien ne marchera plus.')) run(async () => { const r = await sb.rpc('regen_invite', { g: g.id }); return r; }, 'Nouveau lien créé').then(() => renderSheet()); }, text: 'Nouveau lien' }) : null)));
  // Signalements du groupe
  if (ga) {
    const rs = groupReports();
    if (rs.length) kids.push(h('div', { class: 'stack-s' }, h('p', { class: 'kicker', text: 'Messages signalés' }), rs.map(reportRow)));
  }
  const ms = members().sort((a, b) => ({ owner: 0, admin: 1, member: 2 }[gmembers.get(a).role] - { owner: 0, admin: 1, member: 2 }[gmembers.get(b).role]) || nm(a).localeCompare(nm(b)));
  kids.push(h('div', { class: 'stack-s' }, h('p', { class: 'kicker', text: `Membres (${ms.length})` }), h('div', { class: 'mlist' }, ms.map(id => {
    const r = gmembers.get(id).role;
    return h('div', { class: 'mrow' }, avatar(id, 'sm', true), h('span', { class: 'mname' }, nm(id), r !== 'member' ? h('span', { class: 'badge ice', text: r === 'owner' ? 'Propriétaire' : 'Organisateur' }) : null),
      isOwner && id !== me ? h('button', { class: 'linkbtn ok', type: 'button', onclick: () => run(() => sb.rpc('set_member_role', { g: g.id, u: id, r: r === 'admin' ? 'member' : 'admin' }), r === 'admin' ? 'Organisateur retiré' : nm(id) + ' est organisateur').then(() => renderSheet()), text: r === 'admin' ? 'Retirer organisateur' : 'Nommer organisateur' }) : null,
      ga && id !== me && r !== 'owner' ? h('button', { class: 'linkbtn', type: 'button', onclick: () => { removeMember(id); setTimeout(renderSheet, 600); }, text: 'Retirer' }) : null);
  }))));
  const out = [...gbans].filter(id => profiles.has(id));
  if (ga && out.length) kids.push(h('div', { class: 'stack-s' }, h('p', { class: 'kicker', text: 'Retirés du groupe' }), out.map(id => h('div', { class: 'mrow' }, avatar(id, 'sm'), h('span', { class: 'mname', text: nm(id) }),
    h('button', { class: 'linkbtn ok', type: 'button', onclick: () => { reinstate(id); setTimeout(renderSheet, 600); }, text: 'Autoriser à revenir' })))));
  kids.push(h('button', { class: 'btn ghost danger-t', type: 'button', onclick: leaveGroup, text: 'Quitter le groupe' }));
  d.replaceChildren(...kids);
}
async function leaveGroup() {
  const g = grp(); if (!g) return;
  const alone = members().length <= 1;
  if (!confirm(alone ? `Tu es seul dans « ${g.name} ». Le quitter le supprime définitivement, avec ses messages. Continuer ?` : `Quitter « ${g.name} » ? Tu pourras revenir avec un lien d'invitation.` + (g.owner === me ? ' La propriété passera à un autre organisateur ou au plus ancien membre.' : ''))) return;
  if (await run(() => sb.rpc('leave_group', { g: g.id }), 'Tu as quitté le groupe', false)) { closeSheet(); gid = null; forget('nnn-group'); await loadAll(); }
}

/* ---------- signalements et modération ---------- */
async function reportPost(p) {
  const reason = prompt('Pourquoi signales-tu ce message ? (facultatif)\nLes organisateurs du groupe seront prévenus.', '');
  if (reason === null) return;
  run(() => sb.from('reports').insert({ post_id: p.id, reporter: me, reason: reason.trim().slice(0, 300) || null }), 'Merci, le message est signalé aux organisateurs.', false);
}
function groupReports() { const byPost = new Map(); reports.forEach(r => { const p = posts.find(x => x.id === r.post_id); if (p) (byPost.get(r.post_id) || byPost.set(r.post_id, { p, rs: [] }).get(r.post_id)).rs.push(r); }); return [...byPost.values()]; }
function reportRow({ p, rs }) {
  return h('div', { class: 'report' }, h('div', {}, h('b', { text: nm(p.author) }), ' : ', snippet(p)),
    h('span', { class: 'dim', text: `${rs.length} signalement${rs.length > 1 ? 's' : ''}` + (rs.some(r => r.reason) ? ' · « ' + rs.filter(r => r.reason).map(r => r.reason).join(' » « ') + ' »' : '') }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await run(() => sb.from('posts').delete().eq('id', p.id), 'Message supprimé')) renderSheet(); }, text: 'Supprimer le message' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { if (await run(() => sb.from('reports').delete().eq('post_id', p.id), 'Signalement classé')) renderSheet(); }, text: 'Garder' }),
      admin && p.author !== me ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => { if (confirm(`Suspendre le compte de ${nm(p.author)} sur tout le site ?`) && await run(() => sb.from('banned').insert({ user_id: p.author }), 'Compte suspendu')) renderSheet(); }, text: 'Suspendre l\'auteur' }) : null));
}
// Modération du site : tous les signalements, tous groupes confondus.
async function renderModSheet() {
  const d = $('sheet'), ids = [...new Set(reports.map(r => r.post_id))];
  const { data } = ids.length ? await sb.from('posts').select('*').in('id', ids) : { data: [] };
  if (sheetView?.type !== 'mod') return;
  const rows = (data || []).map(p => ({ p, rs: reports.filter(r => r.post_id === p.id) }));
  d.replaceChildren(sheetHead('Modération'), rows.length ? h('div', { class: 'stack-s' }, rows.map(reportRow)) : h('p', { class: 'dim', text: 'Aucun message signalé.' }));
}
$('groups-btn').onclick = () => { $('me-menu').hidden = true; openSheet({ type: 'groups' }); };
$('mod-btn').onclick = () => { $('me-menu').hidden = true; openSheet({ type: 'mod' }); };
async function deleteAccount() {
  const w = prompt('Supprimer ton compte efface définitivement ton profil, tes jours, tes messages et tes votes.\nÉcris SUPPRIMER pour confirmer :', '');
  if ((w || '').trim().toUpperCase() !== 'SUPPRIMER') return;
  if (await run(() => sb.rpc('delete_my_account'), null, false)) { closeSheet(); forget('nnn-group', 'nnn-seen', 'nnn-draft'); await sb.auth.signOut(); toast('Ton compte a été supprimé.'); }
}

/* ---------- fiche membre ---------- */
let sheetView = null;
const sinceFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: 'numeric', month: 'long' });
function openSheet(view) { sheetView = view; renderSheet(); const d = $('sheet'); if (!d.open) d.showModal(); }
function closeSheet() { const d = $('sheet'); if (d.open) d.close(); }
$('sheet').addEventListener('close', () => { sheetView = null; });
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });
function sheetHead(title) { return h('div', { class: 'sheet-head' }, h('h2', { class: 'h2', text: title }), h('button', { type: 'button', class: 'x', 'aria-label': 'Fermer', onclick: closeSheet, text: '✕' })); }
function renderSheet() {
  const d = $('sheet'); if (!sheetView) return;
  if (sheetView.type === 'notif') return renderNotifSheet();
  if (sheetView.type === 'groups') return renderGroupsSheet();
  if (sheetView.type === 'gsettings') return renderGroupSettings();
  if (sheetView.type === 'mod') return renderModSheet();
  const id = sheetView.id, pr = profiles.get(id); if (!pr) { closeSheet(); return; }
  const st = stat(id), isMe = id === me;
  const kids = [sheetHead(isMe ? 'Mon profil' : 'Profil'),
    h('div', { class: 'prof' }, avatar(id, 'xxl'), h('div', { class: 'prof-id' }, h('b', { text: pr.pseudo }),
      h('span', { class: 'dim', text: 'Sur le mur depuis le ' + sinceFmt.format(new Date(pr.created_at)) + (online.has(id) && !isMe ? ' · en ligne' : '') }),
      h('div', { class: 'badges' }, banned.has(id) ? h('span', { class: 'badge bad', text: 'Compte suspendu' }) : badges(st)))),
    h('div', { class: 'stats' }, [['Série en cours', st.cur], ['Jours tenus', st.ok], ['Meilleure série', st.best]].map(([l, v]) => h('div', { class: 'stat' }, h('b', { text: v }), h('span', { text: l })))),
    h('div', { class: 'wall' }, wall(st.cells))];
  if (isMe) {
    const inp = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: e => setAvatar(e.target.files[0]) });
    kids.push(h('div', { class: 'btn-row' },
      h('label', { class: 'btn' }, inp, pr.avatar ? 'Changer la photo' : 'Ajouter une photo'),
      pr.avatar ? h('button', { type: 'button', class: 'btn ghost', onclick: () => setAvatar(null), text: 'Retirer la photo' }) : null,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { closeSheet(); $('rename-btn').click(); }, text: 'Changer de pseudo' })),
      h('button', { type: 'button', class: 'textbtn danger-t', onclick: deleteAccount, text: 'Supprimer mon compte' }));
  } else if (!banned.has(id) && gmembers.has(id)) {
    kids.push(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: () => {
      closeSheet(); if (tab !== 'feed') { location.hash = 'feed'; goTab('feed'); }
      const c = $('composer'); c.value = (c.value ? c.value.replace(/\s*$/, ' ') : '') + '@' + pr.pseudo + ' '; composerChanged(); c.focus();
    }, text: 'Mentionner dans la discussion' })));
  }
  d.replaceChildren(...kids);
}
async function setAvatar(file) {
  const old = profiles.get(me)?.avatar;
  const ok = await run(async () => {
    let path = null;
    if (file) {
      const blob = await shrink(file, 512, 0.85);
      path = me + '/' + Date.now() + '.jpg';
      const up = await sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
      if (up.error) return up;
    }
    return sb.from('profiles').update({ avatar: path }).eq('id', me);
  }, file ? 'Photo de profil mise à jour' : 'Photo retirée');
  if (ok && old) sb.storage.from('avatars').remove([old]).then(() => {}, () => {});
  renderSheet();
}
// Avatars et pseudos cliquables : ouvrent la fiche du membre.
document.addEventListener('click', e => { const t = e.target.closest('[data-uid]'); if (t && profiles.has(t.dataset.uid)) { e.stopPropagation(); openSheet({ type: 'profile', id: t.dataset.uid }); } }, true);
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-uid][role=button]')) { e.preventDefault(); openSheet({ type: 'profile', id: e.target.dataset.uid }); } });
$('profile-btn').onclick = () => { $('me-menu').hidden = true; openSheet({ type: 'profile', id: me }); };

/* ---------- notifications ---------- */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64u(s) { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function currentPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription();
  if (!sub) return null;
  const { data } = await sb.from('push_subs').select('level').eq('endpoint', sub.endpoint).maybeSingle();
  return data ? data.level : null;
}
async function enablePush(level) {
  if (!pushSupported()) { toast(isIOS && !standalone() ? 'Sur iPhone, installe d\'abord l\'appli sur l\'écran d\'accueil.' : 'Ton navigateur ne gère pas les notifications.'); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications refusées. Autorise-les dans les réglages du navigateur.'); renderSheet(); return false; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
  const j = sub.toJSON();
  const ok = await run(() => sb.from('push_subs').upsert({ endpoint: j.endpoint, user_id: me, p256dh: j.keys.p256dh, auth: j.keys.auth, level }, { onConflict: 'endpoint' }),
    level === 'all' ? 'Notifications activées pour tous les messages' : 'Notifications activées', false);
  renderSheet(); queue(); return ok;
}
async function disablePush() {
  const reg = pushSupported() && await navigator.serviceWorker.getRegistration(), sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await sb.from('push_subs').delete().eq('endpoint', sub.endpoint); try { await sub.unsubscribe(); } catch (_) {} }
  toast('Notifications coupées sur cet appareil'); renderSheet();
}
async function renderNotifSheet() {
  const d = $('sheet'), lvl = await currentPush(); if (sheetView?.type !== 'notif') return;
  let state;
  if (!pushSupported()) state = isIOS && !standalone() ? 'Sur iPhone, les notifications marchent seulement depuis l\'appli installée : Safari, bouton Partager, « Sur l\'écran d\'accueil », puis ouvre l\'appli et reviens ici.' : 'Ce navigateur ne gère pas les notifications.';
  else if (Notification.permission === 'denied') state = 'Les notifications sont bloquées pour ce site. Autorise-les dans les réglages du navigateur, puis reviens ici.';
  else state = lvl === 'all' ? 'Activées : tous les messages.' : lvl ? 'Activées : seulement l\'important.' : 'Désactivées sur cet appareil.';
  const opt = (k, title, sub) => h('button', { type: 'button', class: 'opt', 'aria-pressed': lvl === k ? 'true' : 'false', disabled: !pushSupported() || Notification.permission === 'denied', onclick: () => enablePush(k) }, h('b', { text: title }), h('span', { text: sub }));
  d.replaceChildren(sheetHead('Notifications'), h('p', { class: 'dim', text: state }),
    opt('important', 'L\'important seulement', 'Rappel à 21 h et 23 h si tu n\'as pas validé, mentions, réponses à tes messages, contestations.'),
    opt('all', 'Tous les messages', 'L\'important, plus chaque message du groupe.'),
    lvl ? h('button', { type: 'button', class: 'btn ghost', onclick: disablePush, text: 'Couper sur cet appareil' }) : null);
}
$('notif-btn').onclick = () => { $('me-menu').hidden = true; openSheet({ type: 'notif' }); };
$('notif-yes').onclick = () => enablePush('important');
$('notif-later').onclick = () => { try { localStorage.setItem('nnn-notif-later', String(Date.now())); } catch (_) {} queue(); };
function renderNotifCta(hasProfile) {
  const later = +(saved('nnn-notif-later') || 0);
  $('notif-cta').hidden = !(hasProfile && tab === 'today' && pushSupported() && Notification.permission === 'default' && Date.now() - later > 3 * 864e5);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { const go = e.data?.go, g = e.data?.g; if (g && g !== gid && myGroups.has(g)) switchGroup(g); if (go && ['today', 'board', 'feed'].includes(go)) { location.hash = go; } });

// Photos dans la discussion
$('photo-in').addEventListener('change', e => { pickPhoto(e.target.files[0]); e.target.value = ''; });
$('viewer').addEventListener('click', e => { if (e.target === $('viewer') || e.target.id === 'viewer-img') $('viewer').close(); });

// Installation en appli : bouton natif (Android, Chrome) ou mode d'emploi (iPhone).
let installEvt = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('install-btn').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('install-btn').hidden = true; toast('Appli installée.'); });
if (isIOS && !standalone()) $('install-btn').hidden = false;
$('install-btn').onclick = async () => {
  $('me-menu').hidden = true;
  if (installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (_) {} installEvt = null; $('install-btn').hidden = true; return; }
  alert('Sur iPhone : ouvre ce site dans Safari, touche le bouton Partager (carré avec une flèche), puis « Sur l\'écran d\'accueil ».');
};
if ('serviceWorker' in navigator && location.protocol === 'https:') window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
$('share-btn').onclick = shareRecap;
$('logout-btn').onclick = async () => { $('me-menu').hidden = true; await sb.auth.signOut(); };
function goTab(t) { if (t !== 'feed' || tab !== 'feed') { unreadMark = null; selected = null; } tab = t; window.scrollTo(0, 0); queue(); if (t === 'feed') requestAnimationFrame(() => requestAnimationFrame(composerChanged)); }
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => { const t = b.dataset.tab; if (location.hash.slice(1) !== t) location.hash = t; goTab(t); }));
function fromHash() { const t = location.hash.slice(1); if (['today', 'board', 'feed'].includes(t) && t !== tab) goTab(t); }
window.addEventListener('hashchange', fromHash);

$('forgot-btn').addEventListener('click', async () => {
  if (!sb) return;
  const email = $('in-email').value.trim(), msg = $('auth-msg'); msg.className = 'form-msg';
  if (!email) { msg.textContent = 'Indique ton e-mail ci-dessus, puis clique à nouveau sur « Mot de passe oublié ».'; return; }
  $('forgot-btn').disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  $('forgot-btn').disabled = false;
  if (error) { msg.textContent = friendly(error); return; }
  msg.className = 'form-msg ok'; msg.textContent = 'Si un compte existe avec cet e-mail, un lien pour changer le mot de passe vient d\'être envoyé.';
});
$('reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const password = $('reset-pass').value, msg = $('reset-msg'); msg.textContent = '';
  if (password.length < 6) { msg.textContent = 'Le mot de passe doit faire au moins 6 caractères.'; return; }
  $('reset-submit').disabled = true;
  const { error } = await sb.auth.updateUser({ password });
  $('reset-submit').disabled = false;
  if (error) { msg.textContent = friendly(error); return; }
  recovery = false; $('reset-pass').value = ''; toast('Mot de passe changé.'); queue();
});

/* ---------- démarrage ---------- */
async function onSession(sess) {
  session = sess; me = sess?.user?.id || null; admin = false; loaded = false;
  if (!sess) { profiles = new Map(); banned = new Set(); myGroups = new Map(); gid = null; otherNews.clear(); recovery = false; joinRoom(); queue(); loadInvitePreview(); loadPublicStats(); return; }
  const pre = saved('nnn-pseudo') || sess.user.user_metadata?.pseudo || '';
  $('setup-pseudo').value = pre; $('setup-msg').textContent = '';
  const { data } = await sb.rpc('is_admin'); admin = !!data;
  await loadAll();
  // inscription sans confirmation d'e-mail : on crée le profil tout de suite si un pseudo a été donné
  if (!profiles.has(me) && pre.length >= 2) {
    const { error } = await joinClub(pre);
    if (!error) { forget('nnn-pseudo'); await loadAll(); }
    else { $('setup-msg').textContent = friendly(error); queue(); }
  }
  subscribe();
  if (profiles.has(me)) afterJoin();
}
fromHash(); setAuthMode('login');
if (!sb) {
  banner('Configuration manquante.', 'Renseigne l\'URL et la clé publique Supabase dans config.js, puis redéploie.');
  $('auth-submit').disabled = true; queue();
} else {
  sb.auth.getSession().then(({ data }) => onSession(data.session));
  sb.auth.onAuthStateChange((ev, sess) => { if (ev === 'PASSWORD_RECOVERY') { recovery = true; queue(); } if (ev === 'SIGNED_IN' && sess?.user?.id === me) return; if (ev === 'TOKEN_REFRESHED') { session = sess; return; } onSession(sess); });
}
let lastDay = phase().day;
setInterval(() => { const d = phase().day; if (d !== lastDay) { lastDay = d; oathOk = false; confessOpen = false; } if (session && tab === 'today' && !document.activeElement?.closest?.('#hero')) queue(); else if (session) renderRemind(profiles.has(me) && !banned.has(me) && !recovery); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) loadAll(); });
})();
