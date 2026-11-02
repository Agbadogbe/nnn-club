// Club NNN : envoi des notifications (Web Push).
// Appelée par la base (pg_net) : à chaque message ou contestation, et par pg_cron pour les rappels.
// Clés (push_key, vapid_public, vapid_private) lues dans private.settings via nnn_push_config(),
// fonction réservée au rôle service.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
let conf: Record<string, string> | null = null;
async function config() {
  if (!conf) {
    const { data, error } = await sb.rpc('nnn_push_config');
    if (error || !data) throw new Error('config: ' + (error?.message || 'vide'));
    conf = data as Record<string, string>;
    webpush.setVapidDetails('https://nnn-club.vercel.app', conf.vapid_public, conf.vapid_private);
  }
  return conf;
}

type Msg = { title: string; body: string; important: boolean; url?: string; tag?: string };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const c = await config();
  if (req.method !== 'POST' || !c.push_key || req.headers.get('x-nnn-key') !== c.push_key) return json({ error: 'forbidden' }, 403);
  const ev = await req.json().catch(() => ({}));
  const [{ data: profiles }, { data: banned }] = await Promise.all([
    sb.from('profiles').select('id,pseudo'), sb.from('banned').select('user_id'),
  ]);
  const out = new Set((banned || []).map((b) => b.user_id));
  const members = (profiles || []).filter((p) => !out.has(p.id));
  const nm = (id: string) => (profiles || []).find((p) => p.id === id)?.pseudo || 'Quelqu\'un';
  const msgs = new Map<string, Msg>();

  if ((ev.type === 'post' || ev.type === 'report') && ev.id) {
    const { data: p } = await sb.from('posts').select('*').eq('id', ev.id).maybeSingle();
    if (!p) return json({ sent: 0 });
    // Destinataires : les membres du groupe du message.
    const [{ data: gm }, { data: grp }] = await Promise.all([
      sb.from('group_members').select('user_id,role').eq('group_id', p.group_id),
      sb.from('groups').select('name').eq('id', p.group_id).maybeSingle(),
    ]);
    const inGroup = new Map((gm || []).map((m) => [m.user_id, m.role]));
    const gname = grp?.name || 'Le groupe';
    const url = '/?g=' + p.group_id + '#feed';
    const members2 = members.filter((m) => inGroup.has(m.id));
    if (ev.type === 'report') {
      for (const m of members2) if (inGroup.get(m.id) !== 'member') msgs.set(m.id, { title: `🚩 Message signalé · ${gname}`, body: `Un message de ${nm(p.author)} a été signalé. Ouvre la discussion pour décider.`, important: true, url, tag: 'report' });
    } else
    if (p.kind === 'contest') {
      for (const m of members2) {
        if (m.id === p.author) continue;
        msgs.set(m.id, m.id === p.target
          ? { title: `⚖️ Ton jour ${p.day} est contesté`, body: `${nm(p.author)} conteste ton jour ${p.day} dans ${gname}. Défends-toi dans la discussion.`, important: true, url }
          : { title: `⚖️ Contestation · ${gname}`, body: `${nm(p.author)} conteste le jour ${p.day} de ${nm(p.target)}. Tu as 24 h pour voter.`, important: true, url });
      }
    } else if (p.kind === 'text') {
      const text: string = p.text || '';
      const body = (text || '📷 Photo').slice(0, 180);
      let parent: { author: string } | null = null;
      if (p.reply_to) parent = (await sb.from('posts').select('author').eq('id', p.reply_to).maybeSingle()).data;
      for (const m of members2) {
        if (m.id === p.author) continue;
        if (new RegExp('@' + esc(m.pseudo) + '(?![\\p{L}\\p{N}_])', 'iu').test(text)) msgs.set(m.id, { title: `${nm(p.author)} t'a mentionné · ${gname}`, body, important: true, url });
        else if (parent && parent.author === m.id) msgs.set(m.id, { title: `${nm(p.author)} t'a répondu · ${gname}`, body, important: true, url });
        else msgs.set(m.id, { title: `${nm(p.author)} · ${gname}`, body, important: false, url });
      }
    }
  } else if (ev.type === 'remind') {
    // Jour du défi à Paris (novembre 2026, comme nnn_today()).
    const [y, mo, d] = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
    const day = y === 2026 && mo === 11 ? d : 0;
    if (!day) return json({ sent: 0 });
    const { data: done } = await sb.from('checkins').select('user_id').eq('day', day);
    const has = new Set((done || []).map((d) => d.user_id));
    const last = ev.hour === 23;
    for (const m of members) {
      if (has.has(m.id)) continue;
      msgs.set(m.id, {
        title: last ? '⏳ Dernière heure' : '🕘 Pense à valider ta journée',
        body: last ? `Il reste moins d'une heure pour valider le jour ${day}.` : `Le jour ${day} n'est pas encore validé. Tu as jusqu'à minuit.`,
        important: true, url: '/#today', tag: 'remind',
      });
    }
  }
  if (!msgs.size) return json({ sent: 0 });

  const { data: subs } = await sb.from('push_subs').select('*').in('user_id', [...msgs.keys()]);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    const m = msgs.get(s.user_id)!;
    if (!m.important && s.level !== 'all') return;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: m.title, body: m.body, url: m.url || '/#feed', tag: m.tag || 'feed' }), { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from('push_subs').delete().eq('endpoint', s.endpoint);
      else console.error('push', code, (e as Error).message);
    }
  }));
  return json({ sent });
});
