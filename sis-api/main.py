"""
SIS Admin API — JWT authentication (for humans)
Manages users, API clients, layers, and settings.
"""

from fastapi import FastAPI, Depends, HTTPException, status, Request, UploadFile, File, Form, BackgroundTasks, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import List, Optional
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs
import logging
import os
import re
import csv
import io
import json
import zipfile
import glob
import time
import secrets
import psycopg2
import psycopg2.extras
from psycopg2 import sql as pgsql
from psycopg2.extras import RealDictCursor
import requests as http_requests

from shared import (
    DB_CONFIG, ACCESS_TOKEN_EXPIRE_MINUTES,
    get_db, log_audit, get_client_ip,
    hash_password, verify_password, create_access_token,
    generate_api_key,
    UserLogin, Token, User, UserCreate, UserSelfUpdate, Layer, LayerCreate, PublishUpdate,
    Setting, SettingCreate, SettingUpdate, APIClient, APIClientCreate,
    get_current_user, get_current_admin_user, verify_api_key,
)

# /docs, /redoc, /openapi.json reveal the full API surface. Off by default;
# set ENABLE_DOCS=true in the env to re-enable for local development.
log = logging.getLogger("sis-api")

_docs_on = os.getenv("ENABLE_DOCS", "false").strip().lower() == "true"
app = FastAPI(
    title="SIS Admin API",
    description="JWT-protected API for managing users, API clients, layers, and settings.",
    version="1.0.0",
    docs_url="/docs" if _docs_on else None,
    redoc_url="/redoc" if _docs_on else None,
    openapi_url="/openapi.json" if _docs_on else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost",
        "http://localhost:80",
        "http://localhost:8001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _recover_orphaned_dst_runs():
    """A DST run executes as an in-process background task. If the worker is
    killed mid-run (e.g. OOM), the run-state row is stranded at 'queued' /
    'running' forever and the UI polls it indefinitely. On every startup, fail
    any such orphan so the user gets a clear result and can simply re-run."""
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE api.dst_recipe
                       SET run_status      = 'failed',
                           run_error       = 'interrupted — the server restarted mid-run '
                                             '(often out of memory); please run it again',
                           run_finished_at = now()
                     WHERE run_status IN ('queued', 'running')
                """)
                n = cur.rowcount
            conn.commit()
        if n:
            log.warning("startup: marked %d orphaned DST run(s) as failed", n)
    except Exception:
        log.exception("startup: failed to recover orphaned DST runs")


# Every generated .map declares TEMPLATE "getfeatureinfo.tmpl" (relative to the
# mapfile dir), but the volume directory is gitignored, so fresh installs have
# no template and raster GetFeatureInfo fails with "Unable to access file".
# The SPA needs it for the click popup and the dynamic-legend hover probe.
GFI_TEMPLATE = """<!-- MapServer Template -->
Value: [value_list]
Coords: [x], [y]
"""


@app.on_event("startup")
def _ensure_getfeatureinfo_template():
    path = "/srv/rasters/getfeatureinfo.tmpl"
    try:
        if not os.path.exists(path):
            with open(path, "w") as f:
                f.write(GFI_TEMPLATE)
            log.info("startup: wrote %s", path)
    except Exception:
        log.exception("startup: could not ensure %s", path)


@app.on_event("startup")
def _ensure_raster_query_tolerance():
    """Patch pre-migration-011 .map files in place: without a LAYER TOLERANCE
    the raster GetFeatureInfo query rectangle shrinks with the view scale and
    returns nothing once zoomed past the raster's native resolution.

    In-place insertion (not a regen from soil_data.layer.map) deliberately —
    DST layers' on-disk DATA line points at a versioned hardlink the DB text
    knows nothing about, and must survive.
    """
    import glob as _glob
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(r"""
                    SELECT layer_id,
                           COALESCE(CEIL(GREATEST(
                             CASE distance_uom
                               WHEN 'deg' THEN d * 111320
                               WHEN 'km'  THEN d * 1000
                               ELSE            d
                             END, 100)), 1000)::int AS tol_m
                    FROM (
                      SELECT layer_id, distance_uom,
                             -- layer.distance is TEXT; cast defensively.
                             CASE WHEN distance ~ '^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?$'
                                  THEN distance::float END AS d
                      FROM soil_data.layer WHERE map IS NOT NULL
                    ) t
                """)
                tol = {r[0]: r[1] for r in cur.fetchall()}
        patched = 0
        exported = 0
        for path in _glob.glob("/srv/rasters/*.map"):
            layer_id = os.path.splitext(os.path.basename(path))[0]
            if layer_id not in tol:
                continue
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            if "TOLERANCE" in content:
                continue
            # A pre-migration file: prefer a full re-export from the DB text
            # (brings tolerance AND any regenerated styles, e.g. the
            # class-driven categorical rendering; DST-versioned DATA lines
            # survive via the helper). Fall back to inserting the two
            # tolerance lines in place.
            with get_db() as conn2:
                with conn2.cursor() as cur2:
                    if _export_mapfile_from_db(cur2, layer_id):
                        exported += 1
                        continue
            if "      TYPE RASTER\n" not in content:
                continue
            content = content.replace(
                "      TYPE RASTER\n",
                "      TYPE RASTER\n      TOLERANCE %d\n      TOLERANCEUNITS METERS\n" % tol[layer_id],
                1)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            patched += 1
        if patched or exported:
            log.info("startup: mapfiles synced — %d re-exported from DB, %d patched in place",
                     exported, patched)
    except Exception:
        log.exception("startup: could not patch .map query tolerances")


# ==================== Authentication ====================

LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_MINUTES = 15

@app.post("/api/auth/login", response_model=Token)
async def login(user_credentials: UserLogin, request: Request):
    """Login with email/password — returns a JWT token.

    After LOGIN_MAX_ATTEMPTS consecutive failures the account is locked for
    LOGIN_LOCKOUT_MINUTES. A successful login resets the counter.
    """
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT user_id, password_hash, is_active, "
                "       failed_login_attempts, locked_until "
                "FROM api.user WHERE user_id = %s",
                (user_credentials.user_id,)
            )
            user = cur.fetchone()

            # Generic auth-error response — same message for unknown user / bad
            # password / locked account so we don't leak which one it was.
            generic_unauthorized = HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect username or password"
            )

            if not user:
                log_audit(user_credentials.user_id, None, "login_failed",
                          {"reason": "unknown_user"}, get_client_ip(request))
                raise generic_unauthorized

            # Lockout window still active?
            if user.get("locked_until") and user["locked_until"] > datetime.now(user["locked_until"].tzinfo):
                log_audit(user["user_id"], None, "login_locked",
                          {"locked_until": user["locked_until"].isoformat()},
                          get_client_ip(request))
                raise generic_unauthorized

            if not verify_password(user_credentials.password, user['password_hash']):
                # Increment failed counter; lock if threshold reached
                attempts = (user.get("failed_login_attempts") or 0) + 1
                if attempts >= LOGIN_MAX_ATTEMPTS:
                    cur.execute(
                        "UPDATE api.user SET failed_login_attempts = %s, "
                        "       locked_until = now() + (%s || ' minutes')::interval "
                        "WHERE user_id = %s",
                        (attempts, LOGIN_LOCKOUT_MINUTES, user["user_id"])
                    )
                    log_audit(user["user_id"], None, "login_account_locked",
                              {"attempts": attempts}, get_client_ip(request))
                else:
                    cur.execute(
                        "UPDATE api.user SET failed_login_attempts = %s "
                        "WHERE user_id = %s",
                        (attempts, user["user_id"])
                    )
                    log_audit(user["user_id"], None, "login_failed",
                              {"attempts": attempts}, get_client_ip(request))
                raise generic_unauthorized

            if not user['is_active']:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="User account is inactive"
                )

            # Successful login — reset lockout state
            cur.execute(
                "UPDATE api.user SET last_login = %s, "
                "       failed_login_attempts = 0, locked_until = NULL "
                "WHERE user_id = %s",
                (datetime.now(), user['user_id'])
            )
            log_audit(user['user_id'], None, "login_success", None, get_client_ip(request))
            access_token = create_access_token(
                data={"sub": user['user_id']},
                expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
            )
            return {"access_token": access_token, "token_type": "bearer"}

@app.patch("/api/users/me")
async def update_own_account(
    payload: UserSelfUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update the logged-in user's own email and/or password. Requires current password."""
    if payload.new_user_id is None and payload.new_password is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Nothing to update")

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT password_hash FROM api.user WHERE user_id = %s",
                (current_user['user_id'],))
            row = cur.fetchone()
            if not row or not verify_password(payload.current_password, row['password_hash']):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                    detail="Current password is incorrect")

            new_user_id = payload.new_user_id or current_user['user_id']
            renaming = bool(payload.new_user_id
                            and payload.new_user_id != current_user['user_id'])

            # The default admin account's guardrails are keyed to its name —
            # renaming it would silently shed its protections, and an instance
            # could then lose its last untouchable administrator.
            if renaming and current_user['user_id'] == DEFAULT_ADMIN_ID:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"The default '{DEFAULT_ADMIN_ID}' account cannot be renamed.")
            if renaming and payload.new_user_id == DEFAULT_ADMIN_ID:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail=f"'{DEFAULT_ADMIN_ID}' is reserved for the default administrator account.")

            if renaming:
                cur.execute("SELECT 1 FROM api.user WHERE user_id = %s",
                            (payload.new_user_id,))
                if cur.fetchone():
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                        detail="User name already in use")
                # The rename cascades user_id into api.audit (FK ON UPDATE
                # CASCADE), which the append-only trigger blocks ("user_id can
                # only be cleared"). Retagging this user's audit rows to their
                # new id keeps attribution truthful, so pause the update guard
                # for exactly this transaction — the ACCESS EXCLUSIVE lock the
                # ALTER takes on api.audit means nothing else can write audit
                # rows while the guard is down.
                cur.execute("ALTER TABLE api.audit DISABLE TRIGGER audit_no_update")

            # Bump password_changed_at on every password change so old JWTs
            # for this user are rejected by get_current_user (see shared.py).
            if payload.new_password and payload.new_user_id:
                cur.execute(
                    "UPDATE api.user SET user_id = %s, password_hash = %s, "
                    "password_changed_at = now() WHERE user_id = %s",
                    (payload.new_user_id, hash_password(payload.new_password), current_user['user_id']))
            elif payload.new_password:
                cur.execute(
                    "UPDATE api.user SET password_hash = %s, password_changed_at = now() "
                    "WHERE user_id = %s",
                    (hash_password(payload.new_password), current_user['user_id']))
            elif payload.new_user_id:
                cur.execute(
                    "UPDATE api.user SET user_id = %s WHERE user_id = %s",
                    (payload.new_user_id, current_user['user_id']))

            if renaming:
                cur.execute("ALTER TABLE api.audit ENABLE TRIGGER audit_no_update")

    # OUTSIDE the transaction: the rename holds an ACCESS EXCLUSIVE lock on
    # api.audit until commit, and log_audit writes on its OWN connection — an
    # audit insert before this point deadlocks against our own lock (each side
    # waiting on the other, invisible to Postgres' deadlock detector). The
    # audit row also carries the NEW id: after the rename the old id no longer
    # exists and would fail the user FK.
    log_audit(new_user_id, None, "user_self_updated",
             {"renamed_from": current_user['user_id'] if renaming else None,
              "new_user_id": payload.new_user_id,
              "password_changed": payload.new_password is not None}, None)

    result = {"message": "Account updated successfully"}
    if renaming:
        new_token = create_access_token(
            data={"sub": new_user_id},
            expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
        result["access_token"] = new_token
        result["token_type"] = "bearer"
    return result

@app.get("/api/auth/verify")
async def verify_token(current_user: dict = Depends(get_current_user)):
    """Verify that a JWT token is valid."""
    return {
        "user_id": current_user['user_id'],
        "is_admin": current_user['is_admin'],
        "message": "Token is valid"
    }

# ==================== User Management (Admin Only) ====================

@app.post("/api/users", status_code=status.HTTP_201_CREATED)
async def create_user(
    user: UserCreate,
    current_user: dict = Depends(get_current_admin_user)
):
    """Create a new user (admin only)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    "INSERT INTO api.user (user_id, password_hash, is_admin) VALUES (%s, %s, %s)",
                    (user.user_id, hash_password(user.password), user.is_admin)
                )
                log_audit(current_user['user_id'], None, "user_created", {"new_user": user.user_id}, None)
                return {"message": "User created successfully", "user_id": user.user_id}
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")

# ==================== Software version / update awareness ====================
# Read-only: report the running build's git SHA (stamped at deploy via the
# GIT_SHA env) and compare it against the repo's branch on GitHub. This NEVER
# performs an update — applying one is the deliberate host command ./update.sh.
# The only outbound call is an unauthenticated, read-only GitHub compare.

UPDATE_REPO = os.getenv("UPDATE_REPO", "un-fao/OpenNSIS")
UPDATE_BRANCH = os.getenv("UPDATE_BRANCH", "main")


@app.get("/api/admin/version")
async def get_software_version(current_user: dict = Depends(get_current_admin_user)):
    """The running build's version stamp (no network)."""
    return {"sha": os.getenv("GIT_SHA", "unknown"),
            "repo": UPDATE_REPO, "branch": UPDATE_BRANCH}


@app.get("/api/admin/update-check")
async def check_for_updates(current_user: dict = Depends(get_current_admin_user)):
    """Compare the running build against the repo branch on GitHub (read-only).
    Returns how many newer commits exist and the command to apply them; it does
    not (and cannot) update anything itself."""
    import urllib.request, urllib.error, json
    sha = (os.getenv("GIT_SHA", "unknown") or "unknown").strip()
    out = {"current": sha, "repo": UPDATE_REPO, "branch": UPDATE_BRANCH,
           "command": "./update.sh", "available": None}
    if sha in ("", "unknown"):
        out["error"] = ("This build carries no version stamp (GIT_SHA). Updates can "
                        "still be applied on the host with ./update.sh.")
        return out
    url = f"https://api.github.com/repos/{UPDATE_REPO}/compare/{sha}...{UPDATE_BRANCH}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "sis-update-check",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        out["error"] = ("Version not found on the remote (is this commit pushed?)."
                        if e.code == 404 else f"GitHub returned HTTP {e.code}.")
        return out
    except Exception as e:
        out["error"] = f"Could not reach GitHub: {e}"
        return out
    # base=local, head=branch → ahead_by = commits the branch has that we don't.
    new_commits = int(data.get("ahead_by") or 0)
    commits = []
    for c in (data.get("commits") or [])[-25:]:
        commits.append({
            "sha": (c.get("sha") or "")[:7],
            "message": (c.get("commit", {}).get("message") or "").splitlines()[0],
            "date": (c.get("commit", {}).get("committer", {}) or {}).get("date"),
        })
    out.update({
        "available": new_commits > 0,
        "new_commits": new_commits,
        "status": data.get("status"),              # identical|ahead|behind|diverged
        "latest": (commits[-1]["sha"] if commits else sha),
    })
    out["commits"] = list(reversed(commits))       # newest first for display
    return out


@app.get("/api/users", response_model=List[User])
async def list_users(current_user: dict = Depends(get_current_admin_user)):
    """List all users (admin only)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT user_id, is_active, is_admin, created_at, last_login FROM api.user ORDER BY created_at DESC"
            )
            return [dict(u) for u in cur.fetchall()]

# The account created at deployment. It can manage every other account, and
# no other account can modify or remove it — so no sequence of admin mistakes
# can leave an instance without a working administrator.
DEFAULT_ADMIN_ID = "admin"


def _active_admins_besides(cur, user_id: str) -> int:
    cur.execute("SELECT count(*) FROM api.\"user\" "
                "WHERE is_admin AND is_active AND user_id <> %s", (user_id,))
    return cur.fetchone()[0]


@app.patch("/api/users/{user_id}/active")
async def toggle_user_active(user_id: str, is_active: bool, current_user: dict = Depends(get_current_admin_user)):
    """Activate or deactivate a user (admin only). Guardrails: never yourself
    (ask another administrator), never the default admin account (unless you
    are it — and then the self rule applies), never the last active admin."""
    if user_id == current_user['user_id']:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="You cannot change your own active status — ask another administrator.")
    if user_id == DEFAULT_ADMIN_ID:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"The default '{DEFAULT_ADMIN_ID}' account cannot be deactivated.")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT is_admin FROM api.\"user\" WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            if not is_active and row[0] and _active_admins_besides(cur, user_id) == 0:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail="Cannot deactivate the last active administrator.")
            cur.execute("UPDATE api.\"user\" SET is_active = %s WHERE user_id = %s", (is_active, user_id))
            log_audit(current_user['user_id'], None, "user_active_toggled",
                     {"user": user_id, "is_active": is_active}, None)
            return {"message": f"User {'activated' if is_active else 'deactivated'} successfully"}


@app.patch("/api/users/{user_id}/admin")
async def toggle_user_admin(user_id: str, is_admin: bool, current_user: dict = Depends(get_current_admin_user)):
    """Grant or revoke administrator rights (admin only). Guardrails: never
    your own rights, never the default admin account, never the last one."""
    if user_id == current_user['user_id']:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="You cannot change your own administrator rights — ask another administrator.")
    if user_id == DEFAULT_ADMIN_ID:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"The default '{DEFAULT_ADMIN_ID}' account's administrator rights cannot be changed.")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT is_admin FROM api.\"user\" WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            if row[0] and not is_admin and _active_admins_besides(cur, user_id) == 0:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail="Cannot revoke the last active administrator.")
            cur.execute("UPDATE api.\"user\" SET is_admin = %s WHERE user_id = %s", (is_admin, user_id))
            log_audit(current_user['user_id'], None, "user_admin_toggled",
                     {"user": user_id, "is_admin": is_admin}, None)
            return {"message": f"Administrator rights {'granted' if is_admin else 'revoked'} successfully"}

@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str, current_user: dict = Depends(get_current_admin_user)):
    """Delete a user (admin only)."""
    if user_id == current_user['user_id']:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account")
    if user_id == DEFAULT_ADMIN_ID:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"The default '{DEFAULT_ADMIN_ID}' account cannot be deleted.")
    with get_db() as conn:
        with conn.cursor() as cur:
            # The audit FK has no ON DELETE action, so a user with audited
            # actions (anyone who ever logged in) could not be deleted at all.
            # Clearing user_id is the one audit mutation the append-only
            # trigger permits — entries stay, attribution is anonymised.
            cur.execute("UPDATE api.audit SET user_id = NULL WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM api.user WHERE user_id = %s", (user_id,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            log_audit(current_user['user_id'], None, "user_deleted", {"deleted_user": user_id}, None)
            return {"message": "User deleted successfully"}

# ==================== API Client Management (Admin Only) ====================

@app.post("/api/clients", status_code=status.HTTP_201_CREATED)
async def create_api_client(
    client: APIClientCreate,
    current_user: dict = Depends(get_current_admin_user)
):
    """Create a new API client and return its key once (admin only)."""
    api_key = generate_api_key()
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    """
                    INSERT INTO api.api_client (api_client_id, api_key, description, expires_at)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (client.api_client_id, api_key, client.description, client.expires_at)
                )
                log_audit(current_user['user_id'], None, "api_client_created",
                         {"client_id": client.api_client_id}, None)
                return {
                    "message": "API client created successfully",
                    "api_client_id": client.api_client_id,
                    "api_key": api_key,
                    "warning": "Save this API key now. You won't be able to see it again!"
                }
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="API client already exists")

@app.get("/api/clients", response_model=List[APIClient])
async def list_api_clients(current_user: dict = Depends(get_current_admin_user)):
    """List all API clients without their keys (admin only)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT api_client_id, is_active, created_at, expires_at, description, last_login
                FROM api.api_client ORDER BY created_at DESC
                """
            )
            return [dict(c) for c in cur.fetchall()]

@app.patch("/api/clients/{api_client_id}/status")
async def update_api_client_status(
    api_client_id: str,
    is_active: bool,
    current_user: dict = Depends(get_current_admin_user)
):
    """Activate or deactivate an API client (admin only)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE api.api_client SET is_active = %s WHERE api_client_id = %s",
                (is_active, api_client_id)
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API client not found")
            log_audit(current_user['user_id'], None, "api_client_status_changed",
                     {"client_id": api_client_id, "is_active": is_active}, None)
            return {"message": f"API client {'activated' if is_active else 'deactivated'} successfully"}

@app.delete("/api/clients/{api_client_id}")
async def delete_api_client(
    api_client_id: str,
    current_user: dict = Depends(get_current_admin_user)
):
    """Delete an API client (admin only)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM api.api_client WHERE api_client_id = %s", (api_client_id,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API client not found")
            log_audit(current_user['user_id'], None, "api_client_deleted",
                     {"deleted_client": api_client_id}, None)
            return {"message": "API client deleted successfully"}

# ==================== Layer Management ====================
# Legacy CRUD endpoints over api.layer (POST /api/layer, PUT /api/layer/{id},
# POST /api/sync/layers) were removed when soil_data.layer became the source
# of truth. The active layer endpoints (PATCH .../custom|publish|default,
# DELETE /api/layer/{id}, GET /api/layer/all, GET /api/layer) all read/write
# soil_data.layer + soil_data.mapset.

@app.patch("/api/layer/{layer_id}/custom")
async def update_layer_custom(
    layer_id: str,
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Inline-edit fields shown in the admin Rasters table:
      * project_name → soil_data.mapset.costum_group (per mapset)
      * property_name → soil_data.layer.costum_name  (per layer)
    Both are optional; only the keys present in the payload are written.
    Empty strings are normalised to NULL.
    """
    def _clean(v):
        if v is None: return None
        v = str(v).strip()
        return v if v else None

    has_proj = "project_name" in payload
    has_prop = "property_name" in payload
    has_opac = "default_opacity" in payload
    has_order = "display_order" in payload
    order = None
    if has_order:
        raw = payload.get("display_order")
        if raw is None or str(raw).strip() == "":
            order = None
        else:
            try:
                order = int(float(raw))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="display_order must be an integer")
    opacity = None
    if has_opac:
        raw = payload.get("default_opacity")
        if raw is None or str(raw).strip() == "":
            opacity = None
        else:
            try:
                opacity = float(raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="default_opacity must be a number")
            if not 0 <= opacity <= 1:
                raise HTTPException(status_code=400, detail="default_opacity must be between 0 and 1")
    if not (has_proj or has_prop or has_opac or has_order):
        raise HTTPException(status_code=400, detail="No editable field supplied")

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT mapset_id FROM soil_data.layer WHERE layer_id = %s", (layer_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Layer not found")
            mapset_id = row[0]

            if has_prop:
                cur.execute(
                    "UPDATE soil_data.layer SET costum_name = %s WHERE layer_id = %s",
                    (_clean(payload.get("property_name")), layer_id),
                )
            if has_opac:
                cur.execute(
                    "UPDATE soil_data.layer SET default_opacity = %s WHERE layer_id = %s",
                    (opacity, layer_id),
                )
            if has_order:
                cur.execute(
                    "UPDATE soil_data.layer SET display_order = %s WHERE layer_id = %s",
                    (order, layer_id),
                )
            if has_proj:
                cur.execute(
                    "UPDATE soil_data.mapset SET costum_group = %s WHERE mapset_id = %s",
                    (_clean(payload.get("project_name")), mapset_id),
                )
    log_audit(current_user["user_id"], None, "layer_custom_updated",
              {"layer_id": layer_id, **{k: payload[k] for k in ("project_name", "property_name", "default_opacity", "display_order") if k in payload}},
              None)
    return {"layer_id": layer_id, "ok": True}


@app.patch("/api/layer/{layer_id}/publish")
async def update_layer_publish(
    layer_id: str,
    publish_data: PublishUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Publish or unpublish a layer. Unpublishing clears is_default.
    Writes to soil_data.layer (post-merge source of truth)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            if publish_data.publish:
                cur.execute(
                    "UPDATE soil_data.layer SET is_published = TRUE WHERE layer_id = %s",
                    (layer_id,))
            else:
                cur.execute(
                    "UPDATE soil_data.layer SET is_published = FALSE, is_default = FALSE WHERE layer_id = %s",
                    (layer_id,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Layer not found")
            log_audit(current_user['user_id'], None, "layer_publish_changed",
                     {"layer_id": layer_id, "publish": publish_data.publish}, None)
            return {"message": "Layer publish status updated successfully"}

@app.patch("/api/layer/{layer_id}/default")
async def set_default_layer(
    layer_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Mark a layer as the default (clears previous default). Layer must be published.
    Writes to soil_data.layer."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT is_published FROM soil_data.layer WHERE layer_id = %s", (layer_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Layer not found")
            if not row[0]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Only a published layer can be set as default")
            cur.execute("UPDATE soil_data.layer SET is_default = FALSE WHERE is_default = TRUE")
            cur.execute("UPDATE soil_data.layer SET is_default = TRUE WHERE layer_id = %s", (layer_id,))
            log_audit(current_user['user_id'], None, "layer_default_set",
                     {"layer_id": layer_id}, None)
            return {"message": "Default layer updated successfully"}

@app.post("/api/default-layer/clear")
async def clear_default_layer(current_user: dict = Depends(get_current_user)):
    """Clear the default layer (no layer will be default).
    Writes to soil_data.layer."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE soil_data.layer SET is_default = FALSE WHERE is_default = TRUE")
            log_audit(current_user['user_id'], None, "layer_default_cleared", None, None)
            return {"message": "Default layer cleared"}

def _delete_layer_full(layer_id: str, user_id: str, *, missing_ok: bool = False) -> dict:
    """End-to-end raster cleanup used by both DELETE /api/layer/{id} and the
    DST recipe DELETE path. Wipes, in order:
      1. soil_data.layer row (cascades to class / map / sld via FKs)
      2. soil_data.mapset row if no other layers reference it
      3. pyCSW record (CSW-T Delete by file_identifier)
      4. on-disk artifacts: <layer_id>.tif/.map in /srv/rasters
         and <layer_id>.xml in /srv/pycsw-records

    Filesystem + pyCSW failures are returned as warnings, not raised.
    When `missing_ok=True`, returns a 'not_found' result instead of raising
    when the layer doesn't exist.
    """
    from raster_registry.pycsw_load import delete_record as pycsw_delete_record

    warnings: list = []
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT layer_id FROM soil_data.layer WHERE layer_id = %s", (layer_id,))
            if not cur.fetchone():
                if missing_ok:
                    return {"message": "Layer not found", "layer_id": layer_id,
                            "found": False, "warnings": [],
                            "removed_files": [], "mapset_deleted": False,
                            "pycsw_deleted": False}
                raise HTTPException(status_code=404, detail="Layer not found")

            cur.execute("""
                SELECT l.mapset_id, l.file_path, l.file_extension, m.file_identifier
                FROM soil_data.layer l
                LEFT JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                WHERE l.layer_id = %s
            """, (layer_id,))
            sm = cur.fetchone() or {}
            mapset_id = sm.get("mapset_id")
            file_identifier = sm.get("file_identifier")
            file_path = sm.get("file_path")
            file_ext = (sm.get("file_extension") or "tif").lstrip(".")

            cur.execute("DELETE FROM soil_data.layer WHERE layer_id = %s", (layer_id,))

            mapset_deleted = False
            if mapset_id:
                cur.execute("SELECT 1 FROM soil_data.layer WHERE mapset_id = %s LIMIT 1",
                            (mapset_id,))
                if not cur.fetchone():
                    cur.execute("DELETE FROM soil_data.mapset WHERE mapset_id = %s",
                                (mapset_id,))
                    mapset_deleted = (cur.rowcount > 0)

    pycsw_deleted = False
    if mapset_deleted and file_identifier:
        result = pycsw_delete_record(file_identifier)
        pycsw_deleted = bool(result.get("transaction_ok"))
        if not pycsw_deleted and result.get("transaction_error"):
            warnings.append(f"pyCSW delete failed: {result['transaction_error']}")

    removed_files = []
    candidates = []
    if file_path:
        candidates.append(os.path.join(file_path, f"{layer_id}.{file_ext}"))
    candidates.append(os.path.join("/srv/rasters", f"{layer_id}.{file_ext}"))
    candidates.append(os.path.join("/srv/rasters", f"{layer_id}.{file_ext}.aux.xml"))
    candidates.append(os.path.join("/srv/rasters", f"{layer_id}.map"))
    candidates.append(os.path.join("/srv/pycsw-records", f"{layer_id}.xml"))
    # DST versioned map-DATA hardlinks: <layer_id>.r<token>.<ext>
    import glob as _glob
    candidates.extend(_glob.glob(os.path.join("/srv/rasters", f"{layer_id}.r*.{file_ext}")))
    for p in candidates:
        try:
            if os.path.isfile(p):
                os.remove(p)
                removed_files.append(p)
        except OSError as e:
            warnings.append(f"unlink {p}: {e}")

    log_audit(user_id, None, "layer_deleted",
              {"layer_id": layer_id, "mapset_deleted": mapset_deleted,
               "pycsw_deleted": pycsw_deleted, "removed_files": removed_files,
               "warnings": warnings}, None)

    return {
        "message": "Layer deleted",
        "layer_id": layer_id,
        "found": True,
        "mapset_deleted": mapset_deleted,
        "pycsw_deleted": pycsw_deleted,
        "removed_files": removed_files,
        "warnings": warnings,
    }


@app.delete("/api/layer/{layer_id}")
async def delete_layer(layer_id: str, current_user: dict = Depends(get_current_admin_user)):
    """Admin endpoint — defers to the shared _delete_layer_full helper."""
    return _delete_layer_full(layer_id, current_user["user_id"])

MAPFILE_DST_DATA_RE = re.compile(r'^(\s*DATA ".*\.r[0-9a-f]+\.tif")\s*$', re.M)

def _export_mapfile_from_db(cur, layer_id: str) -> bool:
    """Dump soil_data.layer.map to /srv/rasters/<id>.map, preserving a
    DST-versioned DATA line already present on disk (the DB text only knows
    the canonical filename; see _dst_version_map_data)."""
    cur.execute("SELECT map FROM soil_data.layer WHERE layer_id = %s", (layer_id,))
    row = cur.fetchone()
    text = (row or {}).get("map") if isinstance(row, dict) else (row[0] if row else None)
    if not text:
        return False
    path = os.path.join("/srv/rasters", f"{layer_id}.map")
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                m = MAPFILE_DST_DATA_RE.search(f.read())
            if m:
                text = re.sub(r'^\s*DATA ".*"\s*$', m.group(1), text, count=1, flags=re.M)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return True
    except Exception:
        log.exception("mapfile export failed for %s", layer_id)
        return False


@app.put("/api/mapped-property/{property_id}/colours")
async def update_property_colours(
    property_id: str,
    payload: dict,
    current_user: dict = Depends(get_current_admin_user),
):
    """Change a mapped property's legend colours (start/end of the ramp and
    the number of intervals). Applies to every raster of this property on the
    instance: regenerates soil_data.class, the SLD and the .map text via the
    DB triggers, then re-exports the on-disk mapfiles."""
    start = (payload.get("start_color") or "").strip()
    end = (payload.get("end_color") or "").strip()
    try:
        n = int(payload.get("num_intervals") or 0)
    except (TypeError, ValueError):
        n = 0
    hexre = re.compile(r"^#[0-9a-fA-F]{6}$")
    if not hexre.match(start) or not hexre.match(end):
        raise HTTPException(status_code=400, detail="Colours must be #rrggbb")
    if not 2 <= n <= 20:
        raise HTTPException(status_code=400, detail="num_intervals must be 2-20")

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                UPDATE soil_data.mapped_property
                   SET start_color = %s, end_color = %s, num_intervals = %s
                 WHERE mapped_property_id = %s
            """, (start, end, n, property_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Mapped property not found")
            # Touch every layer of the property: fires class() (class rows +
            # SLD) and map() (stored .map text) per row.
            cur.execute("""
                UPDATE soil_data.layer l
                   SET stats_minimum = l.stats_minimum
                  FROM soil_data.mapset m
                 WHERE m.mapset_id = l.mapset_id
                   AND m.mapped_property_id = %s
                RETURNING l.layer_id
            """, (property_id,))
            layer_ids = [r["layer_id"] for r in cur.fetchall()]
            exported = sum(1 for lid in layer_ids if _export_mapfile_from_db(cur, lid))
        conn.commit()

    log_audit(current_user["user_id"], None, "property_colours_updated",
              {"mapped_property_id": property_id, "start": start, "end": end,
               "num_intervals": n, "layers": len(layer_ids)}, None)
    return {"mapped_property_id": property_id, "layers_updated": len(layer_ids),
            "mapfiles_exported": exported}


@app.put("/api/mapset/{mapset_id}/class-colours")
async def update_class_colours(
    mapset_id: str,
    payload: dict,
    current_user: dict = Depends(get_current_admin_user),
):
    """Edit a categorical raster's legend classes: colour, label and pixel
    value per class, plus adding and removing classes. Updates
    soil_data.class (re-rendering the SLD via its trigger), touches the
    mapset's layers so map() rebuilds the class-driven styles, and
    re-exports the on-disk mapfiles."""
    hexre = re.compile(r"^#[0-9a-fA-F]{6}$")

    def _num(x, what):
        try:
            return float(x)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{what} must be numeric")

    cleaned = []
    for c in (payload.get("classes") or []):
        v = _num(c.get("value"), "Class value")
        nv = c.get("new_value")
        nv = _num(nv, "New class value") if nv is not None else None
        col = (c.get("color") or "").strip()
        if not hexre.match(col):
            raise HTTPException(status_code=400, detail="Colours must be #rrggbb")
        label = c.get("label")
        if label is not None:
            label = str(label).strip()[:120] or None
        cleaned.append((v, nv, col, label))
    removals = [_num(rv, "Removal value") for rv in (payload.get("remove") or [])]
    reset_auto = bool(payload.get("reset_auto"))
    replace_all = bool(payload.get("replace_all"))
    custom = payload.get("custom")
    if not cleaned and not removals and not reset_auto:
        raise HTTPException(status_code=400, detail="No classes given")

    if reset_auto:
        # Back to the automatic ramp: clear the flag; touching the layers
        # below makes class() regenerate the uniform rows and map()/sld()
        # re-render from them.
        with get_db() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    UPDATE soil_data.mapset SET custom_classes = FALSE
                     WHERE mapset_id = %s
                """, (mapset_id,))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Mapset not found")
                cur.execute("""
                    UPDATE soil_data.layer SET stats_minimum = stats_minimum
                     WHERE mapset_id = %s
                    RETURNING layer_id
                """, (mapset_id,))
                layer_ids = [r["layer_id"] for r in cur.fetchall()]
                exported = sum(1 for lid in layer_ids if _export_mapfile_from_db(cur, lid))
            conn.commit()
        log_audit(current_user["user_id"], None, "class_breaks_reset",
                  {"mapset_id": mapset_id, "layers": len(layer_ids)}, None)
        return {"mapset_id": mapset_id, "reset": True,
                "layers_updated": len(layer_ids), "mapfiles_exported": exported}

    if replace_all:
        if len(cleaned) < 2 or len(cleaned) > 60:
            raise HTTPException(status_code=400,
                                detail="Custom breaks need 2-60 classes")
        vals = [v for v, nv, col, label in cleaned]
        if len(set(vals)) != len(vals):
            raise HTTPException(status_code=400, detail="Class values must be unique")

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if custom is not None:
                cur.execute("""
                    UPDATE soil_data.mapset SET custom_classes = %s
                     WHERE mapset_id = %s
                """, (bool(custom), mapset_id))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Mapset not found")
            if replace_all:
                cur.execute("DELETE FROM soil_data.class WHERE mapset_id = %s",
                            (mapset_id,))
            cur.execute("SELECT value FROM soil_data.class WHERE mapset_id = %s",
                        (mapset_id,))
            existing = {float(r["value"]) for r in cur.fetchall()}

            # Dry-run the final value set so renames/additions can never
            # collide (the DB PK would abort the whole transaction).
            final = existing - set(removals)
            for v, nv, col, label in cleaned:
                if v in existing:
                    if nv is not None and nv != v:
                        if nv in final:
                            raise HTTPException(status_code=400,
                                                detail=f"Value {nv} is already used")
                        final.discard(v)
                        final.add(nv)
                else:
                    target = v
                    if target in final:
                        raise HTTPException(status_code=400,
                                            detail=f"Value {target} is already used")
                    final.add(target)
            if not final:
                raise HTTPException(status_code=400,
                                    detail="At least one class must remain")

            removed = 0
            if removals:
                cur.execute("""
                    DELETE FROM soil_data.class
                     WHERE mapset_id = %s AND value = ANY(%s)
                """, (mapset_id, removals))
                removed = cur.rowcount

            updated = inserted = 0
            for v, nv, col, label in cleaned:
                if v in existing:
                    sets, args = ["color = %s"], [col]
                    if label is not None:
                        sets.append("label = %s"); args.append(label)
                    if nv is not None and nv != v:
                        sets.append("value = %s"); args.append(nv)
                    args += [mapset_id, v]
                    cur.execute(f"""
                        UPDATE soil_data.class SET {', '.join(sets)}
                         WHERE mapset_id = %s AND value = %s
                    """, args)
                    updated += cur.rowcount
                else:
                    lbl = label or str(int(v) if float(v).is_integer() else v)
                    cur.execute("""
                        INSERT INTO soil_data.class
                            (mapset_id, value, code, label, color, opacity, publish)
                        VALUES (%s, %s, %s, %s, %s, 1, TRUE)
                        ON CONFLICT (mapset_id, value) DO UPDATE
                            SET color = EXCLUDED.color, label = EXCLUDED.label
                    """, (mapset_id, v, lbl[:40], lbl, col))
                    inserted += 1

            if removed and not (updated or inserted):
                # The SLD trigger fires on INSERT/UPDATE only — touch a
                # surviving row so a removal-only save re-renders the SLD.
                cur.execute("""
                    UPDATE soil_data.class SET color = color
                     WHERE mapset_id = %s
                       AND value = (SELECT min(value) FROM soil_data.class
                                     WHERE mapset_id = %s)
                """, (mapset_id, mapset_id))
            if not (updated or inserted or removed):
                raise HTTPException(status_code=404, detail="No matching classes")

            cur.execute("""
                UPDATE soil_data.layer SET stats_minimum = stats_minimum
                 WHERE mapset_id = %s
                RETURNING layer_id
            """, (mapset_id,))
            layer_ids = [r["layer_id"] for r in cur.fetchall()]
            exported = sum(1 for lid in layer_ids if _export_mapfile_from_db(cur, lid))
        conn.commit()

    log_audit(current_user["user_id"], None, "class_colours_updated",
              {"mapset_id": mapset_id, "classes": updated, "added": inserted,
               "removed": removed, "layers": len(layer_ids)}, None)
    return {"mapset_id": mapset_id, "classes_updated": updated,
            "classes_added": inserted, "classes_removed": removed,
            "layers_updated": len(layer_ids), "mapfiles_exported": exported}


@app.get("/api/layer/all")
async def get_all_layers(current_user: dict = Depends(get_current_user)):
    """Raster layers for the admin Rasters tab.

    Sourced from soil_data.layer + mapset + project + mapped_property +
    property_num. Vector stubs (mapset.mapped_property_id IS NULL OR
    layer.file_path empty) are excluded. WMS URLs are computed per-row so
    the admin "Check WMS" button can probe them.
    """
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT
                  l.layer_id,
                  l.is_published       AS publish,
                  l.is_default,
                  l.file_orig_name,
                  m.country_id,
                  m.project_id,
                  m.mapset_id,
                  COALESCE(m.costum_group, m.project_id) AS project_name,
                  COALESCE(
                    l.costum_name,
                    NULLIF(CONCAT_WS(' ',
                      m.title, m.unit_of_measure_id,
                      l.dimension_depth, l.dimension_stats), '')
                  ) AS property_name,
                  m.mapped_property_id,
                  mp.start_color, mp.end_color,
                  COALESCE(mp.num_intervals, 10) AS num_intervals,
                  mp.property_type,
                  COALESCE(m.custom_classes, FALSE) AS custom_classes,
                  l.default_opacity,
                  l.display_order,
                  -- A short token that mutates whenever the engine writes
                  -- new pixels: stats_min/max + the embedded MapServer .map
                  -- text hash. Used as the WMS cache-buster.
                  md5(COALESCE(l.stats_minimum::text,'') ||
                      COALESCE(l.stats_maximum::text,'') ||
                      COALESCE(l.map,''))::text AS cache_token
                FROM soil_data.layer l
                LEFT JOIN soil_data.mapset       m  ON m.mapset_id          = l.mapset_id
                LEFT JOIN soil_data.mapped_property mp
                       ON mp.mapped_property_id = m.mapped_property_id
                WHERE m.spatial_representation_type_code = 'grid'
                ORDER BY l.display_order NULLS LAST, l.layer_id
            """)
            rows = cur.fetchall()

            # Class rows for categorical swatches / the per-class editor.
            classes_by_mapset = {}
            mapset_ids = [r["mapset_id"] for r in rows if r.get("mapset_id")]
            if mapset_ids:
                cur.execute("""
                    SELECT mapset_id, value, label, color
                    FROM soil_data.class
                    WHERE publish IS TRUE AND mapset_id = ANY(%s)
                    ORDER BY mapset_id, value
                """, (mapset_ids,))
                for c in cur.fetchall():
                    classes_by_mapset.setdefault(c["mapset_id"], []).append({
                        "value": float(c["value"]),
                        "label": c["label"],
                        "color": c["color"],
                    })
            for r in rows:
                r["legend_classes"] = classes_by_mapset.get(r.get("mapset_id")) or None

    map_dir = "/etc/mapserver"
    for r in rows:
        map_path = f"{map_dir}/{r['layer_id']}.map"
        token = _wms_cache_token(r["layer_id"], r.get("cache_token"))
        gm, gl, gf = _build_wms_urls(map_path, r["layer_id"], cache_token=token)
        r["get_map_url"] = gm
        r["get_legend_url"] = gl
        r["get_feature_info_url"] = gf
    return rows

# ==================== Settings Management ====================

@app.post("/api/setting", status_code=status.HTTP_201_CREATED)
async def create_setting(setting: SettingCreate, current_user: dict = Depends(get_current_admin_user)):
    """Create a new setting."""
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    "INSERT INTO api.setting (key, value) VALUES (%s, %s)",
                    (setting.key, setting.value)
                )
                log_audit(current_user['user_id'], None, "setting_created", {"key": setting.key}, None)
                return {"message": "Setting created successfully", "key": setting.key}
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Setting already exists")

@app.put("/api/setting/{key}")
async def update_setting(
    key: str,
    setting_update: SettingUpdate,
    current_user: dict = Depends(get_current_admin_user)
):
    """Update a setting value."""
    with get_db() as conn:
        with conn.cursor() as cur:
            # COUNTRY_CODE anchors project ownership (soil_data.project FK) and
            # the ETL country-bounds check — an invalid value breaks project
            # creation with confusing errors, so refuse it at the door.
            if key == "COUNTRY_CODE":
                cc = (setting_update.value or "").strip().upper()
                cur.execute("SELECT en FROM soil_data.country WHERE country_id = %s", (cc,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=400, detail=(
                        f"'{setting_update.value}' is not a known ISO 3166-1 "
                        f"alpha-2 country code (for example 'ID' for Indonesia, "
                        f"not 'IDN'). The value must match soil_data.country."))
                setting_update.value = cc
            cur.execute("UPDATE api.setting SET value = %s WHERE key = %s", (setting_update.value, key))
            if cur.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Setting not found")
            log_audit(current_user['user_id'], None, "setting_updated", {"key": key}, None)
            return {"message": "Setting updated successfully"}

@app.delete("/api/setting/{key}")
async def delete_setting(key: str, current_user: dict = Depends(get_current_admin_user)):
    """Delete a setting."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM api.setting WHERE key = %s", (key,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Setting not found")
            log_audit(current_user['user_id'], None, "setting_deleted", {"key": key}, None)
            return {"message": "Setting deleted successfully"}

@app.get("/api/setting/all", response_model=List[Setting])
async def get_all_settings(current_user: dict = Depends(get_current_user)):
    """Get all settings."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT key, value FROM api.setting ORDER BY key")
            return [dict(s) for s in cur.fetchall()]

# ==================== Data Read Endpoints (API Key) ====================
# Used by the web mapping app. These are separate from the GloSIS federation
# endpoints in sis-api-glosis, which are optional.

@app.get("/api/layer", response_model=List[Layer])
async def get_published_layers(
    request: Request,
    api_client: dict = Depends(verify_api_key)
):
    """Published raster layers for the public web-mapping SPA.

    Sourced from soil_data.layer + soil_data.mapset, filtered to
    spatial_representation_type_code = 'grid' so vector stubs (ETL profile
    datasets) don't surface here. URLs are built per-request from the
    configured MapServer / download base.
    """
    download_base = "/downloads/"
    map_dir = "/etc/mapserver"
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT value FROM api.setting WHERE key = 'DOWNLOAD_BASE_URL'")
            row = cur.fetchone()
            if row and row.get("value"):
                download_base = row["value"]
            if not download_base.endswith("/"):
                download_base += "/"

            cur.execute("""
                SELECT
                  l.layer_id,
                  m.country_id,
                  m.project_id,
                  m.mapset_id,
                  m.file_identifier::text AS file_identifier,
                  COALESCE(m.costum_group, m.project_id) AS project_name,
                  COALESCE(
                    l.costum_name,
                    NULLIF(CONCAT_WS(' ',
                      m.title, m.unit_of_measure_id,
                      l.dimension_depth, l.dimension_stats), '')
                  ) AS property_name,
                  l.dimension_depth    AS dimension,
                  l.dimension_stats,
                  EXTRACT(YEAR FROM m.creation_date)::int AS year,
                  l.is_default,
                  l.stats_minimum, l.stats_maximum, l.no_data_value,
                  mp.property_type,
                  COALESCE(m.custom_classes, FALSE) AS custom_classes,
                  l.default_opacity,
                  l.display_order,
                  m.unit_of_measure_id,
                  m.keyword_theme      AS keywords,
                  -- DST outputs get a richer click popup (per-input breakdown).
                  EXISTS (SELECT 1 FROM api.dst_recipe d
                          WHERE d.output_layer_id = l.layer_id) AS is_dst,
                  -- Cache-buster: changes whenever pixel values or the .map
                  -- text on the layer row mutate.
                  md5(COALESCE(l.stats_minimum::text,'') ||
                      COALESCE(l.stats_maximum::text,'') ||
                      COALESCE(l.map,''))::text AS cache_token
                FROM soil_data.layer l
                LEFT JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                LEFT JOIN soil_data.mapped_property mp
                       ON mp.mapped_property_id = m.mapped_property_id
                WHERE l.is_published = TRUE
                  AND m.spatial_representation_type_code = 'grid'
                ORDER BY l.display_order NULLS LAST, l.layer_id
            """)
            rows = cur.fetchall()

            # Legend classes (soil_data.class) for every mapset in one query —
            # the same rows the SLD/mapfile colours come from, so the SPA's
            # dynamic legend always matches what MapServer renders.
            classes_by_mapset = {}
            mapset_ids = [r["mapset_id"] for r in rows if r.get("mapset_id")]
            if mapset_ids:
                cur.execute("""
                    SELECT mapset_id, value, label, color
                    FROM soil_data.class
                    WHERE publish IS TRUE AND mapset_id = ANY(%s)
                    ORDER BY mapset_id, value
                """, (mapset_ids,))
                for c in cur.fetchall():
                    classes_by_mapset.setdefault(c["mapset_id"], []).append({
                        "value": float(c["value"]),
                        "label": c["label"],
                        "color": c["color"],
                    })

    out = []
    for r in rows:
        layer_id = r["layer_id"]
        map_path = f"{map_dir}/{layer_id}.map"
        token = _wms_cache_token(layer_id, r.get("cache_token"))
        get_map, get_legend, get_feature_info = _build_wms_urls(
            map_path, layer_id, cache_token=token)
        # Route the SPA at the SIS rich-metadata endpoint, not pyCSW's slim
        # OGC API Records JSON. Federation harvesters still hit pyCSW for
        # the full ISO 19139 record at /collections/metadata:main/items/...
        metadata_url = f"/api/raster/metadata/{layer_id}"
        out.append({
            "layer_id": layer_id,
            "publish": True,
            "is_default": r.get("is_default") or False,
            "project_id": r.get("project_id"),
            "project_name": r.get("project_name"),
            "property_name": r.get("property_name"),
            "dimension": r.get("dimension"),
            "dimension_stats": r.get("dimension_stats"),
            "year": r.get("year"),
            "version": None,
            "unit_of_measure_id": r.get("unit_of_measure_id"),
            "keywords": r.get("keywords"),
            "is_dst": bool(r.get("is_dst")),
            "stats_minimum": r.get("stats_minimum"),
            "stats_maximum": r.get("stats_maximum"),
            "no_data_value": r.get("no_data_value"),
            "custom_classes": bool(r.get("custom_classes")),
            "default_opacity": r.get("default_opacity"),
            "display_order": r.get("display_order"),
            "property_type": r.get("property_type"),
            "legend_classes": classes_by_mapset.get(r.get("mapset_id")) or None,
            "metadata_url": metadata_url,
            "download_url": f"{download_base}{layer_id}.tif",
            "get_map_url": get_map,
            "get_legend_url": get_legend,
            "get_feature_info_url": get_feature_info,
        })
    log_audit(None, api_client['api_client_id'], "published_layers_accessed",
              {"layer_count": len(out)}, get_client_ip(request))
    return out

@app.get("/api/setting", response_model=List[Setting])
async def get_settings(
    request: Request,
    api_client: dict = Depends(verify_api_key)
):
    """Get all settings (requires API key). Used by the web mapping app."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT key, value FROM api.setting ORDER BY key")
            settings = cur.fetchall()
            log_audit(None, api_client['api_client_id'], "settings_accessed",
                     {"setting_count": len(settings)}, get_client_ip(request))
            return [dict(s) for s in settings]

@app.get("/api/manifest")
async def get_manifest(
    request: Request,
    api_client: dict = Depends(verify_api_key)
):
    """Get soil properties manifest (requires API key)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM api.vw_api_manifest")
            data = cur.fetchall()
            log_audit(None, api_client['api_client_id'], "manifest_accessed",
                     {"record_count": len(data)}, get_client_ip(request))
            return [dict(row) for row in data]

@app.get("/api/profile")
async def get_profiles(
    request: Request,
    api_client: dict = Depends(verify_api_key)
):
    """Get soil profiles (requires API key)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM api.vw_api_profile")
            data = cur.fetchall()
            log_audit(None, api_client['api_client_id'], "profiles_accessed",
                     {"record_count": len(data)}, get_client_ip(request))
            return [dict(row) for row in data]


@app.get("/api/profile/blur")
async def get_profile_blur_flags(api_client: dict = Depends(verify_api_key)):
    """Per-layer privacy flags for soil-profile layers, so the map can warn /
    adapt its UI:
      * blurred_mapset_ids        — coordinates are blurred (radius never exposed)
      * locations_only_mapset_ids — only points are shared, no observational data
      * hide_download_mapset_ids  — per-project CSV download button is hidden
    Booleans/ids only; no sensitive values are returned."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT mapset_id,
                       COALESCE(spatial_blur_m, 0) > 0 AS blurred,
                       COALESCE(locations_only, FALSE) AS loc_only,
                       COALESCE(hide_download, FALSE) AS hide_dl
                FROM soil_data.mapset
                WHERE (spatial_blur_m IS NOT NULL AND spatial_blur_m > 0)
                   OR locations_only IS TRUE
                   OR hide_download IS TRUE
            """)
            rows = cur.fetchall()
            return {
                "blurred_mapset_ids": [r[0] for r in rows if r[1]],
                "locations_only_mapset_ids": [r[0] for r in rows if r[2]],
                "hide_download_mapset_ids": [r[0] for r in rows if r[3]],
            }

@app.get("/api/profile/symbology")
async def get_profile_symbology(api_client: dict = Depends(verify_api_key)):
    """Per-project marker symbology for the map view, keyed by the stub
    mapset id. Only mapsets with at least one property set are returned."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT mapset_id, marker_shape, marker_size,
                       marker_color, marker_opacity,
                       COALESCE(active_default, TRUE) AS active_default,
                       display_order
                FROM soil_data.mapset
                WHERE marker_shape IS NOT NULL OR marker_size IS NOT NULL
                   OR marker_color IS NOT NULL OR marker_opacity IS NOT NULL
                   OR active_default IS FALSE OR display_order IS NOT NULL
            """)
            return {r["mapset_id"]: {
                "shape": r["marker_shape"], "size": r["marker_size"],
                "color": r["marker_color"], "opacity": r["marker_opacity"],
                "active": r["active_default"],
                "order": r["display_order"],
            } for r in cur.fetchall()}


@app.get("/api/observation")
async def get_observations(
    request: Request,
    profile_code: Optional[str] = None,
    api_client: dict = Depends(verify_api_key)
):
    """Get observational data, optionally filtered by profile code (requires API key)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if profile_code:
                cur.execute(
                    "SELECT * FROM api.vw_api_observation WHERE profile_code = %s",
                    (profile_code,)
                )
            else:
                cur.execute("SELECT * FROM api.vw_api_observation")
            data = cur.fetchall()
            log_audit(None, api_client['api_client_id'], "observations_accessed",
                     {"profile_code": profile_code, "record_count": len(data)},
                     get_client_ip(request))
            return [dict(row) for row in data]


@app.get("/api/observation_bounds")
async def get_observation_bounds(
    request: Request,
    api_client: dict = Depends(verify_api_key)
):
    """Per (property, procedure, unit) value bounds — used by the SPA to draw
    inline bars in the Show data panel showing where a value sits relative to
    the typical expected range."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT property_num_id, procedure_num_id, unit_of_measure_id,
                       value_min, value_max, typical_min, typical_max
                FROM soil_data.observation_num
                ORDER BY property_num_id, procedure_num_id
            """)
            return [dict(r) for r in cur.fetchall()]

# ==================== Metadata Sync ====================

PYCSW_URL = os.getenv("PYCSW_URL", "http://sis-metadata:8000")
MAPSERVER_WMS_URL = os.getenv("MAPSERVER_WMS_URL", "http://localhost:8004")

def _validate_pycsw_url(url: str) -> str:
    """Reject anything that isn't an http(s) URL pointing at our metadata
    container. Hardcoding the parser stops a future bug from turning
    PYCSW_URL into a user-controlled SSRF vector."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=500, detail="PYCSW_URL must be http(s)")
    # Allow only the docker hostname or explicit operator-trusted hosts.
    allowed_hosts = {"sis-metadata", "localhost", "127.0.0.1"}
    if parsed.hostname not in allowed_hosts:
        raise HTTPException(
            status_code=500,
            detail=f"PYCSW_URL host '{parsed.hostname}' is not in the allowlist"
        )
    return url


def _parse_layer_id(info_href: str):
    params = parse_qs(urlparse(info_href).query)
    map_path = params.get("map", [None])[0]
    if not map_path:
        return None, None
    layer_id = map_path.split("/")[-1].replace(".map", "")
    return layer_id, map_path


def _wms_cache_token(layer_id: str, db_token: Optional[str] = None) -> str:
    """Cache-buster that *actually* changes when the engine rewrites a layer.

    The DB-side fallback (md5 of stats_min/max + .map text) misses the
    common case where reclassified DST outputs keep the same value range
    across reruns. We layer the on-disk GeoTIFF mtime on top — that always
    bumps when the engine rewrites the file."""
    mtime = 0
    candidate = f"/srv/rasters/{layer_id}.tif"
    try:
        mtime = int(os.path.getmtime(candidate))
    except OSError:
        pass
    if not db_token:
        return str(mtime)
    return f"{db_token}{mtime}"


def _build_wms_urls(map_path: str, layer_id: str, cache_token: Optional[str] = None):
    """Build WMS GetMap / GetLegendGraphic / GetFeatureInfo URLs.

    `cache_token` is appended as a `_v=…` parameter on GetMap + legend so
    browsers (and any intermediate caches) treat re-rendered tiles as a
    fresh resource. MapServer ignores the parameter. Callers typically pass
    a value that mutates whenever the underlying layer is regenerated
    (e.g. soil_data.layer.stats_minimum+max, or the DST run finished_at).
    """
    base = MAPSERVER_WMS_URL
    cb = f"&_v={cache_token}" if cache_token else ""
    get_map = (f"{base}/?map={map_path}&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
               f"&LAYERS={layer_id}&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=TRUE{cb}")
    get_legend = (f"{base}/?map={map_path}&SERVICE=WMS&VERSION=1.1.1"
                  f"&LAYER={layer_id}&REQUEST=getlegendgraphic&FORMAT=image/png{cb}")
    get_feature_info = (f"{base}/?map={map_path}&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo"
                        f"&LAYERS={layer_id}&QUERY_LAYERS={layer_id}&INFO_FORMAT=text%2Fhtml")
    return get_map, get_legend, get_feature_info


def _to_relative_path(href: Optional[str]) -> Optional[str]:
    """Strip scheme/host from a pyCSW link so it becomes same-origin."""
    if not href:
        return None
    parsed = urlparse(href)
    if not parsed.netloc:
        return href
    rel = parsed.path
    if parsed.query:
        rel += "?" + parsed.query
    return rel


def _parse_property_name(title: str) -> str:
    return title.strip() if title else title


# ==================== Codelists (any authenticated user) ====================

@app.get("/api/codelist/organisations")
async def get_organisations(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT organisation_id, country, city FROM soil_data.organisation ORDER BY organisation_id")
            return cur.fetchall()

@app.get("/api/codelist/individuals")
async def get_individuals(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT individual_id, email FROM soil_data.individual ORDER BY individual_id")
            return cur.fetchall()

@app.get("/api/codelist/projects")
async def get_projects(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # `abstract` and `license` come from the stub mapset (the same
            # row the ETL ingest writes to). Falling back to project.description
            # keeps things sensible for projects that have only been used for
            # raster uploads. Both let the "Upload CSV" form auto-fill on
            # project selection.
            cur.execute("""
                SELECT p.country_id, p.project_id, p.name,
                       p.description,
                       COALESCE(m.abstract, p.description) AS abstract,
                       m.other_constraints                  AS license
                FROM soil_data.project p
                LEFT JOIN soil_data.mapset m
                       ON m.mapset_id = p.country_id || '-' || p.project_id
                ORDER BY p.project_id
            """)
            return cur.fetchall()

@app.get("/api/codelist/properties")
async def get_properties(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT property_num_id, property_name, uri FROM soil_data.property_num ORDER BY property_name")
            return cur.fetchall()


@app.post("/api/codelist/properties", status_code=status.HTTP_201_CREATED)
async def create_property(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Add a row to soil_data.property_num from the ETL standardization
    table's inline '+ Add Property…' temp row."""
    pid = (payload.get("property_num_id") or "").strip().upper()
    pname = (payload.get("property_name") or "").strip()
    definition = (payload.get("definition") or "").strip() or None
    uri = (payload.get("uri") or "").strip() or None
    if not pid:
        raise HTTPException(status_code=400, detail="property_num_id is required")
    if not re.fullmatch(r"[A-Z0-9_]+", pid):
        raise HTTPException(status_code=400,
                            detail="property_num_id must be CAPS (A-Z, 0-9, _)")
    if not pname:
        raise HTTPException(status_code=400, detail="property_name is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO soil_data.property_num
                        (property_num_id, property_name, definition, uri)
                    VALUES (%s, %s, %s, %s)
                """, (pid, pname, definition, uri))
            except psycopg2.errors.UniqueViolation:
                raise HTTPException(status_code=409,
                                    detail=f"property_num_id '{pid}' already exists")
    log_audit(current_user['user_id'], None, "property_num_created",
              {"property_num_id": pid, "property_name": pname,
               "definition": definition, "uri": uri}, None)
    return {"property_num_id": pid, "property_name": pname,
            "definition": definition, "uri": uri}

@app.get("/api/codelist/procedures")
async def get_procedures(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT procedure_num_id, procedure_name, uri FROM soil_data.procedure_num ORDER BY procedure_name")
            return cur.fetchall()


@app.post("/api/codelist/procedures", status_code=status.HTTP_201_CREATED)
async def create_procedure(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Add a row to soil_data.procedure_num from the ETL standardization
    table's inline '+ Add Procedure…' temp row.

    When `property_num_id` is supplied the endpoint also inserts an
    observation_num link (property × this procedure × 'dimensionless' unit)
    so the new procedure immediately appears in that property's procedure
    dropdown without manual catalogue surgery."""
    pid = (payload.get("procedure_num_id") or "").strip().upper()
    pname = (payload.get("procedure_name") or "").strip()
    # `definition` is the user-facing label; stored in `reference` (the
    # closest free-text column on soil_data.procedure_num).
    reference = (payload.get("definition") or "").strip() or None
    uri = (payload.get("uri") or "").strip() or None
    property_num_id = (payload.get("property_num_id") or "").strip() or None
    if not pid:
        raise HTTPException(status_code=400, detail="procedure_num_id is required")
    if not re.fullmatch(r"[A-Z0-9_]+", pid):
        raise HTTPException(status_code=400,
                            detail="procedure_num_id must be CAPS (A-Z, 0-9, _)")
    if not pname:
        raise HTTPException(status_code=400, detail="procedure_name is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO soil_data.procedure_num
                        (procedure_num_id, procedure_name, reference, uri)
                    VALUES (%s, %s, %s, %s)
                """, (pid, pname, reference, uri))
            except psycopg2.errors.UniqueViolation:
                raise HTTPException(status_code=409,
                                    detail=f"procedure_num_id '{pid}' already exists")
            if property_num_id:
                # observation_num needs a unit; default to 'dimensionless'
                # so the row is valid. The user can switch the unit later.
                cur.execute("""
                    INSERT INTO soil_data.observation_num
                        (property_num_id, procedure_num_id, unit_of_measure_id)
                    VALUES (%s, %s, 'dimensionless')
                    ON CONFLICT (property_num_id, procedure_num_id) DO NOTHING
                """, (property_num_id, pid))
    log_audit(current_user['user_id'], None, "procedure_num_created",
              {"procedure_num_id": pid, "procedure_name": pname,
               "definition": reference, "uri": uri,
               "linked_property_num_id": property_num_id}, None)
    return {"procedure_num_id": pid, "procedure_name": pname,
            "definition": reference, "uri": uri}

@app.get("/api/codelist/units")
async def get_units(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT unit_of_measure_id, unit_name FROM soil_data.unit_of_measure ORDER BY unit_name")
            return cur.fetchall()

@app.get("/api/codelist/procedures_for_property/{property_num_id}")
async def get_procedures_for_property(property_num_id: str, current_user: dict = Depends(get_current_user)):
    """Get procedure_num entries available for a given property, based on observation_num."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT DISTINCT o.procedure_num_id, p.procedure_name, p.uri
                FROM soil_data.observation_num o
                JOIN soil_data.procedure_num p ON p.procedure_num_id = o.procedure_num_id
                WHERE o.property_num_id = %s
                ORDER BY p.procedure_name
            """, (property_num_id,))
            return cur.fetchall()

@app.get("/api/codelist/units_for_property/{property_num_id}")
async def get_units_for_property(property_num_id: str, current_user: dict = Depends(get_current_user)):
    """Get unit_of_measure entries available for a given property, based on observation_num."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT DISTINCT o.unit_of_measure_id
                FROM soil_data.observation_num o
                WHERE o.property_num_id = %s
                ORDER BY o.unit_of_measure_id
            """, (property_num_id,))
            return cur.fetchall()

@app.get("/api/codelist/source_units/{property_num_id}/{procedure_num_id}")
async def get_source_units(
    property_num_id: str,
    procedure_num_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Source-unit options for an observation (canonical unit + any conversions to it).

    The canonical unit comes from observation_num.unit_of_measure_id.
    Other entries are sourced from soil_data.unit_conversion where unit_to = canonical.
    """
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT unit_of_measure_id
                FROM soil_data.observation_num
                WHERE property_num_id = %s AND procedure_num_id = %s
            """, (property_num_id, procedure_num_id))
            row = cur.fetchone()
            if not row or not row["unit_of_measure_id"]:
                return []
            canonical = row["unit_of_measure_id"]

            cur.execute("""
                SELECT c.unit_from, c.operation, c.value, c.unit_to,
                       uf.uri AS unit_from_uri, ut.uri AS unit_to_uri
                FROM soil_data.unit_conversion c
                LEFT JOIN soil_data.unit_of_measure uf ON uf.unit_of_measure_id = c.unit_from
                LEFT JOIN soil_data.unit_of_measure ut ON ut.unit_of_measure_id = c.unit_to
                WHERE c.unit_to = %s
                ORDER BY c.unit_from
            """, (canonical,))
            convs = cur.fetchall()

            # Procedures added inline via '+ Add Procedure…' get an
            # observation_num row with 'dimensionless' as a placeholder unit
            # (the user hasn't picked one yet). When that placeholder has no
            # conversions pointing to it, fall back to the full unit
            # catalogue so the user can pick any unit.
            if canonical == "dimensionless" and not convs:
                cur.execute("""
                    SELECT unit_of_measure_id, uri FROM soil_data.unit_of_measure
                    ORDER BY unit_of_measure_id
                """)
                return [{
                    "unit_of_measure_id": u["unit_of_measure_id"],
                    "operation": None,
                    "value": None,
                    "unit_to": None,
                    "is_canonical": False,
                    "uri": u["uri"],
                } for u in cur.fetchall()]

            cur.execute("SELECT uri FROM soil_data.unit_of_measure WHERE unit_of_measure_id = %s", (canonical,))
            canonical_uri_row = cur.fetchone()
            canonical_uri = canonical_uri_row["uri"] if canonical_uri_row else None

            options = [{
                "unit_of_measure_id": canonical,
                "operation": None,
                "value": None,
                "unit_to": canonical,
                "is_canonical": True,
                "uri": canonical_uri,
            }]
            for c in convs:
                options.append({
                    "unit_of_measure_id": c["unit_from"],
                    "operation": c["operation"],
                    "value": float(c["value"]) if c["value"] is not None else None,
                    "unit_to": c["unit_to"],
                    "is_canonical": False,
                    "uri": c["unit_from_uri"],
                })
            return options

def _row_get(row, key, idx):
    """Read a column from a cursor row regardless of cursor factory
    (RealDictCursor → dict, default cursor → tuple)."""
    if row is None:
        return None
    return row.get(key) if isinstance(row, dict) else row[idx]


def _instance_country_code(cur) -> str:
    """This instance's country, from api.setting.COUNTRY_CODE. It is the
    authority for new-project ownership — every SIS deployment is one
    country, so a new project always belongs to the configured country
    regardless of what the client sends. Falls back to env, then 'BT'."""
    cur.execute("SELECT value FROM api.setting WHERE key = 'COUNTRY_CODE'")
    val = _row_get(cur.fetchone(), "value", 0)
    if val:
        return val.strip().upper()
    return os.getenv("COUNTRY_CODE", "BT").upper()


def _project_country_id(cur, project_id):
    """Country that owns `project_id` in soil_data.project (first if the id
    exists under several countries), or None. The composite FK on
    api.uploaded_dataset / proj_x_org_x_ind must match this."""
    if not project_id:
        return None
    cur.execute("SELECT country_id FROM soil_data.project WHERE project_id = %s "
                "ORDER BY country_id LIMIT 1", (project_id,))
    return _row_get(cur.fetchone(), "country_id", 0)


def _validate_project_id(pid: str):
    """A project_id is embedded verbatim in the '-'-delimited raster ids
    (<CC>-<PROJ>-<PROP>-<YEAR>) and in on-disk filenames, so it must be
    uppercase letters and digits only — no spaces, symbols (incl. '-'/'_') or
    lower case. Raises 400 otherwise."""
    if not re.fullmatch(r"[A-Z0-9]+", pid or ""):
        raise HTTPException(
            status_code=400,
            detail="Project ID must be uppercase letters and digits only "
                   "(no spaces, symbols or lower case).")


@app.post("/api/codelist/projects", status_code=status.HTTP_201_CREATED)
async def create_project(payload: dict, current_user: dict = Depends(get_current_user)):
    pid = payload.get("project_id", "").strip()
    name = payload.get("name", "").strip()
    description = (payload.get("description") or "").strip() or None
    if not pid or not name:
        raise HTTPException(status_code=400, detail="project_id and name are required")
    _validate_project_id(pid)
    with get_db() as conn:
        with conn.cursor() as cur:
            # New projects always belong to THIS instance's country.
            country_id = _instance_country_code(cur)
            try:
                cur.execute(
                    "INSERT INTO soil_data.project (country_id, project_id, name, description) VALUES (%s, %s, %s, %s)",
                    (country_id, pid, name, description),
                )
                return {"country_id": country_id, "project_id": pid, "name": name, "description": description}
            except psycopg2.errors.ForeignKeyViolation:
                # Not a duplicate: the instance's configured country is not a
                # row in soil_data.country, so every insert fails its FK.
                raise HTTPException(status_code=400, detail=(
                    f"Cannot create the project: this instance's country code "
                    f"('{country_id}', from the COUNTRY_CODE setting) is not a "
                    f"known ISO 3166-1 alpha-2 code. Correct it under "
                    f"Administration → Settings and try again."))
            except psycopg2.errors.UniqueViolation as e:
                cname = getattr(getattr(e, "diag", None), "constraint_name", "") or ""
                if "name" in cname:
                    raise HTTPException(status_code=400,
                                        detail=f"A project named '{name}' already exists")
                raise HTTPException(status_code=400,
                                    detail=f"Project ID '{pid}' already exists")
            except psycopg2.IntegrityError as e:
                raise HTTPException(status_code=400, detail=(
                    "Could not create the project: "
                    + (getattr(e, "pgerror", None) or str(e)).splitlines()[0]))

@app.patch("/api/codelist/projects/{project_id}")
async def update_project(project_id: str, payload: dict, current_user: dict = Depends(get_current_user)):
    # Metadata-only edit (never the project_id). Accept `name`, and either
    # `description` or the legacy ETL key `abstract`. Only the keys present in
    # the payload are updated, so old callers that send just a description keep
    # working.
    sets, params = [], []
    if "name" in payload:
        name = (payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        sets.append("name = %s")
        params.append(name)
    if "description" in payload or "abstract" in payload:
        description = payload.get("description") if "description" in payload else payload.get("abstract")
        sets.append("description = %s")
        params.append((description or "").strip() or None)
    if not sets:
        return {"message": "Nothing to update"}
    params.append(project_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE soil_data.project SET {', '.join(sets)} WHERE project_id = %s",
                tuple(params),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project not found")
            # The profile publish stub carries copies of the project's name and
            # description (stamped at ingest: mapset.title/abstract and
            # layer.costum_name) — keep them in step so the map layer list and
            # the re-rendered catalogue record show the edit.
            cur.execute("""
                UPDATE soil_data.mapset m
                SET title    = p.name,
                    abstract = COALESCE(p.description, m.abstract)
                FROM soil_data.project p
                WHERE p.project_id = %s
                  AND m.country_id = p.country_id
                  AND m.mapset_id = p.country_id || '-' || p.project_id
            """, (project_id,))
            cur.execute("""
                UPDATE soil_data.layer l
                SET costum_name = p.name
                FROM soil_data.project p
                WHERE p.project_id = %s
                  AND l.layer_id = p.country_id || '-' || p.project_id
            """, (project_id,))
    # After commit: push the edit into the pyCSW records of the project's
    # stub + rasters (authors/abstract/title are baked into the ISO XML).
    _refresh_project_catalogue_records(project_id)
    return {"message": "Project updated"}


# ==================== Projects management (admin) ====================
# CRUD for the Projects tab. Editing is metadata-only (never the project_id).
# Deleting lets the admin, PER dependent type, either delete the dependents or
# reassign them to another project — updating ids / files / web-services / the
# pyCSW catalogue accordingly.

def _project_country_of(cur, project_id):
    """The country_id that owns project_id, or None (404 caller-side)."""
    cur.execute("SELECT country_id FROM soil_data.project WHERE project_id = %s "
                "ORDER BY country_id LIMIT 1", (project_id,))
    row = cur.fetchone()
    return (row["country_id"] if isinstance(row, dict) else row[0]) if row else None


def _project_raster_layer_ids(cur, cc, project_id):
    """layer_ids of the project's rasters (its mapsets minus the profile stub)."""
    cur.execute(
        """
        SELECT l.layer_id
        FROM soil_data.layer l
        JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
        WHERE m.country_id = %s AND m.project_id = %s
          AND m.mapset_id <> (m.country_id || '-' || m.project_id)
        ORDER BY l.layer_id
        """,
        (cc, project_id),
    )
    return [r["layer_id"] for r in cur.fetchall()]


def _refresh_project_catalogue_records(project_id: str, country_id: Optional[str] = None) -> dict:
    """Re-render and reload the pyCSW records of every layer belonging to a
    project (profile publish stub + raster layers), so edits to the project's
    name, description or authors reach the catalogue — records are otherwise
    only rendered at ingest / registration time. Best-effort: returns
    {"refreshed": [...], "failed": [...]} and never raises; catalogue failures
    must not block the edit that triggered the refresh."""
    refreshed, failed = [], []
    try:
        from raster_registry.xml_render import render_xml
        from raster_registry.pycsw_load import write_xml_and_load
        with get_db() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cc = country_id or _project_country_of(cur, project_id)
                if not cc:
                    return {"refreshed": refreshed, "failed": failed}
                layer_ids = _project_raster_layer_ids(cur, cc, project_id)
                stub = f"{cc}-{project_id}"
                cur.execute("SELECT 1 FROM soil_data.layer WHERE layer_id = %s", (stub,))
                if cur.fetchone():
                    layer_ids.insert(0, stub)
            for lid in layer_ids:
                try:
                    write_xml_and_load(lid, render_xml(conn, lid))
                    refreshed.append(lid)
                except Exception as e:
                    log.warning("catalogue refresh failed for %s: %s", lid, e)
                    failed.append(lid)
    except Exception as e:
        log.warning("catalogue refresh failed for project %s: %s", project_id, e)
    return {"refreshed": refreshed, "failed": failed}


def _delete_all_project_profiles(cur, cc, project_id) -> dict:
    """Delete ALL of a project's soil-profile data by walking
    project_site -> plot -> profile -> element -> specimen -> result_num, so it
    works regardless of the plot's csv tag (profiles orphaned from a deleted
    dataset are still removed — csv-scoped pruning misses those). Plots on a
    site shared with another project are preserved. Clears this project's
    project_site links, deletes sites no longer referenced, and marks its ETL
    datasets Removed. Keeps the project row and its publish stub. `cur` is a
    RealDictCursor inside a caller transaction."""
    cur.execute("SELECT site_id FROM soil_data.project_site WHERE country_id=%s AND project_id=%s",
                (cc, project_id))
    site_ids = [r["site_id"] for r in cur.fetchall()]
    deleted = {}
    if site_ids:
        cur.execute("""SELECT DISTINCT site_id FROM soil_data.project_site
                       WHERE site_id = ANY(%s) AND NOT (country_id=%s AND project_id=%s)""",
                    (site_ids, cc, project_id))
        shared = {r["site_id"] for r in cur.fetchall()}
        own_sites = [s for s in site_ids if s not in shared]
        if own_sites:
            cur.execute("SELECT plot_id FROM soil_data.plot WHERE site_id = ANY(%s)", (own_sites,))
            plot_ids = [r["plot_id"] for r in cur.fetchall()]
            if plot_ids:
                cur.execute("SELECT profile_id FROM soil_data.profile WHERE plot_id = ANY(%s)", (plot_ids,))
                profile_ids = [r["profile_id"] for r in cur.fetchall()]
                element_ids = []
                if profile_ids:
                    cur.execute("SELECT element_id FROM soil_data.element WHERE profile_id = ANY(%s)", (profile_ids,))
                    element_ids = [r["element_id"] for r in cur.fetchall()]
                specimen_ids = []
                if element_ids:
                    cur.execute("SELECT specimen_id FROM soil_data.specimen WHERE element_id = ANY(%s)", (element_ids,))
                    specimen_ids = [r["specimen_id"] for r in cur.fetchall()]
                if specimen_ids:
                    cur.execute("DELETE FROM soil_data.result_num WHERE specimen_id = ANY(%s)", (specimen_ids,)); deleted["result_num"] = cur.rowcount
                    cur.execute("DELETE FROM soil_data.specimen WHERE specimen_id = ANY(%s)", (specimen_ids,)); deleted["specimen"] = cur.rowcount
                if element_ids:
                    cur.execute("DELETE FROM soil_data.element WHERE element_id = ANY(%s)", (element_ids,)); deleted["element"] = cur.rowcount
                if profile_ids:
                    cur.execute("DELETE FROM soil_data.profile WHERE profile_id = ANY(%s)", (profile_ids,)); deleted["profile"] = cur.rowcount
                cur.execute("DELETE FROM soil_data.plot WHERE plot_id = ANY(%s)", (plot_ids,)); deleted["plot"] = cur.rowcount
        cur.execute("DELETE FROM soil_data.project_site WHERE country_id=%s AND project_id=%s", (cc, project_id))
        deleted["project_site"] = cur.rowcount
        deleted["site"] = 0
        for sid in own_sites:
            cur.execute("SELECT 1 FROM soil_data.project_site WHERE site_id=%s LIMIT 1", (sid,))
            if not cur.fetchone():
                cur.execute("DELETE FROM soil_data.site WHERE site_id=%s", (sid,)); deleted["site"] += cur.rowcount
    cur.execute("UPDATE api.uploaded_dataset SET status='Removed', note='Removed' "
                "WHERE country_id=%s AND project_id=%s", (cc, project_id))
    return deleted


def _delete_project_profiles(cur, cc, project_id) -> dict:
    """Full profile teardown for deleting a project: delete all profile data
    (by project, not csv), then the profile publish-stub layer/mapset
    '<CC>-<PROJ>' and the upload records (so the project row can be removed)."""
    total = _delete_all_project_profiles(cur, cc, project_id)
    stub = f"{cc}-{project_id}"
    cur.execute("DELETE FROM soil_data.layer WHERE layer_id = %s", (stub,))
    cur.execute("DELETE FROM soil_data.mapset WHERE mapset_id = %s", (stub,))
    cur.execute("DELETE FROM api.uploaded_dataset WHERE country_id = %s AND project_id = %s",
                (cc, project_id))
    return total


def _delete_stub_catalogue_record(stub_id: str):
    """Best-effort removal of a profile publish-stub's pyCSW record and its
    on-disk XML, after the stub's layer/mapset rows are gone (or renamed) —
    otherwise the catalogue keeps a ghost record forever. Call it outside the
    DB transaction; catalogue failures must never block the deletion."""
    try:
        from raster_registry.pycsw_load import delete_record, PYCSW_RECORDS_DIR
        delete_record(stub_id)
        xml_path = os.path.join(PYCSW_RECORDS_DIR, f"{stub_id}.xml")
        if os.path.exists(xml_path):
            os.remove(xml_path)
    except Exception as e:
        log.warning("stub catalogue cleanup failed for %s: %s", stub_id, e)


def _reassign_project_profiles(cur, cc, src, tgt) -> dict:
    """Move a project's profiles/uploads/authors onto an existing target project,
    de-duplicating shared sites and author rows, and merge the profile stub."""
    moved = {}
    # project_site: drop links to sites the target already has, then move the rest
    cur.execute("""DELETE FROM soil_data.project_site s
                   WHERE s.country_id=%s AND s.project_id=%s AND EXISTS (
                     SELECT 1 FROM soil_data.project_site t
                     WHERE t.country_id=%s AND t.project_id=%s AND t.site_id=s.site_id)""",
                (cc, src, cc, tgt))
    cur.execute("UPDATE soil_data.project_site SET project_id=%s WHERE country_id=%s AND project_id=%s",
                (tgt, cc, src))
    moved["project_site"] = cur.rowcount
    cur.execute("UPDATE api.uploaded_dataset SET project_id=%s WHERE country_id=%s AND project_id=%s",
                (tgt, cc, src))
    moved["uploaded_dataset"] = cur.rowcount
    # authors (proj_x_org_x_ind): drop exact duplicates, move the rest
    cur.execute("""DELETE FROM soil_data.proj_x_org_x_ind s
                   WHERE s.country_id=%s AND s.project_id=%s AND EXISTS (
                     SELECT 1 FROM soil_data.proj_x_org_x_ind t
                     WHERE t.country_id=%s AND t.project_id=%s
                       AND t.organisation_id=s.organisation_id AND t.individual_id=s.individual_id
                       AND t.position=s.position AND t.tag=s.tag AND t.role=s.role)""",
                (cc, src, cc, tgt))
    cur.execute("UPDATE soil_data.proj_x_org_x_ind SET project_id=%s WHERE country_id=%s AND project_id=%s",
                (tgt, cc, src))
    moved["authors"] = cur.rowcount
    # merge the profile publish-stub '<CC>-<src>' into '<CC>-<tgt>'
    src_stub, tgt_stub = f"{cc}-{src}", f"{cc}-{tgt}"
    cur.execute("SELECT 1 FROM soil_data.mapset WHERE mapset_id=%s", (tgt_stub,))
    if cur.fetchone():
        cur.execute("DELETE FROM soil_data.layer WHERE layer_id=%s", (src_stub,))
        cur.execute("DELETE FROM soil_data.mapset WHERE mapset_id=%s", (src_stub,))
    else:
        cur.execute("UPDATE soil_data.mapset SET country_id=%s, project_id=%s, mapset_id=%s WHERE mapset_id=%s",
                    (cc, tgt, tgt_stub, src_stub))
        cur.execute("UPDATE soil_data.layer SET layer_id=%s WHERE layer_id=%s", (tgt_stub, src_stub))
    return moved


def _dst_finalize_render(output_layer_id: str):
    """Apply the DST-output rendering to a raster-calculator output: a green->red
    mapped-property ramp, and a stats_minimum recomputed over NON-ZERO values so
    0 (the DST nodata sentinel) falls below the colour ramp and renders
    transparent. Re-fires the map trigger (via the stats update, which reads the
    freshly-set property colours) and re-dumps the .map. The plain raster
    re-registration doesn't reproduce this, so reassignment calls it explicitly.
    """
    import rasterio as _rio
    tif = os.path.join("/srv/rasters", f"{output_layer_id}.tif")
    if not os.path.isfile(tif):
        return
    with _rio.open(tif) as src:
        band = src.read(1, masked=True)
    nz = band.compressed()
    nz = nz[nz != 0]
    real_min = float(nz.min()) if nz.size else None
    with get_db() as conn:
        with conn.cursor() as cur:
            # Green (low) -> red (high) ramp on this output's mapped_property
            # (DST-minted MAP#### properties are per-output, matching the DST
            # editor's default). Set BEFORE the stats update so the map trigger
            # picks up the new colours.
            cur.execute("""
                UPDATE soil_data.mapped_property SET start_color = '#1a9850', end_color = '#d7191c'
                WHERE mapped_property_id = (
                    SELECT m.mapped_property_id FROM soil_data.layer l
                    JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                    WHERE l.layer_id = %s)
            """, (output_layer_id,))
            # Re-set stats_minimum (to the real non-zero min) — this re-fires the
            # map trigger so DATARANGE spans the real data, leaving 0 transparent.
            cur.execute(
                "UPDATE soil_data.layer SET stats_minimum = COALESCE(%s, stats_minimum) "
                "WHERE layer_id = %s", (real_min, output_layer_id))
            cur.execute("SELECT map FROM soil_data.layer WHERE layer_id = %s", (output_layer_id,))
            row = cur.fetchone()
    if row and row[0]:
        with open(os.path.join("/srv/rasters", f"{output_layer_id}.map"), "w", encoding="utf-8") as fh:
            fh.write(row[0])


def _retag_raster(old_layer_id: str, target_project_id: str, user_id: str) -> dict:
    """Reassign one raster to another project: rename its files to the new
    <CC>-<target>-<rest> id and re-register (regenerating .map/.sld/xml/urls and
    the pyCSW record), preserving title/abstract/licence/dates/unit/publish and
    the colour classes. Returns {ok, old_layer_id, new_layer_id, warnings} or a
    {ok:False, skipped, reason} when the file is missing or the target id exists."""
    from raster_registry.register import register_raster
    from raster_registry.populate import ClassDef

    warnings: list = []
    # 1. capture current metadata + colour classes, compute the new id
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT l.mapset_id, l.file_extension, l.is_published, l.file_orig_name,
                       m.title, m.abstract, m.other_constraints, m.publication_date,
                       m.unit_of_measure_id, m.time_period_begin, m.time_period_end
                FROM soil_data.layer l JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                WHERE l.layer_id = %s
            """, (old_layer_id,))
            row = cur.fetchone()
            if not row:
                return {"ok": False, "skipped": True, "old_layer_id": old_layer_id,
                        "reason": "layer not found"}
            ext = (row["file_extension"] or "tif").lstrip(".")
            parts = old_layer_id.split("-")
            if len(parts) < 2:
                return {"ok": False, "skipped": True, "old_layer_id": old_layer_id,
                        "reason": "unexpected layer_id shape"}
            parts[1] = target_project_id
            new_layer_id = "-".join(parts)
            cur.execute("SELECT value, code, label, color, opacity, publish "
                        "FROM soil_data.class WHERE mapset_id=%s ORDER BY value", (row["mapset_id"],))
            classes = [ClassDef(**c) for c in cur.fetchall()] or None
            meta = dict(row)

    if new_layer_id == old_layer_id:
        return {"ok": False, "skipped": True, "old_layer_id": old_layer_id,
                "reason": "already under target project"}

    old_tif = os.path.join("/srv/rasters", f"{old_layer_id}.{ext}")
    new_tif = os.path.join("/srv/rasters", f"{new_layer_id}.{ext}")
    # 2. collision guard — never overwrite an existing raster
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM soil_data.layer WHERE layer_id=%s", (new_layer_id,))
            if cur.fetchone() or os.path.exists(new_tif):
                return {"ok": False, "skipped": True, "old_layer_id": old_layer_id,
                        "new_layer_id": new_layer_id, "reason": "target id already exists"}
    if not os.path.isfile(old_tif):
        return {"ok": False, "skipped": True, "old_layer_id": old_layer_id,
                "reason": f"raster file missing: {old_tif}"}

    # 3. rename the raster + its stats sidecar to the new id
    os.rename(old_tif, new_tif)
    old_aux, new_aux = f"{old_tif}.aux.xml", f"{new_tif}.aux.xml"
    if os.path.isfile(old_aux):
        try:
            os.rename(old_aux, new_aux)
        except OSError as e:
            warnings.append(f"rename {old_aux}: {e}")

    # 4. remove the old DB/pyCSW/.map artifacts (old .tif already moved away)
    warnings += _delete_layer_full(old_layer_id, user_id, missing_ok=True).get("warnings", [])

    # 5. re-register under the new id, carrying the captured metadata
    try:
        with get_db() as conn:
            register_raster(
                conn, new_tif,
                project_name=target_project_id,
                title=meta.get("title"), abstract=meta.get("abstract"),
                classes=classes, license=meta.get("other_constraints"),
                publish=bool(meta.get("is_published")),
                publication_date=meta.get("publication_date"),
                unit_of_measure_id=meta.get("unit_of_measure_id"),
                time_period_begin=meta.get("time_period_begin"),
                time_period_end=meta.get("time_period_end"),
                file_orig_name=meta.get("file_orig_name"),
            )
    except Exception as e:
        warnings.append(f"re-register failed for {new_layer_id}: {e}")
        return {"ok": False, "old_layer_id": old_layer_id, "new_layer_id": new_layer_id,
                "warnings": warnings}

    # 6. Repoint any DST (Raster-calculator) recipe that references this raster,
    # so is_dst and the pixel-breakdown popup keep working after the rename:
    #   * as an OUTPUT → rename recipe_id + output_layer_id (kept equal; re-running
    #     a recipe derives the output id from recipe_id; is_dst/popup key off
    #     output_layer_id). Nothing FKs to recipe_id.
    #   * as an INPUT  → repoint the matching step.layer_id inside recipe JSON, so
    #     the popup can still sample the input and the recipe still re-runs.
    try:
        from psycopg2.extras import Json as _Json
        with get_db() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "UPDATE api.dst_recipe SET recipe_id = %s, output_layer_id = %s "
                    "WHERE output_layer_id = %s OR recipe_id = %s",
                    (new_layer_id, new_layer_id, old_layer_id, old_layer_id),
                )
                cur.execute("SELECT recipe_id, recipe FROM api.dst_recipe")
                for r in cur.fetchall():
                    rec = r["recipe"] or {}
                    changed = False
                    for s in (rec.get("steps") or []):
                        if s.get("layer_id") == old_layer_id:
                            s["layer_id"] = new_layer_id
                            changed = True
                    if changed:
                        cur.execute("UPDATE api.dst_recipe SET recipe = %s WHERE recipe_id = %s",
                                    (_Json(rec), r["recipe_id"]))
    except Exception as e:
        warnings.append(f"dst_recipe repoint failed for {new_layer_id}: {e}")

    # 7. If the raster is a DST output, restore its DST rendering (green->red
    # ramp + 0 transparent) — the plain re-registration reset stats_minimum to 0
    # and kept the default ramp.
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM api.dst_recipe WHERE output_layer_id = %s", (new_layer_id,))
                is_dst_output = cur.fetchone() is not None
        if is_dst_output:
            _dst_finalize_render(new_layer_id)
    except Exception as e:
        warnings.append(f"dst render finalize failed for {new_layer_id}: {e}")

    return {"ok": True, "old_layer_id": old_layer_id, "new_layer_id": new_layer_id,
            "warnings": warnings}


@app.get("/api/projects")
async def list_projects_managed(current_user: dict = Depends(get_current_user)):
    """Projects with dependent counts for the Projects tab."""
    sql = """
        SELECT p.country_id, p.project_id, p.name, p.description,
               COALESCE(pc.profiles, 0) AS profile_count,
               COALESCE(rc.rasters, 0)  AS raster_count
        FROM soil_data.project p
        LEFT JOIN (
            SELECT ps.country_id, ps.project_id, count(DISTINCT pr.profile_id) AS profiles
            FROM soil_data.project_site ps
            JOIN soil_data.plot pl ON pl.site_id = ps.site_id
            JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
            GROUP BY 1, 2
        ) pc ON pc.country_id = p.country_id AND pc.project_id = p.project_id
        LEFT JOIN (
            SELECT m.country_id, m.project_id, count(*) AS rasters
            FROM soil_data.layer l JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
            WHERE m.mapset_id <> (m.country_id || '-' || m.project_id)
            GROUP BY 1, 2
        ) rc ON rc.country_id = p.country_id AND rc.project_id = p.project_id
        ORDER BY p.name;
    """
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


@app.get("/api/projects/{project_id}/dependents")
async def get_project_dependents(project_id: str, current_user: dict = Depends(get_current_user)):
    """Dependent objects of a project, to drive the delete dialog."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cc = _project_country_of(cur, project_id)
            if not cc:
                raise HTTPException(status_code=404, detail="Project not found")
            cur.execute("""
                SELECT count(DISTINCT pr.profile_id) AS profiles
                FROM soil_data.project_site ps
                JOIN soil_data.plot pl ON pl.site_id = ps.site_id
                JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
                WHERE ps.country_id = %s AND ps.project_id = %s
            """, (cc, project_id))
            profiles = cur.fetchone()["profiles"]
            cur.execute("SELECT table_name FROM api.uploaded_dataset WHERE country_id=%s AND project_id=%s",
                        (cc, project_id))
            datasets = [r["table_name"] for r in cur.fetchall()]
            raster_ids = _project_raster_layer_ids(cur, cc, project_id)
    return {
        "country_id": cc,
        "profiles": {"count": profiles, "datasets": datasets},
        "rasters": {"count": len(raster_ids), "layer_ids": raster_ids},
    }


@app.delete("/api/projects/{project_id}")
async def delete_project_managed(
    project_id: str,
    payload: dict = Body(default={}),
    current_user: dict = Depends(get_current_admin_user),
):
    """Delete a project. For each dependent type present, the payload chooses to
    `delete` those dependents or `reassign` them to another project:
        {"profiles": {"action": "delete|reassign", "target_project_id": "…"},
         "rasters":  {"action": "delete|reassign", "target_project_id": "…"}}
    Rasters are retagged one-by-one (own transactions); a target-id collision
    skips that raster and keeps the source project. Everything else runs in one
    transaction, then the empty project row is removed.
    """
    uid = current_user["user_id"]
    payload = payload or {}
    prof_opt = payload.get("profiles") or {}
    rast_opt = payload.get("rasters") or {}
    summary = {"profiles": {}, "rasters": {"deleted": [], "reassigned": [], "skipped": []},
               "warnings": []}

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cc = _project_country_of(cur, project_id)
            if not cc:
                raise HTTPException(status_code=404, detail="Project not found")
            raster_ids = _project_raster_layer_ids(cur, cc, project_id)
            cur.execute("""
                SELECT count(DISTINCT pr.profile_id) AS n
                FROM soil_data.project_site ps
                JOIN soil_data.plot pl ON pl.site_id = ps.site_id
                JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
                WHERE ps.country_id = %s AND ps.project_id = %s
            """, (cc, project_id))
            profile_count = cur.fetchone()["n"]

            # validate required actions + reassign targets up front
            def _validate(kind, opt, has_dep):
                if not has_dep:
                    return None
                action = (opt.get("action") or "").lower()
                if action not in ("delete", "reassign"):
                    raise HTTPException(status_code=400,
                                        detail=f"{kind}: action must be 'delete' or 'reassign'")
                if action == "reassign":
                    tgt = (opt.get("target_project_id") or "").strip()
                    if not tgt or tgt == project_id:
                        raise HTTPException(status_code=400,
                                            detail=f"{kind}: a different target project is required")
                    cur.execute("SELECT 1 FROM soil_data.project WHERE country_id=%s AND project_id=%s",
                                (cc, tgt))
                    if not cur.fetchone():
                        raise HTTPException(status_code=400,
                                            detail=f"{kind}: target project '{tgt}' not found")
                    return tgt
                return None

            prof_target = _validate("profiles", prof_opt, profile_count > 0)
            rast_target = _validate("rasters", rast_opt, len(raster_ids) > 0)

    # --- rasters (each in its own transaction via the helpers) ---
    if raster_ids:
        action = (rast_opt.get("action") or "").lower()
        for lid in raster_ids:
            if action == "delete":
                res = _delete_layer_full(lid, uid, missing_ok=True)
                summary["rasters"]["deleted"].append(lid)
                summary["warnings"] += res.get("warnings", [])
            else:  # reassign
                res = _retag_raster(lid, rast_target, uid)
                summary["warnings"] += res.get("warnings", [])
                if res.get("ok"):
                    summary["rasters"]["reassigned"].append(res["new_layer_id"])
                else:
                    summary["rasters"]["skipped"].append(
                        {"layer_id": lid, "reason": res.get("reason", "failed")})

    # --- profiles + final project removal (one transaction) ---
    rasters_all_handled = not summary["rasters"]["skipped"]
    stub_id = f"{cc}-{project_id}"
    stub_gone = False
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if profile_count > 0:
                if (prof_opt.get("action") or "").lower() == "delete":
                    summary["profiles"] = _delete_project_profiles(cur, cc, project_id)
                else:
                    summary["profiles"] = _reassign_project_profiles(cur, cc, project_id, prof_target)
                # either way the stub no longer exists under this project's id
                # (deleted, merged into the target, or renamed to the target)
                stub_gone = True
            else:
                # The publish stub ('<CC>-<PROJ>' layer+mapset created by the
                # ETL ingest) survives an earlier profile deletion from the
                # Soil profiles tab — deliberately, so its policy fields carry
                # over to a re-ingest. But with no profiles left the branch
                # above never runs, so nothing would ever remove the stub, and
                # the leftover check below then counts its mapset and keeps
                # the project forever. Remove the stub for the empty project.
                cur.execute("DELETE FROM soil_data.layer WHERE layer_id = %s", (stub_id,))
                n_layer = cur.rowcount
                cur.execute("DELETE FROM soil_data.mapset WHERE mapset_id = %s", (stub_id,))
                stub_gone = bool(n_layer or cur.rowcount)
            # remove the project row only if nothing is left behind
            cur.execute("""SELECT
                    (SELECT count(*) FROM soil_data.project_site WHERE country_id=%s AND project_id=%s) AS ps,
                    (SELECT count(*) FROM soil_data.mapset WHERE country_id=%s AND project_id=%s) AS ms
                """, (cc, project_id, cc, project_id))
            left = cur.fetchone()
            project_deleted = False
            if rasters_all_handled and left["ps"] == 0 and left["ms"] == 0:
                cur.execute("DELETE FROM api.uploaded_dataset WHERE country_id=%s AND project_id=%s",
                            (cc, project_id))
                cur.execute("DELETE FROM soil_data.proj_x_org_x_ind WHERE country_id=%s AND project_id=%s",
                            (cc, project_id))
                cur.execute("DELETE FROM soil_data.project WHERE country_id=%s AND project_id=%s",
                            (cc, project_id))
                project_deleted = cur.rowcount > 0
            else:
                summary["warnings"].append(
                    "Project kept: some dependents could not be moved/removed "
                    f"(project_site={left['ps']}, mapsets={left['ms']}, "
                    f"skipped_rasters={len(summary['rasters']['skipped'])}).")

    if stub_gone:
        _delete_stub_catalogue_record(stub_id)

    log_audit(uid, None, "project_deleted",
              {"project_id": project_id, "country_id": cc, "summary": summary,
               "project_deleted": project_deleted}, None)
    return {"message": "Project deleted" if project_deleted else "Project retained (see warnings)",
            "project_deleted": project_deleted, **summary}


@app.post("/api/codelist/organisations", status_code=status.HTTP_201_CREATED)
async def create_organisation(payload: dict, current_user: dict = Depends(get_current_user)):
    oid = payload.get("organisation_id", "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="organisation_id is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO soil_data.organisation (organisation_id, country, city)
                    VALUES (%s, %s, %s)
                """, (oid, payload.get("country"), payload.get("city")))
                return {"organisation_id": oid, "country": payload.get("country"), "city": payload.get("city")}
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=400, detail="Organisation already exists")

@app.post("/api/codelist/individuals", status_code=status.HTTP_201_CREATED)
async def create_individual(payload: dict, current_user: dict = Depends(get_current_user)):
    iid = payload.get("individual_id", "").strip()
    if not iid:
        raise HTTPException(status_code=400, detail="individual_id is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute("INSERT INTO soil_data.individual (individual_id, email) VALUES (%s, %s)",
                           (iid, payload.get("email")))
                return {"individual_id": iid, "email": payload.get("email")}
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=400, detail="Individual already exists")

# ==================== ETL (any authenticated user) ====================

@app.put("/api/etl/metadata")
async def save_etl_metadata(
    payload: dict,
    current_user: dict = Depends(get_current_user)
):
    """Replace all authors for a project in soil_data.proj_x_org_x_ind.

    Accepts `country_id` in the payload; falls back to the env COUNTRY_CODE
    for backwards compatibility with single-country callers.
    """
    project_id = payload.get("project_id")
    req_country = (payload.get("country_id") or "").upper()
    authors = payload.get("authors", [])
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            # The author link FK references soil_data.project(country_id,
            # project_id). Trust the project table over the request / env
            # COUNTRY_CODE, which can disagree (e.g. demo data seeded under a
            # different country than the instance's configured code). Use the
            # requested country only if that exact project exists; otherwise
            # resolve the project's real owner by project_id.
            country_id = None
            if req_country:
                cur.execute("SELECT 1 FROM soil_data.project WHERE country_id=%s AND project_id=%s",
                            (req_country, project_id))
                if cur.fetchone():
                    country_id = req_country
            if country_id is None:
                cur.execute("SELECT country_id FROM soil_data.project WHERE project_id=%s ORDER BY country_id LIMIT 1",
                            (project_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail=f"Project '{project_id}' not found")
                country_id = row[0]
            cur.execute(
                "DELETE FROM soil_data.proj_x_org_x_ind WHERE country_id = %s AND project_id = %s",
                (country_id, project_id),
            )
            for a in authors:
                org = a.get("organisation_id")
                ind = a.get("individual_id")
                if not org or not ind:
                    continue
                cur.execute("""
                    INSERT INTO soil_data.proj_x_org_x_ind
                        (country_id, project_id, organisation_id, individual_id, position, tag, role)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (country_id, project_id, org, ind,
                      a.get("position"), a.get("tag"), a.get("role")))
            log_audit(current_user['user_id'], None, "etl_metadata_saved",
                     {"country_id": country_id, "project_id": project_id,
                      "count": len(authors)}, None)
    # After commit: authors are baked into the ISO XML (contact /
    # pointOfContact blocks), so re-render the project's catalogue records.
    _refresh_project_catalogue_records(project_id, country_id)
    return {"message": f"{len(authors)} author(s) saved"}

@app.get("/api/etl/project/{project_id}/authors")
async def get_project_authors(
    project_id: str,
    country_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """Get existing authors linked to a project from soil_data.proj_x_org_x_ind."""
    req_country = (country_id or "").upper()
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Resolve the project's real owner (see save_etl_metadata) so the
            # author list matches regardless of the instance's COUNTRY_CODE.
            cc = req_country
            if cc:
                cur.execute("SELECT 1 FROM soil_data.project WHERE country_id=%s AND project_id=%s",
                            (cc, project_id))
                if not cur.fetchone():
                    cc = None
            if not cc:
                cur.execute("SELECT country_id FROM soil_data.project WHERE project_id=%s ORDER BY country_id LIMIT 1",
                            (project_id,))
                row = cur.fetchone()
                cc = row["country_id"] if row else (req_country or "")
            cur.execute("""
                SELECT organisation_id, individual_id, position, tag, role
                FROM soil_data.proj_x_org_x_ind
                WHERE country_id = %s AND project_id = %s
                ORDER BY organisation_id, individual_id
            """, (cc, project_id))
            return cur.fetchall()

CSV_UPLOAD_MAX_BYTES = 50 * 1024 * 1024   # 50 MB
CSV_UPLOAD_MAX_ROWS  = 200_000

# validate_dataset stamps the dataset note with this exact string only when
# EVERY check passed. ingest_dataset gates on it (see the guard there).
VALIDATION_OK_NOTE = "Validation OK"

@app.post("/api/etl/upload")
async def upload_csv(
    file: UploadFile = File(...),
    project_id: str = Form(None),
    current_user: dict = Depends(get_current_user)
):
    """Upload a CSV file: create staging table, register in api.uploaded_dataset."""
    if not file.filename or not file.filename.lower().endswith('.csv'):
        raise HTTPException(status_code=400, detail="Only CSV files are accepted")

    # Read with a hard byte cap so a malicious or runaway upload can't OOM us.
    contents = await file.read(CSV_UPLOAD_MAX_BYTES + 1)
    if len(contents) > CSV_UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"CSV exceeds {CSV_UPLOAD_MAX_BYTES // (1024 * 1024)} MB limit"
        )
    text = contents.decode('utf-8-sig')
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="CSV must have a header row and at least one data row")
    if len(rows) - 1 > CSV_UPLOAD_MAX_ROWS:
        raise HTTPException(
            status_code=413,
            detail=f"CSV exceeds {CSV_UPLOAD_MAX_ROWS} data-row limit"
        )

    raw_headers = [h.strip() for h in rows[0]]
    data_rows = rows[1:]

    # Sanitize column names: replace chars that break psycopg2's parameter substitution
    # Keep a map from sanitized → original for display
    def sanitize_col(name):
        return name.replace('%', 'pct')

    # Build safe, NON-EMPTY, UNIQUE column names. A blank header (e.g. a trailing
    # comma / unnamed column) would otherwise become a zero-length identifier
    # (`"" TEXT`) and duplicate headers a duplicate column — both crash the
    # CREATE TABLE. Blank → column_N (1-based); repeats get a numeric suffix.
    headers = []
    used = set()
    for i, h in enumerate(raw_headers, start=1):
        name = sanitize_col(h).strip() or f"column_{i}"
        base, n = name, 2
        while name.lower() in used:
            name = f"{base}_{n}"
            n += 1
        used.add(name.lower())
        headers.append(name)

    # Build a safe table name. Postgres truncates identifiers at 63 chars, so
    # if two long filenames sanitize to the same prefix the second upload's
    # CREATE TABLE silently collides with the first. Cap the base at 40 chars
    # (timestamp suffix is 16 chars + an underscore = 57, well under 63).
    base_name = re.sub(r'[^a-zA-Z0-9_]', '_', file.filename.rsplit('.', 1)[0]).lower()[:40]
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    table_name = f"{base_name}_{ts}"

    # Protect _row_id reserved name
    if any(h == '_row_id' for h in headers):
        raise HTTPException(status_code=400, detail="Column name '_row_id' is reserved; please rename in your CSV.")

    with get_db() as conn:
        with conn.cursor() as cur:
            # Create staging table with _row_id surrogate key + all TEXT columns
            col_defs = pgsql.SQL(', ').join(
                [pgsql.SQL("_row_id SERIAL PRIMARY KEY")] +
                [pgsql.SQL("{} TEXT").format(pgsql.Identifier(h)) for h in headers]
            )
            cur.execute(pgsql.SQL("CREATE TABLE {}.{} ({})").format(
                pgsql.Identifier('soil_data_upload'),
                pgsql.Identifier(table_name),
                col_defs
            ))

            # Insert data
            if data_rows:
                placeholders = pgsql.SQL(', ').join([pgsql.Placeholder()] * len(headers))
                insert_sql = pgsql.SQL("INSERT INTO {}.{} ({}) VALUES ({})").format(
                    pgsql.Identifier('soil_data_upload'),
                    pgsql.Identifier(table_name),
                    pgsql.SQL(', ').join(pgsql.Identifier(h) for h in headers),
                    placeholders
                )
                for row in data_rows:
                    # Pad or truncate row to match headers
                    padded = (row + [''] * len(headers))[:len(headers)]
                    cur.execute(insert_sql, padded)

            # Register in api.uploaded_dataset. country_id is required since
            # the spatial_metadata → soil_data merge made project's PK composite.
            # Use this instance's configured country (api.setting), not the env
            # default — the env is unset in deployment, so "BT" leaked in and
            # broke the (country_id, project_id) FK on non-BT instances.
            country_id = _project_country_id(cur, project_id) or _instance_country_code(cur)
            cur.execute("""
                INSERT INTO api.uploaded_dataset
                    (table_name, file_name, user_id, status, n_rows, n_col,
                     country_id, project_id)
                VALUES (%s, %s, %s, 'Uploaded', %s, %s, %s, %s)
            """, (table_name, file.filename, current_user['user_id'],
                  len(data_rows), len(headers),
                  country_id, project_id))

            # Initialize column entries in api.uploaded_dataset_column
            for i, h in enumerate(headers):
                note = raw_headers[i] if raw_headers[i] != h else None
                cur.execute("""
                    INSERT INTO api.uploaded_dataset_column (table_name, column_name, ignore_column, note)
                    VALUES (%s, %s, true, %s)
                """, (table_name, h, note))

            log_audit(current_user['user_id'], None, "etl_csv_uploaded",
                     {"table_name": table_name, "rows": len(data_rows), "cols": len(headers)}, None)

    # Return preview (first 20 rows)
    preview = data_rows[:20]
    return {
        "table_name": table_name,
        "columns": headers,
        "n_rows": len(data_rows),
        "n_col": len(headers),
        "preview": preview
    }

@app.get("/api/etl/datasets")
async def list_datasets(current_user: dict = Depends(get_current_user)):
    """List all uploaded datasets."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM api.uploaded_dataset ORDER BY table_name DESC")
            return cur.fetchall()

# Rows returned to the preview/mapping table. The UI paginates these client-
# side (100/page), so a 100-row cap made every CSV a single, un-navigable page.
# 5000 covers realistic soil-profile CSVs while keeping the payload light;
# ingest still processes the full staging table regardless.
ETL_PREVIEW_MAX_ROWS = 5000

@app.get("/api/etl/datasets/{table_name}/preview")
async def get_dataset_preview(table_name: str, current_user: dict = Depends(get_current_user)):
    """Get up to ETL_PREVIEW_MAX_ROWS rows from a staging table (paginated in the UI)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Dataset not found")
            cur.execute(pgsql.SQL("SELECT * FROM {}.{} ORDER BY _row_id LIMIT {}").format(
                pgsql.Identifier('soil_data_upload'),
                pgsql.Identifier(table_name),
                pgsql.Literal(ETL_PREVIEW_MAX_ROWS)
            ))
            rows = cur.fetchall()
            all_cols = [desc[0] for desc in cur.description] if cur.description else []
            # Hide _row_id from the column list (keep it in each row for PATCH targeting)
            columns = [c for c in all_cols if c != '_row_id']
            return {"columns": columns, "rows": [dict(r) for r in rows]}

@app.get("/api/etl/datasets/{table_name}/columns")
async def get_dataset_columns(table_name: str, current_user: dict = Depends(get_current_user)):
    """Get column mappings for a dataset."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT column_name, property_num_id, procedure_num_id, unit_of_measure_id,
                       ignore_column, note, destination_table, destination_column,
                       validation
                FROM api.uploaded_dataset_column
                WHERE table_name = %s ORDER BY column_name
            """, (table_name,))
            return cur.fetchall()

@app.put("/api/etl/datasets/{table_name}/columns")
async def save_dataset_columns(
    table_name: str,
    payload: dict,
    current_user: dict = Depends(get_current_user)
):
    """Save column mappings for a dataset. Payload: {columns: [...], epsg: "4326"}."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Dataset not found")

            columns = payload.get("columns", [])
            epsg = payload.get("epsg")
            project_id = payload.get("project_id")

            for col in columns:
                # If the (property, procedure) pair was added inline via
                # '+ Add Procedure…', observation_num was created with a
                # 'dimensionless' placeholder unit. Now that the user has
                # picked a real one, promote it to canonical — but only
                # when nothing depends on the old canonical yet (no
                # result_num rows referencing this observation_num).
                prop_id = col.get("property_num_id")
                proc_id = col.get("procedure_num_id")
                unit_id = col.get("unit_of_measure_id")
                if prop_id and proc_id and unit_id and unit_id != "dimensionless":
                    cur.execute("""
                        UPDATE soil_data.observation_num o
                        SET unit_of_measure_id = %s
                        WHERE o.property_num_id = %s
                          AND o.procedure_num_id = %s
                          AND o.unit_of_measure_id = 'dimensionless'
                          AND NOT EXISTS (
                              SELECT 1 FROM soil_data.result_num r
                              WHERE r.observation_num_id = o.observation_num_id
                          )
                    """, (unit_id, prop_id, proc_id))

                cur.execute("""
                    UPDATE api.uploaded_dataset_column
                    SET destination_table = %s,
                        destination_column = %s,
                        property_num_id = %s,
                        procedure_num_id = %s,
                        unit_of_measure_id = %s,
                        ignore_column = %s,
                        note = %s
                    WHERE table_name = %s AND column_name = %s
                """, (
                    col.get("destination_table"),
                    col.get("destination_column"),
                    col.get("property_num_id"),
                    col.get("procedure_num_id"),
                    col.get("unit_of_measure_id"),
                    col.get("ignore_column", True),
                    col.get("note"),
                    table_name,
                    col["column_name"]
                ))

            # A skipped (ignore) or unmapped column can't carry a meaningful
            # validation result — clear any stale one so the UI stops showing an
            # error for a column the user has excluded.
            cur.execute("""
                UPDATE api.uploaded_dataset_column
                SET validation = NULL
                WHERE table_name = %s
                  AND (ignore_column = true OR destination_table IS NULL)
            """, (table_name,))

            if epsg:
                cur.execute("""
                    UPDATE api.uploaded_dataset SET cords_epsg = %s WHERE table_name = %s
                """, (epsg, table_name))

            if project_id:
                # Keep country_id in lock-step with the project so the composite
                # FK to soil_data.project holds (self-heals datasets that were
                # registered with a stale/default country at upload time).
                proj_country = _project_country_id(cur, project_id) or _instance_country_code(cur)
                cur.execute("""
                    UPDATE api.uploaded_dataset SET country_id = %s, project_id = %s
                    WHERE table_name = %s
                """, (proj_country, project_id, table_name))

            log_audit(current_user['user_id'], None, "etl_columns_saved",
                     {"table_name": table_name, "columns": len(columns)}, None)
            return {"message": "Column mappings saved successfully"}

@app.post("/api/etl/datasets/{table_name}/ingest")
async def ingest_dataset(
    table_name: str,
    payload: Optional[dict] = None,
    current_user: dict = Depends(get_current_user)
):
    """Ingest staged CSV data into soil_data tables based on column mappings.

    Optional JSON body: { "license": "<CC BY-NC-SA-4.0|...>" } — copied to the
    stub mapset's other_constraints.

    Validation runs silently first (same checks as the Validate button); ingest
    proceeds only when it is fully clean, so no separate Validate click is
    needed and a stale/reset validation stamp can't wrongly block ingest.
    """
    license_val = (payload or {}).get("license") if isinstance(payload, dict) else None

    # Resolve the licence up front (falling back to the one already recorded on
    # the project's stub mapset) so the silent validation sees it.
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT project_id, country_id FROM api.uploaded_dataset WHERE table_name = %s",
                        (table_name,))
            ds0 = cur.fetchone()
            if not ds0:
                raise HTTPException(status_code=404, detail="Dataset not found")
            if not (license_val or "").strip():
                cc0 = (_project_country_id(cur, ds0.get("project_id"))
                       or ds0.get("country_id") or _instance_country_code(cur))
                cur.execute("SELECT other_constraints FROM soil_data.mapset WHERE mapset_id = %s",
                            (f"{cc0}-{ds0.get('project_id')}",))
                _lr = cur.fetchone()
                if _lr and (_lr.get("other_constraints") or "").strip():
                    license_val = _lr["other_constraints"]

    # Run the full validation silently (it also stamps the dataset note).
    validation = await validate_dataset(table_name, {"license": license_val}, current_user)
    if (validation.get("message") or "") != VALIDATION_OK_NOTE:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot ingest — {validation.get('message') or 'validation failed'}. "
                   "Resolve the reported issues and try again.")

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get dataset metadata
            cur.execute("SELECT * FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            dataset = cur.fetchone()
            if not dataset:
                raise HTTPException(status_code=404, detail="Dataset not found")

            project_id = dataset.get("project_id")
            # Resolve the country from the project itself so ingest writes rows
            # (project_site, …) under the project's real owner — not the stale
            # env default that the dataset may have been registered with.
            country_id = (_project_country_id(cur, project_id)
                          or dataset.get("country_id")
                          or _instance_country_code(cur))
            epsg = dataset.get("cords_epsg") or "4326"

            # A licence is required — supplied now, or already on the project's
            # stub mapset from a previous ingest. (Belt-and-braces alongside the
            # validate-time check, in case a licence was cleared after Validate.)
            if not (license_val or "").strip():
                cur.execute("SELECT other_constraints FROM soil_data.mapset WHERE mapset_id = %s",
                            (f"{country_id}-{project_id}",))
                _lr = cur.fetchone()
                if not (_lr and (_lr.get("other_constraints") or "").strip()):
                    raise HTTPException(
                        status_code=400,
                        detail="A licence is required before ingesting. Select a licence and try again.")

            # Get column mappings (non-ignored)
            cur.execute("""
                SELECT column_name, destination_table, destination_column,
                       property_num_id, procedure_num_id, unit_of_measure_id
                FROM api.uploaded_dataset_column
                WHERE table_name = %s AND (ignore_column = false OR destination_table IS NOT NULL)
            """, (table_name,))
            mappings = cur.fetchall()

            if not mappings:
                raise HTTPException(status_code=400, detail="No column mappings defined")

            # Build lookup: destination_table.destination_column → csv_column_name (and extras)
            # For result_num, use csv column name as key since multiple columns map to "value"
            col_map = {}  # {dest_table: {key: {csv_col, prop, proc, unit}}}
            for m in mappings:
                dt = m["destination_table"]
                if not dt:
                    continue
                if dt not in col_map:
                    col_map[dt] = {}
                key = m["column_name"] if dt == "result_num" else (m["destination_column"] or "value")
                col_map[dt][key] = {
                    "csv_col": m["column_name"],
                    "property_num_id": m.get("property_num_id"),
                    "procedure_num_id": m.get("procedure_num_id"),
                    "unit_of_measure_id": m.get("unit_of_measure_id"),
                }

            # Read all rows from staging table (stable order by _row_id)
            cur.execute(pgsql.SQL("SELECT * FROM {}.{} ORDER BY _row_id").format(
                pgsql.Identifier("soil_data_upload"),
                pgsql.Identifier(table_name)
            ))
            rows = cur.fetchall()

            if not rows:
                raise HTTPException(status_code=400, detail="No data rows in staging table")

            # Helper to get a value from a row via mapping
            def get_val(row, table, col):
                info = col_map.get(table, {}).get(col)
                if not info:
                    return None
                v = row.get(info["csv_col"])
                if v is None or v == "":
                    return None
                return v

            # Caches to avoid duplicate inserts
            sites_inserted = set()
            project_sites_inserted = set()
            plots_cache = {}       # (site_id, plot_code) → plot_id
            profiles_cache = {}    # profile_code → profile_id
            elements_cache = {}    # (profile_id, upper, lower) → element_id
            specimens_cache = {}   # element_id → specimen_id
            obs_num_cache = {}     # (prop, proc) → (observation_num_id, canonical_unit)
            unit_conv_cache = {}   # (source_unit, canonical_unit) → {operation, value} or None

            ingested = 0
            # Distinct (observation, specimen) pairs written — the result_num
            # insert is an upsert, so counting attempts would double-count CSV
            # rows that overwrite the same measurement.
            result_keys = set()
            errors = []

            if not project_id:
                raise HTTPException(status_code=400, detail="Project is required for ingest")

            # Ensure the site for this project exists (site_id = project_id)
            site_id = project_id
            cur.execute("""
                INSERT INTO soil_data.site (site_id) VALUES (%s)
                ON CONFLICT (site_id) DO NOTHING
            """, (site_id,))
            cur.execute("""
                INSERT INTO soil_data.project_site (country_id, project_id, site_id)
                VALUES (%s, %s, %s) ON CONFLICT DO NOTHING
            """, (country_id, project_id, site_id))

            # Ensure a stub mapset + layer exists for this project so the
            # Soil profiles tab can hang policy fields (is_published,
            # profile_limit, spatial_blur_m) off them. ID convention:
            #   mapset_id == layer_id == <CC>-<PROJ>
            stub_id = f"{country_id}-{project_id}"
            cur.execute("""
                INSERT INTO soil_data.mapset
                    (country_id, project_id, mapped_property_id, mapset_id,
                     keyword_theme, keyword_place, costum_group, title,
                     spatial_representation_type_code)
                VALUES (%s, %s, NULL, %s, ARRAY['soil profile'],
                        (SELECT ARRAY_REMOVE(ARRAY[un_reg, en], NULL)
                         FROM soil_data.country
                         WHERE country_id = (SELECT value FROM api.setting WHERE key='COUNTRY_CODE')),
                        %s,
                        (SELECT name FROM soil_data.project
                         WHERE country_id = %s AND project_id = %s),
                        'vector')
                ON CONFLICT (mapset_id) DO UPDATE SET
                    keyword_theme = COALESCE(EXCLUDED.keyword_theme,
                                             soil_data.mapset.keyword_theme),
                    keyword_place = COALESCE(EXCLUDED.keyword_place,
                                             soil_data.mapset.keyword_place),
                    costum_group  = COALESCE(EXCLUDED.costum_group,
                                             soil_data.mapset.costum_group),
                    title         = COALESCE(EXCLUDED.title,
                                             soil_data.mapset.title),
                    spatial_representation_type_code = 'vector'
            """, (country_id, project_id, stub_id, project_id,
                  country_id, project_id))
            # file_orig_name has NOT NULL + UNIQUE — use the stub_id as a
            # placeholder so each stub row gets a unique non-null value.
            # costum_name mirrors soil_data.project.name (same source the
            # stub mapset's title uses).
            cur.execute("""
                INSERT INTO soil_data.layer
                    (mapset_id, layer_id, file_path, is_published, file_orig_name, costum_name)
                VALUES (%s, %s, '', TRUE, %s,
                        (SELECT name FROM soil_data.project
                         WHERE country_id = %s AND project_id = %s))
                ON CONFLICT (layer_id) DO UPDATE SET
                    costum_name = COALESCE(EXCLUDED.costum_name,
                                           soil_data.layer.costum_name)
            """, (stub_id, stub_id, f"(stub) {stub_id}", country_id, project_id))
            sites_inserted.add(site_id)
            project_sites_inserted.add((project_id, site_id))

            for i, row in enumerate(rows):
                row_num = i + 2  # 1-based + header
                try:
                    # --- plot ---
                    plot_id = None
                    plot_code = None
                    if "plot" in col_map:
                        plot_code = get_val(row, "plot", "plot_code")
                        lon = get_val(row, "plot", "geom (longitude)")
                        lat = get_val(row, "plot", "geom (latitude)")
                        plot_type = get_val(row, "plot", "type")
                        altitude = get_val(row, "plot", "altitude")
                        sampling_date = get_val(row, "plot", "sampling_date")
                        pos_accuracy = get_val(row, "plot", "positional_accuracy")

                        cache_key = plot_code or f"_row{i}"
                        if plot_code and cache_key in plots_cache:
                            plot_id = plots_cache[cache_key]
                        else:
                            geom_expr = None
                            geom_params = []
                            if lon and lat:
                                geom_expr = "ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), %s), 4326)"
                                geom_params = [float(lon), float(lat), int(epsg)]

                            # plot_code is a real-world label, not an identifier
                            # (rows are identified by plot_id, and equal codes can
                            # legitimately occur in different projects). Reuse an
                            # existing plot only within this project's site —
                            # never match by code across the whole table.
                            existing_plot = None
                            if plot_code:
                                cur.execute("""
                                    SELECT plot_id FROM soil_data.plot
                                    WHERE site_id = %s AND plot_code = %s
                                """, (site_id, plot_code))
                                existing_plot = cur.fetchone()

                            if existing_plot:
                                plot_id = existing_plot["plot_id"]
                                geom_set = f"geom = {geom_expr}," if geom_expr else ""
                                cur.execute(f"""
                                    UPDATE soil_data.plot SET
                                        {geom_set}
                                        type = COALESCE(%s, type),
                                        altitude = COALESCE(%s, altitude),
                                        sampling_date = COALESCE(%s, sampling_date),
                                        positional_accuracy = COALESCE(%s, positional_accuracy),
                                        csv = COALESCE(csv, %s)
                                    WHERE plot_id = %s
                                """, (*geom_params, plot_type,
                                      int(altitude) if altitude else None,
                                      sampling_date or None,
                                      int(pos_accuracy) if pos_accuracy else None,
                                      table_name, plot_id))
                            else:
                                geom_col = ", geom" if geom_expr else ""
                                geom_val = f", {geom_expr}" if geom_expr else ""
                                cur.execute(f"""
                                    INSERT INTO soil_data.plot
                                        (site_id, plot_code, type, altitude, sampling_date, positional_accuracy, csv{geom_col})
                                    VALUES (%s, %s, %s, %s, %s, %s, %s{geom_val})
                                    RETURNING plot_id
                                """, (site_id, plot_code, plot_type,
                                      int(altitude) if altitude else None,
                                      sampling_date or None,
                                      int(pos_accuracy) if pos_accuracy else None,
                                      table_name, *geom_params))
                                plot_id = cur.fetchone()["plot_id"]
                            if plot_code:
                                plots_cache[cache_key] = plot_id

                    # --- profile (profile_code = plot_code) ---
                    profile_id = None
                    if plot_id and plot_code:
                        if plot_code in profiles_cache:
                            profile_id = profiles_cache[plot_code]
                        else:
                            # profile_code is a label like plot_code — a profile
                            # is only reused when it belongs to this very plot.
                            cur.execute("""
                                SELECT profile_id FROM soil_data.profile
                                WHERE plot_id = %s AND profile_code = %s
                            """, (plot_id, plot_code))
                            existing_profile = cur.fetchone()
                            if existing_profile:
                                profile_id = existing_profile["profile_id"]
                            else:
                                cur.execute("""
                                    INSERT INTO soil_data.profile (plot_id, profile_code)
                                    VALUES (%s, %s)
                                    RETURNING profile_id
                                """, (plot_id, plot_code))
                                profile_id = cur.fetchone()["profile_id"]
                            profiles_cache[plot_code] = profile_id

                    # --- element ---
                    element_id = None
                    if "element" in col_map and profile_id:
                        upper = get_val(row, "element", "upper_depth")
                        lower = get_val(row, "element", "lower_depth")
                        elem_type = get_val(row, "element", "type") or "Layer"
                        horizon = get_val(row, "element", "horizon")
                        if upper is not None and lower is not None:
                            upper_i = int(float(upper))
                            lower_i = int(float(lower))
                            elem_key = (profile_id, upper_i, lower_i)
                            if elem_key in elements_cache:
                                element_id = elements_cache[elem_key]
                            else:
                                cur.execute("""
                                    INSERT INTO soil_data.element (profile_id, upper_depth, lower_depth, type, horizon)
                                    VALUES (%s, %s, %s, %s, %s)
                                    RETURNING element_id
                                """, (profile_id, upper_i, lower_i, elem_type, horizon))
                                element_id = cur.fetchone()["element_id"]
                                elements_cache[elem_key] = element_id

                    # --- specimen (auto-create per element) ---
                    specimen_id = None
                    if element_id:
                        if element_id in specimens_cache:
                            specimen_id = specimens_cache[element_id]
                        else:
                            cur.execute("""
                                INSERT INTO soil_data.specimen (element_id)
                                VALUES (%s) RETURNING specimen_id
                            """, (element_id,))
                            specimen_id = cur.fetchone()["specimen_id"]
                            specimens_cache[element_id] = specimen_id

                    # --- result_num (one per result_num-mapped column) ---
                    if "result_num" in col_map and specimen_id:
                        for dest_col, info in col_map["result_num"].items():
                            prop_id = info.get("property_num_id")
                            proc_id = info.get("procedure_num_id")
                            source_unit = info.get("unit_of_measure_id")
                            if not prop_id or not proc_id:
                                continue

                            # Get observation_num_id and its canonical unit
                            obs_key = (prop_id, proc_id)
                            if obs_key in obs_num_cache:
                                obs_num_id, canonical_unit = obs_num_cache[obs_key]
                            else:
                                cur.execute("""
                                    SELECT observation_num_id, unit_of_measure_id
                                    FROM soil_data.observation_num
                                    WHERE property_num_id = %s AND procedure_num_id = %s
                                """, (prop_id, proc_id))
                                obs_row = cur.fetchone()
                                if not obs_row:
                                    # No observation_num exists — fall back to the source unit as canonical
                                    cur.execute("""
                                        INSERT INTO soil_data.observation_num
                                            (property_num_id, procedure_num_id, unit_of_measure_id)
                                        VALUES (%s, %s, %s)
                                        RETURNING observation_num_id, unit_of_measure_id
                                    """, (prop_id, proc_id, source_unit or "Unknown"))
                                    obs_row = cur.fetchone()
                                obs_num_id = obs_row["observation_num_id"]
                                canonical_unit = obs_row["unit_of_measure_id"]
                                obs_num_cache[obs_key] = (obs_num_id, canonical_unit)

                            # Resolve conversion (source -> canonical) once per pair
                            if source_unit and canonical_unit and source_unit != canonical_unit:
                                conv_key = (source_unit, canonical_unit)
                                if conv_key in unit_conv_cache:
                                    conv = unit_conv_cache[conv_key]
                                else:
                                    cur.execute("""
                                        SELECT operation, value FROM soil_data.unit_conversion
                                        WHERE unit_from = %s AND unit_to = %s
                                    """, (source_unit, canonical_unit))
                                    conv = cur.fetchone()
                                    unit_conv_cache[conv_key] = conv
                            else:
                                conv = None  # no conversion needed

                            raw_val = row.get(info["csv_col"])
                            if raw_val is None or raw_val == "":
                                continue
                            try:
                                val = float(raw_val)
                            except (ValueError, TypeError):
                                continue
                            if conv:
                                cv = float(conv["value"])
                                if conv["operation"] == "*":
                                    val = val * cv
                                elif conv["operation"] == "/":
                                    val = val / cv

                            cur.execute("""
                                INSERT INTO soil_data.result_num (observation_num_id, specimen_id, value)
                                VALUES (%s, %s, %s)
                                ON CONFLICT (observation_num_id, specimen_id)
                                DO UPDATE SET value = EXCLUDED.value
                            """, (obs_num_id, specimen_id, val))
                            result_keys.add((obs_num_id, specimen_id))

                    ingested += 1

                except Exception as e:
                    errors.append(f"Row {row_num}: {str(e)}")
                    if len(errors) > 50:
                        errors.append("... too many errors, stopping")
                        break

            # Update the stub mapset's catalogue fields from the data we
            # just ingested:
            #   abstract            ← soil_data.project.description
            #   other_constraints   ← license picked in the ETL form
            #   creation_date       ← max(plot.sampling_date) for this csv
            #   revision_date       ← CURRENT_DATE
            #   publication_date    ← CURRENT_DATE
            #   time_period_begin   ← min(plot.sampling_date)
            #   time_period_end     ← max(plot.sampling_date)
            cur.execute("""
                UPDATE soil_data.mapset m
                SET
                  abstract          = COALESCE(p.description, m.abstract),
                  other_constraints = COALESCE(%s, m.other_constraints),
                  publication_date  = CURRENT_DATE,
                  revision_date     = CURRENT_DATE,
                  creation_date     = COALESCE(d.max_date, m.creation_date),
                  time_period_begin = COALESCE(d.min_date, m.time_period_begin),
                  time_period_end   = COALESCE(d.max_date, m.time_period_end)
                FROM soil_data.project p,
                     (SELECT MIN(sampling_date) AS min_date,
                             MAX(sampling_date) AS max_date
                      FROM soil_data.plot WHERE csv = %s) d
                WHERE m.mapset_id = %s
                  AND p.country_id = m.country_id AND p.project_id = m.project_id
            """, (license_val, table_name, stub_id))

            # Stub layer geometry-derived fields. The plot points just
            # inserted carry an SRID — copy that to the layer, plus the
            # native extent and a WGS84 bbox for the catalogue's
            # gmd:EX_GeographicBoundingBox.
            cur.execute("""
                UPDATE soil_data.layer l
                SET
                  reference_system_identifier_code = b.epsg::text,
                  spatial_reference  = 'EPSG:' || b.epsg::text,
                  extent             = b.extent_native,
                  west_bound_longitude = b.minx,
                  east_bound_longitude = b.maxx,
                  south_bound_latitude = b.miny,
                  north_bound_latitude = b.maxy,
                  distribution_format  = 'PostGIS',
                  file_size            = pg_total_relation_size(('soil_data_upload.' || %s)::regclass),
                  file_size_pretty     = pg_size_pretty(pg_total_relation_size(('soil_data_upload.' || %s)::regclass)),
                  file_orig_name       = COALESCE(
                                            (SELECT file_name FROM api.uploaded_dataset
                                             WHERE table_name = %s),
                                            l.file_orig_name),
                  file_path            = 'soil_data_upload.' || %s
                FROM (
                  SELECT
                    MIN(ST_SRID(geom)) AS epsg,
                    ST_XMin(ST_Extent(geom))::text || ' ' ||
                    ST_YMin(ST_Extent(geom))::text || ' ' ||
                    ST_XMax(ST_Extent(geom))::text || ' ' ||
                    ST_YMax(ST_Extent(geom))::text AS extent_native,
                    ST_XMin(ST_Extent(ST_Transform(geom, 4326))) AS minx,
                    ST_XMax(ST_Extent(ST_Transform(geom, 4326))) AS maxx,
                    ST_YMin(ST_Extent(ST_Transform(geom, 4326))) AS miny,
                    ST_YMax(ST_Extent(ST_Transform(geom, 4326))) AS maxy
                  FROM soil_data.plot
                  WHERE csv = %s AND geom IS NOT NULL
                ) b
                WHERE l.layer_id = %s AND b.epsg IS NOT NULL
            """, (table_name, table_name, table_name, table_name, table_name, stub_id))

            # Render ISO 19139 XML for the stub mapset and load into pyCSW.
            # render_xml handles vector vs grid (spatialResolution omitted
            # for vector point datasets). Best-effort: catalogue failures
            # shouldn't roll back the data ingest.
            try:
                from raster_registry.xml_render import render_xml as _render_xml
                from raster_registry.pycsw_load import write_xml_and_load as _write_xml_and_load
                xml_content = _render_xml(conn, stub_id)
                _write_xml_and_load(stub_id, xml_content)
            except Exception as e:
                log.warning("ETL xml/pycsw publish failed for %s: %s", stub_id, e)

            # Update dataset status and note
            status = "Ingested" if not errors else "Partial"
            result_num_count = len(result_keys)
            profile_count = len(profiles_cache)
            property_count = len({prop for (prop, _proc) in obs_num_cache.keys()})
            note = (
                f"Ingested {ingested}/{len(rows)} CSV rows, "
                f"{profile_count} profiles, "
                f"{property_count} soil properties, "
                f"{result_num_count} measurements"
            )
            if errors:
                note += f", {len(errors)} errors"
            cur.execute("""
                UPDATE api.uploaded_dataset
                SET status = %s, note = %s, ingestion_date = CURRENT_DATE
                WHERE table_name = %s
            """, (status, note, table_name))

            log_audit(current_user['user_id'], None, "etl_ingested",
                     {"table_name": table_name, "ingested": ingested, "errors": len(errors)}, None)

            return {
                "message": note,
                "ingested": ingested,
                "total": len(rows),
                "result_num_count": result_num_count,
                "errors": errors
            }


class CellEdit(BaseModel):
    row_id: int
    column: str
    value: Optional[str] = None

class CellEditBatch(BaseModel):
    edits: List[CellEdit]


@app.patch("/api/etl/datasets/{table_name}/cells")
async def edit_dataset_cells(
    table_name: str,
    batch: CellEditBatch,
    current_user: dict = Depends(get_current_user)
):
    """Edit one or more cells in a staging table. Writes to api.uploaded_dataset_edit for audit."""
    if not batch.edits:
        return {"updated": 0, "errors": []}

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Validate dataset exists
            cur.execute("SELECT 1 FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Dataset not found")

            # Load valid column names for this dataset (prevents injection via column param)
            cur.execute(
                "SELECT column_name FROM api.uploaded_dataset_column WHERE table_name = %s",
                (table_name,)
            )
            valid_cols = {r["column_name"] for r in cur.fetchall()}

            updated = 0
            errors = []
            for edit in batch.edits:
                if edit.column not in valid_cols:
                    errors.append(f"row {edit.row_id}: unknown column '{edit.column}'")
                    continue
                # Capture old value for audit
                cur.execute(
                    pgsql.SQL("SELECT {} AS v FROM {}.{} WHERE _row_id = %s").format(
                        pgsql.Identifier(edit.column),
                        pgsql.Identifier("soil_data_upload"),
                        pgsql.Identifier(table_name),
                    ),
                    (edit.row_id,)
                )
                old = cur.fetchone()
                if not old:
                    errors.append(f"row {edit.row_id}: not found")
                    continue
                old_value = old["v"]

                cur.execute(
                    pgsql.SQL("UPDATE {}.{} SET {} = %s WHERE _row_id = %s").format(
                        pgsql.Identifier("soil_data_upload"),
                        pgsql.Identifier(table_name),
                        pgsql.Identifier(edit.column),
                    ),
                    (edit.value, edit.row_id)
                )
                if cur.rowcount:
                    updated += 1
                    cur.execute("""
                        INSERT INTO api.uploaded_dataset_edit
                            (table_name, row_id, column_name, old_value, new_value, user_id)
                        VALUES (%s, %s, %s, %s, %s, %s)
                    """, (table_name, edit.row_id, edit.column, old_value, edit.value,
                          current_user['user_id']))

            log_audit(current_user['user_id'], None, "etl_cells_edited",
                     {"table_name": table_name, "updated": updated, "errors": len(errors)}, None)

            return {"updated": updated, "errors": errors}


@app.post("/api/etl/datasets/{table_name}/validate")
async def validate_dataset(
    table_name: str,
    payload: Optional[dict] = None,
    current_user: dict = Depends(get_current_user)
):
    """Validate CSV values against destination column datatypes and check constraints.
    Saves per-column result in api.uploaded_dataset_column.validation.

    Optional JSON body: { "license": "<...>" } — a licence must be chosen for
    validation to pass (it becomes the dataset's mapset licence at ingest).
    """
    # Datatype + constraint rules per (dest_table, dest_column)
    # kind: int | smallint | real | date | enum | text
    RULES = {
        ("plot", "type"):                {"kind": "enum", "values": ["TrialPit", "Borehole"]},
        ("plot", "altitude"):            {"kind": "smallint"},
        ("plot", "positional_accuracy"): {"kind": "smallint"},
        ("plot", "sampling_date"):       {"kind": "date"},
        ("plot", "geom (longitude)"):    {"kind": "real", "min": -180, "max": 180},
        ("plot", "geom (latitude)"):     {"kind": "real", "min": -90, "max": 90},
        ("element", "upper_depth"):      {"kind": "int", "min": 0, "max": 1000},
        ("element", "lower_depth"):      {"kind": "int", "min": 0},
        ("element", "type"):             {"kind": "enum", "values": ["Horizon", "Layer"]},
    }
    # Destinations that must be mapped at least once (label, table, column)
    REQUIRED_DESTINATIONS = [
        ("Profile code",   "plot",       "plot_code"),
        ("Longitude",      "plot",       "geom (longitude)"),
        ("Latitude",       "plot",       "geom (latitude)"),
        ("Sampling date",  "plot",       "sampling_date"),
        ("Upper depth",    "element",    "upper_depth"),
        ("Lower depth",    "element",    "lower_depth"),
        ("Soil property",  "result_num", "value"),
    ]
    SMALLINT_MIN, SMALLINT_MAX = -32768, 32767

    def check_value(v, rule):
        """Return None if valid, else error description."""
        if v is None or v == "":
            return None  # empty cells are allowed at validation stage
        kind = rule["kind"]
        if kind in ("int", "smallint"):
            try:
                n = int(float(v))
            except (ValueError, TypeError):
                return f"'{v}' not an integer"
            if kind == "smallint" and not (SMALLINT_MIN <= n <= SMALLINT_MAX):
                return f"{n} out of smallint range"
            if "min" in rule and n < rule["min"]:
                return f"{n} < {rule['min']}"
            if "max" in rule and n > rule["max"]:
                return f"{n} > {rule['max']}"
            return None
        if kind == "real":
            try:
                n = float(v)
            except (ValueError, TypeError):
                return f"'{v}' not a number"
            if "min" in rule and n < rule["min"]:
                return f"{n} < {rule['min']}"
            if "max" in rule and n > rule["max"]:
                return f"{n} > {rule['max']}"
            return None
        if kind == "date":
            try:
                datetime.strptime(str(v), "%Y-%m-%d")
            except (ValueError, TypeError):
                return f"'{v}' not a date (YYYY-MM-DD)"
            return None
        if kind == "enum":
            if v not in rule["values"]:
                return f"'{v}' not in {rule['values']}"
            return None
        return None

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Dataset exists?
            cur.execute("SELECT table_name FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Dataset not found")

            # Load mappings
            cur.execute("""
                SELECT column_name, destination_table, destination_column,
                       property_num_id, procedure_num_id, unit_of_measure_id
                FROM api.uploaded_dataset_column
                WHERE table_name = %s AND destination_table IS NOT NULL
            """, (table_name,))
            mappings = cur.fetchall()

            if not mappings:
                raise HTTPException(status_code=400, detail="No column mappings defined")

            # Load staging rows (ordered by _row_id for stable row numbers)
            cur.execute(pgsql.SQL("SELECT * FROM {}.{} ORDER BY _row_id").format(
                pgsql.Identifier("soil_data_upload"),
                pgsql.Identifier(table_name)
            ))
            rows = cur.fetchall()

            # Preload value_min/max + canonical unit for result_num mappings
            obs_bounds = {}  # (prop_id, proc_id) -> (min, max, canonical_unit)
            for m in mappings:
                if m["destination_table"] == "result_num" and m["property_num_id"] and m["procedure_num_id"]:
                    key = (m["property_num_id"], m["procedure_num_id"])
                    if key not in obs_bounds:
                        cur.execute("""
                            SELECT value_min, value_max, unit_of_measure_id
                            FROM soil_data.observation_num
                            WHERE property_num_id = %s AND procedure_num_id = %s
                        """, key)
                        r = cur.fetchone()
                        obs_bounds[key] = (
                            (r["value_min"], r["value_max"], r["unit_of_measure_id"]) if r else (None, None, None)
                        )

            # Conversion lookup cache: (source_unit, canonical_unit) -> {operation, value} or None
            unit_conv_cache = {}
            def get_conversion(source, canonical):
                if not source or not canonical or source == canonical:
                    return None
                k = (source, canonical)
                if k in unit_conv_cache:
                    return unit_conv_cache[k]
                cur.execute("""
                    SELECT operation, value FROM soil_data.unit_conversion
                    WHERE unit_from = %s AND unit_to = %s
                """, (source, canonical))
                conv = cur.fetchone()
                unit_conv_cache[k] = conv
                return conv

            def convert_value(n, conv):
                if not conv:
                    return n
                cv = float(conv["value"])
                if conv["operation"] == "*":
                    return n * cv
                if conv["operation"] == "/":
                    return n / cv
                return n

            # Validate each mapped column
            col_results = {}  # csv_col -> {"status", "errors", "error_rows"}
            upper_col = None
            lower_col = None

            MAX_DISPLAY = 10

            for m in mappings:
                csv_col = m["column_name"]
                dt = m["destination_table"]
                dc = m["destination_column"]
                errors = []
                error_rows = set()
                truncated = False

                if dt == "element" and dc == "upper_depth":
                    upper_col = csv_col
                if dt == "element" and dc == "lower_depth":
                    lower_col = csv_col

                rule = RULES.get((dt, dc))
                if rule:
                    for row in rows:
                        rid = row["_row_id"]
                        err = check_value(row.get(csv_col), rule)
                        if err:
                            error_rows.add(rid)
                            if len(errors) < MAX_DISPLAY:
                                errors.append(f"row {rid}: {err}")
                            else:
                                truncated = True

                data_min = None
                data_max = None
                if dt == "result_num":
                    missing_meta = []
                    if not m.get("property_num_id"):    missing_meta.append("property")
                    if not m.get("procedure_num_id"):   missing_meta.append("procedure")
                    if not m.get("unit_of_measure_id"): missing_meta.append("unit")
                    if missing_meta:
                        errors.append("missing " + ", ".join(missing_meta))
                        # mark every populated row so the user can see this column failed overall
                        for row in rows:
                            v = row.get(csv_col)
                            if v is not None and v != "":
                                error_rows.add(row["_row_id"])
                    bounds = obs_bounds.get((m["property_num_id"], m["procedure_num_id"]), (None, None, None))
                    vmin, vmax, canonical_unit = bounds
                    source_unit = m.get("unit_of_measure_id")
                    conv = get_conversion(source_unit, canonical_unit)
                    for row in rows:
                        rid = row["_row_id"]
                        v = row.get(csv_col)
                        if v is None or v == "":
                            continue
                        try:
                            n = float(v)
                        except (ValueError, TypeError):
                            error_rows.add(rid)
                            if len(errors) < MAX_DISPLAY:
                                errors.append(f"row {rid}: '{v}' not a number")
                            else:
                                truncated = True
                            continue
                        n = convert_value(n, conv)
                        # Track the actual data range so the popup can show
                        # how close to the bounds the user's values are.
                        data_min = n if data_min is None else min(data_min, n)
                        data_max = n if data_max is None else max(data_max, n)
                        if vmin is not None and n < vmin:
                            error_rows.add(rid)
                            if len(errors) < MAX_DISPLAY:
                                errors.append(f"row {rid}: {n} < {vmin}")
                            else:
                                truncated = True
                        elif vmax is not None and n > vmax:
                            error_rows.add(rid)
                            if len(errors) < MAX_DISPLAY:
                                errors.append(f"row {rid}: {n} > {vmax}")
                            else:
                                truncated = True

                if truncated:
                    errors.append("...")

                entry = {
                    "status": "OK" if not error_rows else "ERROR",
                    "errors": errors,
                    "error_rows": sorted(error_rows),
                }
                # For Soil-property columns, surface the bounds that were applied
                # so the popup can display them — also a sanity check for the user
                # that the validator actually consulted observation_num.
                if dt == "result_num":
                    bounds = obs_bounds.get((m["property_num_id"], m["procedure_num_id"]), (None, None, None))
                    vmin, vmax, canonical_unit = bounds
                    source_unit = m.get("unit_of_measure_id")
                    conv = get_conversion(source_unit, canonical_unit)
                    entry["applied_bounds"] = {
                        "vmin": vmin,
                        "vmax": vmax,
                        "canonical_unit": canonical_unit,
                        "source_unit": source_unit,
                        "conversion": (
                            {"operation": conv["operation"], "value": float(conv["value"])}
                            if conv else None
                        ),
                        "data_min": data_min,
                        "data_max": data_max,
                    }
                col_results[csv_col] = entry

            # Cross-column: upper_depth < lower_depth
            if upper_col and lower_col:
                depth_errors = []
                depth_rows = set()
                truncated = False
                for row in rows:
                    rid = row["_row_id"]
                    u = row.get(upper_col)
                    l = row.get(lower_col)
                    if u in (None, "") or l in (None, ""):
                        continue
                    try:
                        ui = int(float(u)); li = int(float(l))
                    except (ValueError, TypeError):
                        continue
                    if ui >= li:
                        depth_rows.add(rid)
                        if len(depth_errors) < MAX_DISPLAY:
                            depth_errors.append(f"row {rid}: upper {ui} >= lower {li}")
                        else:
                            truncated = True
                if truncated:
                    depth_errors.append("...")
                if depth_rows:
                    for c in (upper_col, lower_col):
                        r = col_results.setdefault(c, {"status": "OK", "errors": [], "error_rows": []})
                        r["errors"].extend(depth_errors)
                        merged = set(r["error_rows"]) | depth_rows
                        r["error_rows"] = sorted(merged)
                        r["status"] = "ERROR"

            # Layer continuity per profile: when sorted by upper_depth, each
            # layer's lower_depth must equal the next layer's upper_depth.
            # E.g. 0–5, 5–34, 34–67, 67–88 is contiguous; 0–5, 10–30 has a gap;
            # 0–30, 20–50 overlaps. Both fail this check.
            profile_code_col_for_chain = next((m["column_name"] for m in mappings
                                               if m["destination_table"] == "plot"
                                               and m["destination_column"] == "plot_code"), None)
            if profile_code_col_for_chain and upper_col and lower_col:
                by_profile = {}   # profile_code → list of (rid, upper, lower)
                for row in rows:
                    rid = row["_row_id"]
                    code = row.get(profile_code_col_for_chain)
                    u = row.get(upper_col)
                    l = row.get(lower_col)
                    if not code or u in (None, "") or l in (None, ""):
                        continue
                    try:
                        ui = int(float(u)); li = int(float(l))
                    except (ValueError, TypeError):
                        continue
                    if ui >= li:  # malformed layer — already flagged above
                        continue
                    by_profile.setdefault(code, []).append((rid, ui, li))

                gap_rows = set()
                gap_msgs = []
                truncated = False
                for code, layers in by_profile.items():
                    layers.sort(key=lambda t: (t[1], t[2]))
                    for i in range(len(layers) - 1):
                        _, _, prev_lower = layers[i]
                        cur_rid, cur_upper, _ = layers[i + 1]
                        if cur_upper != prev_lower:
                            gap_rows.add(cur_rid)
                            if len(gap_msgs) < MAX_DISPLAY:
                                gap_msgs.append(
                                    f"row {cur_rid}: profile_code '{code}' upper "
                                    f"{cur_upper} ≠ previous layer's lower {prev_lower}"
                                )
                            else:
                                truncated = True
                if truncated:
                    gap_msgs.append("...")
                if gap_rows:
                    for c in (profile_code_col_for_chain, upper_col, lower_col):
                        r = col_results.setdefault(c, {"status": "OK", "errors": [], "error_rows": []})
                        r["errors"].extend(gap_msgs)
                        r["error_rows"] = sorted(set(r["error_rows"]) | gap_rows)
                        r["status"] = "ERROR"

            # Profile-code consistency: rows sharing a profile_code must agree
            # on Longitude and Latitude. The first occurrence of each
            # profile_code defines the canonical coords; subsequent occurrences
            # with different values are flagged.
            # (At ingest, profile_code is set equal to the value mapped to
            # plot.plot_code — which is what the "Profile code" destination
            # writes — so we look that mapping up here.)
            profile_code_col = next((m["column_name"] for m in mappings
                                     if m["destination_table"] == "plot"
                                     and m["destination_column"] == "plot_code"), None)
            tmp_lon_col = next((m["column_name"] for m in mappings
                                if m["destination_table"] == "plot"
                                and m["destination_column"] == "geom (longitude)"), None)
            tmp_lat_col = next((m["column_name"] for m in mappings
                                if m["destination_table"] == "plot"
                                and m["destination_column"] == "geom (latitude)"), None)
            if profile_code_col and tmp_lon_col and tmp_lat_col:
                first_seen = {}      # profile_code → (rid, lon, lat) of first row with valid coords
                bad_rows = set()
                bad_msgs = []
                truncated = False
                for row in rows:
                    rid = row["_row_id"]
                    code = row.get(profile_code_col)
                    lon_v = row.get(tmp_lon_col)
                    lat_v = row.get(tmp_lat_col)
                    if not code or lon_v in (None, "") or lat_v in (None, ""):
                        continue
                    try:
                        lon_f = float(lon_v); lat_f = float(lat_v)
                    except (ValueError, TypeError):
                        continue
                    if code not in first_seen:
                        first_seen[code] = (rid, lon_f, lat_f)
                    else:
                        first_rid, first_lon, first_lat = first_seen[code]
                        if lon_f != first_lon or lat_f != first_lat:
                            bad_rows.add(rid)
                            if len(bad_msgs) < MAX_DISPLAY:
                                bad_msgs.append(
                                    f"row {rid}: profile_code '{code}' coords "
                                    f"({lon_f}, {lat_f}) differ from row {first_rid} "
                                    f"({first_lon}, {first_lat})"
                                )
                            else:
                                truncated = True
                if truncated:
                    bad_msgs.append("...")
                if bad_rows:
                    for c in (profile_code_col, tmp_lon_col, tmp_lat_col):
                        r = col_results.setdefault(c, {"status": "OK", "errors": [], "error_rows": []})
                        r["errors"].extend(bad_msgs)
                        r["error_rows"] = sorted(set(r["error_rows"]) | bad_rows)
                        r["status"] = "ERROR"

            # Country-bounds check: at least 95% of (lon, lat) points must
            # fall inside the country's convex hull. Country code comes from
            # api.setting.COUNTRY_CODE; convex hull comes from
            # soil_data.country.geom_convexhull (SRID 4326).
            country_bounds = {"checked": False}
            lon_col = next((m["column_name"] for m in mappings
                            if m["destination_table"] == "plot"
                            and m["destination_column"] == "geom (longitude)"), None)
            lat_col = next((m["column_name"] for m in mappings
                            if m["destination_table"] == "plot"
                            and m["destination_column"] == "geom (latitude)"), None)
            if lon_col and lat_col:
                cur.execute("SELECT value FROM api.setting WHERE key = 'COUNTRY_CODE'")
                cc_row = cur.fetchone()
                country_code = cc_row["value"].strip() if cc_row and cc_row["value"] else None
                if country_code:
                    cur.execute("""
                        SELECT geom_convexhull IS NOT NULL AS has_hull
                        FROM soil_data.country WHERE country_id = %s
                    """, (country_code,))
                    h = cur.fetchone()
                    if h and h["has_hull"]:
                        # Get the dataset's source EPSG so we can transform
                        # CSV coordinates to 4326 (matching the convex hull).
                        cur.execute("SELECT cords_epsg FROM api.uploaded_dataset WHERE table_name = %s",
                                    (table_name,))
                        ds_row = cur.fetchone()
                        try:
                            source_epsg = int((ds_row or {}).get("cords_epsg") or 4326)
                        except (TypeError, ValueError):
                            source_epsg = 4326

                        # Collect numeric (rid, lon, lat) tuples from the staging rows
                        rids, lons, lats = [], [], []
                        for row in rows:
                            lon_v, lat_v = row.get(lon_col), row.get(lat_col)
                            if lon_v in (None, "") or lat_v in (None, ""):
                                continue
                            try:
                                lons.append(float(lon_v))
                                lats.append(float(lat_v))
                                rids.append(int(row["_row_id"]))
                            except (ValueError, TypeError):
                                continue

                        if rids:
                            cur.execute("""
                                WITH points AS (
                                    SELECT t.rid,
                                           ST_Transform(
                                             ST_SetSRID(ST_MakePoint(t.lon, t.lat), %s),
                                             4326
                                           ) AS p
                                    FROM unnest(%s::int[], %s::float8[], %s::float8[])
                                         AS t(rid, lon, lat)
                                )
                                SELECT p.rid
                                FROM points p, soil_data.country c
                                WHERE c.country_id = %s
                                  AND NOT ST_Contains(c.geom_convexhull, p.p)
                            """, (source_epsg, rids, lons, lats, country_code))
                            outside = sorted(int(r["rid"]) for r in cur.fetchall())
                            inside = len(rids) - len(outside)
                            pct = (inside / len(rids)) * 100.0 if rids else 0.0
                            ok = pct >= 95.0
                            country_bounds = {
                                "checked": True,
                                "country_code": country_code,
                                "checked_rows": len(rids),
                                "inside": inside,
                                "outside": len(outside),
                                "percent_inside": round(pct, 2),
                                "threshold": 95.0,
                                "status": "OK" if ok else "ERROR",
                                "outside_rows_preview": outside[:MAX_DISPLAY],
                            }
                            if not ok:
                                msg = (f"only {pct:.1f}% of points inside {country_code} "
                                       f"convex hull (need ≥95%)")
                                preview = [f"row {rid}: outside" for rid in outside[:MAX_DISPLAY]]
                                if len(outside) > MAX_DISPLAY:
                                    preview.append("...")
                                outside_set = set(outside)
                                for c in (lon_col, lat_col):
                                    r = col_results.setdefault(c, {"status": "OK", "errors": [], "error_rows": []})
                                    r["errors"].append(msg)
                                    r["errors"].extend(preview)
                                    r["error_rows"] = sorted(set(r["error_rows"]) | outside_set)
                                    r["status"] = "ERROR"

            # Persist per-column validation. Wipe every column's result first
            # so a column that was un-mapped or set to skip doesn't keep a stale
            # error from a previous mapping — validate only writes results for
            # the columns it actually checked this run.
            cur.execute(
                "UPDATE api.uploaded_dataset_column SET validation = NULL WHERE table_name = %s",
                (table_name,))
            total_errors = 0
            for csv_col, r in col_results.items():
                text = "OK" if r["status"] == "OK" else "; ".join(r["errors"])
                cur.execute("""
                    UPDATE api.uploaded_dataset_column
                    SET validation = %s
                    WHERE table_name = %s AND column_name = %s
                """, (text, table_name, csv_col))
                if r["status"] != "OK":
                    total_errors += len([e for e in r["errors"] if e != "..."])

            # Required destinations: every entry in REQUIRED_DESTINATIONS must be mapped
            mapped_targets = {(m["destination_table"], m["destination_column"]) for m in mappings}
            missing_required = [
                lbl for (lbl, t, c) in REQUIRED_DESTINATIONS if (t, c) not in mapped_targets
            ]

            # Dataset-level note
            n_cols_err = sum(1 for r in col_results.values() if r["status"] != "OK")
            parts = []
            if missing_required:
                parts.append("missing required: " + ", ".join(missing_required))
            if n_cols_err:
                parts.append(f"{n_cols_err} column(s) with errors")
            if country_bounds.get("status") == "ERROR":
                parts.append(f"{country_bounds['percent_inside']}% inside country bounds")
            # A licence must be chosen before the dataset can be ingested.
            license_val = (payload or {}).get("license") if isinstance(payload, dict) else None
            license_missing = not (license_val or "").strip()
            if license_missing:
                parts.append("licence not set")
            note = VALIDATION_OK_NOTE if not parts else "Validation: " + "; ".join(parts)
            cur.execute("UPDATE api.uploaded_dataset SET note = %s WHERE table_name = %s",
                        (note, table_name))

            log_audit(current_user['user_id'], None, "etl_validated",
                     {"table_name": table_name, "columns_with_errors": n_cols_err,
                      "missing_required": missing_required, "license_missing": license_missing,
                      "country_bounds": country_bounds}, None)

            return {
                "message": note,
                "columns": col_results,
                "total_rows": len(rows),
                "missing_required": missing_required,
                "license_missing": license_missing,
                "country_bounds": country_bounds,
            }


def _prune_dataset_rows(cur, dataset: dict) -> dict:
    """Delete every soil_data row tied to one ETL dataset — its csv-tagged plots
    and their profiles/elements/specimens/results — plus the dataset's sites when
    no other plots reference them. `cur` must be a RealDictCursor inside a caller
    transaction. Returns a {table: rowcount} dict ({} when the dataset has no
    plots). Shared by the dataset-prune endpoint and project deletion.
    """
    project_id = dataset.get("project_id")
    table_name = dataset.get("table_name")
    cur.execute("SELECT site_id FROM soil_data.project_site WHERE project_id = %s", (project_id,))
    site_ids = [r["site_id"] for r in cur.fetchall()]

    cur.execute("SELECT plot_id FROM soil_data.plot WHERE csv = %s", (table_name,))
    plot_ids = [r["plot_id"] for r in cur.fetchall()]
    if not plot_ids:
        return {}

    cur.execute("SELECT profile_id FROM soil_data.profile WHERE plot_id = ANY(%s)", (plot_ids,))
    profile_ids = [r["profile_id"] for r in cur.fetchall()]

    element_ids = []
    if profile_ids:
        cur.execute("SELECT element_id FROM soil_data.element WHERE profile_id = ANY(%s)", (profile_ids,))
        element_ids = [r["element_id"] for r in cur.fetchall()]

    specimen_ids = []
    if element_ids:
        cur.execute("SELECT specimen_id FROM soil_data.specimen WHERE element_id = ANY(%s)", (element_ids,))
        specimen_ids = [r["specimen_id"] for r in cur.fetchall()]

    deleted = {}
    if specimen_ids:
        cur.execute("DELETE FROM soil_data.result_num WHERE specimen_id = ANY(%s)", (specimen_ids,))
        deleted["result_num"] = cur.rowcount
        cur.execute("DELETE FROM soil_data.specimen WHERE specimen_id = ANY(%s)", (specimen_ids,))
        deleted["specimen"] = cur.rowcount
    if element_ids:
        cur.execute("DELETE FROM soil_data.element WHERE element_id = ANY(%s)", (element_ids,))
        deleted["element"] = cur.rowcount
    if profile_ids:
        cur.execute("DELETE FROM soil_data.profile WHERE profile_id = ANY(%s)", (profile_ids,))
        deleted["profile"] = cur.rowcount
    cur.execute("DELETE FROM soil_data.plot WHERE plot_id = ANY(%s)", (plot_ids,))
    deleted["plot"] = cur.rowcount

    # Delete sites only if no plots remain AND no other project references them.
    deleted["project_site"] = 0
    deleted["site"] = 0
    for site_id in site_ids:
        cur.execute("SELECT 1 FROM soil_data.plot WHERE site_id = %s LIMIT 1", (site_id,))
        if cur.fetchone():
            continue  # plots still exist (from other CSVs) — keep site
        cur.execute("DELETE FROM soil_data.project_site WHERE project_id = %s AND site_id = %s",
                    (project_id, site_id))
        deleted["project_site"] += cur.rowcount
        cur.execute("SELECT COUNT(*) AS cnt FROM soil_data.project_site WHERE site_id = %s", (site_id,))
        if cur.fetchone()["cnt"] == 0:
            cur.execute("DELETE FROM soil_data.site WHERE site_id = %s", (site_id,))
            deleted["site"] += cur.rowcount
    return deleted


@app.post("/api/etl/datasets/{table_name}/prune")
async def prune_dataset(
    table_name: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete all soil_data rows associated with a dataset's project, reversing an ingest."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get dataset metadata
            cur.execute("SELECT * FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            dataset = cur.fetchone()
            if not dataset:
                raise HTTPException(status_code=404, detail="Dataset not found")

            project_id = dataset.get("project_id")
            if not project_id:
                raise HTTPException(status_code=400, detail="No project associated with this dataset")

            # Collect IDs top-down: plots tagged with this CSV → profiles → elements → specimens
            deleted = _prune_dataset_rows(cur, dataset)
            if not deleted:
                return {"message": "No data found for this dataset", "deleted": {}}

            # Reset dataset status and save note
            parts = [f"{k}: {v}" for k, v in deleted.items() if v > 0]
            note = "Pruned" + (" (" + ", ".join(parts) + ")" if parts else "")
            cur.execute("UPDATE api.uploaded_dataset SET status = %s, note = %s WHERE table_name = %s",
                        ("Removed", note, table_name))

            log_audit(current_user['user_id'], None, "etl_pruned",
                     {"table_name": table_name, "project_id": project_id, "deleted": deleted}, None)

            return {"message": note, "project_id": project_id, "deleted": deleted}


@app.delete("/api/etl/datasets/{table_name}")
async def delete_dataset(
    table_name: str,
    current_user: dict = Depends(get_current_admin_user)
):
    """Drop the staging table and remove all related rows from api.uploaded_dataset(_column)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Dataset not found")

            cur.execute(pgsql.SQL("DROP TABLE IF EXISTS {}.{}").format(
                pgsql.Identifier('soil_data_upload'),
                pgsql.Identifier(table_name)
            ))
            cur.execute("DELETE FROM api.uploaded_dataset_column WHERE table_name = %s", (table_name,))
            cur.execute("DELETE FROM api.uploaded_dataset WHERE table_name = %s", (table_name,))

            log_audit(current_user['user_id'], None, "etl_dataset_deleted",
                     {"table_name": table_name}, None)

            return {"message": f"Deleted dataset {table_name}"}


# ==================== Administrative divisions ====================
# Admin-uploaded polygon boundary layers (country / provinces / districts …)
# shown on the map under an "Administrative divisions" group. Levels and
# names differ per country, so the layer name and the symbology are both
# customisable. Deliberately metadata-free: no mapset/layer rows, no pyCSW,
# nothing published to the federation.

ADMIN_DIV_MAX_BYTES = 1024 * 1024 * 1024   # 1 GB — boundary files can be chunky
ADMIN_DIV_GEOM_TYPES = {"Polygon", "MultiPolygon"}
ADMIN_DIV_STROKE_TYPES = {"solid", "dashed", "dotted", "dash-dot"}
HEX_COLOUR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _geojson_epsg(data) -> int:
    """EPSG code of a GeoJSON document. RFC 7946 GeoJSON is always WGS 84 and
    has no crs member; legacy files may carry one — honour it when it names an
    EPSG code, refuse when it names something we cannot identify."""
    crs = data.get("crs") if isinstance(data, dict) else None
    if not crs:
        return 4326
    name = str(((crs or {}).get("properties") or {}).get("name") or "").strip()
    if "CRS84" in name:
        return 4326
    m = re.search(r"EPSG:{1,2}(\d+)$", name, re.IGNORECASE)
    if m:
        return int(m.group(1))
    raise HTTPException(status_code=400, detail=(
        f"Could not determine the EPSG code from the GeoJSON crs member "
        f"('{name}'). Reproject the file to EPSG:4326 and re-upload."))


def _admin_div_features_from_geojson(data) -> list:
    """[(properties_json, geometry_json), …] from a GeoJSON FeatureCollection,
    bare Feature or bare geometry. Non-polygon features are skipped."""
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Not a GeoJSON object")
    t = data.get("type")
    if t == "FeatureCollection":
        feats = data.get("features") or []
    elif t == "Feature":
        feats = [data]
    elif t in ADMIN_DIV_GEOM_TYPES:
        feats = [{"type": "Feature", "properties": {}, "geometry": data}]
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported GeoJSON type: {t}")
    out = []
    for f in feats:
        geom = (f or {}).get("geometry") or {}
        if geom.get("type") in ADMIN_DIV_GEOM_TYPES:
            out.append((json.dumps(f.get("properties") or {}, default=str),
                        json.dumps(geom)))
    return out


def _admin_div_features_from_kml(contents: bytes) -> list:
    """[(properties_json, geometry_json), …] from a KML document. KML is
    always WGS 84 lon/lat by specification, so no CRS handling is needed.
    Tag matching is namespace-agnostic (KML 2.2 and the older Google Earth
    namespaces differ only in URI). Placemark name/description and
    ExtendedData Data/SimpleData entries become feature properties."""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(contents)
    except ET.ParseError as e:
        raise HTTPException(status_code=400, detail=f"Invalid KML: {e}")

    def local(el):
        return el.tag.rsplit("}", 1)[-1]

    def ring(coord_el):
        # <coordinates> holds whitespace-separated "lon,lat[,alt]" tuples.
        pts = []
        for tok in (coord_el.text or "").split():
            parts = tok.split(",")
            if len(parts) >= 2:
                try:
                    pts.append([float(parts[0]), float(parts[1])])
                except ValueError:
                    continue
        if len(pts) >= 3 and pts[0] != pts[-1]:
            pts.append(pts[0])   # KML rings are not required to be closed
        return pts if len(pts) >= 4 else None

    def polygon_rings(poly_el):
        outer = poly_el.find("./{*}outerBoundaryIs/{*}LinearRing/{*}coordinates")
        r = ring(outer) if outer is not None else None
        if not r:
            return None
        rings = [r]
        for inner in poly_el.findall("./{*}innerBoundaryIs/{*}LinearRing/{*}coordinates"):
            ir = ring(inner)
            if ir:
                rings.append(ir)
        return rings

    out = []
    for pm in (el for el in root.iter() if local(el) == "Placemark"):
        polys = []
        for el in pm.iter():
            if local(el) == "Polygon":
                rings = polygon_rings(el)
                if rings:
                    polys.append(rings)
        if not polys:
            continue   # point/line Placemarks are skipped, like elsewhere
        props = {}
        for tag in ("name", "description"):
            v = pm.find(f"./{{*}}{tag}")
            if v is not None and (v.text or "").strip():
                props[tag] = v.text.strip()
        for d in pm.iter():
            if local(d) == "Data" and d.get("name"):
                v = d.find("./{*}value")
                props[d.get("name")] = (v.text or "").strip() if v is not None else ""
            elif local(d) == "SimpleData" and d.get("name"):
                props[d.get("name")] = (d.text or "").strip()
        geom = ({"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1
                else {"type": "MultiPolygon", "coordinates": polys})
        out.append((json.dumps(props, default=str), json.dumps(geom)))
    return out


def _admin_div_kml_from_kmz(contents: bytes) -> bytes:
    """The KML document inside a KMZ archive (doc.kml by convention, else the
    first .kml entry)."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(contents))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Not a valid KMZ archive")
    kmls = [n for n in zf.namelist() if n.lower().endswith(".kml")]
    if not kmls:
        raise HTTPException(status_code=400,
                            detail="The KMZ archive contains no .kml document")
    kmls.sort(key=lambda n: (n.lower() != "doc.kml", n.lower()))
    return zf.read(kmls[0])


def _admin_div_features_from_zip(contents: bytes) -> tuple:
    """(features, epsg) from a zipped ESRI Shapefile, read with pyshp (pure
    Python — no GDAL vector stack in the image). The EPSG code comes from the
    .prj's AUTHORITY clause; a .prj that declares neither an EPSG code nor
    plain WGS 84 is refused, since the CRS cannot be identified."""
    import shapefile as _shp   # pyshp
    try:
        zf = zipfile.ZipFile(io.BytesIO(contents))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Not a valid zip archive")
    names = {n.lower().rsplit(".", 1)[-1]: n for n in zf.namelist()
             if "." in n and not n.endswith("/")}
    if "shp" not in names or "dbf" not in names:
        raise HTTPException(status_code=400,
                            detail="The zip must contain .shp and .dbf files")
    epsg = 4326   # no .prj → assume WGS 84; the extent check is the backstop
    if "prj" in names:
        prj = zf.read(names["prj"]).decode("utf-8", "ignore")
        # The whole-CRS authority is the last AUTHORITY entry in the WKT
        # (earlier ones belong to the datum/spheroid/units).
        codes = re.findall(r'AUTHORITY\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]', prj, re.IGNORECASE)
        if codes:
            epsg = int(codes[-1])
        elif "PROJCS" in prj or not any(m in prj for m in ("WGS_1984", "WGS 84", "WGS84", "4326")):
            raise HTTPException(status_code=400, detail=(
                "Could not determine the shapefile's EPSG code — its .prj "
                "declares no EPSG authority. Reproject the file to EPSG:4326 "
                "and re-upload."))
    try:
        rdr = _shp.Reader(shp=io.BytesIO(zf.read(names["shp"])),
                          dbf=io.BytesIO(zf.read(names["dbf"])),
                          shx=io.BytesIO(zf.read(names["shx"])) if "shx" in names else None)
        out = []
        for sr in rdr.iterShapeRecords():
            gi = sr.shape.__geo_interface__
            if gi.get("type") in ADMIN_DIV_GEOM_TYPES:
                out.append((json.dumps(sr.record.as_dict(), default=str),
                            json.dumps(gi)))
        return out, epsg
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read the shapefile: {e}")


def _admin_div_features_from_gpkg(contents: bytes) -> tuple:
    """(features, epsg) from a GeoPackage. A GeoPackage is SQLite, which the
    stdlib reads — no GDAL needed; PostGIS parses the WKB after the GeoPackage
    binary header is stripped. Exactly one polygon layer is expected; a
    non-4326 EPSG is returned for the caller to reproject, an undefined or
    non-EPSG CRS is refused."""
    import sqlite3
    import struct
    import tempfile

    def wkb_of(blob):
        # GPKG geometry blob: 'GP' magic, version, flags, srs_id (4 bytes),
        # optional envelope, then standard WKB.
        if not blob or len(blob) < 13 or bytes(blob[0:2]) != b"GP":
            return None
        flags = blob[3]
        if flags & 0x10:   # empty-geometry flag
            return None
        env_len = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get((flags >> 1) & 0x07)
        if env_len is None:
            return None
        return bytes(blob[8 + env_len:])

    def is_polygon(wkb):
        if not wkb or len(wkb) < 5:
            return False
        (code,) = struct.unpack("<I" if wkb[0] == 1 else ">I", wkb[1:5])
        # base type 3/6 = Polygon/MultiPolygon in both ISO (1000s offsets for
        # Z/M) and EWKB (flags in the high bits) encodings
        return (code & 0xFFFF) % 1000 in (3, 6)

    tmp = tempfile.NamedTemporaryFile(suffix=".gpkg", delete=False)
    try:
        tmp.write(contents)
        tmp.close()
        con = sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            try:
                layers = con.execute("""
                    SELECT table_name, column_name, geometry_type_name, srs_id
                    FROM gpkg_geometry_columns
                """).fetchall()
            except sqlite3.Error:
                raise HTTPException(status_code=400, detail="Not a valid GeoPackage")
            candidates = [l for l in layers if (l["geometry_type_name"] or "").upper()
                          in ("POLYGON", "MULTIPOLYGON", "GEOMETRY")]
            if not candidates:
                raise HTTPException(status_code=400,
                                    detail="The GeoPackage has no polygon layer")
            if len(candidates) > 1:
                raise HTTPException(status_code=400, detail=(
                    "The GeoPackage contains several layers ("
                    + ", ".join(l["table_name"] for l in candidates)
                    + ") — export a single polygon layer and re-upload."))
            layer = candidates[0]
            srs_id = int(layer["srs_id"])
            epsg = 4326
            if srs_id != 4326:
                if srs_id in (0, -1):   # 0 = undefined geographic, -1 = undefined cartesian
                    raise HTTPException(status_code=400, detail=(
                        f"Layer '{layer['table_name']}' has an undefined CRS "
                        f"(srs_id {srs_id}) — the EPSG code is unknown. "
                        f"Reproject the file to EPSG:4326 and re-upload."))
                try:
                    srs = con.execute(
                        "SELECT organization, organization_coordsys_id "
                        "FROM gpkg_spatial_ref_sys WHERE srs_id = ?", (srs_id,)).fetchone()
                except sqlite3.Error:
                    srs = None
                if srs is not None and str(srs["organization"] or "").upper() != "EPSG":
                    raise HTTPException(status_code=400, detail=(
                        f"Layer '{layer['table_name']}' uses a non-EPSG CRS "
                        f"('{srs['organization']}:{srs['organization_coordsys_id']}') — "
                        f"the EPSG code is unknown. Reproject the file to "
                        f"EPSG:4326 and re-upload."))
                epsg = int(srs["organization_coordsys_id"]) if srs is not None else srs_id
            tbl = layer["table_name"].replace('"', '""')
            geom_col = layer["column_name"]
            out = []
            for row in con.execute(f'SELECT * FROM "{tbl}"'):
                wkb = wkb_of(row[geom_col])
                if not wkb or not is_polygon(wkb):
                    continue
                props = {k: (None if isinstance(row[k], (bytes, memoryview)) else row[k])
                         for k in row.keys() if k != geom_col}
                out.append((json.dumps(props, default=str), psycopg2.Binary(wkb)))
            return out, epsg
        finally:
            con.close()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@app.get("/api/admin-divisions")
async def list_admin_divisions(api_client: dict = Depends(verify_api_key)):
    """Published administrative division layers with symbology (map view)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT division_id, name, display_order, stroke_color,
                       stroke_width, stroke_type, fill_color, fill_opacity,
                       feature_count, active_default, min_zoom
                FROM api.admin_division
                WHERE is_published
                ORDER BY display_order, division_id
            """)
            return cur.fetchall()


@app.get("/api/admin-divisions/manage")
async def list_admin_divisions_manage(current_user: dict = Depends(get_current_admin_user)):
    """All administrative division layers, for the admin panel."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT division_id, name, display_order, stroke_color,
                       stroke_width, stroke_type, fill_color, fill_opacity,
                       is_published, feature_count, file_name, uploaded_by,
                       uploaded_at, active_default, min_zoom
                FROM api.admin_division
                ORDER BY display_order, division_id
            """)
            return cur.fetchall()


@app.post("/api/admin-divisions/upload")
async def upload_admin_division(
    file: UploadFile = File(...),
    name: str = Form(...),
    current_user: dict = Depends(get_current_admin_user),
):
    """Upload a polygon layer: GeoJSON (.geojson/.json), zipped Shapefile,
    GeoPackage (.gpkg) or KML (.kml/.kmz)."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A layer name is required")
    fname = (file.filename or "").lower()
    contents = await file.read(ADMIN_DIV_MAX_BYTES + 1)
    if len(contents) > ADMIN_DIV_MAX_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"File exceeds {ADMIN_DIV_MAX_BYTES // (1024 * 1024)} MB limit")
    geom_expr = "ST_GeomFromGeoJSON(%s)"
    if fname.endswith((".geojson", ".json")):
        try:
            data = json.loads(contents.decode("utf-8-sig"))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON")
        epsg = _geojson_epsg(data)
        feats = _admin_div_features_from_geojson(data)
    elif fname.endswith(".zip"):
        feats, epsg = _admin_div_features_from_zip(contents)
    elif fname.endswith(".gpkg"):
        feats, epsg = _admin_div_features_from_gpkg(contents)
        geom_expr = "ST_GeomFromWKB(%s)"
    elif fname.endswith(".kml"):
        feats, epsg = _admin_div_features_from_kml(contents), 4326
    elif fname.endswith(".kmz"):
        feats, epsg = _admin_div_features_from_kml(_admin_div_kml_from_kmz(contents)), 4326
    else:
        raise HTTPException(status_code=400, detail=(
            "Upload GeoJSON (.geojson/.json), a zipped Shapefile (.zip), "
            "a GeoPackage (.gpkg) or KML (.kml/.kmz)"))
    if not feats:
        raise HTTPException(status_code=400,
                            detail="No Polygon/MultiPolygon features found in the file")

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # A non-4326 file is reprojected on the fly by PostGIS — provided
            # its EPSG code is one the database knows.
            epsg = int(epsg)
            if epsg != 4326:
                cur.execute("SELECT 1 FROM spatial_ref_sys WHERE srid = %s", (epsg,))
                if not cur.fetchone():
                    raise HTTPException(status_code=400, detail=(
                        f"The file declares EPSG:{epsg}, which this system does "
                        f"not know — reproject to EPSG:4326 and re-upload."))
            src_expr = f"ST_Force2D(ST_SetSRID({geom_expr}, {epsg}))"
            if epsg != 4326:
                src_expr = f"ST_Transform({src_expr}, 4326)"
            cur.execute("""
                INSERT INTO api.admin_division
                    (name, display_order, feature_count, file_name, uploaded_by)
                VALUES (%s,
                        COALESCE((SELECT MAX(display_order) + 1 FROM api.admin_division), 0),
                        %s, %s, %s)
                RETURNING division_id
            """, (name, len(feats), file.filename, current_user["user_id"]))
            division_id = cur.fetchone()["division_id"]
            # Batched insert — a 1 GB boundary file can carry hundreds of
            # thousands of features. ST_Force2D: boundary exports often carry
            # Z coordinates, which the 2D MultiPolygon column would reject.
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO api.admin_division_feature (division_id, properties, geom) VALUES %s",
                [(division_id, props, geom) for props, geom in feats],
                template=("(%s, %s::jsonb, ST_Multi(ST_CollectionExtract(ST_MakeValid("
                          f"{src_expr}), 3)))"),
                page_size=500)
            # GeoJSON is WGS 84 by definition, but projected files do turn up —
            # catch them by extent rather than storing garbage coordinates.
            cur.execute("""
                SELECT ST_XMin(e) < -180.5 OR ST_XMax(e) > 180.5
                    OR ST_YMin(e) < -90.5 OR ST_YMax(e) > 90.5 AS out_of_range
                FROM (SELECT ST_Extent(geom) AS e
                      FROM api.admin_division_feature WHERE division_id = %s) s
            """, (division_id,))
            if cur.fetchone()["out_of_range"]:
                raise HTTPException(status_code=400, detail=(
                    "Coordinates fall outside WGS 84 bounds — the file appears "
                    "to be in a projected CRS but does not declare its EPSG "
                    "code, so it cannot be reprojected automatically. "
                    "Reproject to EPSG:4326 and re-upload."))
            log_audit(current_user["user_id"], None, "admin_division_uploaded",
                      {"division_id": division_id, "name": name,
                       "features": len(feats), "epsg": epsg}, None)
            msg = f"Uploaded '{name}' with {len(feats)} features"
            if epsg != 4326:
                msg += f" (reprojected from EPSG:{epsg})"
            return {"message": msg,
                    "division_id": division_id, "feature_count": len(feats)}


class AdminDivisionUpdate(BaseModel):
    name: Optional[str] = None
    display_order: Optional[int] = None
    stroke_color: Optional[str] = None
    stroke_width: Optional[float] = None
    stroke_type: Optional[str] = None
    fill_color: Optional[str] = None
    fill_opacity: Optional[float] = None
    is_published: Optional[bool] = None
    active_default: Optional[bool] = None
    min_zoom: Optional[float] = None


@app.patch("/api/admin-divisions/{division_id}")
async def update_admin_division(
    division_id: int,
    body: AdminDivisionUpdate,
    current_user: dict = Depends(get_current_admin_user),
):
    """Rename / reorder / restyle / publish-toggle a division layer."""
    sets, params = [], []
    if body.name is not None:
        v = body.name.strip()
        if not v:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        sets.append("name = %s"); params.append(v)
    if body.display_order is not None:
        sets.append("display_order = %s"); params.append(int(body.display_order))
    for col, val in (("stroke_color", body.stroke_color), ("fill_color", body.fill_color)):
        if val is not None:
            if not HEX_COLOUR_RE.match(val):
                raise HTTPException(status_code=400,
                                    detail=f"{col} must be a #rrggbb colour")
            sets.append(f"{col} = %s"); params.append(val)
    if body.stroke_width is not None:
        if not (0 <= body.stroke_width <= 20):
            raise HTTPException(status_code=400, detail="stroke_width must be 0–20")
        sets.append("stroke_width = %s"); params.append(body.stroke_width)
    if body.stroke_type is not None:
        if body.stroke_type not in ADMIN_DIV_STROKE_TYPES:
            raise HTTPException(status_code=400,
                                detail=f"stroke_type must be one of: {', '.join(sorted(ADMIN_DIV_STROKE_TYPES))}")
        sets.append("stroke_type = %s"); params.append(body.stroke_type)
    if body.fill_opacity is not None:
        if not (0 <= body.fill_opacity <= 1):
            raise HTTPException(status_code=400, detail="fill_opacity must be 0–1")
        sets.append("fill_opacity = %s"); params.append(body.fill_opacity)
    if body.min_zoom is not None:
        if not (0 <= body.min_zoom <= 22):
            raise HTTPException(status_code=400, detail="min_zoom must be 0-22")
        # 0 means "always visible" — stored as NULL
        sets.append("min_zoom = %s")
        params.append(float(body.min_zoom) if body.min_zoom > 0 else None)
    if body.active_default is not None:
        sets.append("active_default = %s"); params.append(bool(body.active_default))
    if body.is_published is not None:
        sets.append("is_published = %s"); params.append(bool(body.is_published))
    if not sets:
        return {"message": "Nothing to update"}
    params.append(division_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE api.admin_division SET {', '.join(sets)} WHERE division_id = %s",
                tuple(params))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Layer not found")
            return {"message": "Layer updated"}


@app.delete("/api/admin-divisions/{division_id}")
async def delete_admin_division(
    division_id: int,
    current_user: dict = Depends(get_current_admin_user),
):
    """Delete a division layer and its features (ON DELETE CASCADE)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("DELETE FROM api.admin_division WHERE division_id = %s RETURNING name",
                        (division_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Layer not found")
            log_audit(current_user["user_id"], None, "admin_division_deleted",
                      {"division_id": division_id, "name": row["name"]}, None)
            return {"message": f"Deleted layer '{row['name']}'"}


@app.get("/api/admin-divisions/{division_id}/geojson")
async def get_admin_division_geojson(
    division_id: int,
    api_client: dict = Depends(verify_api_key),
):
    """FeatureCollection for one published division layer (map view)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM api.admin_division WHERE division_id = %s AND is_published",
                        (division_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Layer not found")
            cur.execute("""
                SELECT json_build_object(
                    'type', 'FeatureCollection',
                    'features', COALESCE(json_agg(json_build_object(
                        'type', 'Feature',
                        'properties', COALESCE(properties, '{}'::jsonb),
                        'geometry', ST_AsGeoJSON(geom, 6)::json)), '[]'::json)) AS fc
                FROM api.admin_division_feature
                WHERE division_id = %s
            """, (division_id,))
            return cur.fetchone()["fc"]


# ==================== Health Check & Root ====================

@app.get("/api/layer/soil_profiles")
async def list_soil_profile_layers(current_user: dict = Depends(get_current_user)):
    """List all soil-data projects as profile layers with total vs. published counts.

    After the spatial_metadata → soil_data merge the policy fields moved off
    `project`:
      * is_published lives on the stub `soil_data.layer` (layer_id = '<CC>-<PROJ>')
      * profile_limit / spatial_blur_m live on the stub `soil_data.mapset`
        (mapset_id = '<CC>-<PROJ>')
    """
    sql = """
        WITH profile_ranked AS (
          SELECT ps.country_id, ps.project_id,
                 pr.profile_id,
                 row_number() OVER (PARTITION BY ps.country_id, ps.project_id ORDER BY pr.profile_id) AS rn
          FROM soil_data.project_site ps
          JOIN soil_data.plot pl ON pl.site_id = ps.site_id
          JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
        ),
        profile_totals AS (
          SELECT country_id, project_id, count(DISTINCT profile_id) AS total_profiles
          FROM profile_ranked
          GROUP BY country_id, project_id
        ),
        published_profiles AS (
          SELECT pr.country_id, pr.project_id, pr.profile_id
          FROM profile_ranked pr
          JOIN soil_data.project p
            ON p.country_id = pr.country_id AND p.project_id = pr.project_id
          LEFT JOIN soil_data.mapset pm
            ON pm.mapset_id = p.country_id || '-' || p.project_id
          LEFT JOIN soil_data.layer pl
            ON pl.layer_id = p.country_id || '-' || p.project_id
          -- Treat a missing stub layer as "published by default" so
          -- ETL-created projects don't silently get 0 profile counts.
          WHERE COALESCE(pl.is_published, TRUE) = TRUE
            AND (pm.profile_limit IS NULL OR pr.rn <= pm.profile_limit)
        ),
        published_profile_counts AS (
          SELECT country_id, project_id, count(DISTINCT profile_id) AS published_profiles
          FROM published_profiles
          GROUP BY country_id, project_id
        ),
        total_obs AS (
          SELECT ps.country_id, ps.project_id, count(r.observation_num_id) AS total_observations
          FROM soil_data.project_site ps
          JOIN soil_data.plot pl ON pl.site_id = ps.site_id
          JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
          JOIN soil_data.element e ON e.profile_id = pr.profile_id
          JOIN soil_data.specimen s ON s.element_id = e.element_id
          JOIN soil_data.result_num r ON r.specimen_id = s.specimen_id
          GROUP BY ps.country_id, ps.project_id
        ),
        published_obs AS (
          SELECT pp.country_id, pp.project_id, count(r.observation_num_id) AS published_observations
          FROM published_profiles pp
          JOIN soil_data.element e ON e.profile_id = pp.profile_id
          JOIN soil_data.specimen s ON s.element_id = e.element_id
          JOIN soil_data.result_num r ON r.specimen_id = s.specimen_id
          GROUP BY pp.country_id, pp.project_id
        )
        SELECT
          p.country_id,
          p.project_id,
          p.name AS project_name,
          COALESCE(pl.is_published, TRUE) AS is_published,
          pm.profile_limit,
          pm.spatial_blur_m,
          COALESCE(pm.locations_only, FALSE) AS locations_only,
          COALESCE(pm.hide_download, FALSE) AS hide_download,
          pm.marker_shape, pm.marker_size, pm.marker_color, pm.marker_opacity,
          COALESCE(pm.active_default, TRUE) AS active_default,
          pm.display_order,
          COALESCE(pt.total_profiles, 0) AS total_profile_count,
          COALESCE(ppc.published_profiles, 0) AS published_profile_count,
          COALESCE(tobs.total_observations, 0) AS total_observation_count,
          COALESCE(pobs.published_observations, 0) AS published_observation_count
        FROM soil_data.project p
        LEFT JOIN soil_data.mapset pm
               ON pm.mapset_id = p.country_id || '-' || p.project_id
        LEFT JOIN soil_data.layer pl
               ON pl.layer_id = p.country_id || '-' || p.project_id
        LEFT JOIN profile_totals pt
               ON pt.country_id = p.country_id AND pt.project_id = p.project_id
        LEFT JOIN published_profile_counts ppc
               ON ppc.country_id = p.country_id AND ppc.project_id = p.project_id
        LEFT JOIN total_obs tobs
               ON tobs.country_id = p.country_id AND tobs.project_id = p.project_id
        LEFT JOIN published_obs pobs
               ON pobs.country_id = p.country_id AND pobs.project_id = p.project_id
        WHERE COALESCE(pt.total_profiles, 0) > 0
        ORDER BY pm.display_order NULLS LAST, p.name;
    """
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


class SoilProfilePublishUpdate(BaseModel):
    is_published: bool


@app.patch("/api/layer/soil_profiles/{project_id}/publish")
async def set_soil_profile_publish(
    project_id: str,
    body: SoilProfilePublishUpdate,
    current_user: dict = Depends(get_current_user),
):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.layer l
                SET is_published = %s
                FROM soil_data.project p
                WHERE l.layer_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.is_published, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub layer not found")
            conn.commit()
    return {"project_id": project_id, "is_published": body.is_published}


class SoilProfileLimitUpdate(BaseModel):
    profile_limit: Optional[int] = None


@app.patch("/api/layer/soil_profiles/{project_id}/limit")
async def set_soil_profile_limit(
    project_id: str,
    body: SoilProfileLimitUpdate,
    current_user: dict = Depends(get_current_user),
):
    if body.profile_limit is not None and body.profile_limit <= 0:
        raise HTTPException(status_code=400, detail="profile_limit must be > 0 or null")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET profile_limit = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.profile_limit, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    return {"project_id": project_id, "profile_limit": body.profile_limit}


class SoilProfileOrderUpdate(BaseModel):
    display_order: Optional[int] = None


@app.patch("/api/layer/soil_profiles/{project_id}/order")
async def set_soil_profile_order(
    project_id: str,
    body: SoilProfileOrderUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Position of the project in the map view's Soil profiles panel
    (lower first, NULL last)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET display_order = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.display_order, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    return {"project_id": project_id, "display_order": body.display_order}


class SoilProfileActiveUpdate(BaseModel):
    active_default: bool


@app.patch("/api/layer/soil_profiles/{project_id}/active")
async def set_soil_profile_active(
    project_id: str,
    body: SoilProfileActiveUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Whether the project's layer starts ticked (visible) in the map view.
    Publishing is unaffected — the data stays available either way."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET active_default = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.active_default, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    log_audit(current_user["user_id"], None, "soil_profile_active_updated",
              {"project_id": project_id, "active_default": body.active_default}, None)
    return {"project_id": project_id, "active_default": body.active_default}


class SoilProfileSymbologyUpdate(BaseModel):
    marker_shape: Optional[str] = None
    marker_size: Optional[float] = None
    marker_color: Optional[str] = None
    marker_opacity: Optional[float] = None


MARKER_SHAPES = {"circle", "square", "triangle", "diamond", "star", "profile"}


@app.patch("/api/layer/soil_profiles/{project_id}/symbology")
async def set_soil_profile_symbology(
    project_id: str,
    body: SoilProfileSymbologyUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Per-project marker symbology for the map view (shape, size, colour,
    opacity). NULLs reset a property to the app default."""
    if body.marker_shape is not None and body.marker_shape not in MARKER_SHAPES:
        raise HTTPException(status_code=400,
                            detail=f"marker_shape must be one of {sorted(MARKER_SHAPES)}")
    if body.marker_size is not None and not 2 <= body.marker_size <= 30:
        raise HTTPException(status_code=400, detail="marker_size must be 2-30")
    if body.marker_color is not None and not re.match(r"^#[0-9a-fA-F]{6}$", body.marker_color):
        raise HTTPException(status_code=400, detail="marker_color must be #rrggbb")
    if body.marker_opacity is not None and not 0 <= body.marker_opacity <= 1:
        raise HTTPException(status_code=400, detail="marker_opacity must be 0-1")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET marker_shape = %s, marker_size = %s,
                    marker_color = %s, marker_opacity = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.marker_shape, body.marker_size,
                 body.marker_color, body.marker_opacity, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    log_audit(current_user["user_id"], None, "soil_profile_symbology_updated",
              {"project_id": project_id, "shape": body.marker_shape,
               "size": body.marker_size, "color": body.marker_color,
               "opacity": body.marker_opacity}, None)
    return {"project_id": project_id}


class SoilProfileBlurUpdate(BaseModel):
    spatial_blur_m: Optional[int] = None


@app.patch("/api/layer/soil_profiles/{project_id}/blur")
async def set_soil_profile_blur(
    project_id: str,
    body: SoilProfileBlurUpdate,
    current_user: dict = Depends(get_current_user),
):
    if body.spatial_blur_m is not None and body.spatial_blur_m < 0:
        raise HTTPException(status_code=400, detail="spatial_blur_m must be >= 0 or null")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET spatial_blur_m = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.spatial_blur_m, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    return {"project_id": project_id, "spatial_blur_m": body.spatial_blur_m}


class SoilProfileLocationsOnlyUpdate(BaseModel):
    locations_only: bool


@app.patch("/api/layer/soil_profiles/{project_id}/locations-only")
async def set_soil_profile_locations_only(
    project_id: str,
    body: SoilProfileLocationsOnlyUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Share only profile locations (points) for this project — no observational
    data. Enforced in api.vw_api_observation (SIS data panel/CSV + GloSIS
    federation); the points keep publishing via api.vw_api_profile."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET locations_only = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.locations_only, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    return {"project_id": project_id, "locations_only": body.locations_only}


class SoilProfileHideDownloadUpdate(BaseModel):
    hide_download: bool


@app.patch("/api/layer/soil_profiles/{project_id}/hide-download")
async def set_soil_profile_hide_download(
    project_id: str,
    body: SoilProfileHideDownloadUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Hide the per-project profile CSV download button on the map for this
    project. UI affordance only — the profile points and observational data
    still publish exactly as before (nothing is restricted). Surfaced to the
    map via /api/profile/blur (hide_download_mapset_ids)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE soil_data.mapset m
                SET hide_download = %s
                FROM soil_data.project p
                WHERE m.mapset_id = p.country_id || '-' || p.project_id
                  AND p.project_id = %s
                """,
                (body.hide_download, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project or stub mapset not found")
            conn.commit()
    return {"project_id": project_id, "hide_download": body.hide_download}


@app.delete("/api/layer/soil_profiles/{project_id}/profiles")
async def delete_soil_profile_data(
    project_id: str,
    current_user: dict = Depends(get_current_admin_user),
):
    """Delete all soil-profile data for a project (keeping the project itself),
    by project rather than by csv tag — so profiles orphaned from a deleted ETL
    dataset are removed too. Used by the Soil profiles tab Delete button."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cc = _project_country_of(cur, project_id)
            if not cc:
                raise HTTPException(status_code=404, detail="Project not found")
            deleted = _delete_all_project_profiles(cur, cc, project_id)
            conn.commit()
    log_audit(current_user["user_id"], None, "soil_profiles_deleted",
              {"project_id": project_id, "country_id": cc, "deleted": deleted}, None)
    return {"message": "Soil profiles deleted", "project_id": project_id, "deleted": deleted}


@app.get("/api/stats/dashboard")
async def dashboard_stats(current_user: dict = Depends(get_current_user)):
    """Aggregated stats across soil_data for the dashboard tab."""
    out = {}
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Top-line cards
            cur.execute("""
                SELECT
                  (SELECT count(*) FROM soil_data.profile) AS profile_count,
                  (SELECT count(*) FROM soil_data.result_num) AS observation_count,
                  (SELECT count(*) FROM soil_data.project) AS project_count,
                  -- Distinct properties that actually have measurements in
                  -- this database (not the full catalogue of known ones).
                  (SELECT count(DISTINCT o.property_num_id)
                   FROM soil_data.observation_num o
                   JOIN soil_data.result_num r
                     ON r.observation_num_id = o.observation_num_id) AS property_count,
                  (SELECT count(*) FROM soil_data.site) AS site_count,
                  -- Registered raster layers (grid mapsets).
                  (SELECT count(*) FROM soil_data.layer l
                   JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                   WHERE m.spatial_representation_type_code = 'grid') AS raster_count;
            """)
            out["totals"] = cur.fetchone()

            # Profiles per project
            cur.execute("""
                SELECT p.name AS project_name,
                       count(DISTINCT pr.profile_id) AS profile_count
                FROM soil_data.project p
                LEFT JOIN soil_data.project_site ps ON ps.project_id = p.project_id
                LEFT JOIN soil_data.plot pl ON pl.site_id = ps.site_id
                LEFT JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
                GROUP BY p.name
                ORDER BY profile_count DESC;
            """)
            out["profiles_per_project"] = cur.fetchall()

            # Rasters per project (registered grid layers)
            cur.execute("""
                SELECT p.name AS project_name,
                       count(l.layer_id) AS raster_count
                FROM soil_data.project p
                JOIN soil_data.mapset m
                       ON m.country_id = p.country_id AND m.project_id = p.project_id
                JOIN soil_data.layer l ON l.mapset_id = m.mapset_id
                WHERE m.spatial_representation_type_code = 'grid'
                GROUP BY p.name
                ORDER BY raster_count DESC;
            """)
            out["rasters_per_project"] = cur.fetchall()

            # Top 10 measured properties
            cur.execute("""
                SELECT o.property_num_id AS property,
                       count(*) AS observation_count
                FROM soil_data.result_num r
                JOIN soil_data.observation_num o ON o.observation_num_id = r.observation_num_id
                GROUP BY o.property_num_id
                ORDER BY observation_count DESC
                LIMIT 10;
            """)
            out["top_properties"] = cur.fetchall()

            # Profiles sampled per year
            cur.execute("""
                SELECT extract(year FROM pl.sampling_date)::int AS year,
                       count(DISTINCT pr.profile_id) AS profile_count
                FROM soil_data.plot pl
                JOIN soil_data.profile pr ON pr.plot_id = pl.plot_id
                WHERE pl.sampling_date IS NOT NULL
                GROUP BY year
                ORDER BY year;
            """)
            out["profiles_per_year"] = cur.fetchall()

            # Depth distribution (bins of 25cm up to 2m, then >200)
            cur.execute("""
                WITH depths AS (
                  SELECT CASE
                           WHEN lower_depth IS NULL THEN NULL
                           WHEN lower_depth <= 25 THEN '0-25'
                           WHEN lower_depth <= 50 THEN '25-50'
                           WHEN lower_depth <= 75 THEN '50-75'
                           WHEN lower_depth <= 100 THEN '75-100'
                           WHEN lower_depth <= 150 THEN '100-150'
                           WHEN lower_depth <= 200 THEN '150-200'
                           ELSE '>200'
                         END AS bucket,
                         CASE
                           WHEN lower_depth IS NULL THEN 999
                           WHEN lower_depth <= 25 THEN 0
                           WHEN lower_depth <= 50 THEN 1
                           WHEN lower_depth <= 75 THEN 2
                           WHEN lower_depth <= 100 THEN 3
                           WHEN lower_depth <= 150 THEN 4
                           WHEN lower_depth <= 200 THEN 5
                           ELSE 6
                         END AS sort_idx
                  FROM soil_data.element
                  WHERE lower_depth IS NOT NULL
                )
                SELECT bucket AS depth_range, count(*) AS element_count
                FROM depths
                GROUP BY bucket, sort_idx
                ORDER BY sort_idx;
            """)
            out["depth_distribution"] = cur.fetchall()

            # Value summary per top property (min, q1, median, q3, max)
            cur.execute("""
                WITH top_props AS (
                  SELECT o.property_num_id
                  FROM soil_data.result_num r
                  JOIN soil_data.observation_num o ON o.observation_num_id = r.observation_num_id
                  GROUP BY o.property_num_id
                  ORDER BY count(*) DESC
                  LIMIT 8
                )
                SELECT o.property_num_id AS property,
                       count(r.value)::int AS n,
                       min(r.value)::float AS vmin,
                       percentile_cont(0.25) WITHIN GROUP (ORDER BY r.value)::float AS q1,
                       percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.value)::float AS median,
                       percentile_cont(0.75) WITHIN GROUP (ORDER BY r.value)::float AS q3,
                       max(r.value)::float AS vmax
                FROM soil_data.result_num r
                JOIN soil_data.observation_num o ON o.observation_num_id = r.observation_num_id
                JOIN top_props tp ON tp.property_num_id = o.property_num_id
                WHERE r.value IS NOT NULL
                GROUP BY o.property_num_id
                ORDER BY n DESC;
            """)
            out["value_summary"] = cur.fetchall()

    return out


# ==================== GloSIS Federation (admin) ====================

GLOSIS_FED_DESCRIPTION = "glosis-federation"
GLOSIS_FED_SETTING = "GLOSIS_FEDERATION_ENABLED"


def _glosis_get_enabled(cur) -> bool:
    cur.execute("SELECT value FROM api.setting WHERE key = %s", (GLOSIS_FED_SETTING,))
    row = cur.fetchone()
    return bool(row and str(row["value"]).strip().lower() == "true")


def _glosis_get_token(cur):
    """Return the singleton federation token row (with plaintext api_key) or None.

    Stored plaintext per design — admin needs to be able to copy it back to
    the Discovery Hub at any time, not just once at generation.
    """
    cur.execute("""
        SELECT api_client_id, api_key, is_active, created_at, last_login
        FROM api.api_client
        WHERE description = %s
        ORDER BY created_at NULLS LAST
        LIMIT 1
    """, (GLOSIS_FED_DESCRIPTION,))
    return cur.fetchone()


@app.get("/api/glosis/status")
async def glosis_status(current_user: dict = Depends(get_current_admin_user)):
    """Return federation enabled flag and the singleton token metadata (no plaintext)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            enabled = _glosis_get_enabled(cur)
            token = _glosis_get_token(cur)
            return {"enabled": enabled, "token": token}


@app.post("/api/glosis/enable")
async def glosis_enable(current_user: dict = Depends(get_current_admin_user)):
    """Enable federation. Creates the singleton token if missing (returns plaintext once),
    or re-activates the existing one if currently inactive (no plaintext returned)."""
    new_api_key = None
    new_api_client_id = None
    audit_action = "glosis_federation_enabled"
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO api.setting (key, value) VALUES (%s, 'true')
                ON CONFLICT (key) DO UPDATE SET value = 'true'
            """, (GLOSIS_FED_SETTING,))
            existing = _glosis_get_token(cur)
            if not existing:
                new_api_key = generate_api_key()
                new_api_client_id = f"glosis-{secrets.token_urlsafe(8)}"
                cur.execute("""
                    INSERT INTO api.api_client (api_client_id, api_key, description, is_active)
                    VALUES (%s, %s, %s, true)
                """, (new_api_client_id, new_api_key, GLOSIS_FED_DESCRIPTION))
                audit_action = "glosis_federation_enabled_token_created"
            elif not existing["is_active"]:
                cur.execute("""
                    UPDATE api.api_client SET is_active = true
                    WHERE api_client_id = %s
                """, (existing["api_client_id"],))
    # log_audit uses its own connection; call after the parent transaction commits
    log_audit(current_user["user_id"], new_api_client_id,
              audit_action, None, None)
    return {
        "message": "GloSIS federation enabled",
        "api_key": new_api_key,  # only set on first-ever enable
        "api_client_id": new_api_client_id,
    }


@app.post("/api/glosis/disable")
async def glosis_disable(current_user: dict = Depends(get_current_admin_user)):
    """Disable federation. The token row is kept intact so re-enabling reuses it."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO api.setting (key, value) VALUES (%s, 'false')
                ON CONFLICT (key) DO UPDATE SET value = 'false'
            """, (GLOSIS_FED_SETTING,))
    log_audit(current_user["user_id"], None, "glosis_federation_disabled", None, None)
    return {"message": "GloSIS federation disabled"}


@app.post("/api/glosis/disable_and_delete")
async def glosis_disable_and_delete(current_user: dict = Depends(get_current_admin_user)):
    """Disable federation AND delete the token. Re-enabling later mints a fresh key.

    Audit rows referencing the deleted token have their api_client_id nulled
    out (rather than cascading the delete) so the audit trail is preserved.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO api.setting (key, value) VALUES (%s, 'false')
                ON CONFLICT (key) DO UPDATE SET value = 'false'
            """, (GLOSIS_FED_SETTING,))
            cur.execute("""
                UPDATE api.audit SET api_client_id = NULL
                WHERE api_client_id IN (
                    SELECT api_client_id FROM api.api_client WHERE description = %s
                )
            """, (GLOSIS_FED_DESCRIPTION,))
            cur.execute("""
                DELETE FROM api.api_client WHERE description = %s
            """, (GLOSIS_FED_DESCRIPTION,))
    log_audit(current_user["user_id"], None,
              "glosis_federation_disabled_and_deleted", None, None)
    return {"message": "GloSIS federation disabled and token deleted"}


# ==================== Decision Support Tool (DST) ====================
# See RASTER-AND-DST-PLAN.md for the full design.
# v1 (this slice): recipe CRUD only. Validate / run / engine come next.

def _dst_recipe_row_to_dict(row):
    # The run-state columns (run_status / run_started_at / …) live on
    # api.dst_recipe now (api.dst_run was retired). Surface them under
    # a `latest_run` sub-object so the SPA's existing shape still works.
    started = row.get("run_started_at") if isinstance(row, dict) else row["run_started_at"]
    finished = row.get("run_finished_at") if isinstance(row, dict) else row["run_finished_at"]
    latest_run = None
    if row.get("run_status") if isinstance(row, dict) else row["run_status"]:
        latest_run = {
            "status":          row["run_status"],
            "started_at":      started.isoformat() if started else None,
            "finished_at":     finished.isoformat() if finished else None,
            "output_layer_id": row["output_layer_id"],
            "metadata_status": row["metadata_status"],
            "metadata_error":  row["metadata_error"],
            "error_message":   row["run_error"],
            "triggered_by":    row["run_triggered_by"],
        }
    return {
        "recipe_id": row["recipe_id"],
        "name": row["name"],
        "description": row["description"],
        "recipe": row["recipe"],
        "output_layer_id": row["output_layer_id"],
        "created_by": row["created_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "latest_run": latest_run,
    }


@app.get("/api/dst/inputs")
async def list_dst_inputs(current_user: dict = Depends(get_current_user)):
    """Candidate input rasters for the DST recipe builder.

    Returns published grid layers (the same set that surfaces in the SPA's
    Rasters list) with their stats_minimum / stats_maximum so the builder
    can show the value range next to each row without an extra fetch."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT
                  l.layer_id,
                  l.stats_minimum,
                  l.stats_maximum,
                  m.unit_of_measure_id,
                  l.dimension_depth,
                  l.dimension_stats,
                  COALESCE(l.costum_name, m.title, l.layer_id) AS label
                FROM soil_data.layer l
                LEFT JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                WHERE l.is_published = TRUE
                  AND m.spatial_representation_type_code = 'grid'
                ORDER BY l.display_order NULLS LAST, l.layer_id
            """)
            return cur.fetchall()


@app.get("/api/dst/pixel/{layer_id}")
async def dst_pixel_breakdown(
    layer_id: str,
    lon: float,
    lat: float,
    request: Request,
    api_client: dict = Depends(verify_api_key),
):
    """Per-input breakdown for a DST output at a clicked point (lon/lat WGS84).

    Used by the SPA's map popup: for a DST raster it lists each input raster
    used in the recipe, its value at that pixel, and the reclassified score
    (value >= threshold ? above : below), alongside the aggregated output.
    """
    import rasterio
    from rasterio.warp import transform as warp_transform
    from raster_registry.dst_engine import _resolve_input_path

    with get_db() as conn:
        # _resolve_input_path unpacks its row positionally, so it needs a
        # plain (tuple) cursor, not the RealDictCursor used for metadata.
        path_cur = conn.cursor()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT recipe FROM api.dst_recipe WHERE output_layer_id = %s",
                        (layer_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404,
                                    detail="Not a DST output layer")
            recipe = row["recipe"] or {}

            def _sample(path):
                """Read the band-1 value at (lon,lat), reprojecting the point
                into the raster's CRS. Returns None on nodata / out of bounds."""
                if not path:
                    return None
                try:
                    with rasterio.open(path) as src:
                        xs, ys = warp_transform("EPSG:4326", src.crs, [lon], [lat])
                        val = next(src.sample([(xs[0], ys[0])], indexes=1))[0]
                        nd = src.nodata
                        if val is None:
                            return None
                        fv = float(val)
                        if nd is not None and fv == float(nd):
                            return None
                        if fv != fv:   # NaN
                            return None
                        return fv
                except Exception:
                    return None

            # Output value.
            out_path = _resolve_input_path(path_cur, layer_id)
            output_value = _sample(out_path)

            # Per-input rows. Labels come from each input layer's row.
            inputs = []
            for step in (recipe.get("steps") or []):
                in_id = step.get("layer_id")
                if not in_id:
                    continue
                cur.execute("""
                    SELECT COALESCE(l.costum_name, m.title, l.layer_id) AS label,
                           m.unit_of_measure_id
                    FROM soil_data.layer l
                    LEFT JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                    WHERE l.layer_id = %s
                """, (in_id,))
                meta = cur.fetchone() or {}
                val = _sample(_resolve_input_path(path_cur, in_id))
                threshold = step.get("threshold")
                above = step.get("true_score", 1)
                below = step.get("false_score", 0)
                # Reclassify (engine op is '>='). NULL input → no contribution.
                if val is None or threshold is None:
                    reclass = None
                else:
                    reclass = above if val >= float(threshold) else below
                inputs.append({
                    "layer_id": in_id,
                    "label": meta.get("label") or in_id,
                    "unit_of_measure_id": meta.get("unit_of_measure_id"),
                    "value": val,
                    "threshold": threshold,
                    "below": below,
                    "above": above,
                    "reclass": reclass,
                })

    log_audit(None, api_client["api_client_id"], "dst_pixel_breakdown",
              {"layer_id": layer_id, "lon": lon, "lat": lat}, get_client_ip(request))
    return {
        "layer_id": layer_id,
        "lon": lon,
        "lat": lat,
        "aggregation": recipe.get("aggregation", "sum"),
        "output_value": output_value,
        "inputs": inputs,
    }


@app.get("/api/dst/recipes")
async def list_dst_recipes(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT * FROM api.dst_recipe
                ORDER BY updated_at DESC
            """)
            return [_dst_recipe_row_to_dict(r) for r in cur.fetchall()]


@app.post("/api/dst/recipes", status_code=status.HTTP_201_CREATED)
async def create_dst_recipe(
    payload: dict,
    current_user: dict = Depends(get_current_user)
):
    recipe_id = (payload.get("recipe_id") or "").strip()
    name = (payload.get("name") or "").strip()
    if not recipe_id:
        raise HTTPException(status_code=400, detail="recipe_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    recipe = payload.get("recipe") or {}
    if not isinstance(recipe, dict) or "steps" not in recipe:
        raise HTTPException(status_code=400, detail="recipe must be an object with a 'steps' array")

    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO api.dst_recipe (recipe_id, name, description, recipe, created_by)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (recipe_id) DO NOTHING
                RETURNING *
            """, (recipe_id, name, payload.get("description"),
                  psycopg2.extras.Json(recipe), current_user["user_id"]))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=409, detail=f"recipe_id '{recipe_id}' already exists")
            log_audit(current_user["user_id"], None, "dst_recipe_created",
                      {"recipe_id": recipe_id, "name": name}, None)
            return _dst_recipe_row_to_dict(row)


@app.get("/api/dst/recipes/{recipe_id}")
async def get_dst_recipe(recipe_id: str, current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM api.dst_recipe WHERE recipe_id = %s", (recipe_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recipe not found")
            return _dst_recipe_row_to_dict(row)


@app.put("/api/dst/recipes/{recipe_id}")
async def update_dst_recipe(
    recipe_id: str,
    payload: dict,
    current_user: dict = Depends(get_current_user)
):
    name = (payload.get("name") or "").strip()
    recipe = payload.get("recipe") or {}
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if not isinstance(recipe, dict) or "steps" not in recipe:
        raise HTTPException(status_code=400, detail="recipe must be an object with a 'steps' array")
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                UPDATE api.dst_recipe
                SET name = %s, description = %s, recipe = %s, updated_at = now()
                WHERE recipe_id = %s
                RETURNING *
            """, (name, payload.get("description"),
                  psycopg2.extras.Json(recipe), recipe_id))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recipe not found")
            log_audit(current_user["user_id"], None, "dst_recipe_updated",
                      {"recipe_id": recipe_id}, None)
            return _dst_recipe_row_to_dict(row)


@app.delete("/api/dst/recipes/{recipe_id}")
async def delete_dst_recipe(recipe_id: str, current_user: dict = Depends(get_current_user)):
    # Look up the produced layer first so we can clean up the raster + map
    # + pyCSW XML + soil_data rows along with the recipe row itself.
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT output_layer_id FROM api.dst_recipe WHERE recipe_id = %s
            """, (recipe_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recipe not found")
            output_layer_id = row[0]
            cur.execute("DELETE FROM api.dst_recipe WHERE recipe_id = %s", (recipe_id,))

    layer_cleanup = None
    if output_layer_id:
        layer_cleanup = _delete_layer_full(
            output_layer_id, current_user["user_id"], missing_ok=True)

    log_audit(current_user["user_id"], None, "dst_recipe_deleted",
              {"recipe_id": recipe_id, "output_layer_id": output_layer_id,
               "layer_cleanup": layer_cleanup}, None)
    return {
        "message": "Recipe deleted",
        "recipe_id": recipe_id,
        "output_layer_id": output_layer_id,
        "layer_cleanup": layer_cleanup,
    }


# ==================== DST: validate / run / runs ====================

def _output_layer_id_for_recipe(recipe_id: str, recipe: dict, conn=None) -> str:
    """The output layer_id IS the recipe_id. The SPA pre-fills the recipe_id
    input with <CC>-<PROJ>-<PROP>-<tail> so the user sees the same string
    they're saving. We sanitise to the characters that survive the SIS
    layer_id parser (A-Z, 0-9, dash, underscore) and uppercase for
    consistency.
    """
    safe_id = re.sub(r"[^A-Za-z0-9_-]+", "", recipe_id or "").upper().strip("-")
    return safe_id or "OUT"


def _dst_version_map_data(layer_id: str, raster_dir: str = "/srv/rasters") -> None:
    """Rewrite a DST layer's .map so its raster DATA points at a fresh,
    per-run filename — sidestepping MapServer's per-worker GDAL dataset
    cache (which is keyed by path and would otherwise keep serving the
    previous render after a re-run).

    Mechanism:
      * hardlink  <layer_id>.tif  →  <layer_id>.r<token>.tif  (same inode,
        new path; the download endpoint keeps using the canonical name)
      * rewrite the DATA "<layer_id>.tif" line in <layer_id>.map to the
        versioned name
      * remove stale <layer_id>.r*.tif hardlinks from earlier runs

    The .map is regenerated from scratch on every run (the DB trigger emits
    the canonical DATA, register dumps it to disk), so this post-step is
    idempotent per run.
    """
    map_path = os.path.join(raster_dir, f"{layer_id}.map")
    if not os.path.isfile(map_path):
        return
    with open(map_path, "r", encoding="utf-8") as fh:
        content = fh.read()

    # Find the layer's DATA line. Anchor on the start of a line so we don't
    # match the "DATA" inside "METADATA". The value it points at may be the
    # canonical <layer_id>.tif (fresh from register) OR a stale versioned
    # name left by a previous call — we ignore it and ALWAYS hardlink from
    # the canonical raster the engine just wrote.
    m = re.search(r'^\s*DATA\s+"([^"]+)"', content, re.MULTILINE)
    if not m:
        return
    current_data_name = m.group(1)
    ext = current_data_name.rsplit(".", 1)[-1] if "." in current_data_name else "tif"

    # The engine writes the canonical <layer_id>.<ext>; that's our hardlink
    # source (NOT whatever DATA currently says, which can be stale).
    canonical_path = os.path.join(raster_dir, f"{layer_id}.{ext}")
    if not os.path.isfile(canonical_path):
        return

    token = int(time.time() * 1000)
    versioned_name = f"{layer_id}.r{token}.{ext}"
    versioned_path = os.path.join(raster_dir, versioned_name)

    # Hardlink the freshly-written canonical raster under the versioned name.
    try:
        if not os.path.exists(versioned_path):
            os.link(canonical_path, versioned_path)
    except OSError:
        # Hardlink failed (e.g. cross-device) → fall back to a copy.
        import shutil
        shutil.copy2(canonical_path, versioned_path)

    # Point the .map's DATA line at the versioned file and persist.
    new_content = re.sub(r'(^\s*DATA\s+)"[^"]+"',
                         lambda mm: f'{mm.group(1)}"{versioned_name}"',
                         content, count=1, flags=re.MULTILINE)
    with open(map_path, "w", encoding="utf-8") as fh:
        fh.write(new_content)

    # Drop stale versioned hardlinks from earlier runs.
    for old in glob.glob(os.path.join(raster_dir, f"{layer_id}.r*.{ext}")):
        if os.path.abspath(old) != os.path.abspath(versioned_path):
            try:
                os.remove(old)
            except OSError:
                pass


def _execute_dst_run(recipe_id: str, triggered_by: str):
    """Background worker: load recipe, run engine, register output, update
    the run-state columns on api.dst_recipe directly. Each recipe owns at
    most one run; a rerun simply overwrites the prior state.

    Owns its own DB connection (separate from the request that spawned it).
    """
    from raster_registry.dst_engine import execute_recipe
    from raster_registry.register import register_raster, ContactRef  # noqa: F401

    def _mark(conn, **fields):
        if not fields:
            return
        cols = ", ".join(f"{k} = %s" for k in fields)
        vals = list(fields.values()) + [recipe_id]
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE api.dst_recipe SET {cols} WHERE recipe_id = %s", vals)
        conn.commit()

    out_path: Optional[str] = None
    try:
        with get_db() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT * FROM api.dst_recipe WHERE recipe_id = %s",
                            (recipe_id,))
                recipe_row = cur.fetchone()
            if not recipe_row:
                _mark(conn, run_status="failed",
                      run_error="recipe vanished mid-run",
                      run_finished_at=datetime.utcnow())
                return
            recipe = recipe_row["recipe"]

            _mark(conn, run_status="running")

            output_layer_id = _output_layer_id_for_recipe(recipe_id, recipe, conn)
            out_path = execute_recipe(
                conn, recipe, output_layer_id=output_layer_id)

            md = (recipe or {}).get("metadata", {}) or {}

            # Derive catalogue fields from the input layers' mapsets so the
            # generated output inherits sensible defaults:
            #   * time_period_begin = MIN over inputs
            #   * time_period_end   = MAX over inputs
            #   * other_constraints = license of the first input (inputs
            #     usually share the same license inside a recipe).
            input_layer_ids = [
                s.get("layer_id") for s in (recipe.get("steps") or [])
                if s.get("layer_id")
            ]
            dst_time_begin = None
            dst_time_end = None
            dst_license = None
            if input_layer_ids:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT MIN(m.time_period_begin) AS time_begin,
                               MAX(m.time_period_end)   AS time_end,
                               (
                                 SELECT m2.other_constraints
                                 FROM soil_data.layer l2
                                 JOIN soil_data.mapset m2 ON m2.mapset_id = l2.mapset_id
                                 WHERE l2.layer_id = ANY(%s)
                                   AND m2.other_constraints IS NOT NULL
                                 ORDER BY l2.layer_id
                                 LIMIT 1
                               ) AS license
                        FROM soil_data.layer l
                        JOIN soil_data.mapset m ON m.mapset_id = l.mapset_id
                        WHERE l.layer_id = ANY(%s)
                    """, (input_layer_ids, input_layer_ids))
                    row = cur.fetchone()
                    if row:
                        dst_time_begin = row[0].isoformat() if row[0] else None
                        dst_time_end   = row[1].isoformat() if row[1] else None
                        dst_license    = row[2]

            try:
                # DST outputs have no upstream user-picked filename. Synthesise
                # one from the output_layer_id so soil_data.layer.file_orig_name
                # (NOT NULL UNIQUE) is satisfied.
                registered = register_raster(
                    conn, out_path,
                    title=md.get("title_override") or recipe_row["name"],
                    abstract=md.get("abstract_override") or recipe_row["description"],
                    keywords=md.get("keywords"),
                    publish=bool(md.get("publish_to_catalogue", True)),
                    dst_recipe_id=recipe_id,
                    file_orig_name=f"{output_layer_id}.tif",
                    unit_of_measure_id="dimensionless",
                    publication_date=datetime.utcnow().date().isoformat(),
                    time_period_begin=dst_time_begin,
                    time_period_end=dst_time_end,
                    license=dst_license,
                    # Every DST output is tagged with these theme keywords.
                    extra_keywords_theme=["soil", "digital support tool"],
                )
                conn.commit()
                metadata_status = "succeeded" if registered.xml_published else "failed"
                metadata_error = (
                    "; ".join(registered.warnings) if registered.warnings else None
                )
                # For DST outputs 0 is the nodata sentinel (the .map carries
                # PROCESSING "NODATA=0"). inspect() therefore reports
                # stats_minimum=0, which would put nodata inside the colour
                # ramp (DATARANGE 0 …). Recompute the minimum over the
                # non-zero values and write it back — that re-fires the map +
                # class triggers so DATARANGE / class intervals span the real
                # data — then re-dump the .map to disk before versioning it.
                try:
                    import rasterio as _rio
                    import numpy as _np
                    with _rio.open(out_path) as _src:
                        _band = _src.read(1, masked=True)
                    _nz = _band.compressed()
                    _nz = _nz[_nz != 0]
                    if _nz.size:
                        _real_min = float(_nz.min())
                        with conn.cursor() as _cur:
                            _cur.execute(
                                "UPDATE soil_data.layer SET stats_minimum = %s WHERE layer_id = %s",
                                (_real_min, output_layer_id))
                            _cur.execute(
                                "SELECT map FROM soil_data.layer WHERE layer_id = %s",
                                (output_layer_id,))
                            _row = _cur.fetchone()
                        conn.commit()
                        if _row and _row[0]:
                            with open(os.path.join("/srv/rasters", f"{output_layer_id}.map"),
                                      "w", encoding="utf-8") as _fh:
                                _fh.write(_row[0])
                except Exception:
                    log.exception("DST recipe %s: stats_minimum (non-zero) refresh failed",
                                  recipe_id)
                # Defeat MapServer's per-worker GDAL dataset cache: point the
                # .map's DATA at a fresh, per-run filename (a hardlink to the
                # canonical <layer_id>.tif). GDAL caches by path, so a new
                # path forces a fresh read of the just-written raster without
                # restarting MapServer workers.
                try:
                    _dst_version_map_data(output_layer_id)
                except Exception:
                    log.exception("DST recipe %s: map cache-version failed", recipe_id)
            except Exception as e:
                conn.rollback()
                log.exception("DST recipe %s: registrar failed", recipe_id)
                metadata_status = "failed"
                metadata_error = f"{type(e).__name__}: {e}"

            _mark(conn,
                  run_status="succeeded",
                  run_error=None,               # clear any error from a prior failed run
                  metadata_status=metadata_status,
                  metadata_error=metadata_error,
                  output_layer_id=output_layer_id,
                  run_finished_at=datetime.utcnow())
    except Exception as e:
        log.exception("DST recipe %s run failed", recipe_id)
        try:
            with get_db() as conn2:
                _mark(conn2, run_status="failed",
                      run_error=f"{type(e).__name__}: {e}",
                      run_finished_at=datetime.utcnow())
        except Exception:
            log.exception("DST recipe %s: also failed to record failure", recipe_id)
        if out_path and os.path.exists(out_path):
            try:
                os.remove(out_path)
            except OSError:
                pass


@app.post("/api/dst/recipes/{recipe_id}/validate")
async def validate_dst_recipe(
    recipe_id: str,
    current_user: dict = Depends(get_current_user),
):
    from raster_registry.dst_engine import validate_recipe
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT recipe FROM api.dst_recipe WHERE recipe_id = %s",
                        (recipe_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recipe not found")
        return validate_recipe(conn, row["recipe"])


@app.post("/api/dst/recipes/{recipe_id}/run", status_code=status.HTTP_202_ACCEPTED)
async def run_dst_recipe(
    recipe_id: str,
    background: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    from raster_registry.dst_engine import validate_recipe
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT recipe FROM api.dst_recipe WHERE recipe_id = %s",
                        (recipe_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recipe not found")
        report = validate_recipe(conn, row["recipe"])
        if not report["ok"]:
            raise HTTPException(status_code=400,
                                detail={"message": "recipe failed validation",
                                        "report": report})
        # Mark the recipe row as queued. Re-running overwrites whatever
        # previous run state was on it; api.dst_run is gone.
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE api.dst_recipe
                SET run_status         = 'queued',
                    run_started_at     = now(),
                    run_finished_at    = NULL,
                    run_error          = NULL,
                    metadata_status    = NULL,
                    metadata_error     = NULL,
                    run_triggered_by   = %s
                WHERE recipe_id = %s
            """, (current_user["user_id"], recipe_id))
        conn.commit()

    background.add_task(_execute_dst_run, recipe_id, current_user["user_id"])
    log_audit(current_user["user_id"], None, "dst_run_queued",
              {"recipe_id": recipe_id}, None)
    return {
        "recipe_id": recipe_id,
        "status": "queued",
    }


@app.post("/api/dst/recipes/{recipe_id}/regenerate_metadata")
async def regenerate_dst_metadata(
    recipe_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Re-render XML + reload pyCSW for the current output without re-running
    the engine. Cheap path when only catalogue fields changed."""
    from raster_registry.xml_render import render_xml
    from raster_registry.pycsw_load import write_xml_and_load
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT output_layer_id FROM api.dst_recipe WHERE recipe_id = %s",
                        (recipe_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recipe not found")
            if not row["output_layer_id"]:
                raise HTTPException(status_code=409,
                                    detail="Recipe has no output yet — run it first")
            output_layer_id = row["output_layer_id"]
        xml_content = render_xml(conn, output_layer_id)
        conn.commit()
    result = write_xml_and_load(output_layer_id, xml_content)
    log_audit(current_user["user_id"], None, "dst_metadata_regenerated",
              {"recipe_id": recipe_id, "output_layer_id": output_layer_id}, None)
    return {
        "output_layer_id": output_layer_id,
        "xml_path": result.get("xml_path"),
        "transaction_ok": result.get("transaction_ok"),
        "transaction_error": result.get("transaction_error"),
    }


# ==================== Raster registry — inspect ====================
# Given a TIFF path inside the sis-web-services volume (or uploaded as
# multipart), return everything soil_data.layer would store. Does NOT
# write to the DB — used by the Add-Raster UI to populate the form.

@app.post("/api/raster/inspect")
async def inspect_raster(
    file: Optional[UploadFile] = File(None),
    path: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user),
):
    """Inspect a GeoTIFF. Either upload via multipart (`file`) OR pass a
    path inside the sis-web-services volume (`path`)."""
    from raster_registry.inspect import inspect_geotiff, ensure_nodata

    tmp_path = None
    try:
        if file is not None:
            # Stream to /tmp so rasterio can open by path.
            import tempfile
            suffix = os.path.splitext(file.filename or "")[1] or ".tif"
            fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="raster_inspect_")
            with os.fdopen(fd, "wb") as out:
                while chunk := await file.read(1 << 20):  # 1 MB chunks
                    out.write(chunk)
            tif_path = tmp_path
            # Auto-assign NoData when the upload has none, so the inspect result
            # (and thus the preview + the no-NoData validation rule + masked
            # stats) reflects what register will persist — no manual pre-clean.
            try:
                ensure_nodata(tif_path)
            except Exception:
                log.exception("inspect: ensure_nodata failed for %s", tif_path)
        elif path:
            # Allow only paths inside the MapServer volume — this prevents an
            # admin from reading arbitrary files on disk via this endpoint.
            base = "/srv/rasters"   # bind-mount target inside sis-api (see compose)
            tif_path = os.path.realpath(os.path.join(base, path))
            if not tif_path.startswith(base + os.sep) and tif_path != base:
                raise HTTPException(status_code=400, detail="path must resolve inside /srv/rasters")
            if not os.path.exists(tif_path):
                raise HTTPException(status_code=404, detail=f"File not found: {path}")
        else:
            raise HTTPException(status_code=400,
                                detail="Provide either `file` (multipart) or `path` (form)")
        try:
            meta = inspect_geotiff(tif_path)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to inspect raster: {e}")
        return meta.model_dump()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try: os.unlink(tmp_path)
            except OSError: pass


# ==================== Raster registry — register ====================
# Calls raster_registry.register_raster() end-to-end: inspect → populate
# soil_data.* (triggers .map/.sld) → render ISO 19139 XML → load into pyCSW.

@app.post("/api/raster/register", status_code=status.HTTP_201_CREATED)
async def register_raster_endpoint(
    file: Optional[UploadFile] = File(None),
    path: Optional[str] = Form(None),
    project_name: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    abstract: Optional[str] = Form(None),
    keywords: Optional[str] = Form(None),         # comma-separated
    license: Optional[str] = Form(None),
    publish: bool = Form(True),
    publication_date: Optional[str] = Form(None), # YYYY-MM-DD
    property_num_id: Optional[str] = Form(None),  # FK on soil_data.mapped_property
    unit_of_measure_id: Optional[str] = Form(None),  # FK on soil_data.mapset
    time_period_begin: Optional[str] = Form(None),  # YYYY-MM-DD
    time_period_end: Optional[str] = Form(None),    # YYYY-MM-DD
    file_orig_name: Optional[str] = Form(None),     # filename as picked by the user
    current_user: dict = Depends(get_current_user),
):
    """Register a GeoTIFF as a SIS layer.

    Either upload via multipart (`file`) — the TIFF is moved into the
    MapServer volume at `<layer_id>.tif` — OR pass `path=<filename>` for a
    file already in `/srv/rasters/`.

    Returns the new layer record. Note: XML / pyCSW step is not yet wired,
    so the metadata catalogue won't show the new layer until that lands.
    """
    from raster_registry import register_raster
    from raster_registry.inspect import inspect_geotiff
    import shutil

    base = "/srv/rasters"
    target_path: Optional[str] = None
    moved_from_tmp: Optional[str] = None
    try:
        if file is not None:
            # Stream the upload to a temp file, inspect to determine the
            # layer_id, then move into /srv/rasters/<layer_id>.tif.
            import tempfile
            suffix = os.path.splitext(file.filename or "")[1] or ".tif"
            fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="raster_register_")
            moved_from_tmp = tmp_path
            with os.fdopen(fd, "wb") as out:
                while chunk := await file.read(1 << 20):
                    out.write(chunk)
            # Derive layer_id from filename — uploaded name is authoritative
            layer_id = os.path.splitext(file.filename or "")[0]
            target_path = os.path.join(base, f"{layer_id}.tif")
            shutil.move(tmp_path, target_path)
            # mkstemp creates 0600 and move preserves it — but MapServer and
            # nginx run as different uids and must read this file (WMS render
            # + /downloads). World-readable like every other published raster.
            os.chmod(target_path, 0o644)
            moved_from_tmp = None
        elif path:
            cand = os.path.realpath(os.path.join(base, path))
            if not (cand == base or cand.startswith(base + os.sep)):
                raise HTTPException(status_code=400, detail="path must resolve inside /srv/rasters")
            if not os.path.exists(cand):
                raise HTTPException(status_code=404, detail=f"File not found: {path}")
            target_path = cand
        else:
            raise HTTPException(status_code=400,
                                detail="Provide either `file` (multipart) or `path` (form)")

        # Assign a NoData value now — after the file is in place, before
        # populate / .map / metadata — instead of rejecting rasters that ship
        # without one. Best-effort: a failure here must not abort registration.
        try:
            from raster_registry.inspect import ensure_nodata
            assigned_nd = ensure_nodata(target_path)
            if assigned_nd is not None:
                log.info("register: assigned NoData=%s to %s", assigned_nd, target_path)
        except Exception:
            log.exception("register: ensure_nodata failed for %s", target_path)

        # Store every registered raster as a Cloud-Optimised GeoTIFF (tiled +
        # overviews + DEFLATE), same as the Raster-calculator outputs — MapServer
        # renders it faster and it's a valid COG for direct download. Runs after
        # ensure_nodata so the NoData value is carried into the COG. Best-effort:
        # a conversion failure must not abort registration.
        try:
            from raster_registry.inspect import to_cog
            to_cog(target_path)
            log.info("register: converted %s to COG", target_path)
        except Exception:
            log.exception("register: COG conversion failed for %s", target_path)

        keyword_list = [k.strip() for k in (keywords or "").split(",") if k.strip()] or None

        with get_db() as conn:
            try:
                result = register_raster(
                    conn, target_path,
                    project_name=project_name,
                    title=title,
                    abstract=abstract,
                    keywords=keyword_list,
                    license=license,
                    publish=publish,
                    publication_date=publication_date,
                    property_num_id=property_num_id,
                    unit_of_measure_id=unit_of_measure_id,
                    time_period_begin=time_period_begin,
                    time_period_end=time_period_end,
                    file_orig_name=file_orig_name,
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except psycopg2.errors.UniqueViolation:
                # e.g. soil_data.layer.file_orig_name UNIQUE constraint —
                # the same file has already been registered.
                conn.rollback()
                raise HTTPException(status_code=409,
                                    detail="This file has already been uploaded.")
            except psycopg2.IntegrityError as e:
                conn.rollback()
                raise HTTPException(status_code=409, detail=f"Integrity error: {e}")

        log_audit(current_user["user_id"], None, "raster_registered",
                  {"layer_id": result.layer_id, "warnings": result.warnings},
                  None)
        return result.model_dump()

    finally:
        if moved_from_tmp and os.path.exists(moved_from_tmp):
            try: os.unlink(moved_from_tmp)
            except OSError: pass


# ==================== Raster registry — codelists ====================
# Read endpoints over soil_data.* tables, for the Add-Raster /
# DST UI to populate project/property/individual/organisation pickers.

@app.get("/api/raster/projects")
async def list_smd_projects(
    country_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if country_id:
                cur.execute("""
                    SELECT country_id, project_id, name, description
                    FROM soil_data.project
                    WHERE country_id = %s
                    ORDER BY project_id
                """, (country_id,))
            else:
                cur.execute("""
                    SELECT country_id, project_id, name, description
                    FROM soil_data.project
                    ORDER BY country_id, project_id
                """)
            return cur.fetchall()


@app.post("/api/raster/projects", status_code=status.HTTP_201_CREATED)
async def create_smd_project(payload: dict, current_user: dict = Depends(get_current_user)):
    project_id = (payload.get("project_id") or "").strip()
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")
    _validate_project_id(project_id)
    # soil_data.project.name is NOT NULL UNIQUE — fall back to project_id.
    name = (payload.get("project_name") or "").strip() or project_id
    description = (payload.get("description") or "").strip() or None
    with get_db() as conn:
        with conn.cursor() as cur:
            # New projects always belong to THIS instance's country.
            country_id = _instance_country_code(cur)
            cur.execute("""
                INSERT INTO soil_data.project (country_id, project_id, name, description)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (country_id, project_id) DO UPDATE SET
                    description = COALESCE(EXCLUDED.description, soil_data.project.description)
            """, (country_id, project_id, name, description))
    log_audit(current_user["user_id"], None, "smd_project_created",
              {"country_id": country_id, "project_id": project_id}, None)
    return {"country_id": country_id, "project_id": project_id, "description": description}


@app.get("/api/raster/properties")
async def list_smd_properties(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT mapped_property_id, name, property_num_id,
                       min, max, property_type
                FROM soil_data.mapped_property
                ORDER BY mapped_property_id
            """)
            return cur.fetchall()


@app.get("/api/raster/metadata/{layer_id}")
async def get_raster_metadata(
    layer_id: str,
    api_client: dict = Depends(verify_api_key),
):
    """Rich metadata for a raster layer — used by the SPA's info popup.

    Pulls from soil_data.layer, mapset, project, country, mapped_property,
    property_num, unit_of_measure, proj_x_org_x_ind, individual, organisation,
    url. Returns a flat JSON with sections the SPA can render.
    """
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT
                  l.layer_id,
                  l.file_extension, l.file_size, l.file_size_pretty, l.file_orig_name,
                  l.dimension_depth, l.dimension_stats, l.is_default, l.is_published,
                  l.stats_minimum, l.stats_maximum, l.stats_mean, l.stats_std_dev,
                  l.distance, l.distance_uom,
                  l.reference_system_identifier_code AS epsg,
                  l.spatial_reference,
                  l.west_bound_longitude, l.east_bound_longitude,
                  l.south_bound_latitude, l.north_bound_latitude,
                  l.costum_name,
                  l.no_data_value, l.data_type, l.raster_size_x, l.raster_size_y,
                  m.mapset_id, m.title, m.abstract,
                  m.file_identifier::text AS file_identifier,
                  m.creation_date, m.publication_date, m.revision_date,
                  m.time_period_begin, m.time_period_end,
                  m.access_constraints, m.use_constraints, m.other_constraints,
                  m.spatial_representation_type_code, m.presentation_form,
                  m.scope_code, m.status, m.update_frequency,
                  m.lineage_statement, m.topic_category, m.keyword_theme,
                  m.keyword_place, m.keyword_discipline, m.costum_group,
                  m.unit_of_measure_id, m.md_browse_graphic,
                  c.en AS country_name, m.country_id,
                  p.project_id, p.name AS project_name, p.description AS project_description,
                  mp.mapped_property_id, mp.name AS mapped_property_name,
                  pn.property_num_id, pn.property_name
                FROM soil_data.layer l
                LEFT JOIN soil_data.mapset m  ON m.mapset_id = l.mapset_id
                LEFT JOIN soil_data.country c ON c.country_id = m.country_id
                LEFT JOIN soil_data.project p ON p.country_id = m.country_id AND p.project_id = m.project_id
                LEFT JOIN soil_data.mapped_property mp ON mp.mapped_property_id = m.mapped_property_id
                LEFT JOIN soil_data.property_num pn ON pn.property_num_id = mp.property_num_id
                WHERE l.layer_id = %s
            """, (layer_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Layer not found")
            mapset_id = row["mapset_id"]

            cur.execute("""
                SELECT x.organisation_id, x.individual_id, x.position, x.tag, x.role,
                       i.email AS individual_email,
                       o.country AS organisation_country, o.city AS organisation_city,
                       o.email AS organisation_email
                FROM soil_data.proj_x_org_x_ind x
                LEFT JOIN soil_data.individual   i ON i.individual_id   = x.individual_id
                LEFT JOIN soil_data.organisation o ON o.organisation_id = x.organisation_id
                LEFT JOIN soil_data.mapset       m2
                       ON x.country_id = m2.country_id AND x.project_id = m2.project_id
                WHERE m2.mapset_id = %s
                ORDER BY x.tag, x.role, i.individual_id
            """, (mapset_id,))
            contacts = cur.fetchall()

            cur.execute("""
                SELECT protocol, url, url_name, url_description
                FROM soil_data.url WHERE mapset_id = %s ORDER BY protocol
            """, (mapset_id,))
            urls = cur.fetchall()

    # Stringify dates so JSON serialises cleanly.
    for k in ("creation_date","publication_date","revision_date",
              "time_period_begin","time_period_end"):
        if row.get(k):
            row[k] = row[k].isoformat()
    row["contacts"] = contacts
    row["online_resources"] = urls
    return row


@app.get("/api/raster/countries")
async def list_smd_countries(current_user: dict = Depends(get_current_user)):
    """List countries with `en` name. The country matching the
    COUNTRY_CODE setting (api.setting) is returned first; the rest follow
    alphabetically by `en`."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT value FROM api.setting WHERE key = 'COUNTRY_CODE'")
            row = cur.fetchone()
            default_cc = (row["value"] if row else "").strip().upper() or None
            cur.execute("""
                SELECT country_id, en FROM soil_data.country
                WHERE en IS NOT NULL
                ORDER BY (country_id = %s) DESC, en
            """, (default_cc,))
            return cur.fetchall()


@app.get("/api/raster/file_exists")
async def raster_file_exists(
    file_orig_name: str,
    current_user: dict = Depends(get_current_user),
):
    """Cheap up-front check before the user fills the form: is there
    already a soil_data.layer row with this `file_orig_name`?"""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT layer_id FROM soil_data.layer WHERE file_orig_name = %s LIMIT 1",
                (file_orig_name,),
            )
            row = cur.fetchone()
            return {"exists": bool(row), "layer_id": row[0] if row else None}


@app.get("/api/raster/observation_limits/{property_num_id}/{unit_id}")
async def observation_limits(
    property_num_id: str,
    unit_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Plausible value range for a property in a given unit.

    Aggregates min(value_min) / max(value_max) across all
    soil_data.observation_num rows for the property, then converts the
    result to the requested unit via soil_data.unit_conversion (forward
    or reverse). Returns {value_min, value_max, canonical_unit, converted}.
    The caller adds its own tolerance band.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            # The Upload GeoTIFF dropdown now sends a mapped_property_id —
            # resolve it to the catalogue property_num_id. Falls back to
            # treating the path value as a property_num_id directly so older
            # callers still work. When the mapped_property has no FK link,
            # there's nothing to compare against → return empty limits.
            cur.execute("""
                SELECT property_num_id FROM soil_data.mapped_property
                WHERE mapped_property_id = %s
            """, (property_num_id,))
            row = cur.fetchone()
            is_mapped_property = row is not None
            resolved_prop = row[0] if row else property_num_id
            if is_mapped_property and resolved_prop is None:
                return {"value_min": None, "value_max": None,
                        "canonical_unit": None, "converted": False}

            cur.execute("""
                SELECT MIN(value_min) AS lo, MAX(value_max) AS hi
                FROM soil_data.observation_num
                WHERE property_num_id = %s
                  AND value_min IS NOT NULL AND value_max IS NOT NULL
            """, (resolved_prop,))
            row = cur.fetchone()
            if not row or row[0] is None or row[1] is None:
                return {"value_min": None, "value_max": None,
                        "canonical_unit": None, "converted": False}
            lo, hi = float(row[0]), float(row[1])

            cur.execute("""
                SELECT unit_of_measure_id
                FROM soil_data.observation_num
                WHERE property_num_id = %s
                  AND unit_of_measure_id IS NOT NULL
                GROUP BY unit_of_measure_id
                ORDER BY count(*) DESC
                LIMIT 1
            """, (resolved_prop,))
            row = cur.fetchone()
            canonical = row[0] if row else None

            if not canonical or canonical == unit_id:
                return {"value_min": lo, "value_max": hi,
                        "canonical_unit": canonical, "converted": False}

            # Forward conversion: canonical → user
            cur.execute("""
                SELECT operation, value
                FROM soil_data.unit_conversion
                WHERE unit_from = %s AND unit_to = %s
                LIMIT 1
            """, (canonical, unit_id))
            row = cur.fetchone()
            if row:
                op, val = row[0], float(row[1])
                if op == "*":   lo, hi = lo * val, hi * val
                elif op == "/": lo, hi = lo / val, hi / val
                else:
                    return {"value_min": None, "value_max": None,
                            "canonical_unit": canonical, "converted": False}
                return {"value_min": lo, "value_max": hi,
                        "canonical_unit": canonical, "converted": True}

            # Reverse conversion: user → canonical, invert it
            cur.execute("""
                SELECT operation, value
                FROM soil_data.unit_conversion
                WHERE unit_from = %s AND unit_to = %s
                LIMIT 1
            """, (unit_id, canonical))
            row = cur.fetchone()
            if row:
                op, val = row[0], float(row[1])
                if op == "*":   lo, hi = lo / val, hi / val      # invert *
                elif op == "/": lo, hi = lo * val, hi * val      # invert /
                else:
                    return {"value_min": None, "value_max": None,
                            "canonical_unit": canonical, "converted": False}
                return {"value_min": lo, "value_max": hi,
                        "canonical_unit": canonical, "converted": True}

            return {"value_min": None, "value_max": None,
                    "canonical_unit": canonical, "converted": False}


@app.get("/api/raster/units_for_property/{property_num_id}")
async def list_smd_units_for_property(
    property_num_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Units valid for a given mapped_property: every canonical unit attached
    to observation_num rows for the property_num the mapped_property points
    at, plus every unit convertible to any of those canonicals. When the
    mapped_property has no property_num_id link (e.g. freshly added via the
    Upload GeoTIFF form), fall back to returning ALL units so the user can
    pick any. The path param is named `property_num_id` for back-compat — it
    accepts either a property_num_id or a mapped_property_id."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Resolve the canonical property_num_id. If the path value is a
            # mapped_property_id, follow its FK; otherwise treat it as a
            # property_num_id directly.
            cur.execute("""
                SELECT property_num_id FROM soil_data.mapped_property
                WHERE mapped_property_id = %s
            """, (property_num_id,))
            row = cur.fetchone()
            is_mapped_property = row is not None
            resolved_prop = row["property_num_id"] if row else property_num_id

            # No property_num link → return the full unit catalogue.
            if is_mapped_property and resolved_prop is None:
                cur.execute("""
                    SELECT unit_of_measure_id, unit_name
                    FROM soil_data.unit_of_measure
                    ORDER BY unit_name NULLS LAST, unit_of_measure_id
                """)
                return cur.fetchall()

            cur.execute("""
                WITH canonicals AS (
                  SELECT DISTINCT unit_of_measure_id
                  FROM soil_data.observation_num
                  WHERE property_num_id = %s AND unit_of_measure_id IS NOT NULL
                ),
                source_convertible AS (
                  SELECT DISTINCT c.unit_from AS unit_of_measure_id
                  FROM soil_data.unit_conversion c
                  JOIN canonicals k ON k.unit_of_measure_id = c.unit_to
                )
                SELECT u.unit_of_measure_id, u.unit_name
                FROM soil_data.unit_of_measure u
                WHERE u.unit_of_measure_id IN (
                  SELECT unit_of_measure_id FROM canonicals
                  UNION
                  SELECT unit_of_measure_id FROM source_convertible
                )
                ORDER BY u.unit_name NULLS LAST, u.unit_of_measure_id
            """, (resolved_prop,))
            return cur.fetchall()


@app.get("/api/raster/mapped_soil_properties")
async def list_smd_mapped_soil_properties(current_user: dict = Depends(get_current_user)):
    """mapped_property catalogue — used by Upload GeoTIFF to pick the PROP
    component of the layer id (filename convention <CC>-<PROJ>-<PROP>-...)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT mapped_property_id, name
                FROM soil_data.mapped_property
                WHERE name IS NOT NULL
                ORDER BY name
            """)
            return cur.fetchall()


@app.post("/api/raster/mapped_soil_properties", status_code=status.HTTP_201_CREATED)
async def create_smd_mapped_soil_property(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Add a row to soil_data.mapped_property from the Upload GeoTIFF form's
    inline "+ Add new mapped soil property…" panel. Only id + name are
    accepted; the rest of the row gets the same quantitative defaults the
    raster registrar uses for DST-minted stubs."""
    mpid = (payload.get("mapped_property_id") or "").strip().upper()
    name = (payload.get("name") or "").strip()
    min_val = payload.get("min")
    max_val = payload.get("max")
    property_type = (payload.get("property_type") or "quantitative").strip().lower()
    if property_type not in ("quantitative", "categorical"):
        raise HTTPException(status_code=400,
                            detail="property_type must be 'quantitative' or 'categorical'")
    if not mpid:
        raise HTTPException(status_code=400, detail="mapped_property_id is required")
    if not re.fullmatch(r"[A-Z0-9_]+", mpid):
        raise HTTPException(status_code=400,
                            detail="mapped_property_id must be CAPS (A-Z, 0-9, _)")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    # Both ramps default to 10 buckets; colour ramps differ to match the
    # convention in the seed data. Callers (e.g. the DST tab) can override
    # the colours by passing explicit start_color / end_color hex strings.
    num_intervals = 10
    if property_type == "quantitative":
        start_color, end_color = "#a50026", "#1a9850"
    else:
        start_color, end_color = "#CA0020", "#3F68E2"
    if payload.get("start_color"):
        start_color = str(payload["start_color"]).strip()
    if payload.get("end_color"):
        end_color = str(payload["end_color"]).strip()
    with get_db() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO soil_data.mapped_property
                        (mapped_property_id, name, min, max, property_type,
                         num_intervals, start_color, end_color)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (mpid, name, min_val, max_val, property_type,
                      num_intervals, start_color, end_color))
            except psycopg2.errors.UniqueViolation:
                raise HTTPException(status_code=409,
                                    detail=f"mapped_property_id '{mpid}' already exists")
    log_audit(current_user['user_id'], None, "mapped_property_created",
              {"mapped_property_id": mpid, "name": name,
               "min": min_val, "max": max_val,
               "property_type": property_type}, None)
    return {"mapped_property_id": mpid, "name": name,
            "min": min_val, "max": max_val,
            "property_type": property_type}


@app.get("/api/raster/individuals")
async def list_smd_individuals(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT individual_id, email FROM soil_data.individual
                ORDER BY individual_id
            """)
            return cur.fetchall()


@app.post("/api/raster/individuals", status_code=status.HTTP_201_CREATED)
async def create_smd_individual(payload: dict, current_user: dict = Depends(get_current_user)):
    iid = (payload.get("individual_id") or "").strip()
    if not iid:
        raise HTTPException(status_code=400, detail="individual_id is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO soil_data.individual (individual_id, email)
                VALUES (%s, %s)
                ON CONFLICT (individual_id) DO NOTHING
            """, (iid, payload.get("email")))
    log_audit(current_user["user_id"], None, "smd_individual_created",
              {"individual_id": iid}, None)
    return {"individual_id": iid}


@app.get("/api/raster/organisations")
async def list_smd_organisations(current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT organisation_id, url, email, country, city, postal_code,
                       delivery_point, phone, facsimile
                FROM soil_data.organisation
                ORDER BY organisation_id
            """)
            return cur.fetchall()


@app.post("/api/raster/organisations", status_code=status.HTTP_201_CREATED)
async def create_smd_organisation(payload: dict, current_user: dict = Depends(get_current_user)):
    oid = (payload.get("organisation_id") or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="organisation_id is required")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO soil_data.organisation
                    (organisation_id, url, email, country, city, postal_code,
                     delivery_point, phone, facsimile)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (organisation_id) DO NOTHING
            """, (oid, payload.get("url"), payload.get("email"),
                  payload.get("country"), payload.get("city"),
                  payload.get("postal_code"), payload.get("delivery_point"),
                  payload.get("phone"), payload.get("facsimile")))
    log_audit(current_user["user_id"], None, "smd_organisation_created",
              {"organisation_id": oid}, None)
    return {"organisation_id": oid}


@app.get("/")
async def root():
    return {
        "message": "SIS Admin API",
        "version": "1.0.0",
        "docs": "/docs",
        "authentication": "POST /api/auth/login to get a JWT token"
    }

@app.get("/health")
async def health_check():
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return {"status": "healthy"}
    except Exception:
        # Don't leak DB error strings (may include creds/hostnames) to anonymous callers.
        return {"status": "unhealthy"}
