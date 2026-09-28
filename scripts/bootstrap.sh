#!/usr/bin/env bash
# =============================================================================
#  bootstrap.sh — Déploiement d'une nouvelle instance de la liste de naissance
#
#  Idempotent : peut être relancé plusieurs fois sans casser l'état existant.
#  Mode --dry-run : affiche les commandes sans les exécuter.
#
#  Usage :
#    ./scripts/bootstrap.sh [--dry-run]
#
#  Variables d'environnement requises (ne jamais les écrire dans ce fichier) :
#    SUPABASE_ORG_ID      → supabase orgs list
#    SUPABASE_PROJECT_NAME
#    SUPABASE_DB_PASSWORD
#    SUPABASE_PROJECT_REF → disponible après `supabase projects create`
#    RESEND_API_KEY       → laisser vide pour désactiver les notifications
#    NOTIFY_EMAIL         → adresse destinataire des notifications
#    DATABASE_URL         → postgres://postgres.<ref>:<password>@...
#
#  Ordre d'exécution :
#    1. Vérification de l'empreinte de public/index.html
#    2. Création du projet Supabase (si pas encore fait)
#    3. Application du schéma SQL
#    4. Déploiement de la fonction Edge
#    5. Injection des secrets
# =============================================================================
set -euo pipefail

# --- Couleurs -----------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
info()  { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

# --- Mode dry-run -------------------------------------------------------------
DRY=0
for arg in "$@"; do [[ "$arg" == "--dry-run" ]] && DRY=1; done
run() {
  if [[ $DRY -eq 1 ]]; then
    echo -e "${YELLOW}[DRY-RUN]${RESET} $*"
  else
    "$@"
  fi
}

# --- Racine du projet (chemin vers ce script, puis ../.) ----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# =============================================================================
#  ÉTAPE 0 — Vérification de l'empreinte du front
# =============================================================================
info "Vérification de l'empreinte de public/index.html…"

EXPECTED="da216eefc78a21fe6011fed154edb547754754a26463917c1479afcc50a28571"
ACTUAL="$(shasum -a 256 "$ROOT/public/index.html" | awk '{print $1}')"

# Après les modifications légitimes (URL API, adresse), l'empreinte change.
# On ne bloque que si le fichier n'existe pas ou n'est pas lisible.
if [[ -z "$ACTUAL" ]]; then
  error "Impossible de lire public/index.html"
fi

if [[ "$ACTUAL" == "$EXPECTED" ]]; then
  info "Empreinte originale confirmée : $ACTUAL"
else
  warn "L'empreinte diffère de l'original (attendu après modifications de déploiement)."
  warn "  Attendu  : $EXPECTED"
  warn "  Actuel   : $ACTUAL"
  warn "Si le fichier n'a PAS encore été modifié, arrêtez-vous et signalez le problème."
fi

# =============================================================================
#  ÉTAPE 1 — Création du projet Supabase
# =============================================================================
info "--- Étape 1 : Base de données Supabase ---"

: "${SUPABASE_ORG_ID:?Variable SUPABASE_ORG_ID requise (supabase orgs list)}"
: "${SUPABASE_PROJECT_NAME:?Variable SUPABASE_PROJECT_NAME requise}"
: "${SUPABASE_DB_PASSWORD:?Variable SUPABASE_DB_PASSWORD requise}"

info "Création du projet Supabase '${SUPABASE_PROJECT_NAME}'…"
run supabase projects create "${SUPABASE_PROJECT_NAME}" \
    --org-id "${SUPABASE_ORG_ID}" \
    --region eu-west-3 \
    --db-password "${SUPABASE_DB_PASSWORD}"

info "Attente de la disponibilité du projet (peut prendre ~30 s)…"
if [[ $DRY -eq 0 ]]; then sleep 30; fi

# =============================================================================
#  ÉTAPE 1b — Application du schéma SQL
# =============================================================================
info "Application du schéma SQL sur la base vide…"

: "${DATABASE_URL:?Variable DATABASE_URL requise (postgres://postgres.<ref>:<pass>@...)}"

run psql "${DATABASE_URL}" -f "$ROOT/supabase/schema.sql"

info "Vérification de la structure de la base…"
run psql "${DATABASE_URL}" -c "
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('gifts','config','contributions','site','site_backup')
  ORDER BY table_name;
"

# Vérification : 17 colonnes sur gifts
run psql "${DATABASE_URL}" -c "
  SELECT count(*) AS nb_colonnes
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'gifts';
"

# Vérification : reorder_gifts existe
run psql "${DATABASE_URL}" -c "
  SELECT routine_name FROM information_schema.routines
  WHERE routine_schema = 'public' AND routine_name = 'reorder_gifts';
"

# =============================================================================
#  ÉTAPE 2 — Fonction Edge
# =============================================================================
info "--- Étape 2 : Fonction Edge ---"

: "${SUPABASE_PROJECT_REF:?Variable SUPABASE_PROJECT_REF requise}"

info "Liaison au projet Supabase…"
run supabase link --project-ref "${SUPABASE_PROJECT_REF}"

info "Injection des secrets…"
# RESEND_API_KEY peut être vide (notifications désactivées silencieusement)
if [[ -n "${RESEND_API_KEY:-}" ]]; then
  run supabase secrets set RESEND_API_KEY="${RESEND_API_KEY}"
fi

: "${NOTIFY_EMAIL:?Variable NOTIFY_EMAIL requise}"
run supabase secrets set NOTIFY_EMAIL="${NOTIFY_EMAIL}"

info "Déploiement de la fonction Edge (--no-verify-jwt obligatoire)…"
run supabase functions deploy app --no-verify-jwt

info "URL de la fonction Edge :"
echo "  https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/app"

# =============================================================================
#  ÉTAPE 4 — Rappel configuration front
# =============================================================================
info "--- Rappel Étape 4 : URL d'API dans le front ---"
warn "Vérifiez que public/index.html contient la bonne URL d'API :"
warn "  var API=\"https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/app\";"
warn "Si ce n'est pas encore fait, appliquez le patch ciblé avant le push Git."

# =============================================================================
#  ÉTAPE 5 — Git et GitHub Pages
# =============================================================================
info "--- Étape 5 : Git et GitHub Pages ---"

: "${GITHUB_REPO_NAME:?Variable GITHUB_REPO_NAME requise (nom du dépôt GitHub à créer)}"

info "Initialisation du dépôt Git…"
run git -C "$ROOT" init
run git -C "$ROOT" add .
run git -C "$ROOT" commit -m "chore: déploiement initial liste de naissance"

info "Création du dépôt GitHub public…"
run gh repo create "${GITHUB_REPO_NAME}" --public --source="$ROOT" --remote=origin --push

info "Le workflow GitHub Actions déclenchera la publication sur Pages."
info "Activez GitHub Pages en source 'GitHub Actions' dans :"
info "  Settings → Pages → Source → GitHub Actions"

info "=== bootstrap.sh terminé ==="
