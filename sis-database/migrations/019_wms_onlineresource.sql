-- 019: advertise wms_onlineresource in generated mapfiles.
--
-- Without it MapServer derives the capabilities OnlineResource from the
-- proxied request and loses the host port and /mapserver path, so external
-- WMS clients (QGIS) parse the capabilities but then send GetMap to the
-- wrong URL and render nothing (found 2026-09-10). The base URL comes from
-- the new api.setting WMS_PUBLIC_URL (e.g. http://1.2.3.4:8024/mapserver);
-- deploy scripts seed it, admins can edit it under Administration ->
-- Settings. Empty value = omit the line (old behaviour).

INSERT INTO api.setting (key, value) VALUES ('WMS_PUBLIC_URL', '')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION soil_data.map() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  rec_layer RECORD;
  rec_property RECORD;
  n INT;
  v_min FLOAT; v_max FLOAT; step FLOAT;
  styles TEXT := '';
  k INT; c_lo TEXT; c_hi TEXT; d_lo FLOAT; d_hi FLOAT;
  tol_m INT;
  cell_m FLOAT;
  rec_cls RECORD;
  n_cls INT;
  v_mapset TEXT;
  v_custom BOOLEAN := FALSE;
  d_next FLOAT;
  v_online TEXT;
BEGIN
  SELECT l.layer_id,
    CASE
      WHEN l.distance_uom='m'   THEN 'METERS'
      WHEN l.distance_uom='km'  THEN 'KILOMETERS'
      WHEN l.distance_uom='deg' THEN 'DD'
    END distance_uom,
    l.reference_system_identifier_code,
    l.extent, l.file_extension, l.stats_minimum, l.stats_maximum,
    l.distance AS cell_size, l.distance_uom AS cell_uom,
    l.mapset_id
  INTO rec_layer
  FROM soil_data.layer l
  WHERE l.layer_id = NEW.layer_id;

  SELECT p.start_color, p.end_color, COALESCE(p.num_intervals, 10) AS num_intervals,
         p.property_type
  INTO rec_property
  FROM soil_data.layer l
  JOIN soil_data.mapset m         ON m.mapset_id = l.mapset_id
  JOIN soil_data.mapped_property p ON p.mapped_property_id = m.mapped_property_id
  WHERE l.layer_id = NEW.layer_id;

  -- Query tolerance: one native cell, expressed in metres (floor 100 m,
  -- default 1000 m when the resolution is unknown). layer.distance is TEXT —
  -- cast defensively.
  cell_m := CASE WHEN rec_layer.cell_size ~ '^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?$'
                 THEN rec_layer.cell_size::float END;
  tol_m := COALESCE(CEIL(GREATEST(
             CASE rec_layer.cell_uom
               WHEN 'deg' THEN cell_m * 111320
               WHEN 'km'  THEN cell_m * 1000
               ELSE            cell_m
             END, 100)), 1000);

  n := GREATEST(rec_property.num_intervals, 2);
  v_min := rec_layer.stats_minimum;
  v_max := rec_layer.stats_maximum;
  v_mapset := rec_layer.mapset_id;

  SELECT count(*) INTO n_cls
  FROM soil_data.class WHERE mapset_id = v_mapset AND publish IS TRUE;

  SELECT COALESCE(m.custom_classes, FALSE) INTO v_custom
  FROM soil_data.mapset m WHERE m.mapset_id = v_mapset;

  -- Public WMS base URL (e.g. http://host:port/mapserver) from settings.
  -- When set, it is advertised as wms_onlineresource so external clients
  -- (QGIS etc.) send GetMap/GetLegendGraphic to the right address; behind the
  -- nginx proxy MapServer's own guess drops the port and path. Empty or
  -- missing = line omitted (previous behaviour).
  SELECT NULLIF(TRIM(TRAILING '/' FROM TRIM(value)), '') INTO v_online
  FROM api.setting WHERE key = 'WMS_PUBLIC_URL';

  IF rec_property.property_type = 'categorical' AND n_cls BETWEEN 1 AND 60 THEN
    -- Categorical: one flat-colour STYLE per class value, driven by
    -- soil_data.class — the rows the SLD and the web legend already use, so
    -- editing a class colour recolours everything coherently. (Ramps make no
    -- sense for categories; >60 classes falls back to the ramp below.)
    FOR rec_cls IN SELECT value, color FROM soil_data.class
                   WHERE mapset_id = v_mapset AND publish IS TRUE
                   ORDER BY value LOOP
      styles := styles || 'STYLE
              COLORRANGE "'||rec_cls.color||'" "'||rec_cls.color||'"
              DATARANGE '||(rec_cls.value - 0.5)||' '||(rec_cls.value + 0.5)||'
              RANGEITEM "pixel"
            END # STYLE
            ';
    END LOOP;
  ELSIF v_custom AND n_cls BETWEEN 2 AND 60 THEN
    -- Custom class breaks (quantitative): each class row's value is the
    -- LOWER BOUND of its interval; the next row's value closes it, and the
    -- last interval runs to the layer maximum. Flat colour per interval —
    -- QGIS-style classed rendering with arbitrary (non-uniform) breaks.
    FOR rec_cls IN SELECT value, color,
                          LEAD(value) OVER (ORDER BY value) AS next_value
                   FROM soil_data.class
                   WHERE mapset_id = v_mapset AND publish IS TRUE
                   ORDER BY value LOOP
      d_next := COALESCE(rec_cls.next_value::float,
                         GREATEST(COALESCE(v_max, rec_cls.value + 1), rec_cls.value + 0.000001));
      styles := styles || 'STYLE
              COLORRANGE "'||rec_cls.color||'" "'||rec_cls.color||'"
              DATARANGE '||rec_cls.value||' '||d_next||'
              RANGEITEM "pixel"
            END # STYLE
            ';
    END LOOP;
  ELSIF v_min IS NULL OR v_max IS NULL OR v_max <= v_min THEN
    styles := 'STYLE
              COLORRANGE "'||rec_property.start_color||'" "'||rec_property.end_color||'"
              DATARANGE '||COALESCE(v_min,0)||' '||COALESCE(NULLIF(v_max,v_min),COALESCE(v_min,0)+1)||'
              RANGEITEM "pixel"
            END # STYLE';
  ELSE
    step := (v_max - v_min) / n;
    FOR k IN 1..n LOOP
      c_lo := soil_data._ramp_color(rec_property.start_color, rec_property.end_color, n+1, k);
      c_hi := soil_data._ramp_color(rec_property.start_color, rec_property.end_color, n+1, k+1);
      d_lo := v_min + (k-1)*step;
      d_hi := v_min + k*step;
      styles := styles || 'STYLE
              COLORRANGE "'||c_lo||'" "'||c_hi||'"
              DATARANGE '||d_lo||' '||d_hi||'
              RANGEITEM "pixel"
            END # STYLE
            ';
    END LOOP;
  END IF;

  UPDATE soil_data.layer l SET map = 'MAP
  NAME "'||rec_layer.layer_id||'"
  EXTENT '||rec_layer.extent||'
  UNITS '||rec_layer.distance_uom||'
  SHAPEPATH "./"
  SIZE 800 600
  IMAGETYPE "PNG24"
  PROJECTION
      "init=epsg:'||rec_layer.reference_system_identifier_code||'"
  END # PROJECTION
  WEB
      METADATA
          "ows_title" "'||rec_layer.layer_id||' web-service"
          "ows_enable_request" "*"
'||COALESCE('          "wms_onlineresource" "'||v_online||'?map=/etc/mapserver/'||rec_layer.layer_id||'.map&"
', '')||'          "ows_srs" "EPSG:'||rec_layer.reference_system_identifier_code||' EPSG:4326 EPSG:3857"
          "wms_getfeatureinfo_formatlist" "text/plain,text/html,application/json,geojson,application/vnd.ogc.gml,gml"
          "wms_feature_info_mime_type" "application/json"
      END # METADATA
  END # WEB
  LAYER
      TEMPLATE "getfeatureinfo.tmpl"
      NAME "'||rec_layer.layer_id||'"
      DATA "'||rec_layer.layer_id||'.'||rec_layer.file_extension||'"
      TYPE RASTER
      TOLERANCE '||tol_m||'
      TOLERANCEUNITS METERS
      STATUS ON
      METADATA
        "wms_include_items" "all"
        "gml_include_items" "all"
      END # METADATA
      CLASS
        NAME "'||rec_layer.layer_id||'"
        '||styles||'
      END # CLASS
  END # LAYER
END # MAP'
  WHERE l.layer_id = NEW.layer_id;

  RETURN NEW;
END
$$;


-- Refresh the stored .map text of every existing raster layer.
UPDATE soil_data.layer
   SET stats_minimum = stats_minimum
 WHERE map IS NOT NULL;
