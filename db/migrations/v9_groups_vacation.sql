-- =====================================================================
-- v9 — Device groups, group widget kind, vacation-mode improvements.
-- Idempotent.
-- =====================================================================

-- Widget kind enum: add 'group'.
ALTER TABLE app_widgets
  MODIFY COLUMN kind ENUM('device','sensor','http','label','spacer','group') NOT NULL;

-- Device groups (one button controls many devices, like the Tapo app).
CREATE TABLE IF NOT EXISTS app_device_groups (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  icon       VARCHAR(32)  NULL,
  room       VARCHAR(64)  NULL,
  enabled    TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_device_group_members (
  group_id  INT NOT NULL,
  device_id INT NOT NULL,
  position  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, device_id),
  CONSTRAINT fk_dgm_group  FOREIGN KEY (group_id)  REFERENCES app_device_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_dgm_device FOREIGN KEY (device_id) REFERENCES app_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Vacation / presence-simulation parameters per scheduled task.
ALTER TABLE app_scheduled_tasks
  ADD COLUMN IF NOT EXISTS vacation_min_per_day      INT        NULL  AFTER random_max_minutes,
  ADD COLUMN IF NOT EXISTS vacation_max_per_day      INT        NULL  AFTER vacation_min_per_day,
  ADD COLUMN IF NOT EXISTS vacation_min_duration_min INT        NULL  AFTER vacation_max_per_day,
  ADD COLUMN IF NOT EXISTS vacation_max_duration_min INT        NULL  AFTER vacation_min_duration_min,
  ADD COLUMN IF NOT EXISTS vacation_pick_one         TINYINT(1) NOT NULL DEFAULT 0 AFTER vacation_max_duration_min,
  ADD COLUMN IF NOT EXISTS vacation_dim_chance       TINYINT    NULL  AFTER vacation_pick_one;
