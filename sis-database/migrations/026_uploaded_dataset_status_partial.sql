-- 026: allow the 'Partial' dataset status the API has always written.
--
-- ingest_dataset sets status='Partial' when some rows errored, but the
-- original check constraint only allowed Uploaded/Ingested/Removed — so
-- the first partially-failing ingest crashed on the status update
-- instead of reporting its row errors. Never hit before because
-- validation kept ingests fully clean.

ALTER TABLE api.uploaded_dataset
  DROP CONSTRAINT IF EXISTS uploaded_dataset_status_check;

ALTER TABLE api.uploaded_dataset
  ADD CONSTRAINT uploaded_dataset_status_check
  CHECK (status = ANY (ARRAY['Uploaded'::text, 'Ingested'::text,
                             'Partial'::text, 'Removed'::text]));
