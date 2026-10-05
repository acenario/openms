import { at, resolveNode, value } from "../src/assets/image.js";
import { classifySkill, skillSounds, skillVisuals } from "./skill-data.js";

const MAX_IMAGES = 50000;
const MAX_ITEMS = 32768;
const MAX_QUESTS = 4096;
const MAX_STAGES = 2;
const MAX_STAGE_ITEMS = 8192;
const MAX_ROOTS = 100000;
const MAX_METADATA_NODES = 65536;
const MAX_METADATA_DEPTH = 64;
const MAX_SKILLS = 4096;
// Original initial appearance and one non-granted template per recovered weapon row.
const EQUIPMENT_IDS = [
  1040002, 1060002, 1072001, 1302000, 1312000, 1322000, 1332000, 1372000,
  1382000, 1392000, 1402000, 1412000, 1422000, 1432000, 1442000, 1452000,
  1462000, 1472000, 1482000, 1492000, 2060000, 2061000, 2070000, 2330000,
];
const ICONS = ["icon", "iconMouseOver", "iconDisabled"];

/** One closure covers retained journal presentation and every admitted transaction domain. */
function requiredItems(context) {
  const records = Object.values(context.quests.records);
  if (records.length > MAX_QUESTS) {
    throw new Error("UI quest closure exceeds policy");
  }
  const ids = dropItemClosure(context.dropItemIds ?? []);
  // ScrollHandler's White Scroll protection (equipment-enhancement.js) is an activation dependency, not a shop/drop reward.
  ids.add(2340000);
  for (const values of [
    context.serverData.supportedItemIds,
    context.cashShop.itemIds,
    context.monsterBook.itemIds,
  ]) {
    collectItemIds(ids, values);
  }
  let supportedQuests = 0;
  for (const record of records) {
    collectItemIds(ids, record.dependencies.itemIds);
    if (Number.isSafeInteger(record.info?.viewMedalItem)) {
      collectItemIds(ids, [record.info.viewMedalItem]);
    }
    if (!record.supported) continue;
    supportedQuests++;
    if (record.stages.length > MAX_STAGES) {
      throw new Error("UI quest stage limit");
    }
    for (const stage of record.stages) {
      collectStageItems(ids, stage.check.items);
      collectStageItems(ids, stage.act.items);
      collectStageItems(ids, stage.actionCheck.items);
    }
  }
  return { ids: [...ids].sort((a, b) => a - b), supportedQuests };
}

function dropItemClosure(dropIds) {
  if (!Array.isArray(dropIds) || dropIds.length > MAX_ITEMS) {
    throw new Error("Invalid drop item closure");
  }
  const ids = new Set(EQUIPMENT_IDS);
  for (const id of dropIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Invalid drop item ID");
    }
    ids.add(id);
  }
  if (ids.size > MAX_ITEMS) throw new Error("UI item closure exceeds policy");
  return ids;
}
/** Numeric IDs remain sorted only at publication; no duplicate metadata conversion. */
function collectItemIds(ids, values) {
  if (!Array.isArray(values) || values.length > MAX_ITEMS) {
    throw new Error("Invalid UI item dependencies");
  }
  for (const id of values) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid item dependency ${id}`);
    }
    ids.add(id);
  }
  if (ids.size > MAX_ITEMS) throw new Error("UI item closure exceeds policy");
}

function collectStageItems(ids, items) {
  if (items.length > MAX_STAGE_ITEMS) throw new Error("UI quest item limit");
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0) {
      throw new Error(`Invalid quest item ID ${item.id}`);
    }
    ids.add(item.id);
    if (ids.size > MAX_ITEMS) throw new Error("UI item closure exceeds policy");
  }
}

/** Directory names come from the original archive index, never ID-prefix path arithmetic. */
function imagePaths(context, archive) {
  const entries = context.imageEntries(archive);
  if (!(entries instanceof Map) || entries.size > MAX_IMAGES) {
    throw new Error(`Invalid UI original image index: ${archive}`);
  }
  return [...entries.keys()].filter((path) => path.endsWith(".img")).sort();
}

function addSource(sources, wanted, id, entry) {
  if (!wanted.has(id)) return;
  if (sources.has(id)) throw new Error(`Ambiguous original item source ${id}`);
  sources.set(id, entry);
}

/** Only selected records are decoded into visual bundles; image discovery reads metadata. */
async function itemSources(context, ids) {
  const wanted = new Set(ids),
    sources = new Map();
  for (const path of imagePaths(context, "Character")) {
    const key = path.split("/").at(-1).slice(0, -4);
    if (!/^\d{8}$/.test(key)) continue;
    addSource(sources, wanted, Number(key), {
      archive: "Character",
      path,
      key: "",
      category: path.split("/")[0],
    });
  }
  let roots = 0;
  for (const path of imagePaths(context, "Item")) {
    const image = await context.image("Item", path);
    const direct = path.split("/").at(-1).slice(0, -4);
    if (/^\d{7,8}$/.test(direct) && image.children.info) {
      addSource(sources, wanted, Number(direct), {
        archive: "Item",
        path,
        key: "",
        category: path.split("/")[0],
      });
    }
    const entries = Object.keys(image.children);
    roots += entries.length;
    if (roots > MAX_ROOTS) throw new Error("UI item source root limit");
    for (const key of entries) {
      if (!/^\d{7,8}$/.test(key)) continue;
      addSource(sources, wanted, Number(key), {
        archive: "Item",
        path,
        key,
        category: path.split("/")[0],
      });
    }
  }
  return sources;
}

// Gameplay fields directly under item info (price, cash, tradeBlock, req*, inc*) are integers; a few
// originals store them as String nodes ("1"), which the client's integer reads accept. Readers compare
// them as numbers (an "1" incLUK broke snapshot validation, a "35" reqLevel made a glove unequippable).
const INFO_INTEGER = /^-?\d{1,15}$/;

function infoInteger(node) {
  return typeof node.value === "string" &&
    node.parent?.name === "info" &&
    INFO_INTEGER.test(node.value)
    ? Number(node.value)
    : undefined;
}

/** Plain properties/scalars remain directly consumable; non-property nodes retain explicit type markers. */
function metadataValue(node) {
  if (node.type === "UOL") return { $wzType: "UOL", target: node.value };
  const integer = infoInteger(node);
  if (integer !== undefined) return integer;
  if (node.value !== undefined) {
    if (typeof node.value === "number" && !Number.isFinite(node.value)) {
      throw new Error(`Non-finite original UI metadata ${node.name}`);
    }
    return node.value && typeof node.value === "object"
      ? { ...node.value }
      : node.value;
  }
  const result = Object.create(null);
  if (node.type !== "Property") {
    result.$wzType = node.type;
    if (node.type === "Canvas") {
      result.width = node.width;
      result.height = node.height;
      result.format = node.format;
      result.scale = node.scale;
    }
  }
  return result;
}

/** Preserve every nested effect/restriction, including aliases and empty/unknown node kinds; no pixel payloads. */
export function metadataTree(root) {
  if (!root) return Object.create(null);
  const holder = Object.create(null);
  const queue = [{ node: root, parent: holder, key: "root", depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];
    if (entry.depth > MAX_METADATA_DEPTH) {
      throw new Error("UI metadata depth limit");
    }
    const node = entry.node;
    const target = metadataValue(node);
    entry.parent[entry.key] = target;
    let children;
    if (node.type === "UOL") {
      try {
        children = [["resolved", resolveNode(node)]];
      } catch (error) {
        target.unavailable = error.message;
        continue;
      }
    } else children = Object.entries(node.children);
    for (const [key, child] of children) {
      if (queue.length >= MAX_METADATA_NODES) {
        throw new Error("UI metadata node limit");
      }
      queue.push({ node: child, parent: target, key, depth: entry.depth + 1 });
    }
  }
  return holder.root;
}

/** Reuse the existing UI canvas origin/part/texture pipeline and one independently loadable bundle per ID. */
async function iconBundle(context, input) {
  const entities = [],
    assets = Object.create(null);
  for (const key of input.icons) {
    const child = input.node.children[key];
    if (!child) continue;
    const node = resolveNode(child);
    if (node.type !== "Canvas") {
      throw new Error(`Invalid original icon ${input.source}/${key}`);
    }
    const path = `${input.kind}/${input.id}/${key}`;
    const record = await context.canvasRecord(
      context,
      node,
      path,
      entities.length,
    );
    entities.push(record.entity);
    assets[path] = record.asset;
  }
  if (!assets[`${input.kind}/${input.id}/icon`]) {
    throw new Error(`Missing original icon ${input.source}`);
  }
  // Install chairs carry their seated artwork as a top-level effect animation.
  if (input.effect) {
    const record = await context.effectRecord(
      context,
      input.effect,
      `${input.kind}/${input.id}/effect`,
      entities.length,
    );
    entities.push(record.entity);
  }
  return context.bundle({
    id: `ui:${input.kind}:${input.id}`,
    entities,
    metadata: { source: input.source, assets },
  });
}

/** Only authored Install chair effects become world artwork; other item branches stay metadata. */
function chairEffect(node, entry, id) {
  if (entry.archive !== "Item" || Math.floor(id / 10000) !== 301) return null;
  const child = node.children.effect;
  if (!child) return null;
  const effect = resolveNode(child);
  const frames = Object.keys(effect.children).filter((key) =>
    /^\d+$/.test(key),
  );
  if (!frames.length) return null;
  // A nested/aliased branch is out of scope; keep the authored metadata only.
  for (const key of frames) {
    if (resolveNode(effect.children[key]).type !== "Canvas") return null;
  }
  return effect;
}

/** Character actions are artwork; retain only Item branches as effect metadata. */
function itemProperties(node, archive) {
  const properties = Object.create(null);
  if (archive === "Item") {
    for (const [key, child] of Object.entries(node.children)) {
      if (key !== "info" && key !== "spec") {
        properties[key] = metadataTree(child);
      }
    }
  }
  return properties;
}

/** Preserve absent raw-icon metadata independently of the required inventory icon. */
function itemIconMetadata(info, id) {
  const icon = info.children.icon ? resolveNode(info.children.icon) : null;
  const rawIcon = info.children.iconRaw
    ? resolveNode(info.children.iconRaw)
    : null;
  return {
    iconPath: `item/${id}/icon`,
    iconWidth: icon?.width ?? null,
    iconHeight: icon?.height ?? null,
    iconRawPath: info.children.iconRaw ? `item/${id}/iconRaw` : null,
    iconRawWidth: rawIcon?.width ?? null,
    iconRawHeight: rawIcon?.height ?? null,
  };
}

/** The extra properties object retains top-level effects outside info/spec, never an implicit usability flag. */
async function itemRecord(context, id, entry, strings) {
  const root = await context.image(entry.archive, entry.path);
  const node = at(root, entry.key);
  const source = `${entry.archive}.wz:${entry.path}${entry.key ? `/${entry.key}` : ""}`;
  const info = node.children.info ? resolveNode(node.children.info) : null;
  if (!info?.children.icon) {
    return {
      available: false,
      source,
      reason: "Original item has no info/icon Canvas",
    };
  }
  const properties = itemProperties(node, entry.archive);
  const descriptor = await iconBundle(context, {
    kind: "item",
    id,
    node: info,
    source,
    icons: ["icon", "iconRaw"],
    effect: chairEffect(node, entry, id),
  });
  const iconMetadata = itemIconMetadata(info, id);
  return {
    id,
    category: entry.category,
    name: strings.name,
    description: strings.description,
    source,
    info: metadataTree(info),
    spec: metadataTree(node.children.spec),
    properties,
    ...iconMetadata,
    descriptor,
  };
}

/** Resolve authored rank aliases while retaining the original level metadata. */
function skillLevels(node) {
  const level = metadataTree(node.children.level),
    levels = Object.create(null);
  const levelNode = node.children.level
    ? resolveNode(node.children.level)
    : null;
  const ranks = Object.keys(levelNode?.children ?? {}).filter((rank) =>
    /^\d+$/.test(rank),
  );
  for (const rank of ranks) {
    levels[rank] = metadataTree(resolveNode(levelNode.children[rank]));
  }
  return { level, levels, maxLevel: ranks.length };
}

/** Book ranges are the existing catalog families, not learnability rules. */
function skillFamily(bookId) {
  if (bookId >= 2000) return "legend";
  if (bookId >= 1000) return "cygnus";
  if (bookId >= 800) return "event";
  return "explorer";
}

/** Action aliases retain their authored scalar or ordered string children. */
function skillActions(properties) {
  const rawActions = properties.action?.resolved ?? properties.action;
  return typeof rawActions === "string"
    ? [rawActions]
    : Object.values(rawActions ?? {}).filter(
        (action) => typeof action === "string",
      );
}

function skillMetadata(node, image, properties) {
  const rankMetadata = skillLevels(node);
  const bookId = Number(image.slice(0, -4));
  return {
    bookId,
    jobId: bookId,
    family: skillFamily(bookId),
    ...rankMetadata,
    masterLevel: properties.masterLevel ?? null,
    prerequisites: Object.entries(properties.req ?? {}).map(
      ([skillId, rank]) => ({ skillId: Number(skillId), rank }),
    ),
    actions: skillActions(properties),
    flags: {
      invisible: Boolean(properties.invisible),
      timeLimited: Boolean(properties.timeLimited),
      disabled: Boolean(properties.disable),
    },
  };
}

/** Unknown authored costs stay unavailable; beginner entitlement is not SP. */
function skillAllocationCost(id, properties) {
  return {
    kind:
      properties.levelCost !== undefined
        ? "unknown"
        : id % 10000000 >= 1000 && id % 10000000 <= 1002
          ? "beginner-entitlement"
          : "sp",
    amount: properties.levelCost === undefined ? 1 : null,
    raw: properties.levelCost ?? null,
    evidence:
      "Cosmic AssignSPProcessor.java:68-97 (authorized emulator reference)",
  };
}

/** Full original strings include per-level hN descriptions, not just a display label. */
async function skillRecord(context, input, strings) {
  const { key, image, node } = input;
  const id = Number(key),
    source = `Skill.wz:${image}/skill/${key}`;
  const text = strings.children[key];
  // Missing strings are explicit original absence, not grounds to omit a player skill.
  const properties = Object.create(null);
  for (const [name, child] of Object.entries(node.children)) {
    if (name !== "level" && !ICONS.includes(name)) {
      properties[name] = metadataTree(child);
    }
  }
  const descriptor = await iconBundle(context, {
    kind: "skill",
    id,
    node,
    source,
    icons: ICONS,
  });
  const record = {
    id,
    category: Number(image.slice(0, -4)) % 1000 === 0 ? "beginner" : "job",
    ...skillMetadata(node, image, properties),
    name: text ? value(text, "name", "") : "",
    description: text ? value(text, "desc", "") : "",
    source,
    stringsPresent: Boolean(text),
    strings: metadataTree(text),
    allocationCost: skillAllocationCost(id, properties),
    properties,
    iconPath: `skill/${id}/icon`,
    iconMouseOverPath: node.children.iconMouseOver
      ? `skill/${id}/iconMouseOver`
      : null,
    iconDisabledPath: node.children.iconDisabled
      ? `skill/${id}/iconDisabled`
      : null,
    descriptor,
    visuals: await skillVisuals(context, { id, source, node }),
    sounds: await skillSounds(context, input.soundRoot, key),
  };
  record.classification = classifySkill(record);
  return record;
}

async function skillRecords(context) {
  const paths = imagePaths(context, "Skill");
  const strings = await context.image("String", "Skill.img");
  const soundRoot = await context.image("Sound", "Skill.img");
  const records = Object.create(null);
  const coverage = { playerBooks: [], domains: {}, counts: {}, total: 0 };
  for (const image of paths) {
    if (!/^\d+\.img$/.test(image)) {
      coverage.domains[image] = {
        domain: image.slice(0, -4),
        source: `Skill.wz:${image}`,
        metadata: metadataTree(await context.image("Skill", image)),
        learnable: false,
      };
      continue;
    }
    coverage.playerBooks.push(Number(image.slice(0, -4)));
    const root = at(await context.image("Skill", image), "skill");
    const keys = Object.keys(root.children).sort(
      (a, b) => Number(a) - Number(b),
    );
    if (keys.length + coverage.total > MAX_SKILLS) {
      throw new Error("Player skill catalog bound exceeded");
    }
    for (const key of keys) {
      if (!/^\d+$/.test(key) || !Number.isSafeInteger(Number(key))) {
        throw new Error(`Invalid skill ID ${key}`);
      }
      if (records[Number(key)]) throw new Error(`Duplicate skill ID ${key}`);
      const record = await skillRecord(
        context,
        { key, image, node: at(root, key), soundRoot },
        strings,
      );
      records[Number(key)] = record;
      const category = `${record.classification.activation}:${record.classification.supported ? "supported" : "unavailable"}`;
      coverage.counts[category] = (coverage.counts[category] ?? 0) + 1;
      coverage.total++;
    }
  }
  coverage.playerBooks.sort((a, b) => a - b);
  return { records, coverage };
}

/** Catalog membership describes original templates only; ownership and skill ranks remain profile authorities. */
export async function extractItemSkillUI(context, strings, canvasRecord) {
  const assets = { ...context, canvasRecord };
  const closure = requiredItems(context);
  const sources = await itemSources(context, closure.ids);
  const items = Object.create(null),
    missing = [];
  for (const id of closure.ids) {
    const source = sources.get(id);
    if (!source) {
      missing.push({
        id,
        reason: "No original item/character source in archive index",
      });
      continue;
    }
    if (!strings[id]) {
      missing.push({
        id,
        source: `${source.archive}.wz:${source.path}`,
        reason: "Original item-name record is absent from String.wz",
      });
    }
    const record = await itemRecord(
      assets,
      id,
      source,
      strings[id] ?? { name: null, description: null },
    );
    if (record.available === false) missing.push({ id, ...record });
    else items[id] = record;
  }
  const extractedSkills = await skillRecords(assets);
  const skills = extractedSkills.records;
  return {
    items,
    skills,
    coverage: {
      supportedQuests: closure.supportedQuests,
      requestedItemIds: closure.ids,
      extractedItemIds: Object.keys(items).map(Number),
      missingItems: missing,
      equipmentTemplateIds: EQUIPMENT_IDS,
      skillIds: Object.keys(skills).map(Number),
      skillCoverage: extractedSkills.coverage,
      scope:
        "Complete retained quest/dialog presentation, all admitted server route checks/rewards/shops, every original CashShop commodity and MonsterBook card/reward, selected-map drops and original equipment templates. Numeric player/job skills are exhaustive. Metadata grants no possession or ranks.",
    },
  };
}
