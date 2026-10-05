const MAX_PORTALS = 4096;

/** Validate a destination's extracted portal collection before field preparation. */
function destinationPortals(manifest) {
  const portals = manifest.physics.portals;
  if (!Array.isArray(portals) || portals.length > MAX_PORTALS) {
    throw new Error("Invalid destination portal collection");
  }
  return portals;
}

/** Coordinates are original world pixels at the portal's feet. */
function validatePosition(position) {
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) {
    throw new Error("Nonfinite field arrival coordinate");
  }
}

/** Native field entry0094969d subtracts ten pixels after selecting a portal. */
function portalArrival(portal) {
  validatePosition(portal);
  return { x: portal.x, y: portal.y - 10 };
}

/** The unique portal whose ID or name equals the selector, or null. */
function selectPortal(manifest, byId, selector) {
  let selected = null;
  for (const portal of destinationPortals(manifest)) {
    if ((byId ? portal.id : portal.name) !== selector) continue;
    if (selected) throw new Error(`Ambiguous destination portal ${selector}`);
    selected = portal;
  }
  return selected;
}

/** Field links select a unique name; family travel selects original portal zero by ID.
 * An authored name absent from the destination falls back to portal ID0, as Cosmic
 * GenericPortal.enterPortal `to.getPortal(target) ?? to.getPortal(0)`. */
export function arrivalPosition(manifest, selector) {
  if (selector === null) return null;
  const byId = Number.isInteger(selector) && selector >= 0;
  if (
    !byId &&
    (typeof selector !== "string" || !selector || selector.length > 128)
  ) {
    throw new Error("Invalid destination portal selector");
  }
  const selected =
    selectPortal(manifest, byId, selector) ??
    (byId ? null : selectPortal(manifest, true, 0));
  if (!selected) throw new Error(`Destination portal ${selector} unavailable`);
  return portalArrival(selected);
}

/** Browser reload policy: nearest authored unlinked type0/1 player spawn in XY.
 * Eligibility/distance: authorized MapleMap.findClosestPlayerSpawnpoint reference,
 * not a recovered native save algorithm. Equal distances use the lowest WZ ID.
 * Inputs are validated profile coordinates and an extracted field manifest. */
export function nearestSavedArrival(manifest, saved) {
  validatePosition(saved);
  let selected = null;
  let shortest = Infinity;
  for (const portal of destinationPortals(manifest)) {
    if (
      (portal.type !== 0 && portal.type !== 1) ||
      portal.targetMap !== 999999999
    ) {
      continue;
    }
    validatePosition(portal);
    if (!Number.isSafeInteger(portal.id) || portal.id < 0) {
      throw new Error("Invalid authored spawn portal ID");
    }
    // Rank authored feet, not the y-10 entry offset or a projected foothold.
    const distance = Math.hypot(saved.x - portal.x, saved.y - portal.y);
    if (!Number.isFinite(distance)) {
      throw new Error("Field arrival distance exceeds the finite range");
    }
    if (
      distance < shortest ||
      (distance === shortest && portal.id < selected.id)
    ) {
      selected = portal;
      shortest = distance;
    }
  }
  if (!selected) {
    throw new Error(`Map ${manifest.id} has no authored player spawnpoint`);
  }
  return { ...portalArrival(selected), facing: saved.facing };
}

/** Explicit travel wins over restored location; another field uses its initial actor.
 * A same-field load without a destination is a reload, never an exact-XY warp. */
export function fieldArrival(manifest, selector, saved, explicit = null) {
  if (explicit) {
    validatePosition(explicit);
    return explicit;
  }
  if (selector !== null) return arrivalPosition(manifest, selector);
  if (saved.mapId === manifest.id) return nearestSavedArrival(manifest, saved);
  return null;
}
