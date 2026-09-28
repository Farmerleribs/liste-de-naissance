# Liste de naissance

Site de liste de naissance statique, hébergé sur **GitHub Pages**.

Ce dépôt contient **tout** ce qui constitue le projet. Rien n'est décrit « de mémoire » :
le HTML est l'octet pour octet celui qui est en ligne, le schéma SQL est extrait par
introspection de la base réelle, et la fonction Edge est la version 17 déployée.

---

## 1. Architecture

Trois briques, aucune autre dépendance.

```
    Navigateur de l'invité
            │
            │  fetch() vers .../functions/v1/app?action=state
            ▼
  ┌──────────────────────┐        ┌──────────────────────────────┐
  │  GitHub Pages        │        │  Supabase — fonction Edge    │
  │  public/index.html   │───────▶│  slug `app`, Deno/TypeScript │
  │  un seul fichier     │        │  verify_jwt = false          │
  └──────────────────────┘        └───────────────┬──────────────┘
                                                 │ SERVICE_ROLE_KEY
                                                 ▼
                                  ┌──────────────────────────────┐
                                  │  PostgreSQL 17               │
                                  │  gifts / config /            │
                                  │  contributions               │
                                  │  RLS activé, zéro policy     │
                                  └──────────────────────────────┘
                                                 │
                                                 ▼
                                       Resend (notifications)
```

**Le front est un fichier unique.** `public/index.html` embarque le HTML,
le CSS, les motifs SVG et tout le JavaScript. Pas de build, pas de bundler, pas de
node_modules. Il est publié via GitHub Actions sur GitHub Pages.

**La fonction Edge est la seule porte d'entrée de la base.** Aucun client ne parle à
PostgREST. Voir la section Sécurité.

---

## 2. Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `public/index.html` | Le site entier. |
| `supabase/schema.sql` | DDL complet : 5 tables, 1 fonction, RLS. À jouer sur une base vierge. |
| `supabase/functions/app/index.ts` | Fonction Edge `app`, version 17. |
| `.env.example` | Les secrets attendus par la fonction Edge. |
| `scripts/bootstrap.sh` | Déploiement complet d'une nouvelle instance (idempotent, `--dry-run`). |
| `scripts/verifier.sh` | Vérification post-déploiement (marqueurs, syntaxe JS, secrets). |
| `.github/workflows/deploy.yml` | Publication automatique sur GitHub Pages. |
| `BRIEF-IDE.md` | Instructions pour un agent de développement reprenant le projet. |

---

## 3. Reconstruire le projet de zéro

### 3.1 Base de données

```bash
# Nouveau projet Supabase (région eu-west-3 recommandée), puis :
psql "$DATABASE_URL" -f supabase/schema.sql
```

La base reste **vide** après le schéma. Aucune donnée de démonstration.

### 3.2 Changer le code parent

Le DEFAULT dans `schema.sql` est `'0000'` (valeur neutre pour le dépôt public).
Après déploiement, posez le vrai code directement en base :

```sql
UPDATE public.config SET parent_code = '<votre code>' WHERE id = 1;
```

### 3.3 Fonction Edge

```bash
supabase link --project-ref <ref>
supabase secrets set RESEND_API_KEY=<clé> NOTIFY_EMAIL=<destinataire>
supabase functions deploy app --no-verify-jwt
```

`--no-verify-jwt` est **obligatoire** : le site est public et l'espace parents
s'authentifie par `config.parent_code`, pas par un JWT Supabase.

### 3.4 Front

Dans `public/index.html`, l'URL de l'API est à la ligne 451 :

```
var API="https://<ref>.supabase.co/functions/v1/app";
```

Remplacer `<ref>` par la référence du nouveau projet Supabase. Patch ciblé uniquement —
ne jamais réécrire ce fichier en entier.

### 3.5 Hébergement GitHub Pages

Le dépôt doit être **public**. La publication se fait via GitHub Actions :

```bash
git init
git add .
git commit -m "chore: déploiement initial"
gh repo create <nom-du-repo> --public --source=. --remote=origin --push
```

Activer Pages dans : **Settings → Pages → Source → GitHub Actions**.

Le workflow `.github/workflows/deploy.yml` publie automatiquement le dossier `public/`
à chaque push sur `main`.

---

## 4. Modèle de sécurité — à ne pas « corriger »

**RLS est activé sur les cinq tables, avec zéro policy.** Ce n'est pas un oubli.

- Tout passe par la fonction Edge, qui utilise `SUPABASE_SERVICE_ROLE_KEY`. Cette clé
  contourne RLS par conception.
- Les clés `anon` / publishable ne donnent donc accès à **rien**, même si elles fuitent
  dans le HTML : sans policy, PostgREST refuse toute lecture comme toute écriture.
- Le linter Supabase signale `public.site` et `public.site_backup`. Ajouter une policy
  permissive pour faire taire l'avertissement **ouvrirait la base en lecture/écriture
  publique**. Ne pas le faire.

### Points faibles connus, assumés

- `parent_code` est un code à 4 chiffres, comparé en clair, **sans limitation de
  tentatives**. Suffisant pour un site familial diffusé par lien privé.
- Resend en bac à sable (`onboarding@resend.dev`) ne délivre qu'au propriétaire du compte
  Resend. Pour notifier quelqu'un d'autre : domaine vérifié chez Resend.

### En-têtes de sécurité

GitHub Pages ne permet pas d'en-têtes HTTP personnalisés. Les en-têtes
`X-Frame-Options`, `X-Content-Type-Options` et `Referrer-Policy` qui étaient posés par
l'ancien hébergement ne sont plus actifs.

---

## 5. Fonctionnalités et où elles vivent

| Fonctionnalité | Front (`index.html`) | Back |
|---|---|---|
| Grille des cadeaux | `renderListe`, `cardHTML`, `RAD` | `gifts` triée par `pos` |
| Filtres par catégorie | `renderFiltres`, `appliquerFiltre`, `movePill` | `config.cat_order` |
| Marqueur « Indispensable » | `.band` (bandeau vertical) + pastille de filtre | `gifts.essential` |
| Financement participatif | `finance()`, `.fin/.finb/.fint` | `gifts.funded`, action `contribute` |
| Passage auto en réservé | — | fonction Edge, `funded >= price` |
| Note par catégorie | `.cnote` | `config.notes` (jsonb) |
| Réservation | `openBuy`, `openThanks` | action `reserve`, atomique |
| Livre d'or | `openCagnotteMerci` | action `guestbook` |
| Espace parents | `ouvrirAdmin`, `renderAdmin` | `config.parent_code` |
| Import de photo | `#pfile`, canvas 600×600, JPEG q0.82 | action `set_image` (data-URI) |
| Glisser-déposer de l'ordre | `.grip`, réordonnancement local | RPC `reorder_gifts` |
| Fiche produit | lien `.fiche` | `gifts.url` |
| Motifs de fond | `<pattern>` `BP` / `BPs` / `BPn` | — |

### Design system « Formes douces B+ »

```css
--bleu:#B9CEDD   --bleu-clair:#DCE6EE   --miel:#E3BE55   --miel-txt:#8A6B18
--creme:#F6F2E7  --creme-2:#EDE8DA      --encre:#33434F  --encre-2:#5F6E79
```

Titres en **Prata**, textes en **Karla**. Les vignettes utilisent quatre rayons
organiques `--g1`…`--g4` en rotation (`RAD`).

---

## 6. Pièges rencontrés — à lire avant toute modification

Ces points ont chacun coûté un aller-retour de débogage. Ils sont reproductibles.

1. **Le nom du fichier au déploiement.** Le fichier servi doit s'appeler `index.html`.

2. **Spécificité CSS : le galet d'introduction est `.mot .bloc`, pas `.bloc`.** Une règle
   écrite sur `.bloc` seul est bien présente dans le fichier mais **ne s'applique pas**
   (deux classes battent une).

3. **L'animation `morphDoux` réimpose `border-radius`.** Corriger le rayon dans la règle
   statique ne suffit pas : les keyframes le réécrivent au défilement. Sur mobile, c'est
   `morphDouxM` (rayons bornés en px) qui prend le relais sous 640 px.

4. **`reorder` doit rester atomique.** La RPC `reorder_gifts(uuid[])` fait tout en une
   transaction, et le client réordonne localement sans recharger.

5. **Discipline de patch sur un fichier de 73 Ko.** Partir du fichier en ligne, appliquer
   des règles qui correspondent chacune **exactement une fois**, contrôler la syntaxe de
   chaque script inline (`new Function(src)`), puis refaire l'inventaire des marqueurs.

6. **Les photos sont en `fit = 'contain'` pour tous les articles.**

---

## 7. Reste à faire

- Renseigner l'adresse postale (`var ADRESSE` dans `index.html`, et la div `.val` dans la
  modale de réservation) : actuellement vide, à compléter depuis l'espace parents ou par
  patch ciblé.
- Changer `parent_code` en base après déploiement (DEFAULT public : `'0000'`).
- 15 articles sans photo : importables depuis l'espace parents.
- L'ordre des catégories n'est modifiable qu'en base (`config.cat_order`).
