-- =====================================================================
-- v6 — Repeating timers (incl. multi-device + random/vacation mode),
--      dashboard widgets and admin sessions.
-- Idempotent: safe to re-run.
-- =====================================================================

-- ---- Scheduled tasks: repeats, multi-device, random window, durations.
ALTER TABLE app_scheduled_tasks
  ADD COLUMN IF NOT EXISTS device_ids          JSON         NULL    AFTER device_id,
  ADD COLUMN IF NOT EXISTS repeat_kind         ENUM('once','minutely','hourly','daily','weekly','monthly')
                                                            NOT NULL DEFAULT 'once' AFTER note,
  ADD COLUMN IF NOT EXISTS repeat_interval     INT          NOT NULL DEFAULT 1 AFTER repeat_kind,
  ADD COLUMN IF NOT EXISTS repeat_until        DATETIME     NULL    AFTER repeat_interval,
  ADD COLUMN IF NOT EXISTS days_mask           TINYINT      NOT NULL DEFAULT 127 AFTER repeat_until,
  ADD COLUMN IF NOT EXISTS is_random           TINYINT(1)   NOT NULL DEFAULT 0 AFTER days_mask,
  ADD COLUMN IF NOT EXISTS random_window_start TIME         NULL    AFTER is_random,
  ADD COLUMN IF NOT EXISTS random_window_end   TIME         NULL    AFTER random_window_start,
  ADD COLUMN IF NOT EXISTS random_min_minutes  INT          NULL    AFTER random_window_end,
  ADD COLUMN IF NOT EXISTS random_max_minutes  INT          NULL    AFTER random_min_minutes,
  ADD COLUMN IF NOT EXISTS parent_task_id      INT          NULL    AFTER random_max_minutes,
  ADD COLUMN IF NOT EXISTS duration_minutes    INT          NULL    AFTER parent_task_id,
  ADD COLUMN IF NOT EXISTS title               VARCHAR(128) NULL    AFTER duration_minutes,
  ADD COLUMN IF NOT EXISTS error_message       VARCHAR(512) NULL    AFTER title;

ALTER TABLE app_scheduled_tasks
  MODIFY COLUMN action ENUM('on','off','toggle','on_for','off_for',
                            'set_brightness','set_color','set_temp') NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parent ON app_scheduled_tasks (parent_task_id);

-- ---- Dashboard widgets.
CREATE TABLE IF NOT EXISTS app_widgets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  kind        ENUM('device','sensor','http','label','spacer') NOT NULL,
  title       VARCHAR(128) NULL,
  config      JSON NULL,
  pos_x       INT NOT NULL DEFAULT 0,
  pos_y       INT NOT NULL DEFAULT 0,
  width       INT NOT NULL DEFAULT 3,
  height      INT NOT NULL DEFAULT 1,
  enabled     TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pos (pos_y, pos_x)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Admin sessions (simple unlock tokens).
CREATE TABLE IF NOT EXISTS app_admin_sessions (
  token        CHAR(64) PRIMARY KEY,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  last_seen_at DATETIME NULL,
  user_agent   VARCHAR(255) NULL,
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
