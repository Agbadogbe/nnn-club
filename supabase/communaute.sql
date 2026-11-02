-- =====================================================================
-- Communauté : plusieurs groupes, invitations, classement global,
-- signalements, suppression de compte.
-- Ajouté le 2 novembre 2026. Relançable, ne supprime aucune donnée.
-- (Inclus à la fin de schema.sql ; peut aussi être lancé seul.)
-- =====================================================================

-- Crée ou met à jour une règle d'accès (sans jamais la supprimer).
create or replace function pg_temp.pol(n text, t text, cmd text, u text, c text) returns void
language plpgsql as $$
declare s text := split_part(t, '.', 1); r text := split_part(t, '.', 2);
begin
  if exists (select 1 from pg_policies where schemaname = s and tablename = r and policyname = n) then
    execute format('alter policy %I on %s to authenticated', n, t)
      || coalesce(' using (' || u || ')', '') || coalesce(' with check (' || c || ')', '');
  else
    execute format('create policy %I on %s for %s to authenticated', n, t, cmd)
      || coalesce(' using (' || u || ')', '') || coalesce(' with check (' || c || ')', '');
  end if;
end $$;

-- ---------- Tables ----------------------------------------------------
create table if not exists public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(trim(name)) between 2 and 40),
  invite_code  text not null unique default lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  owner        uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now()
);
create table if not exists public.group_members (
  group_id   uuid not null references public.groups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','admin','member')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);
-- Retirés d'un groupe par ses organisateurs : ils ne peuvent plus le rejoindre.
create table if not exists public.group_bans (
  group_id    uuid not null references public.groups(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
-- « Vu par », par groupe.
create table if not exists public.group_reads (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  seen_at   timestamptz not null default now(),
  primary key (group_id, user_id)
);
-- Signalements de messages.
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  reporter    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  reason      text check (reason is null or char_length(reason) <= 300),
  created_at  timestamptz not null default now(),
  unique (post_id, reporter)
);
alter table public.posts    add column if not exists group_id uuid references public.groups(id) on delete cascade;
alter table public.contests add column if not exists group_id uuid references public.groups(id) on delete cascade;
alter table public.profiles add column if not exists terms_at timestamptz;
create index if not exists posts_group_idx on public.posts (group_id, created_at desc);
create index if not exists posts_image_idx on public.posts (image) where image is not null;
create index if not exists contests_group_idx on public.contests (group_id);

-- ---------- Fonctions d'accès -----------------------------------------
-- Membre du groupe g (et du site).
create or replace function public.in_group(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (select 1 from public.group_members where group_id = g and user_id = auth.uid())
$$;
-- Organisateur du groupe g (propriétaire ou admin), ou modérateur du site.
create or replace function public.is_group_admin(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_member() and exists (
    select 1 from public.group_members where group_id = g and user_id = auth.uid() and role in ('owner','admin')))
$$;
create or replace function public.post_in_my_group(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts where id = p and public.in_group(group_id))
$$;
-- Les personnes que je peux voir : moi et les membres de mes groupes. Personne d'autre.
create or replace function public.my_peers() returns setof uuid
language sql stable security definer set search_path = public as $$
  select auth.uid()
  union
  select b.user_id from public.group_members a join public.group_members b on b.group_id = a.group_id
  where a.user_id = auth.uid() and public.is_member()
$$;
revoke execute on function public.my_peers() from public, anon;
grant execute on function public.my_peers() to authenticated;
revoke execute on function public.in_group(uuid) from public, anon;
revoke execute on function public.is_group_admin(uuid) from public, anon;
revoke execute on function public.post_in_my_group(uuid) from public, anon;
grant execute on function public.in_group(uuid) to authenticated;
grant execute on function public.is_group_admin(uuid) to authenticated;
grant execute on function public.post_in_my_group(uuid) to authenticated;

-- ---------- Actions sur les groupes (appelées depuis le site) ----------
create or replace function public.create_group(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  if not public.is_member() then raise exception 'NNN_AUTH'; end if;
  if (select count(*) from public.groups where owner = auth.uid()) >= 5 then raise exception 'NNN_TOO_MANY_GROUPS'; end if;
  insert into public.groups (name, owner) values (regexp_replace(trim(p_name), '\s+', ' ', 'g'), auth.uid()) returning id into g;
  insert into public.group_members (group_id, user_id, role) values (g, auth.uid(), 'owner');
  insert into public.posts (author, kind, group_id) values (auth.uid(), 'join', g);
  return g;
end $$;

-- Aperçu d'une invitation (nom, nombre de membres), visible avant de s'inscrire.
create or replace function public.group_preview(p_code text)
returns table (id uuid, name text, members bigint)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, (select count(*) from public.group_members m where m.group_id = g.id)
  from public.groups g where g.invite_code = lower(trim(p_code))
$$;

create or replace function public.join_group(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  if not public.is_member() then raise exception 'NNN_AUTH'; end if;
  select id into g from public.groups where invite_code = lower(trim(p_code));
  if g is null then raise exception 'NNN_BAD_INVITE'; end if;
  if exists (select 1 from public.group_bans where group_id = g and user_id = auth.uid()) then raise exception 'NNN_GROUP_BANNED'; end if;
  if exists (select 1 from public.group_members where group_id = g and user_id = auth.uid()) then return g; end if;
  if (select count(*) from public.group_members where group_id = g) >= 200 then raise exception 'NNN_GROUP_FULL'; end if;
  insert into public.group_members (group_id, user_id) values (g, auth.uid());
  insert into public.posts (author, kind, group_id) values (auth.uid(), 'join', g);
  return g;
end $$;

-- Quitter un groupe. Le propriétaire passe la main au plus ancien admin ou membre ;
-- un groupe vide est supprimé.
create or replace function public.leave_group(g uuid) returns void
language plpgsql security definer set search_path = public as $$
declare nxt uuid;
begin
  if not exists (select 1 from public.group_members where group_id = g and user_id = auth.uid()) then return; end if;
  delete from public.group_members where group_id = g and user_id = auth.uid();
  if not exists (select 1 from public.group_members where group_id = g) then
    delete from public.groups where id = g; return;
  end if;
  if (select owner from public.groups where id = g) = auth.uid() then
    select user_id into nxt from public.group_members where group_id = g
      order by (role = 'admin') desc, joined_at limit 1;
    update public.groups set owner = nxt where id = g;
    update public.group_members set role = 'owner' where group_id = g and user_id = nxt;
  end if;
end $$;

-- Retirer / réintégrer un membre (organisateurs du groupe ; jamais le propriétaire).
create or replace function public.ban_member(g uuid, u uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_admin(g) or u = auth.uid() then raise exception 'NNN_FORBIDDEN'; end if;
  if (select owner from public.groups where id = g) = u then raise exception 'NNN_FORBIDDEN'; end if;
  delete from public.group_members where group_id = g and user_id = u;
  insert into public.group_bans (group_id, user_id) values (g, u) on conflict do nothing;
end $$;
create or replace function public.unban_member(g uuid, u uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_admin(g) then raise exception 'NNN_FORBIDDEN'; end if;
  delete from public.group_bans where group_id = g and user_id = u;
end $$;
-- Nommer ou retirer un admin (propriétaire seulement).
create or replace function public.set_member_role(g uuid, u uuid, r text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if r not in ('admin','member') then raise exception 'NNN_FORBIDDEN'; end if;
  if not (public.is_admin() or (select owner from public.groups where id = g) = auth.uid()) or u = (select owner from public.groups where id = g) then
    raise exception 'NNN_FORBIDDEN';
  end if;
  update public.group_members set role = r where group_id = g and user_id = u;
end $$;
-- Nouveau lien d'invitation (l'ancien ne marche plus).
create or replace function public.regen_invite(g uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
begin
  if not public.is_group_admin(g) then raise exception 'NNN_FORBIDDEN'; end if;
  update public.groups set invite_code = c where id = g;
  return c;
end $$;

-- Verdict de chaque contestation, calculé par le serveur (pour le classement global).
-- Votants : membres du groupe de la contestation, arrivés avant son ouverture, hors personne visée.
create or replace function public.contest_verdicts()
returns table (target uuid, day int, state text)
language sql stable security definer set search_path = public as $$
  with el as (
    select c.target, c.day, m.user_id
    from public.contests c
    join public.group_members m on m.group_id = c.group_id and m.user_id <> c.target and m.joined_at <= c.created_at
    where not exists (select 1 from public.banned b where b.user_id = m.user_id)
  ), t as (
    select c.target, c.day, c.resolution, c.created_at,
      (select count(*) from el where el.target = c.target and el.day = c.day) as n,
      (select count(*) from public.votes v join el on el.target = v.target and el.day = v.day and el.user_id = v.voter
        where v.target = c.target and v.day = c.day and v.vote = 'valid') as yes,
      (select count(*) from public.votes v join el on el.target = v.target and el.day = v.day and el.user_id = v.voter
        where v.target = c.target and v.day = c.day and v.vote = 'invalid') as no
    from public.contests c
    where public.in_group(c.group_id) or public.is_admin()
  )
  select target, day, case
    when resolution is not null then resolution
    when n > 0 and no * 2 > n then 'invalid'
    when n > 0 and yes * 2 >= n then 'valid'
    when now() >= created_at + interval '24 hours' or not public.nnn_votes_open() then case when no > yes then 'invalid' else 'valid' end
    else 'open' end
  from t
$$;

-- Chiffres publics pour la page d'accueil (sans aucune donnée personnelle).
create or replace function public.public_stats() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'participants', (select count(*) from public.profiles p where not exists (select 1 from public.banned b where b.user_id = p.id)),
    'groups', (select count(*) from public.groups),
    'held_today', (select count(*) from public.checkins where day = public.nnn_today() and status = 'ok'),
    'days_held', (select count(*) from public.checkins where status = 'ok'))
$$;

-- Supprimer son compte et toutes ses données (messages, jours, votes, groupes possédés).
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
declare g uuid;
begin
  if auth.uid() is null then raise exception 'NNN_AUTH'; end if;
  for g in select group_id from public.group_members where user_id = auth.uid() loop
    perform public.leave_group(g);
  end loop;
  delete from auth.users where id = auth.uid();
end $$;

revoke execute on function public.create_group(text), public.join_group(text), public.leave_group(uuid),
  public.ban_member(uuid, uuid), public.unban_member(uuid, uuid), public.set_member_role(uuid, uuid, text),
  public.regen_invite(uuid), public.contest_verdicts(), public.delete_my_account(),
  public.group_preview(text), public.public_stats() from public, anon;
grant execute on function public.create_group(text), public.join_group(text), public.leave_group(uuid),
  public.ban_member(uuid, uuid), public.unban_member(uuid, uuid), public.set_member_role(uuid, uuid, text),
  public.regen_invite(uuid), public.contest_verdicts(), public.delete_my_account(),
  public.group_preview(text), public.public_stats() to authenticated;
grant execute on function public.group_preview(text), public.public_stats() to anon;

-- Inscription : on enregistre l'acceptation des conditions (18 ans et plus).
create or replace function public.join_club(p_pseudo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NNN_AUTH'; end if;
  if exists (select 1 from public.banned where user_id = auth.uid()) then raise exception 'NNN_BANNED'; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  insert into public.profiles (id, pseudo, terms_at) values (auth.uid(), p_pseudo, now());
end $$;

-- ---------- Déclencheurs ----------------------------------------------
-- Les annonces vont dans chaque groupe du membre ; l'arrivée est annoncée au moment de rejoindre un groupe.
create or replace function public.post_from_checkin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.posts (author, kind, day, late, group_id)
  select new.user_id, new.status, new.day, new.late and new.status = 'ok', m.group_id
  from public.group_members m where m.user_id = new.user_id;
  return null;
end $$;
create or replace function public.post_from_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  return null;
end $$;
create or replace function public.post_from_contest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.posts (author, kind, day, target, group_id)
  values (new.opened_by, 'contest', new.day, new.target, new.group_id);
  return null;
end $$;

-- Modifier un message : groupe figé ; épingler réservé aux organisateurs du groupe.
create or replace function public.posts_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if not public.is_group_admin(old.group_id) then new.pinned := old.pinned; end if;
  if not (old.author = auth.uid() and old.kind = 'text') then new.text := old.text; end if;
  new.id := old.id; new.author := old.author; new.kind := old.kind; new.day := old.day; new.group_id := old.group_id;
  new.target := old.target; new.late := old.late; new.created_at := old.created_at; new.reply_to := old.reply_to; new.image := old.image;
  new.edited_at := case when new.text is distinct from old.text then now() else old.edited_at end;
  return new;
end $$;
create or replace function public.contests_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.target := old.target; new.day := old.day; new.opened_by := old.opened_by;
    new.created_at := old.created_at; new.group_id := coalesce(old.group_id, new.group_id);
  end if;
  return new;
end $$;
create or replace function public.group_reads_stamp() returns trigger
language plpgsql set search_path = public as $$
begin new.seen_at := now(); return new; end $$;
create or replace function public.groups_clean() returns trigger
language plpgsql set search_path = public as $$
begin
  new.name := regexp_replace(trim(new.name), '\s+', ' ', 'g');
  if tg_op = 'INSERT' then new.created_at := now();
  else new.id := old.id; new.created_at := old.created_at;
    -- Depuis le site, seul le nom change ; propriétaire et lien passent par leave_group / regen_invite.
    if current_user = 'authenticated' then new.owner := old.owner; new.invite_code := old.invite_code; end if;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'group_reads_stamp') then
    create trigger group_reads_stamp before insert or update on public.group_reads for each row execute function public.group_reads_stamp();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'groups_clean') then
    create trigger groups_clean before insert or update on public.groups for each row execute function public.groups_clean();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'reports_stamp') then
    create trigger reports_stamp before insert on public.reports for each row execute function public.stamp_created();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'group_bans_stamp') then
    create trigger group_bans_stamp before insert on public.group_bans for each row execute function public.stamp_created();
  end if;
end $$;
revoke execute on function public.group_reads_stamp(), public.groups_clean() from public, anon, authenticated;

-- Notification aux organisateurs du groupe quand un message est signalé.
create or replace function public.reports_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.nnn_push(jsonb_build_object('type', 'report', 'id', new.post_id));
  return null;
end $$;
revoke execute on function public.reports_push() from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'reports_push') then
    create trigger reports_push after insert on public.reports for each row execute function public.reports_push();
  end if;
end $$;

-- ---------- Le groupe d'origine ---------------------------------------
-- Si le site existait avant les groupes, tous les membres actuels forment le premier groupe,
-- avec l'organisateur comme propriétaire. Messages, contestations et « vu » y sont rattachés.
do $$
declare g uuid; o uuid;
begin
  if exists (select 1 from public.groups) or not exists (select 1 from public.profiles) then return; end if;
  select a.user_id into o from public.app_admins a join public.profiles p on p.id = a.user_id order by p.created_at limit 1;
  if o is null then select id into o from public.profiles order by created_at limit 1; end if;
  insert into public.groups (name, owner) values ('Les fondateurs', o) returning id into g;
  insert into public.group_members (group_id, user_id, role, joined_at)
    select g, p.id, case when p.id = o then 'owner' else 'member' end, p.created_at
    from public.profiles p where not exists (select 1 from public.banned b where b.user_id = p.id);
  insert into public.group_bans (group_id, user_id) select g, user_id from public.banned on conflict do nothing;
  update public.posts set group_id = g where group_id is null;
  update public.contests set group_id = g where group_id is null;
  insert into public.group_reads (group_id, user_id, seen_at) select g, user_id, seen_at from public.reads on conflict do nothing;
  update public.profiles set terms_at = created_at where terms_at is null;
end $$;
-- Anciennes exclusions : elles concernaient le groupe d'origine (déjà recopiées dans group_bans).
-- La table banned sert désormais aux exclusions du site entier, décidées par les modérateurs.
alter table public.posts alter column group_id set not null;
alter table public.contests alter column group_id set not null;

-- ---------- Règles d'accès --------------------------------------------
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.group_bans    enable row level security;
alter table public.group_reads   enable row level security;
alter table public.reports       enable row level security;

-- Défi seul ou entre amis : on ne voit le profil et les jours que des membres de ses groupes.
select pg_temp.pol('profiles_read', 'public.profiles', 'select', $q$id in (select public.my_peers()) or (select public.is_admin())$q$, null);
select pg_temp.pol('checkins_read', 'public.checkins', 'select', $q$user_id in (select public.my_peers()) or (select public.is_admin())$q$, null);
select pg_temp.pol('banned_read', 'public.banned', 'select', $q$user_id in (select public.my_peers()) or (select public.is_admin())$q$, null);
select pg_temp.pol('groups_read', 'public.groups', 'select', $q$(select public.in_group(id)) or (select public.is_admin())$q$, null);
select pg_temp.pol('groups_update', 'public.groups', 'update', $q$(select public.is_group_admin(id))$q$, $q$(select public.is_group_admin(id))$q$);
select pg_temp.pol('gm_read', 'public.group_members', 'select', $q$(select public.in_group(group_id)) or user_id = (select auth.uid()) or (select public.is_admin())$q$, null);
select pg_temp.pol('gb_read', 'public.group_bans', 'select', $q$(select public.is_group_admin(group_id)) or user_id = (select auth.uid())$q$, null);
select pg_temp.pol('gr_read', 'public.group_reads', 'select', $q$(select public.in_group(group_id))$q$, null);
select pg_temp.pol('gr_insert', 'public.group_reads', 'insert', null, $q$user_id = (select auth.uid()) and (select public.in_group(group_id))$q$);
select pg_temp.pol('gr_update', 'public.group_reads', 'update', $q$user_id = (select auth.uid())$q$, $q$user_id = (select auth.uid()) and (select public.in_group(group_id))$q$);
select pg_temp.pol('reports_read', 'public.reports', 'select',
  $q$reporter = (select auth.uid()) or (select public.is_admin()) or exists (select 1 from public.posts p where p.id = post_id and public.is_group_admin(p.group_id))$q$, null);
select pg_temp.pol('reports_insert', 'public.reports', 'insert', null, $q$reporter = (select auth.uid()) and (select public.post_in_my_group(post_id))$q$);
select pg_temp.pol('reports_delete', 'public.reports', 'delete',
  $q$(select public.is_admin()) or exists (select 1 from public.posts p where p.id = post_id and public.is_group_admin(p.group_id))$q$, null);

-- Messages : seulement dans ses groupes.
select pg_temp.pol('posts_read', 'public.posts', 'select', $q$(select public.in_group(group_id)) or (select public.is_admin())$q$, null);
select pg_temp.pol('posts_insert', 'public.posts', 'insert', null,
  $q$author = (select auth.uid()) and (select public.in_group(group_id)) and kind = 'text'
     and ((text is not null and char_length(trim(text)) > 0) or image is not null)
     and (image is null or split_part(image, '/', 1) = (select auth.uid())::text)
     and day is null and target is null and late = false$q$);
select pg_temp.pol('posts_update', 'public.posts', 'update',
  $q$(author = (select auth.uid()) and kind = 'text' and (select public.in_group(group_id))) or (select public.is_group_admin(group_id))$q$,
  $q$kind <> 'text' or image is not null or char_length(trim(text)) > 0$q$);
select pg_temp.pol('posts_delete', 'public.posts', 'delete',
  $q$(author = (select auth.uid()) and kind = 'text') or (select public.is_group_admin(group_id))$q$, null);

-- Réactions : sur les messages de ses groupes.
select pg_temp.pol('reactions_read', 'public.reactions', 'select', $q$(select public.post_in_my_group(post_id)) or (select public.is_admin())$q$, null);
select pg_temp.pol('reactions_insert', 'public.reactions', 'insert', null, $q$user_id = (select auth.uid()) and (select public.post_in_my_group(post_id))$q$);
select pg_temp.pol('reactions_update', 'public.reactions', 'update', $q$user_id = (select auth.uid())$q$, $q$user_id = (select auth.uid()) and (select public.post_in_my_group(post_id))$q$);

-- Contestations : dans un de ses groupes, contre un membre de ce groupe ; les organisateurs du groupe tranchent.
select pg_temp.pol('contests_read', 'public.contests', 'select', $q$(select public.in_group(group_id)) or (select public.is_admin())$q$, null);
select pg_temp.pol('contests_insert', 'public.contests', 'insert', null,
  $q$opened_by = (select auth.uid()) and target <> (select auth.uid()) and resolution is null
     and (select public.in_group(group_id)) and public.nnn_votes_open()
     and exists (select 1 from public.group_members m where m.group_id = contests.group_id and m.user_id = contests.target)
     and not exists (select 1 from public.banned b where b.user_id = contests.target)
     and exists (select 1 from public.checkins c where c.user_id = contests.target and c.day = contests.day and c.status = 'ok')$q$);
select pg_temp.pol('contests_update', 'public.contests', 'update',
  $q$(select public.is_group_admin(group_id)) and target <> (select auth.uid())$q$,
  $q$(select public.is_group_admin(group_id)) and target <> (select auth.uid())$q$);
select pg_temp.pol('contests_delete', 'public.contests', 'delete', $q$(select public.is_admin())$q$, null);

-- Votes : membres du groupe arrivés avant l'ouverture, pendant 24 h.
select pg_temp.pol('votes_read', 'public.votes', 'select',
  $q$exists (select 1 from public.contests k where k.target = votes.target and k.day = votes.day and public.in_group(k.group_id))$q$, null);
select pg_temp.pol('votes_insert', 'public.votes', 'insert', null,
  $q$voter = (select auth.uid()) and voter <> target and (select public.is_member()) and public.nnn_votes_open()
     and exists (select 1 from public.contests k join public.group_members m on m.group_id = k.group_id and m.user_id = votes.voter
                 where k.target = votes.target and k.day = votes.day and k.resolution is null
                   and m.joined_at <= k.created_at and now() < k.created_at + interval '24 hours')$q$);
select pg_temp.pol('votes_update', 'public.votes', 'update', $q$voter = (select auth.uid())$q$,
  $q$voter = (select auth.uid()) and voter <> target and (select public.is_member()) and public.nnn_votes_open()
     and exists (select 1 from public.contests k join public.group_members m on m.group_id = k.group_id and m.user_id = votes.voter
                 where k.target = votes.target and k.day = votes.day and k.resolution is null
                   and m.joined_at <= k.created_at and now() < k.created_at + interval '24 hours')$q$);

-- Photos : lisibles par les membres du groupe où elles ont été envoyées.
do $$
begin
  if to_regnamespace('storage') is null then return; end if;
  perform pg_temp.pol('nnn_photos_read', 'storage.objects', 'select',
    $q$bucket_id = 'photos' and ((select public.is_admin()) or exists (select 1 from public.posts p where p.image = objects.name and public.in_group(p.group_id)))$q$, null);
end $$;

-- ---------- Temps réel ------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['groups','group_members','group_reads'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object or undefined_object then null;
    end;
  end loop;
end $$;
