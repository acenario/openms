import { at, value } from "../src/assets/image.js";
import { LIMITS } from "../src/rendering/stream-validation.js";

export const defaultRoots = Object.freeze([
  "100000000",
  "100000001",
  "103040000",
  "108000500",
  "120000000",
  "200090500",
  "211040000",
  "230000000",
  "000010000",
  "000000000",
  "000000001",
  "000000003",
  "101000100",
  "101000102",
  "105040310",
  "105040312",
  "105040314",
  "103000900",
  "103000903",
  "103000906",
]);

/** Explicit release IDs use the same finite input boundary as extraction. */
export function selectedMapIds(maps = defaultRoots) {
  const ids = typeof maps === "string" ? maps.split(",") : maps;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > LIMITS.maps ||
    ids.some((id) => typeof id !== "string" || !/^\d{9}$/.test(id))
  ) {
    throw new Error(
      `--maps requires at most ${LIMITS.maps} comma-separated nine-digit IDs`,
    );
  }
  return [...new Set(ids)].sort();
}

/** Iterative original foothold traversal; derived camera fallback remains explicitly unverified. */
export function mapBounds(map) {
  const info = at(map, "info");
  const extents = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  const queue = [at(map, "foothold")];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > 100000) {
      throw new Error("Foothold traversal limit exceeded");
    }
    const node = queue[i];
    if (!node.children.x1) {
      queue.push(...Object.values(node.children));
      continue;
    }
    extents.left = Math.min(extents.left, value(node, "x1"), value(node, "x2"));
    extents.right = Math.max(
      extents.right,
      value(node, "x1"),
      value(node, "x2"),
    );
    extents.top = Math.min(extents.top, value(node, "y1"), value(node, "y2"));
    extents.bottom = Math.max(
      extents.bottom,
      value(node, "y1"),
      value(node, "y2"),
    );
  }
  const bounds = {
    left: value(info, "VRLeft", extents.left - 100),
    right: value(info, "VRRight", extents.right + 100),
    top: value(info, "VRTop", extents.top - 500),
    bottom: value(info, "VRBottom", extents.bottom + 100),
  };
  if (!Object.values(bounds).every(Number.isFinite)) {
    throw new Error("Map has no finite bounds/footholds");
  }
  return bounds;
}

/** The actual authored spawn is required by both preflight and initial placement. */
export function spawnPortal(map) {
  const portal = Object.values(at(map, "portal").children).find(
    (entry) => value(entry, "pn") === "sp",
  );
  if (!portal) throw new Error("Map has no spawn portal for initial placement");
  return portal;
}
