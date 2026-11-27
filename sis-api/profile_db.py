"""
Profile database — the Admin Panel's Database tab.

Browse soil profile data as it sits in soil_data (plot → profile → element →
specimen → result_num, plus the descriptive results result_desc_plot /
_surface / _profile / _element), edit it, attach photographs and feed the
profile report.

Reading needs a signed-in user. Writing needs an administrator or an account
with api.user.can_edit_data; deleting a whole profile stays admin-only, like
every other bulk delete in the API.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile, File, Form
from typing import Optional
from datetime import date
import io
import math
import psycopg2
from psycopg2.extras import RealDictCursor

from shared import get_db, log_audit, get_client_ip, get_current_user

router = APIRouter(prefix="/api/pdb")

# level → (result table, object id column, table the object lives in, its key)
LEVELS = {
    "plot":    ("soil_data.result_desc_plot",    "plot_id",    "soil_data.plot",    "plot_id"),
    "surface": ("soil_data.result_desc_surface", "surface_id", "soil_data.plot",    "plot_id"),
    "profile": ("soil_data.result_desc_profile", "profile_id", "soil_data.profile", "profile_id"),
    "element": ("soil_data.result_desc_element", "element_id", "soil_data.element", "element_id"),
}
PLOT_TYPES = ("TrialPit", "Borehole")
ELEMENT_TYPES = ("Horizon", "Layer")
CENSORED = ("<LOD", "<LOQ", ">RANGE")

PHOTO_MAX_BYTES = 12 * 1024 * 1024   # upload cap
PHOTO_MAX_DIM = 1800                 # px, longest side after re-encode
PHOTO_THUMB_DIM = 420
PHOTO_MAX_PER_PLOT = 30

PLOT_SORTS = {
    "plot_code": "pl.plot_code",
    "plot_id": "pl.plot_id",
    "sampling_date": "pl.sampling_date",
    "altitude": "pl.altitude",
    "type": "pl.type",
}


class _Bad(Exception):
    """A change the client sent cannot be applied; the message is shown."""


# ==================== Permissions ====================

def user_can_edit(cur, user: dict) -> bool:
    if user.get("is_admin"):
        return True
    cur.execute('SELECT can_edit_data FROM api."user" WHERE user_id = %s', (user["user_id"],))
    row = cur.fetchone()
    if not row:
        return False
    return bool(row["can_edit_data"] if isinstance(row, dict) else row[0])


async def get_data_editor(current_user: dict = Depends(get_current_user)) -> dict:
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            ok = user_can_edit(cur, current_user)
    if not ok:
        raise HTTPException(status_code=403,
                            detail="You do not have permission to edit soil profile data")
    return current_user


# ==================== Shared with the CSV ingest ====================

def ensure_profile_container(cur, country_id: str, project_id: str) -> str:
    """Make sure a project can hold profiles: its site (site_id = project_id),
    the project_site link and the stub mapset + layer '<CC>-<PROJ>' that the
    Soil profiles tab hangs its policy fields on (is_published,
    profile_limit, spatial_blur_m). Returns the site_id. Used by the CSV
    ingest and by "New profile" in the Database tab."""
    site_id = project_id
    cur.execute("""
        INSERT INTO soil_data.site (site_id) VALUES (%s)
        ON CONFLICT (site_id) DO NOTHING
    """, (site_id,))
    cur.execute("""
        INSERT INTO soil_data.project_site (country_id, project_id, site_id)
        VALUES (%s, %s, %s) ON CONFLICT DO NOTHING
    """, (country_id, project_id, site_id))

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
    return site_id


# ==================== Value parsing ====================

def _text(v, name, max_len, nullable=True):
    if v is None or (isinstance(v, str) and not v.strip()):
        if nullable:
            return None
        raise _Bad(f"{name} is required")
    s = str(v).strip()
    if len(s) > max_len:
        raise _Bad(f"{name} is longer than {max_len} characters")
    return s


def _integer(v, name, lo, hi, nullable=True):
    if v is None or (isinstance(v, str) and not v.strip()):
        if nullable:
            return None
        raise _Bad(f"{name} is required")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise _Bad(f"{name} must be a whole number")
    if not math.isfinite(f) or f != int(f):
        raise _Bad(f"{name} must be a whole number")
    i = int(f)
    if i < lo or i > hi:
        raise _Bad(f"{name} must be between {lo} and {hi}")
    return i


def _number(v, name, lo, hi, nullable=True):
    if v is None or (isinstance(v, str) and not v.strip()):
        if nullable:
            return None
        raise _Bad(f"{name} is required")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise _Bad(f"{name} must be a number")
    if not math.isfinite(f) or f < lo or f > hi:
        raise _Bad(f"{name} must be between {lo} and {hi}")
    return f


def _iso_date(v, name):
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        d = date.fromisoformat(str(v).strip()[:10])
    except ValueError:
        raise _Bad(f"{name} must be a date (YYYY-MM-DD)")
    if d.year < 1800 or d > date.today():
        raise _Bad(f"{name} must lie between 1800 and today")
    return d


def _choice(v, name, allowed, nullable=True):
    if v is None or (isinstance(v, str) and not v.strip()):
        if nullable:
            return None
        raise _Bad(f"{name} is required")
    if v not in allowed:
        raise _Bad(f"{name} must be one of: {', '.join(allowed)}")
    return v


# ==================== Reading ====================

def _plot_filter(project_id: Optional[str], q: Optional[str]):
    """WHERE fragment (alias pl) + params for the project / code filters."""
    conds, params = [], []
    if project_id:
        conds.append("""EXISTS (SELECT 1 FROM soil_data.project_site ps
                                WHERE ps.site_id = pl.site_id AND ps.project_id = %s)""")
        params.append(project_id)
    if q and q.strip():
        like = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conds.append("pl.plot_code ILIKE %s")
        params.append(f"%{like}%")
    return (" AND ".join(conds) if conds else "TRUE"), params


def _plot_order(sort: str, direction: str) -> str:
    col = PLOT_SORTS.get(sort, "pl.plot_code")
    d = "DESC" if str(direction).lower() == "desc" else "ASC"
    return f"{col} {d} NULLS LAST, pl.plot_id {d}"


@router.get("/meta")
async def pdb_meta(current_user: dict = Depends(get_current_user)):
    """Everything the tab needs once: whether this user may edit, the
    projects, and the code lists (descriptive properties with their
    categories per level, numeric observations)."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            can_edit = user_can_edit(cur, current_user)
            cur.execute("""
                SELECT p.project_id, p.name,
                       (SELECT count(*) FROM soil_data.project_site ps
                          JOIN soil_data.plot pl ON pl.site_id = ps.site_id
                         WHERE ps.country_id = p.country_id
                           AND ps.project_id = p.project_id) AS profiles
                FROM soil_data.project p ORDER BY p.name
            """)
            projects = cur.fetchall()
            cur.execute("""
                SELECT o.property_desc_id, p.property_name, p.definition,
                       o.category_desc_id, c.notation, c.category_name,
                       o.plot, o.surface, o.profile, o.element, o.procedure_desc_id
                FROM soil_data.observation_desc o
                JOIN soil_data.property_desc p USING (property_desc_id)
                JOIN soil_data.category_desc c USING (category_desc_id)
                ORDER BY p.property_name, o.property_desc_id,
                         o.category_order NULLS LAST, c.notation, o.category_desc_id
            """)
            props = {}
            for r in cur.fetchall():
                p = props.get(r["property_desc_id"])
                if p is None:
                    p = props[r["property_desc_id"]] = {
                        "id": r["property_desc_id"],
                        "name": (r["property_name"] or r["property_desc_id"]).strip(),
                        "definition": r["definition"],
                        "procedure": r["procedure_desc_id"],
                        "levels": [],
                        "categories": [],
                    }
                for lvl in LEVELS:
                    if r[lvl] and lvl not in p["levels"]:
                        p["levels"].append(lvl)
                p["categories"].append({
                    "id": r["category_desc_id"],
                    "code": r["notation"],
                    "name": r["category_name"],
                })
            cur.execute("""
                SELECT o.observation_num_id, o.property_num_id, pr.property_name,
                       o.procedure_num_id, o.unit_of_measure_id,
                       o.value_min, o.value_max
                FROM soil_data.observation_num o
                JOIN soil_data.property_num pr USING (property_num_id)
                ORDER BY pr.property_name, o.procedure_num_id
            """)
            observations = cur.fetchall()
    return {
        "can_edit": can_edit,
        "is_admin": bool(current_user.get("is_admin")),
        "projects": projects,
        "desc_properties": list(props.values()),
        "observations": observations,
        "plot_types": PLOT_TYPES,
        "element_types": ELEMENT_TYPES,
        "censored": CENSORED,
    }


@router.get("/plots")
async def pdb_plots(project_id: Optional[str] = None, q: Optional[str] = None,
                    limit: int = 50, offset: int = 0,
                    sort: str = "plot_code", dir: str = "asc",
                    current_user: dict = Depends(get_current_user)):
    """One row per profile (plot): identity, location, counts and the
    descriptive results recorded at plot, surface and profile level."""
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    where, params = _plot_filter(project_id, q)
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"""
                SELECT pl.plot_id, pl.plot_code, pl.type, pl.sampling_date,
                       pl.altitude, pl.positional_accuracy,
                       ST_X(pl.geom) AS longitude, ST_Y(pl.geom) AS latitude,
                       (SELECT string_agg(DISTINCT ps.project_id, ', ')
                          FROM soil_data.project_site ps
                         WHERE ps.site_id = pl.site_id) AS project_id,
                       (SELECT count(*) FROM soil_data.profile pr
                          JOIN soil_data.element e ON e.profile_id = pr.profile_id
                         WHERE pr.plot_id = pl.plot_id) AS horizons,
                       (SELECT count(*) FROM api.profile_photo ph
                         WHERE ph.plot_id = pl.plot_id) AS photos,
                       count(*) OVER () AS total
                FROM soil_data.plot pl
                WHERE {where}
                ORDER BY {_plot_order(sort, dir)}
                LIMIT %s OFFSET %s
            """, (*params, limit, offset))
            rows = cur.fetchall()
            total = rows[0]["total"] if rows else 0
            if not rows and offset:
                cur.execute(f"SELECT count(*) AS n FROM soil_data.plot pl WHERE {where}", params)
                total = cur.fetchone()["n"]
            ids = [r["plot_id"] for r in rows]
            by_id = {r["plot_id"]: r for r in rows}
            for r in rows:
                r.pop("total", None)
                r["desc"] = {"plot": {}, "surface": {}, "profile": {}}
            if ids:
                cur.execute("""SELECT plot_id, property_desc_id, category_desc_id
                               FROM soil_data.result_desc_plot WHERE plot_id = ANY(%s)""", (ids,))
                for d in cur.fetchall():
                    by_id[d["plot_id"]]["desc"]["plot"][d["property_desc_id"]] = d["category_desc_id"]
                cur.execute("""SELECT surface_id, property_desc_id, category_desc_id
                               FROM soil_data.result_desc_surface WHERE surface_id = ANY(%s)""", (ids,))
                for d in cur.fetchall():
                    by_id[d["surface_id"]]["desc"]["surface"][d["property_desc_id"]] = d["category_desc_id"]
                cur.execute("""SELECT pr.plot_id, d.property_desc_id, d.category_desc_id
                               FROM soil_data.result_desc_profile d
                               JOIN soil_data.profile pr USING (profile_id)
                               WHERE pr.plot_id = ANY(%s)""", (ids,))
                for d in cur.fetchall():
                    by_id[d["plot_id"]]["desc"]["profile"][d["property_desc_id"]] = d["category_desc_id"]
            # Column set over the whole selection, so it is the same on every page.
            columns = {}
            cur.execute(f"""SELECT DISTINCT d.property_desc_id FROM soil_data.result_desc_plot d
                            JOIN soil_data.plot pl USING (plot_id) WHERE {where}""", params)
            columns["plot"] = sorted(r["property_desc_id"] for r in cur.fetchall())
            cur.execute(f"""SELECT DISTINCT d.property_desc_id FROM soil_data.result_desc_surface d
                            JOIN soil_data.plot pl ON pl.plot_id = d.surface_id WHERE {where}""", params)
            columns["surface"] = sorted(r["property_desc_id"] for r in cur.fetchall())
            cur.execute(f"""SELECT DISTINCT d.property_desc_id FROM soil_data.result_desc_profile d
                            JOIN soil_data.profile pr USING (profile_id)
                            JOIN soil_data.plot pl ON pl.plot_id = pr.plot_id WHERE {where}""", params)
            columns["profile"] = sorted(r["property_desc_id"] for r in cur.fetchall())
    return {"total": total, "limit": limit, "offset": offset, "rows": rows,
            "desc_columns": columns}


@router.get("/elements")
async def pdb_elements(project_id: Optional[str] = None, q: Optional[str] = None,
                       limit: int = 50, offset: int = 0,
                       current_user: dict = Depends(get_current_user)):
    """One row per horizon / layer with its analytical values (one column per
    numeric observation in use) and its descriptive results."""
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    where, params = _plot_filter(project_id, q)
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"""
                SELECT e.element_id, e.profile_id, pl.plot_id, pl.plot_code,
                       e.horizon, e.upper_depth, e.lower_depth, e.type,
                       (SELECT string_agg(DISTINCT ps.project_id, ', ')
                          FROM soil_data.project_site ps
                         WHERE ps.site_id = pl.site_id) AS project_id,
                       count(*) OVER () AS total
                FROM soil_data.element e
                JOIN soil_data.profile pr ON pr.profile_id = e.profile_id
                JOIN soil_data.plot pl ON pl.plot_id = pr.plot_id
                WHERE {where}
                ORDER BY pl.plot_code NULLS LAST, pl.plot_id,
                         e.upper_depth, e.lower_depth, e.element_id
                LIMIT %s OFFSET %s
            """, (*params, limit, offset))
            rows = cur.fetchall()
            total = rows[0]["total"] if rows else 0
            if not rows and offset:
                cur.execute(f"""SELECT count(*) AS n FROM soil_data.element e
                                JOIN soil_data.profile pr ON pr.profile_id = e.profile_id
                                JOIN soil_data.plot pl ON pl.plot_id = pr.plot_id
                                WHERE {where}""", params)
                total = cur.fetchone()["n"]
            ids = [r["element_id"] for r in rows]
            by_id = {r["element_id"]: r for r in rows}
            for r in rows:
                r.pop("total", None)
                r["num"] = {}
                r["desc"] = {}
                r["sample_field_id"] = None
                r["sample_lab_id"] = None
            if ids:
                _attach_element_results(cur, ids, by_id)
            cur.execute(f"""
                SELECT DISTINCT r.observation_num_id
                FROM soil_data.result_num r
                JOIN soil_data.specimen s ON s.specimen_id = r.specimen_id
                JOIN soil_data.element e ON e.element_id = s.element_id
                JOIN soil_data.profile pr ON pr.profile_id = e.profile_id
                JOIN soil_data.plot pl ON pl.plot_id = pr.plot_id
                WHERE {where}""", params)
            num_columns = [r["observation_num_id"] for r in cur.fetchall()]
            cur.execute(f"""
                SELECT DISTINCT d.property_desc_id
                FROM soil_data.result_desc_element d
                JOIN soil_data.element e ON e.element_id = d.element_id
                JOIN soil_data.profile pr ON pr.profile_id = e.profile_id
                JOIN soil_data.plot pl ON pl.plot_id = pr.plot_id
                WHERE {where}""", params)
            desc_columns = sorted(r["property_desc_id"] for r in cur.fetchall())
    return {"total": total, "limit": limit, "offset": offset, "rows": rows,
            "num_columns": num_columns, "desc_columns": desc_columns}


def _attach_element_results(cur, ids, by_id):
    """Fill num / desc / sample ids on element dicts. An element's values
    come from all its specimens; where two specimens carry the same
    observation the first specimen wins (the ingest creates one)."""
    cur.execute("""SELECT specimen_id, element_id, sample_field_id, sample_lab_id
                   FROM soil_data.specimen WHERE element_id = ANY(%s)
                   ORDER BY specimen_id""", (ids,))
    seen = set()
    for s in cur.fetchall():
        if s["element_id"] in seen:
            continue
        seen.add(s["element_id"])
        by_id[s["element_id"]]["sample_field_id"] = s["sample_field_id"]
        by_id[s["element_id"]]["sample_lab_id"] = s["sample_lab_id"]
    cur.execute("""SELECT s.element_id, r.observation_num_id, r.value, r.censored
                   FROM soil_data.result_num r
                   JOIN soil_data.specimen s ON s.specimen_id = r.specimen_id
                   WHERE s.element_id = ANY(%s)
                   ORDER BY s.specimen_id DESC""", (ids,))
    for r in cur.fetchall():
        by_id[r["element_id"]]["num"][str(r["observation_num_id"])] = (
            r["value"] if r["value"] is not None else r["censored"])
    cur.execute("""SELECT element_id, property_desc_id, category_desc_id
                   FROM soil_data.result_desc_element WHERE element_id = ANY(%s)""", (ids,))
    for d in cur.fetchall():
        by_id[d["element_id"]]["desc"][d["property_desc_id"]] = d["category_desc_id"]


def _load_record(cur, plot_id: int) -> Optional[dict]:
    cur.execute("""
        SELECT pl.plot_id, pl.site_id, pl.plot_code, pl.type, pl.sampling_date,
               pl.altitude, pl.positional_accuracy,
               ST_X(pl.geom) AS longitude, ST_Y(pl.geom) AS latitude
        FROM soil_data.plot pl WHERE pl.plot_id = %s
    """, (plot_id,))
    rec = cur.fetchone()
    if not rec:
        return None
    cur.execute("""
        SELECT p.project_id, p.name, p.description
        FROM soil_data.project_site ps
        JOIN soil_data.project p
          ON p.country_id = ps.country_id AND p.project_id = ps.project_id
        WHERE ps.site_id = %s ORDER BY p.project_id
    """, (rec["site_id"],))
    rec["projects"] = cur.fetchall()
    rec["desc"] = {"plot": {}, "surface": {}}
    cur.execute("""SELECT property_desc_id, category_desc_id
                   FROM soil_data.result_desc_plot WHERE plot_id = %s""", (plot_id,))
    for d in cur.fetchall():
        rec["desc"]["plot"][d["property_desc_id"]] = d["category_desc_id"]
    cur.execute("""SELECT property_desc_id, category_desc_id
                   FROM soil_data.result_desc_surface WHERE surface_id = %s""", (plot_id,))
    for d in cur.fetchall():
        rec["desc"]["surface"][d["property_desc_id"]] = d["category_desc_id"]

    cur.execute("""SELECT profile_id, profile_code FROM soil_data.profile
                   WHERE plot_id = %s ORDER BY profile_id""", (plot_id,))
    profiles = cur.fetchall()
    for pr in profiles:
        pr["desc"] = {}
        cur.execute("""SELECT property_desc_id, category_desc_id
                       FROM soil_data.result_desc_profile WHERE profile_id = %s""",
                    (pr["profile_id"],))
        for d in cur.fetchall():
            pr["desc"][d["property_desc_id"]] = d["category_desc_id"]
        cur.execute("""SELECT element_id, profile_id, horizon, upper_depth, lower_depth, type
                       FROM soil_data.element WHERE profile_id = %s
                       ORDER BY upper_depth, lower_depth, element_id""",
                    (pr["profile_id"],))
        els = cur.fetchall()
        by_id = {}
        for e in els:
            e["num"] = {}
            e["desc"] = {}
            e["sample_field_id"] = None
            e["sample_lab_id"] = None
            by_id[e["element_id"]] = e
        if els:
            _attach_element_results(cur, list(by_id), by_id)
        pr["elements"] = els
    rec["profiles"] = profiles
    cur.execute("""SELECT photo_id, caption, display_order, width, height, uploaded_at
                   FROM api.profile_photo WHERE plot_id = %s
                   ORDER BY display_order, photo_id""", (plot_id,))
    rec["photos"] = cur.fetchall()
    return rec


@router.get("/record")
async def pdb_record_at(project_id: Optional[str] = None, q: Optional[str] = None,
                        sort: str = "plot_code", dir: str = "asc", offset: int = 0,
                        plot_id: Optional[int] = None,
                        current_user: dict = Depends(get_current_user)):
    """The form view's record navigator: the profile at position `offset` of
    the current selection, with the selection's size. With `plot_id` the
    navigator lands on that profile (its position is worked out here); a
    profile outside the selection is returned on its own."""
    where, params = _plot_filter(project_id, q)
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"SELECT count(*) AS n FROM soil_data.plot pl WHERE {where}", params)
            total = cur.fetchone()["n"]
            if plot_id is not None:
                cur.execute(f"""SELECT rn FROM (
                                  SELECT pl.plot_id,
                                         row_number() OVER (ORDER BY {_plot_order(sort, dir)}) AS rn
                                  FROM soil_data.plot pl WHERE {where}) x
                                WHERE plot_id = %s""", (*params, plot_id))
                row = cur.fetchone()
                if row:
                    return {"total": total, "offset": row["rn"] - 1,
                            "record": _load_record(cur, plot_id)}
                rec = _load_record(cur, plot_id)
                if rec:
                    return {"total": 1, "offset": 0, "record": rec}
            if total == 0:
                return {"total": 0, "offset": 0, "record": None}
            offset = max(0, min(int(offset), total - 1))
            cur.execute(f"""SELECT pl.plot_id FROM soil_data.plot pl WHERE {where}
                            ORDER BY {_plot_order(sort, dir)} LIMIT 1 OFFSET %s""",
                        (*params, offset))
            plot_id = cur.fetchone()["plot_id"]
            return {"total": total, "offset": offset, "record": _load_record(cur, plot_id)}


@router.get("/plots/{plot_id}")
async def pdb_record(plot_id: int, current_user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            rec = _load_record(cur, plot_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"record": rec}


# ==================== Writing ====================

def _first_specimen(cur, element_id: int, create: bool) -> Optional[int]:
    cur.execute("""SELECT specimen_id FROM soil_data.specimen
                   WHERE element_id = %s ORDER BY specimen_id LIMIT 1""", (element_id,))
    row = cur.fetchone()
    if row:
        return row["specimen_id"]
    if not create:
        return None
    cur.execute("""INSERT INTO soil_data.specimen (element_id) VALUES (%s)
                   RETURNING specimen_id""", (element_id,))
    return cur.fetchone()["specimen_id"]


def _require(cur, table: str, key: str, value, what: str):
    cur.execute(f"SELECT 1 FROM {table} WHERE {key} = %s", (value,))
    if not cur.fetchone():
        raise _Bad(f"{what} {value} does not exist")


def _plot_values(cur, plot_id: Optional[int], site_id: str, values: dict) -> dict:
    """Validated column → value for a plot insert/update. Longitude and
    latitude travel together and come back as 'geom' (lon, lat) or None."""
    unknown = set(values) - {"plot_code", "type", "sampling_date", "altitude",
                             "positional_accuracy", "longitude", "latitude"}
    if unknown:
        raise _Bad(f"Unknown field: {', '.join(sorted(unknown))}")
    out = {}
    if "plot_code" in values:
        code = _text(values["plot_code"], "Profile code", 100, nullable=False)
        cur.execute("""SELECT 1 FROM soil_data.plot
                       WHERE site_id = %s AND plot_code = %s
                         AND plot_id IS DISTINCT FROM %s""", (site_id, code, plot_id))
        if cur.fetchone():
            raise _Bad(f"Profile code '{code}' already exists in this project")
        out["plot_code"] = code
    if "type" in values:
        out["type"] = _choice(values["type"], "Type", PLOT_TYPES)
    if "sampling_date" in values:
        out["sampling_date"] = _iso_date(values["sampling_date"], "Sampling date")
    if "altitude" in values:
        out["altitude"] = _integer(values["altitude"], "Altitude", -500, 9000)
    if "positional_accuracy" in values:
        out["positional_accuracy"] = _integer(values["positional_accuracy"],
                                              "Positional accuracy", 0, 30000)
    if "longitude" in values or "latitude" in values:
        lon, lat = values.get("longitude"), values.get("latitude")
        if plot_id is not None and ("longitude" not in values or "latitude" not in values):
            cur.execute("""SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat
                           FROM soil_data.plot WHERE plot_id = %s""", (plot_id,))
            cur_xy = cur.fetchone() or {}
            if "longitude" not in values:
                lon = cur_xy.get("lon")
            if "latitude" not in values:
                lat = cur_xy.get("lat")
        lon = _number(lon, "Longitude", -180, 180)
        lat = _number(lat, "Latitude", -90, 90)
        if (lon is None) != (lat is None):
            raise _Bad("Longitude and latitude must both be given, or both left empty")
        out["geom"] = None if lon is None else (lon, lat)
    return out


def _write_plot(cur, plot_id: int, values: dict):
    cur.execute("SELECT site_id, plot_code FROM soil_data.plot WHERE plot_id = %s", (plot_id,))
    row = cur.fetchone()
    if not row:
        raise _Bad(f"Profile {plot_id} does not exist")
    vals = _plot_values(cur, plot_id, row["site_id"], values)
    if not vals:
        return
    sets, params = [], []
    for col, v in vals.items():
        if col == "geom":
            if v is None:
                sets.append("geom = NULL")
            else:
                sets.append("geom = ST_SetSRID(ST_MakePoint(%s, %s), 4326)")
                params.extend(v)
        else:
            sets.append(f"{col} = %s")
            params.append(v)
    cur.execute(f"UPDATE soil_data.plot SET {', '.join(sets)} WHERE plot_id = %s",
                (*params, plot_id))
    # The ingest finds a plot's profile by profile_code = plot_code: keep the
    # two in step so a later re-ingest still lands on this profile.
    if "plot_code" in vals and vals["plot_code"] != row["plot_code"]:
        cur.execute("""UPDATE soil_data.profile SET profile_code = %s
                       WHERE plot_id = %s AND profile_code IS NOT DISTINCT FROM %s""",
                    (vals["plot_code"], plot_id, row["plot_code"]))


def _element_values(current: dict, values: dict) -> dict:
    unknown = set(values) - {"horizon", "upper_depth", "lower_depth", "type"}
    if unknown:
        raise _Bad(f"Unknown field: {', '.join(sorted(unknown))}")
    out = {}
    if "horizon" in values:
        out["horizon"] = _text(values["horizon"], "Horizon designation", 40)
    if "type" in values:
        out["type"] = _choice(values["type"], "Type", ELEMENT_TYPES, nullable=False)
    if "upper_depth" in values:
        out["upper_depth"] = _integer(values["upper_depth"], "Upper depth", 0, 1000, nullable=False)
    if "lower_depth" in values:
        out["lower_depth"] = _integer(values["lower_depth"], "Lower depth", 1, 3000, nullable=False)
    upper = out.get("upper_depth", current.get("upper_depth"))
    lower = out.get("lower_depth", current.get("lower_depth"))
    if upper is None or lower is None:
        raise _Bad("Upper and lower depth are required")
    if lower <= upper:
        raise _Bad(f"Lower depth ({lower}) must be greater than upper depth ({upper})")
    return out


def _write_element(cur, element_id: int, values: dict):
    cur.execute("""SELECT upper_depth, lower_depth FROM soil_data.element
                   WHERE element_id = %s""", (element_id,))
    row = cur.fetchone()
    if not row:
        raise _Bad(f"Horizon {element_id} does not exist")
    vals = _element_values(row, values)
    if not vals:
        return
    sets = ", ".join(f"{c} = %s" for c in vals)
    cur.execute(f"UPDATE soil_data.element SET {sets} WHERE element_id = %s",
                (*vals.values(), element_id))


def _write_specimen(cur, element_id: int, values: dict):
    unknown = set(values) - {"sample_field_id", "sample_lab_id"}
    if unknown:
        raise _Bad(f"Unknown field: {', '.join(sorted(unknown))}")
    _require(cur, "soil_data.element", "element_id", element_id, "Horizon")
    vals = {k: _text(v, k, 100) for k, v in values.items()}
    if not vals:
        return
    specimen_id = _first_specimen(cur, element_id, create=any(v is not None for v in vals.values()))
    if specimen_id is None:
        return
    sets = ", ".join(f"{c} = %s" for c in vals)
    cur.execute(f"UPDATE soil_data.specimen SET {sets} WHERE specimen_id = %s",
                (*vals.values(), specimen_id))


def _write_desc(cur, level: str, object_id: int, property_id: str, category_id):
    if level not in LEVELS:
        raise _Bad(f"Unknown level '{level}'")
    table, key, obj_table, obj_key = LEVELS[level]
    _require(cur, obj_table, obj_key, object_id,
             {"plot": "Profile", "surface": "Profile", "profile": "Profile", "element": "Horizon"}[level])
    if category_id is None or category_id == "":
        cur.execute(f"DELETE FROM {table} WHERE {key} = %s AND property_desc_id = %s",
                    (object_id, property_id))
        return
    cur.execute(f"""SELECT 1 FROM soil_data.observation_desc
                    WHERE property_desc_id = %s AND category_desc_id = %s AND {level} IS TRUE""",
                (property_id, category_id))
    if not cur.fetchone():
        raise _Bad(f"'{category_id}' is not a category of '{property_id}' at {level} level")
    cur.execute(f"""
        INSERT INTO {table} ({key}, property_desc_id, category_desc_id)
        VALUES (%s, %s, %s)
        ON CONFLICT ({key}, property_desc_id)
        DO UPDATE SET category_desc_id = EXCLUDED.category_desc_id
    """, (object_id, property_id, category_id))


def _write_num(cur, element_id: int, observation_id: int, value):
    _require(cur, "soil_data.element", "element_id", element_id, "Horizon")
    cur.execute("""SELECT o.value_min, o.value_max, pr.property_name
                   FROM soil_data.observation_num o
                   JOIN soil_data.property_num pr USING (property_num_id)
                   WHERE o.observation_num_id = %s""", (observation_id,))
    obs = cur.fetchone()
    if not obs:
        raise _Bad(f"Observation {observation_id} does not exist")
    if value is None or (isinstance(value, str) and not value.strip()):
        specimen_id = _first_specimen(cur, element_id, create=False)
        if specimen_id is not None:
            cur.execute("""DELETE FROM soil_data.result_num r USING soil_data.specimen s
                           WHERE r.specimen_id = s.specimen_id AND s.element_id = %s
                             AND r.observation_num_id = %s""", (element_id, observation_id))
        return
    name = obs["property_name"] or f"observation {observation_id}"
    specimen_id = _first_specimen(cur, element_id, create=True)
    if isinstance(value, str) and value.strip().upper() in CENSORED:
        cur.execute("""
            INSERT INTO soil_data.result_num (observation_num_id, specimen_id, value, censored)
            VALUES (%s, %s, NULL, %s)
            ON CONFLICT (observation_num_id, specimen_id)
            DO UPDATE SET value = NULL, censored = EXCLUDED.censored
        """, (observation_id, specimen_id, value.strip().upper()))
        return
    try:
        val = float(value)
    except (TypeError, ValueError):
        raise _Bad(f"{name}: '{value}' is not a number")
    if not math.isfinite(val):
        raise _Bad(f"{name}: '{value}' is not a number")
    lo, hi = obs["value_min"], obs["value_max"]
    if (lo is not None and val < lo) or (hi is not None and val > hi):
        raise _Bad(f"{name}: {val:g} is outside the admissible range "
                   f"{'' if lo is None else f'{lo:g}'} to {'' if hi is None else f'{hi:g}'}")
    cur.execute("""
        INSERT INTO soil_data.result_num (observation_num_id, specimen_id, value)
        VALUES (%s, %s, %s)
        ON CONFLICT (observation_num_id, specimen_id)
        DO UPDATE SET value = EXCLUDED.value, censored = NULL
    """, (observation_id, specimen_id, val))


def _apply_change(cur, ch: dict):
    if not isinstance(ch, dict):
        raise _Bad("Malformed change")
    kind = ch.get("kind")
    if kind == "plot":
        _write_plot(cur, int(ch["plot_id"]), dict(ch.get("values") or {}))
    elif kind == "element":
        _write_element(cur, int(ch["element_id"]), dict(ch.get("values") or {}))
    elif kind == "specimen":
        _write_specimen(cur, int(ch["element_id"]), dict(ch.get("values") or {}))
    elif kind == "desc":
        _write_desc(cur, str(ch.get("level")), int(ch["object_id"]),
                    str(ch.get("property_desc_id")), ch.get("category_desc_id"))
    elif kind == "num":
        _write_num(cur, int(ch["element_id"]), int(ch["observation_num_id"]), ch.get("value"))
    else:
        raise _Bad(f"Unknown change kind '{kind}'")


def _db_message(e: Exception) -> str:
    msg = (getattr(e, "diag", None) and e.diag.message_primary) or str(e)
    return str(msg).strip().split("\n")[0]


@router.post("/save")
async def pdb_save(payload: dict, request: Request,
                   current_user: dict = Depends(get_data_editor)):
    """Apply a list of edits in one transaction: all of them or none.

    Each change is one of
      {kind: plot,     plot_id,    values: {plot_code, type, sampling_date,
                                            altitude, positional_accuracy,
                                            longitude, latitude}}
      {kind: element,  element_id, values: {horizon, upper_depth, lower_depth, type}}
      {kind: specimen, element_id, values: {sample_field_id, sample_lab_id}}
      {kind: desc,     level, object_id, property_desc_id, category_desc_id | null}
      {kind: num,      element_id, observation_num_id, value | null | "<LOD"}
    """
    changes = (payload or {}).get("changes")
    if not isinstance(changes, list) or not changes:
        raise HTTPException(status_code=400, detail="No changes to save")
    if len(changes) > 5000:
        raise HTTPException(status_code=400, detail="Too many changes in one save")
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            for i, ch in enumerate(changes):
                try:
                    _apply_change(cur, ch)
                except _Bad as e:
                    raise HTTPException(status_code=400, detail=str(e))
                except (KeyError, TypeError, ValueError):
                    raise HTTPException(status_code=400, detail=f"Change {i + 1} is malformed")
                except psycopg2.Error as e:
                    raise HTTPException(status_code=400, detail=_db_message(e))
    kinds = {}
    for ch in changes:
        kinds[ch.get("kind")] = kinds.get(ch.get("kind"), 0) + 1
    log_audit(current_user["user_id"], None, "pdb_saved",
              {"changes": len(changes), "kinds": kinds}, get_client_ip(request))
    return {"message": "Saved", "changes": len(changes)}


@router.post("/plots", status_code=201)
async def pdb_create_plot(payload: dict, request: Request,
                          current_user: dict = Depends(get_data_editor)):
    """New profile, keyed in by hand: the plot and its (empty) profile."""
    project_id = str((payload or {}).get("project_id") or "").strip()
    values = dict((payload or {}).get("values") or {})
    if not project_id:
        raise HTTPException(status_code=400, detail="Project is required")
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT country_id FROM soil_data.project WHERE project_id = %s",
                        (project_id,))
            proj = cur.fetchone()
            if not proj:
                raise HTTPException(status_code=404, detail="Project not found")
            try:
                site_id = ensure_profile_container(cur, proj["country_id"], project_id)
                if "plot_code" not in values:
                    raise _Bad("Profile code is required")
                vals = _plot_values(cur, None, site_id, values)
                geom = vals.pop("geom", None)
                cols = ["site_id"] + list(vals)
                marks = ["%s"] * len(cols)
                params = [site_id] + list(vals.values())
                if geom is not None:
                    cols.append("geom")
                    marks.append("ST_SetSRID(ST_MakePoint(%s, %s), 4326)")
                    params.extend(geom)
                cur.execute(f"""INSERT INTO soil_data.plot ({', '.join(cols)})
                                VALUES ({', '.join(marks)}) RETURNING plot_id""", params)
                plot_id = cur.fetchone()["plot_id"]
                cur.execute("""INSERT INTO soil_data.profile (plot_id, profile_code)
                               VALUES (%s, %s)""", (plot_id, vals["plot_code"]))
            except _Bad as e:
                raise HTTPException(status_code=400, detail=str(e))
            except psycopg2.Error as e:
                raise HTTPException(status_code=400, detail=_db_message(e))
    log_audit(current_user["user_id"], None, "pdb_profile_created",
              {"plot_id": plot_id, "project_id": project_id}, get_client_ip(request))
    return {"plot_id": plot_id}


@router.delete("/plots/{plot_id}")
async def pdb_delete_plot(plot_id: int, request: Request,
                          current_user: dict = Depends(get_current_user)):
    """Delete one profile with everything under it (admin only)."""
    if not current_user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin privileges required")
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""DELETE FROM soil_data.plot WHERE plot_id = %s
                           RETURNING plot_code""", (plot_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Profile not found")
    log_audit(current_user["user_id"], None, "pdb_profile_deleted",
              {"plot_id": plot_id, "plot_code": row["plot_code"]}, get_client_ip(request))
    return {"message": "Deleted"}


@router.post("/plots/{plot_id}/elements", status_code=201)
async def pdb_create_element(plot_id: int, payload: dict, request: Request,
                             current_user: dict = Depends(get_data_editor)):
    """Add a horizon / layer to a profile (the profile row is created when
    the plot has none yet)."""
    values = dict((payload or {}).get("values") or {})
    values.setdefault("type", "Horizon")
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT plot_code FROM soil_data.plot WHERE plot_id = %s", (plot_id,))
            plot = cur.fetchone()
            if not plot:
                raise HTTPException(status_code=404, detail="Profile not found")
            try:
                vals = _element_values({}, values)
                profile_id = (payload or {}).get("profile_id")
                if profile_id is not None:
                    cur.execute("""SELECT profile_id FROM soil_data.profile
                                   WHERE profile_id = %s AND plot_id = %s""",
                                (int(profile_id), plot_id))
                else:
                    cur.execute("""SELECT profile_id FROM soil_data.profile
                                   WHERE plot_id = %s ORDER BY profile_id LIMIT 1""", (plot_id,))
                row = cur.fetchone()
                if row:
                    profile_id = row["profile_id"]
                elif (payload or {}).get("profile_id") is not None:
                    raise _Bad("That profile does not belong to this plot")
                else:
                    cur.execute("""INSERT INTO soil_data.profile (plot_id, profile_code)
                                   VALUES (%s, %s) RETURNING profile_id""",
                                (plot_id, plot["plot_code"]))
                    profile_id = cur.fetchone()["profile_id"]
                cur.execute("""SELECT 1 FROM soil_data.element
                               WHERE profile_id = %s AND upper_depth = %s AND lower_depth = %s""",
                            (profile_id, vals["upper_depth"], vals["lower_depth"]))
                if cur.fetchone():
                    raise _Bad(f"This profile already has a horizon at "
                               f"{vals['upper_depth']}–{vals['lower_depth']} cm")
                cur.execute("""INSERT INTO soil_data.element
                                   (profile_id, upper_depth, lower_depth, type, horizon)
                               VALUES (%s, %s, %s, %s, %s) RETURNING element_id""",
                            (profile_id, vals["upper_depth"], vals["lower_depth"],
                             vals["type"], vals.get("horizon")))
                element_id = cur.fetchone()["element_id"]
            except _Bad as e:
                raise HTTPException(status_code=400, detail=str(e))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Malformed request")
            except psycopg2.Error as e:
                raise HTTPException(status_code=400, detail=_db_message(e))
    log_audit(current_user["user_id"], None, "pdb_horizon_created",
              {"plot_id": plot_id, "element_id": element_id}, get_client_ip(request))
    return {"element_id": element_id}


@router.delete("/elements/{element_id}")
async def pdb_delete_element(element_id: int, request: Request,
                             current_user: dict = Depends(get_data_editor)):
    """Delete a horizon / layer with its samples, values and description."""
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""DELETE FROM soil_data.element WHERE element_id = %s
                           RETURNING profile_id""", (element_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Horizon not found")
    log_audit(current_user["user_id"], None, "pdb_horizon_deleted",
              {"element_id": element_id}, get_client_ip(request))
    return {"message": "Deleted"}


# ==================== Photographs ====================

def _encode_photo(data: bytes):
    """(jpeg, thumbnail jpeg, width, height). Always re-encoded with Pillow:
    upright (EXIF orientation applied), no metadata, capped dimensions —
    nothing of the uploaded file is stored as sent."""
    from PIL import Image, ImageOps
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = ImageOps.exif_transpose(img)
    except Exception:
        raise HTTPException(status_code=400, detail="Not a readable image")
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.split()[3])
        img = flat
    else:
        img = img.convert("RGB")
    if max(img.size) > PHOTO_MAX_DIM:
        img.thumbnail((PHOTO_MAX_DIM, PHOTO_MAX_DIM))
    full = io.BytesIO()
    img.save(full, format="JPEG", quality=85, optimize=True)
    thumb_img = img.copy()
    thumb_img.thumbnail((PHOTO_THUMB_DIM, PHOTO_THUMB_DIM))
    thumb = io.BytesIO()
    thumb_img.save(thumb, format="JPEG", quality=80, optimize=True)
    return full.getvalue(), thumb.getvalue(), img.size[0], img.size[1]


@router.post("/plots/{plot_id}/photos", status_code=201)
async def pdb_upload_photo(plot_id: int, request: Request,
                           file: UploadFile = File(...),
                           caption: Optional[str] = Form(None),
                           current_user: dict = Depends(get_data_editor)):
    data = await file.read()
    if len(data) > PHOTO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 12 MB)")
    full, thumb, width, height = _encode_photo(data)
    cap = (caption or "").strip()[:300] or None
    with get_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM soil_data.plot WHERE plot_id = %s", (plot_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Profile not found")
            cur.execute("""SELECT count(*) AS n, COALESCE(max(display_order), 0) AS last
                           FROM api.profile_photo WHERE plot_id = %s""", (plot_id,))
            stat = cur.fetchone()
            if stat["n"] >= PHOTO_MAX_PER_PLOT:
                raise HTTPException(status_code=400,
                                    detail=f"A profile can hold at most {PHOTO_MAX_PER_PLOT} photographs")
            cur.execute("""
                INSERT INTO api.profile_photo
                    (plot_id, caption, display_order, width, height, image, thumbnail, uploaded_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING photo_id, caption, display_order, width, height, uploaded_at
            """, (plot_id, cap, stat["last"] + 1, width, height,
                  psycopg2.Binary(full), psycopg2.Binary(thumb), current_user["user_id"]))
            photo = cur.fetchone()
    log_audit(current_user["user_id"], None, "pdb_photo_added",
              {"plot_id": plot_id, "photo_id": photo["photo_id"]}, get_client_ip(request))
    return photo


@router.get("/photos/{photo_id}")
async def pdb_get_photo(photo_id: int, size: str = "full",
                        current_user: dict = Depends(get_current_user)):
    col = "thumbnail" if size == "thumb" else "image"
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {col} FROM api.profile_photo WHERE photo_id = %s", (photo_id,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Photograph not found")
    return Response(content=bytes(row[0]), media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=3600",
                             "X-Content-Type-Options": "nosniff"})


@router.patch("/photos/{photo_id}")
async def pdb_update_photo(photo_id: int, payload: dict,
                           current_user: dict = Depends(get_data_editor)):
    sets, vals = [], []
    if "caption" in (payload or {}):
        sets.append("caption = %s")
        vals.append((str(payload["caption"] or "").strip()[:300]) or None)
    if "display_order" in (payload or {}):
        try:
            vals.append(int(payload["display_order"]))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="display_order must be a whole number")
        sets.append("display_order = %s")
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE api.profile_photo SET {', '.join(sets)} WHERE photo_id = %s",
                        (*vals, photo_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Photograph not found")
    return {"message": "Updated"}


@router.delete("/photos/{photo_id}")
async def pdb_delete_photo(photo_id: int, request: Request,
                           current_user: dict = Depends(get_data_editor)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM api.profile_photo WHERE photo_id = %s RETURNING plot_id",
                        (photo_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Photograph not found")
    log_audit(current_user["user_id"], None, "pdb_photo_deleted",
              {"photo_id": photo_id, "plot_id": row[0]}, get_client_ip(request))
    return {"message": "Deleted"}
