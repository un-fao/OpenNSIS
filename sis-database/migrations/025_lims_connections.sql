-- 025: laboratory (LIMS) API connections for the ETL.
--
-- A national SIS can fetch analysed samples directly from one or more
-- laboratory information systems (e.g. SoilFER-LIMS) instead of receiving
-- CSV exports. Each connection holds the lab's exchange-API endpoint and
-- key, plus the incremental-sync state. Fetched data lands in the ordinary
-- ETL staging tables as api.uploaded_dataset rows with source='lims-api'
-- (migration 024) and a reference back to the connection, so the whole
-- existing mapping/validation/ingestion pipeline applies unchanged.
--
-- The API key lives in this table (like api.api_client keys) and is served
-- only through admin-authenticated endpoints — NEVER via the public
-- settings endpoint.

CREATE TABLE IF NOT EXISTS api.lims_connection (
    connection_id  serial PRIMARY KEY,
    name           text NOT NULL UNIQUE,
    base_url       text NOT NULL,
    api_key        text NOT NULL,
    enabled        boolean NOT NULL DEFAULT true,
    sync_cursor    text,
    last_fetch_at  timestamptz,
    last_fetch_note text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE api.uploaded_dataset
  ADD COLUMN IF NOT EXISTS lims_connection_id integer
      REFERENCES api.lims_connection(connection_id) ON DELETE SET NULL;

COMMENT ON TABLE api.lims_connection IS
  'Laboratory exchange-API connections (e.g. SoilFER-LIMS) the ETL can fetch from.';
COMMENT ON COLUMN api.uploaded_dataset.lims_connection_id IS
  'Set when this dataset was fetched from a laboratory API (source=lims-api).';
