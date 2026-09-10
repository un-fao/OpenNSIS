-- 020: Active (default-on) toggle for administrative division layers.
--
-- Mirrors the soil-profile projects' active_default (migration 016): a
-- published division layer can be set to start unticked (hidden) in the map
-- view while remaining available in the layer panel. Default true preserves
-- current behaviour.

ALTER TABLE api.admin_division
  ADD COLUMN IF NOT EXISTS active_default boolean NOT NULL DEFAULT true;
