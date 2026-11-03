const seen = new Set<string>();

/**
 * `console.warn` at most once per key, per process.
 *
 * For conditions that are steady state rather than per-request — a missing
 * platform header, say: either it is there for every request or for none, so
 * the second line carries no information and the log becomes noise.
 */
export const warnOnce = (key: string, message: string): void => {
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  console.warn(message);
};
