// Original008d379c/008d549f; ordinary input is70 printable ASCII characters.
// Fork policy (not original): allow longer messages for agent and player conversation.
// The protocol's text bound (shared/schema.js) still caps a message at 256 characters.
export const CHAT_LIMIT = 200;
export const CHAT_RATE_LIMITS = Object.freeze({
  repeat: 30000,
  flood: 2000,
  cooldown: 2800,
});

export function sanitizeChat(text) {
  return text.replace(/[^\x20-\x7e]/g, " ").trim();
}

/** 004904be: shared original four-message gates; UI owns its history and counters. */
export function admitChat(state, text, now) {
  if (now < state.blockedUntil) return false;
  if (now - state.recentStarted > CHAT_RATE_LIMITS.repeat) {
    state.recent.length = 0;
    state.recentStarted = now;
  }
  if (state.recent.length === 4) state.recent.shift();
  state.recent.push(text);
  const repeated =
    state.recent.length === 4 &&
    state.recent.every((previous) => previous === text);
  if (!repeated) {
    state.submitTimes[state.submitIndex] = now;
    state.submitIndex = (state.submitIndex + 1) % state.submitTimes.length;
  }
  if (
    repeated ||
    now - state.submitTimes[state.submitIndex] < CHAT_RATE_LIMITS.flood
  ) {
    state.blockedUntil = now + CHAT_RATE_LIMITS.cooldown;
    return false;
  }
  return true;
}
