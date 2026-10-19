"""Write soil_data.* from a RasterMetadata block.

Port of the DB-write half of
/home/carva014/Work/Code/FAO/GloSIS-private/Metadata/02_geotiff_metadata_to_postgres.py
adapted to be idempotent (upsert) so re-registering a layer doesn't fail.

DB triggers fire automatically when stats_minimum / stats_maximum are set
on soil_data.layer:
  - class_func_on_layer_table → populates soil_data.class
  - map_func_on_layer_table   → populates soil_data.layer.map (the
                                 MapServer .map file content)
  - sld_func_on_class_table   → populates soil_data.mapset.sld (the
                                 SLD style content)

So this module only writes the identity + metadata rows; .map / .sld /
class entries appear automatically.
"""

from typing import Optional, List
from pydantic import BaseModel

from .inspect import RasterMetadata


# soil_data.layer.dimension_stats CHECK constraint allows only:
_ALLOWED_DIMENSION_STATS = {"MEAN", "SDEV", "UNCT", "X"}


class ClassDef(BaseModel):
    """One class for soil_data.class — overrides the auto-classification
    that the class trigger produces from stats_min/max. Used by DST recipes
    that ship explicit colour ramps."""
    value: float
    code: str
    label: str
    color: str          # hex like '#1a9850'
    opacity: float = 1.0
    publish: bool = True


def _normalise_dimension_stats(v: Optional[str]) -> str:
    if not v:
        return "X"
    v = v.upper()
    return v if v in _ALLOWED_DIMENSION_STATS else "X"


def populate_spatial_metadata(
    conn,
    meta: RasterMetadata,
    *,
    title: Optional[str] = None,
    abstract: Optional[str] = None,
    classes: Optional[List[ClassDef]] = None,
    keywords_theme: Optional[List[str]] = None,
    keywords_place: Optional[List[str]] = None,
    keywords_discipline: Optional[List[str]] = None,
    other_constraints: Optional[str] = None,
    publication_date: Optional[str] = None,
    property_num_id: Optional[str] = None,
    unit_of_measure_id: Optional[str] = None,
    time_period_begin: Optional[str] = None,
    time_period_end: Optional[str] = None,
    file_orig_name: Optional[str] = None,
    extra_keywords_theme: Optional[List[str]] = None,
) -> None:
    """Upsert into soil_data.project, mapset, layer (and optionally
    class). All-or-nothing transaction.

    The caller owns the connection. We don't commit — the orchestrator
    does that once the XML / pyCSW side has also succeeded.
    """
    if not (meta.country_id and meta.project_id
            and meta.property_id and meta.mapset_id):
        raise ValueError(
            "Cannot populate spatial_metadata: layer_id must decompose into "
            "country_id, project_id, property_id, mapset_id (got "
            f"layer_id={meta.layer_id!r}, parts={meta.country_id!r}/"
            f"{meta.project_id!r}/{meta.property_id!r}/{meta.mapset_id!r})"
        )

    dim_stats = _normalise_dimension_stats(meta.dimension_stats)

    with conn.cursor() as cur:
        # 1. project — created on demand. soil_data.project.name is
        #    NOT NULL UNIQUE; fall back to a country-qualified id.
        cur.execute("""
            INSERT INTO soil_data.project (country_id, project_id, name)
            VALUES (%s, %s, %s)
            ON CONFLICT (country_id, project_id) DO NOTHING
        """, (meta.country_id, meta.project_id,
              f"{meta.country_id}-{meta.project_id}"))

        # 1b. mapped_property — created on demand with quantitative defaults.
        # Upload GeoTIFF passes an existing mapped_property_id from the
        # soil_data.mapped_property catalogue (no-op here on conflict).
        # DST runs may mint a fresh id (e.g. DST/SUITABILITY) so we still
        # need the INSERT branch. We do NOT touch property_num_id — the
        # catalogue is the source of truth for that FK; new stubs get NULL.
        cur.execute("""
            INSERT INTO soil_data.mapped_property
                (mapped_property_id, name, property_type, num_intervals,
                 start_color, end_color)
            VALUES (%s, %s, 'quantitative', 5, '#a50026', '#1a9850')
            ON CONFLICT (mapped_property_id) DO NOTHING
        """, (meta.property_id, meta.property_id))

        # The visible group: classified properties land under their class
        # ("Chemical"/"Physical", from the catalogue keywords — matching how
        # the map panel groups them); everything else keeps the project code.
        cur.execute(
            "SELECT keyword_theme FROM soil_data.mapped_property WHERE mapped_property_id = %s",
            (meta.property_id,))
        _row = cur.fetchone()
        _kws = {str(k).lower() for k in ((_row[0] if _row else None) or [])}
        _kws |= {str(k).lower() for k in (extra_keywords_theme or [])}
        if "chemical" in _kws:
            costum_group = "Chemical"
        elif "physical" in _kws:
            costum_group = "Physical"
        else:
            costum_group = meta.project_id

        # 2. mapset — created on demand. mapset.mapped_property_id is the FK
        #    column referencing soil_data.mapped_property(mapped_property_id).
        # "Created on" date (publication_date arg) goes into creation_date
        # and revision_date. The mapset.publication_date column tracks when
        # the file was uploaded into the SIS — that's CURRENT_DATE here.
        # keyword_theme merges the property's catalogue keywords, the
        # caller-supplied upload keywords (keywords_theme — previously
        # accepted but silently dropped, so records for new properties were
        # born without subject keywords) and any internal extras.
        cur.execute("""
            INSERT INTO soil_data.mapset
                (country_id, project_id, mapped_property_id, mapset_id, title, abstract,
                 other_constraints, publication_date, revision_date, creation_date,
                 unit_of_measure_id, time_period_begin, time_period_end,
                 costum_group, keyword_theme, keyword_place)
            VALUES (%s, %s, %s, %s, %s, %s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, %s,
                    -- keyword_theme: property catalogue keywords ∪ caller
                    -- upload keywords ∪ internal extras, de-duplicated.
                    ARRAY(SELECT DISTINCT k FROM unnest(
                      COALESCE((SELECT keyword_theme FROM soil_data.mapped_property
                                WHERE mapped_property_id = %s), '{}'::text[])
                      || %s::text[]
                      || %s::text[]
                    ) AS k),
                    (SELECT ARRAY_REMOVE(ARRAY[un_reg, en], NULL)
                     FROM soil_data.country
                     WHERE country_id = (SELECT value FROM api.setting WHERE key='COUNTRY_CODE')))
            ON CONFLICT (mapset_id) DO UPDATE SET
                title              = COALESCE(EXCLUDED.title,              soil_data.mapset.title),
                abstract           = COALESCE(EXCLUDED.abstract,           soil_data.mapset.abstract),
                other_constraints  = COALESCE(EXCLUDED.other_constraints,  soil_data.mapset.other_constraints),
                publication_date   = EXCLUDED.publication_date,
                revision_date      = COALESCE(EXCLUDED.revision_date,      soil_data.mapset.revision_date),
                creation_date      = COALESCE(EXCLUDED.creation_date,      soil_data.mapset.creation_date),
                unit_of_measure_id = COALESCE(EXCLUDED.unit_of_measure_id, soil_data.mapset.unit_of_measure_id),
                time_period_begin  = COALESCE(EXCLUDED.time_period_begin,  soil_data.mapset.time_period_begin),
                time_period_end    = COALESCE(EXCLUDED.time_period_end,    soil_data.mapset.time_period_end),
                costum_group       = COALESCE(EXCLUDED.costum_group,       soil_data.mapset.costum_group),
                keyword_theme      = COALESCE(EXCLUDED.keyword_theme,      soil_data.mapset.keyword_theme),
                keyword_place      = COALESCE(EXCLUDED.keyword_place,      soil_data.mapset.keyword_place)
        """, (meta.country_id, meta.project_id, meta.property_id, meta.mapset_id,
              title, abstract, other_constraints,
              publication_date, publication_date,
              unit_of_measure_id, time_period_begin, time_period_end,
              costum_group, meta.property_id,
              list(keywords_theme or []),
              list(extra_keywords_theme or [])))

        # 3. layer — identity row first (upsert)
        cur.execute("""
            INSERT INTO soil_data.layer
                (mapset_id, layer_id, file_path, file_extension,
                 dimension_depth, dimension_stats, file_size, file_size_pretty,
                 file_orig_name, costum_name)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (layer_id) DO UPDATE SET
                mapset_id        = EXCLUDED.mapset_id,
                file_path        = EXCLUDED.file_path,
                file_extension   = EXCLUDED.file_extension,
                dimension_depth  = EXCLUDED.dimension_depth,
                dimension_stats  = EXCLUDED.dimension_stats,
                file_size        = EXCLUDED.file_size,
                file_size_pretty = EXCLUDED.file_size_pretty,
                file_orig_name   = COALESCE(EXCLUDED.file_orig_name, soil_data.layer.file_orig_name),
                costum_name      = COALESCE(EXCLUDED.costum_name,    soil_data.layer.costum_name)
        """, (meta.mapset_id, meta.layer_id, meta.file_path, meta.file_extension,
              meta.dimension_depth, dim_stats, meta.file_size, meta.file_size_pretty,
              file_orig_name, title))

        # 4. layer — GDAL/rasterio-extracted fields. We update in two passes:
        #    first the non-trigger columns, then the trigger-sensitive ones
        #    (stats_minimum, stats_maximum, extent, ...) so the map_func and
        #    class_func triggers fire exactly once with the final values.
        cur.execute("""
            UPDATE soil_data.layer SET
                raster_size_x = %s,
                raster_size_y = %s,
                pixel_size_x  = %s,
                pixel_size_y  = %s,
                origin_x      = %s,
                origin_y      = %s,
                distance      = %s,
                spatial_reference = %s,
                n_bands       = %s,
                compression   = %s,
                distribution_format = %s,
                west_bound_longitude = %s,
                east_bound_longitude = %s,
                north_bound_latitude = %s,
                south_bound_latitude = %s
            WHERE layer_id = %s
        """, (
            meta.raster_size_x, meta.raster_size_y,
            meta.pixel_size_x, meta.pixel_size_y,
            meta.origin_x, meta.origin_y, meta.distance,
            meta.spatial_reference,
            meta.n_bands, meta.compression, meta.distribution_format,
            meta.west_bound_longitude, meta.east_bound_longitude,
            meta.north_bound_latitude, meta.south_bound_latitude,
            meta.layer_id,
        ))

        # Per-band info — store the first band's stats on the layer row
        # (single-band rasters are the norm; multi-band is rare in this stack).
        first_band = meta.bands[0] if meta.bands else None
        data_type = first_band.data_type if first_band else None
        no_data_value = first_band.no_data_value if first_band else None
        stats_min = first_band.stats_minimum if first_band else None
        stats_max = first_band.stats_maximum if first_band else None
        stats_mean = first_band.stats_mean if first_band else None
        stats_std_dev = first_band.stats_std_dev if first_band else None

        cur.execute("""
            UPDATE soil_data.layer SET
                data_type     = %s,
                no_data_value = %s,
                stats_mean    = %s,
                stats_std_dev = %s
            WHERE layer_id = %s
        """, (data_type, no_data_value, stats_mean, stats_std_dev, meta.layer_id))

        # Trigger-sensitive update last — fires class_func + map_func.
        # distance_uom and reference_system_identifier_code feed map_func.
        cur.execute("""
            UPDATE soil_data.layer SET
                distance_uom = %s,
                reference_system_identifier_code = %s,
                extent = %s,
                stats_minimum = %s,
                stats_maximum = %s
            WHERE layer_id = %s
        """, (meta.distance_uom, meta.reference_system_identifier_code,
              meta.extent, stats_min, stats_max, meta.layer_id))

        # 5. Optional user-supplied class rows. These OVERWRITE the auto-class
        #    that the class trigger just produced; useful for DST suitability
        #    maps that ship explicit colour ramps.
        if classes:
            cur.execute("DELETE FROM soil_data.class WHERE mapset_id = %s",
                        (meta.mapset_id,))
            for c in classes:
                cur.execute("""
                    INSERT INTO soil_data.class
                        (mapset_id, value, code, label, color, opacity, publish)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                """, (meta.mapset_id, c.value, c.code, c.label, c.color, c.opacity, c.publish))
            # The map trigger fired at step 4, before these rows existed, so
            # layer.map still styles a ramp. Touch a map-trigger column that
            # the class trigger does NOT watch (extent), so map() regenerates
            # with the class styles without class() clobbering the rows just
            # written.
            cur.execute("UPDATE soil_data.layer SET extent = extent WHERE mapset_id = %s",
                        (meta.mapset_id,))
