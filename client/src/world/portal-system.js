import {
  admitTutorialPortal,
  resolveTutorialPortal,
  tutorialNpcOffered,
  tutorialPortalKind,
} from "../npc/npc-script-portals.js";
import {
  portalEntryContains,
  portalRectangleContains,
  portalRevealContains,
  updatePortalGraphics,
} from "./portal-presentation.js";

const MAX_PORTALS = 4096;
const REQUEST_INTERVAL_MS = 500; // 0053035d: elapsed > 499, cross-map request only.
const SAME_MAP_ADMISSION_MS = 120; // 00957b74: provisional +0x2b2c guard.
const SAME_MAP_RECOVERY_MS = 600; // 0094e5e5: movement commits next update, then guard=now+600.

/** Lifetime is InGameSystems, not a field. One token owns admission until settlement. */
export class PortalTravelGate {
  constructor(clock = () => performance.now()) {
    if (typeof clock !== "function") {
      throw new Error("Portal clock is required");
    }
    this.clock = clock;
    this.lastNow = 0;
    this.lastRequestMs = -Infinity;
    this.sameMapUntilMs = 0;
    this.active = null;
    this.sequence = 0;
    this.completed = 0;
    this.failed = 0;
    this.lastOutcome = "idle";
    // Cosmic Character.blockPortal stores script names for the character session.
    this.blockedScripts = new Set();
  }

  now() {
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.lastNow) {
      throw new Error("Portal clock must be finite and monotonic");
    }
    this.lastNow = now;
    return now;
  }

  /** crossMap means original packet path, including same-field types 4/5. */
  tryBegin(crossMap) {
    if (typeof crossMap !== "boolean") {
      throw new Error("Invalid portal request kind");
    }
    const now = this.now();
    if (this.active) {
      this.lastOutcome = "request-already-pending";
      return null;
    }
    if (crossMap && now - this.lastRequestMs < REQUEST_INTERVAL_MS) {
      this.lastOutcome = "cross-map-request-cooldown";
      return null;
    }
    if (!crossMap && now < this.sameMapUntilMs) {
      this.lastOutcome = "same-map-motion-in-flight";
      return null;
    }
    if (!Number.isSafeInteger(this.sequence + 1)) {
      throw new Error("Portal request sequence exhausted");
    }
    const controller = new AbortController();
    const token = {
      id: ++this.sequence,
      crossMap,
      controller,
      signal: controller.signal,
      notBeforeMs: now,
    };
    this.active = token;
    if (crossMap) this.lastRequestMs = now;
    else this.sameMapUntilMs = now + SAME_MAP_ADMISSION_MS;
    this.lastOutcome = "offline-request-pending";
    return token;
  }

  owns(token) {
    return token !== null && this.active === token;
  }

  /** 0053185c timestamps responses, including failures. Stale tokens cannot release a successor. */
  complete(token, outcome = "committed") {
    if (!this.owns(token)) return false;
    if (!["committed", "failed", "cancelled"].includes(outcome)) {
      throw new Error("Invalid portal completion outcome");
    }
    const now = this.now();
    if (!token.crossMap && outcome === "committed") {
      this.sameMapUntilMs = now + SAME_MAP_RECOVERY_MS;
    }
    if (token.crossMap) this.lastRequestMs = now;
    this.active = null;
    this.lastOutcome = outcome;
    if (outcome === "committed") this.completed++;
    else this.failed++;
    return true;
  }

  /** Explicit application cancellation only; destroying a committed source is not cancellation. */
  cancel(token) {
    if (!this.owns(token)) return false;
    token.controller.abort();
    return this.complete(token, "cancelled");
  }

  snapshot() {
    const now = this.now();
    return {
      pending: this.active !== null,
      token: this.active?.id ?? null,
      cooldownMs: Math.max(0, REQUEST_INTERVAL_MS - (now - this.lastRequestMs)),
      sameMapMotionMs: Math.max(0, this.sameMapUntilMs - now),
      requests: this.sequence,
      completed: this.completed,
      failed: this.failed,
      lastOutcome: this.lastOutcome,
    };
  }
}

/** Original Win32 PtInRect uses exclusive right/bottom boundaries and integer feet. */
function contains(portal, sim, halfWidth, halfHeight) {
  return portalRectangleContains(portal, sim, halfWidth, halfHeight);
}

function containsAutomatic(record, sim) {
  const type = record.portal.type;
  return (
    (type === 3 || type === 9 || type === 12 || type === 13) &&
    contains(record.portal, sim, record.halfWidth, record.halfHeight)
  );
}

function travelOptions(portal, token) {
  return {
    token,
    signal: token.signal,
    sound: portal.type !== 4 && portal.type !== 5,
    effect: token.crossMap ? null : "Teleport",
    sameMapMotion: !token.crossMap,
    transition: token.crossMap ? "field" : "teleport",
    notBeforeMs: token.notBeforeMs,
  };
}

// Exact Cosmic scripts/portal/market{01..24,26,52..56}; never dispatch arbitrary script names.
const MARKET_ENTRY_SCRIPT = /^market(?:0[1-9]|1[0-9]|2[0-4]|26|5[2-6])$/;
const FREE_MARKET_MAP = 910000000;

export function marketPortalKind(portal, raw) {
  // Native 0094df9b sends script requests only for sentinel types7/8/11 here.
  if (portal.targetMap !== 999999999 || ![7, 8, 11].includes(portal.type)) {
    return null;
  }
  if (raw.script === "market00") return "return";
  return MARKET_ENTRY_SCRIPT.test(raw.script) ? "entry" : null;
}

/** Native 0094df9b Up request for a sentinel type7/8/11 script other than the
 *  market/tutorial translations. Only the online authority may run its compiled
 *  source (server/src/field-portal-scripts.js); routing status remains unavailable here. */
export function scriptedPortalKind(portal, raw) {
  if (
    portal.targetMap !== 999999999 ||
    ![7, 8, 11].includes(portal.type) ||
    typeof raw.script !== "string" ||
    !/^[A-Za-z0-9_]{1,64}$/.test(raw.script) ||
    marketPortalKind(portal, raw)
  ) {
    return null;
  }
  return raw.script;
}

/** Server policy translation; the field/profile owner commits this plan atomically. */
export function resolveMarketTravel(request, profile) {
  const source = Number(request.sourceMapId);
  if (
    !Number.isSafeInteger(source) ||
    source < 0 ||
    source > 999999998 ||
    Number(profile.location.mapId) !== source
  ) {
    throw new Error("Market route no longer owns its source field");
  }
  if (MARKET_ENTRY_SCRIPT.test(request.script)) {
    if (source === FREE_MARKET_MAP) {
      throw new Error("Already in the Free Market");
    }
    return {
      mapId: "910000000",
      portal: "out00",
      savedLocation: source,
    };
  }
  if (request.script !== "market00") {
    throw new Error("Unsupported market script");
  }
  return resolveMarketReturn(profile.savedLocations.FREE_MARKET);
}

/** Keep the authored missing-save fallback distinct from corrupt saved state. */
function resolveMarketReturn(saved) {
  if (saved === null) {
    // Authored market00 catch fallback, not a substitute for failed asset loading.
    return { mapId: "100000000", portal: 0, savedLocation: null };
  }
  if (
    !Number.isSafeInteger(saved) ||
    saved < 0 ||
    saved > 999999998 ||
    saved === FREE_MARKET_MAP
  ) {
    throw new Error("Invalid saved Free Market return field");
  }
  return {
    mapId: String(saved).padStart(9, "0"),
    portal: { marketReturn: true },
    savedLocation: null,
  };
}

/** Authored market scripts take priority over every collected fallback spawn. */
function scanMarketReturnPortals(portals, raw, spawns) {
  for (const portal of portals) {
    const script = raw[String(portal.id)]?.script;
    if (typeof script === "string" && script.includes("market")) {
      return portal;
    }
    if (
      portal.type >= 0 &&
      portal.type <= 1 &&
      portal.targetMap === 999999999
    ) {
      spawns.push(portal.id);
    }
  }
  return null;
}

/** AbstractPlayerInteraction.getMarketPortalId + MapleMap.findMarketPortal.
 * The stored nearest portal is not used by the authored return script. */
export function selectMarketReturnPortal(physics, random = Math.random) {
  const portals = physics.portals;
  if (!Array.isArray(portals) || portals.length > MAX_PORTALS) {
    throw new Error("Invalid market destination portals");
  }
  const raw = physics.map.$portalProperties ?? {};
  const spawns = [];
  const market = scanMarketReturnPortals(portals, raw, spawns);
  if (market) return market.id;
  if (!spawns.length) {
    throw new Error("Market destination has no player spawnpoint");
  }
  return spawns[Math.floor(random() * spawns.length)];
}

/** Preserve unsupported records rather than silently redirecting or running WZ scripts. */
export function portalRouteStatus(portal, raw) {
  if (marketPortalKind(portal, raw)) return null;
  if (tutorialPortalKind(portal, raw)) return null;
  if (raw.script !== undefined && raw.script !== "") {
    return "server-script-unavailable";
  }
  if (portal.type === 0) return "spawn-only";
  if (portal.type === 6) return "special-field-loader-unavailable";
  if (portal.type === 9) return "automatic-script-packet-unavailable";
  if (portal.type === 12) return "impact-skill-state-unavailable";
  if (portal.type === 13) return "impact-field-reactor-state-unavailable";
  if (![1, 2, 3, 4, 5, 7, 8, 10, 11].includes(portal.type)) {
    return "unsupported-portal-type";
  }
  // delay/onlyOnce/impacts/reactorName are consumed by 9/12/13, not ordinary routing.
  return unsupportedDestination(portal);
}

function unsupportedDestination(portal) {
  if (!Number.isInteger(portal.targetMap) || portal.targetMap === 999999999) {
    return "no-route";
  }
  if (portal.targetMap < 0 || portal.targetMap > 999999998) {
    return "invalid-target-map";
  }
  if (typeof portal.targetName !== "string" || !portal.targetName.length) {
    return "missing-target-name";
  }
  return null;
}

/** Validate one presentation entry against the sole original field metadata. */
function prepareRecord(presentation, portals, raw) {
  const portal = portals.get(presentation.portalId);
  if (!portal || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) {
    throw new Error("Portal presentation has no valid physics record");
  }
  if (
    presentation.entityId !== null &&
    presentation.entityId !== `portal:${portal.id}`
  ) {
    throw new Error("Portal presentation identity mismatch");
  }
  const properties = raw[String(portal.id)] ?? {};
  const hRange = Number(properties.hRange ?? 100);
  const vRange = Number(properties.vRange ?? 100);
  if (
    ![hRange, vRange].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000000,
    )
  ) {
    throw new Error("Invalid authored automatic portal range");
  }
  const tutorialProgram = prepareTutorialProgram(
    presentation,
    portal,
    properties,
  );
  return {
    portal,
    entityId: presentation.entityId,
    status: presentation.status,
    denied: portalRouteStatus(portal, properties),
    tutorialProgram,
    marketScript: marketPortalKind(portal, properties)
      ? properties.script
      : null,
    halfWidth: Math.trunc(hRange / 2),
    halfHeight: Math.trunc(vRange / 2),
    phase: presentation.status === "looping-graphics" ? "looping" : "hidden",
    animation: null,
    desired: false,
  };
}

function prepareTutorialProgram(presentation, portal, properties) {
  const tutorial = tutorialPortalKind(portal, properties);
  const program = tutorial
    ? admitTutorialPortal(presentation.tutorialProgram)
    : null;
  if (program && program.script !== tutorial) {
    throw new Error("Tutorial program differs from original portal metadata");
  }
  return program;
}

function packetPortalRoute(record, mapId) {
  return (
    record.tutorialProgram !== null ||
    record.marketScript !== null ||
    String(record.portal.targetMap).padStart(9, "0") !== String(mapId) ||
    record.portal.type === 4 ||
    record.portal.type === 5
  );
}

/** Offline traversal is not server permission. Owns state, never scene artwork/resources.
 * Main advances entity animations before update(), then renders. travel validates
 * the exact named destination, relocates same-map motion without field replacement,
 * and stages packet-path destinations before an atomic faded field replacement.
 */
export class PortalSystem {
  constructor(scene, hooks) {
    const presentation = scene.manifest.portalPresentation;
    const portals = scene.manifest.physics.portals;
    if (
      presentation?.schemaVersion !== 1 ||
      !Array.isArray(presentation.records) ||
      !Array.isArray(portals) ||
      presentation.records.length > MAX_PORTALS ||
      portals.length !== presentation.records.length
    ) {
      throw new Error("Invalid portal presentation coverage");
    }
    if (
      typeof hooks.travel !== "function" ||
      typeof hooks.onError !== "function" ||
      !(hooks.travelGate instanceof PortalTravelGate)
    ) {
      throw new Error("Portal travel and error hooks are required");
    }
    const byId = new Map(portals.map((portal) => [portal.id, portal]));
    const raw = scene.manifest.physics.map.$portalProperties ?? {};
    const seen = new Set();
    this.records = presentation.records.map((record) => {
      if (seen.has(record.portalId)) {
        throw new Error("Duplicate portal presentation record");
      }
      seen.add(record.portalId);
      return prepareRecord(record, byId, raw);
    });
    this.scene = scene;
    this.hooks = hooks;
    this.destroyed = false;
    this.token = null;
    this.generation = 0;
    this.gate = hooks.travelGate;
    this.automatic = null;
    this.automaticAttempt = null;
    this.candidate = null;
    this.reveal = null;
    this.lastOutcome = "offline-traversal-not-server-authorization";
    this.requests = 0;
    this.completed = 0;
  }

  /** Bounded, allocation-free tick; ms follows the integration's active simulation clock. */
  update(ms, inputState) {
    if (this.destroyed) return;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("Invalid portal update input");
    }
    // Cooldown uses the shared monotonic application clock, never scene delta time.
    this.handleInput(inputState);
    if (this.destroyed) return;
    this.selectNearby(this.scene.simulation);
    this.handleAutomatic();
    for (const record of this.records) this.updateGraphics(record);
  }

  /** Original Up dispatch precedes movement/ladder capture; edge ownership is shared
   * with update() so standalone callers retain the same API without duplicate requests. */
  handleInput(inputState) {
    if (this.destroyed) return;
    if (typeof inputState.upPressed !== "boolean") {
      throw new Error("Invalid portal input state");
    }
    const pressed = inputState.upPressed;
    inputState.upPressed = false;
    if (!pressed || this.gate.active) return;
    const sim = this.scene.simulation;
    this.selectNearby(sim);
    if (!this.candidate) return;
    if (!sim.footholdId || sim.action === "attack" || sim.movementLocked) {
      this.lastOutcome = "requires-grounded-unblocked-local-user";
      return;
    }
    this.request(this.candidate);
  }

  /** Original searches run in reverse source order. pt6 belongs to a separate collection. */
  selectNearby(sim) {
    this.candidate = null;
    this.reveal = null;
    this.automatic = null;
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index],
        portal = record.portal;
      if (portal.type === 0 || portal.type === 6) continue;
      if (!this.automatic && containsAutomatic(record, sim)) {
        this.automatic = record;
      }
      if (!this.candidate && portalEntryContains(portal, sim)) {
        this.candidate = record;
      }
      if (
        !this.reveal &&
        (portal.type === 10 || portal.type === 11) &&
        portalRevealContains(portal, sim)
      ) {
        this.reveal = record;
      }
    }
  }

  /** 0094dac6 runs without Up/contact for type3. Failed overlap requests require reentry. */
  handleAutomatic() {
    if (!this.automatic) {
      this.automaticAttempt = null;
      return;
    }
    if (this.automaticAttempt === this.automatic || this.gate.active) return;
    if (
      this.scene.simulation.action === "attack" ||
      this.scene.simulation.movementLocked
    ) {
      return;
    }
    if (this.request(this.automatic)) this.automaticAttempt = this.automatic;
  }

  get blocksMovement() {
    return this.gate.active !== null && !this.gate.active.crossMap;
  }

  /** Region replacement is detected by identity: do not hold sprites/leases after eviction. */
  updateGraphics(record) {
    updatePortalGraphics(this.scene, record, this.reveal === record);
  }

  /** Named route errors stay visible and retain the current scene; no rejection is swallowed. */
  request(record) {
    if (this.destroyed || this.gate.active) return false;
    if (
      this.scene.offlineField?.dead ||
      this.scene.offlineField?.blocksMovement
    ) {
      return false;
    }
    if (
      record.tutorialProgram &&
      this.gate.blockedScripts.has(record.tutorialProgram.script)
    ) {
      this.lastOutcome = "authored-portal-blocked";
      return true;
    }
    if (record.denied) {
      this.lastOutcome = record.denied;
      this.hooks.onError(
        new Error(`Portal ${record.portal.name}: ${record.denied}`),
      );
      return true;
    }
    const token = this.gate.tryBegin(
      packetPortalRoute(record, this.scene.manifest.id),
    );
    if (!token) {
      this.lastOutcome = this.gate.lastOutcome;
      return false;
    }
    this.token = token;
    this.requests++;
    const generation = ++this.generation;
    this.lastOutcome = "offline-request-pending";
    this.finishTravel(record, generation);
    return true;
  }

  async finishTravel(record, generation) {
    const token = this.token;
    let outcome = "failed";
    try {
      await this.dispatchTravel(record, token);
      outcome = token.signal.aborted ? "cancelled" : "committed";
      if (this.destroyed || generation !== this.generation) return;
      this.completed++;
      this.lastOutcome = "offline-request-committed";
    } catch (error) {
      outcome = token.signal.aborted ? "cancelled" : "failed";
      if (
        this.destroyed ||
        generation !== this.generation ||
        outcome === "cancelled"
      ) {
        return;
      }
      this.lastOutcome = error instanceof Error ? error.message : String(error);
      this.hooks.onError(error);
    } finally {
      // Successful Main commit destroys this owner before travel resolves.
      this.gate.complete(token, outcome);
      if (this.token === token) this.token = null;
    }
  }

  /** Dispatch only the explicitly admitted offline route authorities. */
  dispatchTravel(record, token) {
    const options = travelOptions(record.portal, token);
    if (record.tutorialProgram) return this.dispatchTutorial(record, token);
    if (record.marketScript !== null) {
      if (typeof this.hooks.travelMarket !== "function") {
        throw new Error("Offline market travel authority is unavailable");
      }
      return this.hooks.travelMarket(
        {
          script: record.marketScript,
          sourceMapId: this.scene.manifest.id,
        },
        options,
      );
    }
    return this.hooks.travel(
      String(record.portal.targetMap).padStart(9, "0"),
      record.portal.targetName,
      options,
    );
  }

  async dispatchTutorial(record, token) {
    if (typeof this.hooks.getProfile !== "function") {
      throw new Error("Tutorial portal character authority is unavailable");
    }
    const profile = this.hooks.getProfile();
    if (Number(profile?.location?.mapId) !== Number(this.scene.manifest.id)) {
      throw new Error("Tutorial portal no longer owns its character field");
    }
    if (tutorialNpcOffered(record.tutorialProgram)) {
      await this.dispatchTutorialNpc(record, token);
    }
    const path = resolveTutorialPortal(record.tutorialProgram, profile);
    if (path !== null) {
      if (typeof this.hooks.showTutorial !== "function") {
        throw new Error("Original tutorial artwork renderer is unavailable");
      }
      await this.hooks.showTutorial(path, {
        signal: token.signal,
        source: record.tutorialProgram.source,
      });
    }
    if (this.destroyed || token.signal.aborted || !this.gate.owns(token)) {
      throw new Error("Tutorial portal request was cancelled");
    }
    this.gate.blockedScripts.add(record.tutorialProgram.script);
    return record.tutorialProgram.result;
  }

  async dispatchTutorialNpc(record, token) {
    if (typeof this.hooks.hasLevel30Character !== "function") {
      throw new Error("Tutorial portal account authority is unavailable");
    }
    const eligible = await this.hooks.hasLevel30Character();
    if (this.destroyed || token.signal.aborted || !this.gate.owns(token)) {
      throw new Error("Tutorial portal request was cancelled");
    }
    if (typeof eligible !== "boolean") {
      throw new Error("Invalid tutorial portal account eligibility");
    }
    if (!eligible) return;
    if (typeof this.hooks.openTutorialNpc !== "function") {
      throw new Error("Tutorial portal NPC authority is unavailable");
    }
    await this.hooks.openTutorialNpc(record.tutorialProgram.openNpc.npcId, {
      signal: token.signal,
      source: record.tutorialProgram.source,
      sourceMapId: this.scene.manifest.id,
    });
  }

  snapshot() {
    return {
      mode: "offline-packaged-traversal-not-server-authorization",
      records: this.records.length,
      pending: this.gate.active !== null,
      cooldownMs: this.gate.snapshot().cooldownMs,
      gate: this.gate.snapshot(),
      automatic: this.automatic?.portal.id ?? null,
      requests: this.requests,
      completed: this.completed,
      lastOutcome: this.lastOutcome,
      candidate: this.candidate?.portal.id ?? null,
      graphics: this.records
        .filter((record) => record.entityId)
        .map((record) => ({
          portalId: record.portal.id,
          entityId: record.entityId,
          phase: record.phase,
          resident: this.scene.byId.has(record.entityId),
          status: record.status,
        })),
      unsupported: this.records
        .filter((record) => record.denied)
        .map((record) => ({
          portalId: record.portal.id,
          reason: record.denied,
        })),
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    // Keep the gate token: the application still owns the in-flight async operation.
    this.candidate = null;
    this.reveal = null;
    for (const record of this.records) record.animation = null;
  }
}
