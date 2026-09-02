-- v10: 'line' widget kind + per-group appearance config.
--
-- Adds a new widget kind ('line') used as a thin separator on the home grid,
-- and a JSON column on app_device_groups to store appearance settings such
-- as render_as ('default' | 'bulb' | 'plug') and overlay_icon. Existing rows
-- keep their previous behaviour (NULL config → defaults in the UI).

ALTER TABLE app_widgets
  MODIFY COLUMN kind ENUM('device','sensor','http','label','spacer','group','line') NOT NULL;

ALTER TABLE app_device_groups
  ADD COLUMN config JSON NULL AFTER enabled;
