-- =====================================================================
-- Club No Nut November — schéma Supabase
-- À coller dans Supabase > SQL Editor > New query, puis "Run".
-- Le défi est fixé à novembre 2026 (heure de Paris), voir nnn_year().
-- Le script peut être relancé sans risque : il ne supprime aucune donnée.
-- Ensuite, lancer aussi communaute.sql (groupes, invitations, classement global).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tables ----------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  pseudo      text not null check (char_length(trim(pseudo)) between 2 and 24),
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_pseudo_unique on public.profiles (lower(pseudo));

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.checkins (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  day         int  not null check (day between 1 and 30),
  status      text not null check (status in ('ok','fail')),
  late        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  author      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('text','ok','fail','join','contest')),
  text        text check (text is null or char_length(text) between 1 and 500),
  day         int,
  target      uuid references public.profiles(id) on delete cascade,
  late        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists posts_created_idx on public.posts (created_at desc);

create table if not exists public.reactions (
  post_id  uuid not null references public.posts(id) on delete cascade,
  user_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  emoji    text not null check (emoji in ('🔥','💪','😂','🫡')),
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  author      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 300),
  created_at  timestamptz not null default now()
);

create table if not exists public.contests (
  target      uuid not null references public.profiles(id) on delete cascade,
  day         int  not null check (day between 1 and 30),
  opened_by   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  resolution  text check (resolution in ('valid','invalid')),
  created_at  timestamptz not null default now(),
  primary key (target, day)
);

create table if not exists public.votes (
  target  uuid not null,
  day     int  not null,
  voter   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  vote    text not null check (vote in ('valid','invalid')),
  primary key (target, day, voter),
  foreign key (target, day) references public.contests(target, day) on delete cascade
);

-- Fil : messages épinglés par l'organisateur, et date de modification d'un message.
alter table public.posts add column if not exists pinned boolean not null default false;
alter table public.posts add column if not exists edited_at timestamptz;
-- Discussion façon messagerie : un message peut répondre à un autre (citation).
alter table public.posts add column if not exists reply_to uuid references public.posts(id) on delete set null;
create index if not exists posts_reply_idx on public.posts (reply_to);
-- Photos (chemin dans le stockage « photos ») et photo de profil (stockage « avatars »).
alter table public.posts add column if not exists image text;
alter table public.profiles add column if not exists avatar text;

-- Dernière visite de la discussion, pour afficher « vu par ».
create table if not exists public.reads (
  user_id  uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  seen_at  timestamptz not null default now()
);

-- Abonnements aux notifications (un par appareil).
create table if not exists public.push_subs (
  endpoint    text primary key,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  level       text not null default 'important' check (level in ('all','important')),
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs (user_id);

-- Membres retirés du défi par l'organisateur. Leur historique est conservé.
create table if not exists public.banned (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- Fonctions utilitaires ------------------------------------

-- Année du défi : à changer ici ET dans app.js (const YEAR).
create or replace function public.nnn_year() returns int
language sql immutable set search_path = public as $$ select 2026 $$;

-- Jour du défi en cours (1 à 30) selon l'heure de Paris, ou NULL hors novembre.
create or replace function public.nnn_today() returns int
language sql stable set search_path = public as $$
  select case
    when extract(year  from now() at time zone 'Europe/Paris') = public.nnn_year()
     and extract(month from now() at time zone 'Europe/Paris') = 11
    then extract(day from now() at time zone 'Europe/Paris')::int
  end
$$;

-- Contestations et votes : ouverts pendant novembre et le 1er décembre (pour le jour 30).
create or replace function public.nnn_votes_open() returns boolean
language sql stable set search_path = public as $$
  select (now() at time zone 'Europe/Paris')::date
         between make_date(public.nnn_year(), 11, 1) and make_date(public.nnn_year(), 12, 1)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid())
$$;

-- Membre actif : a un profil et n'a pas été retiré.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid())
     and not exists (select 1 from public.banned where user_id = auth.uid())
$$;

-- Rejoindre le défi (ouvert à tous ceux qui ont le lien), sauf si l'organisateur nous a retiré.
create or replace function public.join_club(p_pseudo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NNN_AUTH'; end if;
  if exists (select 1 from public.banned where user_id = auth.uid()) then raise exception 'NNN_BANNED'; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  insert into public.profiles (id, pseudo) values (auth.uid(), p_pseudo);
end $$;
revoke all on function public.join_club(text) from public;
revoke all on function public.join_club(text) from anon;
grant execute on function public.join_club(text) to authenticated;

-- ---------- Déclencheurs ---------------------------------------------

-- Pseudos nettoyés (espaces) ; date d'arrivée et identifiant non modifiables.
create or replace function public.profiles_clean() returns trigger
language plpgsql set search_path = public as $$
begin
  new.pseudo := regexp_replace(trim(new.pseudo), '\s+', ' ', 'g');
  if new.avatar is not null and split_part(new.avatar, '/', 1) <> new.id::text then
    raise exception 'NNN_BAD_PATH';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists profiles_clean on public.profiles;
create trigger profiles_clean before insert or update on public.profiles
  for each row execute function public.profiles_clean();

-- Les dates des messages et commentaires sont fixées par le serveur.
create or replace function public.stamp_created() returns trigger
language plpgsql set search_path = public as $$
begin
  new.created_at := now();
  return new;
end $$;

drop trigger if exists posts_stamp on public.posts;
create trigger posts_stamp before insert on public.posts
  for each row execute function public.stamp_created();
drop trigger if exists comments_stamp on public.comments;
create trigger comments_stamp before insert on public.comments
  for each row execute function public.stamp_created();
drop trigger if exists banned_stamp on public.banned;
create trigger banned_stamp before insert on public.banned
  for each row execute function public.stamp_created();

-- Modification d'un message : l'auteur ne change que le texte de ses messages, l'organisateur
-- ne change que l'épinglage. Tout le reste est figé. (Ignoré depuis l'éditeur SQL.)
create or replace function public.posts_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if not public.is_admin() then new.pinned := old.pinned; end if;
  if not (old.author = auth.uid() and old.kind = 'text') then new.text := old.text; end if;
  new.id := old.id; new.author := old.author; new.kind := old.kind; new.day := old.day;
  new.target := old.target; new.late := old.late; new.created_at := old.created_at; new.reply_to := old.reply_to; new.image := old.image;
  new.edited_at := case when new.text is distinct from old.text then now() else old.edited_at end;
  return new;
end $$;

drop trigger if exists posts_guard on public.posts;
create trigger posts_guard before update on public.posts
  for each row execute function public.posts_guard();

-- L'heure et le badge "après 23 h" sont fixés par le serveur, jamais par le téléphone.
create or replace function public.checkins_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.late := extract(hour from now() at time zone 'Europe/Paris') >= 23;
  return new;
end $$;

drop trigger if exists checkins_stamp on public.checkins;
create trigger checkins_stamp before insert or update on public.checkins
  for each row execute function public.checkins_stamp();

-- Contestation : date d'ouverture fixée par le serveur. Elle décide qui peut voter :
-- seuls les membres inscrits avant l'ouverture (un compte créé après ne compte pas).
create or replace function public.contests_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.target     := old.target;
    new.day        := old.day;
    new.opened_by  := old.opened_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists contests_stamp on public.contests;
create trigger contests_stamp before insert or update on public.contests
  for each row execute function public.contests_stamp();

-- Les annonces automatiques du fil sont créées par le serveur.
create or replace function public.post_from_checkin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.posts (author, kind, day, late)
  values (new.user_id, new.status, new.day, new.late and new.status = 'ok');
  return null;
end $$;

drop trigger if exists checkins_post on public.checkins;
create trigger checkins_post after insert or update of status on public.checkins
  for each row execute function public.post_from_checkin();

create or replace function public.post_from_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.posts (author, kind) values (new.id, 'join');
  return null;
end $$;

drop trigger if exists profiles_post on public.profiles;
create trigger profiles_post after insert on public.profiles
  for each row execute function public.post_from_profile();

create or replace function public.post_from_contest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.posts (author, kind, day, target)
  values (new.opened_by, 'contest', new.day, new.target);
  return null;
end $$;

drop trigger if exists contests_post on public.contests;
create trigger contests_post after insert on public.contests
  for each row execute function public.post_from_contest();

-- Droits d'exécution : les fonctions des déclencheurs ne sont pas appelables depuis le site,
-- is_admin() et is_member() seulement par les membres connectés.
revoke execute on function public.post_from_checkin() from public, anon, authenticated;
revoke execute on function public.post_from_contest() from public, anon, authenticated;
revoke execute on function public.post_from_profile() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_member() to authenticated;

-- ---------- Mise à niveau des données existantes ----------------------

-- Pseudos déjà enregistrés : on enlève les espaces en trop (ignoré en cas de doublon).
do $$
declare r record;
begin
  for r in select id from public.profiles where pseudo <> regexp_replace(trim(pseudo), '\s+', ' ', 'g') loop
    begin
      update public.profiles set pseudo = pseudo where id = r.id;
    exception when unique_violation then null;
    end;
  end loop;
end $$;

-- ---------- Règles d'accès (RLS) -------------------------------------

alter table public.profiles     enable row level security;
alter table public.app_admins   enable row level security;
alter table public.banned       enable row level security;
alter table public.checkins     enable row level security;
alter table public.posts        enable row level security;
alter table public.reactions    enable row level security;
alter table public.comments     enable row level security;
alter table public.contests     enable row level security;
alter table public.votes        enable row level security;

-- app_admins : aucune règle, donc illisible et non modifiable depuis le site.

-- Profils : seuls les membres voient le groupe (chacun voit au moins le sien).
-- On rejoint via join_club(), qui refuse les membres retirés. Pas de suppression depuis le site :
-- l'organisateur retire un membre avec la table banned, l'historique reste.
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated
  using ((select public.is_member()) or id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) and (select public.is_member()))
  with check (id = (select auth.uid()));

-- Membres retirés : visibles des membres (et de la personne concernée) ;
-- seul l'organisateur retire ou réintègre, jamais lui-même.
drop policy if exists banned_read   on public.banned;
drop policy if exists banned_insert on public.banned;
drop policy if exists banned_delete on public.banned;
create policy banned_read   on public.banned for select to authenticated
  using ((select public.is_member()) or user_id = (select auth.uid()));
create policy banned_insert on public.banned for insert to authenticated
  with check ((select public.is_admin()) and user_id <> (select auth.uid()));
create policy banned_delete on public.banned for delete to authenticated
  using ((select public.is_admin()));

-- Validations : seulement pour soi, seulement le jour en cours, seulement si on est membre actif.
-- Un jour validé peut passer à "craqué" le jour même, jamais l'inverse.
drop policy if exists checkins_read   on public.checkins;
drop policy if exists checkins_insert on public.checkins;
drop policy if exists checkins_update on public.checkins;
drop policy if exists checkins_delete on public.checkins;
create policy checkins_read   on public.checkins for select to authenticated using ((select public.is_member()));
create policy checkins_insert on public.checkins for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_member()) and day = public.nnn_today());
create policy checkins_update on public.checkins for update to authenticated
  using      (user_id = (select auth.uid()) and (select public.is_member()) and day = public.nnn_today() and status = 'ok')
  with check (user_id = (select auth.uid()) and day = public.nnn_today() and status = 'fail');
create policy checkins_delete on public.checkins for delete to authenticated using ((select public.is_admin()));

-- Fil : on ne peut écrire que des messages texte ; les annonces viennent des déclencheurs.
drop policy if exists posts_read   on public.posts;
drop policy if exists posts_insert on public.posts;
drop policy if exists posts_delete on public.posts;
drop policy if exists posts_update on public.posts;
create policy posts_read   on public.posts for select to authenticated using ((select public.is_member()));
create policy posts_insert on public.posts for insert to authenticated
  with check (author = (select auth.uid()) and (select public.is_member()) and kind = 'text'
              and ((text is not null and char_length(trim(text)) > 0) or image is not null)
              and (image is null or split_part(image, '/', 1) = (select auth.uid())::text)
              and day is null and target is null and late = false);
create policy posts_update on public.posts for update to authenticated
  using ((author = (select auth.uid()) and kind = 'text' and (select public.is_member())) or (select public.is_admin()))
  with check (kind <> 'text' or image is not null or char_length(trim(text)) > 0);
create policy posts_delete on public.posts for delete to authenticated
  using ((author = (select auth.uid()) and kind = 'text') or (select public.is_admin()));

-- Réactions : une par personne et par message.
drop policy if exists reactions_read   on public.reactions;
drop policy if exists reactions_insert on public.reactions;
drop policy if exists reactions_update on public.reactions;
drop policy if exists reactions_delete on public.reactions;
create policy reactions_read   on public.reactions for select to authenticated using ((select public.is_member()));
create policy reactions_insert on public.reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_member()));
create policy reactions_update on public.reactions for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_member()))
  with check (user_id = (select auth.uid()));
create policy reactions_delete on public.reactions for delete to authenticated using (user_id = (select auth.uid()));

-- Commentaires.
drop policy if exists comments_read   on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_delete on public.comments;
create policy comments_read   on public.comments for select to authenticated using ((select public.is_member()));
create policy comments_insert on public.comments for insert to authenticated
  with check (author = (select auth.uid()) and (select public.is_member()) and char_length(trim(text)) > 0);
create policy comments_delete on public.comments for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_admin()));

-- Contestations : on conteste le jour validé d'un autre membre actif, pendant le défi.
-- Seul l'organisateur tranche, et jamais sur son propre jour.
drop policy if exists contests_read   on public.contests;
drop policy if exists contests_insert on public.contests;
drop policy if exists contests_update on public.contests;
drop policy if exists contests_delete on public.contests;
create policy contests_read   on public.contests for select to authenticated using ((select public.is_member()));
create policy contests_insert on public.contests for insert to authenticated
  with check (
    opened_by = (select auth.uid()) and target <> (select auth.uid()) and resolution is null
    and (select public.is_member()) and public.nnn_votes_open()
    and not exists (select 1 from public.banned b where b.user_id = contests.target)
    and exists (select 1 from public.checkins c where c.user_id = contests.target and c.day = contests.day and c.status = 'ok')
  );
create policy contests_update on public.contests for update to authenticated
  using ((select public.is_admin()) and target <> (select auth.uid()))
  with check ((select public.is_admin()) and target <> (select auth.uid()));
create policy contests_delete on public.contests for delete to authenticated using ((select public.is_admin()));

-- Votes : un vote par personne, pas sur son propre jour, pendant les 24 h qui suivent l'ouverture.
-- Après 24 h, la majorité des votants décide (égalité : le jour est maintenu).
-- Seuls votent les membres déjà inscrits à l'ouverture (ce sont eux qui sont comptés).
drop policy if exists votes_read   on public.votes;
drop policy if exists votes_insert on public.votes;
drop policy if exists votes_update on public.votes;
create policy votes_read   on public.votes for select to authenticated using ((select public.is_member()));
create policy votes_insert on public.votes for insert to authenticated
  with check (
    voter = (select auth.uid()) and voter <> target and (select public.is_member()) and public.nnn_votes_open()
    and exists (select 1 from public.contests k join public.profiles p on p.id = votes.voter
                where k.target = votes.target and k.day = votes.day and k.resolution is null
                  and p.created_at <= k.created_at and now() < k.created_at + interval '24 hours')
  );
create policy votes_update on public.votes for update to authenticated
  using (voter = (select auth.uid()))
  with check (
    voter = (select auth.uid()) and voter <> target and (select public.is_member()) and public.nnn_votes_open()
    and exists (select 1 from public.contests k join public.profiles p on p.id = votes.voter
                where k.target = votes.target and k.day = votes.day and k.resolution is null
                  and p.created_at <= k.created_at and now() < k.created_at + interval '24 hours')
  );

-- ---------- Vu par, notifications -------------------------------------
create or replace function public.reads_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  new.seen_at := now();
  return new;
end $$;
drop trigger if exists reads_stamp on public.reads;
create trigger reads_stamp before insert or update on public.reads
  for each row execute function public.reads_stamp();
revoke execute on function public.reads_stamp() from public, anon, authenticated;

alter table public.reads     enable row level security;
alter table public.push_subs enable row level security;
drop policy if exists reads_read   on public.reads;
drop policy if exists reads_insert on public.reads;
drop policy if exists reads_update on public.reads;
create policy reads_read   on public.reads for select to authenticated using ((select public.is_member()));
create policy reads_insert on public.reads for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_member()));
create policy reads_update on public.reads for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists push_read   on public.push_subs;
drop policy if exists push_insert on public.push_subs;
drop policy if exists push_update on public.push_subs;
drop policy if exists push_delete on public.push_subs;
create policy push_read   on public.push_subs for select to authenticated using (user_id = (select auth.uid()));
create policy push_insert on public.push_subs for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_member()));
create policy push_update on public.push_subs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_delete on public.push_subs for delete to authenticated using (user_id = (select auth.uid()));

-- Envoi des notifications : la base appelle la fonction « nnn-push » (Edge Function)
-- via pg_net. Adresse et clé dans private.settings (invisibles depuis l'appli) :
--   insert into private.settings values ('push_url', 'https://<projet>.supabase.co/functions/v1/nnn-push'),
--                                       ('push_key', '<une longue valeur aléatoire>');
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (key text primary key, value text not null);
revoke all on private.settings from public, anon, authenticated;

create or replace function public.nnn_push(payload jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare u text; k text;
begin
  if to_regnamespace('net') is null then return; end if;
  select value into u from private.settings where key = 'push_url';
  select value into k from private.settings where key = 'push_key';
  if u is null or k is null then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    using u, payload, jsonb_build_object('Content-Type', 'application/json', 'x-nnn-key', k);
exception when others then
  raise warning 'nnn_push: %', sqlerrm;  -- une notification ratée ne bloque jamais un message
end $$;
revoke execute on function public.nnn_push(jsonb) from public, anon, authenticated;

-- Lue par la fonction nnn-push (rôle service uniquement). Clés VAPID à ajouter dans private.settings :
-- vapid_public, vapid_private (la clé publique est aussi dans app.js, VAPID_PUBLIC).
create or replace function public.nnn_push_config() returns jsonb
language sql stable security definer set search_path = private as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from private.settings
  where key in ('push_key', 'vapid_public', 'vapid_private')
$$;
revoke execute on function public.nnn_push_config() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.nnn_push_config() to service_role;
  end if;
end $$;

create or replace function public.posts_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('text', 'contest') then
    perform public.nnn_push(jsonb_build_object('type', 'post', 'id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists posts_push on public.posts;
create trigger posts_push after insert on public.posts
  for each row execute function public.posts_push();
revoke execute on function public.posts_push() from public, anon, authenticated;

-- Rappels : 21 h et 23 h à Paris en novembre (UTC+1), si pg_cron est activé.
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('nnn-remind-21', '0 20 * 11 *', $c$select public.nnn_push('{"type":"remind","hour":21}')$c$);
    perform cron.schedule('nnn-remind-23', '0 22 * 11 *', $c$select public.nnn_push('{"type":"remind","hour":23}')$c$);
  end if;
end $$;

-- ---------- Photos ----------------------------------------------------
-- « photos » : privé, lisible par les membres ; « avatars » : public.
-- Chacun n'écrit que dans son dossier (<son id>/...).
do $$
begin
  if to_regnamespace('storage') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('photos', 'photos', false, 6291456, array['image/jpeg','image/png','image/webp','image/gif']),
         ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
  on conflict (id) do nothing;
  execute 'drop policy if exists nnn_photos_read on storage.objects';
  execute 'drop policy if exists nnn_photos_insert on storage.objects';
  execute 'drop policy if exists nnn_photos_delete on storage.objects';
  execute 'drop policy if exists nnn_avatars_insert on storage.objects';
  execute 'drop policy if exists nnn_avatars_delete on storage.objects';
  execute $p$create policy nnn_photos_read on storage.objects for select to authenticated
    using (bucket_id = 'photos' and (select public.is_member()))$p$;
  execute $p$create policy nnn_photos_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_member()))$p$;
  execute $p$create policy nnn_photos_delete on storage.objects for delete to authenticated
    using (bucket_id = 'photos' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())))$p$;
  execute $p$create policy nnn_avatars_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_member()))$p$;
  execute $p$create policy nnn_avatars_delete on storage.objects for delete to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;
end $$;

-- ---------- Anti-spam ------------------------------------------------
-- Au plus 8 messages par minute et par membre.
create or replace function public.posts_rate() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and new.kind = 'text' and
     (select count(*) from public.posts where author = new.author and kind = 'text'
        and created_at > now() - interval '1 minute') >= 8 then
    raise exception 'NNN_SLOW';
  end if;
  return new;
end $$;
drop trigger if exists posts_rate on public.posts;
create trigger posts_rate before insert on public.posts
  for each row execute function public.posts_rate();
revoke execute on function public.posts_rate() from public, anon, authenticated;
create index if not exists posts_author_idx on public.posts (author, created_at desc);

-- ---------- Temps réel ------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['profiles','banned','checkins','posts','reactions','comments','contests','votes','reads'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- Anciens commentaires -> réponses dans la discussion -------
-- Chaque commentaire devient un message qui cite le message commenté (même
-- identifiant, même date), puis quitte la table comments. Sans effet ensuite.
alter table public.posts disable trigger posts_stamp;
with moved as (
  insert into public.posts (id, author, kind, text, reply_to, created_at)
  select c.id, c.author, 'text', left(c.text, 500), c.post_id, c.created_at
  from public.comments c
  where char_length(trim(c.text)) > 0
  on conflict (id) do nothing
  returning id
)
delete from public.comments c where c.id in (select id from moved) or char_length(trim(c.text)) = 0;
alter table public.posts enable trigger posts_stamp;
