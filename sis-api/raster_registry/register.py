"""Orchestrator — the one function both DST and Add-Raster call.

Steps:
  1. inspect (extract metadata)
  2. populate soil_data.*  → DB triggers generate .map / .sld
  3. render XML
  4. load into pyCSW

The caller passes a *committed* connection-or-not? — currently we expect
the caller to manage transactions. The orchestrator does NOT call commit
because the surrounding HTTP handler typically wants to commit/rollback
once everything succeeds (or fails).
"""

import logging
import os
from typing import Optional, List
from pydantic import BaseModel

from .inspect import inspect_geotiff, distinct_int_values, RasterMetadata
from .populate import populate_spatial_metadata, ClassDef
from .xml_render import render_xml
from .pycsw_load import write_xml_and_load

log = logging.getLogger("raster_registry")


MAPSERVER_WMS_URL = os.getenv("MAPSERVER_WMS_URL", "http://localhost:8004")
DOWNLOAD_BASE_URL_DEFAULT = "/downloads/"


class ContactRef(BaseModel):
    organisation_id: Optional[str] = None
    individual_id: Optional[str] = None
    role: str = "pointOfContact"


class RegisteredLayer(BaseModel):
    layer_id: str
    spatial_metadata_layer_inserted: bool
    xml_published: bool
    xml_path: Optional[str] = None
    map_path: Optional[str] = None
    warnings: List[str] = []
    meta: Optional[RasterMetadata] = None


def _build_browse_graphic_url(map_path: str, layer_id: str,
                              west, south, east, north, max_size: int = 512) -> str:
    """WMS 1.1.1 GetMap URL that returns a JPEG preview of the layer.
    WMS 1.1.1 + SRS=EPSG:4326 has lon/lat axis order, so BBOX = west,south,east,north.
    Width/Height preserve the bbox aspect ratio, capped at `max_size`."""
    try:
        w = float(east) - float(west)
        h = float(north) - float(south)
    except Exception:
        w, h = 1.0, 1.0
    if w <= 0 or h <= 0:
        w, h = 1.0, 1.0
    if w >= h:
        width = max_size
        height = max(int(round(max_size * h / w)), 1)
    else:
        height = max_size
        width = max(int(round(max_size * w / h)), 1)
    return (
        f"{MAPSERVER_WMS_URL}/?map={map_path}"
        f"&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap"
        f"&LAYERS={layer_id}&STYLES=&FORMAT=image%2Fjpeg"
        f"&SRS=EPSG:4326&BBOX={west},{south},{east},{north}"
        f"&WIDTH={width}&HEIGHT={height}"
    )


def _build_wms_urls(map_path: str, layer_id: str):
    base = MAPSERVER_WMS_URL
    get_map = (f"{base}/?map={map_path}&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
               f"&LAYERS={layer_id}&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=TRUE")
    get_legend = (f"{base}/?map={map_path}&SERVICE=WMS&VERSION=1.1.1"
                  f"&LAYER={layer_id}&REQUEST=getlegendgraphic&FORMAT=image/png")
    get_feature_info = (f"{base}/?map={map_path}&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo"
                        f"&LAYERS={layer_id}&QUERY_LAYERS={layer_id}&INFO_FORMAT=text%2Fhtml")
    return get_map, get_legend, get_feature_info


def _resolve_download_url(cur, layer_id: str) -> str:
    cur.execute("SELECT value FROM api.setting WHERE key = 'DOWNLOAD_BASE_URL'")
    row = cur.fetchone()
    base = (row[0] if row else None) or DOWNLOAD_BASE_URL_DEFAULT
    if not base.endswith("/"):
        base += "/"
    return f"{base}{layer_id}.tif"


def _class_palette(n: int) -> List[str]:
    """n visually distinct hex colours — golden-angle hue spacing, so
    neighbouring class codes don't get neighbouring hues."""
    import colorsys
    out = []
    for i in range(n):
        h = (i * 0.618033988749895) % 1.0
        r, g, b = colorsys.hsv_to_rgb(h, 0.60, 0.85)
        out.append("#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255)))
    return out


def register_raster(
    conn,
    tif_path: str,
    *,
    project_name: Optional[str] = None,
    title: Optional[str] = None,
    abstract: Optional[str] = None,
    classes: Optional[List[ClassDef]] = None,
    keywords: Optional[List[str]] = None,
    contacts: Optional[List[ContactRef]] = None,
    license: Optional[str] = None,
    publish: bool = True,
    dst_recipe_id: Optional[str] = None,
    publication_date: Optional[str] = None,
    property_num_id: Optional[str] = None,
    unit_of_measure_id: Optional[str] = None,
    time_period_begin: Optional[str] = None,
    time_period_end: Optional[str] = None,
    file_orig_name: Optional[str] = None,
    extra_keywords_theme: Optional[List[str]] = None,
) -> RegisteredLayer:
    """End-to-end registration of a GeoTIFF into the SIS catalogue.

    `tif_path` must be the absolute path to the TIFF as visible from inside
    the sis-api container — typically `/srv/rasters/<layer_id>.tif`.

    Both DST runs and Add-Raster uploads converge here.
    """
    warnings: List[str] = []

    # 1. Inspect
    meta = inspect_geotiff(tif_path)

    # 1b. Default legend for categorical properties. Without soil_data.class
    # rows the map/SLD generators fall back to a continuous colour ramp,
    # which is meaningless for class codes — so seed one class per value
    # actually present in the raster (never min..max fill: sparse codings
    # like 11, 12, 111, 112 would invent classes that don't exist). Skipped
    # when the caller ships classes (DST recipes) or the mapset already has
    # a legend (re-upload after the admin edited it).
    if classes is None:
        with conn.cursor() as cur:
            cur.execute("""SELECT property_type FROM soil_data.mapped_property
                           WHERE mapped_property_id = %s""", (meta.property_id,))
            row = cur.fetchone()
            if row and row[0] == "categorical":
                cur.execute("SELECT count(*) FROM soil_data.class WHERE mapset_id = %s",
                            (meta.mapset_id,))
                if cur.fetchone()[0] == 0:
                    vals = distinct_int_values(tif_path)
                    if vals:
                        palette = _class_palette(len(vals))
                        classes = [ClassDef(value=float(v), code=str(v), label=str(v),
                                            color=palette[i])
                                   for i, v in enumerate(vals)]
                        log.info("seeded %d default classes for categorical %s",
                                 len(vals), meta.mapset_id)
                    else:
                        warnings.append(
                            "categorical property, but no default legend could be "
                            "derived (non-integer values or more than 60 distinct "
                            "classes) — define the classes in the legend editor")

    # 2. Populate soil_data.* (also fires .map / .sld triggers)
    populate_spatial_metadata(
        conn, meta,
        title=title or meta.layer_id,
        abstract=abstract,
        classes=classes,
        keywords_theme=keywords,
        other_constraints=license,
        publication_date=publication_date,
        property_num_id=property_num_id,
        unit_of_measure_id=unit_of_measure_id,
        time_period_begin=time_period_begin,
        time_period_end=time_period_end,
        file_orig_name=file_orig_name,
        extra_keywords_theme=extra_keywords_theme,
    )

    # 2b. Materialise the .map file MapServer reads at runtime.
    # The DB trigger map_func_on_layer_table populates soil_data.layer.map
    # with the rendered MAP content; we just need to dump it next to the
    # raster on disk (/srv/rasters/ inside sis-api is bind-mounted as
    # /etc/mapserver/ inside sis-web-services).
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT map FROM soil_data.layer WHERE layer_id = %s",
                (meta.layer_id,),
            )
            row = cur.fetchone()
            map_text = row[0] if row else None
        if map_text:
            map_out = os.path.join("/srv/rasters", f"{meta.layer_id}.map")
            with open(map_out, "w", encoding="utf-8") as fh:
                fh.write(map_text)
        else:
            warnings.append(
                "soil_data.layer.map is empty (stats may be NULL); "
                "MapServer will have no .map file for this layer"
            )
    except Exception as e:
        log.exception(".map export failed for %s", meta.layer_id)
        warnings.append(f".map export failed: {e}")

    # 2c. Persist online-resource URLs (WMS + download) in soil_data.url
    # keyed by mapset_id. xml_render reads this table to fill the
    # <gmd:onLine> / transferOptions block of the ISO 19139 record —
    # without these rows, federation harvesters see no way to fetch data.
    map_path_on_disk_for_urls = f"/etc/mapserver/{meta.layer_id}.map"
    wms_get_map, _wms_legend, _wms_finfo = _build_wms_urls(
        map_path_on_disk_for_urls, meta.layer_id)
    try:
        with conn.cursor() as cur:
            download_url_for_urls = _resolve_download_url(cur, meta.layer_id)
            wms_caps = (f"{MAPSERVER_WMS_URL}/?map={map_path_on_disk_for_urls}"
                        f"&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities")
            url_rows = [
                ("OGC:WMS", wms_caps,
                 f"{meta.layer_id} WMS",
                 "Web Map Service — GetCapabilities"),
                ("WWW:LINK-1.0-http--link", download_url_for_urls,
                 f"{meta.layer_id}.tif",
                 "GeoTIFF download"),
            ]
            for protocol, url, name, descr in url_rows:
                cur.execute("""
                    INSERT INTO soil_data.url
                        (mapset_id, protocol, url, url_name, url_description)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (mapset_id, protocol, url) DO UPDATE SET
                        url_name        = EXCLUDED.url_name,
                        url_description = EXCLUDED.url_description
                """, (meta.mapset_id, protocol, url, name, descr))
    except Exception as e:
        log.exception("URL inserts failed for %s", meta.layer_id)
        warnings.append(f"online resource URL insert failed: {e}")

    # 2d. Browse-graphic (thumbnail) URL — a WMS GetMap that returns a JPEG.
    # Stored in soil_data.mapset.md_browse_graphic; the ISO 19139 record's
    # <gmd:graphicOverview><gmd:fileName> reads from this column.
    try:
        thumb_url = _build_browse_graphic_url(
            map_path_on_disk_for_urls, meta.layer_id,
            meta.west_bound_longitude, meta.south_bound_latitude,
            meta.east_bound_longitude, meta.north_bound_latitude,
        )
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE soil_data.mapset SET md_browse_graphic = %s WHERE mapset_id = %s",
                (thumb_url, meta.mapset_id),
            )
    except Exception as e:
        log.exception("md_browse_graphic update failed for %s", meta.layer_id)
        warnings.append(f"md_browse_graphic update failed: {e}")

    # 3. XML render — fills soil_data.mapset.xml and returns the record
    xml_published = False
    xml_path: Optional[str] = None
    if publish:
        try:
            xml_content = render_xml(conn, meta.layer_id)
        except Exception as e:
            log.exception("render_xml failed for %s", meta.layer_id)
            warnings.append(f"xml_render failed: {e}")
            xml_content = None

        # 4. pyCSW load — write to disk + best-effort CSW-T transaction
        if xml_content:
            try:
                result = write_xml_and_load(meta.layer_id, xml_content)
                xml_path = result.get("xml_path")
                xml_published = bool(result.get("transaction_ok"))
                if not xml_published and result.get("transaction_error"):
                    warnings.append(
                        f"pyCSW transaction did not complete: {result['transaction_error']}"
                    )
            except Exception as e:
                log.exception("pycsw_load failed for %s", meta.layer_id)
                warnings.append(f"pycsw_load failed: {e}")

    map_path_on_disk = f"/etc/mapserver/{meta.layer_id}.map"

    return RegisteredLayer(
        layer_id=meta.layer_id,
        spatial_metadata_layer_inserted=True,
        xml_published=xml_published,
        xml_path=xml_path,
        map_path=map_path_on_disk,
        warnings=warnings,
        meta=meta,
    )
