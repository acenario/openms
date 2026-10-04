/** Browser engineering limits shared by admission and the nonrecursive interpreter. */
export const NPC_RUNTIME_LIMITS = Object.freeze({
  sourceBytes: 1000000,
  tokens: 50000,
  nodes: 30000,
  depth: 128,
  expressions: 20000,
  statements: 10000,
  analysisSteps: 200000,
  variables: 512,
  arrayLength: 256,
  loopIterations: 256,
  stepsPerTurn: 100000,
  turnsPerSession: 2048,
  textLength: 32768,
  inputLength: 4096,
  dependencies: 8192,
});

// Original raw NPC message and CUtilDlgEx renderer types are distinct enums.
export const NPC_DIALOG_TYPES = Object.freeze({
  sendNext: Object.freeze({
    kind: "say",
    rawType: 0,
    internalType: 0,
    prev: false,
    next: true,
  }),
  sendPrev: Object.freeze({
    kind: "say",
    rawType: 0,
    internalType: 0,
    prev: true,
    next: false,
  }),
  sendNextPrev: Object.freeze({
    kind: "say",
    rawType: 0,
    internalType: 0,
    prev: true,
    next: true,
  }),
  sendOk: Object.freeze({
    kind: "say",
    rawType: 0,
    internalType: 0,
    prev: false,
    next: false,
  }),
  sendYesNo: Object.freeze({ kind: "yes-no", rawType: 1, internalType: 1 }),
  sendAcceptDecline: Object.freeze({
    kind: "accept-decline",
    rawType: 12,
    internalType: 1,
  }),
  sendSimple: Object.freeze({ kind: "choice", rawType: 4, internalType: 4 }),
  sendGetNumber: Object.freeze({ kind: "number", rawType: 3, internalType: 2 }),
  sendGetText: Object.freeze({ kind: "text", rawType: 2, internalType: 3 }),
});

export const NPC_REMOTE_SERVICES = Object.freeze([
  "party-membership",
  "monster-carnival",
  "server-experience-reward",
  "hall-of-fame-player-npc",
  "party-quest-progress",
  "custom-quest-progress",
  "event-instance",
  "quest-info-progress",
  "skill-grant",
  "field-population",
  "random-outcome",
]);

export const NPC_READ_TYPES = Object.freeze({
  "is-gm": [0, 0],
  "cpq-winner-map": [0, 0],
  "cpq-loser-map": [0, 0],
  meso: [0, 0],
  level: [0, 0],
  job: [0, 0],
  "input-text": [0, 0],
  "crafting-scroll": [0, 0],
  "map-id": [0, 0],
  "number-with-commas": [1, 1],
  "parse-int": [1, 2],
  "hall-of-fame-map": [1, 1],
  "skill-book": [1, 1],
  "is-cygnus": [1, 1],
  "is-aran": [1, 1],
  "first-job-stat-requirement": [1, 1],
  "can-get-first-job": [2, 2],
  "saved-location-peek": [1, 1],
  "saved-location-take": [1, 1],
  "quest-state": [1, 1, "questIds"],
  "quest-completed": [1, 1, "questIds"],
  "quest-started": [1, 1, "questIds"],
  "item-count": [1, 1, "itemIds"],
  "have-item": [1, 2, "itemIds"],
  "can-hold": [1, 2, "itemIds"],
  "can-hold-all": [1, 2, "itemIds"],
});
for (const spec of Object.values(NPC_READ_TYPES)) Object.freeze(spec);

export function npcError(code, reason) {
  return Object.assign(new Error(reason), { code });
}

export function requireNpc(condition, reason, code = "npc-artifact") {
  if (!condition) throw npcError(code, reason);
}

export function npcInteger(value, min = -2147483648, max = 2147483647) {
  requireNpc(
    Number.isSafeInteger(value) && value >= min && value <= max,
    "NPC integer is outside the supported range",
    "npc-value",
  );
  return value;
}

export function npcPrimitive(value) {
  requireNpc(
    value === null ||
      value === undefined ||
      ["string", "number", "boolean"].includes(typeof value),
    "NPC source operation requires a primitive",
    "npc-value",
  );
  return value;
}

export function npcValue(value) {
  if (typeof value === "number") {
    requireNpc(
      Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
      "NPC arithmetic produced an unsupported number",
      "npc-value",
    );
  }
  if (typeof value === "string") {
    requireNpc(
      value.length <= NPC_RUNTIME_LIMITS.textLength,
      "NPC string exceeds the text limit",
      "npc-value",
    );
  }
  return value;
}

export function npcNumber(value) {
  return npcValue(Number(npcPrimitive(value)));
}

/** Explicit primitive abstract equality; object coercion/host dispatch is never possible. */
function primitiveEqual(left, right) {
  if (typeof left === typeof right) return left === right;
  const leftAbsent = left === null || left === undefined;
  const rightAbsent = right === null || right === undefined;
  if (leftAbsent && rightAbsent) return true;
  if (leftAbsent || rightAbsent) return false;
  return numericPrimitiveEqual(left, right);
}

function numericPrimitiveEqual(left, right) {
  if (typeof left === "boolean") left = Number(left);
  if (typeof right === "boolean") right = Number(right);
  if (typeof left === "number" && typeof right === "string") {
    right = Number(right);
  }
  if (typeof right === "number" && typeof left === "string") {
    left = Number(left);
  }
  return left === right;
}

/** Arrays retain identity; abstract comparisons requiring object coercion remain refused. */
function arrayEquality(operator, left, right) {
  if (!Array.isArray(left)) npcPrimitive(left);
  if (!Array.isArray(right)) npcPrimitive(right);
  if (operator === "===") return left === right;
  if (operator === "!==") return left !== right;
  const identityOnly =
    (Array.isArray(left) && Array.isArray(right)) ||
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined;
  requireNpc(
    identityOnly,
    "NPC array equality cannot coerce primitives",
    "npc-value",
  );
  const equal = left === right;
  return operator === "==" ? equal : !equal;
}

/** Source JS primitive conversions are intentional and bounded before/after operations. */
export function npcBinary(operator, left, right) {
  if (
    ["==", "!=", "===", "!=="].includes(operator) &&
    (Array.isArray(left) || Array.isArray(right))
  ) {
    return arrayEquality(operator, left, right);
  }
  npcPrimitive(left);
  npcPrimitive(right);
  switch (operator) {
    case "+":
      return npcValue(
        typeof left === "string" || typeof right === "string"
          ? String(left) + String(right)
          : Number(left) + Number(right),
      );
    case "-":
      return npcValue(Number(left) - Number(right));
    case "*":
      return npcValue(Number(left) * Number(right));
    case "/":
      return npcValue(Number(left) / Number(right));
    case "%":
      return npcValue(Number(left) % Number(right));
    default:
      return comparePrimitives(operator, left, right);
  }
}

function comparePrimitives(operator, left, right) {
  switch (operator) {
    case "==":
      return primitiveEqual(left, right);
    case "!=":
      return !primitiveEqual(left, right);
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      throw npcError("npc-artifact", "Unknown NPC binary operation");
  }
}

export function npcUnary(operator, value) {
  if (operator === "is-array") return Array.isArray(value);
  if (operator === "!") return !value;
  if (operator === "typeof") return typeof value;
  if (operator === "+") return npcNumber(value);
  if (operator === "-") return npcValue(-npcNumber(value));
  throw npcError("npc-artifact", "Unknown NPC unary operation");
}
