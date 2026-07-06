/**
 * Redaction for status text fragments (activity labels, project names).
 * Patterns are treated as case-insensitive literals unless they compile as a
 * valid RegExp, in which case they're used as one.
 */
export function redactText(text: string, patterns: string[]): string {
  let out = text;
  for (const pattern of patterns) {
    if (!pattern) continue;
    let re: RegExp;
    try {
      re = new RegExp(pattern, "gi");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    }
    out = out.replace(re, "…");
  }
  return out;
}
