/**
 * Heuristics for classifying user prompts.
 *
 * Author: Michael Christensen
 */

/**
 * Whether a user prompt is substantial enough to start a first-responder
 * worker. This is intentionally conservative for short status/meta questions.
 */
export function looksSubstantive(text: string): boolean {
  const clean = text.trim();
  if (!clean) {
    return false;
  }
  if (clean.startsWith("/")) {
    return false;
  }
  if (/^\[swarm wakeup/i.test(clean)) {
    return false;
  }
  if (/^(hi|hello|hey|thanks|thank you)\b/i.test(clean) && clean.length < 60) {
    return false;
  }
  if (/^(is|are) (it|this|the swarm|mswarm)\b/i.test(clean)) {
    return false;
  }
  if (/^(what|which) (color|model|version|status)\b/i.test(clean)) {
    return false;
  }
  if (/^(show|tell me) (the )?(status|board|roster)\b/i.test(clean)) {
    return false;
  }
  if (clean.length >= 80) {
    return true;
  }
  if (/^(why|how (do|does|did|can|could|should|would))\b/i.test(clean)) {
    return true;
  }
  // Stems, not whole words: "analy" must match "analyze" and "analysis".
  return /\b(review|analy|port|research|investigat|fix|correct|implement|build|add|change|update|test|write|create|compare|explain|plan|design|refactor|clean|install|commit|debug|diagnos|optimi|improve|find|check|make|migrat|remove|delete|rename|upgrade|document|summari|audit)\w*/i.test(
    clean,
  );
}
