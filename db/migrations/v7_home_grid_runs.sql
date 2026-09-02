-- =====================================================================
-- v7 — Home grid layout, per-device guest_control, per-task run log.
-- Idempotent.
-- =====================================================================

ALTER TABLE app_devices
  ADD COLUMN IF NOT EXISTS home_x        INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS home_y        INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS home_width    INT          NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS home_height   INT          NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS on_home       TINYINT(1)   NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS guest_control TINYINT(1)   NOT NULL DEFAULT 1;

ALTER TABLE app_widgets
  ADD COLUMN IF NOT EXISTS on_home       TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS home_x        INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS home_y        INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS home_width    INT          NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS home_height   INT          NOT NULL DEFAULT 2;

CREATE TABLE IF NOT EXISTS app_task_runs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_id       INT NOT NULL,
  device_id     INT NOT NULL,
  action        VARCHAR(32) NOT NULL,
  result        ENUM('ok','error') NOT NULL,
  error_message VARCHAR(512) NULL,
  ran_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_run_task FOREIGN KEY (task_id) REFERENCES app_scheduled_tasks(id) ON DELETE CASCADE,
  INDEX idx_task (task_id, ran_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
