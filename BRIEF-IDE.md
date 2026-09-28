# Brief à donner à un agent de développement

Ce fichier est fait pour être **collé tel quel** dans un IDE agentique (Cursor, Claude
Code, Windsurf, Copilot Workspace…) après avoir ouvert ce dépôt. Il dit ce qu'est le
projet, ce qu'il ne faut pas toucher, et comment vérifier qu'on ne l'a pas cassé.

---

## Le message à coller

> Tu reprends un projet complet et **en production**. Tout est dans ce dépôt : ne
> reconstruis rien à partir de zéro, n'improvise aucune partie.
>
> **Lis d'abord `README.md` en entier**, en particulier la section 4 (modèle de sécurité)
> et la section 6 (pièges rencontrés). Chacun de ces pièges a déjà cassé le site une fois.
>
> **Ce qu'est le projet.** Un site de liste de naissance. Trois briques : un fichier HTML
> statique unique servi par GitHub Pages, une fonction Edge Deno sur Supabase, une base
> PostgreSQL. Aucun build, aucun bundler, aucun `node_modules`. `public/index.html`
> contient le HTML, le CSS, les motifs SVG et tout le JavaScript dans deux scripts
> inline.
>
> **Règles à respecter sans exception :**
>
> 1. **Ne réécris jamais `public/index.html` en entier.** Applique des modifications
>    ciblées, et assure-toi que chaque motif recherché correspond **exactement une fois**.
>    Plusieurs sélecteurs se ressemblent : `.bloc` apparaît trois fois, et le galet
>    d'introduction est `.mot .bloc` (deux classes). Une règle écrite sur `.bloc` seul
>    sera présente dans le fichier sans jamais s'appliquer.
>
> 2. Après chaque modification du HTML, **contrôle la syntaxe des deux scripts inline**
>    (extraction puis `new Function(src)`), puis refais un inventaire des marqueurs pour
>    vérifier que rien n'a disparu :
>    `pattern id="BP"`, `pattern id="BPs"`, `pattern id="BPn"`, `class="band"`,
>    `function finance`, `class="fint"`, `cnote`, `Voir et offrir`, `morphDouxM`,
>    `pfile`, `function insec`, `cat_order`, `grip`, `toggle_essential`.
>
> 3. **RLS est activé sans aucune policy, c'est voulu.** Le linter Supabase s'en plaint
>    pour `public.site` et `public.site_backup`. N'ajoute **pas** de policy permissive :
>    cela ouvrirait la base en lecture et écriture publiques. Tout accès passe par la
>    fonction Edge avec la clé `service_role`.
>
> 4. La fonction Edge se déploie avec `--no-verify-jwt`. Le site est public et l'espace
>    parents s'authentifie par `config.parent_code`, pas par un JWT.
>
> 5. `reorder_gifts(uuid[])` doit rester une **seule** transaction. Ne la remplace pas par
>    une boucle d'`UPDATE` : cela réintroduit une course avec le rechargement côté client
>    et les éléments déplacés « redescendent ».
>
> 6. Les noms réels du code, à ne pas deviner : la fonction de rendu de la grille est
>    `renderListe` (il n'existe pas de `renderGrid`), la zone cliquable d'une carte est un
>    `<div class="bt">` (pas un `<button>`), et la poignée de glisser-déposer est
>    `<span class="grip">`.
>
> **Ce qui n'est pas dans le dépôt, volontairement :** le dump des données. La base
> démarre vide ; les articles et la configuration se saisissent depuis l'espace parents.
> Ne fabrique pas de données de démonstration.
>
> **Secrets :** aucun secret n'est dans le dépôt. Voir `.env.example`.
>
> **Ta première tâche :** ne code rien. Lis le dépôt, puis rends-moi (a) un schéma de
> l'architecture telle que tu la comprends, (b) la liste des fonctions JavaScript de
> `public/index.html` avec leur rôle, (c) la liste des actions de l'API de la fonction
> Edge en distinguant celles qui exigent le code parent. Je validerai avant toute
> modification.

---

## Vérifications automatisables

À faire tourner après toute modification du front.

```bash
# 1. Inventaire des marqueurs — chacun doit être présent
for m in 'pattern id="BP"' 'pattern id="BPs"' 'pattern id="BPn"' \
         'class="band"' 'function finance' 'class="fint"' 'cnote' \
         'Voir et offrir' 'morphDouxM' 'pfile' 'function insec' \
         'cat_order' 'grip' 'toggle_essential'; do
  printf '%-22s %s\n' "$m" "$(grep -c -- "$m" public/index.html)"
done

# 2. Syntaxe des scripts inline
node -e '
const fs=require("fs");
const h=fs.readFileSync("public/index.html","utf8");
const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m,i=0;
while((m=re.exec(h))){i++; try{new Function(m[1]); console.log("script "+i+" : OK");}
  catch(e){console.log("script "+i+" : ERREUR — "+e.message); process.exitCode=1;}}
if(!i){console.log("aucun script inline trouvé — suspect"); process.exitCode=1;}
'

# 3. Script tout-en-un
bash scripts/verifier.sh
```

## Pièges de déploiement

- Le dépôt GitHub doit être **public** pour GitHub Pages gratuit.
- Le fichier publié doit s'appeler `index.html`.
- GitHub Pages publie le dossier `public/` via le workflow `.github/workflows/deploy.yml`.
- GitHub Pages **ne permet pas d'en-têtes HTTP personnalisés** : les en-têtes de sécurité
  (`X-Frame-Options`, etc.) ne peuvent pas être posés.
- Le site n'utilise aucun chemin absolu : il fonctionne sous
  `https://<compte>.github.io/<repo>/` sans `<base href>` à ajouter.
- Ses seules dépendances externes sont les polices Google Fonts.
