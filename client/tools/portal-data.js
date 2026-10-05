import { createHash } from "node:crypto";
import {
  TUTORIAL_PORTAL_PROGRAMS,
  tutorialPortalKind,
} from "../src/npc/npc-script-portals.js";

/** Translate only complete, hash-verified authorized programs into the finite tutorial IR. */
export function compileTutorialPortal({ script, text }) {
  const program = TUTORIAL_PORTAL_PROGRAMS[script];
  if (
    !program ||
    createHash("sha256").update(text).digest("hex") !== program.sha256
  ) {
    throw new Error(
      `Unsupported or changed authored tutorial portal source: ${script}`,
    );
  }
  return program;
}

import { at, value, resolveNode } from "../src/assets/image.js";
import {
  marketPortalKind,
  portalRouteStatus,
  scriptedPortalKind,
} from "../src/world/portal-system.js";

const MAX_PLAYABLE_MAPS = 1024;
const MAX_NPC_PLACEMENTS = 4096;
const MAX_NPC_DESTINATIONS = 32768;

function mapPortals(context, mapId) {
  const map = context.image("Map", `Map/Map${mapId[0]}/${mapId}.img`);
  const nodes = Object.values(map.children.portal?.children ?? {});
  if (nodes.length > MAX_PORTALS) {
    throw new Error("Portal closure record bound exceeded");
  }
  return nodes;
}

function routeFields(node) {
  return {
    id: Number(node.name),
    name: value(node, "pn"),
    type: value(node, "pt"),
    targetMap: value(node, "tm"),
    targetName: value(node, "tn"),
  };
}

function destinationStatus(context, portal, target) {
  const nodes = mapPortals(context, target);
  let matches = 0;
  for (const node of nodes) {
    if (
      portal.targetPortalId !== undefined
        ? Number(node.name) === portal.targetPortalId
        : value(node, "pn") === portal.targetName
    ) {
      matches++;
    }
  }
  if (matches === 0) return "missing-named-destination";
  if (matches !== 1) return "ambiguous-named-destination";
  return null;
}

function closureRoute(portal, raw, source) {
  const market = marketPortalKind(portal, raw);
  if (market === "entry" && source !== "910000000") {
    return { ...portal, targetMap: 910000000, targetName: "out00" };
  }
  // Dynamic return destinations are the already-admitted entry source fields.
  // Include the authored no-saved-location fallback even when market is a seed.
  if (market === "return") {
    return {
      ...portal,
      targetMap: 100000000,
      targetName: null,
      targetPortalId: 0,
    };
  }
  return portal;
}

/** Bounded source-driven closure; unsupported scripts and malformed named routes stay explicit.
 * context.image owns decoding/cache and must fail on missing/corrupt original IMG dependencies.
 * @returns {{ids:string[],blocked:object[]}} */
export function collectPlayableMaps(context, seeds) {
  if (
    !Array.isArray(seeds) ||
    !seeds.length ||
    seeds.length > MAX_PLAYABLE_MAPS ||
    seeds.some((id) => typeof id !== "string" || !/^\d{9}$/.test(id))
  ) {
    throw new Error("Invalid playable-map seed set");
  }
  const ids = [...new Set(seeds)],
    seen = new Set(ids),
    blocked = [];
  const closure = { ids, seen, blocked, npcIds: new Set() };
  for (let index = 0; index < ids.length; index++) {
    const source = ids[index];
    for (const node of mapPortals(context, source)) {
      const target = admitClosureRoute(context, source, node, blocked);
      if (target !== null) appendDestination(closure, target);
    }
    admitNpcDestinations(context, source, closure);
  }
  return { ids: ids.sort(), blocked };
}

function appendDestination(closure, target) {
  if (closure.seen.has(target)) return;
  if (closure.ids.length >= MAX_PLAYABLE_MAPS) {
    throw new Error(
      "Playable map closure exceeds 1024 maps; select an explicit release",
    );
  }
  closure.seen.add(target);
  closure.ids.push(target);
}

/** A saved return points back into this closure; finite authored NPC destinations extend it. */
export function admitNpcDestinations(context, source, closure) {
  if (!context.npcRoutes) return;
  const map = context.image("Map", `Map/Map${source[0]}/${source}.img`);
  const placements = Object.values(map.children.life?.children ?? {});
  if (placements.length > MAX_NPC_PLACEMENTS) {
    throw new Error("NPC placement limit exceeded");
  }
  for (const node of placements) {
    if (value(node, "type") !== "n") continue;
    const id = Number(value(node, "id"));
    const route = context.npcRoutes.get(id);
    if (!route || closure.npcIds.has(id)) continue;
    closure.npcIds.add(id);
    admitNpcRoute(context, source, route, closure);
  }
  admitPortalNpcDestinations(context, source, closure);
  admitTransportDestinations(context, source, closure);
}

/** Any map a published transport touches admits all of them: both directions'
 * waiting rooms, rides, cabins and stations, since a waiting room may only be
 * reachable through an unsupported NPC. One unavailable map blocks the whole
 * transport so no passenger boards a ride without a packaged destination. */
function admitTransportDestinations(context, source, closure) {
  for (const [event, schedule] of Object.entries(
    context.transportSchedules ?? {},
  )) {
    const targets = schedule.mapIds.map((id) => String(id).padStart(9, "0"));
    if (!targets.includes(source)) continue;
    const missing = targets.filter(
      (target) =>
        !context.imageEntries("Map").has(`Map/Map${target[0]}/${target}.img`),
    );
    if (missing.length) {
      for (const target of missing) {
        closure.blocked.push({
          source,
          event,
          target,
          reason: "transport-map-unavailable",
        });
      }
      continue;
    }
    admitDestinationMaps(context, { source, event }, targets, closure);
  }
}

/** A supported online portal script contributes its finite literal warp maps. */
function supportedPortalScript(context, portal, raw) {
  const script = scriptedPortalKind(portal, raw);
  const compilation = script ? context.portalScripts?.[script] : null;
  return compilation?.status === "supported" ? compilation : null;
}

function admitPortalNpcDestinations(context, source, closure) {
  // Portal-opened NPCs need no physical life placement, but use the same authored closure.
  for (const node of mapPortals(context, source)) {
    const raw = { script: value(node, "script", "") };
    const compilation = supportedPortalScript(context, routeFields(node), raw);
    if (compilation) {
      admitDestinationMaps(
        context,
        { source, portalScript: raw.script },
        compilation.dependencies.mapIds,
        closure,
      );
      continue;
    }
    const script = tutorialPortalKind(routeFields(node), raw);
    const npc = TUTORIAL_PORTAL_PROGRAMS[script]?.openNpc;
    if (!npc || closure.npcIds.has(npc.npcId)) continue;
    const route = context.npcRoutes.get(npc.npcId);
    if (!route) throw new Error(`Missing supported portal NPC: ${npc.npcId}`);
    closure.npcIds.add(npc.npcId);
    admitNpcRoute(context, source, route, closure);
  }
}

function admitNpcRoute(context, source, route, closure) {
  admitDestinationMaps(
    context,
    { source, npcId: route.npcId },
    route.dependencies.mapIds,
    closure,
  );
}

function admitDestinationMaps(context, owner, targets, closure) {
  if (targets.length > MAX_NPC_DESTINATIONS) {
    throw new Error("NPC destination limit exceeded");
  }
  for (const id of targets) {
    const target = String(id).padStart(9, "0");
    if (!context.imageEntries("Map").has(`Map/Map${target[0]}/${target}.img`)) {
      closure.blocked.push({
        ...owner,
        target,
        reason: "npc-destination-map-unavailable",
      });
      continue;
    }
    appendDestination(closure, target);
  }
}

/** Resolve and validate one authored edge before admitting its destination. */
export function admitClosureRoute(context, source, node, blocked) {
  const authored = routeFields(node);
  const raw = { script: value(node, "script", "") };
  if (tutorialPortalKind(authored, raw)) return null;
  // Its literal warp maps join through admitNpcDestinations.
  if (supportedPortalScript(context, authored, raw)) return null;
  const portal = closureRoute(authored, raw, source);
  let reason = portalRouteStatus(authored, raw);
  if (source === "910000000" && marketPortalKind(authored, raw) === "entry") {
    reason = "already-in-free-market";
  }
  const target = Number.isInteger(portal.targetMap)
    ? String(portal.targetMap).padStart(9, "0")
    : null;
  if (!reason) reason = destinationStatus(context, portal, target);
  if (!reason) return target;
  blocked.push({
    source,
    portalId: portal.id,
    name: portal.name,
    target,
    targetName: portal.targetName,
    ...(portal.targetPortalId !== undefined
      ? { targetPortalId: portal.targetPortalId }
      : {}),
    reason,
  });
  return null;
}

const MAX_PORTALS = 4096;
const MAX_FRAMES = 1024;
// Original 0xc0041f78 minus common B=-0x40000000, matching existing map depths.
const PORTAL_DEPTH = 270200;
// 0043ea3e -> 0043f768: PUSH 0x78 before reading string ID 0x15f8.
const ORIGINAL_FRAME_DELAY_MS = 120;
const STATES = ["portalStart", "portalContinue", "portalExit"];

/** Shared frame extraction retains alpha and original origins; normalize WZ numeric strings. */
async function portalFrames(context, node) {
  node = resolveNode(node);
  const children = Object.keys(node.children)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));
  if (!children.length || children.length > MAX_FRAMES) {
    throw new Error("Portal frame count exceeds extraction bounds");
  }
  const result = await context.frames(node);
  if (result.length !== children.length) {
    throw new Error("Portal frame count mismatch");
  }
  for (let index = 0; index < result.length; index++) {
    const delay = Number(
      value(at(node, children[index]), "delay", ORIGINAL_FRAME_DELAY_MS),
    );
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new Error("Invalid portal frame delay");
    }
    result[index].delay = delay;
  }
  return result;
}

/** Original helper selection; unknown named variants are not silently replaced by default. */
export function graphics(node) {
  const type = value(node, "pt", null);
  if (type === 2 || type === 4 || type === 7) return "portal/game/pv";
  if (type !== 10 && type !== 11) return null;
  const image = value(node, "image", "");
  if (typeof image !== "string" && typeof image !== "number") {
    throw new Error("Invalid portal image variant");
  }
  const variant = image === "" ? "default" : String(image);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(variant)) {
    throw new Error("Invalid portal variant name");
  }
  return `portal/game/${type === 10 ? "ph" : "psh"}/${variant}`;
}

/** Resolve and cache one bounded original portal animation family. */
async function cachedActions(context, helper, path, cache) {
  if (cache.has(path)) return cache.get(path);
  let resource = helper;
  for (const key of path.split("/")) resource = resource?.children[key];
  if (!resource) return null;
  const actions = {};
  if (path === "portal/game/pv") {
    actions.default = await portalFrames(context, resource);
  } else {
    for (const state of STATES) {
      actions[state] = await portalFrames(context, at(resource, state));
    }
  }
  // 0071332c deliberately uses ph Continue even for psh Start/Exit (type11).
  if (path.startsWith("portal/game/psh/")) {
    const continuePath = path.replace("/psh/", "/ph/");
    let continueResource = helper;
    for (const key of continuePath.split("/")) {
      continueResource = continueResource?.children[key];
    }
    if (!continueResource?.children.portalContinue) return null;
    actions.portalContinue = await portalFrames(
      context,
      at(continueResource, "portalContinue"),
    );
  }
  cache.set(path, actions);
  return actions;
}

/** No route metadata is duplicated here: portalId indexes physics.portals/$portalProperties. */
function activation(node) {
  const type = value(node, "pt");
  if (value(node, "script", "") !== "") return "server-script";
  if (type === 0) return "spawn";
  if (type === 6) return "special-field-loader";
  if (type === 9) return "automatic-server-script";
  if (type === 12 || type === 13) return "automatic-impact";
  if (type === 3) return "automatic-and-up";
  if (type === 10 || type === 11) return "hidden-up";
  if ([1, 2, 4, 5, 7, 8].includes(type)) return "ordinary-up";
  return "unknown-type";
}

export async function extractOne(context, node, helper, actionCache) {
  const path = graphics(node);
  const record = {
    portalId: Number(node.name),
    entityId: null,
    graphics: path,
    status: "metadata-only",
    activation: activation(node),
  };
  const tutorial = tutorialPortalKind(routeFields(node), {
    script: value(node, "script", ""),
  });
  if (tutorial) {
    const program = context.portalPrograms?.[tutorial];
    if (
      !program ||
      program.sha256 !== TUTORIAL_PORTAL_PROGRAMS[tutorial].sha256
    ) {
      throw new Error(`Missing verified tutorial portal program: ${tutorial}`);
    }
    record.tutorialProgram = program;
  }
  if (!path) return { entity: null, record };
  const actions = await cachedActions(context, helper, path, actionCache);
  if (!actions) {
    record.status = "unsupported-missing-original-artwork";
    return { entity: null, record };
  }
  const x = Number(value(node, "x")),
    y = Number(value(node, "y"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Nonfinite portal placement");
  }
  const hidden = value(node, "pt") === 10 || value(node, "pt") === 11;
  const entity = {
    id: `portal:${node.name}`,
    kind: "portal",
    order: Number(node.name),
    x,
    y,
    z: PORTAL_DEPTH,
    visible: !hidden,
    flip: false,
    opacity: 1,
    action: hidden ? "portalStart" : "default",
    actions,
  };
  record.entityId = entity.id;
  record.status = hidden ? "proximity-state-graphics" : "looping-graphics";
  return { entity, record };
}

/** Extract bounded original portal graphics into the map's existing region/atlas path.
 * All placements, including invisible/script/sentinel/special records, are accounted for.
 */
export async function extractPortals(context, map, mapId) {
  if (!/^\d{9}$/.test(String(mapId))) {
    throw new Error("Invalid portal map identity");
  }
  const nodes = Object.values(map.children.portal?.children ?? {});
  if (nodes.length > MAX_PORTALS) {
    throw new Error("Portal count exceeds extraction bounds");
  }
  const helper = context.image("Map", "MapHelper.img");
  const entities = [],
    records = [],
    actionCache = new Map();
  for (const node of nodes) {
    if (!/^\d+$/.test(node.name) || !Number.isSafeInteger(Number(node.name))) {
      throw new Error("Invalid original portal index");
    }
    const result = await extractOne(context, node, helper, actionCache);
    records.push(result.record);
    if (result.entity) entities.push(result.entity);
  }
  return {
    entities,
    presentation: {
      schemaVersion: 1,
      records,
      provenance:
        "Map.wz:MapHelper.img; original 0071165a,00712313,0071259d,00712827,00712d35,0071332c",
      timing: {
        defaultFrameMs: ORIGINAL_FRAME_DELAY_MS,
        evidence: "0043ea3e -> 0043f768",
      },
      mode: "offline-packaged-traversal-not-server-authorization",
    },
  };
}
