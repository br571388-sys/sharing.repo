// Public URL helpers that work outside of a request (queue / cron / commands).

/** Public base URL: PUBLIC_BASE_URL, or the last URL recorded by /setup, or '' if unknown. */
export function baseUrlFromEnv(config, recorded = '') {
  return config.publicBaseUrl || recorded || '';
}
