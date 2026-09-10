#!/bin/bash
set -euo pipefail

# ============================================================================
# deploy-workshop.sh — bring up ONE country's SIS as an isolated compose
# project on a shared workshop host, reachable at http://<IP>:<HOST_PORT>.
#
# This is the dedicated workshop deploy layer. It does NOT modify the base
# repo's docker-compose.yml or deploy.sh — it merges the workshop override on
# top and drives the same sequence in a project-aware way.
#
# Run it from inside that country's copy of the repo (one dir per country, so
# each has its own ./sis-database/volume etc.):
#
#   /opt/sis-bt/  →  ops/workshop/deploy-workshop.sh BT 8012
#
# Usage:
#   ops/workshop/deploy-workshop.sh <COUNTRY_CC> <HOST_PORT> [ORG_LOGO_URL]
#
# Port convention (see ops/workshop/README.md):
#   BD 8011  BT 8012  ID 8013  KG 8014  KH 8015  LA 8016  LK 8017
#   MN 8018  NP 8019  PH 8020  TH 8021  UZ 8022  VN 8023
# ============================================================================

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <COUNTRY_CC> <HOST_PORT> [ORG_LOGO_URL]" >&2
  echo "Example: $0 BT 8012" >&2
  exit 1
fi

COUNTRY=$(echo "$1" | tr '[:lower:]' '[:upper:]')   # ISO 3166-1 alpha-2
HOST_PORT="$2"
ORG_LOGO_URL="${3:-https://w7.pngwing.com/pngs/360/217/png-transparent-soil-test-computer-icons-soil-quality-soil-miscellaneous-logo-silhouette.png}"

PROJECT="sis-$(echo "$COUNTRY" | tr '[:upper:]' '[:lower:]')"   # e.g. sis-bt

# Repo root = two levels up from this script (ops/workshop/ → repo root).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERRIDE="ops/workshop/docker-compose.workshop.yml"
cd "$PROJECT_DIR"

# Compose >= 2.24 is REQUIRED for the `!override` tag in the override file.
# On older compose it silently no-ops, leaving every stack bound to the base
# dev ports (8001-8006) → 13 countries collide on the same ports. Fail hard
# rather than let that happen mid-setup.
CV=$(docker compose version --short 2>/dev/null || echo "0")
if [[ "$(printf '%s\n2.24.0\n' "$CV" | sort -V | head -1)" != "2.24.0" ]]; then
  echo "ERROR: docker compose $CV — the workshop needs >= 2.24 for the" >&2
  echo "       '!override' tag that drops the base dev port bindings." >&2
  echo "       Ubuntu 24.04 + current docker-ce ships a new enough one." >&2
  exit 1
fi

# Exported so the override interpolates ${PROJECT} and ${HOST_PORT}.
export PROJECT HOST_PORT

# Project-aware compose + exec helpers.
dc()   { docker compose -p "$PROJECT" -f docker-compose.yml -f "$OVERRIDE" "$@"; }
dx()   { dc exec -T "$@"; }                 # exec in a service (stdin ok via -T)

####################
# Bootstrap .env   #
####################
# Same scheme as the base deploy.sh — per-deployment random secrets.
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  [[ -f "$PROJECT_DIR/.env.example" ]] || { echo "ERROR: no .env or .env.example in $PROJECT_DIR" >&2; exit 1; }
  echo "No .env found — generating one with random secrets..."
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  sed -i "s|^POSTGRES_PASSWORD=__GENERATE_ME__|POSTGRES_PASSWORD=$(rand 32)|"                 "$PROJECT_DIR/.env"
  sed -i "s|^POSTGRES_GLOSIS_PASSWORD=__GENERATE_ME__|POSTGRES_GLOSIS_PASSWORD=$(rand 32)|"   "$PROJECT_DIR/.env"
  sed -i "s|^SECRET_KEY=__GENERATE_ME__|SECRET_KEY=$(rand 48)|"                               "$PROJECT_DIR/.env"
  sed -i "s|^WEB_MAPPING_API_KEY=__GENERATE_ME__|WEB_MAPPING_API_KEY=$(rand 43)|"             "$PROJECT_DIR/.env"
  chmod 600 "$PROJECT_DIR/.env"
  echo ".env generated (chmod 600)."
fi
set -a; source "$PROJECT_DIR/.env"; set +a

ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)

echo "============================================================"
echo " Deploying $COUNTRY  →  project $PROJECT  →  http://<IP>:$HOST_PORT"
echo "============================================================"

####################
#      Docker      #
####################
# Tear down ONLY this country's project; wipe its DB volume for a clean init.
dc down -v --remove-orphans
rm -rf "$PROJECT_DIR/sis-database/volume/"* 2>/dev/null || true

# sis-api runs as uid 1000 (appuser) and writes rasters + pyCSW XML into
# these bind mounts. On a server where the repo was cloned by root they're
# root-owned → PermissionError on upload. Chown when we can (root on the
# server); best-effort elsewhere (dev laptops usually already match uid 1000).
chown -R 1000:1000 "$PROJECT_DIR/sis-web-services/volume" \
                   "$PROJECT_DIR/sis-metadata/volume" 2>/dev/null \
  || echo "NOTE: could not chown volumes to uid 1000 (not root?) — fine if your user is uid 1000."

####################
#  sis-database    #
####################
dc up --build sis-database -d
echo "Waiting for $PROJECT-database PostgreSQL to accept queries..."
until dx sis-database psql -U sis -d sis -c "SELECT 1" >/dev/null 2>&1; do sleep 2; done
echo "PostgreSQL ready."

dc cp "$PROJECT_DIR/sis-database/init.sql" sis-database:/tmp/init.sql
dc cp "$PROJECT_DIR/sis-database/sis-database_latest_with_codelist.sql" sis-database:/tmp/dump.sql
# Strip pg_dump 18+ \restrict/\unrestrict meta-commands (psql 17.5 rejects them).
dx sis-database sed -i -E '/^\\(restrict|unrestrict)( |$)/d' /tmp/dump.sql
sleep 3
dx sis-database psql -d sis -U sis -f /tmp/init.sql
dx sis-database psql -d sis -U sis -f /tmp/dump.sql

# Bring the freshly seeded schema up to date. The seed dump can lag behind
# sis-database/migrations/ (migrations are idempotent, so re-running ones the
# dump already contains is harmless). Same ledgered runner as update.sh, so a
# later update.sh skips everything applied here.
echo "Applying database migrations..."
dx sis-database psql -d sis -U sis -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS api;
CREATE TABLE IF NOT EXISTS api.schema_migration (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
shopt -s nullglob
for f in "$PROJECT_DIR"/sis-database/migrations/*.sql; do
  name=$(basename "$f")
  echo "  apply  $name"
  { cat "$f"; printf "\nINSERT INTO api.schema_migration(filename) VALUES ('%s') ON CONFLICT DO NOTHING;\n" "$name"; } \
    | dx sis-database psql -d sis -U sis -v ON_ERROR_STOP=1 --single-transaction -q \
    || { echo "ERROR: migration '$name' failed — rolled back."; exit 1; }
done
shopt -u nullglob

# Rotate the read-only federation role's password to the .env value.
dx sis-database psql -d sis -U sis -v glosis_pw="$POSTGRES_GLOSIS_PASSWORD" \
  <<< "ALTER ROLE sis_glosis WITH PASSWORD :'glosis_pw';"

# Country name + map centroid from soil_data.country (neutral fallbacks).
COUNTRY_NAME=$(dx sis-database psql -U sis -d sis -tAc \
  "SELECT en FROM soil_data.country WHERE country_id = '$COUNTRY';" 2>/dev/null | tr -d '\r' || true)
COUNTRY_CENTROID=$(dx sis-database psql -U sis -d sis -tAc \
  "SELECT ST_X(geom_centroid)::text || '|' || ST_Y(geom_centroid)::text
   FROM soil_data.country WHERE country_id = '$COUNTRY';" 2>/dev/null | tr -d '\r' || true)
COUNTRY_LON=$(echo "$COUNTRY_CENTROID" | cut -d'|' -f1)
COUNTRY_LAT=$(echo "$COUNTRY_CENTROID" | cut -d'|' -f2)
[ -z "$COUNTRY_NAME" ] && COUNTRY_NAME="$COUNTRY"
[ -z "$COUNTRY_LAT" ] && COUNTRY_LAT="0"
[ -z "$COUNTRY_LON" ] && COUNTRY_LON="0"

# Public WMS base URL advertised in mapfile capabilities (migration 019) —
# external WMS clients (QGIS) follow it, so it must carry this instance's
# public IP and port. Best-effort IP detection; fix in Settings if wrong.
PUB_IP=$(curl -fs -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
WMS_PUBLIC_URL="http://${PUB_IP}:${HOST_PORT}/mapserver"

# App settings. DOWNLOAD_BASE_URL stays relative (/downloads/) → resolves
# against this country's own origin:port.
dx sis-database psql -d sis -U sis -v ON_ERROR_STOP=1 \
  -v title="Soil Information System of $COUNTRY_NAME" \
  -v lat="$COUNTRY_LAT" -v lon="$COUNTRY_LON" \
  -v wmsurl="$WMS_PUBLIC_URL" <<EOF
INSERT INTO api.setting(key, value) VALUES
 ('COUNTRY_CODE', '$COUNTRY'),
 ('ORG_LOGO_URL','$ORG_LOGO_URL'),
 ('LANGUAGE','${LANGUAGE:-en}'),
 ('LAYER_PANEL_COLLAPSED','false'),
 ('APP_TITLE', :'title'),
 ('LATITUDE', :'lat'),
 ('LONGITUDE', :'lon'),
 ('ZOOM','9'),
 ('BASE_MAP_DEFAULT','esri-imagery'),
 ('DOWNLOAD_BASE_URL','/downloads/'),
 ('WMS_PUBLIC_URL', :'wmsurl')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
EOF

# API client used by the SPA (key matches .env WEB_MAPPING_API_KEY).
dx sis-database psql -d sis -U sis -v web_key="$WEB_MAPPING_API_KEY" \
  <<< "INSERT INTO api.api_client (api_client_id, api_key, description, is_active) VALUES ('sis-web-mapping', :'web_key', 'Web mapping frontend', true);"

##################
#     sis-api    #
##################
dc up --build sis-api -d
sleep 2
ADMIN_HASH=$(dx sis-api python -c "import bcrypt,sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt()).decode())" "$ADMIN_PASSWORD")
dx sis-database psql -d sis -U sis -v hash="$ADMIN_HASH" \
  <<< "INSERT INTO api.\"user\" (user_id, password_hash, is_active, is_admin)
       VALUES ('admin', :'hash', true, true)
       ON CONFLICT (user_id) DO UPDATE SET
         password_hash = EXCLUDED.password_hash, is_active = true, is_admin = true,
         password_changed_at = now(), failed_login_attempts = 0, locked_until = NULL;"

##################
# sis-api-glosis #
##################
dc up --build sis-api-glosis -d

####################
#     sis-nginx    #
####################
dc up sis-nginx -d

###########################
#     sis-web-services    #
###########################
dc up --build sis-web-services -d

#######################
#     sis-metadata    #
#######################
cp "$PROJECT_DIR/sis-metadata/pycsw_default.yml" "$PROJECT_DIR/sis-metadata/pycsw.yml"
sed -i "s|COUNTRY_SIS|$COUNTRY_NAME|g" "$PROJECT_DIR/sis-metadata/pycsw.yml"
sed -i "s|__POSTGRES_PASSWORD__|$POSTGRES_PASSWORD|g" "$PROJECT_DIR/sis-metadata/pycsw.yml"
dc up --build sis-metadata -d
# Cosmetic pyCSW UI branding (best-effort).
dx sis-metadata sed -i "s/pycsw website/${COUNTRY_NAME} SIS metadata/g" pycsw/pycsw/ogc/api/templates/_base.html 2>/dev/null || true
dx sis-metadata sed -i "s|https://pycsw.org/img/pycsw-logo-vertical.png|${ORG_LOGO_URL}|g" pycsw/pycsw/ogc/api/templates/_base.html 2>/dev/null || true

##########################
#     sis-web-mapping    #
##########################
# Relative URLs so the SPA calls its own origin:port (API_KEY still comes from
# the base build arg = .env WEB_MAPPING_API_KEY). Passed as --build-arg for
# reliable override across compose versions.
dc build --build-arg API_URL="" --build-arg MAPSERVER_URL=/mapserver sis-web-mapping
dc up -d sis-web-mapping

##########################
#  Health + credentials  #
##########################
sleep 2
echo -n "Health: "; curl -s "http://localhost:${HOST_PORT}/api/health" || echo "(not ready yet — give it a few seconds)"
echo
echo "============================================================"
echo " $COUNTRY ($COUNTRY_NAME) deployed."
echo " URL:            http://<IP>:$HOST_PORT/"
echo " Admin login:    admin"
echo " Admin password: $ADMIN_PASSWORD"
echo
echo " Save this password now — it will not be shown again."
echo "============================================================"
