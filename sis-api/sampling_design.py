"""Sampling design — SoilFER three-stage hierarchical CSC sampling.

Implements the method of the SoilFER Technical Manual for Sampling Design
(un-fao/SoilFER, "sampling design"): covariate space coverage (CSC, k-means
in standardised covariate space) selects primary sampling units (PSUs) over
the country, CSC again selects secondary units (SSUs) inside the PSUs at a
finer grid, and simple random sampling places the points within the SSUs,
each with ranked replacement locations.

Design decisions (agreed on the OpenNSIS side):
  * Covariates are EPHEMERAL: fetched at run time from explicit open sources
    (windowed, overview-level HTTP range reads — the full-resolution sources
    are never downloaded), used, and discarded with the scratch directory.
    Only the design and its manifest persist.
  * Every source is recorded in the manifest with URL, licence, retrieval
    time, resolution, resampling and a checksum of the fetched window, plus
    all parameters and the random seed — the design is auditable even though
    its inputs are not stored.
  * No new dependencies: numpy + rasterio (already in the image) do the
    remote reads, reprojection (WarpedVRT) and the k-means (~Lloyd's with
    k-means++ init, chunked, seeded).

Stage-2 covariates in v1 are the terrain derivatives and land cover read at
the SSU grid; satellite composites (e.g. Digital Earth Africa GeoMAD) are a
declared follow-up and would slot in as one more source adapter.
"""

import hashlib
import json
import logging
import math
import time
from datetime import datetime, timezone

import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.merge import merge as rio_merge
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform as warp_transform

log = logging.getLogger("sampling_design")

WORLDCOVER_BASE = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com"
                   "/v200/2021/map")
CHELSA_BASE = ("https://os.zhdk.cloud.switch.ch/chelsav2/GLOBAL"
               "/climatologies/1981-2010/bio")
EARTH_SEARCH = "https://earth-search.aws.element84.com/v1"
GEOBOUNDARIES = "https://www.geoboundaries.org/api/current/gbOpen"

# The default recipe — every entry user-visible with name, licence and link.
DEFAULT_SOURCES = [
    {"id": "boundary-geoboundaries", "category": "boundary",
     "name": "geoBoundaries ADM0 country boundary",
     "licence": "CC BY 4.0", "link": "https://www.geoboundaries.org",
     "required": True},
    {"id": "terrain-cop-dem-30", "category": "terrain",
     "name": "Copernicus GLO-30 DEM + derivatives (slope, aspect, TPI)",
     "licence": "ESA/Airbus free licence",
     "link": "https://registry.opendata.aws/copernicus-dem/",
     "required": True},
    {"id": "climate-chelsa-bio", "category": "climate",
     "name": "CHELSA v2.1 bioclim (bio1, bio12, bio15)",
     "licence": "CC0", "link": "https://chelsa-climate.org",
     "required": False},
    {"id": "landcover-worldcover", "category": "landcover",
     "name": "ESA WorldCover 10 m (2021, v200) — land cover + cropland mask",
     "licence": "CC BY 4.0", "link": "https://esa-worldcover.org",
     "required": True},
]

UA = {"User-Agent": "OpenNSIS-sampling-design"}


# --------------------------------------------------------------------------
# Small geometry helpers (no shapely: numpy even-odd point-in-polygon)
# --------------------------------------------------------------------------

def _rings_of(geojson_geom):
    """All rings of a Polygon/MultiPolygon as [N×2 numpy arrays] (lon, lat).
    Even-odd testing across all rings handles holes and multiparts."""
    g = geojson_geom
    if g["type"] == "Polygon":
        polys = [g["coordinates"]]
    elif g["type"] == "MultiPolygon":
        polys = g["coordinates"]
    else:
        raise ValueError(f"unsupported geometry {g['type']}")
    return [np.asarray(ring, dtype="float64") for poly in polys for ring in poly]


def decimate_ring(ring, max_vertices=2000):
    """Thin a ring to at most max_vertices, keeping closure. For sampling
    grids (cells of hundreds of metres) boundary detail far below the cell
    size carries no information — and unbounded rings OOM the point test."""
    n = ring.shape[0]
    if n <= max_vertices:
        return ring
    step = int(math.ceil(n / max_vertices))
    out = ring[::step]
    if not np.array_equal(out[0], out[-1]):
        out = np.vstack([out, out[0]])
    return out


def points_in_geom(xs, ys, rings, chunk=20_000):
    """Vectorised even-odd rule over all rings; memory bounded on both axes
    (points are chunked, rings decimated)."""
    inside = np.zeros(xs.shape[0], dtype=bool)
    for ring in rings:
        ring = decimate_ring(ring)
        x0, y0 = ring[:-1, 0], ring[:-1, 1]
        x1, y1 = ring[1:, 0], ring[1:, 1]
        dy = y1 - y0
        dy[dy == 0] = 1e-12
        for i0 in range(0, xs.shape[0], chunk):
            sl = slice(i0, i0 + chunk)
            px = xs[sl][:, None]
            py = ys[sl][:, None]
            cond = ((y0[None, :] > py) != (y1[None, :] > py))
            xint = x0[None, :] + (py - y0[None, :]) / dy[None, :] * (x1[None, :] - x0[None, :])
            crossings = (cond & (px < xint)).sum(axis=1)
            inside[sl] ^= (crossings % 2).astype(bool)
    return inside


def utm_crs_for(lon, lat):
    zone = int(math.floor((lon + 180.0) / 6.0)) + 1
    return f"EPSG:{(32600 if lat >= 0 else 32700) + zone}"


# --------------------------------------------------------------------------
# Fetching (ephemeral, windowed)
# --------------------------------------------------------------------------

def fetch_boundary(iso3, scratch_note):
    """geoBoundaries ADM0 GeoJSON for the country. Returns (geometry, meta)."""
    api = f"{GEOBOUNDARIES}/{iso3}/ADM0/"
    r = requests.get(api, headers=UA, timeout=60)
    r.raise_for_status()
    info = r.json()
    gj_url = info["gjDownloadURL"]
    r2 = requests.get(gj_url, headers=UA, timeout=120)
    r2.raise_for_status()
    gj = r2.json()
    geom = gj["features"][0]["geometry"]
    meta = {"source": "geoBoundaries ADM0", "url": gj_url,
            "licence": info.get("boundaryLicense", "CC BY 4.0"),
            "retrieved_at": _now(),
            "checksum": hashlib.sha1(r2.content).hexdigest()[:16]}
    return geom, meta


def _stac_hrefs(collection, bbox):
    """Earth Search STAC: asset hrefs of items intersecting bbox."""
    body = {"collections": [collection], "bbox": list(bbox), "limit": 200}
    r = requests.post(f"{EARTH_SEARCH}/search", json=body, headers=UA, timeout=60)
    r.raise_for_status()
    feats = r.json().get("features", [])
    hrefs = []
    for f in feats:
        assets = f.get("assets", {})
        a = assets.get("data") or next(iter(assets.values()), None)
        if a and a.get("href"):
            href = a["href"]
            # Earth Search hands out s3:// hrefs for the open buckets —
            # translate to anonymous HTTPS so no AWS credentials are needed.
            if href.startswith("s3://"):
                bucket, _, key = href[5:].partition("/")
                href = f"https://{bucket}.s3.amazonaws.com/{key}"
            hrefs.append(href)
    return hrefs


def _worldcover_tiles(bbox):
    """Deterministic 3°×3° tile URLs covering bbox (no STAC needed)."""
    w, s, e, n = bbox
    urls = []
    for lat in range(int(math.floor(s / 3.0)) * 3, int(math.ceil(n / 3.0)) * 3, 3):
        for lon in range(int(math.floor(w / 3.0)) * 3, int(math.ceil(e / 3.0)) * 3, 3):
            ns = f"N{lat:02d}" if lat >= 0 else f"S{-lat:02d}"
            ew = f"E{lon:03d}" if lon >= 0 else f"W{-lon:03d}"
            urls.append(f"{WORLDCOVER_BASE}/ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif")
    return urls


def _overview_pick(src, target_res_m):
    """Index of the coarsest internal overview still finer than the target
    resolution, or None for the base image. Without this, warping e.g. 10 m
    WorldCover tiles onto a 2 km grid makes GDAL read full-resolution source
    and OOMs the container; with it, each read touches a few hundred KB."""
    res = abs(src.transform.a)
    if src.crs and src.crs.is_geographic:
        res *= 111_320.0
    best = None
    try:
        factors = src.overviews(1)
    except Exception:
        factors = []
    for i, fct in enumerate(factors):
        if res * fct <= target_res_m * 0.75:
            best = i
    return best


def read_grid(urls, grid, categorical=False):
    """Read remote rasters onto `grid` = (crs, transform, width, height).
    Mosaics multiple files; sources are opened at a matching internal
    overview level, so only the needed window near the target resolution
    travels over the network and through memory."""
    crs, transform, width, height = grid
    target_res_m = abs(transform.a)
    resampling = Resampling.nearest if categorical else Resampling.average
    out = np.full((height, width), np.nan, dtype="float32")
    env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
                       CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff",
                       GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2",
                       GDAL_CACHEMAX=64,
                       AWS_NO_SIGN_REQUEST="YES")
    with env:
        for url in urls:
            try:
                with rasterio.open(url) as probe:
                    lvl = _overview_pick(probe, target_res_m)
                opts = {"OVERVIEW_LEVEL": lvl} if lvl is not None else {}
                with rasterio.open(url, **opts) as src:
                    with WarpedVRT(src, crs=crs, transform=transform,
                                   width=width, height=height,
                                   resampling=resampling, nodata=np.nan,
                                   dtype="float32") as vrt:
                        arr = vrt.read(1)
                mask = ~np.isnan(arr)
                out[mask] = arr[mask]
            except rasterio.errors.RasterioIOError as e:
                # A missing WorldCover sea tile is normal; anything else is
                # surfaced through the step log by the caller.
                log.info("skipping %s: %s", url, e)
    return out


def terrain_derivatives(dem, cell_m):
    """Slope (deg), aspect (sin+cos), TPI from a DEM grid. NaN-safe."""
    dzdy, dzdx = np.gradient(dem, cell_m)
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    aspect = np.arctan2(-dzdx, dzdy)
    # Mean of the 8-neighbourhood via shifted stack (edges stay NaN-ish).
    shifts = [np.roll(np.roll(dem, dy, 0), dx, 1)
              for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy, dx) != (0, 0)]
    tpi = dem - np.nanmean(np.stack(shifts), axis=0)
    return {"slope": slope, "aspect_sin": np.sin(aspect),
            "aspect_cos": np.cos(aspect), "tpi": tpi}


# --------------------------------------------------------------------------
# CSC: k-means in standardised covariate space
# --------------------------------------------------------------------------

def _kmeanspp_init(X, k, rng):
    n = X.shape[0]
    centroids = np.empty((k, X.shape[1]), dtype=X.dtype)
    centroids[0] = X[rng.integers(n)]
    d2 = ((X - centroids[0]) ** 2).sum(axis=1)
    for i in range(1, k):
        probs = d2 / d2.sum()
        centroids[i] = X[rng.choice(n, p=probs)]
        d2 = np.minimum(d2, ((X - centroids[i]) ** 2).sum(axis=1))
    return centroids


def _assign(X, centroids, chunk=100_000):
    """Nearest centroid per row, chunked to bound memory."""
    labels = np.empty(X.shape[0], dtype="int32")
    mind2 = np.empty(X.shape[0], dtype="float64")
    c2 = (centroids ** 2).sum(axis=1)
    for i0 in range(0, X.shape[0], chunk):
        sl = slice(i0, i0 + chunk)
        d2 = c2[None, :] - 2.0 * X[sl] @ centroids.T
        labels[sl] = np.argmin(d2, axis=1)
        mind2[sl] = np.take_along_axis(d2, labels[sl][:, None], 1)[:, 0] \
            + (X[sl] ** 2).sum(axis=1)
    return labels, np.maximum(mind2, 0.0)


def csc_kmeans(X, k, seed, n_init=4, max_iter=60, tol=1e-5):
    """Lloyd's k-means with k-means++ init; returns (centroids, labels, mssd).
    mssd = mean squared shortest distance in covariate space — the standard
    CSC quality metric, comparable with the R workflow's output."""
    best = None
    for run in range(n_init):
        rng = np.random.default_rng(seed + run)
        C = _kmeanspp_init(X, k, rng)
        for _ in range(max_iter):
            labels, mind2 = _assign(X, C)
            newC = np.empty_like(C)
            for j in range(k):
                members = X[labels == j]
                newC[j] = members.mean(axis=0) if len(members) else X[rng.integers(X.shape[0])]
            shift = float(((newC - C) ** 2).sum())
            C = newC
            if shift < tol:
                break
        labels, mind2 = _assign(X, C)
        mssd = float(mind2.mean())
        if best is None or mssd < best[2]:
            best = (C, labels, mssd)
    return best


def select_units(X, C, n_replacements=2):
    """Per centroid: indices of the nearest, 2nd and 3rd nearest rows."""
    picks = []
    taken = set()
    for j in range(C.shape[0]):
        d2 = ((X - C[j]) ** 2).sum(axis=1)
        order = np.argsort(d2)
        chosen = []
        for idx in order:
            if int(idx) not in taken:
                chosen.append(int(idx))
                taken.add(int(idx))
            if len(chosen) == n_replacements + 1:
                break
        picks.append(chosen)
    return picks


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _standardise(stack):
    """[bands,h,w] → (n_valid, bands) matrix + flat index of valid pixels."""
    bands, h, w = stack.shape
    flat = stack.reshape(bands, -1)
    valid = ~np.isnan(flat).any(axis=0)
    X = flat[:, valid].T.astype("float64")
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd == 0] = 1.0
    return ((X - mu) / sd).astype("float32"), np.flatnonzero(valid)


def _grid_for(bounds_utm, crs, cell):
    w0, s0, e0, n0 = bounds_utm
    width = max(1, int(math.ceil((e0 - w0) / cell)))
    height = max(1, int(math.ceil((n0 - s0) / cell)))
    return (crs, from_origin(w0, n0, cell, cell), width, height)


def _centres(grid):
    crs, transform, width, height = grid
    cols, rows = np.meshgrid(np.arange(width), np.arange(height))
    xs = transform.c + (cols.ravel() + 0.5) * transform.a
    ys = transform.f + (rows.ravel() + 0.5) * transform.e
    return xs, ys


def _checksum(arr):
    return hashlib.sha1(np.nan_to_num(arr).tobytes()).hexdigest()[:16]


def execute_design(design_id, get_db):
    """The whole three-stage run. Writes status/step log/manifest/features
    through get_db; everything fetched is discarded when the function ends."""

    def logstep(msg):
        log.info("design %s: %s", design_id, msg)
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""UPDATE api.sampling_design
                               SET step_log = step_log || %s WHERE design_id = %s""",
                            (f"[{_now()}] {msg}\n", design_id))

    def fail(msg):
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""UPDATE api.sampling_design
                               SET status='failed', error=%s, finished_at=now()
                               WHERE design_id = %s""", (msg, design_id))

    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""SELECT params, sources FROM api.sampling_design
                               WHERE design_id = %s""", (design_id,))
                row = cur.fetchone()
                params, sources = row[0], row[1]
                cur.execute("UPDATE api.sampling_design SET status='running' WHERE design_id=%s",
                            (design_id,))
                cur.execute("SELECT value FROM api.setting WHERE key='COUNTRY_CODE'")
                cc = (cur.fetchone() or ["?"])[0]
                cur.execute("SELECT iso3_code FROM soil_data.country WHERE country_id=%s", (cc,))
                r = cur.fetchone()
                iso3_default = r[0] if r else None

        iso3 = (params.get("iso3") or iso3_default or "").upper()
        if not iso3:
            fail("No ISO3 country code (set COUNTRY_CODE or pass iso3)")
            return
        seed = int(params.get("seed") or 20260101)
        n_psu = int(params.get("n_psu", 50))
        ssu_per_psu = int(params.get("ssu_per_psu", 2))
        pts_per_ssu = int(params.get("pts_per_ssu", 3))
        psu_m = float(params.get("psu_size_m", 2000))
        ssu_m = float(params.get("ssu_size_m", 100))
        cropland_only = bool(params.get("cropland_only", True))
        chosen = {s["id"] for s in sources}
        manifest_sources = []
        rng = np.random.default_rng(seed)

        # ---- boundary ----------------------------------------------------
        logstep(f"Fetching country boundary for {iso3} (geoBoundaries ADM0)")
        geom, bmeta = fetch_boundary(iso3, None)
        manifest_sources.append({"id": "boundary-geoboundaries", **bmeta})
        rings = _rings_of(geom)
        lons = np.concatenate([r[:, 0] for r in rings])
        lats = np.concatenate([r[:, 1] for r in rings])
        bbox = (float(lons.min()), float(lats.min()),
                float(lons.max()), float(lats.max()))
        crs = utm_crs_for(float(lons.mean()), float(lats.mean()))
        # boundary rings in UTM for the in-country test
        rings_utm = []
        for ring in rings:
            xs, ys = warp_transform("EPSG:4326", crs, ring[:, 0].tolist(), ring[:, 1].tolist())
            rings_utm.append(np.column_stack([xs, ys]))
        all_utm = np.vstack(rings_utm)
        bounds_utm = (all_utm[:, 0].min(), all_utm[:, 1].min(),
                      all_utm[:, 0].max(), all_utm[:, 1].max())
        logstep(f"Working CRS {crs}; bbox {tuple(round(v, 3) for v in bbox)}")

        # ---- stage 1 grid + covariates ------------------------------------
        grid1 = _grid_for(bounds_utm, crs, psu_m)
        xs1, ys1 = _centres(grid1)
        inside = points_in_geom(xs1, ys1, rings_utm)
        logstep(f"Stage 1 grid: {grid1[2]}×{grid1[3]} cells at {int(psu_m)} m, "
                f"{int(inside.sum())} inside the boundary")

        band_stack, band_names = [], []

        dem_hrefs = _stac_hrefs("cop-dem-glo-30", bbox) if "terrain-cop-dem-30" in chosen else []
        if dem_hrefs:
            logstep(f"Fetching DEM window from {len(dem_hrefs)} Copernicus GLO-30 tiles "
                    f"(Earth Search STAC, overview-level reads)")
            dem1 = read_grid(dem_hrefs, grid1)
            deriv = terrain_derivatives(dem1, psu_m)
            for nm, arr in [("elevation", dem1)] + list(deriv.items()):
                band_stack.append(arr)
                band_names.append(nm)
            manifest_sources.append({
                "id": "terrain-cop-dem-30", "stac": f"{EARTH_SEARCH} cop-dem-glo-30",
                "tiles": len(dem_hrefs), "resolution_m": psu_m,
                "resampling": "average", "retrieved_at": _now(),
                "checksum": _checksum(dem1)})

        if "climate-chelsa-bio" in chosen:
            for bio in ("bio1", "bio12", "bio15"):
                url = f"{CHELSA_BASE}/CHELSA_{bio}_1981-2010_V.2.1.tif"
                logstep(f"Fetching CHELSA {bio} window")
                arr = read_grid([url], grid1)
                band_stack.append(arr)
                band_names.append(bio)
                manifest_sources.append({
                    "id": f"climate-chelsa-{bio}", "url": url,
                    "resolution_m": psu_m, "resampling": "average",
                    "retrieved_at": _now(), "checksum": _checksum(arr)})

        lc1 = None
        if "landcover-worldcover" in chosen:
            wc_urls = _worldcover_tiles(bbox)
            logstep(f"Fetching ESA WorldCover window ({len(wc_urls)} tiles)")
            lc1 = read_grid(wc_urls, grid1, categorical=True)
            band_stack.append(lc1)
            band_names.append("landcover")
            manifest_sources.append({
                "id": "landcover-worldcover", "tiles": len(wc_urls),
                "url_base": WORLDCOVER_BASE, "resolution_m": psu_m,
                "resampling": "nearest", "retrieved_at": _now(),
                "checksum": _checksum(lc1)})

        if not band_stack:
            fail("No covariate sources selected")
            return

        stack1 = np.stack(band_stack)
        # mask: outside country → NaN; cropland constraint (WorldCover 40)
        flatmask = ~inside
        if cropland_only and lc1 is not None:
            flatmask |= (np.nan_to_num(lc1.ravel()) != 40)
        stack1.reshape(len(band_stack), -1)[:, flatmask] = np.nan

        X1, valid_idx1 = _standardise(stack1)
        if X1.shape[0] < n_psu * 3:
            fail(f"Only {X1.shape[0]} candidate cells after masking — too few "
                 f"for {n_psu} PSUs (relax the cropland constraint or grid size)")
            return
        logstep(f"Stage 1 CSC: k-means k={n_psu} on {X1.shape[0]} cells × "
                f"{X1.shape[1]} covariates ({', '.join(band_names)})")
        C1, _, mssd1 = csc_kmeans(X1, n_psu, seed)
        picks1 = select_units(X1, C1, n_replacements=0)
        logstep(f"Stage 1 done: MSSD {mssd1:.4f}")

        # ---- stages 2 + 3 per PSU ----------------------------------------
        _, t1, w1, h1 = grid1
        features = []        # (kind, sample_id, rank, lon, lat, props, poly)
        total_pts = 0
        for p_i, pick in enumerate(picks1, start=1):
            flat = int(valid_idx1[pick[0]])
            row_, col_ = divmod(flat, w1)
            px_w = t1.c + col_ * t1.a
            px_n = t1.f + row_ * t1.e
            psu_bounds = (px_w, px_n + t1.e * 1, px_w + t1.a * 1, px_n)  # (w,s,e,n)
            psu_bounds = (px_w, px_n - psu_m, px_w + psu_m, px_n)
            features.append(("psu", None, 0, None, None,
                             {"psu": p_i}, (crs, psu_bounds)))

            grid2 = _grid_for(psu_bounds, crs, ssu_m)
            dem2 = read_grid(dem_hrefs, grid2) if dem_hrefs else None
            bands2, names2 = [], []
            if dem2 is not None:
                d2 = terrain_derivatives(dem2, ssu_m)
                for nm, arr in [("elevation", dem2)] + list(d2.items()):
                    bands2.append(arr); names2.append(nm)
            lc2 = None
            if lc1 is not None:
                lc2 = read_grid(_worldcover_tiles(
                    _bbox_of(psu_bounds, crs)), grid2, categorical=True)
                bands2.append(lc2); names2.append("landcover")
            stack2 = np.stack(bands2)
            if cropland_only and lc2 is not None:
                stack2.reshape(len(bands2), -1)[:, np.nan_to_num(lc2.ravel()) != 40] = np.nan
            X2, vidx2 = _standardise(stack2)
            k2 = min(ssu_per_psu, max(1, X2.shape[0] // 2))
            if X2.shape[0] < 1:
                logstep(f"PSU {p_i}: no valid SSU cells (fully masked) — skipped")
                continue
            C2, _, _ = csc_kmeans(X2, k2, seed + p_i, n_init=2, max_iter=40)
            picks2 = select_units(X2, C2, n_replacements=0)

            _, t2, w2, h2 = grid2
            for s_i, pick2 in enumerate(picks2, start=1):
                flat2 = int(vidx2[pick2[0]])
                r2_, c2_ = divmod(flat2, w2)
                sw = t2.c + c2_ * t2.a
                sn = t2.f + r2_ * t2.e
                ssu_bounds = (sw, sn - ssu_m, sw + ssu_m, sn)
                features.append(("ssu", None, 0, None, None,
                                 {"psu": p_i, "ssu": s_i}, (crs, ssu_bounds)))
                # stage 3: SRS points + ranked replacements inside the SSU
                n_needed = pts_per_ssu * 3  # target + 2 replacements each
                px = rng.uniform(sw, sw + ssu_m, n_needed)
                py = rng.uniform(sn - ssu_m, sn, n_needed)
                lon_pts, lat_pts = warp_transform(crs, "EPSG:4326",
                                                  px.tolist(), py.tolist())
                for t_i in range(pts_per_ssu):
                    for rank in range(3):
                        j = t_i * 3 + rank
                        sid = f"{iso3}-D{design_id:03d}-P{p_i:03d}-S{s_i:02d}-{t_i+1:02d}"
                        if rank:
                            sid += f"-R{rank}"
                        features.append(("point", sid, rank,
                                         float(lon_pts[j]), float(lat_pts[j]),
                                         {"psu": p_i, "ssu": s_i}, None))
                        total_pts += 0 if rank else 1
            logstep(f"PSU {p_i}/{n_psu}: {len(picks2)} SSUs, "
                    f"{len(picks2) * pts_per_ssu} points")

        # ---- persist ------------------------------------------------------
        logstep(f"Writing {total_pts} target points (plus replacements) to the design")
        def build_abstract(m):
            lines = [
                f"Soil sampling design for {m['iso3']}, generated {m['generated_at']} "
                f"with the SoilFER three-stage method (covariate space coverage).",
                f"Stage 1: {n_psu} primary units of {int(psu_m)} m selected over the "
                f"country by k-means in standardised covariate space "
                f"({', '.join(m['covariates_stage1'])}); quality (MSSD) "
                f"{m['quality']['stage1_mssd']:.4f}.",
                f"Stage 2: up to {ssu_per_psu} secondary units of {int(ssu_m)} m per "
                f"primary unit, CSC on terrain derivatives and land cover.",
                f"Stage 3: {pts_per_ssu} points per secondary unit by simple random "
                f"sampling, each with two ranked replacement locations.",
                "Constraint: cropland only (ESA WorldCover class 40)." if cropland_only
                else "No land-cover constraint applied.",
                f"Random seed {seed}; working CRS {crs}.",
                "Data sources (fetched at run time, not stored):",
            ]
            for src_ in m["sources"]:
                bits = [src_.get("id", "?")]
                if src_.get("url"): bits.append(src_["url"])
                if src_.get("stac"): bits.append(src_["stac"])
                if src_.get("url_base"): bits.append(src_["url_base"])
                if src_.get("licence"): bits.append(f"licence {src_['licence']}")
                if src_.get("checksum"): bits.append(f"checksum {src_['checksum']}")
                lines.append("  - " + ", ".join(bits))
            return "\n".join(lines)

        manifest = {
            "method": "Three-stage hierarchical CSC (SoilFER sampling design manual)",
            "iso3": iso3, "crs": crs, "seed": seed,
            "params": params, "covariates_stage1": band_names,
            "sources": manifest_sources,
            "quality": {"stage1_mssd": mssd1},
            "notes": ["Covariates fetched ephemerally and discarded after the run.",
                      "Stage-2 covariates: terrain derivatives + land cover at the "
                      "SSU grid; satellite composites are a planned follow-up."],
            "generated_at": _now(),
        }
        with get_db() as conn:
            with conn.cursor() as cur:
                for kind, sid, rank, lon, lat, props, poly in features:
                    if poly is not None:
                        pcrs, (bw, bs, be, bn) = poly
                        xs, ys = warp_transform(pcrs, "EPSG:4326",
                                                [bw, be, be, bw, bw],
                                                [bn, bn, bs, bs, bn])
                        coords = [[list(c) for c in zip(xs, ys)]]
                        gj = json.dumps({"type": "Polygon", "coordinates": coords})
                    else:
                        gj = json.dumps({"type": "Point", "coordinates": [lon, lat]})
                    cur.execute("""
                        INSERT INTO api.sampling_design_feature
                            (design_id, kind, sample_id, rank, geom, props)
                        VALUES (%s, %s, %s, %s,
                                ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s)
                    """, (design_id, kind, sid, rank, gj, json.dumps(props)))
                cur.execute("""UPDATE api.sampling_design
                               SET status='done', manifest=%s, abstract=%s,
                                   quality=%s, finished_at=now()
                               WHERE design_id=%s""",
                            (json.dumps(manifest), build_abstract(manifest),
                             json.dumps(manifest["quality"]), design_id))
        logstep("Design complete")

    except Exception as e:  # noqa: BLE001 — surface everything to the row
        log.exception("sampling design %s failed", design_id)
        fail(f"{type(e).__name__}: {e}")


def _bbox_of(bounds_utm, crs):
    w, s, e, n = bounds_utm
    xs, ys = warp_transform(crs, "EPSG:4326", [w, e], [s, n])
    return (min(xs), min(ys), max(xs), max(ys))
