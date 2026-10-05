import {
  call,
  cmMethod,
  member,
  playerMethod,
  resolveVariable,
} from "./npc-script-ir.js";

const PARTY_CALLS = new Set(["getParty", "isLeader", "partyMembersInMap"]);
const CARNIVAL_CALLS = new Set([
  "sendCPQMapLists",
  "fieldTaken",
  "fieldLobbied",
  "challengeParty",
  "cpqLobby",
]);
const PARTY_QUEST_CALLS = new Set([
  "gotPartyQuestItem",
  "removePartyQuestItem",
  "setPartyQuestItemObtained",
]);
// Server state without local authority: event instances, numbered quest info
// progress, direct skill grants and other characters' field population.
const UNAVAILABLE_CALLS = Object.freeze({
  getEventInstance: "event-instance",
  getEventManager: "event-instance",
  getQuestProgressInt: "quest-info-progress",
  setQuestProgress: "quest-info-progress",
  teachSkill: "skill-grant",
  getPlayerCount: "field-population",
});
// PortalPlayerInteraction members without local authority. Portal sources only;
// an NPC `cm` receiver keeps its own closed method set.
const PORTAL_UNAVAILABLE_CALLS = Object.freeze({
  message: "player-message",
  playerMessage: "player-message",
  mapMessage: "player-message",
  blockPortal: "portal-session-state",
  getPortal: "portal-session-state",
  openNpc: "npc-conversation",
  showInstruction: "client-presentation",
  showInfo: "client-presentation",
  showInfoText: "client-presentation",
  showWZEffect: "client-presentation",
  changeMusic: "client-presentation",
  talkGuide: "client-presentation",
  removeGuide: "client-presentation",
  setDirectionStatus: "client-presentation",
  unlockUI: "client-presentation",
  earnTitle: "client-presentation",
  enableActions: "client-presentation",
  isEventLeader: "event-instance",
  startDungeonInstance: "event-instance",
  containsAreaInfo: "quest-info-progress",
  getWarpMap: "field-state",
  resetMapObjects: "field-state",
  gainItem: "inventory-mutation",
  removeAll: "inventory-mutation",
  useItem: "inventory-mutation",
  cancelItem: "inventory-mutation",
  forceStartQuest: "quest-mutation",
  forceCompleteQuest: "quest-mutation",
});
const PORTAL_PLAYER_UNAVAILABLE_CALLS = Object.freeze({
  message: "player-message",
  dropMessage: "player-message",
  getEventInstance: "event-instance",
});
const REMOTE_RECEIVER_CALLS = Object.freeze(["size", "get", "startInstance"]);
const MAX_RECEIVER_CHAIN = 16;
const GAME_CONSTANT_READS = Object.freeze({
  getHallOfFameMapid: "hall-of-fame-map",
  getSkillBook: "skill-book",
  isCygnus: "is-cygnus",
  isAran: "is-aran",
});

const QUEST_CALLS = new Set([
  "getQuestStatus",
  "isQuestCompleted",
  "isQuestStarted",
  "isQuestActive",
  "forceStartQuest",
  "startQuest",
  "forceCompleteQuest",
  "completeQuest",
]);

/** A server custom quest without original Check/Info authority remains an explicit lazy trap. */
export function npcMissingQuestService(context, node) {
  const id = node?.arguments?.[0]?.value;
  return QUEST_CALLS.has(cmMethod(node)) &&
    Number.isSafeInteger(id) &&
    context.originalQuestIds &&
    !context.originalQuestIds.has(id)
    ? "custom-quest-progress"
    : null;
}
/** Portal-only receivers: `pi`, `pi.getPlayer()` and any `pi.getMap()` method
 *  other than the map-id read lower to a trap. */
function portalRemoteService(node) {
  const method = cmMethod(node);
  if (Object.hasOwn(PORTAL_UNAVAILABLE_CALLS, method)) {
    return PORTAL_UNAVAILABLE_CALLS[method];
  }
  const player = playerMethod(node);
  if (Object.hasOwn(PORTAL_PLAYER_UNAVAILABLE_CALLS, player)) {
    return PORTAL_PLAYER_UNAVAILABLE_CALLS[player];
  }
  const receiver = node?.callee?.object;
  if (
    node?.type === "CallExpression" &&
    !call(node, "getId") &&
    (cmMethod(receiver) === "getMap" || playerMethod(receiver) === "getMap") &&
    receiver.arguments.length === 0
  ) {
    return "field-state";
  }
  return null;
}

/** Known remote operations compile to a transactional trap, never a host invocation.
 *  In a portal source a receiver evaluates before its member call, so a trapping
 *  receiver anywhere in a bounded call chain makes the whole chain unreachable. */
export function npcRemoteService(node, portal = false) {
  if (!portal) return remoteCall(node);
  for (
    let depth = 0;
    node?.type === "CallExpression" && depth < MAX_RECEIVER_CHAIN;
    depth++
  ) {
    const service = portalRemoteService(node) ?? remoteCall(node);
    if (service) return service;
    node = node.callee.type === "MemberExpression" ? node.callee.object : null;
  }
  return null;
}

function remoteCall(node) {
  const method = cmMethod(node);
  if (Object.hasOwn(UNAVAILABLE_CALLS, method)) {
    return UNAVAILABLE_CALLS[method];
  }
  if (PARTY_QUEST_CALLS.has(playerMethod(node))) return "party-quest-progress";
  if (PARTY_CALLS.has(method) || playerMethod(node) === "getParty") {
    return "party-membership";
  }
  if (
    CARNIVAL_CALLS.has(method) ||
    playerMethod(node) === "getFestivalPoints"
  ) {
    return "monster-carnival";
  }
  if (method === "gainExp") return "server-experience-reward";
  if (
    call(node, "getMembers") &&
    (cmMethod(node.callee.object) === "getParty" ||
      playerMethod(node.callee.object) === "getParty")
  ) {
    return "party-membership";
  }
  return null;
}

function configField(context, scope, node) {
  if (!member(node.object, "server") || !member(node.object.object, "config")) {
    return null;
  }
  const receiver = node.object.object.object;
  if (receiver.type !== "Identifier") return null;
  const binding = resolveVariable(context, scope, receiver);
  if (binding?.host !== "config.YamlConfig") return null;
  if (
    binding.owner === context.scopeOwners.get(scope) &&
    binding.declarationEnd > node.start
  ) {
    throw new Error("Static configuration binding used before initialization");
  }
  const name = node.property.name;
  if (!["USE_CPQ", "USE_ENABLE_SOLO_EXPEDITIONS"].includes(name)) return null;
  if (typeof context.staticConfig?.[name] !== "boolean") {
    throw new Error(`Missing authored static configuration: ${name}`);
  }
  return {
    op: "literal",
    value: context.staticConfig[name],
    raw: String(context.staticConfig[name]),
  };
}

/** Only named, side-effect-free source methods are lowered; Java itself is never evaluated. */
function staticHostExpression(context, scope, node) {
  const binding = staticHostBinding(context, scope, node);
  if (!binding) return null;
  const method = node.callee.property?.name;
  if (
    binding.host === "server.life.PlayerNPC" &&
    method === "spawnPlayerNPC" &&
    node.arguments.length === 2
  ) {
    return { op: "unavailable", service: "hall-of-fame-player-npc" };
  }
  if (
    binding.host !== "constants.game.GameConstants" ||
    !Object.hasOwn(GAME_CONSTANT_READS, method) ||
    node.arguments.length !== 1
  ) {
    return null;
  }
  return { op: "read", kind: GAME_CONSTANT_READS[method], args: [] };
}

function staticHostBinding(context, scope, node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.computed ||
    node.callee.object?.type !== "Identifier"
  ) {
    return null;
  }
  const name = node.callee.object.name;
  if (
    !context.variables.some(
      (variable) => variable.name === name && variable.host,
    )
  ) {
    return null;
  }
  const binding = resolveVariable(context, scope, node.callee.object);
  if (!binding?.host) return null;
  if (
    binding.owner === context.scopeOwners.get(scope) &&
    binding.declarationEnd > node.start
  ) {
    throw new Error("Static host binding used before initialization");
  }
  return binding;
}

export function npcBooleanConfig(context, name) {
  const value = context.staticConfig?.[name];
  if (typeof value !== "boolean") {
    throw new Error(`Missing authored static configuration: ${name}`);
  }
  return value;
}

/** `cm.getEventManager("<published transport>")`; any other name keeps its trap. */
export function admittedEventManager(context, node) {
  const name = node?.arguments?.[0];
  return cmMethod(node) === "getEventManager" &&
    node.arguments.length === 1 &&
    name.type === "Literal" &&
    typeof name.value === "string" &&
    context.eventManagers?.has(name.value)
    ? name.value
    : null;
}

/** EventManager reads: the manager (null when unpublished) and its getProperty. */
function eventRead(context, scope, node) {
  if (admittedEventManager(context, node)) {
    return { op: "read", kind: "event-manager", args: [] };
  }
  const receiver = node.callee?.object;
  if (
    call(node, "getProperty") &&
    node.arguments.length === 1 &&
    receiver.type === "Identifier" &&
    context.variables.some((variable) => variable.name === receiver.name) &&
    resolveVariable(context, scope, receiver)?.eventManager
  ) {
    return {
      op: "read",
      kind: "event-property",
      args: [],
      operands: [receiver, node.arguments[0]],
    };
  }
  return null;
}

export function npcServiceExpression(context, scope, node) {
  if (node.type === "MemberExpression" && !node.computed) {
    return configField(context, scope, node);
  }
  const event = eventRead(context, scope, node);
  if (event) return event;
  const host = staticHostExpression(context, scope, node);
  if (host) return host;
  const service =
    npcMissingQuestService(context, node) ??
    npcRemoteService(node, context.portal) ??
    comparisonService(node, context.portal);
  if (service) return { op: "unavailable", service };
  const collection = remoteCollectionExpression(context, scope, node);
  if (collection) return collection;
  if (playerMethod(node) === "isGM" && node.arguments.length === 0) {
    // Offline character profiles never confer server GM privileges.
    return { op: "read", kind: "is-gm", args: [] };
  }
  return mapServiceExpression(node);
}

/** Comparing an unavailable value traps before its other operand is lowered. */
function comparisonService(node, portal) {
  if (node.type !== "BinaryExpression") return null;
  if (
    call(node.left, "random") &&
    node.left.arguments.length === 0 &&
    node.left.callee.object.type === "Identifier" &&
    node.left.callee.object.name === "Math"
  ) {
    // Server-side random selection has no authored local authority.
    return "random-outcome";
  }
  return npcRemoteService(node.left, portal);
}

function remoteCollectionExpression(context, scope, node) {
  if (
    (context.portal
      ? node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed
      : REMOTE_RECEIVER_CALLS.some((name) => call(node, name))) &&
    node.callee.object.type === "Identifier"
  ) {
    const service = remoteBinding(context, scope, node.callee.object);
    if (service) return { op: "unavailable", service };
  }
  return null;
}

/** Only an authored binding is resolved; host names keep their own diagnostics. */
function remoteBinding(context, scope, node) {
  if (!context.variables.some((variable) => variable.name === node.name)) {
    return null;
  }
  return resolveVariable(context, scope, node)?.remoteService ?? null;
}

function mapServiceExpression(node) {
  if (node.type !== "CallExpression" || node.arguments.length !== 0) {
    return null;
  }
  if (
    playerMethod(node.callee.object) !== "getMap" ||
    node.callee.object.arguments.length
  ) {
    return null;
  }
  if (call(node, "isCPQWinnerMap")) {
    return { op: "read", kind: "cpq-winner-map", args: [] };
  }
  if (call(node, "isCPQLoserMap")) {
    return { op: "read", kind: "cpq-loser-map", args: [] };
  }
  return null;
}

/** A statement call on a remote-service binding is unreachable past its trapping initializer. */
export function npcRemoteReceiver(context, scope, node) {
  const receiver = node.callee?.object;
  if (
    !context.portal ||
    node.callee?.type !== "MemberExpression" ||
    receiver.type !== "Identifier"
  ) {
    return null;
  }
  return remoteBinding(context, scope, receiver);
}

/** A server-owned collection cannot be materialized locally; fail before iterating it. */
export function npcRemoteLoop(context, scope, node) {
  const bound = node.test?.right;
  if (
    !call(bound, "size") ||
    bound.arguments.length ||
    bound.callee.object.type !== "Identifier"
  ) {
    return null;
  }
  const binding = resolveVariable(context, scope, bound.callee.object);
  return binding?.remoteService
    ? { op: "unavailable", service: binding.remoteService }
    : null;
}
