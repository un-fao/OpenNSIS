"""
Shared configuration, database connection, Pydantic models,
and authentication utilities — used by sis-api and sis-api-glosis.
"""

from fastapi import Depends, HTTPException, status, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional, Annotated, List
from datetime import datetime, timedelta
import psycopg2
from psycopg2.extras import RealDictCursor
import jwt
from jwt import InvalidTokenError
import bcrypt
import secrets
import os
from contextlib import contextmanager

# ==================== Configuration ====================

SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST"),
    "port": os.getenv("POSTGRES_PORT"),
    "database": os.getenv("POSTGRES_DB"),
    "user": os.getenv("POSTGRES_USER"),
    "password": os.getenv("POSTGRES_PASSWORD")
}

security = HTTPBearer()

# ==================== Database Connection ====================

@contextmanager
def get_db():
    """Database connection context manager"""
    conn = psycopg2.connect(**DB_CONFIG)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

# ==================== Pydantic Models ====================

class UserLogin(BaseModel):
    user_id: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

class User(BaseModel):
    user_id: str
    is_active: bool
    is_admin: bool
    can_edit_data: bool = False         # may edit profile data (Database tab)
    created_at: datetime
    last_login: Optional[datetime] = None

class UserCreate(BaseModel):
    user_id: str
    password: str
    is_admin: bool = False

class UserSelfUpdate(BaseModel):
    current_password: str
    new_user_id: Optional[str] = None
    new_password: Optional[str] = None

class LegendClass(BaseModel):
    value: float                        # lower bound (quantitative) / category value
    label: str
    color: str                          # #rrggbb, same row the SLD/mapfile uses

class Layer(BaseModel):
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    layer_id: str
    publish: bool = True
    property_name: Optional[str] = None
    dimension: Optional[str] = None
    dimension_stats: Optional[str] = None
    year: Optional[int] = None          # EXTRACT(YEAR FROM mapset.creation_date)
    stats_minimum: Optional[float] = None
    stats_maximum: Optional[float] = None
    no_data_value: Optional[float] = None
    property_type: Optional[str] = None  # quantitative | categorical
    custom_classes: Optional[bool] = False  # mapset uses hand-defined class breaks
    default_opacity: Optional[float] = None  # initial map-view opacity (0-1; None = 1)
    display_order: Optional[int] = None    # map panel position (lower first, None last)
    legend_classes: Optional[List[LegendClass]] = None  # soil_data.class rows
    version: Optional[str] = None
    unit_of_measure_id: Optional[str] = None
    metadata_url: Optional[str] = None
    download_url: Optional[str] = None
    get_map_url: Optional[str] = None
    get_legend_url: Optional[str] = None
    get_feature_info_url: Optional[str] = None
    is_default: Optional[bool] = False
    keywords: Optional[List[str]] = None
    is_dst: Optional[bool] = False

class LayerCreate(BaseModel):
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    layer_id: str
    publish: bool = True
    property_name: Optional[str] = None
    dimension: Optional[str] = None
    version: Optional[str] = None
    unit_of_measure_id: Optional[str] = None
    metadata_url: Optional[str] = None
    download_url: Optional[str] = None
    get_map_url: Optional[str] = None
    get_legend_url: Optional[str] = None
    get_feature_info_url: Optional[str] = None

class PublishUpdate(BaseModel):
    publish: bool

class Setting(BaseModel):
    key: str
    value: str

class SettingCreate(BaseModel):
    key: str
    value: str

class SettingUpdate(BaseModel):
    value: str

class APIClient(BaseModel):
    api_client_id: str
    is_active: bool
    created_at: datetime
    expires_at: Optional[datetime] = None
    description: str

class APIClientCreate(BaseModel):
    api_client_id: str
    description: str
    expires_at: Optional[datetime] = None

# ==================== Auth Utility Functions ====================

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    now = datetime.utcnow()
    expire = now + (expires_delta or timedelta(minutes=15))
    # iat (issued-at) is used by get_current_user to invalidate tokens whose
    # owners have rotated their password since the token was issued.
    to_encode.update({"exp": expire, "iat": now})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def generate_api_key() -> str:
    return secrets.token_urlsafe(32)

def get_client_ip(request) -> Optional[str]:
    """Return the real client IP, trusting X-Forwarded-For from the upstream
    proxy (sis-nginx in our deployment). Falls back to the direct connection
    address. NOTE: in dev, backend ports may be reachable directly, in which
    case the header can be spoofed — pin trusted proxy IPs at the front
    door before relying on these audit logs for forensics.
    """
    xff = request.headers.get("x-forwarded-for") if hasattr(request, "headers") else None
    if xff:
        return xff.split(",")[0].strip()
    client = getattr(request, "client", None)
    return client.host if client else None

def log_audit(user_id: Optional[str], api_client_id: Optional[str],
              action: str, details: Optional[dict], ip_address: Optional[str]):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO api.audit (user_id, api_client_id, action, details, ip_address)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (user_id, api_client_id, action,
                 psycopg2.extras.Json(details) if details else None,
                 ip_address)
            )

# ==================== FastAPI Dependencies ====================

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Validate JWT token and return the current user."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        with get_db() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT user_id, is_active, is_admin, password_changed_at "
                    "FROM api.user WHERE user_id = %s",
                    (user_id,)
                )
                user = cur.fetchone()
                if user is None or not user['is_active']:
                    raise credentials_exception
                # Reject tokens issued before the user's last password change.
                # token "iat" is unix epoch seconds; password_changed_at is a UTC datetime.
                iat = payload.get("iat")
                pwd_changed = user.get("password_changed_at")
                if iat is not None and pwd_changed is not None:
                    iat_dt = datetime.utcfromtimestamp(int(iat))
                    if iat_dt < pwd_changed.replace(tzinfo=None):
                        raise credentials_exception
                return dict(user)
    except InvalidTokenError:
        raise credentials_exception

async def get_current_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    """Ensure the current JWT user has admin privileges."""
    if not current_user.get('is_admin'):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required"
        )
    return current_user

async def verify_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header()] = None
) -> dict:
    """Validate API key and return the API client record."""
    if not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key required. Include X-API-Key header in your request.",
            headers={"WWW-Authenticate": "ApiKey"}
        )
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT api_client_id, is_active, expires_at FROM api.api_client WHERE api_key = %s",
                (x_api_key,)
            )
            client = cur.fetchone()
            if not client:
                log_audit(None, None, "api_key_invalid_attempt",
                         {"api_key_prefix": x_api_key[:8] + "..."}, get_client_ip(request))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")
            if not client['is_active']:
                log_audit(None, client['api_client_id'], "api_key_inactive_attempt",
                         None, get_client_ip(request))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key is inactive")
            if client['expires_at'] and client['expires_at'] < datetime.now().date():
                log_audit(None, client['api_client_id'], "api_key_expired_attempt",
                         None, get_client_ip(request))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key has expired")
            cur.execute(
                "UPDATE api.api_client SET last_login = %s WHERE api_client_id = %s",
                (datetime.now(), client['api_client_id'])
            )
            return dict(client)
