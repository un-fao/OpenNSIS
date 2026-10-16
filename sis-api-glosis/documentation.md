# REST API Documentation — sis-api-glosis (GloSIS Federation)

## Table of Contents
1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Endpoints](#endpoints)
4. [Data exposed](#data-exposed)
5. [Security boundary](#security-boundary)
6. [Lifecycle (enable / disable / regenerate token)](#lifecycle)
7. [Configuration](#configuration)
8. [Error responses](#error-responses)
9. [Example session](#example-session)

---

## Overview

`sis-api-glosis` is a **separate FastAPI service** in the SIS stack. It exposes
a small, read-only surface designed for the GloSIS Discovery Hub (and any
other federated client) to consume soil-profile data from this node.

**It is intentionally narrow**:

- Only three data endpoints (`/manifest`, `/profile`, `/observation`).
- All three return what's already visible on the SIS — i.e. published
  profiles, filtered the same way the SPA filters them. There is no admin or
  write surface here.
- Connects to Postgres as a **dedicated read-only role** (`sis_glosis`).
  The role has `SELECT` only on the federation views and `api.setting`, plus
  `INSERT` on `api.audit`. Even with a valid token, callers cannot read or
  write anything else — enforced at the database layer.

The admin-side controls (enable/disable, view & regenerate the federation
token) live on the main API at `/api/glosis/*`. See
`sis-api/documentation.md` → *GloSIS Federation*.

**Ports**:
- Dev: host port `8006` → container `8000`
- Prod (recommended): not published; reached via `sis-nginx` under `/glosis/`

`/docs`, `/redoc` and `/openapi.json` are disabled by default. Set
`ENABLE_DOCS=true` in the env to re-enable them for local development.

---

## Authentication

Every endpoint requires **two gates simultaneously**:

1. **Federation flag**: the setting `GLOSIS_FEDERATION_ENABLED` in
   `api.setting` must be `'true'`. The SIS admin flips this on from the
   Administration → GloSIS Federation panel.
2. **Federation token**: an `X-API-Key: <token>` header that matches an
   active, non-expired row in `api.vw_glosis_federation_token` (a view
   restricted to `api.api_client` rows with `description = 'glosis-federation'`).

If either gate fails, the response is `401 Unauthorized` (invalid/inactive/
expired token) or `403 Forbidden` (federation disabled). The two cases use
different status codes so the Hub operator can distinguish "I have the wrong
token" from "this node hasn't accepted us yet."

There is one singleton federation token per node — generated automatically
when the admin first clicks **Enable**.

CORS is `*` because the Hub typically calls from the server side; the
endpoints don't accept cookies or credentials.

---

## Endpoints

| Method | Path           | Auth                  | Description                                         |
| ------ | -------------- | --------------------- | --------------------------------------------------- |
| GET    | `/`            | Public                | Service identification banner                       |
| GET    | `/health`      | Public                | Liveness probe (returns `{status: healthy}` only)   |
| GET    | `/manifest`    | Federation token + flag | Aggregated soil-property manifest for this node    |
| GET    | `/profile`     | Federation token + flag | Published soil profiles                             |
| GET    | `/profile?bbox=minLon,minLat,maxLon,maxLat` | Federation token + flag | Profiles inside a WGS84 rectangle |
| GET    | `/observation` | Federation token + flag | Observational data                                  |
| GET    | `/observation?profile_code=XYZ` | Federation token + flag | Observations filtered to one profile     |
| GET    | `/observation?property=CODE` | Federation token + flag | Observations of one soil property (code as in `/manifest`) |
| GET    | `/observation?bbox=…` | Federation token + flag | Observations whose profile lies inside the rectangle (filters combine) |

A malformed `bbox` returns `400` with an explanatory message. Filters exist so
federated clients can request only what a search needs instead of a node's
entire holdings.

The two public endpoints (`/`, `/health`) reveal nothing sensitive — health
errors are flattened to `{status: unhealthy}` without exception text.

---

## Data exposed

All three federation endpoints read from views, not from base tables. The
views already apply the same filters the SIS map uses, so what the Hub sees
matches **exactly** what's visible on the SIS.

### `GET /manifest` → `api.vw_api_manifest`

Per-property aggregation:

```json
[
  {
    "property": "ALUTOT",
    "profiles": 142,
    "observations": 1893,
    "geom": "POLYGON ((...))"
  },
  ...
]
```

Each row is one soil property with:
- `profiles` — count of distinct published profiles that have at least one
  observation of this property,
- `observations` — total count of `result_num` rows,
- `geom` — bounding envelope of those profiles' locations (PostGIS WKB).

### `GET /profile` → `api.vw_api_profile`

One row per published soil profile. The view enforces:
- `soil_data.project.is_published = true`
- optional per-project `profile_limit` (rows beyond the limit are skipped)
- optional per-project `spatial_blur_m` applied to the geometry

```json
[
  {
    "gid": 712,
    "profile_code": "BT-OBS-0014",
    "project_name": "GSNM Bhutan 2024",
    "altitude": 2410,
    "date": "2024-04-13",
    "geometry": { "type": "Point", "coordinates": [90.4, 27.5] }
  },
  ...
]
```

### `GET /observation` → `api.vw_api_observation`

One row per result, scoped to published profiles only:

```json
[
  {
    "profile_code": "BT-OBS-0014",
    "upper_depth": 0,
    "lower_depth": 30,
    "property_num_id": "ALUTOT",
    "procedure_num_id": "TOTAL_TP03",
    "value": 1530.0,
    "unit_of_measure_id": "mg_per_kg"
  },
  ...
]
```

Values are in the **canonical unit** for each (property, procedure) pair
(see `unit_of_measure_id`).

`?profile_code=…` narrows the response to one profile. Anything else is the
full payload — for a large country this can be tens of thousands of rows;
the Hub should cache and paginate at its layer.

---

## Security boundary

This service is a **defense-in-depth example**: the application code is
already read-only (there's no write path), and the database role it connects
as is read-only too. An attacker would need to bypass both layers to do
anything beyond the three views.

| Layer                      | Mechanism                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **Application**            | Only three FastAPI route handlers, all `GET`, no INSERT/UPDATE/DELETE statements. |
| **DB role privileges**     | `sis_glosis` has `SELECT` on:                                                       |
|                            | • `api.vw_api_manifest`                                                             |
|                            | • `api.vw_api_profile`                                                              |
|                            | • `api.vw_api_observation`                                                          |
|                            | • `api.vw_glosis_federation_token` (filtered to federation rows only)               |
|                            | • `api.setting` (to read `GLOSIS_FEDERATION_ENABLED`)                              |
|                            | and `INSERT` on `api.audit` (for logging).                                          |
| **Token isolation**        | The federation token view filters `api.api_client` to rows with                     |
|                            | `description = 'glosis-federation'`. Even with full SELECT on this view,            |
|                            | `sis_glosis` cannot see other API keys (web-mapping, future external clients).      |
| **Setting gate**           | The admin can flip `GLOSIS_FEDERATION_ENABLED=false` at any time and the           |
|                            | three data endpoints immediately return 403 without touching the DB.               |
| **Token lifecycle**        | Singleton per node. **Disable & Delete token** in the admin panel removes the      |
|                            | row; audit entries referring to it get their `api_client_id` nulled                 |
|                            | (the append-only `api.audit` trigger allows that one mutation).                    |
| **Audit log**              | Every successful and failed call is logged via `INSERT INTO api.audit` with        |
|                            | `action ∈ {glosis_manifest_accessed, glosis_profiles_accessed,                     |
|                            | glosis_observations_accessed, glosis_token_invalid, glosis_token_inactive,          |
|                            | glosis_token_expired}` plus the caller IP (from `X-Forwarded-For` if set).         |

The data exposed is **not** considered secret — federated soil data is the
point of GloSIS. The security boundary is to prevent unauthorised changes
to the SIS, prevent secret leakage (other API keys, user password hashes,
infra settings), and give the SIS admin a verifiable "kill switch."

---

## Lifecycle

| Step                            | What happens                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| **1. SIS deploy**               | Container starts disabled (`GLOSIS_FEDERATION_ENABLED` unset/`false`). All federation requests return 403. |
| **2. Admin clicks Enable**      | Setting is set to `true`; a singleton federation token is generated (random URL-safe string). The Administration UI displays the token + the endpoint URLs to share. |
| **3. Hub requests data**        | Every request validated: setting on, token matches, token active, not expired. Audit row written. |
| **4. Admin clicks Disable**     | Setting flipped to `false`. Token row is kept so re-enabling reuses it. |
| **5. Admin clicks Disable & Delete token** | Setting flipped to `false`; `api.audit` rows referring to the token have `api_client_id` set to NULL (the only audit UPDATE the append-only trigger permits); token row deleted. Next Enable mints a fresh key. |

The Hub admin must be sent two things by the SIS admin:
- the federation token (visible inline in the Endpoints box on the
  Administration panel — currently kept in plaintext at rest so it can be
  re-copied),
- the endpoint URLs (also shown on the same panel).

---

## Configuration

`sis-api-glosis` reads its DB credentials from env vars set by
`docker-compose.yml`:

| Env var                     | Set from `.env` key            | Notes                                  |
| --------------------------- | ------------------------------ | -------------------------------------- |
| `POSTGRES_HOST`             | `POSTGRES_HOST`                |                                        |
| `POSTGRES_PORT`             | `POSTGRES_PORT`                |                                        |
| `POSTGRES_DB`               | `POSTGRES_DB`                  |                                        |
| `POSTGRES_USER`             | `POSTGRES_GLOSIS_USER`         | **Not `POSTGRES_USER`** — the read-only role |
| `POSTGRES_PASSWORD`         | `POSTGRES_GLOSIS_PASSWORD`     | Per-deployment, rotated by `deploy.sh` on first run |
| `SECRET_KEY`                | `SECRET_KEY`                   | Unused by this service today; kept for future symmetric crypto |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `ACCESS_TOKEN_EXPIRE_MINUTES`| Unused (no JWT issuance here)         |
| `ENABLE_DOCS`               | (not in `.env`; set per deploy) | If `true`, exposes `/docs`, `/redoc`, `/openapi.json` |

The container has no write capability against any table other than
`api.audit` even if these env vars are tampered with — the privilege grant
on the Postgres role is the real boundary.

---

## Error responses

```json
{ "detail": "human-readable message" }
```

| Status | Cause                                                                          |
| ------ | ------------------------------------------------------------------------------ |
| 200    | OK                                                                              |
| 401    | Missing / invalid / inactive / expired `X-API-Key` header                       |
| 403    | Federation disabled on this node (`GLOSIS_FEDERATION_ENABLED ≠ 'true'`)        |
| 500    | Server error — message is generic, no DB error text surfaced                    |

`/health` never raises; on a DB outage it returns `200 {status: unhealthy}`.

---

## Example session

Assume the SIS is at `https://sis.example.gov.bt`, the Hub admin has the
federation token in `$TOKEN`, and federation has been enabled.

```bash
# 1. Manifest — what does this node hold?
curl -s -H "X-API-Key: $TOKEN" \
  https://sis.example.gov.bt/glosis/manifest | jq '.[0:3]'

# 2. All published profiles
curl -s -H "X-API-Key: $TOKEN" \
  https://sis.example.gov.bt/glosis/profile | jq 'length'

# 3. Observations for a specific profile
curl -s -H "X-API-Key: $TOKEN" \
  "https://sis.example.gov.bt/glosis/observation?profile_code=BT-OBS-0014" | jq
```

Wrong / disabled cases:

```bash
# No token → 401
curl -i https://sis.example.gov.bt/glosis/manifest

# Wrong token → 401
curl -i -H "X-API-Key: nope" https://sis.example.gov.bt/glosis/manifest

# Token correct, but admin clicked Disable → 403
curl -i -H "X-API-Key: $TOKEN" https://sis.example.gov.bt/glosis/manifest
# { "detail": "GloSIS federation is disabled on this node." }
```

---

**Document version**: 1.0 — matches current code.
