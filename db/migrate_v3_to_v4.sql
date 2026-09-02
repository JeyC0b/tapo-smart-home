-- ===========================================================================
-- Migration v3 → v4
-- - app_rule_conditions table (1..N conditions per rule)
-- - sort_order on app_devices
-- - migrate existing primary/secondary conditions into the new table
-- - drop legacy primary/secondary columns from app_rules
-- ===========================================================================

ALTER TABLE app_devices
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS app_rule_conditions (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  rule_id      INT NOT NULL,
  position     INT NOT NULL DEFAULT 0,
  combinator   ENUM('AND','OR') NULL,
  device_id    INT NOT NULL,
  metric       ENUM('temperature','humidity','state','battery','energy_w','motion') NOT NULL,
  operator     ENUM('lt','lte','gt','gte','eq','neq') NOT NULL,
  threshold    DECIMAL(10,3) NOT NULL,
  CONSTRAINT fk_cond_rule   FOREIGN KEY (rule_id) REFERENCES app_rules(id) ON DELETE CASCADE,
  CONSTRAINT fk_cond_device FOREIGN KEY (device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_rule_pos (rule_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill primary condition
INSERT INTO app_rule_conditions (rule_id, position, combinator, device_id, metric, operator, threshold)
SELECT id, 0, NULL, sensor_device_id, metric, operator, threshold
FROM app_rules
WHERE sensor_device_id IS NOT NULL
  AND metric IS NOT NULL
  AND operator IS NOT NULL
  AND threshold IS NOT NULL;

-- Backfill secondary condition
INSERT INTO app_rule_conditions (rule_id, position, combinator, device_id, metric, operator, threshold)
SELECT id, 1, combinator, sensor2_device_id, metric2, operator2, threshold2
FROM app_rules
WHERE sensor2_device_id IS NOT NULL
  AND metric2 IS NOT NULL
  AND operator2 IS NOT NULL
  AND threshold2 IS NOT NULL
  AND combinator IS NOT NULL;

-- Drop legacy primary/secondary columns
ALTER TABLE app_rules
  DROP FOREIGN KEY fk_rule_sensor,
  DROP FOREIGN KEY fk_rule_sensor2;
ALTER TABLE app_rules
  DROP COLUMN sensor_device_id,
  DROP COLUMN metric,
  DROP COLUMN operator,
  DROP COLUMN threshold,
  DROP COLUMN combinator,
  DROP COLUMN sensor2_device_id,
  DROP COLUMN metric2,
  DROP COLUMN operator2,
  DROP COLUMN threshold2;

-- Add 'motion' to existing condition metric enum (if backfilled with old enum)
ALTER TABLE app_rule_conditions
  MODIFY COLUMN metric ENUM('temperature','humidity','state','battery','energy_w','motion') NOT NULL;
