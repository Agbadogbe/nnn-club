/* Club No Nut November — logique du site (Supabase) */
(() => {
const YEAR = 2026, MONTH = 11, N = 30, TZ = 'Europe/Paris';
const EMOJIS = ['🔥', '💪', '😂', '🫡'];
const $ = id => document.getElementById(id);

const cfg = window.NNN_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes('XXXX');
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

/* ---------- état ---------- */
let session = null, me = null, admin = false, loaded = false;
let profiles = new Map();            // id -> {pseudo, created_at}
let banned = new Set();              // membres retirés par l'organisateur (historique conservé)
let recovery = false;                // ouverture depuis le lien « mot de passe oublié »
let checkins = new Map();            // id -> {day: {status, late}}
let contests = new Map();            // "uid_day" -> {target, day, resolution, opened_by, votes:{voter:vote}}
let posts = [], reactions = new Map(), comments = [];
const openComments = new Set(), drafts = {};
let busy = false, oathOk = false, confessOpen = false, freshStamp = false;
let tab = 'today', lastSeenPost = 0;
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
function members() { return [...profiles.keys()].filter(id => !banned.has(id)); }
// Contestations et votes ouverts pendant novembre et le 1er décembre (comme nnn_votes_open() côté serveur).
// Votants d'une contestation : membres actifs inscrits avant son ouverture, hors personne contestée.
// Un compte créé après l'ouverture ne compte pas ; un compte retiré par l'organisateur perd sa voix.
function electors(c) { const t0 = new Date(c.created_at); return members().filter(id => id !== c.target && new Date(profiles.get(id).created_at) <= t0); }
function tally(c) { const el = new Set(electors(c)); let yes = 0, no = 0; for (const [v, x] of Object.entries(c.votes)) { if (!el.has(v)) continue; x === 'invalid' ? no++ : yes++; } return { yes, no, others: el.size }; }
function votesOpen() { const p = paris(); return p.y === YEAR && (p.m === MONTH || (p.m === MONTH + 1 && p.d === 1)); }
function hue(id) { let x = 2166136261; for (const c of String(id)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } return Math.round((x % 12) * 30); }
function avatar(id, cls = '') {
  const n = nm(id).trim(); const ini = n.split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?';
  return h('span', { class: 'avatar ' + cls, style: '--h:' + hue(id), 'aria-hidden': 'true', text: ini });
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }
function rand(seed) { let x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }

/* ---------- calculs ---------- */
function contestState(c) {
  if (!c) return null;
  if (c.resolution) return c.resolution;
  const { yes, no, others } = tally(c);
  if (others > 0 && no * 2 > others) return 'invalid';
  if (others > 0 && yes * 2 >= others) return 'valid';
  return 'open';
}
function stat(uid) {
  const ph = phase(), days = checkins.get(uid) || {};
  let ok = 0, run = 0, best = 0, out = null; const cells = [];
  for (let d = 1; d <= N; d++) {
    let st;
    if (d > ph.last) st = 'future';
    else {
      const v = days[d]?.status;
      if (v === 'ok' && contestState(contests.get(uid + '_' + d)) === 'invalid') st = 'voided';
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
function ranked() {
  return members().map(id => ({ id, st: stat(id) }))
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
  $('me-btn').hidden = !authed;
  for (const t of ['today', 'board', 'feed']) $('v-' + t).hidden = !hasProfile || tab !== t;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  if (authed) { $('me-av').replaceWith(Object.assign(avatar(me), { id: 'me-av' })); $('me-name').textContent = hasProfile ? nm(me) : (session.user.email || ''); }
  if (!authed) renderPoster();
  if (hasProfile) { renderToday(); renderBoard(); renderFeed(); }
  if (aeId) { const n = $(aeId); if (n && n !== document.activeElement) { n.focus(); if (sel) try { n.setSelectionRange(...sel); } catch (_) {} } }
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
  const r = ranked(), alive = r.filter(x => !x.st.out).length;
  $('lb-sum').textContent = `${alive} en lice / ${r.length}`;
  const order = [1, 0, 2];
  $('podium').replaceChildren(...order.map(i => {
    const x = r[i];
    if (!x) return h('div', { class: 'pod empty' });
    return h('div', { class: 'pod p' + (i + 1) }, h('span', { class: 'place', text: ['1er', '2e', '3e'][i] }), avatar(x.id, 'xl'), h('span', { class: 'nm', text: nm(x.id) }),
      h('div', { class: 'block' }, h('b', { text: x.st.cur }), h('span', { text: 'jours de série' })));
  }));
  const lb = $('lb'); lb.replaceChildren();
  if (!r.length) lb.append(h('div', { class: 'empty', text: 'Personne sur le mur pour l\'instant.' }));
  r.forEach((x, i) => lb.append(h('div', { class: 'lb-row' },
    h('span', { class: 'rank', text: i + 1 }), avatar(x.id),
    h('div', { class: 'lb-name' }, h('b', { text: nm(x.id) + (x.id === me ? ' (toi)' : '') }), h('div', { class: 'badges' }, badges(x.st)),
      admin && x.id !== me ? h('button', { class: 'linkbtn', onclick: () => removeMember(x.id), text: 'Retirer du défi' }) : null),
    h('div', { class: 'lb-score' }, h('b', { text: x.st.cur }), h('small', { text: x.st.ok + ' au total' })))));
  const out = [...banned].filter(id => profiles.has(id));
  if (out.length) lb.append(h('div', { class: 'retired' }, h('span', { class: 'dim', text: 'Retirés du défi :' }),
    out.map(id => h('span', { class: 'badge bad' }, nm(id),
      admin ? h('button', { class: 'linkbtn ok', style: 'margin:0 0 0 6px', onclick: () => reinstate(id), text: 'réintégrer' }) : null))));
  const g = $('grid'); g.replaceChildren();
  if (!r.length) return;
  const head = h('tr', {}, h('th', { class: 'nm' }));
  for (let d = 1; d <= N; d++) head.append(h('th', { text: d }));
  const tb = h('tbody');
  r.forEach(x => { const tr = h('tr', {}, h('th', { class: 'nm', text: nm(x.id) })); x.st.cells.forEach((c, i) => tr.append(h('td', { class: c, title: nm(x.id) + ' · jour ' + (i + 1) }))); tb.append(tr); });
  g.append(h('thead', {}, head), tb);
}

function renderFeed() {
  const f = $('feed'); f.replaceChildren();
  if (tab === 'feed' && posts[0]) lastSeenPost = Math.max(lastSeenPost, +new Date(posts[0].created_at));
  $('feed-dot').hidden = tab === 'feed' || !posts[0] || +new Date(posts[0].created_at) <= lastSeenPost || posts[0].author === me;
  if (!posts.length) { f.append(h('div', { class: 'empty', text: loaded ? 'Le fil est vide. Lance la discussion ou trace ton premier bâton pour l\'annoncer.' : 'Chargement du fil…' })); return; }
  const byPost = {}; comments.forEach(c => (byPost[c.post_id] ||= []).push(c));
  for (const p of posts) {
    const sys = p.kind !== 'text', isC = p.kind === 'contest';
    let line = null;
    if (p.kind === 'ok') line = [h('b', { text: nm(p.author) }), h('span', { class: 'big ok', text: 'tient le jour ' + p.day }), p.late ? h('span', { class: 'badge gold', text: 'après 23 h' }) : null];
    if (p.kind === 'fail') line = [h('b', { text: nm(p.author) }), h('span', { class: 'big bad', text: 'avoue au jour ' + p.day }), h('span', { class: 'badge ice', text: 'Honnête' })];
    if (p.kind === 'join') line = [h('b', { text: nm(p.author) }), h('span', { class: 'big ice', text: 'entre sur le mur' })];
    if (isC) line = [h('b', { text: nm(p.author) }), h('span', { class: 'big gold', text: 'conteste' }), 'le jour ' + p.day + ' de', h('b', { text: nm(p.target) })];
    const card = h('article', { class: 'post' + (sys && !isC ? ' sys' : '') + (isC ? ' contest' : '') },
      h('div', { class: 'p-head' }, avatar(p.author), h('div', { class: 'who' }, sys ? h('div', { class: 'sysline' }, line) : h('b', { text: nm(p.author) }), h('div', { class: 'when', text: when(p.created_at) }))));
    if (p.kind === 'text') card.append(h('p', { class: 'p-text', text: p.text }));
    if (isC) card.append(voteBox(contests.get(p.target + '_' + p.day)));
    const rx = reactions.get(p.id) || {}, counts = {}; Object.values(rx).forEach(e => counts[e] = (counts[e] || 0) + 1);
    card.append(h('div', { class: 'reacts' }, EMOJIS.map(e => h('button', { class: 'react', 'aria-pressed': rx[me] === e ? 'true' : 'false', 'aria-label': 'Réagir ' + e, onclick: () => react(p.id, e) }, e, counts[e] ? h('small', { text: counts[e] }) : null))));
    const cs = (byPost[p.id] || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const open = openComments.has(p.id);
    const acts = h('div', { class: 'actions' }, h('button', { onclick: () => { open ? openComments.delete(p.id) : openComments.add(p.id); queue(); }, text: cs.length ? `${cs.length} commentaire${cs.length > 1 ? 's' : ''}` : 'Commenter' }));
    const okNow = p.kind === 'ok' && checkins.get(p.author)?.[p.day]?.status === 'ok';
    if (okNow && votesOpen() && p.author !== me && !banned.has(p.author) && !contests.has(p.author + '_' + p.day)) acts.append(h('button', { class: 'warn', onclick: () => contest(p), text: 'Contester' }));
    if ((p.kind === 'text' && p.author === me) || admin) acts.append(h('button', { class: 'del', onclick: () => delPost(p.id), text: 'Supprimer' }));
    card.append(acts);
    if (open) {
      const box = h('div', { class: 'comments' });
      cs.forEach(c => box.append(h('div', { class: 'cmt' }, avatar(c.author, 'sm'), h('div', {}, h('b', { text: nm(c.author) }), c.text,
        (c.author === me || admin) ? h('button', { class: 'linkbtn', style: 'margin-left:8px', onclick: () => run(() => sb.from('comments').delete().eq('id', c.id)), text: 'suppr.' }) : null))));
      const inp = h('input', { type: 'text', id: 'c-' + p.id, maxlength: '300', placeholder: 'Ton commentaire…', 'aria-label': 'Commentaire' });
      inp.value = drafts[p.id] || ''; inp.addEventListener('input', () => drafts[p.id] = inp.value);
      box.append(h('form', { class: 'cform', onsubmit: e => { e.preventDefault(); addComment(p.id, inp); } }, inp, h('button', { class: 'btn', type: 'submit', text: 'Envoyer' })));
      card.append(box);
    }
    f.append(card);
  }
}

function voteBox(c) {
  const box = h('div', { class: 'vote' });
  if (!c) { box.append(h('span', { class: 'dim', text: 'Contestation clôturée.' })); return box; }
  const state = contestState(c), t = tally(c), yes = t.yes, no = t.no, others = Math.max(1, t.others);
  const canVote = votesOpen() && !banned.has(me) && new Date(profiles.get(me)?.created_at || 0) <= new Date(c.created_at);
  box.append(h('div', { class: 'row-between' },
    h('b', { text: { open: 'Vote en cours', valid: 'Jour maintenu', invalid: 'Jour annulé' }[state] + (c.resolution ? ' par l\'organisateur' : '') }),
    h('span', { class: 'mono dim', text: `${yes} y croient · ${no} doutent · ${others} votants` })));
  box.append(h('div', { class: 'meter', title: 'Le trait central marque la majorité' }, h('i', { style: `width:${Math.min(100, Math.round(no / others * 100))}%` })));
  box.append(h('span', { class: 'dim', style: 'font-size:13px', text: 'Le jour est annulé si plus de la moitié des autres membres doutent.' }));
  if (me !== c.target && !c.resolution && !canVote) box.append(h('span', { class: 'dim', style: 'font-size:13px', text: votesOpen() ? 'Tu as rejoint le groupe après l\'ouverture de cette contestation : tu ne votes pas.' : 'Les votes sont clos.' }));
  if (me !== c.target && !c.resolution && canVote) {
    const mv = c.votes[me];
    box.append(h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost' + (mv === 'valid' ? ' sel' : ''), onclick: () => vote(c, 'valid'), text: 'Je le crois' }),
      h('button', { class: 'btn ghost' + (mv === 'invalid' ? ' sel' : ''), onclick: () => vote(c, 'invalid'), text: 'Je doute' })));
  }
  if (me === c.target && !c.resolution) box.append(h('span', { class: 'dim', style: 'font-size:13px', text: 'Tu ne votes pas sur ton propre jour. Défends-toi en commentaire.' }));
  if (admin && me !== c.target) box.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn ghost', onclick: () => resolve(c, 'valid'), text: 'Maintenir' }),
    h('button', { class: 'btn ghost', onclick: () => resolve(c, 'invalid'), text: 'Annuler le jour' }),
    c.resolution ? h('button', { class: 'btn ghost', onclick: () => resolve(c, null), text: 'Rendre au vote' }) : null));
  return box;
}

/* ---------- données ---------- */
async function loadAll() {
  if (!sb || !session) return;
  const [p, c, po, r, cm, ct, v, bn] = await Promise.all([
    sb.from('profiles').select('id,pseudo,created_at'),
    sb.from('checkins').select('user_id,day,status,late'),
    sb.from('posts').select('*').order('created_at', { ascending: false }).limit(150),
    sb.from('reactions').select('post_id,user_id,emoji'),
    sb.from('comments').select('*').order('created_at', { ascending: false }).limit(500),
    sb.from('contests').select('*'),
    sb.from('votes').select('*'),
    sb.from('banned').select('user_id'),
  ]);
  const errs = [p, c, po, r, cm, ct, v, bn].map(x => x.error).filter(Boolean);
  if (errs.length) { console.error(errs); banner('Impossible de lire les données.', 'Vérifie que le script schema.sql a bien été exécuté dans Supabase.'); }
  profiles = new Map((p.data || []).map(x => [x.id, x]));
  banned = new Set((bn.data || []).map(x => x.user_id));
  checkins = new Map(); (c.data || []).forEach(x => { if (!checkins.has(x.user_id)) checkins.set(x.user_id, {}); checkins.get(x.user_id)[x.day] = { status: x.status, late: x.late }; });
  posts = po.data || [];
  reactions = new Map(); (r.data || []).forEach(x => { if (!reactions.has(x.post_id)) reactions.set(x.post_id, {}); reactions.get(x.post_id)[x.user_id] = x.emoji; });
  comments = cm.data || [];
  contests = new Map(); (ct.data || []).forEach(x => contests.set(x.target + '_' + x.day, { ...x, votes: {} }));
  (v.data || []).forEach(x => { const k = contests.get(x.target + '_' + x.day); if (k) k.votes[x.voter] = x.vote; });
  loaded = true; queue();
}
let reloadT = null;
function scheduleReload() { clearTimeout(reloadT); reloadT = setTimeout(loadAll, 250); }
let channel = null;
function subscribe() {
  if (channel) return;
  channel = sb.channel('nnn');
  for (const t of ['profiles', 'banned', 'checkins', 'posts', 'reactions', 'comments', 'contests', 'votes'])
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, scheduleReload);
  channel.subscribe();
}

/* ---------- actions ---------- */
function friendly(e) {
  const m = (e && (e.message || e.error_description)) || '';
  if (/NNN_BANNED/.test(m)) return 'Tu as été retiré du défi par l\'organisateur.';
  if (/duplicate key.*pseudo|profiles_pseudo_unique/i.test(m)) return 'Ce pseudo est déjà pris.';
  if (/row-level security|violates/i.test(m)) return 'Action refusée : elle ne respecte pas les règles du défi.';
  if (/duplicate key.*pseudo|profiles_pseudo_unique/i.test(m)) return 'Ce pseudo est déjà pris.';
  if (/duplicate key/i.test(m)) return 'C\'est déjà enregistré.';
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(m)) return 'Confirme d\'abord ton e-mail avec le lien reçu.';
  if (/already registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail. Connecte-toi.';
  if (/rate limit/i.test(m)) return 'Trop de tentatives. Réessaie dans quelques minutes.';
  if (/Password should be/i.test(m)) return 'Le mot de passe doit faire au moins 6 caractères.';
  if (/fetch|network/i.test(m)) return 'Pas de connexion. Vérifie ton réseau.';
  return m || 'Action impossible pour le moment.';
}
async function run(fn, ok) {
  if (busy) return false; busy = true; queue();
  let success = false;
  try { const res = await fn(); if (res && res.error) throw res.error; success = true; if (ok) toast(ok); }
  catch (e) { console.error(e); toast(friendly(e)); }
  busy = false; await loadAll(); return success;
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
  const mine = (reactions.get(postId) || {})[me];
  run(() => mine === e ? sb.from('reactions').delete().eq('post_id', postId).eq('user_id', me)
    : sb.from('reactions').upsert({ post_id: postId, user_id: me, emoji: e }, { onConflict: 'post_id,user_id' }));
}
async function addComment(postId, inp) {
  const t = inp.value.trim(); if (!t) return;
  if (await run(() => sb.from('comments').insert({ post_id: postId, author: me, text: t.slice(0, 300) }))) { drafts[postId] = ''; }
}
function delPost(id) { run(() => sb.from('posts').delete().eq('id', id), 'Message supprimé'); }
async function contest(p) {
  const ok = await run(() => sb.from('contests').insert({ target: p.author, day: p.day, opened_by: me }), 'Contestation ouverte. Le groupe vote.');
  if (ok) run(() => sb.from('votes').insert({ target: p.author, day: p.day, voter: me, vote: 'invalid' }));
}
function vote(c, v) { run(() => sb.from('votes').upsert({ target: c.target, day: c.day, voter: me, vote: v }, { onConflict: 'target,day,voter' })); }
function resolve(c, r) { run(() => sb.from('contests').update({ resolution: r }).eq('target', c.target).eq('day', c.day), r ? 'Décision enregistrée' : 'Rendu au vote'); }
function removeMember(id) {
  if (!confirm(`Retirer ${nm(id)} du défi ? Son historique reste visible, mais il ne pourra plus valider, écrire ni voter. Tu pourras le réintégrer.`)) return;
  run(() => sb.from('banned').insert({ user_id: id }), nm(id) + ' a été retiré du défi');
}
function reinstate(id) { run(() => sb.from('banned').delete().eq('user_id', id), nm(id) + ' est de retour dans le défi'); }
function joinClub(pseudo) { return sb.rpc('join_club', { p_pseudo: pseudo }); }
function saved(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } }
function forget(...ks) { try { ks.forEach(k => localStorage.removeItem(k)); } catch (_) {} }

/* ---------- formulaires ---------- */
function banner(title, text) { const b = $('banner'); b.replaceChildren(h('b', { text: title + ' ' }), text); b.hidden = false; }
function setAuthMode(m) {
  authMode = m;
  $('tab-login').setAttribute('aria-selected', m === 'login'); $('tab-signup').setAttribute('aria-selected', m === 'signup');
  $('f-pseudo').hidden = m !== 'signup';
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
  $('auth-submit').disabled = true;
  try {
    if (authMode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
    } else {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { pseudo }, emailRedirectTo: location.origin } });
      if (error) throw error;
      try { localStorage.setItem('nnn-pseudo', pseudo); } catch (_) {}
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
  $('setup-submit').disabled = true;
  const { error } = await joinClub(pseudo);
  $('setup-submit').disabled = false;
  if (error) { msg.textContent = friendly(error); return; }
  forget('nnn-pseudo');
  await loadAll(); toast('Bienvenue sur le mur, ' + pseudo);
});
$('composer').addEventListener('input', e => { $('ccount').textContent = e.target.value.length + '/500'; try { localStorage.setItem('nnn-draft', e.target.value); } catch (_) {} });
try { const d = localStorage.getItem('nnn-draft'); if (d) { $('composer').value = d; $('ccount').textContent = d.length + '/500'; } } catch (_) {}
$('composer-form').addEventListener('submit', async e => {
  e.preventDefault(); const t = $('composer').value.trim(); if (!t) return;
  if (await run(() => sb.from('posts').insert({ author: me, kind: 'text', text: t.slice(0, 500) }), 'Publié')) {
    $('composer').value = ''; $('ccount').textContent = '0/500'; try { localStorage.removeItem('nnn-draft'); } catch (_) {}
  }
});
$('me-btn').onclick = ev => { ev.stopPropagation(); $('me-menu').hidden = !$('me-menu').hidden; };
document.addEventListener('click', ev => { if (!$('me-menu').contains(ev.target)) $('me-menu').hidden = true; });
$('logout-btn').onclick = async () => { $('me-menu').hidden = true; await sb.auth.signOut(); };
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; location.hash = tab; window.scrollTo(0, 0); queue(); }));
function fromHash() { const t = location.hash.slice(1); if (['today', 'board', 'feed'].includes(t)) { tab = t; queue(); } }
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
  if (!sess) { profiles = new Map(); banned = new Set(); recovery = false; queue(); return; }
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
setInterval(() => { const d = phase().day; if (d !== lastDay) { lastDay = d; oathOk = false; confessOpen = false; } if (session && tab === 'today' && !document.activeElement?.closest?.('#hero')) queue(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) loadAll(); });
})();
