import {
  consumeTemplate,
  grantItem,
  inventoryType,
  itemCount,
} from "../items/inventory-model.js";
import { validateProfile } from "../profile/profile-validation.js";
import { equipmentUpgrade } from "../items/equipment-enhancement.js";
import { SAVED_LOCATION_TYPES } from "../profile/profile-domains.js";
import { recalculateVitals } from "../character/character-stats.js";
import { jobAdvancementGrowthRange } from "../character/offline-progression.js";
import { skillPointPool } from "../skills/skill-allocation-rules.js";
import {
  NPC_RUNTIME_LIMITS as LIMITS,
  npcInteger,
  npcPrimitive,
  requireNpc,
} from "./npc-script-values.js";
import {
  NPC_ARTWORK_LIMITS,
  NPC_MARKUP_FAMILIES,
  NPC_MARKUP_TOKENS,
  npcMarkupId,
  validNpcArtworkPath,
} from "./npc-script-markup.js";

const QUEST_INFO_FIELDS = new Set([
  "name",
  "area",
  "parent",
  "order",
  "summary",
  "demandSummary",
  "rewardSummary",
  "type",
  "sortkey",
  "showLayerTag",
  "0",
  "1",
  "2",
]);
const MAX_QUEST_INVENTORY_ROWS = 200000;

export function npcLookup(table, id) {
  if (table instanceof Map) return table.get(id);
  return table && Object.hasOwn(table, id) ? table[id] : undefined;
}

export function npcDependency(context, family, id) {
  npcInteger(id, 1);
  requireNpc(
    context.dependencies[family].has(id),
    `NPC ${family} dependency ${id} is not closed`,
    "npc-dependency",
  );
  return id;
}

function originalName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LIMITS.textLength
  );
}

/** No missing table or fabricated renderer label is authority for an authored dependency. */
export function validateNpcEnvironment(context, environment) {
  requireNpc(
    environment.items &&
      environment.quests?.schemaVersion === 1 &&
      typeof environment.isCurrent === "function" &&
      typeof environment.isBusy === "function",
    "NPC environment lacks original catalogs or ownership guards",
    "npc-dependency",
  );
  validateEnvironmentOwner(context, environment);
  if (context.requirements.has("atomic-field-travel")) {
    requireNpc(
      typeof environment.prepareTravel === "function",
      "NPC field travel authority is unavailable",
      "npc-dependency",
    );
  }
  if (context.requirements.has("account-local-storage")) {
    requireNpc(
      environment.storageAvailable === true,
      "Account storage authority or original NPC fees are unavailable",
      "npc-dependency",
    );
  }
  validateCatalogDependencies(context.dependencies, environment);
  validateNameDependencies(context.dependencies, environment);
}

function validateEnvironmentOwner(context, environment) {
  if (environment.portal === undefined) {
    npcInteger(environment.npcId, 1);
    requireNpc(
      originalName(npcLookup(environment.names?.npc, environment.npcId)) &&
        npcLookup(environment.portraits, environment.npcId),
      "Interacting NPC name/portrait is not packaged",
      "npc-dependency",
    );
    return;
  }
  // A portal script has no interacting NPC; one authored portal owns it.
  requireNpc(
    environment.npcId === undefined &&
      /^[A-Za-z0-9_]{1,64}$/.test(environment.portal?.script) &&
      context.source?.path === `scripts/portal/${environment.portal.script}.js`,
    "Portal script environment differs from its authored source",
    "npc-dependency",
  );
}

function validateCatalogDependencies(dependencies, environment) {
  for (const id of dependencies.itemIds) {
    const template = npcLookup(environment.items, id);
    requireNpc(
      template?.id === id && template.descriptor,
      `Original item ${id} is unavailable`,
      "npc-dependency",
    );
  }
  for (const id of dependencies.questIds) {
    requireNpc(
      npcLookup(environment.quests.records, id)?.id === id,
      `Original quest ${id} is unavailable`,
      "npc-dependency",
    );
  }
  for (const id of dependencies.shopIds) {
    requireNpc(
      npcLookup(environment.shops, id),
      `Authored shop ${id} is unavailable`,
      "npc-dependency",
    );
  }
}

function validateNameDependencies(dependencies, environment) {
  for (const id of dependencies.npcIds) {
    requireNpc(
      originalName(npcLookup(environment.names?.npc, id)),
      `Original NPC name ${id} is unavailable`,
      "npc-dependency",
    );
  }
  for (const id of dependencies.mobIds) {
    requireNpc(
      originalName(npcLookup(environment.names?.mob, id)),
      `Original monster name ${id} is unavailable`,
      "npc-dependency",
    );
  }
  for (const id of dependencies.mapIds) {
    requireNpc(
      originalName(npcLookup(environment.mapNames, id)),
      `Original map name ${id} is unavailable`,
      "npc-dependency",
    );
  }
}

function compatibleQuestInfo(record) {
  requireNpc(
    record.info && typeof record.info === "object",
    "Force quest definition has no original metadata",
    "npc-quest-definition",
  );
  requireNpc(
    Array.isArray(record.stages) && record.stages.length === 2,
    "Force quest has no complete stage projection",
    "npc-quest-definition",
  );
  for (const stage of record.stages) {
    requireNpc(
      Array.isArray(stage.check?.mobs) &&
        stage.check.mobs.length <= LIMITS.variables,
      "Force quest mob progress exceeds its bound",
      "npc-quest-definition",
    );
  }
  const fields = Object.keys(record.info);
  requireNpc(
    fields.length <= LIMITS.variables,
    "Quest metadata exceeds its bound",
    "npc-quest-definition",
  );
  for (const field of fields) {
    if (QUEST_INFO_FIELDS.has(field)) continue;
    if (
      ["timeLimit", "timeLimit2"].includes(field) &&
      record.info[field] === 0
    ) {
      continue;
    }
    requireNpc(
      false,
      `Force quest requires unsupported metadata: ${field}`,
      "npc-quest-definition",
    );
  }
  // Quest.forceStart has server-configured Temple of Time progress for the entire 35xx family.
  requireNpc(
    Math.trunc(record.id / 100) !== 35,
    "Force quest requires server-specific progress",
    "npc-quest-definition",
  );
}

/** Force transitions bypass Check/Act gates/rewards, but not unavailable progress state. */
export function admitNpcForceQuests(context, environment) {
  if (!context.forceQuests) return;
  const rows = environment.quests.inventory?.Check?.rows;
  requireNpc(
    Array.isArray(rows) && rows.length <= MAX_QUEST_INVENTORY_ROWS,
    "Force quest requires the complete original Check inventory",
    "npc-quest-definition",
  );
  const seen = new Set();
  for (const id of context.forceQuestIds) {
    compatibleQuestInfo(npcLookup(environment.quests.records, id));
  }
  for (const row of rows) {
    requireNpc(
      typeof row.path === "string" && row.path.length <= 4096,
      "Invalid original quest inventory",
      "npc-quest-definition",
    );
    const parts = row.path.split("/"),
      id = Number(parts[0]);
    if (!context.forceQuestIds.has(id)) continue;
    seen.add(id);
    const field = parts.slice(2).join("/");
    if (parts.length <= 2) continue;
    const supported = supportedForceQuestField(field);
    requireNpc(
      supported,
      `Force quest requires unsupported progress/control: ${row.path}`,
      "npc-quest-definition",
    );
  }
  for (const id of context.forceQuestIds) {
    requireNpc(
      seen.has(id),
      "Force quest Check definition is missing",
      "npc-quest-definition",
    );
  }
}

function supportedForceQuestField(field) {
  // Scalar conditions and scripted entrypoint names are not executed by forceStart/Complete.
  return (
    /^(npc|lvmin|lvmax|pop|endmeso|startscript|endscript)$/.test(field) ||
    /^job(?:\/\d+)?$/.test(field) ||
    /^(item|mob)(?:\/\d+(?:\/(id|count))?)?$/.test(field) ||
    /^quest(?:\/\d+(?:\/(id|state))?)?$/.test(field)
  );
}

function validateMarkupName(environment, code, id) {
  let value;
  if (["t", "z"].includes(code)) value = npcLookup(environment.names?.item, id);
  else if (code === "u") {
    value = npcLookup(environment.quests.records, id)?.name;
  } else return;
  requireNpc(
    originalName(value),
    "Rendered NPC markup has no original name",
    "npc-dependency",
  );
}

function validateImageSize(width, height) {
  requireNpc(
    Number.isSafeInteger(width) &&
      width > 0 &&
      Number.isSafeInteger(height) &&
      height > 0 &&
      width <= NPC_ARTWORK_LIMITS.pixels / height,
    "Rendered NPC artwork exceeds pixel policy or lacks original dimensions",
    "npc-dependency",
  );
}

function validateMarkupImage(token, context, environment) {
  const code = token[1];
  if (code === "i" || code === "v") {
    if (!/^#[iv]\d+:?#$/.test(token)) return false;
    validateMarkupItemImage(token, environment);
  } else if (code === "f" || code === "F") {
    validateMarkupArtwork(token, context, environment);
  } else return false;
  return true;
}

function validateMarkupItemImage(token, environment) {
  const end = token.endsWith(":#") ? -2 : -1;
  const item = npcLookup(environment.items, Number(token.slice(2, end)));
  requireNpc(
    item?.descriptor &&
      typeof item.iconPath === "string" &&
      item.iconPath.length > 0,
    "Rendered NPC item icon is unavailable",
    "npc-dependency",
  );
  validateImageSize(item.iconWidth, item.iconHeight);
}

function validateMarkupArtwork(token, context, environment) {
  const path = token.slice(2, -1),
    row = npcLookup(environment.artworkMetadata, path);
  requireNpc(
    validNpcArtworkPath(path) &&
      context.dependencies.artworkPaths.has(path) &&
      environment.artwork instanceof Set &&
      environment.artwork.has(path) &&
      row?.descriptor &&
      typeof row.path === "string" &&
      row.path.length > 0,
    "Rendered NPC artwork is outside declared packaged closure",
    "npc-dependency",
  );
  validateImageSize(row.width, row.height);
}

/** Scan the rendered result, not just literals: dynamic concatenation cannot escape closure. */
export function validateNpcMarkup(text, context, environment) {
  requireNpc(
    typeof text === "string" && text.length <= LIMITS.textLength,
    "Invalid NPC authored text",
    "npc-value",
  );
  let images = 0;
  for (const match of text.matchAll(NPC_MARKUP_TOKENS)) {
    const token = match[0],
      code = token[1],
      family = NPC_MARKUP_FAMILIES[code];
    if (family) {
      const encoded = npcInteger(Number(token.match(/\d+/)[0]), 1),
        id = npcMarkupId(code, encoded);
      npcDependency(context, family, id);
      validateMarkupName(environment, code, id);
      if (code === "a") {
        const index = (encoded % 10) - 1;
        requireNpc(
          index >= 0 &&
            npcLookup(environment.quests.records, id)?.stages[1]?.check.mobs[
              index
            ],
          "Rendered NPC quest-progress token has no original target",
          "npc-dependency",
        );
      }
    }
    if (validateMarkupImage(token, context, environment)) {
      requireNpc(
        ++images <= NPC_ARTWORK_LIMITS.images,
        "Rendered NPC artwork count exceeds policy",
        "npc-dependency",
      );
    }
  }
}

function itemTemplate(turn, id) {
  npcDependency(turn.context, "itemIds", id);
  const template = npcLookup(turn.environment.items, id);
  requireNpc(
    template?.id === id && template.descriptor,
    "Original NPC item template is unavailable",
    "npc-dependency",
  );
  return template;
}

function canHold(turn, id, count) {
  const template = itemTemplate(turn, id);
  npcInteger(count, 1, 32767);
  const draft = structuredClone(turn.profile);
  try {
    grantItem(draft, template, count);
    return true;
  } catch (error) {
    if (["inventory-full", "unique-item"].includes(error.code)) return false;
    throw error;
  }
}

/** AbstractPlayerInteraction.java:253–277: probe all grants together, not one free slot twice. */
function canHoldAll(turn, args) {
  const ids = args[0],
    quantities = args[1];
  requireNpc(
    Array.isArray(ids) && ids.length <= LIMITS.arrayLength,
    "NPC canHoldAll requires a bounded item array",
    "npc-value",
  );
  requireNpc(
    quantities === undefined ||
      (Array.isArray(quantities) && quantities.length <= LIMITS.arrayLength),
    "NPC canHoldAll requires a bounded quantity array",
    "npc-value",
  );
  const count = quantities
    ? Math.min(ids.length, quantities.length)
    : ids.length;
  const draft = structuredClone(turn.profile);
  try {
    for (let index = 0; index < count; index++) {
      grantItem(
        draft,
        itemTemplate(turn, ids[index]),
        npcInteger(quantities ? quantities[index] : 1, 1, 32767),
      );
    }
    return true;
  } catch (error) {
    if (["inventory-full", "unique-item"].includes(error.code)) return false;
    throw error;
  }
}

// SERVER reference AbstractPlayerInteraction.java:1149–1191. Not recovered Nexon rules.
const FIRST_JOB_STATS = Object.freeze([
  null,
  ["str", 35],
  ["int", 20],
  ["dex", 25],
  ["dex", 25],
  ["dex", 20],
]);
const HALL_OF_FAME_MAPS = Object.freeze([
  130000110, 102000004, 101000004, 100000204, 103000008, 120000105,
]);

function firstJobRead(turn, kind, args) {
  const type = npcInteger(args[0]),
    spec = FIRST_JOB_STATS[type];
  if (kind === "first-job-stat-requirement") {
    return spec ? `${spec[0].toUpperCase()} ${spec[1]}` : null;
  }
  requireNpc(
    typeof args[1] === "boolean",
    "NPC starter AP policy is not boolean",
    "npc-value",
  );
  return args[1] || !spec || turn.profile[spec[0]] >= spec[1];
}

/** GameConstants.java:428–449,485–508 and MapId.java:255–264, explicit pure enum dispatch. */
function gameConstantRead(kind, value) {
  const job = npcInteger(value, 0, 32767);
  const cygnus = Math.trunc(job / 1000) === 1;
  const aran = job === 2000 || (job >= 2100 && job <= 2112);
  switch (kind) {
    case "skill-book":
      return skillPointPool(job);
    case "is-cygnus":
      return cygnus;
    case "is-aran":
      return aran;
    case "hall-of-fame-map":
      if (cygnus) return 130000100;
      if (aran) return 140010110;
      return HALL_OF_FAME_MAPS[Math.trunc(job / 100)] ?? HALL_OF_FAME_MAPS[0];
    default:
      requireNpc(false, "Unknown pure NPC job read");
  }
}

function parseInteger(args) {
  const value = npcPrimitive(args[0]);
  const radix = args.length === 2 ? npcInteger(args[1]) : 0;
  requireNpc(
    radix === 0 || (radix >= 2 && radix <= 36),
    "Invalid NPC parseInt radix",
    "npc-value",
  );
  return npcInteger(Number.parseInt(String(value), radix));
}

// Cosmic MapleMap.java4308-4337: explicit source sets, not guessed map-name ranges.
const CPQ_WINNER_MAPS = new Set([
  980000103, 980000203, 980000303, 980000403, 980000503, 980000603, 980031300,
  980032300, 980033300,
]);
const CPQ_LOSER_MAPS = new Set([
  980000104, 980000204, 980000304, 980000404, 980000504, 980000604, 980031400,
  980032400, 980033400,
]);

export function readNpcLocal(turn, kind, args) {
  const profile = turn.profile;
  switch (kind) {
    case "is-gm":
      // Offline profiles carry no server privilege authority.
      return false;
    case "cpq-winner-map":
      return CPQ_WINNER_MAPS.has(Number(profile.location.mapId));
    case "cpq-loser-map":
      return CPQ_LOSER_MAPS.has(Number(profile.location.mapId));
    case "map-id":
      return npcInteger(Number(profile.location.mapId), 0);
    case "number-with-commas":
      return String(npcInteger(args[0])).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    case "saved-location-peek":
    case "saved-location-take":
      return readSavedLocation(turn, kind, args[0]);
    case "event-manager":
    case "event-property":
      return readEventManager(turn, kind, args);
    default:
      return readNpcPure(turn, kind, args);
  }
}

/** Server-published EventManager properties; an absent manager is Cosmic's null. */
function readEventManager(turn, kind, args) {
  const events = turn.environment.events ?? {};
  const known = typeof args[0] === "string" && Object.hasOwn(events, args[0]);
  if (kind === "event-manager") return known ? args[0] : null;
  requireNpc(
    known && Object.hasOwn(events[args[0]], args[1]),
    "Event manager property is unavailable",
    "npc-dependency",
  );
  return events[args[0]][args[1]];
}

function readNpcPure(turn, kind, args) {
  switch (kind) {
    case "parse-int":
      return parseInteger(args);
    case "hall-of-fame-map":
    case "skill-book":
    case "is-cygnus":
    case "is-aran":
      return gameConstantRead(kind, args[0]);
    case "first-job-stat-requirement":
    case "can-get-first-job":
      return firstJobRead(turn, kind, args);
    case "can-hold-all":
      return canHoldAll(turn, args);
    default:
      return readPlayerState(turn, kind, args);
  }
}

function readPlayerState(turn, kind, args) {
  const profile = turn.profile;
  switch (kind) {
    case "crafting-scroll":
      return turn.craftingScroll;
    case "meso":
      return profile.meso;
    case "level":
      return profile.level;
    case "job":
      return profile.job;
    case "input-text":
      return turn.inputText;
    default:
      return readQuestOrInventoryState(turn, kind, args);
  }
}

function readQuestOrInventoryState(turn, kind, args) {
  switch (kind) {
    case "quest-state":
    case "quest-completed":
    case "quest-started":
      return readQuestState(turn, kind, args[0]);
    default:
      return readInventoryState(turn, kind, args);
  }
}

function readInventoryState(turn, kind, args) {
  const profile = turn.profile;
  switch (kind) {
    case "item-count":
      itemTemplate(turn, args[0]);
      return itemCount(profile, args[0]);
    case "have-item":
      itemTemplate(turn, args[0]);
      return (
        itemCount(profile, args[0]) >=
        npcInteger(args.length === 2 ? args[1] : 1)
      );
    case "can-hold":
      return canHold(turn, args[0], args.length === 2 ? args[1] : 1);
    default:
      requireNpc(false, "Unknown NPC read");
  }
}

function readQuestState(turn, kind, questId) {
  const id = npcDependency(turn.context, "questIds", questId),
    state = turn.profile.quests[id]?.state ?? 0;
  return kind === "quest-state"
    ? state
    : state === (kind === "quest-completed" ? 2 : 1);
}

/** Character.java5839-5850: get consumes the slot; peek leaves it intact. */
function readSavedLocation(turn, kind, type) {
  requireNpc(
    SAVED_LOCATION_TYPES.includes(type),
    "Invalid saved location type",
  );
  const saved = turn.profile.savedLocations[type];
  if (saved === null) return -1;
  const mapId = npcInteger(saved, 0);
  requireNpc(
    turn.context.dependencies.mapIds.has(mapId) ||
      turn.context.dependencies.mapIds.size < LIMITS.dependencies,
    "NPC saved return dependency budget exceeded",
    "npc-budget",
  );
  turn.context.dependencies.mapIds.add(mapId);
  if (kind === "saved-location-take") {
    turn.environment.recordEffect?.({ kind, type, mapId }, []);
    turn.profile.savedLocations[type] = null;
    turn.effects.push({ kind: "saved-location-take", type, mapId });
  }
  return mapId;
}

/** The exposed Character API retains map authority; its unused portal metadata is not persisted. */
function saveLocation(turn, type) {
  requireNpc(
    SAVED_LOCATION_TYPES.includes(type),
    "Invalid saved location type",
  );
  const mapId = npcInteger(Number(turn.profile.location.mapId), 0);
  turn.profile.savedLocations[type] = mapId;
  turn.effects.push({ kind: "save-location", type, mapId });
}

/** API gainItem overloads564-585 have randomStats=false. Supplied config.yaml340
 * disables enhanced crafting; a release requiring it is refused by conversion. */
function grantedItemAttributes(turn, template) {
  if (inventoryType(template.id) !== 1) return {};
  requireNpc(
    turn.context.requirements.has(
      "equipment-grants:original-template-no-enhanced-crafting",
    ),
    "NPC equipment creation policy is unavailable",
    "npc-dependency",
  );
  const upgrade = equipmentUpgrade({}, template);
  // API625-626 and ItemConstants.isAccessory127-129.
  if (template.id >= 1110000 && template.id < 1140000 && upgrade.slots <= 0) {
    upgrade.slots = 3;
  }
  // setCS is retained for its entire conversation but supplied policy does not
  // apply Chaos. No random roll, bonus slot, or cash mutation is invented.
  return { upgrade };
}

function itemEffect(turn, node, args) {
  const id = args[0],
    template = itemTemplate(turn, id);
  const count = npcInteger(
    node.overload === "id-show" || args.length === 1 ? 1 : args[1],
    -32768,
    32767,
  );
  const show =
    node.overload === "id-show" ? args[1] : args.length === 3 ? args[2] : true;
  requireNpc(
    typeof show === "boolean",
    "NPC item show flag is not boolean",
    "npc-value",
  );
  if (count >= 0) {
    requireNpc(
      inventoryType(id) !== 1 || count === 1,
      "NPC equipment creation requires exactly one instance",
      "npc-value",
    );
    requireNpc(
      !(id >= 5000000 && id <= 5000999),
      "NPC pet generation requires external instance authority",
      "npc-dependency",
    );
  }
  if (count > 0) {
    grantItem(
      turn.profile,
      template,
      count,
      grantedItemAttributes(turn, template),
    );
  }
  if (count < 0) consumeTemplate(turn.profile, id, -count);
  turn.effects.push({ kind: "item", itemId: id, delta: count, show });
}

function questEffect(turn, node, args) {
  const id = npcDependency(turn.context, "questIds", args[0]);
  const npcId =
    args.length === 2
      ? npcDependency(turn.context, "npcIds", args[1])
      : turn.environment.npcId;
  const previous = turn.profile.quests[id],
    state = node.kind === "quest-start" ? 1 : 2;
  // SERVER Quest.java:371-418 preserves ordinary mob progress on forceStart,
  // creates a fresh completed status on forceComplete, and never executes WZ Act.
  const kills = questKills(turn, id, state, previous);
  const next = { state, kills };
  if (state === 2) next.completedAt = turn.now;
  turn.profile.quests[id] = next;
  turn.effects.push({
    kind: node.kind,
    questId: id,
    npcId,
    previousState: previous?.state ?? 0,
    state,
    ...(state === 2 ? { completedAt: turn.now } : {}),
  });
}

function questKills(turn, id, state, previous) {
  const kills = state === 1 ? { ...(previous?.kills ?? {}) } : {};
  if (state === 1) {
    const record = npcLookup(turn.environment.quests.records, id);
    for (const stage of record.stages) {
      for (const mob of stage.check.mobs) {
        if (!Object.hasOwn(kills, mob.id)) kills[mob.id] = 0;
      }
    }
  }
  return kills;
}

/** SERVER Character.java:1365-1388 distinguishes random spawn from an explicit portal. */
function warpEffect(turn, args) {
  const mapId = npcDependency(turn.context, "mapIds", args[0]);
  const destination =
    args.length === 1
      ? { kind: "warp", mapId, randomSpawn: true }
      : { kind: "warp", mapId, portal: authoredPortal(args[1]) };
  requireNpc(
    !turn.effects.some((effect) => effect.kind === "warp"),
    "An NPC turn may prepare only one field transition",
    "npc-travel",
  );
  turn.effects.push(destination);
  // Native changeMap is synchronous: later reads/saves see the new map, not its old coordinates.
  // This is the detached turn draft; prepared field coordinates publish only after durable commit.
  turn.profile.location.mapId = String(mapId).padStart(9, "0");
}

function authoredPortal(portal) {
  if (typeof portal === "number") return npcInteger(portal, 0);
  requireNpc(
    typeof portal === "string" && portal.length > 0 && portal.length <= 128,
    "Invalid authored NPC destination portal",
    "npc-value",
  );
  return portal;
}

/** Character.java:1141–1259; first explorer advancement only, server-reference/offline authority. */
function jobEffect(turn, args) {
  const profile = turn.profile,
    job = npcInteger(args[0], 0, 32767);
  requireNpc(
    [100, 200, 300, 400, 500].includes(job),
    "This advancement requires unavailable advanced-job authority",
    "npc-dependency",
  );
  requireNpc(
    profile.job === 0 && profile.level >= (job === 200 ? 8 : 10),
    "First job advancement requires an eligible beginner",
    "npc-job",
  );
  requireNpc(
    typeof args[1] === "boolean",
    "Invalid starting AP policy",
    "npc-value",
  );
  profile.job = job;
  profile.remainingSp[skillPointPool(job)] = npcInteger(
    profile.remainingSp[skillPointPool(job)] + 1,
    0,
  );
  if (args[1]) profile.remainingAp = npcInteger(profile.remainingAp + 4, 0);
  // Character.gainSlotsInternal:9157–9191 refuses an entire +4 above96; legacy saves are retained.
  for (let category = 0; category < 4; category++) {
    if (profile.inventorySlots[category] + 4 <= 96) {
      profile.inventorySlots[category] += 4;
    }
  }
  const growth = jobAdvancementGrowthRange(job);
  const hp = growth.hp[1] === 0 ? 0 : randomInclusive(turn, ...growth.hp);
  const mp = growth.mp[1] === 0 ? 0 : randomInclusive(turn, ...growth.mp);
  profile.baseMaxHP = Math.min(30000, profile.baseMaxHP + hp);
  profile.baseMaxMP = Math.min(30000, profile.baseMaxMP + mp);
  recalculateVitals(profile, turn.environment.items);
  turn.effects.push({ kind: "job", job, hp, mp });
}

function randomInclusive(turn, minimum, maximum) {
  const sample = (turn.environment.random ?? Math.random)();
  requireNpc(
    Number.isFinite(sample) && sample >= 0 && sample < 1,
    "Invalid NPC random sample",
  );
  return minimum + Math.floor(sample * (maximum - minimum + 1));
}

/** Character.resetStats:7914–7964 conserves total AP and restores first-job SP entitlement. */
function resetStatsEffect(turn, enabled) {
  requireNpc(
    typeof enabled === "boolean",
    "Invalid starter AP policy",
    "npc-value",
  );
  if (!enabled) return; // The authored API explicitly disables this mutation with autoassign off.
  const profile = turn.profile,
    type = profile.job / 100;
  requireNpc(
    Number.isInteger(type) && type >= 1 && type <= 5,
    "Stat reset requires supported first-job authority",
    "npc-dependency",
  );
  const spec = FIRST_JOB_STATS[type];
  const total =
    profile.remainingAp + profile.str + profile.dex + profile.int + profile.luk;
  const remaining = total - (12 + spec[1]);
  requireNpc(
    remaining >= 0,
    "Starter AP total cannot cover first-job prerequisites",
    "npc-job",
  );
  profile.str = profile.dex = profile.int = profile.luk = 4;
  profile[spec[0]] = spec[1];
  profile.remainingAp = npcInteger(remaining, 0);
  profile.remainingSp[skillPointPool(profile.job)] = npcInteger(
    1 + (profile.level - (type === 2 ? 8 : 10)) * 3,
    0,
  );
  recalculateVitals(profile, turn.environment.items);
  turn.effects.push({ kind: "reset-stats", job: profile.job });
}

export function applyNpcEffect(turn, node, args) {
  turn.environment.recordEffect?.(node, args);
  if (node.kind === "item") itemEffect(turn, node, args);
  else if (node.kind === "job") jobEffect(turn, args);
  else if (node.kind === "reset-stats") resetStatsEffect(turn, args[0]);
  else if (node.kind === "warp") warpEffect(turn, args);
  else if (node.kind === "portal-sound") {
    // PortalPlayerInteraction.playPortalSound: presentation only, no profile change.
    turn.effects.push({ kind: "portal-sound" });
  } else if (node.kind === "save-location") saveLocation(turn, args[0]);
  else if (node.kind === "crafting-scroll") {
    requireNpc(
      args.length === 1 && typeof args[0] === "boolean",
      "NPC setCS requires exactly one boolean argument",
      "npc-value",
    );
    // Character.java:344,589-595. Session-local; never write this flag into a save.
    turn.craftingScroll = args[0];
  } else if (node.kind === "meso") {
    const delta = npcInteger(args[0]),
      balance = npcInteger(turn.profile.meso + delta, 0);
    turn.profile.meso = balance;
    turn.effects.push({ kind: "meso", delta, balance });
  } else questEffect(turn, node, args);
}

/** Structured cloning drops property descriptors; restore VM-owned array immutability on receipt. */
export function restoreNpcGlobals(globals) {
  validateSessionValues(globals, true);
}

function validateSessionValues(globals, restore = false) {
  const queue = [],
    depths = new Map();
  let characters = 0;
  const values = Object.values(globals);
  requireNpc(
    values.length <= LIMITS.variables,
    "NPC retained variable count exceeded",
    "npc-budget",
  );
  for (const value of values) queue.push({ value, depth: 0 });
  for (let index = 0; index < queue.length; index++) {
    requireNpc(
      queue.length <= LIMITS.analysisSteps,
      "NPC retained variable budget exceeded",
      "npc-budget",
    );
    const { value, depth } = queue[index];
    requireNpc(
      depth <= LIMITS.depth,
      "NPC retained array depth exceeded",
      "npc-budget",
    );
    if (typeof value === "string") characters += value.length;
    requireNpc(
      characters <= LIMITS.sourceBytes * 16,
      "NPC retained text budget exceeded",
      "npc-budget",
    );
    if (!Array.isArray(value)) continue;
    requireNpc(
      value.length <= LIMITS.arrayLength,
      "NPC array length exceeded",
      "npc-budget",
    );
    if (restore) Object.freeze(value);
    requireNpc(
      Object.isFrozen(value),
      "NPC array is not immutable and bounded",
    );
    if ((depths.get(value) ?? -1) >= depth) continue;
    depths.set(value, depth);
    for (const child of value) queue.push({ value: child, depth: depth + 1 });
  }
}
export function validateNpcDraft(turn) {
  validateNpcEnvironment(turn.context, turn.environment);
  validateProfile(turn.profile, turn.environment.items);
  validateSessionValues(turn.globals);
  requireNpc(
    turn.effects.length <= LIMITS.stepsPerTurn,
    "NPC effect budget exceeded",
  );
  if (turn.view?.text !== undefined) {
    validateNpcMarkup(turn.view.text, turn.context, turn.environment);
  }
}
