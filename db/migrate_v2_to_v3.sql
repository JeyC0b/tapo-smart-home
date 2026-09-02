-- ===========================================================================
-- Migrace v2 → v3
--   - app_devices.is_momentary
--   - app_rules: trigger_type, secondary cond, action_value, duration, cooldown
--   - app_settings: default_username/password
--   - app_scheduled_tasks.rule_id
-- ===========================================================================

ALTER TABLE app_devices
  ADD COLUMN IF NOT EXISTS is_momentary TINYINT(1) NOT NULL DEFAULT 0;

-- pravidla
ALTER TABLE app_rules
  ADD COLUMN IF NOT EXISTS trigger_type ENUM('sensor','time','device_state') NOT NULL DEFAULT 'sensor',
  ADD COLUMN IF NOT EXISTS combinator ENUM('AND','OR') NULL,
  ADD COLUMN IF NOT EXISTS sensor2_device_id INT NULL,
  ADD COLUMN IF NOT EXISTS metric2 ENUM('temperature','humidity','state','battery','energy_w') NULL,
  ADD COLUMN IF NOT EXISTS operator2 ENUM('lt','lte','gt','gte','eq','neq') NULL,
  ADD COLUMN IF NOT EXISTS threshold2 DECIMAL(8,2) NULL,
  ADD COLUMN IF NOT EXISTS action_value JSON NULL,
  ADD COLUMN IF NOT EXISTS duration_minutes INT NULL,
  ADD COLUMN IF NOT EXISTS cooldown_minutes INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_fired_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS fire_count INT NOT NULL DEFAULT 0;

-- enum action: rozšířit (pokud již sloupec existuje, MODIFY)
ALTER TABLE app_rules
  MODIFY COLUMN action ENUM('on','off','toggle','on_for','off_for',
                            'set_brightness','set_color','set_temp','set_effect') NOT NULL,
  MODIFY COLUMN sensor_device_id INT NULL,
  MODIFY COLUMN metric ENUM('temperature','humidity','state','battery','energy_w') NULL,
  MODIFY COLUMN operator ENUM('lt','lte','gt','gte','eq','neq') NULL,
  MODIFY COLUMN threshold DECIMAL(8,2) NULL;

ALTER TABLE app_scheduled_tasks
  ADD COLUMN IF NOT EXISTS rule_id INT NULL;

INSERT IGNORE INTO app_settings (k,v) VALUES
  ('default_username',''),
  ('default_password','');
