import { EXPRESSION_NAMES } from "../input/character-bindings.js";

/** Browser engineering limits, not recovered game constants. */
export const LIMITS = Object.freeze({
  fetches: 4,
  decodes: 2,
  queue: 256,
  resourceBytes: 32 * 1024 * 1024,
  gpuBytes: 192 * 1024 * 1024,
  cpuBytes: 192 * 1024 * 1024,
  cacheBytes: 4 * 1024 * 1024 * 1024,
  cacheEntries: 32768,
  uploadBytes: 16 * 1024 * 1024,
  uploadMs: 4,
  // Release map count; v83 Map.wz holds ~2.5k field images, so this covers the whole world.
  maps: 4096,
  mapNames: 16384,
  uiTemplates: 32768,
  uiArtwork: 8192,
  regions: 4096,
  textures: 65536,
  entities: 8192,
  actions: 128,
  frames: 4096,
  parts: 4096,
  sprites: 65536,
  atlasSide: 2048,
});
const FACE_EXPRESSIONS = new Set(["default", ...EXPRESSION_NAMES]);

/** Reject corrupt boundaries before allocating renderer resources. */
export function finite(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Nonfinite asset coordinate");
  }
}
export function bounds(value) {
  if (!value) throw new Error("Missing bounds");
  for (const key of ["left", "top", "right", "bottom"]) finite(value[key]);
  if (value.right <= value.left || value.bottom <= value.top) {
    throw new Error("Unordered bounds");
  }
}
export function entries(value, limit) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object dictionary");
  }
  const result = Object.entries(value);
  if (result.length > limit) {
    throw new Error("Dictionary exceeds resource limit");
  }
  return result;
}
export function array(value, limit) {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("Invalid bounded array");
  }
  return value;
}
export function resource(info) {
  if (
    !info ||
    !resourceURL(info.url) ||
    !/^[a-f0-9]{64}$/.test(info.sha256) ||
    !Number.isInteger(info.bytes) ||
    info.bytes <= 0 ||
    info.bytes > LIMITS.resourceBytes
  ) {
    throw new Error("Invalid content-addressed resource");
  }
}

function resourceURL(url) {
  return (
    typeof url === "string" &&
    (/^\/generated\/[a-zA-Z0-9/_.-]+$/.test(url) ||
      /^\/api\/v1\/world-content\/(catalog|resources)\/[a-f0-9]{64}$/.test(
        url,
      ) ||
      /^\/api\/v1\/custom-content\/images\/[a-f0-9]{64}$/.test(url) ||
      /^\/api\/v1\/custom-content\/regions\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/[1-9]\d{0,4}\/[a-f0-9]{64}$/.test(
        url,
      ))
  );
}
export function catalog(value) {
  if (value?.schemaVersion !== 2 || typeof value.buildId !== "string") {
    throw new Error("Catalog version must be 2");
  }
  mapNames(value.mapNames);
  for (const [, map] of entries(value.maps, LIMITS.maps)) {
    resource(map);
    array(map.neighbors, LIMITS.maps);
    for (const id of map.neighbors) {
      if (typeof id !== "string") throw new Error("Invalid neighbor ID");
    }
  }
  if (!Object.hasOwn(value.maps, value.defaultMap)) {
    throw new Error("Default map unavailable");
  }
  if (value.originalSources !== undefined) resource(value.originalSources);
  if (value.ui !== undefined) uiCatalog(value.ui);
  if (value.monsters !== undefined) monsterCatalog(value.monsters, value.maps);
  if (value.spawns !== undefined) spawnCatalog(value.spawns, value.maps);
  return value;
}

/** Index only authored templates available in the selected immutable map closure. */
function monsterCatalog(monsters, maps) {
  for (const [id, monster] of entries(monsters, LIMITS.uiArtwork)) {
    if (
      !Number.isSafeInteger(monster.id) ||
      monster.id <= 0 ||
      String(monster.id) !== id ||
      monster.template !== `mob:${String(monster.id).padStart(7, "0")}` ||
      typeof monster.name !== "string" ||
      monster.name.length > 4096 ||
      !Object.hasOwn(maps, monster.mapId)
    ) {
      throw new Error("Invalid development monster catalog entry");
    }
  }
}

/** Spawn placements reference maps inside the selected closure; counts stay small integers. */
function spawnCatalog(spawns, maps) {
  if (spawns?.schemaVersion !== 1) {
    throw new Error("Unsupported spawn catalog version");
  }
  for (const [id, rows] of entries(spawns.mobs, LIMITS.uiArtwork)) {
    if (!/^[1-9]\d{0,8}$/.test(id)) {
      throw new Error("Invalid spawn monster identity");
    }
    for (const row of array(rows, LIMITS.maps)) {
      if (
        typeof row.mapId !== "string" ||
        !Object.hasOwn(maps, row.mapId) ||
        !Number.isSafeInteger(row.count) ||
        row.count < 1
      ) {
        throw new Error("Invalid spawn map entry");
      }
    }
  }
}

function mapNames(names) {
  for (const [id, name] of entries(names, LIMITS.mapNames)) {
    if (
      !/^(0|[1-9]\d{0,8})$/.test(id) ||
      typeof name !== "string" ||
      name.length > 4096
    ) {
      throw new Error("Invalid original map name");
    }
  }
}

/** Validate lazy visual references without downloading or decoding their artwork. */
function visualReferences(value, maximum) {
  for (const [, record] of entries(value, maximum)) {
    if (record.available === false) {
      if (typeof record.reason !== "string" || !record.reason.length) {
        throw new Error(
          "Unavailable artwork requires its original-source reason",
        );
      }
    } else resource(record.descriptor);
  }
}

function uiCatalog(ui) {
  if (ui?.schemaVersion !== 1) {
    throw new Error("Unsupported UI catalog version");
  }
  for (const [, descriptor] of entries(ui.bundles, 128)) resource(descriptor);
  visualReferences(ui.minimaps, LIMITS.maps);
  itemCatalog(ui.items);
  visualReferences(ui.skills, LIMITS.uiArtwork);
  visualReferences(ui.npcPortraits, LIMITS.uiArtwork);
  npcWorldCatalog(ui.npcWorld);
  skillWorldCatalog(ui.skillWorld);
  skillUtilityCatalog(ui.skillUtility);
  skillCombatCatalog(ui.skillCombat);
  dialogArtwork(ui.dialogArtwork);
  avatarCatalog(ui.avatar);
  cashCatalog(ui.cashShop);
  monsterBookCatalog(ui.monsterBook);
  nativeRules(ui);
  if (
    !ui.bundles.Quest ||
    !ui.bundles.CashShop ||
    !ui.bundles.MonsterBook ||
    !ui.bundles.SkillMacro ||
    !ui.bundles.Trunk ||
    !ui.bundles.EnchantSkill
  ) {
    throw new Error("Native UI bundle dependency is absent");
  }
}

function npcWorldCatalog(world) {
  resource(world?.markers);
  resource(world?.speech?.bundle);
  if (!Number.isInteger(world?.speech?.color)) {
    throw new Error("Invalid original NPC speech color");
  }
}

function skillWorldCatalog(world) {
  for (const [, form] of entries(world?.forms, LIMITS.uiTemplates)) {
    resource(form.bundle);
    for (const key of ["speed", "jump", "fs", "swim"]) finite(form[key]);
  }
  for (const [, effect] of entries(world?.effects, LIMITS.uiArtwork)) {
    resource(effect.bundle);
  }
  skillRidingCatalog(world.riding);
  skillDoorCatalog(world.maps);
}

function skillRidingCatalog(riding) {
  for (const [, mount] of entries(riding?.mounts, 256)) {
    resource(mount.bundle);
    if (mount.templateId === null) continue;
    for (const key of ["speed", "jump", "fs", "swim", "fatigue"]) {
      finite(mount[key]);
    }
  }
  for (const [, saddle] of entries(riding?.saddles, 256)) {
    for (const [, bank] of entries(saddle, 256)) resource(bank.bundle);
  }
  finite(riding.riderAnchor.x);
  finite(riding.riderAnchor.y);
}

function skillDoorCatalog(maps) {
  for (const [id, map] of entries(maps, LIMITS.maps)) {
    if (!/^\d{9}$/.test(id) || !/^\d{9}$/.test(map.returnMap)) {
      throw new Error("Invalid native skill-door map identity");
    }
    if (!Number.isSafeInteger(map.fieldLimit) || map.fieldLimit < 0) {
      throw new Error("Invalid native field restriction mask");
    }
    for (const door of array(map.doors, LIMITS.entities)) {
      finite(door.x);
      finite(door.y);
      if (!Number.isSafeInteger(door.id) || typeof door.name !== "string") {
        throw new Error("Invalid native town-door portal");
      }
    }
  }
}

function skillUtilityCatalog(utility) {
  for (const [id, pet] of entries(utility?.pets, LIMITS.uiTemplates)) {
    if (!/^500\d{4}$/.test(id)) {
      throw new Error("Invalid original pet identity");
    }
    resource(pet.bundle);
  }
}

function skillCombatCatalog(combat) {
  for (const [id, ranks] of entries(combat?.mobSkills, 256)) {
    if (!/^[1-9]\d{0,2}$/.test(id)) {
      throw new Error("Invalid original monster skill identity");
    }
    for (const [rank, info] of entries(ranks, 256)) {
      if (!/^[1-9]\d{0,2}$/.test(rank)) {
        throw new Error("Invalid original monster skill rank");
      }
      entries(info, 256);
    }
  }
  doomFormCatalog(combat?.targets?.doom);
}

function doomFormCatalog(doom) {
  resource(doom?.bundle);
  for (const key of ["speed", "flySpeed", "transitionMs"]) finite(doom[key]);
  if (
    !Number.isSafeInteger(doom.templateId) ||
    doom.templateId < 1 ||
    !Number.isSafeInteger(doom.transitionMs) ||
    doom.transitionMs < 1
  ) {
    throw new Error("Invalid original Doom form metadata");
  }
  entries(doom.actions, LIMITS.actions);
}

function itemCatalog(items) {
  visualReferences(items, LIMITS.uiTemplates);
  for (const [id, item] of entries(items, LIMITS.uiTemplates)) {
    if (
      String(item.id) !== id ||
      !Number.isSafeInteger(item.iconWidth) ||
      !Number.isSafeInteger(item.iconHeight) ||
      item.iconWidth < 1 ||
      item.iconHeight < 1 ||
      item.iconWidth > 32768 ||
      item.iconHeight > 32768
    ) {
      throw new Error("Invalid original item icon metadata");
    }
  }
}

function nativeRules(ui) {
  macroDictionary(ui.skillMacroRules);
  const emblems = ui.social?.emblems;
  for (const key of ["backgrounds", "logos", "colors"]) {
    for (const id of array(emblems?.[key], LIMITS.uiArtwork)) {
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error("Invalid original guild emblem metadata");
      }
    }
  }
}

function macroDictionary(rules) {
  if (rules?.source !== "Etc.wz:Curse.img") {
    throw new Error("Original skill macro dictionary source is absent");
  }
  for (const word of array(rules.curseWords, 8192)) {
    if (typeof word !== "string" || !word.length || word.length > 256) {
      throw new Error("Invalid original macro dictionary word");
    }
  }
}

function dialogArtwork(artwork) {
  visualReferences(artwork, LIMITS.uiArtwork);
  for (const [path, record] of entries(artwork, LIMITS.uiArtwork)) {
    if (!path.length || path.length > 4096 || /[\r\n#]/.test(path)) {
      throw new Error("Invalid exact dialogue artwork path");
    }
    if (record.available === false) continue;
    dialogDimensions(path, record);
  }
}

function dialogDimensions(path, record) {
  if (
    record.path !== path ||
    !Number.isSafeInteger(record.width) ||
    !Number.isSafeInteger(record.height) ||
    record.width < 1 ||
    record.height < 1 ||
    record.width > 32768 ||
    record.height > 32768
  ) {
    throw new Error("Invalid original dialogue artwork dimensions");
  }
}

function avatarCatalog(avatar) {
  if (avatar?.schemaVersion !== 1) {
    throw new Error("Unsupported avatar catalog");
  }
  resource(avatar.projectiles);
  visualReferences(avatar.entries, LIMITS.uiTemplates);
  for (const [id, record] of entries(avatar.entries, LIMITS.uiTemplates)) {
    if (
      String(record.id) !== id ||
      !["body", "head", "face", "hair", "equipment"].includes(record.kind) ||
      typeof record.visual !== "boolean"
    ) {
      throw new Error("Invalid original avatar identity");
    }
  }
  for (const [, skin] of entries(avatar.skins, 256)) {
    if (!avatar.entries[skin.body] || !avatar.entries[skin.head]) {
      throw new Error("Avatar skin dependency is absent");
    }
  }
}

function cashCatalog(cash) {
  if (cash?.schemaVersion !== 1) throw new Error("Unsupported cash catalog");
  resource(cash.bundle);
  resource(cash.preview.bundle);
  visualReferences(cash.specialItems, LIMITS.uiArtwork);
  entries(cash.commodities, LIMITS.uiTemplates);
  entries(cash.packages, 4096);
  array(cash.itemIds, LIMITS.uiTemplates);
  resource(cash.bgm);
}

function monsterBookCatalog(book) {
  const cards = entries(book?.cards, 4096);
  array(book.categories, 9);
  for (const [id, card] of cards) {
    if (
      String(card.itemId) !== id ||
      !Number.isSafeInteger(card.mobId) ||
      card.mobId < 1 ||
      !Number.isInteger(card.category) ||
      card.category < 0 ||
      card.category > 8
    ) {
      throw new Error("Invalid original Monster Book card");
    }
    cardPortrait(card.portrait);
  }
}

function cardPortrait(portrait) {
  if (portrait?.available === false) {
    if (typeof portrait.reason !== "string") {
      throw new Error("Missing Monster Book portrait source reason");
    }
  } else resource(portrait?.descriptor);
}
function atlasDictionary(value) {
  for (const [, atlas] of entries(value.atlases, LIMITS.textures)) {
    resource(atlas);
    for (const key of ["width", "height"]) {
      if (
        !Number.isInteger(atlas[key]) ||
        atlas[key] < 1 ||
        atlas[key] > LIMITS.atlasSide
      ) {
        throw new Error("Unsupported atlas dimensions");
      }
    }
  }
}
function textureDictionary(value) {
  for (const [, texture] of entries(value.textures, LIMITS.textures)) {
    const atlas = value.atlases[texture.atlas];
    if (!atlas) throw new Error("Unknown texture atlas");
    for (const key of ["x", "y", "width", "height"]) {
      if (
        !Number.isInteger(texture[key]) ||
        texture[key] < (key === "x" || key === "y" ? 0 : 1)
      ) {
        throw new Error("Invalid atlas rectangle");
      }
    }
    if (
      texture.x + texture.width > atlas.width ||
      texture.y + texture.height > atlas.height
    ) {
      throw new Error("Atlas rectangle overflow");
    }
  }
}
function regionDescriptors(value) {
  const ids = new Set();
  for (const region of array(value.regions, LIMITS.regions)) {
    resource(region);
    bounds(region.bounds);
    if (
      typeof region.id !== "string" ||
      ids.has(region.id) ||
      typeof region.always !== "boolean"
    ) {
      throw new Error("Invalid region ID/visibility");
    }
    ids.add(region.id);
    for (const id of array(region.atlases, LIMITS.textures)) {
      if (!Object.hasOwn(value.atlases, id)) {
        throw new Error("Unknown region atlas");
      }
    }
  }
}
export function manifest(value) {
  if (value?.schemaVersion !== 2 || typeof value.id !== "string") {
    throw new Error("Map version must be 2");
  }
  bounds(value.bounds);
  finite(value.camera?.x);
  finite(value.camera?.y);
  atlasDictionary(value);
  textureDictionary(value);
  regionDescriptors(value);
  entities(value.actors, value);
  return value;
}

/** Independent UI/effect resources retain the existing entity and atlas contracts. */
export function visualBundle(value) {
  if (
    value?.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !value.metadata ||
    typeof value.metadata !== "object" ||
    Array.isArray(value.metadata)
  ) {
    throw new Error("Invalid visual bundle");
  }
  atlasDictionary(value);
  textureDictionary(value);
  entities(value.entities, value);
  return value;
}
function alpha(value) {
  if (value === undefined) return;
  finite(value);
  if (value < 0 || value > 1) throw new Error("Invalid original alpha");
}
function sourceSize(value) {
  if (!value) return;
  for (const key of ["width", "height"]) {
    if (
      !Number.isInteger(value[key]) ||
      value[key] <= 0 ||
      value[key] > 32768
    ) {
      throw new Error("Invalid logical source canvas dimensions");
    }
  }
}
function frame(value, map, background) {
  finite(value.delay);
  if (value.delay < 0) {
    throw new Error("Invalid animation duration");
  }
  alpha(value.alphaEnd);
  framePose(value);
  frameParts(value, map, background);
}

function framePose(value) {
  finite(value.moveX ?? 0);
  finite(value.moveY ?? 0);
  if (![0, 90, 180, 270].includes(value.rotate ?? 0)) {
    throw new Error("Invalid native frame rotation");
  }
  for (const key of ["flip", "alias", "preAction"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error("Invalid native frame pose flag");
    }
  }
  framePoseIdentity(value);
}

function framePoseIdentity(value) {
  if (value.poseAction === undefined && value.poseIndex === undefined) return;
  if (
    typeof value.poseAction !== "string" ||
    !value.poseAction.length ||
    value.poseAction.length > 128 ||
    !Number.isSafeInteger(value.poseIndex) ||
    value.poseIndex < 0 ||
    value.poseIndex >= LIMITS.frames
  ) {
    throw new Error("Invalid native frame pose identity");
  }
}
/** Validate original canvas extent and each atlas-backed frame part. */
function frameParts(value, map, background) {
  const parts = array(value.parts, LIMITS.parts);
  sourceSize(value.sourceSize);
  if (
    background &&
    (!parts.length || (parts.length > 1 && !value.sourceSize))
  ) {
    throw new Error("Tiled backgrounds require their original sourceSize");
  }
  for (const part of parts) {
    if (!Object.hasOwn(map.textures, part.texture)) {
      throw new Error("Unknown part texture");
    }
    for (const key of ["x", "y", "z"]) finite(part[key]);
    alpha(part.opacity);
    if (
      part.expression !== undefined &&
      !FACE_EXPRESSIONS.has(part.expression)
    ) {
      throw new Error("Invalid avatar face expression");
    }
    expressionTiming(part);
  }
}
/** Face frame timelines are independent of the body frame containing their anchors. */
function expressionTiming(part) {
  if (
    part.expressionDuration !== undefined &&
    (!Number.isSafeInteger(part.expressionDuration) ||
      part.expressionDuration < 0)
  ) {
    throw new Error("Invalid avatar expression duration");
  }
  expressionInterval(part);
}

/** Validate the complete half-open interval; untimed face parts remain supported. */
function expressionInterval(part) {
  const start = part.expressionStart;
  const end = part.expressionEnd;
  const loop = part.expressionLoopMs;
  if (start === undefined && end === undefined && loop === undefined) return;
  if (
    !part.expression ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(loop) ||
    start < 0 ||
    end < start ||
    end > loop ||
    loop <= 0
  ) {
    throw new Error("Invalid avatar expression frame interval");
  }
}

function background(value) {
  if (!Number.isInteger(value.type) || value.type < 0 || value.type > 7) {
    throw new Error("Unsupported background mode");
  }
  for (const key of ["rx", "ry", "cx", "cy"]) finite(value[key]);
  if (value.cx < 0 || value.cy < 0) {
    throw new Error("Negative background spacing");
  }
  backgroundCanvas(value);
  const speed =
    value.type === 4 || value.type === 6
      ? value.rx
      : value.type === 5 || value.type === 7
        ? value.ry
        : 0;
  if (Math.abs(speed) > 20000) {
    throw new Error("Background scroll duration is below one millisecond");
  }
}

/** The first native canvas fixes logical repeat periods even after lossless splitting. */
function backgroundCanvas(value) {
  if (!value.canvas) throw new Error("Missing original background canvas");
  sourceSize(value.canvas);
  const scale = value.canvas.scale;
  if (!Number.isInteger(scale) || scale < 0 || scale > 16) {
    throw new Error("Invalid original background canvas scale");
  }
  const overlap = 2 ** scale - 1;
  const repeat = backgroundRepeat(value.type);
  if (
    (repeat & 1 && (value.cx || value.canvas.width - overlap) <= 0) ||
    (repeat & 2 && (value.cy || value.canvas.height - overlap) <= 0)
  ) {
    throw new Error("Nonpositive original background period");
  }
}

function backgroundRepeat(type) {
  if (type < 4) return type;
  if (type === 4) return 1;
  if (type === 5) return 2;
  return 3;
}

/** Action-root repeat is retained once; native -1/-2 are nonlooping modes. */
function actionRepeat(frames) {
  for (let index = 0; index < frames.length; index++) {
    const repeat = frames[index].repeat;
    if (repeat === undefined) continue;
    if (
      index !== 0 ||
      !Number.isSafeInteger(repeat) ||
      repeat < -2 ||
      repeat >= frames.length
    ) {
      throw new Error("Invalid animation repeat");
    }
  }
}

/** Validate action collections and the initial action after entity metadata. */
function entityActions(entity, map) {
  for (const [, frames] of entries(entity.actions, LIMITS.actions)) {
    if (!array(frames, LIMITS.frames).length) throw new Error("Empty action");
    actionRepeat(frames);
    for (const value of frames) {
      frame(value, map, entity.background);
    }
  }
  if (!Object.hasOwn(entity.actions, entity.action)) {
    throw new Error("Missing initial action");
  }
}
export function entities(values, map) {
  const ids = new Set();
  for (const entity of array(values, LIMITS.entities)) {
    if (typeof entity.id !== "string" || ids.has(entity.id)) {
      throw new Error("Invalid entity identity");
    }
    ids.add(entity.id);
    if (!Number.isSafeInteger(entity.order) || entity.order < 0) {
      throw new Error("Missing global entity draw order");
    }
    if (
      ![
        "map",
        "character",
        "ui",
        "portal",
        "mob",
        "npc",
        "effect",
        "reactor",
      ].includes(entity.kind)
    ) {
      throw new Error("Unsupported entity kind");
    }
    for (const key of ["x", "y", "z"]) finite(entity[key]);
    alpha(entity.opacity);
    if (entity.background) background(entity.background);
    entityActions(entity, map);
  }
  return values;
}
