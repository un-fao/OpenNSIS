-- 028: controlled classification keywords on the soil-property catalogue.
--
-- Adds 'chemical' / 'physical' and 'macronutrient' /
-- 'micronutrient' to soil_data.mapped_property.keyword_theme, and merges the
-- property keywords into the keyword_theme of existing mapsets (new mapsets
-- inherit them at registration). Keywords are merged, never removed, so the
-- migration is idempotent and preserves locally added keywords.
--
-- The web map groups the combined popups on these keywords: 'texture' (one
-- composition card) and the nutrient keywords (one NPK card), and the layer
-- panel exposes them as filter chips.

-- 1. Classify the catalogue -------------------------------------------------
WITH cls(mapped_property_id, kws) AS (
  VALUES
    -- Physical properties
    ('BULDWHOLE', ARRAY['physical']),
    ('BULDFINE',  ARRAY['physical']),
    ('POR',       ARRAY['physical']),
    ('TEXTCLAY',  ARRAY['physical']),
    ('TEXTSAND',  ARRAY['physical']),
    ('TEXTSILT',  ARRAY['physical']),
    ('HYDCOND',   ARRAY['physical']),
    ('AVAVOL',    ARRAY['physical']),
    ('COAFRA',    ARRAY['physical']),
    ('COAFRAF',   ARRAY['physical']),

    -- Chemical properties (non-nutrient)
    ('SOLSAL',    ARRAY['chemical']),
    ('SALT',      ARRAY['chemical']),
    ('ECEC',      ARRAY['chemical']),
    ('CEC',       ARRAY['chemical']),
    ('ACIEXC',    ARRAY['chemical']),
    ('BASCAL',    ARRAY['chemical']),
    ('BASEXC',    ARRAY['chemical']),
    ('BSATS',     ARRAY['chemical']),
    ('GYP',       ARRAY['chemical']),
    ('CARINORG',  ARRAY['chemical']),
    ('CCETOT',    ARRAY['chemical']),
    ('CARORG',    ARRAY['chemical']),
    ('CARSTK',    ARRAY['chemical']),
    ('CARTOT',    ARRAY['chemical']),
    ('ORGMAT',    ARRAY['chemical']),
    ('CARNIT',    ARRAY['chemical']),
    ('PHX',       ARRAY['chemical']),
    ('PHAQ',      ARRAY['chemical']),
    ('ELECCOND',  ARRAY['chemical']),
    ('HYDEXC',    ARRAY['chemical']),
    ('ALUTOT',    ARRAY['chemical']),
    ('ALUEXC',    ARRAY['chemical']),
    ('CAD',       ARRAY['chemical']),
    ('SODEXP',    ARRAY['chemical']),
    ('SODEXT',    ARRAY['chemical']),
    ('SODTOT',    ARRAY['chemical']),
    ('PHORET',    ARRAY['chemical']),

    -- Carbon-sequestration scenario products (SOC stocks are chemistry)
    ('CORGT0',      ARRAY['chemical']),
    ('CORGSOCBAU',  ARRAY['chemical']),
    ('CORGSOCSSM1', ARRAY['chemical']),
    ('CORGSOCSSM2', ARRAY['chemical']),
    ('CORGSOCSSM3', ARRAY['chemical']),
    ('CORGADBAU',   ARRAY['chemical']),
    ('CORGADSSM1',  ARRAY['chemical']),
    ('CORGADSSM2',  ARRAY['chemical']),
    ('CORGADSSM3',  ARRAY['chemical']),
    ('CORGRDSSM1',  ARRAY['chemical']),
    ('CORGRDSSM2',  ARRAY['chemical']),
    ('CORGRDSSM3',  ARRAY['chemical']),
    ('CORGASRBAU',  ARRAY['chemical']),
    ('CORGASRSSM1', ARRAY['chemical']),
    ('CORGASRSSM2', ARRAY['chemical']),
    ('CORGASRSSM3', ARRAY['chemical']),

    -- Macronutrients (N, P, K, Ca, Mg, S) — chemical as well
    ('NITTOT',    ARRAY['chemical','macronutrient']),
    ('PHO',       ARRAY['chemical','macronutrient']),
    ('PHOEXT',    ARRAY['chemical','macronutrient']),
    ('PHOTOT',    ARRAY['chemical','macronutrient']),
    ('POT',       ARRAY['chemical','macronutrient']),
    ('POTEXC',    ARRAY['chemical','macronutrient']),
    ('POTEXT',    ARRAY['chemical','macronutrient']),
    ('POTTOT',    ARRAY['chemical','macronutrient']),
    ('CALEXT',    ARRAY['chemical','macronutrient']),
    ('CALEXC',    ARRAY['chemical','macronutrient']),
    ('CALTOT',    ARRAY['chemical','macronutrient']),
    ('MAGEXT',    ARRAY['chemical','macronutrient']),
    ('MAGEXC',    ARRAY['chemical','macronutrient']),
    ('MAGTOT',    ARRAY['chemical','macronutrient']),
    ('SULEXT',    ARRAY['chemical','macronutrient']),
    ('SULTOT',    ARRAY['chemical','macronutrient']),

    -- Micronutrients (Fe, Mn, Zn, Cu, B, Mo) — chemical as well
    ('IROEXT',    ARRAY['chemical','micronutrient']),
    ('IROTOT',    ARRAY['chemical','micronutrient']),
    ('MANEXT',    ARRAY['chemical','micronutrient']),
    ('MANTOT',    ARRAY['chemical','micronutrient']),
    ('ZINEXT',    ARRAY['chemical','micronutrient']),
    ('ZNTOT',     ARRAY['chemical','micronutrient']),
    ('COPEXT',    ARRAY['chemical','micronutrient']),
    ('COPTOT',    ARRAY['chemical','micronutrient']),
    ('BOREXT',    ARRAY['chemical','micronutrient']),
    ('BORTOT',    ARRAY['chemical','micronutrient']),
    ('MOL',       ARRAY['chemical','micronutrient'])

    -- Not classified on purpose: PEAT (soil material), CLAWRB (classification)
)
UPDATE soil_data.mapped_property p
   SET keyword_theme = ARRAY(
         SELECT DISTINCT k
           FROM unnest(COALESCE(p.keyword_theme, '{}'::text[]) || c.kws) AS k
          ORDER BY k)
  FROM cls c
 WHERE p.mapped_property_id = c.mapped_property_id;

-- 2. Propagate to existing mapsets (new ones inherit at registration) -------
UPDATE soil_data.mapset m
   SET keyword_theme = ARRAY(
         SELECT DISTINCT k
           FROM unnest(COALESCE(m.keyword_theme, '{}'::text[]) || p.keyword_theme) AS k
          ORDER BY k)
  FROM soil_data.mapped_property p
 WHERE m.mapped_property_id = p.mapped_property_id
   AND p.keyword_theme IS NOT NULL
   AND NOT (COALESCE(m.keyword_theme, '{}'::text[]) @> p.keyword_theme);

-- 3. Align the mapset group with the classification --------------------------
-- The map panel groups classified rasters under Chemical/Physical, so the
-- stored group (admin Rasters tab, "Group" column) follows the keywords.
-- Unclassified mapsets (e.g. DST outputs) keep their custom group.
UPDATE soil_data.mapset SET costum_group = 'Chemical'
 WHERE 'chemical' = ANY(keyword_theme) AND costum_group IS DISTINCT FROM 'Chemical';
UPDATE soil_data.mapset SET costum_group = 'Physical'
 WHERE 'physical' = ANY(keyword_theme) AND costum_group IS DISTINCT FROM 'Physical';
