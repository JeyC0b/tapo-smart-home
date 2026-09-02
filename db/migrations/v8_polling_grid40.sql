-- =====================================================================
-- v8 — Per-hub & per-device polling interval, widget HTTP cache,
--      40 px home grid (rows doubled).
-- Idempotent.
-- =====================================================================

ALTER TABLE app_hubs
  ADD COLUMN IF NOT EXISTS poll_interval_seconds INT      NULL,
  ADD COLUMN IF NOT EXISTS last_polled_at        DATETIME NULL;

ALTER TABLE app_devices
  ADD COLUMN IF NOT EXISTS poll_interval_seconds INT NULL;

ALTER TABLE app_widgets
  ADD COLUMN IF NOT EXISTS cached_value JSON         NULL,
  ADD COLUMN IF NOT EXISTS cached_at    DATETIME     NULL,
  ADD COLUMN IF NOT EXISTS cache_error  VARCHAR(512) NULL;

-- 40 px grid migration (idempotent — gated by app_settings flag).
INSERT IGNORE INTO app_settings (k, v) VALUES ('migrated_v8_grid40', '0');
UPDATE app_devices d JOIN app_settings s ON s.k='migrated_v8_grid40' AND s.v='0'
   SET d.home_y = d.home_y * 2, d.home_height = d.home_height * 2;
UPDATE app_widgets w JOIN app_settings s ON s.k='migrated_v8_grid40' AND s.v='0'
   SET w.home_y = w.home_y * 2, w.home_height = w.home_height * 2;
UPDATE app_settings SET v='1' WHERE k='migrated_v8_grid40';
