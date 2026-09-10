-- 022: text labels for administrative division layers.
--
-- The uploaded attribute tables (state/province names etc.) are stored per
-- feature in admin_division_feature.properties but were never surfaced.
-- label_attribute names the property to render as a text label on each
-- polygon in the map view; NULL (default) = no labels.

ALTER TABLE api.admin_division
  ADD COLUMN IF NOT EXISTS label_attribute text;
