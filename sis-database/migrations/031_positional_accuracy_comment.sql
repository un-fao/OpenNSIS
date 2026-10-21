-- 031: document the unit convention for plot.positional_accuracy.
-- The column is a bare smallint; neither the schema nor the GloSIS ontology
-- fixes a unit, so the convention (metres) lives in this comment, the ETL
-- upload template and the validation-rules sheet. Idempotent.
COMMENT ON COLUMN soil_data.plot.positional_accuracy IS
  'Horizontal positional accuracy in metres (error margin of the recorded location).';
