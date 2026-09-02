-- =====================================================================
-- v12 — Scheduled tasks survive an unreachable device.
-- Idempotent.
--
-- Problem this fixes:
--   Until now a single failed device command marked the whole task
--   'failed'. Two things were lost with it:
--     1) the auto-revert of an "on for N minutes" timer was never
--        scheduled (or, when the revert itself was the failing task,
--        never retried) — the plug stayed ON indefinitely;
--     2) a repeating timer never enqueued its next occurrence, so one
--        Wi-Fi hiccup silently killed the whole daily/weekly schedule.
--
--   Tasks now retry with a backoff until the device answers again, and
--   the next occurrence of a repeating timer is enqueued exactly once,
--   independently of whether this run succeeded.
-- =====================================================================

ALTER TABLE app_scheduled_tasks
  -- How many execution attempts this row has had (0 = never attempted).
  ADD COLUMN IF NOT EXISTS attempt_count  INT        NOT NULL DEFAULT 0 AFTER status,
  -- When the next attempt is due. NULL → the row is still on its original
  -- run_at. The runner picks rows by COALESCE(retry_at, run_at) <= NOW().
  ADD COLUMN IF NOT EXISTS retry_at       DATETIME   NULL AFTER run_at,
  -- Devices still awaiting a successful switch, with the concrete target
  -- state resolved on the FIRST attempt: [{"d":26,"on":true}, …].
  -- Storing the resolved state keeps 'toggle' deterministic across retries
  -- (a re-resolved toggle would flip the device back) and pins the device
  -- that vacation "pick one random device" mode chose.
  ADD COLUMN IF NOT EXISTS retry_targets  JSON       NULL AFTER device_ids,
  -- 1 = this row is the automatic counter-action of an *_for timer. Reverts
  -- get their own (much longer) retry window: a device left ON is a state
  -- the user never asked for, so it is worth chasing for hours.
  ADD COLUMN IF NOT EXISTS is_revert      TINYINT(1) NOT NULL DEFAULT 0 AFTER parent_task_id,
  -- 1 = the follow-up occurrence of this repeating task has been enqueued.
  -- Guards against creating it twice while the row is being retried.
  ADD COLUMN IF NOT EXISTS next_created   TINYINT(1) NOT NULL DEFAULT 0 AFTER is_revert;

-- The runner scans by COALESCE(retry_at, run_at); this index covers the
-- retry_at half of that scan.
ALTER TABLE app_scheduled_tasks
  ADD INDEX IF NOT EXISTS idx_status_retry (status, retry_at);

-- Retry windows in minutes: roughly how long a task keeps chasing a device
-- that does not answer (the runner turns this into an attempt budget).
-- 0 disables retrying for that class of task.
INSERT INTO app_settings (k, v) VALUES ('task_retry_minutes', '60')
  ON DUPLICATE KEY UPDATE v = v;
INSERT INTO app_settings (k, v) VALUES ('task_revert_retry_minutes', '1440')
  ON DUPLICATE KEY UPDATE v = v;
