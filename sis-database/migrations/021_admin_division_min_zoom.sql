-- 021: zoom visibility for administrative division layers.
--
-- A single threshold instead of the classic min/max scale pair: the layer
-- renders only when the map is zoomed in beyond this level. NULL (default)
-- means always visible; the API also stores 0 as NULL. Applied in the map
-- view via the OpenLayers layer minZoom option; ticking the layer still
-- controls overall visibility.

ALTER TABLE api.admin_division
  ADD COLUMN IF NOT EXISTS min_zoom real;
