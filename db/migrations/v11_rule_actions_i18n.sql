-- v11: Multi-step actions for rules + i18n (language preference).
--
-- 1) New table app_rule_actions: ordered list of actions to execute when a
--    rule fires. Includes a 'wait' kind so chains like "turn A on -> wait
--    3 min -> turn B on" are possible.
--
-- 2) When this table has rows for a given rule, the legacy single-action
--    columns on app_rules (action / action_value / target_device_id /
--    duration_minutes) are IGNORED at runtime. Empty list = legacy fallback.
--    The legacy columns stay in place to keep older rules editable on
--    rollback and to simplify migration.

CREATE TABLE IF NOT EXISTS app_rule_actions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  rule_id           INT NOT NULL,
  position          INT NOT NULL DEFAULT 0,
  kind              ENUM(
                      'on','off','toggle','on_for','off_for',
                      'set_brightness','set_color','set_temp','set_effect',
                      'wait'
                    ) NOT NULL,
  -- NULL only for 'wait'.
  target_device_id  INT NULL,
  -- JSON params: { brightness?, hsv?, color_temp?, effect? }.
  action_value      JSON NULL,
  -- Duration in seconds. For *_for: how long to keep the state. For 'wait':
  -- how long to pause before continuing the chain. NULL otherwise.
  duration_seconds  INT NULL,
  CONSTRAINT fk_ract_rule   FOREIGN KEY (rule_id)          REFERENCES app_rules(id)   ON DELETE CASCADE,
  CONSTRAINT fk_ract_target FOREIGN KEY (target_device_id) REFERENCES app_devices(id) ON DELETE CASCADE,
  INDEX idx_rule_pos (rule_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) UI language is per-installation default; individual users can override
--    via cookie. Stored as a regular settings row; SELECT-on-empty returns
--    'en' from defaults.
INSERT INTO app_settings (k, v) VALUES ('default_language', 'en')
  ON DUPLICATE KEY UPDATE v = v;
