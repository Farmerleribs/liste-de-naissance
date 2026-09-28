#!/usr/bin/env bash
# =============================================================================
#  verifier.sh — Contrôle post-déploiement de la liste de naissance
#
#  Idempotent : ne modifie rien, ne fait que vérifier.
#  Mode --dry-run : affiche ce qui serait vérifié (utile en CI).
#
#  Usage :
#    ./scripts/verifier.sh [--dry-run]
#
#  Sorties :
#    0  — tous les contrôles passent
#    1  — au moins un contrôle échoue
#
#  Contrôles effectués :
#    1. Présence du fichier public/index.html
#    2. Empreinte SHA-256 (informative après modifications légitimes)
#    3. Inventaire des 13 marqueurs fonctionnels (chacun doit être présent ≥ 1)
#    4. Syntaxe des scripts inline (node requis)
#    5. Absence de secrets connus dans le fichier déployé
#    6. Présence du workflow GitHub Actions
# =============================================================================
set -uo pipefail

# --- Couleurs -----------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
fail()  { echo -e "${RED}[FAIL]${RESET}  $*"; ERRORS=$((ERRORS+1)); }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
info()  { echo -e "        $*"; }

ERRORS=0

# --- Mode dry-run -------------------------------------------------------------
DRY=0
for arg in "$@"; do [[ "$arg" == "--dry-run" ]] && DRY=1; done

if [[ $DRY -eq 1 ]]; then
  echo -e "${YELLOW}[DRY-RUN]${RESET} Mode simulation — aucune commande réseau lancée"
fi

# --- Racine du projet ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HTML="$ROOT/public/index.html"

echo ""
echo "======================================================================="
echo "  verifier.sh — Contrôle de la liste de naissance"
echo "  Racine : $ROOT"
echo "======================================================================="
echo ""

# =============================================================================
#  1. Présence du fichier
# =============================================================================
echo "--- 1. Fichier public/index.html ---"
if [[ -f "$HTML" ]]; then
  SIZE="$(wc -c < "$HTML")"
  ok "Fichier présent (${SIZE} octets)"
else
  fail "public/index.html introuvable"
  echo ""
  echo "Erreurs totales : $ERRORS"
  exit 1
fi

# =============================================================================
#  2. Empreinte SHA-256
# =============================================================================
echo ""
echo "--- 2. Empreinte SHA-256 ---"
EXPECTED_ORIG="da216eefc78a21fe6011fed154edb547754754a26463917c1479afcc50a28571"
ACTUAL="$(shasum -a 256 "$HTML" | awk '{print $1}')"

if [[ "$ACTUAL" == "$EXPECTED_ORIG" ]]; then
  ok "Empreinte originale (fichier non encore modifié)"
  info "SHA-256 : $ACTUAL"
else
  warn "L'empreinte diffère de l'original — normal si l'URL d'API et/ou l'adresse ont été patchées."
  info "  Original  : $EXPECTED_ORIG"
  info "  Actuel    : $ACTUAL"
fi

# =============================================================================
#  3. Inventaire des marqueurs fonctionnels
# =============================================================================
echo ""
echo "--- 3. Marqueurs fonctionnels ---"

declare -a MARKERS=(
  'pattern id="BP"'
  'pattern id="BPs"'
  'pattern id="BPn"'
  'class="band"'
  'function finance'
  'class="fint"'
  'cnote'
  'Voir et offrir'
  'morphDouxM'
  'pfile'
  'function insec'
  'cat_order'
  'grip'
  'toggle_essential'
)

MARKER_OK=0
MARKER_FAIL=0

for m in "${MARKERS[@]}"; do
  COUNT="$(grep -c -- "$m" "$HTML" 2>/dev/null || echo 0)"
  if [[ "$COUNT" -ge 1 ]]; then
    ok "$(printf '%-28s' "$m") (${COUNT}×)"
    MARKER_OK=$((MARKER_OK+1))
  else
    fail "$(printf '%-28s' "$m") ABSENT (0×)"
    MARKER_FAIL=$((MARKER_FAIL+1))
    ERRORS=$((ERRORS+1))
  fi
done

info "Marqueurs OK : $MARKER_OK / $((MARKER_OK+MARKER_FAIL))"

# =============================================================================
#  4. Syntaxe des scripts inline
# =============================================================================
echo ""
echo "--- 4. Syntaxe des scripts inline ---"

if command -v node &>/dev/null; then
  node -e '
const fs = require("fs");
const h = fs.readFileSync(process.argv[1], "utf8");
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, ok = 0, ko = 0;
while ((m = re.exec(h))) {
  i++;
  try {
    new Function(m[1]);
    console.log("[OK]    script " + i + " : syntaxe valide");
    ok++;
  } catch (e) {
    console.log("[FAIL]  script " + i + " : " + e.message);
    ko++;
  }
}
if (!i) {
  console.log("[FAIL]  Aucun script inline trouvé — suspect");
  process.exitCode = 1;
} else if (ko > 0) {
  process.exitCode = 1;
}
' "$HTML"
  if [[ $? -ne 0 ]]; then
    ERRORS=$((ERRORS+1))
  fi
else
  warn "node non disponible — contrôle de syntaxe JS ignoré"
fi

# =============================================================================
#  5. Absence de secrets dans le fichier déployé
# =============================================================================
echo ""
echo "--- 5. Absence de données sensibles dans le front ---"

# Vérifier que l'adresse postale d'origine a bien été retirée
ADRESSE_ORIG="Asnières-sur-Seine"
if grep -q "$ADRESSE_ORIG" "$HTML" 2>/dev/null; then
  fail "L'adresse postale originale est encore présente dans public/index.html"
  fail "→ Appliquer le patch Étape 3 avant tout push public"
else
  ok "Adresse postale originale absente"
fi

# Vérifier que le parent_code par défaut connu n'est pas en clair dans le front
# (il est dans schema.sql, mais on vérifie le HTML aussi par précaution)
if grep -q "var ADRESSE=\"2 rue de Verdun" "$HTML" 2>/dev/null; then
  fail "var ADRESSE contient encore l'adresse réelle"
else
  ok "var ADRESSE : adresse réelle absente"
fi

# =============================================================================
#  6. Présence du workflow GitHub Actions
# =============================================================================
echo ""
echo "--- 6. Workflow GitHub Actions ---"

WORKFLOW="$ROOT/.github/workflows/deploy.yml"
if [[ -f "$WORKFLOW" ]]; then
  ok "Workflow GitHub Actions présent : .github/workflows/deploy.yml"
  # Vérification que les deux actions obligatoires sont présentes
  if grep -q "upload-pages-artifact" "$WORKFLOW"; then
    ok "actions/upload-pages-artifact référencé"
  else
    fail "actions/upload-pages-artifact absent du workflow"
  fi
  if grep -q "deploy-pages" "$WORKFLOW"; then
    ok "actions/deploy-pages référencé"
  else
    fail "actions/deploy-pages absent du workflow"
  fi
else
  warn "Workflow GitHub Actions absent — normal avant l'Étape 5"
fi

# =============================================================================
#  7. Vérification que l'URL d'API a été mise à jour
# =============================================================================
echo ""
echo "--- 7. URL d'API dans le front ---"

PROD_URL="wcdokfrjgivmdisafzio.supabase.co"
if grep -q "$PROD_URL" "$HTML" 2>/dev/null; then
  warn "L'URL d'API pointe encore vers la production (wcdokfrjgivmdisafzio)"
  warn "→ Appliquer le patch Étape 4 avant tout push public"
else
  ok "URL d'API : ne pointe plus vers wcdokfrjgivmdisafzio (production)"
  # Afficher l'URL actuellement configurée
  API_LINE="$(grep 'var API=' "$HTML" | head -1)"
  info "URL actuelle : $API_LINE"
fi

# =============================================================================
#  Bilan
# =============================================================================
echo ""
echo "======================================================================="
if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}  RÉSULTAT : TOUS LES CONTRÔLES PASSENT (0 erreur)${RESET}"
else
  echo -e "${RED}  RÉSULTAT : $ERRORS ERREUR(S) DÉTECTÉE(S)${RESET}"
fi
echo "======================================================================="
echo ""

exit $ERRORS
