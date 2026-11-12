#!/bin/bash
set -euo pipefail

# ============================================================================
# update.sh — safe in-place update for a single-country SIS install.
#
# Pulls the latest code from the repo, applies any pending DB migrations, then
# rebuilds and recreates ONLY the application containers and refreshes nginx
# (recreated or restarted only if its definition or configuration changed).
#
#   git pull → apply migrations/*.sql → up --build sis-api sis-api-glosis
#              sis-web-mapping → refresh nginx → health check
#
# IT NEVER TOUCHES YOUR DATA. It does not run `down`, never passes `-v`, and
# never reloads the seed dump. Everything you uploaded — the Postgres database
# (sis-database), the pyCSW records (sis-metadata) and the rasters
# (sis-web-services) — lives in volumes that `up --build` leaves untouched.
#
# Out of scope (left running untouched): the data containers themselves
# (Postgres / pyCSW / MapServer base images). A Postgres *major* upgrade or a
# change to those images is a deliberate, manual operation — not this script.
#
# Usage:   ./update.sh [-y]      # run from the install dir; -y skips the prompt
# Env:     DC="docker compose"   # override the compose command if needed
# ============================================================================

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # the install / repo root

DC="${DC:-docker compose}"
DB_SVC="sis-database"
APP_SVCS="sis-api sis-api-glosis sis-web-mapping"   # code containers only
ASSUME_YES=0
[ "${1:-}" = "-y" ] && ASSUME_YES=1

err(){ echo "ERROR: $*" >&2; exit 1; }
# psql inside the running DB container (data DB is sis/sis).
dbpsql(){ $DC exec -T "$DB_SVC" psql -U sis -d sis "$@"; }

# ---- preflight -------------------------------------------------------------
command -v git >/dev/null 2>&1 || err "git not found."
$DC version >/dev/null 2>&1     || err "'docker compose' not available."
[ -d .git ]                     || err "not a git checkout: $(pwd)"
[ -f docker-compose.yml ]       || err "docker-compose.yml not found in $(pwd)"
dbpsql -tAc "SELECT 1" >/dev/null 2>&1 \
  || err "$DB_SVC is not reachable — start the stack first (docker compose up -d)."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
OLD=$(git rev-parse --short HEAD)
echo "Install dir : $(pwd)"
echo "Branch      : $BRANCH   (at $OLD)"

# ---- 0. canonical remote ---------------------------------------------------
# Installs from before the repository moved (FAO-SID/SIS-dev →
# FAO-SID/OpenNSIS → un-fao/OpenNSIS) still point at the old names and ride
# GitHub's redirects — which only survive until a new repository ever claims
# an old name. Re-point such remotes to the official URL, preserving any
# embedded credentials. Forks and custom remotes are left untouched.
CUR_URL=$(git remote get-url origin 2>/dev/null || echo "")
case "$CUR_URL" in
  *github.com/FAO-SID/SIS-dev*|*github.com/FAO-SID/OpenNSIS*|*github.com:FAO-SID/SIS-dev*|*github.com:FAO-SID/OpenNSIS*)
    NEW_URL=$(printf '%s' "$CUR_URL" | sed -E 's#(github\.com[/:])FAO-SID/(SIS-dev|OpenNSIS)#\1un-fao/OpenNSIS#')
    git remote set-url origin "$NEW_URL"
    echo "### 0/4  origin re-pointed to the official repository: $NEW_URL"
    ;;
esac

# ---- 1. pull latest (auto-stash generated files like pycsw.yml) ------------
echo "### 1/4  git pull --ff-only origin/$BRANCH"
git fetch --quiet --tags origin
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "  local changes present (e.g. generated sis-metadata/pycsw.yml) — stashing"
  git stash push --quiet -m "sis-update-autostash" && STASHED=1 || true
fi
if ! git merge --ff-only "origin/$BRANCH" --quiet; then
  [ "$STASHED" = 1 ] && git stash pop --quiet || true
  err "fast-forward failed (history diverged or local commits). Resolve manually, then re-run."
fi
if [ "$STASHED" = 1 ]; then
  git stash pop --quiet 2>/dev/null \
    || echo "  NOTE: could not auto-restore local changes (likely pycsw.yml). If metadata
        misbehaves, re-run the pycsw step from deploy.sh — your data is unaffected."
fi
NEW=$(git rev-parse --short HEAD)
if [ "$OLD" = "$NEW" ]; then
  echo "  already up to date at $NEW"
else
  echo "  $OLD → $NEW:"
  git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/      /'
fi

# ---- confirm ---------------------------------------------------------------
if [ "$ASSUME_YES" != 1 ]; then
  printf "Apply pending migrations and rebuild app containers? Your data is preserved. [y/N] "
  read -r ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "aborted."; exit 0;; esac
fi

# ---- 2. DB migrations ------------------------------------------------------
# Each sis-database/migrations/NNN_*.sql runs once, in filename order, inside a
# single transaction together with its bookkeeping insert — so a failure rolls
# the whole file back and records nothing. Migrations must be idempotent.
echo "### 2/4  database migrations"
dbpsql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS api;
CREATE TABLE IF NOT EXISTS api.schema_migration (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
shopt -s nullglob
applied_any=0
for f in sis-database/migrations/*.sql; do
  name=$(basename "$f")
  done_=$(dbpsql -tAc "SELECT 1 FROM api.schema_migration WHERE filename = '$name'" | tr -d '[:space:]')
  if [ "$done_" = "1" ]; then
    echo "  skip   $name"
    continue
  fi
  echo "  apply  $name"
  { cat "$f"; printf "\nINSERT INTO api.schema_migration(filename) VALUES ('%s');\n" "$name"; } \
    | dbpsql -v ON_ERROR_STOP=1 --single-transaction -q \
    || err "migration '$name' failed — rolled back, nothing recorded. Fix it and re-run."
  applied_any=1
done
shopt -u nullglob
[ "$applied_any" = 0 ] && echo "  (no pending migrations)"

# ---- 3. rebuild + recreate the application containers -----------------------
# Data containers (sis-database / sis-metadata / sis-web-services) are NOT in
# this list and keep running with their volumes intact.
# Stamp the new version so the Administration → Software & updates panel
# reflects the just-pulled commit (compose passes ${GIT_SHA} into sis-api).
export GIT_SHA="$NEW"
echo "### 3/4  rebuild app containers (data containers untouched)"
$DC up -d --build $APP_SVCS

# ---- nginx: apply a changed definition or configuration --------------------
# nginx is not rebuilt, but the pull may have changed its service definition
# (e.g. a new volume) or sis-nginx/nginx.conf. `up -d` recreates the container
# only when the definition changed. The configuration needs more care: it is
# a single-file bind mount and git REPLACES a changed file, so the running
# container keeps seeing the old one and `nginx -s reload` would silently
# re-read that. Only a restart re-attaches the mount. The new file is
# validated inside the running container first, so a broken configuration
# never takes the site down. `--no-deps` keeps the data containers untouched.
nginx_conf_sum(){ $DC exec -T sis-nginx md5sum /etc/nginx/nginx.conf 2>/dev/null | cut -d' ' -f1 || true; }
want=$(md5sum < sis-nginx/nginx.conf | cut -d' ' -f1)
nginx_ok=1
if $DC exec -T sis-nginx true >/dev/null 2>&1 && [ "$want" != "$(nginx_conf_sum)" ]; then
  { $DC exec -T sis-nginx sh -c 'cat > /tmp/nginx.candidate.conf' < sis-nginx/nginx.conf \
      && $DC exec -T sis-nginx nginx -t -c /tmp/nginx.candidate.conf; } >/dev/null 2>&1 || nginx_ok=0
  $DC exec -T sis-nginx rm -f /tmp/nginx.candidate.conf >/dev/null 2>&1 || true
fi
if [ "$nginx_ok" = 1 ]; then
  $DC up -d --no-deps sis-nginx
  if [ "$want" != "$(nginx_conf_sum)" ]; then
    $DC restart sis-nginx >/dev/null 2>&1 || true
    echo "  nginx restarted (configuration changed)"
  else
    echo "  nginx up to date"
  fi
else
  echo "  WARNING: the new sis-nginx/nginx.conf does not pass 'nginx -t'; nginx was left"
  echo "           running on its previous configuration. Fix the file and re-run."
fi

# ---- 4. health -------------------------------------------------------------
echo "### 4/4  health"
code=""
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost/api/health 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] && echo "  api health: 200" || echo "  api health: $code (give it a few more seconds, then check 'docker compose logs sis-api')"

echo "============================================================"
echo " Update complete: $OLD → $NEW.  Data preserved."
echo "============================================================"
