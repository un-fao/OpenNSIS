#!/bin/bash
set -euo pipefail

# Set working directory.
# These three may be overridden from the environment (e.g. by
# ops/single/first-deploy.sh) so the same script drives a scripted server
# deploy without editing it; the defaults preserve local-dev behaviour.
PROJECT_DIR="${PROJECT_DIR:-/home/carva014/Work/Code/FAO/OpenNSIS}"   # << or export PROJECT_DIR=…
COUNTRY="${COUNTRY:-BT}"                                # ISO 3166-1 alpha-2; full name and centroid are looked up from soil_data.country
LANGUAGE="${LANGUAGE:-en}"                              # default UI language for this instance (en, es)
ORG_LOGO_URL="${ORG_LOGO_URL:-https://tse4.mm.bing.net/th/id/OIP.hV37F63PxOkqMwTAlCNnvQAAAA?r=0&pid=Api}"

cd "$PROJECT_DIR"

# Version stamp for the Administration → Software & updates panel (compose
# passes ${GIT_SHA} into sis-api). Harmless if not a git checkout.
export GIT_SHA="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

####################
# Bootstrap .env   #
####################
# Generate per-deployment secrets the first time deploy.sh runs.
# .env is gitignored — never committed.
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  if [[ ! -f "$PROJECT_DIR/.env.example" ]]; then
    echo "ERROR: neither .env nor .env.example found in $PROJECT_DIR" >&2
    exit 1
  fi
  echo "No .env found — generating one with random secrets..."
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"

  rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  P_PG=$(rand 32)
  P_GLOSIS=$(rand 32)
  P_SECRET=$(rand 48)
  P_WEB=$(rand 43)

  # Use | as sed delimiter since values may contain / and =
  sed -i "s|^POSTGRES_PASSWORD=__GENERATE_ME__|POSTGRES_PASSWORD=$P_PG|"                    "$PROJECT_DIR/.env"
  sed -i "s|^POSTGRES_GLOSIS_PASSWORD=__GENERATE_ME__|POSTGRES_GLOSIS_PASSWORD=$P_GLOSIS|"  "$PROJECT_DIR/.env"
  sed -i "s|^SECRET_KEY=__GENERATE_ME__|SECRET_KEY=$P_SECRET|"                              "$PROJECT_DIR/.env"
  sed -i "s|^WEB_MAPPING_API_KEY=__GENERATE_ME__|WEB_MAPPING_API_KEY=$P_WEB|"               "$PROJECT_DIR/.env"

  chmod 600 "$PROJECT_DIR/.env"
  echo ".env generated with random secrets (chmod 600)."
fi

# Optional automatic HTTPS: `export DOMAIN=soil.example.org` before running
# deploy.sh and the Caddy TLS front is enabled — certificates are obtained
# and renewed automatically. Persisted into .env so later `docker compose`
# invocations and update.sh keep the same topology.
if [[ -n "${DOMAIN:-}" ]] && ! grep -q "^COMPOSE_PROFILES=tls" "$PROJECT_DIR/.env"; then
  {
    echo ""
    echo "# Automatic HTTPS (added by deploy.sh — see 'Enabling HTTPS' in the README)"
    echo "DOMAIN=$DOMAIN"
    echo "COMPOSE_PROFILES=tls"
    echo "NGINX_HTTP_BIND=127.0.0.1:8080"
    echo "NGINX_HTTPS_BIND=127.0.0.1:8443"
  } >> "$PROJECT_DIR/.env"
  echo "HTTPS enabled for $DOMAIN (Caddy TLS front, certificates via Let's Encrypt)."
fi

# Load .env so shell can use the same vars docker compose sees
set -a
source "$PROJECT_DIR/.env"
set +a

# Random first-login admin password — printed once at the end.
ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)

# Hosts ports
HOST_SIS_API_DEV="localhost:8002" # make sure is the same as API_URL in docker compose.yml
HOST_SIS_API_PROD="sis-api:8000"
HOST_SIS_API=$HOST_SIS_API_DEV

HOST_SIS_METADATA_DEV="localhost:8003" # make sure is the same as PYCSW_SERVER_URL in docker compose.yml
HOST_SIS_METADATA_PROD="sis-metadata:8000"
HOST_SIS_METADATA=$HOST_SIS_METADATA_DEV

HOST_SIS_WEB_SERVICES_DEV="localhost:8004"
HOST_SIS_WEB_SERVICES_PROD="sis-web-services:80"
HOST_SIS_WEB_SERVICES=$HOST_SIS_WEB_SERVICES_DEV

clear 2>/dev/null || true


####################
#      Docker      #
####################

# Tear down only the SIS compose project — now does NOT touch other containers
docker compose down -v --remove-orphans
# Remove old DB volume content so init.sql + dump rerun against a clean state
rm -rf "$PROJECT_DIR/sis-database/volume/"* 2>/dev/null || true

# sis-api runs as uid 1000 (appuser) and writes rasters + pyCSW XML into these
# bind mounts. On a server where the repo was cloned by root they are
# root-owned, so every raster registration fails with a PermissionError while
# read-only operations look fine. Chown when we can (root on a server);
# best-effort elsewhere (dev laptops usually already match uid 1000).
chown -R 1000:1000 "$PROJECT_DIR/sis-web-services/volume" \
                   "$PROJECT_DIR/sis-metadata/volume" 2>/dev/null \
  || echo "NOTE: could not chown volumes to uid 1000 (not root?) — fine if your user is uid 1000."


####################
#  sis-database    #
####################

# Build and run sis-database container
docker compose up --build sis-database -d

# Wait for the PostgreSQL server to actually accept queries.
# pg_isready returns success during the entrypoint's init phase too — too soon.
echo "Waiting for sis-database PostgreSQL to accept queries..."
until docker exec sis-database psql -U sis -d sis -c "SELECT 1" >/dev/null 2>&1; do
  sleep 2
done
echo "sis-database PostgreSQL is ready."

# Copy SQL scripts to sis-database container
docker cp $PROJECT_DIR/sis-database/init.sql sis-database:/tmp/init.sql
docker cp $PROJECT_DIR/sis-database/sis-database_latest_with_codelist.sql sis-database:/tmp/sis-database_latest_with_codelist.sql

# pg_dump 18+ emits \restrict / \unrestrict meta-commands that older psql
# versions (we ship 17.5) reject. Strip them — they're cosmetic.
docker exec sis-database sed -i -E '/^\\(restrict|unrestrict)( |$)/d' /tmp/sis-database_latest_with_codelist.sql

# Execute SQL scripts inside the container
sleep 5
docker exec sis-database psql -d sis -U sis -f /tmp/init.sql
docker exec sis-database psql -d sis -U sis -f /tmp/sis-database_latest_with_codelist.sql

# Bring the freshly seeded schema up to date. The seed dump can lag behind
# sis-database/migrations/ (migrations are idempotent, so re-running ones the
# dump already contains is harmless). Same ledgered runner as update.sh, so a
# later update.sh skips everything applied here.
echo "Applying database migrations..."
docker exec -i sis-database psql -d sis -U sis -v ON_ERROR_STOP=1 -q <<'SQL'
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
    | docker exec -i sis-database psql -d sis -U sis -v ON_ERROR_STOP=1 --single-transaction -q \
    || { echo "ERROR: migration '$name' failed — rolled back."; exit 1; }
done
shopt -u nullglob

# Rotate the sis_glosis role password to the value generated in .env.
# (sis-api-glosis connects with this. The default password from init.sql is the
# role name — rotate it now so each deployment has its own.)
# Note: psql variable substitution `:'var'` only works on stdin / -f, not -c.
docker exec -i sis-database psql -d sis -U sis \
  -v glosis_pw="$POSTGRES_GLOSIS_PASSWORD" \
  <<< "ALTER ROLE sis_glosis WITH PASSWORD :'glosis_pw';"

# Pull country-specific values from soil_data.country:
#  - en           → English country name, used to build APP_TITLE
#  - geom_centroid → Point geometry, used as the default map centre
# Fall back to neutral defaults if the row or column is missing so the
# deploy still completes — the operator can fix the seed afterwards.
COUNTRY_NAME=$(docker exec sis-database psql -U sis -d sis -tAc \
  "SELECT en FROM soil_data.country WHERE country_id = '$COUNTRY';" 2>/dev/null || true)
COUNTRY_CENTROID=$(docker exec sis-database psql -U sis -d sis -tAc \
  "SELECT ST_X(geom_centroid)::text || '|' || ST_Y(geom_centroid)::text
   FROM soil_data.country WHERE country_id = '$COUNTRY';" 2>/dev/null || true)
COUNTRY_LON=$(echo "$COUNTRY_CENTROID" | cut -d'|' -f1)
COUNTRY_LAT=$(echo "$COUNTRY_CENTROID" | cut -d'|' -f2)
[ -z "$COUNTRY_NAME" ] && COUNTRY_NAME="$COUNTRY"
[ -z "$COUNTRY_LAT" ] && COUNTRY_LAT="0"
[ -z "$COUNTRY_LON" ] && COUNTRY_LON="0"

# Public WMS base URL advertised in mapfile capabilities (migration 019) so
# external WMS clients (QGIS) reach the right address through the proxy.
# With a domain -> https://<domain>/mapserver; otherwise best-effort public IP
# (correct it later under Administration -> Settings if the guess is wrong).
if [[ -n "${DOMAIN:-}" ]]; then
  WMS_PUBLIC_URL="https://${DOMAIN}/mapserver"
else
  PUB_IP=$(curl -fs -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  WMS_PUBLIC_URL="http://${PUB_IP}/mapserver"
fi

# Add sis-Web-mapping applications settings.
# COUNTRY_CODE is the ISO 3166-1 alpha-2 code (BT, PH, VN, …) taken from the
# COUNTRY var at the top of this script.
docker exec -i sis-database psql -d sis -U sis \
  -v ON_ERROR_STOP=1 \
  -v title="Soil Information System of $COUNTRY_NAME" \
  -v lat="$COUNTRY_LAT" \
  -v lon="$COUNTRY_LON" \
  -v wmsurl="$WMS_PUBLIC_URL" \
  <<EOF
INSERT INTO api.setting(key, value) VALUES
 ('COUNTRY_CODE', '$COUNTRY'),
 ('ORG_LOGO_URL','$ORG_LOGO_URL'),
 ('LANGUAGE','$LANGUAGE'),
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

# Seed API client used by sis-web-mapping (key matches .env WEB_MAPPING_API_KEY).
# Pass the key as a psql variable to avoid shell-quoting issues. psql variable
# substitution requires stdin / -f mode, not -c.
docker exec -i sis-database psql -d sis -U sis \
  -v web_key="$WEB_MAPPING_API_KEY" \
  <<< "INSERT INTO api.api_client (api_client_id, api_key, description, is_active) VALUES ('sis-web-mapping', :'web_key', 'Web mapping frontend', true);"


##################
#     sis-api    #
##################

# Build and start container
docker compose up --build sis-api -d

# Test SIS API
curl -s http://localhost:8002/health || true

# Provision the admin user with a fresh per-deployment password (printed at
# the end of deploy.sh and never written to disk). bcrypt is computed inside
# the running sis-api container (which has the bcrypt package).
sleep 2
ADMIN_HASH=$(docker exec sis-api python -c "
import bcrypt, sys
print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt()).decode())
" "$ADMIN_PASSWORD")
docker exec -i sis-database psql -d sis -U sis \
  -v hash="$ADMIN_HASH" \
  <<< "INSERT INTO api.\"user\" (user_id, password_hash, is_active, is_admin)
       VALUES ('admin', :'hash', true, true)
       ON CONFLICT (user_id) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         is_active = true, is_admin = true,
         password_changed_at = now(),
         failed_login_attempts = 0, locked_until = NULL;"


##################
# sis-api-glosis #
##################

# Connects as the read-only sis_glosis Postgres role. Federation access is
# OFF by default — the SIS admin enables it from Administration → GloSIS
# Federation, which sets api.setting GLOSIS_FEDERATION_ENABLED='true' and
# generates the token to share with the Discovery Hub.
docker compose up --build sis-api-glosis -d
curl -s http://localhost:8006/health || true


####################
#     sis-nginx    #
####################

# Build and start container
docker compose up sis-nginx -d


###########################
#     sis-web-services    #
###########################

# # Copy .tif and .map files
# rm -f $PROJECT_DIR/sis-web-services/volume/*.map
# rm -f $PROJECT_DIR/sis-web-services/volume/*.tif
# cp /home/carva014/Downloads/FAO/AFACI/$COUNTRY/output/*.tif $PROJECT_DIR/sis-web-services/volume
# cp /home/carva014/Downloads/FAO/AFACI/$COUNTRY/output/*.map $PROJECT_DIR/sis-web-services/volume

# Build and start MapServer container
docker compose up --build sis-web-services -d


#######################
#     sis-metadata    #
#######################

# Customize pyCSW
cp $PROJECT_DIR/sis-metadata/pycsw_default.yml $PROJECT_DIR/sis-metadata/pycsw.yml
sed -i "s|COUNTRY_SIS|$COUNTRY_NAME|g" $PROJECT_DIR/sis-metadata/pycsw.yml
# Inject the per-deployment Postgres password from .env. pyCSW reads its DB
# connection string from pycsw.yml (not from env vars), so we substitute here.
sed -i "s|__POSTGRES_PASSWORD__|$POSTGRES_PASSWORD|g" $PROJECT_DIR/sis-metadata/pycsw.yml

# Build and start pyCSW container
docker compose up --build sis-metadata -d

# Customize pyCSW UI - https://docs.pycsw.org/en/latest/configuration.html
docker exec sis-metadata sed -i "s/pycsw website/${COUNTRY_NAME} SIS metadata/g" pycsw/pycsw/ogc/api/templates/_base.html
docker exec sis-metadata sed -i "s|https://pycsw.org/img/pycsw-logo-vertical.png|${ORG_LOGO_URL}|g" pycsw/pycsw/ogc/api/templates/_base.html
docker exec sis-metadata sed -i "s/https:\/\/pycsw.org/http:\/\/$HOST_SIS_METADATA\/collections\/metadata:main\/items/g" pycsw/pycsw/ogc/api/templates/_base.html

# # Load records — table only exists after pyCSW has been initialized at least
# # once, so the DELETE is best-effort on a fresh deploy.
# docker exec sis-database psql -U sis -d sis \
#   -c "DELETE FROM soil_data.records;" 2>/dev/null || true
# rm -f $PROJECT_DIR/sis-metadata/volume/*.xml
# cp /home/carva014/Downloads/FAO/AFACI/$COUNTRY/output/*.xml $PROJECT_DIR/sis-metadata/volume
# docker exec sis-metadata ls -l /records
# rm -f $PROJECT_DIR/sis-metadata/volume/*.tif.aux.xml
# docker exec sis-metadata pycsw-admin.py load-records -c /etc/pycsw/pycsw.yml -p /records -r -y

# # Verify if records were loaded
# docker exec sis-database psql -U sis -d sis -c "SELECT identifier, title FROM soil_data.records ORDER BY title LIMIT 5;"


##########################
#     sis-web-mapping    #
##########################

# Build and start container
docker compose up --build sis-web-mapping -d

# Automatic-HTTPS front, only when enabled (COMPOSE_PROFILES=tls in .env).
if [[ "${COMPOSE_PROFILES:-}" == *tls* ]]; then
  docker compose up -d sis-caddy
fi


##########################
#  Final credentials     #
##########################
echo
echo "============================================================"
echo " SIS deployment complete."
echo "------------------------------------------------------------"
echo " Admin login:    admin"
echo " Admin password: $ADMIN_PASSWORD"
echo
echo " Save this password now — it will not be shown again."
echo " Change it via the Administration tab after first login."
if [[ -n "${DOMAIN:-}" ]]; then
  echo " URL: https://$DOMAIN/  (certificate is issued on first request —"
  echo "      allow a few seconds; DNS must already point here)"
fi
echo "============================================================"
