-- Migration v4 → v5
--   * app_hubs.kind ENUM('hub','single')
--   * app_devices.hub_id  ON DELETE CASCADE  (was SET NULL)
--   * app_rule_conditions: source_type, http_*, expand metric ENUM, allow device_id NULL,
--                           threshold DECIMAL(14,4)
--   * settings: theme

ALTER TABLE app_hubs
  ADD COLUMN kind ENUM('hub','single') NOT NULL DEFAULT 'hub' AFTER enabled;

-- recreate FK with CASCADE
ALTER TABLE app_devices DROP FOREIGN KEY fk_dev_hub;
ALTER TABLE app_devices
  ADD CONSTRAINT fk_dev_hub FOREIGN KEY (hub_id) REFERENCES app_hubs(id) ON DELETE CASCADE;

ALTER TABLE app_rule_conditions
  ADD COLUMN source_type ENUM('device','http') NOT NULL DEFAULT 'device' AFTER combinator,
  ADD COLUMN http_url VARCHAR(512) NULL AFTER threshold,
  ADD COLUMN http_method ENUM('GET','POST') NOT NULL DEFAULT 'GET' AFTER http_url,
  ADD COLUMN http_json_path VARCHAR(255) NULL AFTER http_method,
  ADD COLUMN http_cache_seconds INT NOT NULL DEFAULT 60 AFTER http_json_path,
  MODIFY COLUMN device_id INT NULL,
  MODIFY COLUMN metric ENUM('temperature','humidity','state','battery','energy_w','motion','http_value') NOT NULL,
  MODIFY COLUMN threshold DECIMAL(14,4) NOT NULL;

INSERT IGNORE INTO app_settings (k, v) VALUES ('theme','dark');
