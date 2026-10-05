import { packageAtlases, resource } from "./atlas.js";
import { expandCanvasParts } from "./canvas-tiles.js";

export const REGION_SIZE = 1024;
const MAX_ENTITIES = 100000;
/** Retain all animation-frame extents, including flipped origins. */
function entityBounds(entity, pixels) {
  const bounds = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  for (const frames of Object.values(entity.actions)) {
    for (const frame of frames) {
      for (const part of frame.parts) {
        const texture = pixels[part.texture];
        const left =
          entity.x + (entity.flip ? -part.x - texture.width : part.x);
        const top = entity.y + part.y;
        bounds.left = Math.min(bounds.left, left);
        bounds.right = Math.max(bounds.right, left + texture.width);
        bounds.top = Math.min(bounds.top, top);
        bounds.bottom = Math.max(bounds.bottom, top + texture.height);
      }
    }
  }
  if (!Object.values(bounds).every(Number.isFinite)) {
    throw new Error(`Invalid entity bounds ${entity.id}`);
  }
  return bounds;
}
/** Texture dependencies include inactive actions, avoiding mid-animation holes. */
function textureIds(entities) {
  const ids = new Set();
  for (const entity of entities) {
    for (const frames of Object.values(entity.actions)) {
      for (const frame of frames) {
        for (const part of frame.parts) ids.add(part.texture);
      }
    }
  }
  return ids;
}
/** Single ownership; a region's bounds include artwork overhanging its cell. */
function splitRegions(entities, pixels) {
  if (entities.length > MAX_ENTITIES) {
    throw new Error("Map entity policy exceeded");
  }
  const regions = new Map();
  for (const entity of entities) {
    if (entity.kind === "character" || entity.kind === "mob") continue;
    const extent = entityBounds(entity, pixels);
    const spanning =
      extent.right - extent.left > REGION_SIZE ||
      extent.bottom - extent.top > REGION_SIZE;
    const always = Boolean(entity.background) || spanning;
    const x = Math.floor(entity.x / REGION_SIZE),
      y = Math.floor(entity.y / REGION_SIZE);
    const id = always ? `always-${entity.id}` : `${x},${y}`;
    if (!regions.has(id)) {
      regions.set(id, { id, always, bounds: { ...extent }, entities: [] });
    }
    const region = regions.get(id);
    region.entities.push(entity);
    region.bounds.left = Math.min(region.bounds.left, extent.left);
    region.bounds.top = Math.min(region.bounds.top, extent.top);
    region.bounds.right = Math.max(region.bounds.right, extent.right);
    region.bounds.bottom = Math.max(region.bounds.bottom, extent.bottom);
  }
  return [...regions.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}
/** Produce independently fetchable immutable manifests before catalog publication. */
export async function packageMap(scene, state) {
  expandCanvasParts(scene.entities, state);
  const actors = scene.entities.filter((entity) => entity.kind === "character");
  const atlasIds = new Set(await packageAtlases(state, textureIds(actors)));
  const renderables = await packageMobs(scene, state, atlasIds);
  const regions = [];
  for (const region of splitRegions(scene.entities, state.pixels)) {
    const atlases = await packageAtlases(state, textureIds(region.entities));
    for (const id of atlases) atlasIds.add(id);
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        id: region.id,
        entities: region.entities,
      }),
    );
    const descriptor = await resource(state.output, "regions", "json", bytes);
    state.regions[descriptor.sha256] = descriptor;
    regions.push({
      id: region.id,
      bounds: region.bounds,
      ...descriptor,
      atlases,
      always: region.always,
    });
  }
  const textures = Object.create(null),
    atlases = Object.create(null);
  for (const id of [...textureIds(scene.entities)].sort()) {
    textures[id] = state.textures[id];
  }
  for (const id of [...atlasIds].sort()) atlases[id] = state.atlases[id];
  const manifest = {
    schemaVersion: 2,
    id: scene.id,
    source: scene.source,
    bounds: scene.bounds,
    camera: scene.camera,
    physics: scene.physics,
    textures,
    atlases,
    actors,
    regions,
    evidence: scene.evidence,
    equipment: scene.equipment,
    portalPresentation: scene.portalPresentation,
    combat: scene.combat,
    reactors: scene.reactors,
    life: scene.life ? { ...scene.life, renderables } : scene.life,
  };
  const descriptor = await resource(
    state.output,
    "maps",
    "json",
    Buffer.from(JSON.stringify(manifest)),
  );
  return { descriptor, manifest };
}

/** Dynamic mob artwork is leased by template, never by an authored static cell. */
async function packageMobs(scene, state, atlasIds) {
  const renderables = Object.create(null);
  const placements = new Map(
    scene.life?.placements.map((record) => [record.id, record]) ?? [],
  );
  for (const entity of scene.entities) {
    if (entity.kind !== "mob") continue;
    // An unplaced server spawn (transport invasion) names its template directly.
    const key = placements.get(entity.id)?.template ?? entity.template;
    if (!key) throw new Error("Mob artwork lacks authored placement");
    if (renderables[key]) continue;
    const atlases = await packageAtlases(state, textureIds([entity]));
    for (const id of atlases) atlasIds.add(id);
    const bounds = entityBounds(entity, state.pixels);
    bounds.left -= entity.x;
    bounds.right -= entity.x;
    bounds.top -= entity.y;
    bounds.bottom -= entity.y;
    renderables[key] = { entity, atlases, bounds };
  }
  return renderables;
}

/** UI/effect bundles share exact texture identities, atlas packing and byte verification. */
export async function packageVisualBundle(bundle, state) {
  if (bundle.entities.length > MAX_ENTITIES) {
    throw new Error("Visual bundle entity policy exceeded");
  }
  expandCanvasParts(bundle.entities, state);
  const ids = textureIds(bundle.entities);
  const atlasIds = await packageAtlases(state, ids);
  const textures = Object.create(null),
    atlases = Object.create(null);
  for (const id of [...ids].sort()) textures[id] = state.textures[id];
  for (const id of [...atlasIds].sort()) atlases[id] = state.atlases[id];
  return resource(
    state.output,
    "bundles",
    "json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: bundle.id,
        entities: bundle.entities,
        metadata: bundle.metadata,
        textures,
        atlases,
      }),
    ),
  );
}
