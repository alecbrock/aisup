/** Wrap s in single quotes with internal quotes escaped for POSIX shell. */
export function singleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
