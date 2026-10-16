-- 030: settings for the "Connect to GloSIS Discovery Hub" flow.
--
-- GLOSIS_HUB_URL  — base URL of the Discovery Hub this node registers with.
-- GLOSIS_NODE_URL — the public address last used to connect (remembered so
--                   the admin form is pre-filled next time).
-- ON CONFLICT DO NOTHING: re-runs and locally changed values are safe.

INSERT INTO api.setting (key, value)
VALUES ('GLOSIS_HUB_URL', 'https://glosis.eloiribeiro.eu')
ON CONFLICT (key) DO NOTHING;

INSERT INTO api.setting (key, value)
VALUES ('GLOSIS_NODE_URL', '')
ON CONFLICT (key) DO NOTHING;
