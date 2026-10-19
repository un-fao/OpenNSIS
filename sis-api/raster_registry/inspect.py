"""Read raster metadata from a GeoTIFF — what soil_data.layer needs.

Port of /home/carva014/Work/Code/FAO/GloSIS-private/Metadata/02_geotiff_metadata_to_postgres.py
(extraction only — the DB INSERTs live in populate.py).
"""

import math
import os
from typing import Optional, List
from pydantic import BaseModel

import warnings

import numpy as np
import rasterio
from rasterio.warp import transform_bounds


def ensure_nodata(path: str) -> Optional[float]:
    """If band 1 declares no NoData, assign a sensible one *in place* and return
    it; return None if the file already had one (then it's left untouched).

    Mirrors the manual pre-clean operators used to run before upload:
      * a -999 background  → standardise on -9999 (remap the pixels + tag);
      * data min > -9999   → -9999 is a safe sentinel below the data → tag only;
      * data dips < -9999  → a very-negative float sentinel (-3.4e38) / the int
                             dtype minimum → tag only.

    Only the -999 case rewrites pixels (block-wise, so memory stays bounded on
    large rasters); every other case just stamps the NoData tag. Single-band
    rasters (what the rest of the pipeline assumes) — band 1 only.
    """
    with rasterio.open(path) as src:
        nd = src.nodatavals[0] if src.nodatavals else None
        if nd is not None and not (isinstance(nd, float) and math.isnan(nd)):
            return None                      # already declared — leave as-is
        dt = np.dtype(src.dtypes[0])
        is_float = np.issubdtype(dt, np.floating)
        profile = src.profile.copy()
        try:
            dmin = float(src.stats(indexes=[1])[0].min)
        except Exception:
            a = src.read(1, masked=True)
            dmin = float(a.min()) if a.count() else 0.0

    remap_from = None
    if abs(dmin + 999.0) < 1e-3:             # -999 background → standard -9999
        nodata, remap_from = -9999.0, -999.0
    elif dmin > -9999.0:                      # -9999 sits below the data → safe
        nodata = -9999.0
    else:                                     # data goes very negative
        nodata = -3.4e38 if is_float else float(np.iinfo(dt).min)
    if not is_float:                          # keep it representable in the dtype
        info = np.iinfo(dt)
        if not (info.min <= nodata <= info.max):
            nodata = float(info.min)

    if remap_from is None:
        # No pixels to touch — just stamp the tag (cheap, no full read/write).
        # IGNORE_COG_LAYOUT_BREAK: GDAL refuses to update a Cloud-Optimised
        # GeoTIFF in place without it (the upload may well be a COG already).
        # Breaking the layout here is harmless — register re-encodes the file
        # as a fresh COG via to_cog() afterwards.
        with rasterio.open(path, "r+", IGNORE_COG_LAYOUT_BREAK="YES") as dst:
            dst.nodata = nodata
        return nodata

    # Remap the -999 background → nodata, one block at a time.
    profile.update(nodata=nodata)
    tmp = path + ".nd.tif"
    with rasterio.open(path) as src, rasterio.open(tmp, "w", **profile) as dst:
        for _, window in src.block_windows(1):
            block = src.read(1, window=window)
            block = np.where(block == remap_from, nodata, block).astype(dt)
            dst.write(block, 1, window=window)
    os.replace(tmp, path)
    return nodata


def to_cog(src_path: str, dst_path: Optional[str] = None) -> str:
    """Rewrite a raster as a Cloud-Optimised GeoTIFF (in place, or to dst_path).

    DEFLATE + predictor 2, 512-px internal tiles, and overviews resampled with
    NEAREST — which keeps categorical values intact and loses nothing meaningful
    on continuous data. GDAL's COG driver is CreateCopy-only, so it reads the
    source and writes a fresh COG; the result is swapped in atomically (a new
    inode also forces MapServer's GDAL cache to re-read). Any NoData already set
    on the source is preserved. Shared by the raster upload and the DST engine.
    """
    import rasterio.shutil as _rio_shutil
    out = dst_path or src_path
    tmp = out + ".cog.tif"
    try:
        _rio_shutil.copy(
            src_path, tmp, driver="COG",
            compress="DEFLATE", predictor=2, blocksize=512,
            overview_resampling="nearest", num_threads="ALL_CPUS",
        )
        os.replace(tmp, out)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise
    return out


def distinct_int_values(path: str, cap: int = 60) -> Optional[List[int]]:
    """Distinct band-1 values of a class-like raster, NoData excluded.

    Returns the sorted integer values, or None when the raster is not
    class-like: any non-integral value, or more than `cap` distinct values
    (the scan stops at the first value past the cap, so a continuous raster
    mistakenly uploaded under a categorical property exits early instead of
    reading the whole file).
    """
    with rasterio.open(path) as src:
        nd = src.nodatavals[0] if src.nodatavals else None
        nd_is_nan = isinstance(nd, float) and math.isnan(nd)
        seen: set = set()
        for _, window in src.block_windows(1):
            arr = src.read(1, window=window)
            if np.issubdtype(arr.dtype, np.floating):
                arr = arr[~np.isnan(arr)]
            if nd is not None and not nd_is_nan:
                arr = arr[arr != nd]
            if arr.size == 0:
                continue
            vals = np.unique(arr)
            if np.issubdtype(vals.dtype, np.floating) and not np.all(np.mod(vals, 1) == 0):
                return None
            seen.update(int(v) for v in vals)
            if len(seen) > cap:
                return None
        return sorted(seen)


def _clean_float(v) -> Optional[float]:
    """Return None for NaN / infinity / None — keeps the JSON encoder happy."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _convert_size(size_bytes: int) -> str:
    if size_bytes <= 0:
        return "0 B"
    units = ("B", "KB", "MB", "GB", "TB", "PB")
    i = min(int(math.floor(math.log(size_bytes, 1024))), len(units) - 1)
    return f"{round(size_bytes / (1024 ** i), 2)} {units[i]}"


class BandStats(BaseModel):
    band_number: int
    data_type: Optional[str] = None
    no_data_value: Optional[float] = None
    stats_minimum: Optional[float] = None
    stats_maximum: Optional[float] = None
    stats_mean: Optional[float] = None
    stats_std_dev: Optional[float] = None


class RasterMetadata(BaseModel):
    file_path: str
    file_name: str
    file_extension: str
    file_size: int
    file_size_pretty: str

    # From filename (best-effort, expects '<CC>-<PROJ>-<PROP>-<dim1>-<dim2>-<stats>')
    layer_id: str
    country_id: Optional[str] = None
    project_id: Optional[str] = None
    property_id: Optional[str] = None
    mapset_id: Optional[str] = None
    dimension_depth: Optional[str] = None
    dimension_stats: Optional[str] = None

    # Raster geometry
    raster_size_x: int
    raster_size_y: int
    pixel_size_x: float
    pixel_size_y: float
    origin_x: float
    origin_y: float
    distance: float
    distance_uom: str

    # CRS
    reference_system_identifier_code: Optional[str] = None
    spatial_reference: Optional[str] = None

    # Driver / data
    n_bands: int
    compression: Optional[str] = None
    distribution_format: Optional[str] = None

    # Bounds in native + WGS84
    extent: str
    west_bound_longitude: float
    east_bound_longitude: float
    north_bound_latitude: float
    south_bound_latitude: float

    bands: List[BandStats] = []


def _parse_layer_id(layer_id: str) -> dict:
    """Decomposition of the SIS layer-id convention:
       <CC>-<PROJ>-<PROP>-<YEAR>-<upper>-<lower>-<stats>
    `dimension_depth` is just <upper>-<lower>; the year sits in the
    mapset_id and is not part of the depth string."""
    parts = layer_id.split("-")
    out = {}
    if len(parts) >= 1: out["country_id"] = parts[0]
    if len(parts) >= 2: out["project_id"] = parts[1]
    if len(parts) >= 3: out["property_id"] = parts[2]
    if len(parts) >= 4: out["mapset_id"] = "-".join(parts[:4])
    if len(parts) >= 6: out["dimension_depth"] = f"{parts[4]}-{parts[5]}"
    if len(parts) >= 7: out["dimension_stats"] = parts[6]
    return out


def inspect_geotiff(tif_path: str) -> RasterMetadata:
    """Read a GeoTIFF and return all metadata needed for soil_data.layer."""
    if not os.path.exists(tif_path):
        raise FileNotFoundError(tif_path)

    file_name = os.path.basename(tif_path)
    file_ext = os.path.splitext(file_name)[1].lstrip(".").lower()
    if file_ext not in {"tif", "tiff", "asc", "ecw", "grb", "rb2", "hdf", "jpg", "nc"}:
        raise ValueError(f"Unsupported file extension: {file_ext}")

    file_size = os.path.getsize(tif_path)
    layer_id = os.path.splitext(file_name)[0]

    with rasterio.open(tif_path) as src:
        crs = src.crs
        transform = src.transform
        bounds = src.bounds   # native CRS

        # Pixel size, origin
        pixel_size_x = abs(transform.a)
        pixel_size_y = abs(transform.e)
        origin_x = transform.c
        origin_y = transform.f

        # Distance UoM from CRS
        if crs and crs.is_geographic:
            distance_uom = "deg"
        elif crs and crs.is_projected:
            distance_uom = "m"
        else:
            distance_uom = "UNKNOWN"

        # EPSG code (if any)
        epsg_code = None
        if crs:
            try:
                epsg = crs.to_epsg()
                if epsg is not None:
                    epsg_code = str(epsg)
            except Exception:
                pass

        # WGS84 bounds
        try:
            west_lon, south_lat, east_lon, north_lat = transform_bounds(
                crs, "EPSG:4326",
                bounds.left, bounds.bottom, bounds.right, bounds.top,
                densify_pts=21
            ) if crs else (bounds.left, bounds.bottom, bounds.right, bounds.top)
        except Exception:
            west_lon, south_lat, east_lon, north_lat = (
                bounds.left, bounds.bottom, bounds.right, bounds.top
            )

        # Native extent string (matches 02's format)
        extent = f"{bounds.left} {bounds.bottom} {bounds.right} {bounds.top}"

        # Compression / format
        compression = src.profile.get("compress")
        if isinstance(compression, str):
            compression = compression.upper()
        distribution_format = "GeoTIFF" if file_ext in {"tif", "tiff"} else file_ext.upper()

        # Per-band statistics — uses rasterio.stats() which delegates to
        # GDAL (equivalent of `gdalinfo -stats`). Falls back to the
        # masked-array path if GDAL returns nothing (e.g. all-NoData band).
        bands: List[BandStats] = []
        for band_idx in range(1, src.count + 1):
            stats = None
            # Force a fresh recompute (clear_cache) honouring NoData. Some
            # producers ship bogus cached STATISTICS_MEAN/STDDEV (e.g. -9999)
            # that GDAL would otherwise return as-is; recomputing also reflects
            # any NoData we just assigned, and skips NaN.
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")  # statistics() is deprecated in rasterio 2.0
                    st = src.statistics(band_idx, approx=False, clear_cache=True)
                if st is not None:
                    stats = (float(st.min), float(st.max),
                             float(st.mean), float(st.std))
            except Exception:
                stats = None

            if stats is None:
                try:
                    arr = src.read(band_idx, masked=True)
                    if arr.count() > 0:
                        stats = (
                            float(arr.min()), float(arr.max()),
                            float(arr.mean()), float(arr.std()),
                        )
                except Exception:
                    pass

            nodata = src.nodatavals[band_idx - 1] if src.nodatavals else None
            if nodata is not None and (isinstance(nodata, float) and math.isnan(nodata)):
                nodata = None

            bands.append(BandStats(
                band_number=band_idx,
                data_type=src.dtypes[band_idx - 1],
                no_data_value=_clean_float(nodata),
                stats_minimum=_clean_float(stats[0]) if stats else None,
                stats_maximum=_clean_float(stats[1]) if stats else None,
                stats_mean=_clean_float(stats[2]) if stats else None,
                stats_std_dev=_clean_float(stats[3]) if stats else None,
            ))

        parsed = _parse_layer_id(layer_id)

        return RasterMetadata(
            file_path=os.path.dirname(tif_path),
            file_name=file_name,
            file_extension=file_ext,
            file_size=file_size,
            file_size_pretty=_convert_size(file_size),

            layer_id=layer_id,
            country_id=parsed.get("country_id"),
            project_id=parsed.get("project_id"),
            property_id=parsed.get("property_id"),
            mapset_id=parsed.get("mapset_id"),
            dimension_depth=parsed.get("dimension_depth"),
            dimension_stats=parsed.get("dimension_stats"),

            raster_size_x=src.width,
            raster_size_y=src.height,
            pixel_size_x=pixel_size_x,
            pixel_size_y=pixel_size_y,
            origin_x=origin_x,
            origin_y=origin_y,
            distance=pixel_size_x,
            distance_uom=distance_uom,

            reference_system_identifier_code=epsg_code,
            spatial_reference=str(crs) if crs else None,

            n_bands=src.count,
            compression=compression,
            distribution_format=distribution_format,

            extent=extent,
            west_bound_longitude=_clean_float(west_lon) or 0.0,
            east_bound_longitude=_clean_float(east_lon) or 0.0,
            north_bound_latitude=_clean_float(north_lat) or 0.0,
            south_bound_latitude=_clean_float(south_lat) or 0.0,

            bands=bands,
        )
