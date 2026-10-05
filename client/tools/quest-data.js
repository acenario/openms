import {
  NPC_MARKUP_FAMILIES,
  NPC_MARKUP_TOKENS,
  npcMarkupId,
} from "../src/npc/npc-script-markup.js";

const MAX_NODES = 200000;
const MAX_QUESTS = 4096;
const MAX_RECORD_NODES = 8192;
const MAX_STRING_NODES = 200000;
const NUMERIC = /^\d+$/;
const CHECK_SCALARS = new Set(["npc", "lvmin", "lvmax", "pop", "endmeso"]);
const INFO_TEXT = new Set([
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
  "medalCategory",
  "viewMedalItem",
]);

/** Preserve every source node and classify exact field shapes, including empty containers. */
function inventoryImage(root, domain) {
  const rows = [];
  const queue = [{ node: root, path: "", depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const { node, path, depth } = queue[index];
    if (depth > 64) throw new Error("Quest metadata depth exceeds policy");
    const row = {
      path,
      type: node.type,
      classification: classify(domain, path, node),
    };
    if (node.value !== undefined) row.value = node.value;
    if (row.classification.startsWith("unsupported")) {
      row.reason = unsupportedReason(domain, path, node);
    }
    rows.push(row);
    for (const [key, child] of Object.entries(node.children)) {
      if (queue.length >= MAX_NODES) {
        throw new Error("Quest image exceeds node policy");
      }
      queue.push({
        node: child,
        path: path ? `${path}/${key}` : key,
        depth: depth + 1,
      });
    }
  }
  return rows;
}

/** Exact path classification avoids treating a nested numeric branch as a normal list. */
function classify(domain, path, node) {
  const parts = path.split("/");
  if (!path || (parts.length === 1 && NUMERIC.test(path))) return "structure";
  if (domain === "Exclusive" || domain === "PQuest") {
    return "unsupported-auxiliary";
  }
  if (domain === "QuestInfo") return classifyInfo(parts);
  if (parts.length === 2 && /^[01]$/.test(parts[1])) return "structure";
  const field = parts.slice(2).join("/");
  if (!/^[01]$/.test(parts[1])) return "unsupported-structure";
  if (domain === "Check") return classifyCheck(field);
  if (domain === "Act") return classifyAct(field, node);
  return classifySay(field, node);
}

function classifyInfo(parts) {
  if (
    parts.length === 2 &&
    (INFO_TEXT.has(parts[1]) || /^[012]$/.test(parts[1]))
  ) {
    return "presentation";
  }
  return "unsupported-control";
}

function unsupportedReason(domain, path, node) {
  const field = path
    .split("/")
    .slice(domain === "QuestInfo" ? 1 : 2)
    .join("/");
  if (/script/.test(field)) {
    return `Referenced script body is absent: ${node.value ?? field}`;
  }
  if (
    /(^|\/)(start|end|interval|dayByDay|dayOfWeek|period|dateExpire|timeLimit|timeLimit2|timerUI|dailyPlayTime)(\/|$)/.test(
      field,
    )
  ) {
    return `Time, expiry or repeat schedule is unavailable: ${field}`;
  }
  const itemReason = unsupportedItemReason(field, node);
  if (itemReason) return itemReason;
  if (/^(auto|normalAuto|oneShot|selected|medal|viewMedal)/.test(field)) {
    return `Original automated/selection/medal control is unavailable: ${field}`;
  }
  if (domain === "Say" || /^(yes|no|ask|stop|\d+)/.test(field)) {
    return `Dialogue branch/control has no supported transition: ${field}`;
  }
  if (domain === "Exclusive" || domain === "PQuest") {
    return "Exclusive medal or party-quest ranking authority is unavailable";
  }
  return `Original ${domain} field requires unimplemented state/consumer semantics: ${field}`;
}

function unsupportedItemReason(field, node) {
  if (/item\/\d+\/prop/.test(field)) {
    return `Invalid weighted item reward probability: prop=${node.value}`;
  }
  if (/item\/\d+\/gender/.test(field)) {
    return `Gender-conditioned reward requires character gender absent from the local profile: ${node.value}`;
  }
  if (/item\/\d+\/(var|name)/.test(field)) {
    return `Special item instance semantics are unavailable: ${field}`;
  }
  return null;
}

function classifyCheck(field) {
  if (CHECK_SCALARS.has(field)) return "supported-condition";
  if (/^job(?:\/\d+)?$/.test(field)) return "supported-condition";
  if (/^(item|mob)(?:\/\d+(?:\/(id|count))?)?$/.test(field)) {
    return "supported-condition";
  }
  if (/^quest(?:\/\d+(?:\/(id|state))?)?$/.test(field)) {
    return "supported-condition";
  }
  return "unsupported-condition";
}

function classifyAct(field, node) {
  if (/^(exp|money|pop)$/.test(field)) return "supported-action";
  if (field === "nextQuest") return "presentation-next-quest";
  if (supportedItemAction(field, node)) return "supported-action";
  if (/^quest(?:\/\d+(?:\/(id|state))?)?$/.test(field)) {
    return "supported-action";
  }
  if (/^(npc|lvmin|lvmax)$/.test(field) || /^job(?:\/\d+)?$/.test(field)) {
    return "supported-condition";
  }
  if (
    /^(start|end|interval|map|fieldEnter|skill|buffItemID|info|npcAct)/.test(
      field,
    )
  ) {
    return "unsupported-action";
  }
  if (/^(\d+|yes|no|ask|stop)(\/|$)/.test(field)) {
    return "retained-embedded-dialogue";
  }
  return "unsupported-action";
}

function supportedItemAction(field, node) {
  if (/^item(?:\/\d+(?:\/(id|count|job))?)?$/.test(field)) return true;
  if (
    /^item\/\d+\/prop$/.test(field) &&
    Number.isSafeInteger(node.value) &&
    node.value >= -1 &&
    node.value <= 0x7fffffff
  ) {
    return true;
  }
  return /^item\/\d+\/gender$/.test(field) && node.value === 2;
}

function classifySay(field, node) {
  if (/^lost(?:\/|$)/.test(field)) return "unsupported-optional-dialogue";
  if (hasPostTransactionChoice(field, node)) return "unsupported-dialogue";
  if (/^(yes|no|stop(?:\/(npc|item|mob|quest|default))?)$/.test(field)) {
    return node.type === "Property"
      ? "supported-dialogue"
      : "unsupported-dialogue";
  }
  if (
    /^(\d+|(yes|no)\/\d+|stop\/(npc|item|mob|quest|default)\/\d+)$/.test(
      field,
    ) &&
    typeof node.value === "string"
  ) {
    return "supported-dialogue";
  }
  if (/^stop\/\d+(?:\/(\d+|answer))?$/.test(field)) return "supported-choice";
  if (field === "ask" && [0, 1].includes(node.value)) return "supported-choice";
  if (field === "npc") return "presentation-npc";
  return "unsupported-dialogue";
}

/** Post-transaction yes/no text cannot introduce another authorizing choice. */
function hasPostTransactionChoice(field, node) {
  return (
    /^(yes|no)\//.test(field) &&
    typeof node.value === "string" &&
    /#L\d+#/.test(node.value)
  );
}

/** WZ scalar/property copy; flat inventory separately retains every original node type. */
function copyTree(root) {
  if (!root) return null;
  if (root.value !== undefined) return root.value;
  const result = Object.create(null);
  const queue = [{ node: root, target: result }];
  for (let index = 0; index < queue.length; index++) {
    const { node, target } = queue[index];
    for (const [key, child] of Object.entries(node.children)) {
      if (queue.length >= MAX_RECORD_NODES) {
        throw new Error("Quest record exceeds policy");
      }
      if (child.value !== undefined) target[key] = child.value;
      else {
        target[key] = Object.create(null);
        queue.push({ node: child, target: target[key] });
      }
    }
  }
  return result;
}

function problem(list, source, reason) {
  list.push({ source, reason });
}

/** Client 0071e1d6 supplies absent item count/state defaults of zero. */
function pairs(value, kind, source, blockers) {
  if (!value || typeof value !== "object") return [];
  const result = [];
  for (const [key, entry] of Object.entries(value)) {
    const field = kind === "quest" ? "state" : "count";
    const count = entry?.[field] ?? 0;
    if (!validPairEntry(key, entry, count)) {
      problem(
        blockers,
        `${source}/${key}`,
        "Invalid or nested condition/action entry",
      );
      continue;
    }
    if (unsupportedPairValue(kind, count)) {
      problem(blockers, `${source}/${key}`, "Unsupported condition value");
    }
    result.push({ id: entry.id, [field]: count, ...entry, index: Number(key) });
  }
  return result;
}

function validPairEntry(key, entry, count) {
  return (
    NUMERIC.test(key) &&
    Number.isSafeInteger(entry?.id) &&
    entry.id > 0 &&
    Number.isSafeInteger(count)
  );
}

function unsupportedPairValue(kind, count) {
  return (
    (kind === "quest" && ![0, 1, 2].includes(count)) ||
    (kind === "mob" && count < 0)
  );
}

function conditions(raw, source, blockers) {
  const result = { items: [], mobs: [], quests: [], jobs: [] };
  if (!raw || typeof raw !== "object") return result;
  for (const key of CHECK_SCALARS) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key])) {
      problem(blockers, `${source}/${key}`, "Condition is not an integer");
    } else result[key] = raw[key];
  }
  if (raw.job) {
    result.jobs = Object.values(raw.job);
    if (result.jobs.some((id) => !Number.isSafeInteger(id) || id < 0)) {
      problem(blockers, `${source}/job`, "Invalid literal job list");
    }
  }
  result.items = pairs(raw.item, "item", `${source}/item`, blockers);
  result.mobs = pairs(raw.mob, "mob", `${source}/mob`, blockers);
  result.quests = pairs(raw.quest, "quest", `${source}/quest`, blockers);
  return result;
}

function actions(raw, source, blockers) {
  const result = {
    items: [],
    quests: [],
    exp: 0,
    money: 0,
    pop: 0,
    nextQuest: null,
  };
  if (!raw || typeof raw !== "object") return result;
  for (const key of ["exp", "money", "pop", "nextQuest"]) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || (key === "exp" && raw[key] < 0)) {
      problem(blockers, `${source}/${key}`, "Invalid reward integer");
    } else result[key] = raw[key];
  }
  result.items = pairs(raw.item, "item", `${source}/item`, blockers);
  result.quests = pairs(raw.quest, "quest", `${source}/quest`, blockers);
  validateItemActions(result.items, source, blockers);
  return result;
}

function validateItemActions(items, source, blockers) {
  let totalWeight = 0;
  for (const entry of items) {
    if (entry.job !== undefined && !Number.isSafeInteger(entry.job)) {
      problem(
        blockers,
        `${source}/item/${entry.index}/job`,
        "Invalid item job mask",
      );
    }
    if ((entry.prop === -1 || entry.prop > 0) && entry.count <= 0) {
      problem(
        blockers,
        `${source}/item/${entry.index}`,
        "Choice or weighted reward must have positive quantity",
      );
    }
    if (entry.prop > 0) totalWeight += entry.prop;
  }
  if (totalWeight > 0x7fffffff) {
    problem(
      blockers,
      `${source}/item`,
      "Reward weights exceed server integer range",
    );
  }
}

function pages(raw) {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .filter(([key, text]) => NUMERIC.test(key) && typeof text === "string")
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([key, text]) => ({ index: Number(key), text }));
}

/** Missing selected stop text advances at 00717ddd..00717e2a; nonempty text terminates. */
function dialogue(input) {
  const result = {
    pages: pages(input),
    yes: pages(input?.yes),
    no: pages(input?.no),
    stop: Object.create(null),
    choices: Object.create(null),
    npc: input?.npc ?? null,
  };
  for (const [key, branch] of Object.entries(input?.stop ?? {})) {
    if (NUMERIC.test(key)) result.choices[key] = branch;
    else result.stop[key] = pages(branch);
  }
  return result;
}

/**
 * A present Say stage without numeric pages sends its accept/complete action
 * without dialogue (00717740/00717963 return 1 at 0071794f/00718070). An absent
 * stage follows the caller's argument at 0071736c and stays blocked, as does a
 * stage whose Act retains numeric text: Act text is never substituted.
 */
function validateDialoguePages(result, { say, act }, source, blockers) {
  if (!say) problem(blockers, source, "Missing Say dialogue stage");
  else if (!result.pages.length && pages(act).length) {
    problem(
      blockers,
      source,
      "No authored Say dialogue pages; embedded Act text is not substituted",
    );
  }
  for (const page of result.pages) {
    if (!/#L\d+#/.test(page.text)) continue;
    if (!result.choices[page.index]) {
      problem(
        blockers,
        `${source}/${page.index}`,
        "Choice text lacks authored stop/result branch",
      );
    }
  }
}

function dependencySet() {
  return {
    npcIds: new Set(),
    mobIds: new Set(),
    itemIds: new Set(),
    questIds: new Set(),
    mapIds: new Set(),
    scriptRefs: new Set(),
    artworkPaths: new Set(),
  };
}

function dependencies(raw, result) {
  const queue = [{ node: raw, path: "" }];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > MAX_RECORD_NODES) {
      throw new Error("Quest dependency count exceeds policy");
    }
    const { node, path } = queue[index];
    if (typeof node === "string") collectTextDependencies(node, path, result);
    if (!node || typeof node !== "object") continue;
    for (const [key, child] of Object.entries(node)) {
      const next = path ? `${path}/${key}` : key;
      collectFieldDependency(key, child, path, result);
      queue.push({ node: child, path: next });
    }
  }
}

function collectTextDependencies(text, path, result) {
  for (const token of text.matchAll(NPC_MARKUP_TOKENS)) {
    const match = /^#([ptivzmocuay@])(\d+)/.exec(token[0]);
    if (match) {
      const id = npcMarkupId(match[1], Number(match[2]));
      if (id > 0) result[NPC_MARKUP_FAMILIES[match[1]]].add(id);
    } else if (/^#[fF]/.test(token[0])) {
      result.artworkPaths.add(token[0].slice(2, -1));
    }
  }
  if (/script$/.test(path) && text) result.scriptRefs.add(text);
}

function collectFieldDependency(key, child, path, result) {
  if (key === "npc" && Number.isSafeInteger(child) && child > 0) {
    result.npcIds.add(child);
  }
  if (key === "viewMedalItem" && Number.isSafeInteger(child) && child > 0) {
    result.itemIds.add(child);
  }
  if (key === "id" && Number.isSafeInteger(child) && child > 0) {
    const family = path.split("/").at(-2);
    const table = { item: "itemIds", mob: "mobIds", quest: "questIds" }[family];
    if (table) result[table].add(child);
  }
}

function compileRecord(id, images, inventories) {
  const record = {
    id: Number(id),
    name: null,
    info: null,
    stages: [],
    blockers: [],
    unavailableBranches: [],
    dependencies: null,
  };
  const deps = collectRecordInventory(id, record, images, inventories);
  record.info = copyTree(images.QuestInfo.children[id]);
  record.name = typeof record.info?.name === "string" ? record.info.name : null;
  validateMedalMetadata(record);
  for (const stage of [0, 1]) {
    record.stages.push(compileStage(id, stage, images, record.blockers));
  }
  record.dependencies = Object.fromEntries(
    Object.entries(deps).map(([key, set]) => [
      key,
      [...set].sort((a, b) =>
        typeof a === "number" ? a - b : a.localeCompare(b),
      ),
    ]),
  );
  record.supported = record.blockers.length === 0;
  return record;
}
/** These fields select native Title presentation; they never authorize a reward or a counter. */
function validateMedalMetadata(record) {
  const info = record.info;
  if (
    info?.medalCategory !== undefined &&
    (!Number.isInteger(info.medalCategory) ||
      info.medalCategory < 0 ||
      info.medalCategory > 3)
  ) {
    problem(
      record.blockers,
      `Quest.wz:QuestInfo.img/${record.id}/medalCategory`,
      "Invalid original medal category",
    );
  }
  if (
    info?.viewMedalItem !== undefined &&
    (!Number.isSafeInteger(info.viewMedalItem) || info.viewMedalItem < 1)
  ) {
    problem(
      record.blockers,
      `Quest.wz:QuestInfo.img/${record.id}/viewMedalItem`,
      "Invalid original displayed medal item",
    );
  }
}

/** Retain optional dialogue separately while every other unsupported source blocks admission. */
function collectRecordInventory(id, record, images, inventories) {
  const deps = dependencySet();
  for (const domain of ["Check", "Act", "Say", "QuestInfo"]) {
    const node = images[domain].children[id];
    if (!node) {
      problem(
        record.blockers,
        `Quest.wz:${domain}.img/${id}`,
        "Missing quest image record",
      );
    }
    if (node) dependencies(copyTree(node), deps);
    for (const row of inventories[domain].byQuest.get(id) ?? []) {
      if (!row.classification.startsWith("unsupported")) continue;
      const target =
        row.classification === "unsupported-optional-dialogue"
          ? record.unavailableBranches
          : record.blockers;
      problem(target, `Quest.wz:${domain}.img/${row.path}`, row.reason);
    }
  }
  return deps;
}

function compileStage(id, stage, images, blockers) {
  const path = `${id}/${stage}`;
  const check = copyTree(images.Check.children[id]?.children[stage]);
  const act = copyTree(images.Act.children[id]?.children[stage]);
  const say = copyTree(images.Say.children[id]?.children[stage]);
  if (!check || !act) {
    problem(
      blockers,
      `Quest.wz:Check/Act.img/${path}`,
      "Missing stage conditions or actions",
    );
  }
  const sayResult = dialogue(say);
  validateDialoguePages(
    sayResult,
    { say, act },
    `Quest.wz:Say.img/${path}`,
    blockers,
  );
  return {
    check: conditions(check, `Quest.wz:Check.img/${path}`, blockers),
    actionCheck: conditions(
      { npc: act?.npc, lvmin: act?.lvmin, lvmax: act?.lvmax, job: act?.job },
      `Quest.wz:Act.img/${path}`,
      blockers,
    ),
    act: actions(act, `Quest.wz:Act.img/${path}`, blockers),
    say: sayResult,
  };
}

/** Original String IMG categories; only original names enter the dialogue resolver. */
function stringNames(context) {
  const result = {
    npc: Object.create(null),
    mob: Object.create(null),
    item: Object.create(null),
  };
  const sources = [
    ["Npc.img", "npc"],
    ["Mob.img", "mob"],
    ["Consume.img", "item"],
    ["Etc.img", "item"],
    ["Eqp.img", "item"],
    ["Ins.img", "item"],
    ["Cash.img", "item"],
    ["Pet.img", "item"],
  ];
  for (const [source, table] of sources) {
    collectNames(context.image("String", source), result[table], "name");
  }
  return result;
}

/**006d3a65: original labels are keyed by NPC script name, not NPC identity/name. */
function npcScriptLabels(context) {
  const root = context.image("Etc", "ScriptInfo.img");
  const entries = Object.entries(root.children);
  if (entries.length > 8192) throw new Error("NPC script label limit exceeded");
  const labels = Object.create(null);
  for (const [name, node] of entries) {
    if (typeof node.value === "string" && node.value.length <= 4096) {
      labels[name] = node.value;
    }
  }
  return labels;
}

/** One bounded original-name traversal; consumers share the published dictionaries. */
function collectNames(root, result, property) {
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    const name = node.children[property]?.value;
    if (NUMERIC.test(node.name) && typeof name === "string") {
      result[Number(node.name)] = name;
    }
    for (const child of Object.values(node.children)) {
      if (queue.length >= MAX_STRING_NODES) {
        throw new Error("Original string lookup exceeds policy");
      }
      if (Object.keys(child.children).length) queue.push(child);
    }
  }
}

/** String.wz:Map.img is canonical catalog metadata, not quest-private data. */
export function extractMapNames(context) {
  const result = Object.create(null);
  collectNames(context.image("String", "Map.img"), result, "mapName");
  return result;
}

function packagedContent(context) {
  const result = {
    maps: [],
    npcs: Object.create(null),
    mobs: Object.create(null),
  };
  if ((context.mapIds?.length ?? 0) > 1024) {
    throw new Error("Quest map content exceeds release policy");
  }
  for (const id of context.mapIds ?? []) {
    result.maps.push(Number(id));
    const map = context.image("Map", `Map/Map${id[0]}/${id}.img`);
    collectMapLife(map, Number(id), result);
  }
  return result;
}

function collectMapLife(map, mapId, result) {
  for (const life of Object.values(map.children.life?.children ?? {})) {
    const kind = life.children.type?.value;
    if (kind !== "n" && kind !== "m") continue;
    const table = kind === "n" ? result.npcs : result.mobs;
    const template = Number(life.children.id?.value);
    if (!Number.isSafeInteger(template)) {
      throw new Error("Invalid quest content life ID");
    }
    if (!table[template]) table[template] = [];
    if (!table[template].includes(mapId)) table[template].push(mapId);
  }
}
/** Preserve authored category labels verbatim, including Korean labels in this archive. */
function categoryLabels(context, image) {
  const root = context.image("Etc", image);
  const labels = Object.create(null);
  const rows = Object.entries(root.children);
  if (rows.length > MAX_QUESTS) throw new Error("Quest category bound");
  for (const [id, node] of rows) {
    if (!NUMERIC.test(id) || typeof node.value !== "string") {
      throw new Error(`Invalid original quest category ${image}/${id}`);
    }
    labels[id] = node.value;
  }
  return { source: `Etc.wz:${image}`, labels };
}

/** Full six-image inventory plus generic executable projections, never an admitted-ID whitelist. */
export function extractQuests(context) {
  const images = Object.create(null),
    inventories = Object.create(null),
    ids = new Set();
  const fields = Object.create(null);
  for (const domain of [
    "Check",
    "Act",
    "Say",
    "QuestInfo",
    "Exclusive",
    "PQuest",
  ]) {
    images[domain] = context.image("Quest", `${domain}.img`);
    const rows = inventoryImage(images[domain], domain);
    const byQuest = new Map();
    for (const row of rows) {
      const id = row.path.split("/")[0];
      if (NUMERIC.test(id)) {
        if (!byQuest.has(id)) byQuest.set(id, []);
        byQuest.get(id).push(row);
        if (domain !== "PQuest") ids.add(id);
      }
      const family = `${domain}/${row.path.replace(/\b\d+\b/g, "*")}`;
      if (!fields[family]) fields[family] = { count: 0, classifications: [] };
      fields[family].count++;
      if (!fields[family].classifications.includes(row.classification)) {
        fields[family].classifications.push(row.classification);
      }
    }
    inventories[domain] = { source: `Quest.wz:${domain}.img`, rows, byQuest };
  }
  if (ids.size > MAX_QUESTS) throw new Error("Quest catalog exceeds policy");
  const records = Object.create(null);
  for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
    records[id] = compileRecord(id, images, inventories);
  }
  const inventory = Object.fromEntries(
    Object.entries(inventories).map(([key, data]) => [
      key,
      { source: data.source, rows: data.rows },
    ]),
  );
  return {
    schemaVersion: 1,
    records,
    inventory,
    fields,
    strings: stringNames(context),
    npcScriptLabels: npcScriptLabels(context),
    categories: categoryLabels(context, "QuestCategory.img"),
    medalCategories: categoryLabels(context, "MedalQuestCategory.img"),
    content: packagedContent(context),
    policy:
      "Synchronous local one-shot quest authority; original rules and text, no missing scripts/time-control semantics or invented drops",
  };
}
