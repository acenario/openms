import { EXPRESSION_NAMES } from "./character-bindings.js";

// Native tables: 00bd8bcc (89 packed records), 00bdafac (8 quickslots),
// 00be27e0 (key/palette coordinates); consumers 008354e4 and 00836619.
export const KEY_COUNT = 89;
export const QUICK_SLOT_COUNT = 8;

const DEFAULT_RECORDS = [
  [2, 4, 10],
  [3, 4, 12],
  [4, 4, 13],
  [5, 4, 18],
  [6, 4, 24],
  [7, 4, 21],
  [16, 4, 8],
  [17, 4, 5],
  [18, 4, 0],
  [19, 4, 4],
  [23, 4, 1],
  [24, 4, 25],
  [25, 4, 19],
  [26, 4, 14],
  [27, 4, 15],
  [29, 5, 52],
  [31, 4, 2],
  [33, 4, 26],
  [34, 4, 17],
  [35, 4, 11],
  [37, 4, 3],
  [38, 4, 20],
  [39, 4, 27],
  [40, 4, 16],
  [41, 4, 23],
  [43, 4, 9],
  [44, 5, 50],
  [45, 5, 51],
  [46, 4, 6],
  [48, 4, 22],
  [50, 4, 7],
  [56, 5, 53],
  [57, 5, 54],
  [59, 6, 100],
  [60, 6, 101],
  [61, 6, 102],
  [62, 6, 103],
  [63, 6, 104],
  [64, 6, 105],
  [65, 6, 106],
];

export const KEY_COORDINATES = Object.freeze([
  Object.freeze({ index: 0, x: 0, y: 0 }),
  Object.freeze({ index: 1, x: 0, y: 0 }),
  Object.freeze({ index: 2, x: 48, y: 66 }),
  Object.freeze({ index: 3, x: 82, y: 66 }),
  Object.freeze({ index: 4, x: 116, y: 66 }),
  Object.freeze({ index: 5, x: 150, y: 66 }),
  Object.freeze({ index: 6, x: 184, y: 66 }),
  Object.freeze({ index: 7, x: 218, y: 66 }),
  Object.freeze({ index: 8, x: 252, y: 66 }),
  Object.freeze({ index: 9, x: 286, y: 66 }),
  Object.freeze({ index: 10, x: 320, y: 66 }),
  Object.freeze({ index: 11, x: 354, y: 66 }),
  Object.freeze({ index: 12, x: 388, y: 66 }),
  Object.freeze({ index: 13, x: 422, y: 66 }),
  Object.freeze({ index: 14, x: 0, y: 0 }),
  Object.freeze({ index: 15, x: 0, y: 0 }),
  Object.freeze({ index: 16, x: 64, y: 99 }),
  Object.freeze({ index: 17, x: 98, y: 99 }),
  Object.freeze({ index: 18, x: 132, y: 99 }),
  Object.freeze({ index: 19, x: 166, y: 99 }),
  Object.freeze({ index: 20, x: 200, y: 99 }),
  Object.freeze({ index: 21, x: 234, y: 99 }),
  Object.freeze({ index: 22, x: 268, y: 99 }),
  Object.freeze({ index: 23, x: 302, y: 99 }),
  Object.freeze({ index: 24, x: 336, y: 99 }),
  Object.freeze({ index: 25, x: 370, y: 99 }),
  Object.freeze({ index: 26, x: 404, y: 99 }),
  Object.freeze({ index: 27, x: 438, y: 99 }),
  Object.freeze({ index: 28, x: 0, y: 0 }),
  Object.freeze({ index: 29, x: 22, y: 198 }),
  Object.freeze({ index: 30, x: 81, y: 132 }),
  Object.freeze({ index: 31, x: 115, y: 132 }),
  Object.freeze({ index: 32, x: 149, y: 132 }),
  Object.freeze({ index: 33, x: 183, y: 132 }),
  Object.freeze({ index: 34, x: 217, y: 132 }),
  Object.freeze({ index: 35, x: 251, y: 132 }),
  Object.freeze({ index: 36, x: 285, y: 132 }),
  Object.freeze({ index: 37, x: 319, y: 132 }),
  Object.freeze({ index: 38, x: 353, y: 132 }),
  Object.freeze({ index: 39, x: 387, y: 132 }),
  Object.freeze({ index: 40, x: 421, y: 132 }),
  Object.freeze({ index: 41, x: 14, y: 66 }),
  Object.freeze({ index: 42, x: 38, y: 165 }),
  Object.freeze({ index: 43, x: 472, y: 99 }),
  Object.freeze({ index: 44, x: 98, y: 165 }),
  Object.freeze({ index: 45, x: 132, y: 165 }),
  Object.freeze({ index: 46, x: 166, y: 165 }),
  Object.freeze({ index: 47, x: 200, y: 165 }),
  Object.freeze({ index: 48, x: 234, y: 165 }),
  Object.freeze({ index: 49, x: 268, y: 165 }),
  Object.freeze({ index: 50, x: 302, y: 165 }),
  Object.freeze({ index: 51, x: 336, y: 165 }),
  Object.freeze({ index: 52, x: 370, y: 165 }),
  Object.freeze({ index: 53, x: 0, y: 0 }),
  Object.freeze({ index: 54, x: 457, y: 165 }),
  Object.freeze({ index: 55, x: 0, y: 0 }),
  Object.freeze({ index: 56, x: 122, y: 198 }),
  Object.freeze({ index: 57, x: 233, y: 198 }),
  Object.freeze({ index: 58, x: 0, y: 0 }),
  Object.freeze({ index: 59, x: 82, y: 27 }),
  Object.freeze({ index: 60, x: 116, y: 27 }),
  Object.freeze({ index: 61, x: 150, y: 27 }),
  Object.freeze({ index: 62, x: 184, y: 27 }),
  Object.freeze({ index: 63, x: 226, y: 27 }),
  Object.freeze({ index: 64, x: 260, y: 27 }),
  Object.freeze({ index: 65, x: 294, y: 27 }),
  Object.freeze({ index: 66, x: 328, y: 27 }),
  Object.freeze({ index: 67, x: 370, y: 27 }),
  Object.freeze({ index: 68, x: 404, y: 27 }),
  Object.freeze({ index: 69, x: 0, y: 0 }),
  Object.freeze({ index: 70, x: 0, y: 0 }),
  Object.freeze({ index: 71, x: 548, y: 66 }),
  Object.freeze({ index: 72, x: 0, y: 0 }),
  Object.freeze({ index: 73, x: 582, y: 66 }),
  Object.freeze({ index: 74, x: 0, y: 0 }),
  Object.freeze({ index: 75, x: 0, y: 0 }),
  Object.freeze({ index: 76, x: 0, y: 0 }),
  Object.freeze({ index: 77, x: 0, y: 0 }),
  Object.freeze({ index: 78, x: 0, y: 0 }),
  Object.freeze({ index: 79, x: 548, y: 99 }),
  Object.freeze({ index: 80, x: 0, y: 0 }),
  Object.freeze({ index: 81, x: 582, y: 99 }),
  Object.freeze({ index: 82, x: 514, y: 66 }),
  Object.freeze({ index: 83, x: 514, y: 99 }),
  Object.freeze({ index: 84, x: 0, y: 0 }),
  Object.freeze({ index: 85, x: 72, y: 198 }), // the drawn Windows/Command key
  Object.freeze({ index: 86, x: 0, y: 0 }),
  Object.freeze({ index: 87, x: 438, y: 27 }),
  Object.freeze({ index: 88, x: 472, y: 27 }),
  Object.freeze({ index: 89, x: 461, y: 198 }),
  Object.freeze({ index: 90, x: 348, y: 198 }),
]);

const PALETTE_COORDINATES = [
  [9, 267],
  [43, 267],
  [77, 267],
  [111, 267],
  [145, 267],
  [179, 267],
  [213, 267],
  [247, 267],
  [281, 267],
  [315, 267],
  [349, 267],
  [383, 267],
  [417, 267],
  [451, 267],
  [485, 267],
  [519, 267],
  [553, 267],
  [587, 267],
  [9, 301],
  [43, 301],
  [77, 301],
  [111, 301],
  [145, 301],
  [179, 301],
  [213, 301],
  [247, 301],
  [281, 301],
  [315, 301],
  [349, 301],
  [383, 301],
  [417, 301],
  [451, 301],
  [485, 301],
  [519, 301],
  [553, 301],
  [587, 301],
  [9, 335],
  [43, 335],
  [77, 335],
  [111, 335],
];

// Windows scan-code physical locations used by the native high-word key consumer.
// Numpad digits follow 0072df55's VK conversion to the number-row records.
const CODE_INDICES = Object.freeze({
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Home: 71,
  ArrowUp: 72,
  PageUp: 73,
  NumpadSubtract: 74,
  ArrowLeft: 75,
  ArrowRight: 77,
  NumpadAdd: 78,
  End: 79,
  ArrowDown: 80,
  PageDown: 81,
  Insert: 82,
  Delete: 83,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  ControlRight: 89,
  AltRight: 90,
  // The native keyboard art draws a Windows key between Ctrl and Alt but no record backs it.
  // Its physical position is macOS Command; both use the otherwise unused record 85, which
  // starts unbound and can be assigned in Key Config like any other key.
  MetaLeft: 85,
  MetaRight: 85,
  Numpad0: 11,
  Numpad1: 2,
  Numpad2: 3,
  Numpad3: 4,
  Numpad4: 5,
  Numpad5: 6,
  Numpad6: 7,
  Numpad7: 8,
  Numpad8: 9,
  Numpad9: 10,
});
export const PHYSICAL_CODES = Object.freeze(Object.keys(CODE_INDICES));
const DIRECTIONS = Object.freeze({
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
});

export function canonicalKeyIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 90) return -1;
  if (index === 54) return 42;
  if (index === 89) return 29;
  if (index === 90) return 56;
  return index;
}

export function keyIndexForCode(code) {
  return canonicalKeyIndex(CODE_INDICES[code] ?? -1);
}

export function isAssignableKey(index) {
  index = canonicalKeyIndex(index);
  return index >= 0 && KEY_COORDINATES[index].x !== 0;
}

export function createDefaultBindings() {
  const keys = Array.from({ length: KEY_COUNT }, () => ({ type: 0, id: 0 }));
  for (const [index, type, id] of DEFAULT_RECORDS) keys[index] = { type, id };
  return { keys, quickSlots: [42, 82, 71, 73, 29, 83, 79, 81] };
}

export function heldActionForCode(code, bindings) {
  if (Object.hasOwn(DIRECTIONS, code)) return DIRECTIONS[code];
  const index = keyIndexForCode(code);
  if (index < 0) return null;
  const action = bindingAction(bindings.keys[index]);
  if (action === "Attack") return "attack";
  if (action === "Jump") return "jump";
  return null;
}

// 00a0773d dispatches type4 IDs to window indices; ID9 ->5 constructs
// KeyConfig at 00a05bb5 (00832586). Captions are not action identifiers.
const WINDOW_ACTIONS = Object.freeze({
  0: "Equip",
  1: "Item",
  3: "Skill",
  4: "Friends",
  5: "WorldMap",
  6: "Messenger",
  7: "MiniMap", // 00a0788f ->008590f9 cycles the resident minimap.
  9: "KeyConfig",
  10: "ChatAll",
  11: "ChatWhisper",
  12: "ChatParty",
  13: "ChatBuddy",
  8: "Quest",
  2: "Stat",
  14: "ShortCut", // 00a078da ->00a06cbc constructs0084a560 shortcut menu.
  15: "QuickSlot",
  16: "ExpandChat",
  17: "Guild",
  18: "ChatGuild",
  19: "Party",
  20: "QuestAlarm",
  21: "ChatSpouse",
  22: "MonsterBook",
  23: "CashShop",
  24: "ChatAlliance",
  25: "PartySearch",
  26: "Family",
  27: "Title",
});
const CHARACTER_ACTIONS = Object.freeze({
  50: "Pickup",
  51: "Sit",
  52: "Attack",
  53: "Jump",
  54: "Talk",
});

const RELEASE_ACTIONS = new Set([10, 11, 12, 13, 18, 21, 24]);

/** Original00a0773d selects chat channels on key-up, unlike ordinary window actions. */
export function isReleaseBinding(binding) {
  return binding?.type === 4 && RELEASE_ACTIONS.has(binding.id);
}

export function bindingAction(binding) {
  if (binding?.type === 4) return WINDOW_ACTIONS[binding.id] ?? null;
  if (binding?.type === 5) return CHARACTER_ACTIONS[binding.id] ?? null;
  if (binding?.type === 6 && binding.id >= 100 && binding.id <= 106) {
    return `Expression:${EXPRESSION_NAMES[binding.id - 99]}`;
  }
  return null;
}

export const ACTION_PALETTE = Object.freeze(
  PALETTE_COORDINATES.map(([x, y], paletteIndex) => {
    const type = paletteIndex < 28 ? 4 : paletteIndex < 33 ? 5 : 6;
    const id =
      paletteIndex < 28
        ? paletteIndex
        : paletteIndex < 33
          ? paletteIndex + 22
          : paletteIndex + 67;
    const binding = { type, id };
    return Object.freeze({
      ...binding,
      paletteIndex,
      index: paletteIndex + 91,
      x,
      y,
      name: bindingAction(binding),
      iconPath: `icon/${id}`,
    });
  }),
);

const BINDABLE_USE_GROUPS = new Set([
  200, 201, 202, 205, 212, 221, 226, 227, 236, 238, 245,
]);

/** 004f38f4 admission is independent of locally supported use effects. */
export function itemBindingType(item) {
  if (!item || !Number.isSafeInteger(item.id)) return 0;
  const group = Math.floor(item.id / 10000);
  if (item.category === "Consume") {
    return BINDABLE_USE_GROUPS.has(group) ||
      Math.floor(item.id / 1000) === 2109 ||
      item.id === 2100067
      ? 2
      : 0;
  }
  if (item.category === "Install") return group === 301 ? 2 : 0;
  if (item.category === "Etc") return group === 429 ? 7 : 0;
  if (item.category === "Cash") return cashBindingType(group);
  return 0;
}

function cashBindingType(group) {
  if (group === 524 || group === 530) return 2;
  if (group === 501) return 7;
  if (group === 516) return 3; // 00486845 -> 0048645b -> 004865eb returns classifier 6.
  return 0;
}
