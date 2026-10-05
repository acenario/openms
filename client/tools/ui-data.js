import { at, resolveNode, value } from "../src/assets/image.js";
import { isCustomQuest } from "../src/quests/custom-quests.js";
import { originalFrames } from "./extraction-frames.js";
import { extractItemSkillUI } from "./ui-item-data.js";
import { extractNpcPortraits, extractDialogArtwork } from "./ui-npc-data.js";
import { extractDropArtwork } from "./drop-data.js";
import { extractWorldMaps } from "./worldmap-data.js";
import { extractCashShop } from "./cash-shop-data.js";
import { extractMonsterBook } from "./monster-book-data.js";
import { extractAvatarCatalog } from "./avatar-catalog.js";
import { createAppearances, extractCharacterCreate } from "./create-data.js";
import { extractSkillMacroRules } from "./skill-macro-data.js";
import { extractNpcWorldUI } from "./life-data.js";
import { extractSkillWorld } from "./skill-world-data.js";
import { extractSkillUtility } from "./skill-utility-data.js";
import { extractSkillCombat } from "./skill-combat-data.js";
import { extractSkillTargets } from "./skill-target-data.js";
import {
  DOJO_SKILLS,
  PYRAMID_SKILLS,
  eventMapFamily,
  eventFieldAllows,
} from "../src/skills/skill-event-rules.js";

const MAX_UI_NODES = 16000;
const MAX_UI_DEPTH = 64;
const MAX_UI_MAPS = 1024;
const MAX_ITEM_NAME_NODES = 150000;
const MAX_SKILL_BOOK_IMAGES = 256;
const MAX_ITEM_NAMES = 50000;
const BRANCHES = [
  "Item",
  "Equip",
  "Stat",
  "Skill",
  "SkillMacro",
  "Quest",
  "UserInfo",
  "Shop",
  "Trunk",
  "EnchantSkill",
  "TradingRoom",
  "TemporaryStatView",
  "GameMenu",
  "ShortCut",
  "KeyConfig",
  "MiniMap",
  "UtilDlgEx",
  "Notice",
  "ToolTip",
  "GameOpt",
  "SysOpt",
  "UserList",
  "QuestAlarm",
  "PartySearch",
  "Family",
  "Title",
  "Messenger",
];
const BRANCH_EXTRAS = {
  TemporaryStatView: ["Skill/CoolTime"],
  Shop: ["PersonalShop/BtExit"],
  TradingRoom: ["Messenger/BtEnter", "FadeYesNo"],
  Family: ["FamilyTree"],
  UserInfo: ["MonsterBook/icon"],
  UserList: [
    { image: "GuildBBS.img", branch: "GuildBBS", path: "GuildBBS" },
    { image: "GuildMark.img", branch: "", path: "GuildMark" },
  ],
};
// Native login scenery is UI.wz:MapLogin.img, not a selected playable map.
// Controls retain their authored states; the scene is packaged separately below.
const LOGIN_BRANCHES = [
  "Title",
  "Common/BtStart",
  "Common/BtExit",
  "Common/SoftKey/BtOK",
  "Common/SoftKey/BtCancel",
  "CharSelect",
  "NewChar",
  "Gender",
  "Notice/backgrnd/2",
];

/** Each canvas is a static presentation entity. Delay=1 is a storage sentinel, never an original animation default. */
async function canvasRecord(context, node, path, order) {
  const originalDelay = value(node, "delay", null);
  const delay = originalDelay === null ? null : Number(originalDelay);
  if (delay !== null && (!Number.isFinite(delay) || delay < 0)) {
    throw new Error(`Invalid UI delay: ${path}`);
  }
  const origin = value(node, "origin", { x: 0, y: 0 });
  // Keep authored alpha ramps as well as origins. UISurface.stateImage restores
  // each frame's real delay when these canvases are composed into an animation.
  const [frame] = await originalFrames(
    node,
    (canvas) => context.part(canvas),
    () => path,
  );
  frame.delay = 1;
  const entity = {
    id: path,
    kind: "ui",
    order,
    x: 0,
    y: 0,
    z: order,
    visible: true,
    flip: false,
    opacity: 1,
    action: "default",
    actions: { default: [frame] },
  };
  return {
    entity,
    asset: { id: path, width: node.width, height: node.height, origin, delay },
  };
}

/** Install chairs keep their authored effect branch as one animation entity drawn behind the seated player. */
async function effectRecord(context, node, path, order) {
  const frames = await originalFrames(
    node,
    (canvas) => context.part(canvas),
    () => path,
  );
  return {
    entity: {
      id: path,
      kind: "ui",
      order,
      x: 0,
      y: 0,
      z: order,
      visible: true,
      flip: false,
      opacity: 1,
      action: "default",
      actions: { default: frames },
    },
  };
}

/** Load authored branch roots in order before the bounded depth-first canvas traversal. */
async function branchRoots(context, { imageName, branch, extras }) {
  const root = await context.image("UI", imageName);
  const start = branch ? at(root, branch) : root;
  const stack = [{ node: start, path: branch, depth: 0 }];
  const sources = [`UI.wz:${imageName}${branch ? `/${branch}` : ""}`];
  for (const extra of extras) {
    const input =
      typeof extra === "string"
        ? { image: imageName, branch: extra, path: extra }
        : extra;
    const archive = input.archive ?? "UI";
    const extraRoot =
      archive === "UI" && input.image === imageName
        ? root
        : await context.image(archive, input.image);
    stack.push({
      node: input.branch ? at(extraRoot, input.branch) : extraRoot,
      path: input.path,
      depth: 0,
    });
    sources.push(
      `${archive}.wz:${input.image}${input.branch ? `/${input.branch}` : ""}`,
    );
  }
  if (branch === "MiniMap") {
    await addMinimapMarkers(context, stack);
  }
  const books =
    branch === "Skill" ? await addSkillBooks(context, stack, sources) : null;
  return { stack, sources, books };
}

/** Iterative traversal retains alias paths and original anchors; bounded path depth detects UOL ancestor cycles. */
async function branchBundle(context, imageName, branch, extras = []) {
  const { stack, sources, books } = await branchRoots(context, {
    imageName,
    branch,
    extras,
  });
  const entities = [],
    assets = Object.create(null),
    aliases = Object.create(null);
  let visited = 0;
  while (stack.length) {
    if (++visited > MAX_UI_NODES) {
      throw new Error(`UI branch exceeds node budget: ${branch}`);
    }
    const item = stack.pop();
    if (item.depth > MAX_UI_DEPTH) {
      throw new Error(`UI branch exceeds depth budget: ${item.path}`);
    }
    if (item.node.type === "UOL") aliases[item.path] = item.node.value;
    const node = resolveNode(item.node);
    if (node.type === "Canvas") {
      const record = await canvasRecord(
        context,
        node,
        item.path,
        entities.length,
      );
      entities.push(record.entity);
      assets[item.path] = record.asset;
      continue;
    }
    for (const [name, child] of Object.entries(node.children)) {
      stack.push({
        node: child,
        path: item.path ? `${item.path}/${name}` : name,
        depth: item.depth + 1,
      });
    }
  }
  return publishBranch(context, {
    imageName,
    branch,
    assets,
    aliases,
    entities,
    sources,
    books,
  });
}

async function addMinimapMarkers(context, stack) {
  const markers = await context.image("Map", "MapHelper.img");
  // 008594a7 draws every other user in the field with the authored `another` canvas; NPCs,
  // portals and the local `user` share the same transform.
  for (const name of ["user", "another", "npc", "portal"]) {
    stack.push({
      node: at(markers, `minimap/${name}`),
      path: `MapHelper/minimap/${name}`,
      depth: 0,
    });
  }
}

/** Native008ac38a paints the selected book's Skill info/icon and String bookName. */
async function addSkillBooks(context, stack, sources) {
  const images = context.imageEntries("Skill");
  if (!(images instanceof Map) || images.size > MAX_SKILL_BOOK_IMAGES) {
    throw new Error("Original skill book image index exceeds its bound");
  }
  const strings = await context.image("String", "Skill.img");
  const books = Object.create(null);
  for (const image of images.keys()) {
    if (!/^\d+\.img$/.test(image)) continue;
    const key = image.slice(0, -4);
    const root = await context.image("Skill", image);
    const icon = at(root, "info/icon");
    const name = value(at(strings, key), "bookName", null);
    if (!icon || typeof name !== "string" || !name) {
      throw new Error(`Original skill book header is unavailable: ${image}`);
    }
    const path = `Skill/Book/${Number(key)}/icon`;
    stack.push({ node: icon, path, depth: 0 });
    books[Number(key)] = { iconPath: path, name };
    sources.push(`Skill.wz:${image}/info/icon`);
  }
  sources.push("String.wz:Skill.img/<book>/bookName");
  return books;
}

function publishBranch(
  context,
  { imageName, branch, assets, aliases, entities, sources, books },
) {
  const metadata = {
    source: `UI.wz:${imageName}${branch ? `/${branch}` : ""}`,
    sources,
    assets,
    aliases,
    timing:
      "Static canvases; absent frame timing unsupported. Explicit authored delays retained in assets.",
  };
  if (books) metadata.books = books;
  if (branch === "MiniMap") {
    metadata.markerSource = "Map.wz:MapHelper.img/minimap";
  }
  if (imageName === "Basic.img" && branch === "Cursor") {
    metadata.states = cursorStates(assets);
  }
  return context.bundle({
    id: `ui:${imageName}:${branch || "root"}`,
    entities,
    metadata,
  });
}

/** Cursor state frames retain sparse numeric IDs and aliases; the UI owner supplies the animation clock. */
function cursorStates(assets) {
  const states = Object.create(null);
  for (const path of Object.keys(assets)) {
    const parts = path.split("/");
    const state = parts[1];
    if (!states[state]) states[state] = [];
    states[state].push(path);
  }
  for (const frames of Object.values(states)) {
    frames.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }
  return states;
}

/** 005cf792 reads info/link once; nonzero link selects the String.wz map-name record. */
async function minimapNames(context, mapId, map) {
  const link = value(at(map, "info"), "link", "");
  if (link !== "" && !/^\d{1,9}$/.test(String(link))) {
    throw new Error(`Invalid original map-name link: ${mapId}`);
  }
  const namesMapId = Number(link) || Number(mapId);
  const root = await context.image("String", "Map.img");
  const regions = Object.values(root.children);
  if (regions.length > 64) throw new Error("Map-name region budget exceeded");
  let names = { streetName: "", mapName: "", namesMapId };
  for (const region of regions) {
    const node = region.children[String(namesMapId)];
    if (!node) continue;
    names = {
      streetName: value(node, "streetName", ""),
      mapName: value(node, "mapName", ""),
      namesMapId,
    };
    if (
      typeof names.streetName !== "string" ||
      typeof names.mapName !== "string"
    ) {
      throw new Error(`Invalid original map names: ${mapId}`);
    }
  }
  return names;
}

/** Original per-map minimap canvas and scalar coordinate metadata, independently demand-loaded. */
async function minimapBundle(context, mapId) {
  const path = `Map/Map${mapId[0]}/${mapId}.img`;
  const map = await context.image("Map", path);
  const names = await minimapNames(context, mapId, map);
  if (!map.children.miniMap) {
    return {
      available: false,
      ...names,
      reason: "Original map has no miniMap branch.",
    };
  }
  const node = at(map, "miniMap");
  if (!node.children.canvas) {
    return {
      available: false,
      ...names,
      reason: "Original miniMap has no canvas.",
    };
  }
  const record = await canvasRecord(
    context,
    at(node, "canvas"),
    "miniMap/canvas",
    0,
  );
  const properties = minimapProperties(node);
  const entities = [record.entity];
  const assets = { "miniMap/canvas": record.asset };
  const mapMark = value(at(map, "info"), "mapMark", "");
  if (typeof mapMark !== "string") {
    throw new Error(`Invalid original map mark: ${mapId}`);
  }
  await appendMinimapMark(context, mapMark, entities, assets);
  const metadata = {
    source: `Map.wz:${path}/miniMap`,
    assets,
    ...names,
    mapMark,
    namesSource: "String.wz:Map.img",
    markSource:
      mapMark && mapMark !== "None"
        ? `Map.wz:MapHelper.img/mark/${mapMark}`
        : null,
    properties,
  };
  const descriptor = await context.bundle({
    id: `ui:minimap:${mapId}`,
    entities,
    metadata,
  });
  return { available: true, ...names, descriptor };
}

async function appendMinimapMark(context, mapMark, entities, assets) {
  if (mapMark && mapMark !== "None") {
    const helper = await context.image("Map", "MapHelper.img");
    const mark = await canvasRecord(
      context,
      at(helper, `mark/${mapMark}`),
      "miniMap/mark",
      1,
    );
    entities.push(mark.entity);
    assets["miniMap/mark"] = mark.asset;
  }
}

function minimapProperties(node) {
  const properties = Object.create(null);
  for (const [key, child] of Object.entries(node.children)) {
    if (["number", "string"].includes(typeof child.value)) {
      properties[key] = child.value;
    }
  }
  return properties;
}

/** Full original item-name table; labels do not confer possession, use rules or instance statistics. */
async function itemLabels(context) {
  const state = {
    labels: Object.create(null),
    details: Object.create(null),
    visited: 0,
    items: 0,
  };
  for (const imageName of [
    "Eqp.img",
    "Consume.img",
    "Ins.img",
    "Etc.img",
    "Cash.img",
    "Pet.img",
  ]) {
    const root = await context.image("String", imageName);
    collectItemLabels(root, state, imageName);
  }
  return state;
}

/** One image traversal shares cumulative limits across the complete original name table. */
function collectItemLabels(root, state, imageName) {
  const stack = [{ node: root, key: "", path: "", depth: 0 }];
  while (stack.length) {
    if (++state.visited > MAX_ITEM_NAME_NODES) {
      throw new Error("UI item-name node budget exceeded");
    }
    const entry = stack.pop();
    if (entry.depth > MAX_UI_DEPTH) {
      throw new Error("UI item-name depth exceeded");
    }
    const node = resolveNode(entry.node);
    if (/^\d{7,8}$/.test(entry.key) && node.children?.name) {
      recordItemLabel(
        state,
        entry.key,
        node,
        `String.wz:${imageName}/${entry.path}`,
      );
      continue;
    }
    for (const [key, child] of Object.entries(node.children || {})) {
      stack.push({
        node: child,
        key,
        path: entry.path ? `${entry.path}/${key}` : key,
        depth: entry.depth + 1,
      });
    }
  }
}

function recordItemLabel(state, key, node, source) {
  const id = Number(key),
    name = value(node, "name", null);
  if (typeof name !== "string" || name.length > 4096) {
    throw new Error(`Invalid original item name ${key}`);
  }
  if (++state.items > MAX_ITEM_NAMES) {
    throw new Error("UI item-name count exceeded");
  }
  if (state.labels[id] && state.labels[id] !== name) {
    throw new Error(`Conflicting item name ${id}`);
  }
  state.labels[id] = name;
  const description = value(node, "desc", "") ?? "";
  if (typeof description !== "string") {
    throw new Error(`Invalid original item description ${key}`);
  }
  state.details[id] = { name, description, source };
}

/** Player and NPC speech share the original skin extraction and color contract. */
async function speechBubbleBundle(context, skin = "0") {
  const image = await context.image("UI", "ChatBalloon.img");
  const color = value(at(image, skin), "clr", null);
  if (!Number.isInteger(color)) {
    throw new Error(`Original speech color is missing or invalid: ${skin}`);
  }
  return {
    bundle: await branchBundle(context, "ChatBalloon.img", skin),
    color,
  };
}

/** Original authored help labels and descriptions for status-bar controls. */
async function buttonHelp(context) {
  const image = await context.image("String", "ToolTipHelp.img");
  const help = Object.create(null);
  const buttons = at(image, "Game/Button");
  for (const [name, node] of Object.entries(buttons.children)) {
    help[name] = {
      title: value(node, "Title", name),
      description: value(node, "Desc", ""),
    };
  }
  return help;
}

/** 00b2bc54 (string1306) selects the same tall field for every native login stage. */
async function loginSceneBundle(context) {
  context.progress?.(
    "Shared UI: converting original UI.wz:MapLogin.img scenery",
  );
  const map = await context.image("UI", "MapLogin.img");
  const entities = await context.scenery(map);
  return context.bundle({
    id: "ui:MapLogin.img",
    entities,
    metadata: {
      source: "UI.wz:MapLogin.img",
      sources: [
        "UI.wz:MapLogin.img",
        "Map.wz:Back/login.img",
        "Map.wz:Obj/login.img",
      ],
    },
  });
}

/** Shared controls keep every authored state, including enabled0/1/2 and disabled scroll artwork. */
async function windowBundles(context) {
  const bundles = Object.create(null);
  bundles.StatusBar = await branchBundle(context, "StatusBar.img", "");
  bundles.ITC = await branchBundle(context, "ITC.img", "");
  bundles.Login = await branchBundle(
    context,
    "Login.img",
    "Common/frame",
    LOGIN_BRANCHES,
  );
  bundles.LoginScene = await loginSceneBundle(context);
  bundles.Basic = await branchBundle(context, "Basic.img", "BtClose", [
    "BtCancel2",
    "BtClaim",
    "Tab2",
    "Tab3",
    "Tab4",
    "BtMin",
    "BtMax",
    "ComboBox2",
    "BtOK",
    "BtOK2",
    "BtYes",
    "BtNo",
    "ItemNo",
    "LevelNo",
    "BtClose2",
    "BtUP",
    "BtDown",
    "BtHide",
    "BtQGiveup",
    "BtMacro",
    "CheckBox",
    "VScr",
    "HScr",
    "VScr4",
    "HScr4",
    "Slider",
    "BtCancel",
  ]);
  bundles.Cursor = await branchBundle(context, "Basic.img", "Cursor");
  for (const branch of BRANCHES) {
    bundles[branch] = await branchBundle(
      context,
      "UIWindow.img",
      branch,
      BRANCH_EXTRAS[branch] ?? [],
    );
  }
  bundles.WorldMap = await extractWorldMaps(context, canvasRecord);
  bundles.MesoDrop = await branchBundle(context, "Basic.img", "Notice3", [
    "Notice4",
  ]);
  bundles.UtilDlg = await branchBundle(context, "Basic.img", "YesNo3", [
    "Notice3",
  ]);
  return bundles;
}

/** Native emblem choices are original numeric source IDs, not generated logos or colors. */
async function socialMetadata(context) {
  const root = await context.image("UI", "GuildMark.img");
  const backgrounds = Object.keys(at(root, "BackGround").children)
    .map(Number)
    .sort((a, b) => a - b);
  const logos = [],
    colors = new Set();
  for (const category of Object.values(at(root, "Mark").children)) {
    for (const [id, logo] of Object.entries(category.children)) {
      logos.push(Number(id));
      for (const color of Object.keys(resolveNode(logo).children)) {
        if (/^\d+$/.test(color)) colors.add(Number(color));
      }
    }
  }
  if (logos.length > MAX_UI_NODES || backgrounds.length > MAX_UI_NODES) {
    throw new Error("Guild emblem source bound");
  }
  return {
    emblems: {
      backgrounds,
      logos: logos.sort((a, b) => a - b),
      colors: [...colors].sort((a, b) => a - b),
      source: "UI.wz:GuildMark.img",
    },
  };
}
/** Check template and scalar-name coverage before separately reporting lazy artwork. */
function metadataCoverage(context, visuals, missing) {
  const dependencies = context.serverData.supportedDependencies;
  const names = context.quests.strings;
  for (const id of dependencies.itemIds) {
    if (!visuals.items[id]) {
      missing.push({
        kind: "item",
        id,
        reason:
          "Original inventory template is absent from Item.wz/Character.wz",
      });
    }
  }
  for (const [kind, ids, dictionary] of [
    ["npc-name", dependencies.npcIds, names.npc],
    ["mob-name", dependencies.mobIds, names.mob],
    ["map-name", dependencies.mapIds, context.mapNames],
    ["quest", dependencies.questIds, context.quests.records],
  ]) {
    for (const id of ids) {
      // State-only custom quests have no original record by definition.
      if (kind === "quest" && isCustomQuest(id)) continue;
      if (!dictionary[id]) {
        missing.push({
          kind,
          id,
          reason: "Required original metadata record is absent",
        });
      }
    }
  }
}

/** Report every admitted script's metadata requirements, independently of selected maps. */
function dependencyCoverage(context, visuals) {
  const dependencies = context.serverData.supportedDependencies;
  const missing = [];
  metadataCoverage(context, visuals, missing);
  for (const id of dependencies.npcIds) {
    const portrait = visuals.npcPortraits[id];
    if (!portrait || portrait.available === false) {
      missing.push({
        kind: "npc-portrait",
        id,
        reason: portrait?.reason ?? "Original NPC portrait is absent",
      });
    }
  }
  for (const path of dependencies.artworkPaths) {
    const artwork = visuals.dialogArtwork[path];
    if (!artwork || artwork.available === false) {
      missing.push({
        kind: "dialog-artwork",
        path,
        reason: artwork?.reason ?? "Original artwork is absent",
      });
    }
  }
  const packaged = new Set(context.mapIds.map(Number));
  return {
    required: Object.fromEntries(
      Object.entries(dependencies).map(([key, values]) => [key, values.length]),
    ),
    missing,
    unpackagedMaps: dependencies.mapIds.filter((id) => !packaged.has(id)),
    scope:
      "All supported numeric/SQL/named routes. Metadata-only map references do not imply a playable destination.",
  };
}

/** Selected maps retain independent demand-loaded minimap bundles. */
async function minimapBundles(context) {
  const minimaps = Object.create(null);
  if (!Array.isArray(context.mapIds) || context.mapIds.length > MAX_UI_MAPS) {
    throw new Error("UI extraction requires bounded selected map IDs");
  }
  for (const mapId of context.mapIds) {
    minimaps[mapId] = await minimapBundle(context, mapId);
  }
  return minimaps;
}

/** NPC world artwork plus its shared speech-bubble bundle. */
async function npcWorldArtwork(context) {
  return {
    ...(await extractNpcWorldUI(context)),
    speech: await speechBubbleBundle(context, "npc"),
  };
}

/** Static catalog metadata; artwork and avatar records remain independently demand-loaded. */
export async function extractGameUI(context) {
  const bundles = await windowBundles(context);
  bundles.FamilyTree = bundles.Family;
  bundles.PartyHP = bundles.UserList;
  const cashShop = await extractCashShop(context, canvasRecord);
  const monsterBook = await extractMonsterBook(context, canvasRecord);
  bundles.CashShop = cashShop.bundle;
  bundles.MonsterBook = monsterBook.bundle;
  const minimaps = await minimapBundles(context);
  const strings = await itemLabels(context);
  const templates = await extractItemSkillUI(
    { ...context, cashShop, monsterBook, effectRecord },
    strings.details,
    canvasRecord,
  );
  const npcPortraits = await extractNpcPortraits(context);
  const dialogArtwork = await extractDialogArtwork(context, canvasRecord);
  const characterCreate = await extractCharacterCreate(context);
  // Create choices and their artwork share one original source: every legal
  // appearance is packaged, so the picker never offers an unrenderable option.
  const avatar = await extractAvatarCatalog(
    { ...context, avatarAppearances: createAppearances(characterCreate) },
    templates.items,
  );
  return {
    schemaVersion: 1,
    bundles,
    minimaps,
    npcPortraits,
    npcWorld: await npcWorldArtwork(context),
    dialogArtwork,
    cashShop,
    monsterBook: monsterBook.monsterBook,
    avatar,
    characterCreate,
    skillMacroRules: await extractSkillMacroRules(context),
    social: await socialMetadata(context),
    dropArtwork: await extractDropArtwork(context, canvasRecord),
    help: await buttonHelp(context),
    itemLabels: strings.labels,
    items: templates.items,
    skills: templates.skills,
    fieldResources: fieldSkillResources(context, templates.skills),
    speechBubbles: await speechBubbleBundle(context),
    skillWorld: await extractSkillWorld(context),
    skillUtility: await extractSkillUtility(context, templates.items),
    skillCombat: {
      ...extractSkillCombat(context),
      targets: await extractSkillTargets(context),
    },
    coverage: uiCoverage(context, templates, {
      cashShop,
      monsterBook,
      npcPortraits,
      dialogArtwork,
    }),
    authority:
      "Original static artwork/metadata with recovered native consumers; mutable state is real local-profile authority, with explicitly labeled authorized Cosmic server-reference policy.",
    evidence: "docs/ingame-ui.md",
  };
}

/** Original field type and map predicates select event artwork, never grant event authority. */
function fieldSkillResources(context, skills) {
  const result = Object.create(null);
  for (const mapId of context.mapIds) {
    const family = eventMapFamily(Number(mapId));
    if (!family) continue;
    const map = context.image("Map", `Map/Map${mapId[0]}/${mapId}.img`);
    const fieldType = value(at(map, "info"), "fieldType", 0);
    if (!eventFieldAllows(family, fieldType)) continue;
    const resources = [];
    const ids = family === "dojo" ? DOJO_SKILLS : PYRAMID_SKILLS;
    for (const id of ids) {
      const skill = skills[id];
      if (!skill?.classification.supported) continue;
      resources.push(skill.visuals, skill.descriptor);
      for (const name of ["Use", "Hit"]) {
        const sound = skill.sounds?.leaves?.[name];
        if (sound) resources.push(sound);
      }
    }
    result[mapId] = resources;
  }
  return result;
}

function uiCoverage(context, templates, sources) {
  const { cashShop, monsterBook, npcPortraits, dialogArtwork } = sources;
  return {
    ...templates.coverage,
    cashCommodities: Object.keys(cashShop.commodities).length,
    cashItems: cashShop.itemIds.length,
    monsterBookItemIds: monsterBook.itemIds,
    monsterBook: monsterBook.coverage,
    scriptMetadata: dependencyCoverage(context, {
      items: templates.items,
      npcPortraits,
      dialogArtwork,
    }),
    missingPortraits: Object.entries(npcPortraits)
      .filter(([, entry]) => entry.available === false)
      .map(([id, entry]) => ({ id: Number(id), ...entry })),
    missingDialogArtwork: Object.entries(dialogArtwork)
      .filter(([, entry]) => entry.available === false)
      .map(([path, entry]) => ({ path, ...entry })),
  };
}
