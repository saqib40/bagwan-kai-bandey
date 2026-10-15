/**
 * Pure helper with no framework dependency (classified CLEAN on init).
 * djb2 string hash rendered as base-36.
 */
export function shortHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
