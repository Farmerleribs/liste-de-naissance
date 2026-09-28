-- ============================================================================
--  Liste de naissance — Capucine & Axel
--  Schéma complet de la base PostgreSQL (Supabase)
--
--  Extrait par introspection du projet en production `wcdokfrjgivmdisafzio`
--  (PostgreSQL 17, région eu-west-3).
--
--  À exécuter sur une base VIERGE, dans cet ordre, avant le chargement
--  des données (voir export-donnees.sh).
--
--  ATTENTION — le projet Supabase d'origine héberge aussi les tables d'une
--  AUTRE application (préfixe `sg_` : suivi de grossesse). Elles ne font pas
--  partie de ce projet et ne sont volontairement pas reprises ici.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Extensions
--    gen_random_uuid() vient de pgcrypto. Sur Supabase elle est déjà installée
--    dans le schéma `extensions` ; la ligne ci-dessous est idempotente.
-- ----------------------------------------------------------------------------
create extension if not exists pgcrypto;


-- ----------------------------------------------------------------------------
-- 1. gifts — les articles de la liste
-- ----------------------------------------------------------------------------
create table public.gifts (
  id            uuid        not null default gen_random_uuid(),
  name          text        not null,
  description   text        not null default ''::text,
  price         text        not null default ''::text,   -- libellé libre : "39,90 €", "~25 €"…
  url           text        not null default ''::text,   -- fiche produit chez le marchand
  image         text        not null default ''::text,   -- URL http(s) OU data:image/...;base64
  category      text        not null default 'Cadeaux'::text,
  emoji         text        not null default '🎁'::text,
  parent_bought boolean     not null default false,      -- déjà acheté par les parents
  reserved_by   text            null,                    -- NULL = disponible
  reserved_at   timestamptz     null,
  created_at    timestamptz not null default now(),
  pos           integer     not null default 0,          -- ordre d'affichage (voir reorder_gifts)
  fit           text        not null default 'cover'::text,  -- 'cover' | 'contain'
  posy          integer     not null default 50,         -- cadrage vertical, 0-100
  funded        numeric     not null default 0,          -- montant déjà financé (€)
  essential     boolean     not null default false,      -- marqueur « Indispensable »
  constraint gifts_pkey primary key (id)
);

comment on column public.gifts.fit is
  'Mode d''insertion de la photo dans la vignette. La production utilise ''contain'' pour tous les articles.';
comment on column public.gifts.funded is
  'Financement participatif cumulé. Quand funded >= price, la fonction Edge bascule reserved_by automatiquement.';
comment on column public.gifts.essential is
  'Affiche le bandeau vertical « Indispensable » et alimente la pastille de filtre du même nom.';


-- ----------------------------------------------------------------------------
-- 2. config — ligne unique (id = 1) contenant tous les réglages éditables
--    depuis l'espace parents
--
--    Les DEFAULT ci-dessous sont les valeurs d'origine à la création de la
--    table. Le contenu réellement en ligne (textes remaniés, cat_order, notes
--    par catégorie, code parent) se trouve dans le dump de données.
-- ----------------------------------------------------------------------------
create table public.config (
  id           integer not null default 1,
  iban         text    not null default 'FR76 XXXX XXXX XXXX XXXX XXXX XXX'::text,
  beneficiary  text    not null default 'Capucine & Axel'::text,
  parent_code  text    not null default '0000'::text,   -- code d'accès de l'espace parents (à changer en base après déploiement)
  term_date    date    not null default '2026-12-05'::date,
  message      text    not null default 'Votre présence et votre générosité nous touchent profondément. Choisissez ce qui vous plaît : offrez un cadeau de la liste, ou participez librement à la cagnotte. Chaque geste sera un premier souvenir gravé dans son histoire.'::text,
  wero         text    not null default ''::text,
  word_title   text    not null default 'Merci d’être là pour lui'::text,
  hero_sub     text    not null default 'Nous attendons notre petit prince. Pour l’accueillir en douceur, voici sa liste de naissance.'::text,
  merci        text    not null default 'Merci pour lui ❤️'::text,
  cagnotte_url text    not null default ''::text,
  notes        jsonb   not null default '{}'::jsonb,     -- { "<catégorie>": "<texte affiché au filtre>" }
  cat_order    text[]  not null default '{}'::text[],    -- ordre des catégories sur le site
  constraint config_pkey primary key (id),
  constraint config_singleton check (id = 1)
);

comment on table public.config is
  'Singleton : la contrainte config_singleton interdit toute ligne autre que id = 1.';
comment on column public.config.parent_code is
  'ATTENTION : secret partagé en clair, comparé sans limitation de tentatives. Voir la section Sécurité du README.';


-- ----------------------------------------------------------------------------
-- 3. contributions — journal des réservations, participations et livre d'or
-- ----------------------------------------------------------------------------
create table public.contributions (
  id         uuid        not null default gen_random_uuid(),
  name       text        not null default ''::text,
  message    text        not null default ''::text,
  method     text        not null default ''::text,   -- 'iban' | 'wero' | …
  created_at timestamptz not null default now(),
  action     text        not null default ''::text,   -- 'reservation' | 'cagnotte' | 'mot'
  amount     text        not null default ''::text,
  gift_id    uuid            null,
  constraint contributions_pkey primary key (id),
  constraint contributions_gift_id_fkey foreign key (gift_id)
    references public.gifts (id) on delete set null
);

create index contributions_gift_id_idx on public.contributions using btree (gift_id);


-- ----------------------------------------------------------------------------
-- 4. site / site_backup — anciens emplacements du HTML servi par la fonction
--    Edge (GET sans paramètre). Conservés parce que la fonction les lit
--    encore, mais le site de production est servi par Netlify : le contenu de
--    `site` est une copie périmée. Ne pas s'en servir comme source de vérité.
-- ----------------------------------------------------------------------------
create table public.site (
  id   integer not null default 1,
  html text    not null default ''::text,
  constraint site_pkey primary key (id),
  constraint site_one check (id = 1)
);

create table public.site_backup (
  id         serial      not null,
  html       text            null,
  note       text            null,
  created_at timestamptz     null default now(),
  constraint site_backup_pkey primary key (id)
);


-- ----------------------------------------------------------------------------
-- 5. reorder_gifts — réécrit toutes les positions en UNE transaction
--
--    Indispensable : l'ancienne version envoyait un UPDATE par article, ce qui
--    provoquait une course avec le rechargement côté client (les éléments
--    déplacés « redescendaient »). Ne pas remplacer par une boucle.
-- ----------------------------------------------------------------------------
create or replace function public.reorder_gifts(p_ids uuid[])
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  update gifts g set pos = x.ord
  from (select unnest(p_ids) as id, generate_series(1, array_length(p_ids,1)) as ord) x
  where g.id = x.id;
  get diagnostics n = row_count;
  return n;
end $function$;


-- ----------------------------------------------------------------------------
-- 6. Sécurité : RLS ACTIVÉ, AUCUNE POLICY — c'est voulu.
--
--    Modèle : aucun client n'accède jamais à PostgREST. Tout passe par la
--    fonction Edge `app`, qui utilise SUPABASE_SERVICE_ROLE_KEY ; cette clé
--    contourne RLS par conception. Résultat : les clés anon/publishable ne
--    donnent accès à rien, et la fonction Edge est le seul chemin d'écriture.
--
--    Ne PAS ajouter de policy « permissive » pour faire taire un avertissement
--    du linter Supabase : cela ouvrirait la base en lecture/écriture publique.
-- ----------------------------------------------------------------------------
alter table public.gifts         enable row level security;
alter table public.config        enable row level security;
alter table public.contributions enable row level security;
alter table public.site          enable row level security;
alter table public.site_backup   enable row level security;


-- ----------------------------------------------------------------------------
-- 7. Ligne de configuration initiale (le dump de données l'écrase)
-- ----------------------------------------------------------------------------
insert into public.config (id) values (1) on conflict (id) do nothing;
insert into public.site   (id) values (1) on conflict (id) do nothing;
