-- =====================================================================
-- Smart-home dashboard — consolidated schema (fresh install).
-- For incremental upgrades from older installs, use db/migrations/*.sql.
-- =====================================================================

-- ---- Hubs (Tapo H100 hubs and standalone Wi-Fi devices treated as "hubs"). 
CREATE TABLE IF NOT EXISTS app_hubs (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(64)  NOT NULL,
  ip                    VARCHAR(64)  NOT NULL UNIQUE,
  username              VARCHAR(128) NOT NULL,
  password              VARCHAR(255) NOT NULL,
  enabled               TINYINT(1)   NOT NULL DEFAULT 1,
  kind                  ENUM('hub','single') NOT NULL DEFAULT 'hub',
  poll_interval_seconds INT          NULL,
  last_polled_at        DATETIME     NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Devices.
CREATE TABLE IF NOT EXISTS app_devices (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  hub_id                INT NULL,
  device_id             VARCHAR(128) NOT NULL UNIQUE,
  parent_device_id      VARCHAR(128) NULL,
  kind                  VARCHAR(16)  NOT NULL DEFAULT 'unknown',
  device_type           VARCHAR(64)  NULL,
  tapo_alias            VARCHAR(128) NULL,
  custom_name           VARCHAR(128) NULL,
  room                  VARCHAR(64)  NULL,
  model                 VARCHAR(128) NULL,
  mac                   VARCHAR(32)  NULL,
  rssi                  SMALLINT     NULL,
  capabilities          JSON         NULL,
  is_momentary          TINYINT(1)   NOT NULL DEFAULT 0,
  online                TINYINT(1)   NOT NULL DEFAULT 0,
  fail_count            SMALLINT     NOT NULL DEFAULT 0,
  excluded              TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order            INT          NOT NULL DEFAULT 0,
  -- Live state cache.
  temperature           DECIMAL(5,2) NULL,
  humidity              DECIMAL(5,2) NULL,
  state                 TINYINT(1)   NULL,
  brightness            TINYINT      NULL,
  hsv                   VARCHAR(32)  NULL,
  color_temp            SMALLINT     NULL,
  fan_speed             TINYINT      NULL,
  battery               TINYINT      NULL,
  motion                TINYINT(1)   NULL,
  energy_w              DECIMAL(8,2) NULL,
  energy_today          DECIMAL(10,3) NULL,
  energy_month          DECIMAL(10,3) NULL,
  last_seen_at          DATETIME     NULL,
  -- Home-screen layout.
  home_x                INT          NOT NULL DEFAULT 0,
  home_y                INT          NOT NULL DEFAULT 0,
  home_width            INT          NOT NULL DEFAULT 4,
  home_height           INT          NOT NULL DEFAULT 2,
  on_home               TINYINT(1)   NOT NULL DEFAULT 1,
  guest_control         TINYINT(1)   NOT NULL DEFAULT 1,
  poll_interval_seconds INT          NULL,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_dev_hub FOREIGN KEY (hub_id) REFERENCES app_hubs(id) ON DELETE CASCADE,
  INDEX idx_kind (kind),
  INDEX idx_room (room),
  INDEX idx_excluded (excluded)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Sensor / state readings (for charts and history).
CREATE TABLE IF NOT EXISTS app_readings (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id   INT NOT NULL,
  temperature DECIMAL(5,2) NULL,
  humidity    DECIMAL(5,2) NULL,
  state       TINYINT(1)   NULL,
  energy_w    DECIMAL(8,2) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_read_dev FOREIGN KEY (device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_dev_time (device_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Automation rules and conditions.
CREATE TABLE IF NOT EXISTS app_rules (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(128) NOT NULL,
  enabled          TINYINT(1) NOT NULL DEFAULT 1,
  trigger_type     ENUM('sensor','time','device_state') NOT NULL DEFAULT 'sensor',
  target_device_id INT NOT NULL,
  action           ENUM('on','off','toggle','on_for','off_for',
                        'set_brightness','set_color','set_temp','set_effect') NOT NULL,
  action_value     JSON NULL,
  duration_minutes INT NULL,
  cooldown_minutes INT NOT NULL DEFAULT 0,
  priority         INT NOT NULL DEFAULT 0,
  start_time       TIME NULL,
  end_time         TIME NULL,
  days_mask        TINYINT NOT NULL DEFAULT 127,
  last_fired_at    DATETIME NULL,
  fire_count       INT NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rule_target FOREIGN KEY (target_device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_target (target_device_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_rule_conditions (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  rule_id            INT NOT NULL,
  position           INT NOT NULL DEFAULT 0,
  combinator         ENUM('AND','OR') NULL,           -- NULL for the first condition
  source_type        ENUM('device','http') NOT NULL DEFAULT 'device',
  device_id          INT NULL,
  metric             ENUM('temperature','humidity','state','battery','energy_w','motion','http_value') NOT NULL,
  operator           ENUM('lt','lte','gt','gte','eq','neq') NOT NULL,
  threshold          DECIMAL(14,4) NOT NULL,
  -- HTTP source params (used when source_type='http').
  http_url           VARCHAR(512) NULL,
  http_method        ENUM('GET','POST') NOT NULL DEFAULT 'GET',
  http_json_path     VARCHAR(255) NULL,            -- dot-path: "main.temp" or "" for raw number
  http_cache_seconds INT NOT NULL DEFAULT 60,
  CONSTRAINT fk_cond_rule   FOREIGN KEY (rule_id)   REFERENCES app_rules(id)   ON DELETE CASCADE,
  CONSTRAINT fk_cond_device FOREIGN KEY (device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_rule_pos (rule_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Multi-step actions (v11). When this table has rows for a rule, the
--      legacy single-action columns on app_rules are ignored at runtime.
CREATE TABLE IF NOT EXISTS app_rule_actions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  rule_id           INT NOT NULL,
  position          INT NOT NULL DEFAULT 0,
  kind              ENUM(
                      'on','off','toggle','on_for','off_for',
                      'set_brightness','set_color','set_temp','set_effect',
                      'wait'
                    ) NOT NULL,
  target_device_id  INT NULL,
  action_value      JSON NULL,
  duration_seconds  INT NULL,
  CONSTRAINT fk_ract_rule   FOREIGN KEY (rule_id)          REFERENCES app_rules(id)   ON DELETE CASCADE,
  CONSTRAINT fk_ract_target FOREIGN KEY (target_device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_ract_rule_pos (rule_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Device-to-device dependencies (e.g. heating-pump must follow heating).
CREATE TABLE IF NOT EXISTS app_dependencies (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(128) NOT NULL,
  enabled          TINYINT(1) NOT NULL DEFAULT 1,
  source_device_id INT NOT NULL,
  source_state     TINYINT(1) NOT NULL,
  target_device_id INT NOT NULL,
  required_state   TINYINT(1) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dep_src FOREIGN KEY (source_device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_dep_tgt FOREIGN KEY (target_device_id) REFERENCES app_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Scheduled tasks (timers + vacation/presence simulation).
CREATE TABLE IF NOT EXISTS app_scheduled_tasks (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  device_id                 INT NOT NULL,
  device_ids                JSON NULL,
  action                    ENUM('on','off','toggle','on_for','off_for',
                                 'set_brightness','set_color','set_temp') NOT NULL,
  run_at                    DATETIME NOT NULL,
  status                    ENUM('pending','done','failed','cancelled') NOT NULL DEFAULT 'pending',
  note                      VARCHAR(255) NULL,
  repeat_kind               ENUM('once','minutely','hourly','daily','weekly','monthly')
                                                             NOT NULL DEFAULT 'once',
  repeat_interval           INT NOT NULL DEFAULT 1,
  repeat_until              DATETIME NULL,
  days_mask                 TINYINT NOT NULL DEFAULT 127,
  is_random                 TINYINT(1) NOT NULL DEFAULT 0,
  random_window_start       TIME NULL,
  random_window_end         TIME NULL,
  random_min_minutes        INT NULL,
  random_max_minutes        INT NULL,
  vacation_min_per_day      INT NULL,
  vacation_max_per_day      INT NULL,
  vacation_min_duration_min INT NULL,
  vacation_max_duration_min INT NULL,
  vacation_pick_one         TINYINT(1) NOT NULL DEFAULT 0,
  vacation_dim_chance       TINYINT NULL,
  parent_task_id            INT NULL,
  duration_minutes          INT NULL,
  title                     VARCHAR(128) NULL,
  error_message             VARCHAR(512) NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  executed_at               DATETIME NULL,
  rule_id                   INT NULL,
  CONSTRAINT fk_sched_dev FOREIGN KEY (device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_status_run (status, run_at),
  INDEX idx_parent (parent_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Per-task execution log.
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

-- ---- Application logs.
CREATE TABLE IF NOT EXISTS app_logs (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  level      ENUM('debug','info','warn','error') NOT NULL DEFAULT 'info',
  source     VARCHAR(64)  NOT NULL,
  message    TEXT NOT NULL,
  meta       JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Key/value application settings.
CREATE TABLE IF NOT EXISTS app_settings (
  k          VARCHAR(64) PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO app_settings (k,v) VALUES
  ('poll_interval_seconds','180'),
  ('rules_enabled','1'),
  ('offline_after_failures','3'),
  ('verify_actions','1'),
  ('default_username',''),
  ('default_password',''),
  ('log_level','info'),
  ('admin_password_hash',''),
  ('admin_password_salt','');

-- ---- Dashboard widgets.
CREATE TABLE IF NOT EXISTS app_widgets (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  kind         ENUM('device','sensor','http','label','spacer','group','line') NOT NULL,
  title        VARCHAR(128) NULL,
  config       JSON NULL,                -- type-specific: url, json_path, refresh_seconds, suffix, color, fontSize, device_id, group_id…
  pos_x        INT NOT NULL DEFAULT 0,   -- 0..11 (12-column /widgets editor grid)
  pos_y        INT NOT NULL DEFAULT 0,
  width        INT NOT NULL DEFAULT 3,   -- 1..12
  height       INT NOT NULL DEFAULT 1,
  enabled      TINYINT(1) NOT NULL DEFAULT 1,
  -- Home-screen layout (40 px row grid).
  on_home      TINYINT(1) NOT NULL DEFAULT 0,
  home_x       INT        NOT NULL DEFAULT 0,
  home_y       INT        NOT NULL DEFAULT 0,
  home_width   INT        NOT NULL DEFAULT 4,
  home_height  INT        NOT NULL DEFAULT 2,
  -- HTTP cache (filled by background refresher).
  cached_value JSON         NULL,
  cached_at    DATETIME     NULL,
  cache_error  VARCHAR(512) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pos (pos_y, pos_x)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Device groups (one button toggles many devices, like the Tapo app).
CREATE TABLE IF NOT EXISTS app_device_groups (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  icon       VARCHAR(32)  NULL,
  room       VARCHAR(64)  NULL,
  enabled    TINYINT(1) NOT NULL DEFAULT 1,
  config     JSON NULL,                          -- appearance: render_as, overlay_icon, button_style, …
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

-- ---- Admin sessions (cookie token → admin mode).
CREATE TABLE IF NOT EXISTS app_admin_sessions (
  token        CHAR(64) PRIMARY KEY,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  last_seen_at DATETIME NULL,
  user_agent   VARCHAR(255) NULL,
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
