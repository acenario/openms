/**
 * SERVER-reference custom quests: the vendored Cosmic 2nd-job advancement
 * scripts (instructors 1012100/1022000/1032001/1052001, job instructors
 * 1072000–1072007) track these IDs as ordinary quest status rows, but no
 * Quest.wz Check/Act/Info record exists. They carry start/complete state only
 * (no mob counters, rewards or journal entry) and share `profile.quests`, as
 * Cosmic's queststatus table does. Original quest IDs end below 30000.
 */
const FIRST = 100000;
const LAST = 100011;

export function isCustomQuest(id) {
  const value = Number(id);
  return Number.isSafeInteger(value) && value >= FIRST && value <= LAST;
}
