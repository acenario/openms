import { at, value } from "../src/assets/image.js";
import { LIMITS } from "../src/rendering/stream-validation.js";

const MAX_MAPS = LIMITS.maps;
const MAX_LIFE = 65536;
const MAX_MOB_ROWS = 256;
const MAX_ITEMS = 32768;
const MAX_DROP_ROWS = 200000;
// Client00506e62 InsertCanvas delays (ms): docs/ghidra-drop-motion/drop-native-helpers.txt.
const MESO_FRAME_DELAYS = Object.freeze([
  Object.freeze([80, 80, 80, 80]),
  Object.freeze([80, 80, 80, 80]),
  Object.freeze([200, 200, 200, 200]),
  Object.freeze([4000, 120, 120, 120]),
]);

function selectedMobs(context) {
  if (!Array.isArray(context.mapIds) || context.mapIds.length > MAX_MAPS) {
    throw new Error("Drop map closure exceeds limit");
  }
  const mobs = Object.create(null);
  for (const id of context.mapIds) {
    const map = context.image("Map", `Map/Map${id[0]}/${id}.img`);
    if (!map.children.life) continue;
    const life = Object.values(at(map, "life").children);
    if (life.length > MAX_LIFE) throw new Error("Drop map life limit");
    for (const node of life) {
      if (value(node, "type", null) !== "m") continue;
      const mobId = Number(value(node, "id", null));
      if (!Number.isSafeInteger(mobId) || mobId <= 0) {
        throw new Error("Invalid drop mob ID");
      }
      mobs[mobId] ??= { rows: [], maps: [] };
      if (!mobs[mobId].maps.includes(id)) mobs[mobId].maps.push(id);
    }
  }
  return mobs;
}

/** The canonical server conversion owns SQL parsing; this projection retains its exact row provenance. */
function compiledDropRows(dataset) {
  if (
    dataset?.domain !== "drops" ||
    !Array.isArray(dataset.tables?.drop_data)
  ) {
    throw new Error("Canonical drop dataset is required");
  }
  const rows = dataset.tables.drop_data;
  if (!rows.length || rows.length > MAX_DROP_ROWS) {
    throw new Error("Canonical drop row bound");
  }
  const sources = dataset.tableSources?.drop_data;
  if (
    !Array.isArray(sources) ||
    !sources.length ||
    sources.length > MAX_DROP_ROWS
  ) {
    throw new Error("Canonical drop source bound");
  }
  validateDropSources(rows, sources);
  return { rows, sources };
}

/** Source spans must cover the canonical table in its original row order. */
function validateDropSources(rows, sources) {
  let firstRow = 1;
  for (const source of sources) {
    if (
      source.firstRow !== firstRow ||
      !Number.isSafeInteger(source.rowCount) ||
      source.rowCount < 1 ||
      typeof source.source !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    ) {
      throw new Error(
        "Canonical drop source rows are incomplete or lack original hashes",
      );
    }
    firstRow += source.rowCount;
  }
  if (firstRow !== rows.length + 1) {
    throw new Error("Canonical drop source coverage differs from table rows");
  }
}

/** Project selected mobs while validating every canonical row, including unselected mobs. */
function collectDropItems(mobs, rows, sources) {
  const itemIds = new Set();
  let sourceIndex = 0;
  for (let index = 0; index < rows.length; index++) {
    if (
      sourceIndex + 1 < sources.length &&
      index + 1 >= sources[sourceIndex + 1].firstRow
    ) {
      sourceIndex++;
    }
    const row = rows[index];
    const {
      dropperid: mobId,
      itemid: itemId,
      minimum_quantity: minimum,
      maximum_quantity: maximum,
      questid: questId,
      chance,
    } = row;
    if (
      ![mobId, itemId, minimum, maximum, questId, chance].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      throw new Error("Invalid canonical drop integer");
    }
    const mob = mobs[mobId];
    if (!mob) continue;
    if (mob.rows.length >= MAX_MOB_ROWS) {
      throw new Error(`Drop row limit: ${mobId}`);
    }
    const reason = rowReason(itemId, minimum, maximum);
    mob.rows.push({
      itemId,
      minimum,
      maximum,
      questId,
      chance,
      sourceRow: index + 1,
      source: sources[sourceIndex].source,
      status: reason ? "unavailable" : "supported",
      reason,
    });
    if (itemId && !reason) itemIds.add(itemId);
  }
  if (itemIds.size > MAX_ITEMS) {
    throw new Error("Drop item closure exceeds limit");
  }
  return itemIds;
}

/** Cosmic is an authorized SERVER reference, never original Nexon drop authority. */
export function extractDropData(context, dataset) {
  const mobs = selectedMobs(context);
  const { rows, sources } = compiledDropRows(dataset);
  const itemIds = collectDropItems(mobs, rows, sources);
  for (const entries of Object.values(dataset.reactors?.rows ?? {})) {
    for (const row of entries) itemIds.add(row.itemId);
  }
  return {
    schemaVersion: 1,
    mobs,
    reactors: dataset.reactors,
    itemIds: [...itemIds].sort((a, b) => a - b),
    provenance: {
      authority: "Cosmic-server-reference/local-offline-policy",
      sources,
      parsedRows: rows.length,
      rate: "1x; floor(random*999999) < chance",
      quantity:
        "Cosmic maximum-exclusive range; equal endpoints are fixed local policy",
      equipment:
        "original base templates; no Cosmic randomized instance statistics",
      quests:
        "questid requires active durable quest; no party/party-quest/world-event gates",
      scope:
        "All per-mob SQL rows for authored mob placements in the selected map closure. Global drops are not enabled.",
    },
  };
}

function rowReason(itemId, minimum, maximum) {
  if (minimum < 1 || maximum < minimum) {
    return "Invalid or empty quantity range";
  }
  if (itemId && (itemId < 1000000 || itemId > 5999999)) {
    return "Item category cannot be represented by the inventory catalog";
  }
  return null;
}

/** Missing original templates remain addressable unavailable rows, never invented artwork. */
export function finalizeDropData(data, items) {
  let supported = 0;
  const unavailable = [];
  for (const [mobId, mob] of Object.entries(data.mobs)) {
    for (const row of mob.rows) {
      if (
        row.status === "supported" &&
        row.itemId &&
        !items[row.itemId]?.descriptor
      ) {
        row.status = "unavailable";
        row.reason =
          "No original item metadata/artwork in the extracted catalog";
      }
      if (row.status === "supported") supported++;
      else unavailable.push({ mobId: Number(mobId), ...row });
    }
  }
  data.coverage = { supportedRows: supported, unavailableRows: unavailable };
  return data;
}

/** Currency uses the same immutable canvas/atlas bundles as inventory icons. */
export async function extractDropArtwork(context, canvasRecord) {
  const root = context.image("Item", "Special/0900.img");
  const assets = Object.create(null),
    entities = [],
    variants = [];
  for (let variant = 0; variant < 4; variant++) {
    const frames = [];
    for (let frame = 0; frame < 4; frame++) {
      const source = `0900000${variant}/iconRaw/${frame}`;
      const node = at(root, source);
      if (node.type !== "Canvas") {
        throw new Error(`Missing original currency canvas ${source}`);
      }
      const path = `drop/meso/${variant}/${frame}`;
      const record = await canvasRecord(context, node, path, entities.length);
      record.asset.delay = MESO_FRAME_DELAYS[variant][frame];
      entities.push(record.entity);
      assets[path] = record.asset;
      frames.push({ path, delay: record.asset.delay });
    }
    variants.push(frames);
  }
  return {
    variants,
    descriptor: await context.bundle({
      id: "drop:currency",
      entities,
      metadata: { source: "Item.wz:Special/0900.img", assets },
    }),
  };
}
