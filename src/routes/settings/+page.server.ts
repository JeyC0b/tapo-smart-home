import { getAllSettings } from '$lib/server/settings';

export async function load() {
  const s = await getAllSettings();
  return {
    settings: {
      poll_interval_seconds: s.poll_interval_seconds,
      rules_enabled: s.rules_enabled,
      offline_after_failures: s.offline_after_failures,
      verify_actions: s.verify_actions,
      default_username: s.default_username,
      has_default_password: !!s.default_password,
      log_level: s.log_level,
      default_language: s.default_language,
      task_retry_minutes: s.task_retry_minutes,
      task_revert_retry_minutes: s.task_revert_retry_minutes
    }
  };
}
