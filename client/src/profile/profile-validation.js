import { PROGRESSION_POLICY } from "../character/offline-progression.js";
import { createDefaultBindings, isAssignableKey } from "../input/keymap.js";
import {
  INVENTORY_POLICY,
  inventoryType,
  itemStackLimit,
  effectiveItemStackLimit,
  isRechargeable,
  equippedSlots,
  createItemUid,
} from "../items/inventory-model.js";
import {
  createCash,
  createSkillMacros,
  createSavedLocations,
  SAVED_LOCATION_TYPES,
  validateCash,
  validateMonsterBook,
  validateSkillMacros,
} from "./profile-domains.js";
import {
  createSocial,
  validateSocial,
  validateSocialOwner,
} from "./profile-social.js";
import {
  createGameOptions,
  validateGameOptions,
} from "./profile-game-options.js";
import { isCustomQuest } from "../quests/custom-quests.js";
import {
  validateItemUpgrade,
  validatePets,
  validateMount,
} from "./profile-item-state.js";

/** Versioned browser save format; limits are local engineering policies, not native rules. */
export const PROFILE_VERSION = 8;
export const PROFILE_LIMITS = Object.freeze({
  inventory: 4096,
  equipment: 128,
  quests: 16384,
  kills: 4096,
  totalKills: 65536,
  coordinate: 10000000,
  name: 32,
  skills: 4096,
  characters: 32,
});

const PROFILE_KEYS = [
  "schemaVersion",
  "name",
  "level",
  "job",
  "exp",
  "meso",
  "fame",
  "hp",
  "maxHP",
  "mp",
  "maxMP",
  "str",
  "dex",
  "int",
  "luk",
  "inventory",
  "equipment",
  "quests",
  "location",
  "settings",
  "keyBindings",
  "remainingSp",
  "skills",
  "remainingAp",
  "inventorySlots",
  "gender",
  "appearance",
  "baseMaxHP",
  "baseMaxMP",
  "cash",
  "monsterBook",
  "skillMacros",
  "social",
  "pets",
  "mount",
  "savedLocations",
];
const VERSION_SIX_KEYS = PROFILE_KEYS.slice(0, -1);
const VERSION_FIVE_KEYS = VERSION_SIX_KEYS.slice(0, -2);
const LEGACY_PROFILE_KEYS = VERSION_SIX_KEYS.slice(0, -11);
const NATIVE_EQUIPPED_POSITIONS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 49, 50, 51,
]);

/** Errors retain a stable code for native UI and inspection consumers. */
export function profileError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ProfileError";
  error.code = code;
  return error;
}

function invalid(path) {
  throw profileError("corrupt-profile", `Invalid saved profile: ${path}`);
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path);
}

function keys(value, allowed, path) {
  object(value, path);
  const own = Reflect.ownKeys(value);
  if (own.length > allowed.length) invalid(`${path} fields`);
  for (const key of own) {
    if (!allowed.includes(key)) invalid(`${path} field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      invalid(path);
    }
  }
}

function integer(value, minimum, path) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(path);
}

function itemId(value, path) {
  integer(value, 1, path);
  if (value > 99999999) invalid(path);
}

function dictionary(value, limit, path) {
  object(value, path);
  const own = Reflect.ownKeys(value);
  if (own.length > limit) invalid(`${path} capacity`);
  for (const key of own) {
    if (typeof key !== "string" || !/^(0|[1-9]\d{0,8})$/.test(key)) {
      invalid(path);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      invalid(path);
    }
  }
  return own;
}

function itemRecord(entry) {
  keys(
    entry,
    ["uid", "id", "count", "slot", "owner", "flags", "expiresAt", "upgrade"],
    "item entry",
  );
  inventoryType(entry.id);
  if (
    typeof entry.uid !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(entry.uid)
  ) {
    invalid("item uid");
  }
  integer(entry.count, isRechargeable(entry.id) ? 0 : 1, "item count");
  if (!Number.isSafeInteger(entry.slot) || entry.slot === 0) {
    invalid("item slot");
  }
  itemOwnership(entry);
  if (
    (inventoryType(entry.id) === 1 || Math.floor(entry.id / 10000) === 500) &&
    entry.count !== 1
  ) {
    invalid("equipment count");
  }
  if (Object.hasOwn(entry, "upgrade")) {
    validateItemUpgrade(entry.upgrade, entry.id);
  }
}

function itemOwnership(entry) {
  if (
    typeof entry.owner !== "string" ||
    entry.owner.length > INVENTORY_POLICY.ownerLength
  ) {
    invalid("item owner");
  }
  integer(entry.flags, 0, "item flags");
  if (entry.flags > 0xffff) invalid("item flags");
  if (entry.expiresAt !== null) integer(entry.expiresAt, 0, "item expiration");
}

function itemTemplate(items, id) {
  const template = items?.[id];
  if (!template?.descriptor || template.id !== id) {
    throw profileError(
      "item-unavailable",
      `Original item metadata unavailable for saved item ${id}; the durable save is unchanged.`,
    );
  }
  return template;
}

function validateItemMetadata(entry, items, equipped, profile) {
  if (!items) return;
  const template = itemTemplate(items, entry.id);
  const limit = profile
    ? effectiveItemStackLimit(profile, template)
    : itemStackLimit(template);
  if (entry.count > limit) {
    invalid(`item ${entry.id} exceeds authored stack limit`);
  }
  if (equipped && !equippedSlots(template).includes(entry.slot)) {
    invalid(`item ${entry.id} equipped slot`);
  }
  return template;
}

function validateInventoryCapacity(value) {
  if (
    !Array.isArray(value.inventorySlots) ||
    value.inventorySlots.length !== 5
  ) {
    invalid("inventorySlots");
  }
  for (const capacity of value.inventorySlots) {
    integer(capacity, 1, "inventory capacity");
    if (capacity > PROFILE_LIMITS.inventory) invalid("inventory capacity");
  }
  if (
    !Array.isArray(value.inventory) ||
    value.inventory.length > PROFILE_LIMITS.inventory
  ) {
    invalid("inventory");
  }
  if (
    !Array.isArray(value.equipment) ||
    value.equipment.length > PROFILE_LIMITS.equipment
  ) {
    invalid("equipment");
  }
}

function inventory(value, items) {
  validateInventoryCapacity(value);
  const uids = new Set(),
    slots = new Set(),
    totals = new Map();
  for (const entries of [value.inventory, value.equipment]) {
    const equipped = entries === value.equipment;
    for (const entry of entries) {
      itemRecord(entry);
      const type = validateInventorySlot(entry, value, equipped);
      const slot = `${type}:${entry.slot}`;
      if (uids.has(entry.uid)) invalid("duplicate item uid");
      if (slots.has(slot)) invalid("duplicate item slot");
      uids.add(entry.uid);
      slots.add(slot);
      const count = (totals.get(entry.id) ?? 0) + entry.count;
      integer(count, isRechargeable(entry.id) ? 0 : 1, "total item quantity");
      totals.set(entry.id, count);
      validateItemMetadata(entry, items, equipped, value);
    }
  }
  validateEquippedConflicts(value.equipment, slots);
}

function validateInventorySlot(entry, profile, equipped) {
  const type = inventoryType(entry.id);
  const equippedPosition = -entry.slot > 100 ? -entry.slot - 100 : -entry.slot;
  if (
    equipped
      ? type !== 1 ||
        entry.slot >= 0 ||
        !NATIVE_EQUIPPED_POSITIONS.has(equippedPosition) ||
        entry.count !== 1
      : entry.slot < 1 || entry.slot > profile.inventorySlots[type - 1]
  ) {
    invalid("item slot");
  }
  return type;
}

/** Cosmic SERVER-reference InventoryManipulator.equip/getWeaponType mutual exclusions. */
function validateEquippedConflicts(equipment, slots) {
  for (const entry of equipment) {
    const category = Math.floor(entry.id / 10000);
    if (entry.slot === -5 && category === 105 && slots.has("1:-6")) {
      invalid("equipped overall conflicts with pants");
    }
    if (
      entry.slot === -11 &&
      category >= 140 &&
      category <= 149 &&
      slots.has("1:-10")
    ) {
      invalid("equipped two-handed weapon conflicts with shield");
    }
  }
}

/** Every owned item and gift envelope has a distinct identity across the transaction. */
export function validateCharacterUids(
  profiles,
  maximum = PROFILE_LIMITS.characters,
) {
  if (
    !Array.isArray(profiles) ||
    profiles.length < 1 ||
    profiles.length > maximum
  ) {
    invalid("character transaction participants");
  }
  const seen = new Set();
  for (const profile of profiles) {
    for (const entries of [
      profile.inventory,
      profile.equipment,
      profile.cash.locker,
    ]) {
      for (const entry of entries) addUid(seen, entry.uid);
    }
    for (const gift of profile.cash.gifts) {
      addUid(seen, gift.uid);
      for (const item of gift.items) addUid(seen, item.uid);
    }
    for (const pet of profile.pets) addUid(seen, pet.uid);
  }
}

function addUid(seen, uid) {
  if (seen.has(uid)) invalid("duplicate owned item or gift uid");
  seen.add(uid);
}

function quests(value) {
  const ids = dictionary(value, PROFILE_LIMITS.quests, "quests");
  let total = 0;
  for (const id of ids) {
    const entry = value[id];
    keys(entry, ["state", "kills", "completedAt"], `quest ${id}`);
    if (![0, 1, 2].includes(entry.state)) invalid(`quest ${id} state`);
    if (Object.hasOwn(entry, "completedAt")) {
      integer(entry.completedAt, 0, "completedAt");
    }
    const targets = dictionary(
      entry.kills,
      PROFILE_LIMITS.kills,
      "quest kills",
    );
    // Custom quests are state-only; mob progress would have no original target.
    if (isCustomQuest(id) && targets.length) invalid(`quest ${id} kills`);
    total += targets.length;
    if (total > PROFILE_LIMITS.totalKills) invalid("total quest kill capacity");
    for (const target of targets) {
      integer(entry.kills[target], 0, "quest kill count");
    }
  }
}

/** Location is durable feet coordinates; geometry is revalidated by scene preparation. */
export function validateProfileLocation(value) {
  keys(value, ["mapId", "x", "y", "facing"], "location");
  if (typeof value.mapId !== "string" || !/^\d{9}$/.test(value.mapId)) {
    invalid("mapId");
  }
  for (const key of ["x", "y"]) {
    if (
      !Number.isFinite(value[key]) ||
      Math.abs(value[key]) > PROFILE_LIMITS.coordinate
    ) {
      invalid(`location ${key}`);
    }
  }
  if (value.facing !== -1 && value.facing !== 1) invalid("location facing");
  return value;
}

function settings(value) {
  keys(
    value,
    ["BGM", "SE", "chat", "questTracker", "gameOptions", "alerts"],
    "settings",
  );
  for (const category of ["BGM", "SE"]) {
    const audio = value[category];
    keys(audio, ["volume", "mute"], `settings ${category}`);
    integer(audio.volume, 0, "audio volume");
    if (audio.volume > 128 || typeof audio.mute !== "boolean") {
      invalid("audio settings");
    }
  }
  keys(value.chat, ["state", "height"], "chat settings");
  integer(value.chat.state, 1, "chat state");
  integer(value.chat.height, 26, "chat height");
  if (value.chat.state > 3 || value.chat.height > 507) invalid("chat settings");
  validateQuestTracker(value.questTracker);
  validateGameOptions(value.gameOptions);
  keys(value.alerts, ["hp", "mp"], "gauge alerts");
  for (const threshold of [value.alerts.hp, value.alerts.mp]) {
    integer(threshold, 0, "gauge alert threshold");
    if (threshold > 19) invalid("gauge alert threshold");
  }
}

function validateQuestTracker(tracker) {
  keys(tracker, ["ids", "auto", "open"], "quest tracker");
  if (
    !Array.isArray(tracker.ids) ||
    tracker.ids.length > 5 ||
    typeof tracker.auto !== "boolean" ||
    typeof tracker.open !== "boolean"
  ) {
    invalid("quest tracker");
  }
  const seen = new Set();
  for (const id of tracker.ids) {
    integer(id, 0, "tracked quest");
    if (id > 999999999 || seen.has(id)) invalid("tracked quest");
    seen.add(id);
  }
}

/** Preserve the packed byte/uint32 contract, including assigned type4/ID0. */
export function validateKeyBindings(value) {
  keys(value, ["keys", "quickSlots"], "key bindings");
  if (!Array.isArray(value.keys) || value.keys.length !== 89) {
    invalid("functional keys");
  }
  for (const binding of value.keys) {
    keys(binding, ["type", "id"], "functional key");
    integer(binding.type, 0, "functional key type");
    integer(binding.id, 0, "functional key id");
    if (binding.type > 8 || binding.id > 0xffffffff) {
      invalid("packed functional key");
    }
  }
  validateQuickSlots(value.quickSlots);
  return value;
}

function validateQuickSlots(quickSlots) {
  if (!Array.isArray(quickSlots) || quickSlots.length !== 8) {
    invalid("quick slots");
  }
  const seen = new Set();
  for (const index of quickSlots) {
    integer(index, 0, "quick slot key");
    if (
      index > 88 ||
      index === 54 ||
      !isAssignableKey(index) ||
      seen.has(index)
    ) {
      invalid("quick slot key");
    }
    seen.add(index);
  }
}

/** Sequential migrations validate old root keys before adding only new domains. */
export function migrateProfile(value, items) {
  object(value, "root");
  if (value.schemaVersion === 7) return migrateVersionSeven(value, items);
  if (value.schemaVersion === 6) return migrateVersionSix(value, items);
  if (value.schemaVersion === 5) return migrateVersionFive(value, items);
  if (![1, 2, 3, 4].includes(value.schemaVersion)) {
    return validateProfile(value, items);
  }
  return migrateLegacyProfile(value, items);
}

/** Schemas one through four share the legacy item and settings representation. */
function migrateLegacyProfile(value, items) {
  const version = value.schemaVersion;
  keys(
    value,
    LEGACY_PROFILE_KEYS.slice(
      0,
      version === 1 ? -4 : version === 2 ? -3 : version === 3 ? -1 : undefined,
    ),
    "legacy root",
  );
  keys(
    value.settings,
    version < 3 ? ["BGM", "SE"] : ["BGM", "SE", "chat"],
    "legacy settings",
  );
  validateLegacyItems(value);
  // Validate pre-clone descriptors in every unrelated domain, not just the legacy root.
  const candidate = {
    ...value,
    schemaVersion: PROFILE_VERSION,
    inventory: [],
    equipment: [],
    inventorySlots: Array(5).fill(INVENTORY_POLICY.categorySlots),
    gender: 0,
    appearance: { skin: 0, face: 20000, hair: 30000 },
    baseMaxHP: value.maxHP,
    baseMaxMP: value.maxMP,
    keyBindings: version === 1 ? createDefaultBindings() : value.keyBindings,
    remainingSp: version < 3 ? Array(10).fill(0) : value.remainingSp,
    skills: version < 3 ? {} : value.skills,
    remainingAp: version < 4 ? 0 : value.remainingAp,
    cash: createCash(),
    monsterBook: { cards: {}, cover: 0 },
    skillMacros: createSkillMacros(),
    social: createSocial(),
    pets: [],
    mount: { level: 1, exp: 0, tiredness: 0 },
    savedLocations: createSavedLocations(),
    settings: {
      ...value.settings,
      chat: version < 3 ? { state: 1, height: 70 } : value.settings.chat,
      questTracker: { ids: [], auto: true, open: true },
      gameOptions: createGameOptions(),
      alerts: { hp: 10, mp: 10 },
    },
  };
  validateProfile(candidate);
  const migrated = structuredClone(candidate);
  migrateLegacyItems(value, migrated, items);
  return validateProfile(migrated, items);
}

function migrateVersionFive(value, items) {
  keys(value, VERSION_FIVE_KEYS, "schema5 root");
  const candidate = {
    ...value,
    schemaVersion: PROFILE_VERSION,
    pets: [],
    mount: { level: 1, exp: 0, tiredness: 0 },
    savedLocations: createSavedLocations(),
  };
  validateProfile(candidate, items);
  return structuredClone(candidate);
}

function migrateVersionSix(value, items) {
  keys(value, VERSION_SIX_KEYS, "schema6 root");
  const candidate = {
    ...value,
    schemaVersion: PROFILE_VERSION,
    savedLocations: createSavedLocations(),
  };
  validateProfile(candidate, items);
  return structuredClone(candidate);
}

/** Schema7 retained only the Free Market map; preserve it while adding native typed slots. */
function migrateVersionSeven(value, items) {
  keys(value, PROFILE_KEYS, "schema7 root");
  keys(value.savedLocations, ["freeMarket"], "schema7 saved locations");
  validateSavedMap(value.savedLocations.freeMarket, "FREE_MARKET");
  const candidate = {
    ...value,
    schemaVersion: PROFILE_VERSION,
    savedLocations: {
      ...createSavedLocations(),
      FREE_MARKET: value.savedLocations.freeMarket,
    },
  };
  validateProfile(candidate, items);
  return structuredClone(candidate);
}

function validateSavedLocations(value) {
  keys(value, SAVED_LOCATION_TYPES, "saved locations");
  for (const type of SAVED_LOCATION_TYPES) validateSavedMap(value[type], type);
}

function validateSavedMap(value, type) {
  if (value === null) return;
  integer(value, 0, `${type} saved map`);
  if (value > 999999998 || (type === "FREE_MARKET" && value === 910000000)) {
    invalid(`${type} saved map`);
  }
}

function validateLegacyItems(value) {
  if (
    !Array.isArray(value.inventory) ||
    value.inventory.length > PROFILE_LIMITS.inventory
  ) {
    invalid("legacy inventory");
  }
  if (
    !Array.isArray(value.equipment) ||
    value.equipment.length > PROFILE_LIMITS.equipment
  ) {
    invalid("legacy equipment");
  }
  const ids = new Set();
  for (const entry of value.inventory) {
    keys(entry, ["id", "count"], "legacy inventory");
    itemId(entry.id, "legacy item id");
    integer(entry.count, 1, "legacy item count");
    if (ids.has(entry.id)) invalid("duplicate legacy item id");
    ids.add(entry.id);
  }
  ids.clear();
  for (const id of value.equipment) {
    itemId(id, "legacy equipment id");
    if (ids.has(id)) invalid("duplicate legacy equipment id");
    ids.add(id);
  }
}

function baseInstance(id, count, slot) {
  return {
    uid: createItemUid(),
    id,
    count,
    slot,
    owner: "",
    flags: 0,
    expiresAt: null,
  };
}

function migrateLegacyItems(value, migrated, items) {
  const used = Array(5).fill(0);
  for (const entry of value.inventory) {
    const template = itemTemplate(items, entry.id);
    const type = inventoryType(entry.id),
      limit = itemStackLimit(template);
    const required = Math.ceil(entry.count / limit);
    if (migrated.inventory.length + required > PROFILE_LIMITS.inventory) {
      throw profileError(
        "migration-capacity",
        `Preserving legacy item ${entry.id} requires ${required} stacks beyond the 4096-record budget; the durable save is unchanged.`,
      );
    }
    let remaining = entry.count;
    for (let index = 0; index < required; index++) {
      const count = Math.min(limit, remaining);
      migrated.inventory.push(baseInstance(entry.id, count, ++used[type - 1]));
      remaining -= count;
    }
  }
  // Larger capacities are retained legacy browser capacity, not native expansion grants.
  for (let index = 0; index < 5; index++) {
    migrated.inventorySlots[index] = Math.max(
      INVENTORY_POLICY.categorySlots,
      used[index],
    );
  }
  const slots = new Set();
  for (const id of value.equipment) {
    const slot = equippedSlots(itemTemplate(items, id)).find(
      (candidate) => !slots.has(candidate),
    );
    if (slot === undefined) {
      throw profileError(
        "migration-equipped-slot",
        `Legacy equipped item ${id} has no unoccupied authored slot; the durable save is unchanged.`,
      );
    }
    slots.add(slot);
    migrated.equipment.push(baseInstance(id, 1, slot));
  }
}

/** Catalog maximum ranks are checked by the character/skill service boundary. */
function learnedSkills(value) {
  dictionary(value, PROFILE_LIMITS.skills, "skills");
  for (const [id, record] of Object.entries(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(id)) invalid("skill id");
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric > 0xffffffff) {
      invalid("skill id");
    }
    keys(record, ["level", "masterLevel", "expiresAt"], `skill ${id}`);
    integer(record.level, 0, "skill level");
    integer(record.masterLevel, 0, "skill masterLevel");
    if (record.expiresAt !== null) {
      integer(record.expiresAt, 0, "skill expiration");
    }
  }
}

function validateCharacterIdentity(value) {
  integer(value.gender, 0, "gender");
  if (value.gender > 1) invalid("gender");
  keys(value.appearance, ["skin", "face", "hair"], "appearance");
  for (const field of ["skin", "face", "hair"]) {
    integer(value.appearance[field], 0, `appearance ${field}`);
  }
  if (
    value.appearance.skin > 255 ||
    value.appearance.face > 99999 ||
    value.appearance.hair > 99999
  ) {
    invalid("appearance");
  }
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > PROFILE_LIMITS.name
  ) {
    invalid("name");
  }
}

/** Scalar character fields retain their existing validation order and numeric limits. */
function validateCharacterScalars(value) {
  validateCharacterIdentity(value);
  for (const key of [
    "level",
    "maxHP",
    "baseMaxHP",
    "str",
    "dex",
    "int",
    "luk",
  ]) {
    integer(value[key], 1, key);
  }
  if (value.level > PROGRESSION_POLICY.maxLevel) {
    invalid("level exceeds local progression");
  }
  for (const key of [
    "job",
    "exp",
    "meso",
    "hp",
    "mp",
    "maxMP",
    "baseMaxMP",
    "remainingAp",
  ]) {
    integer(value[key], 0, key);
  }
  integer(value.fame, Number.MIN_SAFE_INTEGER, "fame");
  if (value.hp > value.maxHP || value.mp > value.maxMP) {
    invalid("vitals exceed maximum");
  }
}

/** Validate all durable fields before accepting or cloning a checkpoint. */
export function validateProfile(value, items) {
  object(value, "root");
  if (value.schemaVersion !== PROFILE_VERSION) {
    const code =
      value.schemaVersion > PROFILE_VERSION
        ? "future-profile-version"
        : "migration-required";
    throw profileError(
      code,
      `Saved profile schema ${String(value.schemaVersion)} cannot be loaded as schema ${PROFILE_VERSION}; migration or an explicit reset is required.`,
    );
  }
  keys(value, PROFILE_KEYS, "root");
  validateCharacterScalars(value);
  learnedSkills(value.skills);
  inventory(value, items);
  validateCash(value.cash, (entry) => {
    itemRecord(entry);
    const template = validateItemMetadata(entry, items, false);
    if (items && template.info?.cash !== 1) {
      invalid("non-cash locker or gift item");
    }
  });
  validatePets(value);
  validateMount(value.mount);
  validateCharacterUids([value]);
  validateMonsterBook(value.monsterBook);
  validateSkillMacros(value.skillMacros);
  validateSocial(value.social);
  quests(value.quests);
  validateProfileLocation(value.location);
  validateSavedLocations(value.savedLocations);
  settings(value.settings);
  validateKeyBindings(value.keyBindings);
  if (!Array.isArray(value.remainingSp) || value.remainingSp.length !== 10) {
    invalid("remainingSp");
  }
  for (const points of value.remainingSp) integer(points, 0, "remainingSp");
  return value;
}

/** The envelope revision is independent of the gameplay schema and IDB physical version. */
export function validateProfileRecord(record, items) {
  keys(
    record,
    ["id", "generation", "revision", "createdAt", "updatedAt", "profile"],
    "envelope",
  );
  validateCharacterId(record.id);
  if (
    typeof record.generation !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.generation,
    )
  ) {
    invalid("generation");
  }
  integer(record.revision, 0, "revision");
  integer(record.createdAt, 0, "createdAt");
  integer(record.updatedAt, record.createdAt, "updatedAt");
  validateProfile(record.profile, items);
  validateSocialOwner(record.profile.social, record.id);
  return record;
}

export function validateCharacterId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    invalid("character id");
  }
  return id;
}

/** Explicit provisional beginner policy, not recovered original character grants. */
/** Created-character base vitals (createProfile below); recalculation starts here. */
export const STARTING_VITALS = Object.freeze({ hp: 50, mp: 30 });

export function createProfile(location) {
  if (!location) {
    throw profileError(
      "missing-bootstrap",
      "A validated packaged spawn is required to create or reset an offline profile.",
    );
  }
  validateProfileLocation(location);
  return {
    schemaVersion: PROFILE_VERSION,
    name: "Maple",
    // The existing packaged avatar identity; migration does not grant a new cosmetic style.
    gender: 0,
    appearance: { skin: 0, face: 20000, hair: 30000 },
    level: 1,
    job: 0,
    exp: 0,
    meso: 0,
    fame: 0,
    hp: STARTING_VITALS.hp,
    maxHP: STARTING_VITALS.hp,
    baseMaxHP: STARTING_VITALS.hp,
    mp: STARTING_VITALS.mp,
    maxMP: STARTING_VITALS.mp,
    baseMaxMP: STARTING_VITALS.mp,
    str: 12,
    dex: 5,
    int: 4,
    luk: 4,
    inventory: [],
    inventorySlots: Array(5).fill(INVENTORY_POLICY.categorySlots),
    // Original starter templates: coat Ma, pants Pn, shoes So, sword Wp.
    equipment: [
      [1040002, -5],
      [1060002, -6],
      [1072001, -7],
      [1302000, -11],
    ].map(([id, slot]) => baseInstance(id, 1, slot)),
    quests: {},
    location: { ...location },
    keyBindings: createDefaultBindings(),
    remainingSp: Array(10).fill(0),
    remainingAp: 0,
    skills: {},
    cash: createCash(),
    monsterBook: { cards: {}, cover: 0 },
    skillMacros: createSkillMacros(),
    social: createSocial(),
    pets: [],
    mount: { level: 1, exp: 0, tiredness: 0 },
    savedLocations: createSavedLocations(),
    settings: {
      BGM: { volume: 64, mute: false },
      SE: { volume: 64, mute: false },
      chat: { state: 1, height: 70 },
      questTracker: { ids: [], auto: true, open: true },
      gameOptions: createGameOptions(),
      alerts: { hp: 10, mp: 10 },
    },
  };
}
