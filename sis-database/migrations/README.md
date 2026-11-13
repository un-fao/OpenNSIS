# Database migrations

Incremental, **idempotent** SQL applied to a *live* database by the repo-root
`update.sh`, so countries can update an installed SIS without wiping the data
they uploaded.

This is the in-place counterpart to the full seed dump
(`sis-database/sis-database_latest_with_codelist.sql`): the dump is what a
*fresh* install loads once; migrations are how an *existing* install moves
forward without reloading (and thus erasing) its data.

## How it works

`update.sh` keeps a ledger table:

```sql
api.schema_migration (filename text primary key, applied_at timestamptz)
```

On each run it applies every `sis-database/migrations/NNN_*.sql` not yet in that
table, in **filename order** (by basename), each inside a single transaction
together with its bookkeeping insert. A failure rolls the whole file back and
records nothing, so re-running is safe.

## Writing a migration

1. Create the next number: `002_short_description.sql`, `003_…`, …
   Numbers are zero-padded and define the apply order — never renumber an
   existing one, and never edit a migration that may already be applied
   somewhere; add a new one instead.
2. Make it **idempotent and transaction-safe** so a re-run (or a fresh install
   that already has the change from the dump) is a harmless no-op:
   - `CREATE OR REPLACE FUNCTION/VIEW …`
   - `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
   - `CREATE TABLE/INDEX IF NOT EXISTS …`
   - `INSERT … ON CONFLICT DO NOTHING`
   - Avoid statements that can't run inside a transaction (e.g.
     `CREATE INDEX CONCURRENTLY`, some `ALTER TYPE … ADD VALUE`). If you truly
     need one, flag it — the runner uses `--single-transaction`.
3. Keep the dump in sync: also fold the change into the seed dump so fresh
   installs get it directly. (A migration then just converges older installs.)
4. Test: `./update.sh` applies it; run again — it should report `skip`.

## Scope

Migrations cover **schema, views, functions/triggers, and reference-data**
changes. They do **not** rebuild application code (that's `update.sh` doing
`up --build` on the app containers) and do **not** upgrade the Postgres / pyCSW /
MapServer base images (a deliberate manual step, with care, because of the data
volumes).

## History

- `001_hsv_colour_ramp.sql` — HSV colour-ramp triggers (`soil_data.class`,
  `soil_data.map`, `soil_data._ramp_color`); also fixes `map()`'s
  mapped_property join. Idempotent; already in fresh dumps.
- `002_vw_api_profile_mapset_id.sql` — `api.vw_api_profile` exposes `mapset_id`
  (DROP + CREATE, no dependents). Idempotent; already in fresh dumps.
- `003_mapset_locations_only.sql` — Per-project "share locations only" flag.
- `004_class_uniform_raster.sql` — `soil_data.class()` no longer fails on a
  uniform raster (minimum equal to maximum).
- `005_mapset_hide_download.sql` — Per-project "hide download" flag.
- `006_plot_profile_code_not_unique.sql` — `plot_code` / `profile_code` are
  real-world labels, not identifiers: uniqueness is dropped, the surrogate keys
  identify a row.
- `007_mapset_period_allow_equal.sql` — Allow a mapset time period to be a
  single instant: begin <= end instead of strictly begin < end.
- `008_admin_divisions.sql` — Administrative division layers: admin-uploaded
  polygon boundaries (country, provinces, municipalities, …) shown on the map
  under an "Administrative divisions" group.
- `009_admin_division_stroke_type.sql` — Stroke type for administrative
  division layers: continuous (solid), dashed, dotted or dash-dot outlines,
  editable alongside the other symbology fields.
- `010_language_setting.sql` — Seeds the `LANGUAGE` setting (instance default
  interface language) on existing installs.
- `011_raster_query_tolerance.sql` — Raster GetFeatureInfo works at any zoom
  level.
- `012_categorical_class_styles.sql` — Categorical rasters render from their
  class table.
- `013_custom_class_breaks.sql` — Custom class breaks for quantitative rasters.
- `014_layer_default_opacity.sql` — Per-layer default opacity for the map view.
- `015_profile_symbology.sql` — Per-project symbology for soil-profile layers.
- `016_profile_active_default.sql` — Soil-profile layers can be published but
  not active by default.
- `017_layer_panel_collapsed_setting.sql` — Seed the LAYER_PANEL_COLLAPSED
  setting: whether the map view's layer panel starts collapsed (just the burger
  glyph) or expanded.
- `018_layer_display_order.sql` — Admin-defined ordering for map-view layer
  lists.
- `019_wms_onlineresource.sql` — Advertise wms_onlineresource in generated
  mapfiles.
- `020_admin_division_active_default.sql` — Active (default-on) toggle for
  administrative division layers.
- `021_admin_division_min_zoom.sql` — Zoom visibility for administrative
  division layers.
- `022_admin_division_label_attribute.sql` — Text labels for administrative
  division layers.
- `023_specimen_field_lab_ids.sql` — Chain-of-custody identifiers on specimens
  (SoilFER-LIMS integration).
- `024_uploaded_dataset_source.sql` — Record where a staged dataset came from.
- `025_lims_connections.sql` — Laboratory (LIMS) API connections for the ETL.
- `026_uploaded_dataset_status_partial.sql` — Allow the 'Partial' dataset
  status the API has always written.
- `027_specimen_field_id_not_unique.sql` — `sample_field_id` is an identifier,
  not a global uniqueness domain.
- `028_property_classification_keywords.sql` — Controlled classification
  keywords on the soil-property catalogue.
- `029_glosis_view_grants.sql` — Restore the sis_glosis read grants on the
  federation data views.
- `030_glosis_hub_settings.sql` — Settings for the "Connect to GloSIS Discovery
  Hub" flow.
- `031_positional_accuracy_comment.sql` — Document the unit convention for
  plot.positional_accuracy.
- `032_method_quality.sql` — Per-procedure measurement quality + censored
  results.
- `033_site_cms.sql` — Public landing page content (issue #13, v1 as amended).
- `034_sampling_design.sql` — Sampling design (SoilFER three-stage CSC) —
  designs and their features.
- `035_sampling_design_publish.sql` — Sampling designs become publishable map
  layers.
- `036_site_single_version.sql` — Drop site versioning — one published copy
  instead of snapshots.
- `037_news_posts.sql` — News — blog-style posts on the public website (/news).
- `038_news_tags.sql` — Tags on news posts (lowercase strings; filter pills on
  /news).
- `039_site_live_by_default.sql` — The public website is live by default: flips
  the stored `SITE_LANDING_ENABLED` on installs that never published a site.

Each file's own header holds the full rationale.
