import { COMBAT_VALUE_LIMIT } from "./combat-formulas.js";
import { LIFE_PLACEMENT_PATTERN } from "./content-identity.js";
import {
  array,
  boolean,
  coordinate,
  canonical,
  closedRecord,
  enumeration,
  hash,
  id,
  integer,
  nullable,
  number,
  optional,
  point,
  protocolError,
  record,
  revision,
  seq,
  text,
  chatText,
  u32,
  union,
  validate,
  string,
} from "./schema.js";
import { decodeJson } from "./json.js";
import { SOCIAL_MESSAGES } from "./social-feedback.js";
import { animation, motionSchema } from "./motion-schema.js";
import {
  settingsSchema,
  keyBindingsSchema,
  skillMacrosSchema,
} from "./native-presentation.js";
import {
  SOCIAL_ACTION_ROWS,
  SOCIAL_CHAT_ACTION_FIELDS,
  SOCIAL_CHAT_CHANNELS,
  SOCIAL_EPHEMERAL_ACTIONS,
  SOCIAL_EVENT_SCHEMAS,
  SOCIAL_RESULT_SCHEMAS,
} from "./social-protocol.js";
import {
  COMMERCE_ACTION_ROWS,
  COMMERCE_EPHEMERAL_ACTIONS,
  COMMERCE_EVENT_SCHEMAS,
  COMMERCE_RESULT_SCHEMAS,
} from "./commerce-protocol.js";
import {
  TRADE_ACTION_ROWS,
  TRADE_EPHEMERAL_ACTIONS,
  TRADE_EVENT_FIELDS,
  TRADE_OFFER_ITEM_FIELDS,
  TRADE_RESULT_SCHEMAS,
  validTradeEvent,
} from "./trade-protocol.js";
import {
  NARRATIVE_ACTION_ROWS,
  NARRATIVE_ACTION_FIELDS,
  NARRATIVE_EPHEMERAL_ACTIONS,
  NARRATIVE_EVENT_FIELDS,
  NARRATIVE_EVENT_SCHEMAS,
  NARRATIVE_RESULT_SCHEMAS,
  narrativeObjectiveSchema,
} from "./narrative-protocol.js";
import {
  DROP_ACTION_ROWS,
  DROP_ENTITY_FIELDS,
  DROP_EPHEMERAL_ACTIONS,
  DROP_EVENT_SCHEMAS,
  DROP_RESULT_SCHEMAS,
} from "./drop-protocol.js";
import {
  COMBAT_ACTION_ROWS,
  COMBAT_ENTITY_FIELDS,
  COMBAT_EPHEMERAL_ACTIONS,
  COMBAT_EVENT_SCHEMAS,
  COMBAT_RESULT_SCHEMAS,
} from "./combat-protocol.js";
import {
  WORLD_ACTION_ROWS,
  WORLD_CLIENT_MESSAGES,
  WORLD_ENTITY_FIELDS,
  WORLD_EPHEMERAL_ACTIONS,
  WORLD_EVENT_SCHEMAS,
  WORLD_RESULT_SCHEMAS,
  worldDestinationSchema,
  worldTransitionFields,
} from "./world-protocol.js";
export { closedRecord, decodeJson, protocolError };
export {
  ANIMATION_ACTIONS,
  animationId,
  animationName,
} from "./motion-schema.js";

/** Plausibility envelope for the motion a client reports for its own actor. Browser
 *  trust policy, not a recovered original constant.
 *
 *  Server input simulation owns position and velocity. Every checkpoint rebases client
 *  prediction. This envelope supplies optional watchdog evidence; being inside it
 *  never authorizes a reported position or grants extra movement time.
 *
 *  Sizing (`speedPxPerSecond` 900 = the fastest combination the kernel can author —
 *  terminal fall 670 px/s, plus a horizontal movement skill 350 px/s, hypot 756 — with
 *  headroom): a report is judged against the time since the last inspected report, so the
 *  same rule covers one tick of jitter and a reconnect gap where the player kept moving.
 *  An additional 500 ms allowance tolerates delayed input/event observations, even
 *  when consecutive client reports are only one simulation tick apart.
 *  `minimumPositionPx` 32 keeps a single 30 ms quantum from ever tripping it: one tick of
 *  terminal fall is 20.1 px and one authoritative knockback adds 8.1 px.
 *  `velocityPxPerSecond` 700 is an instantaneous bound, so it does not scale.
 *
 *  Reports are not compared where the server owns a rule the client cannot know (a
 *  pending field transition, death, a map seat, a ladder attach, or an unpredicted
 *  movement skill). Those checkpoints carry the legacy `authoritative: true` marker;
 *  ordinary checkpoints are equally trusted for prediction reconciliation. */
export const MOTION_PLAUSIBILITY = Object.freeze({
  latencyAllowanceMs: 500,
  speedPxPerSecond: 900,
  minimumPositionPx: 32,
  velocityPxPerSecond: 700,
});

/** Largest gap-scaled displacement allowed for a report spanning `elapsedMs`,
 *  measured from the last inspected report; never below one quantum of headroom. */
export function plausiblePositionPx(elapsedMs) {
  const scaled = Number.isFinite(elapsedMs)
    ? (MOTION_PLAUSIBILITY.speedPxPerSecond *
        (Math.max(0, elapsedMs) + MOTION_PLAUSIBILITY.latencyAllowanceMs)) /
      1000
    : MOTION_PLAUSIBILITY.minimumPositionPx;
  return Math.max(MOTION_PLAUSIBILITY.minimumPositionPx, scaled);
}

/** Initial engineering policy, not original server constants. */
export const PROTOCOL = Object.freeze({
  VERSION: 1,
  SUBPROTOCOL: "openms.game.v1",
  TICK_MS: 30,
  MAX_CATCH_UP: 4,
  /** 240 ms of admitted lead. The browser paces presentation from its own clock, so a
   *  brief server or event-loop delay must not freeze local stepping; the authority
   *  retires any late hint it cannot place. */
  INPUT_LEAD_TICKS: 8,
  INPUT_BUFFER_TICKS: 1,
  INPUT_HISTORY: 128,
  MAX_MESSAGE_BYTES: 16384,
  MAX_SERVER_MESSAGE_BYTES: 65536,
  MAX_SNAPSHOT_PARTS: 64,
  MAX_SNAPSHOT_BYTES: 1048576,
  ASSEMBLY_TIMEOUT_MS: 5000,
  ASSET_PREPARATION_TIMEOUT_MS: 120000,
  MAX_ENTITY_CHANGES: 128,
  MAX_INPUT_HOLD_TICKS: 3,
  /** Bounded per-tick peer motion projection. A field renders at most this many moving
   *  peers in one frame; the rest release on their next changed tick. */
  MAX_PEER_MOTIONS: 24,
});

// The 89-key preference command exceeds 256 schema nodes. Domain admission and
// wire decoding must share the same bounded budget for every legal action.
const CLIENT_SCHEMA_MAX_NODES = 2048;
export const RESULT_CODES = Object.freeze([
  ...Object.keys(SOCIAL_MESSAGES),
  "OK",
  "INVALID_MESSAGE",
  "UNAUTHENTICATED",
  "CHARACTER_BUSY",
  "STALE_CONNECTION",
  "STALE_FIELD",
  "STALE_REVISION",
  "OPERATION_CONFLICT",
  "OPERATION_EXPIRED",
  "NOT_ALLOWED",
  "NOT_IN_RANGE",
  "REQUIREMENTS_NOT_MET",
  "NOT_FOUND",
  "INSUFFICIENT_FUNDS",
  "INVENTORY_FULL",
  "COOLDOWN",
  "RATE_LIMITED",
  "CONTENT_MISMATCH",
  "PROTOCOL_MISMATCH",
  "UNSUPPORTED_VERSION",
  "RESYNC_REQUIRED",
  "TRANSITION_FAILED",
  "SERVER_BUSY",
  "SESSION_EXPIRED",
]);
const code = enumeration(...RESULT_CODES);
const quantity = number(1, 2147483647);
const mesos = number(0, 2147483647);
const template = u32;
const facing = enumeration(-1, 1);
const axis = enumeration(-1, 0, 1);
/** Client-predicted kernel scalars for one sampled tick; same bounded range as a
 *  motion checkpoint so neither side can report a coordinate the kernel rejects. */
const reportedMotion = record({
  x: coordinate,
  y: coordinate,
  vx: coordinate,
  vy: coordinate,
});
const tab = enumeration("equip", "use", "setup", "etc", "cash");
const channel = enumeration(...SOCIAL_CHAT_CHANNELS);
const operationId = string(
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  36,
);
const target = union("kind", {
  entity: record({ kind: enumeration("entity"), entityId: id }),
  aim: record(
    {
      kind: enumeration("aim"),
      x: number(-1, 1, false),
      y: number(-1, 1, false),
    },
    (value) => value.x !== 0 || value.y !== 0,
  ),
});
const answer = union("kind", {
  next: record({ kind: enumeration("next") }),
  previous: record({ kind: enumeration("previous") }),
  cancel: record({ kind: enumeration("cancel") }),
  yesno: record({ kind: enumeration("yesno"), value: boolean }),
  choice: record({ kind: enumeration("choice"), choiceId: u32 }),
  number: record({ kind: enumeration("number"), value: integer }),
  text: record({ kind: enumeration("text"), value: text }),
});
const CORE_ACTION_ROWS = [
  ["settings.save", "character", { settings: settingsSchema }],
  ["key-bindings.save", "character", { keyBindings: keyBindingsSchema }],
  ["skill-macros.save", "character", { skillMacros: skillMacrosSchema }],
  ["quest.track", "character", { questId: template, tracked: boolean }],
  ["quest.notice", "character", { questId: template }],
  ["portal.enter", "character", { portalId: u32 }],
  ["content.enter", "character", { mapId: number(800000000, 899999998) }],
  [
    "revive.request",
    "character",
    { method: enumeration("return", "consumable") },
  ],
  ["skill.cast", "character", { skillId: template, target: optional(target) }],
  ["buff.cancel", "character", { effectId: id }],
  [
    "inventory.move",
    "inventory",
    { itemId: id, quantity, to: record({ tab, slot: u32 }) },
  ],
  ["equipment.equip", "inventory", { itemId: id, slot: u32 }],
  ["equipment.unequip", "inventory", { itemId: id, toSlot: u32 }],
  ["item.use", "inventory", { itemId: id, target: optional(target) }],
  ["inventory.gather", "inventory", { tab }],
  [
    "equipment.scroll",
    "inventory",
    { scrollId: id, equipmentId: id, protectionId: optional(id) },
  ],
  ["npc.open", "character", { npcId: id }],
  ["npc.answer", "conversation", { conversationId: id, step: u32, answer }],
  [
    "quest.accept",
    "character",
    { questId: template, conversationId: id, step: u32 },
  ],
  [
    "quest.claim",
    "character",
    {
      questId: template,
      conversationId: id,
      step: u32,
      rewardChoice: optional(u32),
    },
  ],
  ["quest.abandon", "character", { questId: template }],
  ["shop.buy", "inventory", { shopSession: id, rowId: u32, quantity }],
  ["shop.sell", "inventory", { shopSession: id, itemId: id, quantity }],
  ["shop.recharge", "inventory", { shopSession: id, itemId: id }],
  [
    "stats.allocate",
    "character",
    {
      stat: enumeration("str", "dex", "int", "luk", "hp", "mp"),
      amount: quantity,
    },
  ],
  ["skills.allocate", "character", { skillId: template, amount: quantity }],
  [
    "chat.send",
    "social",
    {
      channel,
      recipientId: optional(id),
      text: chatText,
      ...SOCIAL_CHAT_ACTION_FIELDS,
    },
  ],
];
const ACTION_ROWS = [
  ...new Map(
    [
      ...CORE_ACTION_ROWS,
      ...SOCIAL_ACTION_ROWS,
      ...COMMERCE_ACTION_ROWS,
      ...TRADE_ACTION_ROWS,
      ...NARRATIVE_ACTION_ROWS,
      ...DROP_ACTION_ROWS,
      ...COMBAT_ACTION_ROWS,
      ...WORLD_ACTION_ROWS,
    ].map((row) => [row[0], row]),
  ).values(),
];
const EPHEMERAL_ACTIONS = new Set([
  "npc.open",
  "npc.answer",
  "chat.send",
  ...SOCIAL_EPHEMERAL_ACTIONS,
  ...COMMERCE_EPHEMERAL_ACTIONS,
  ...TRADE_EPHEMERAL_ACTIONS,
  ...NARRATIVE_EPHEMERAL_ACTIONS,
  ...DROP_EPHEMERAL_ACTIONS,
  ...COMBAT_EPHEMERAL_ACTIONS,
  ...WORLD_EPHEMERAL_ACTIONS,
]);
function validChatAction(value) {
  const recipientCount =
    Number(Object.hasOwn(value, "recipientId")) +
    Number(Object.hasOwn(value, "recipientName"));
  return (
    recipientCount === (value.channel === "whisper" ? 1 : 0) &&
    (value.channel === "group") === Object.hasOwn(value, "groupId")
  );
}
const actionVariants = {},
  domains = new Map();
for (const [kind, domain, fields] of ACTION_ROWS) {
  actionVariants[kind] = record(
    { kind: enumeration(kind), ...fields, ...NARRATIVE_ACTION_FIELDS[kind] },
    kind === "chat.send" ? validChatAction : null,
  );
  domains.set(kind, domain);
}
export const ACTION_KINDS = Object.freeze(ACTION_ROWS.map((row) => row[0]));
export const actionSchema = union("kind", actionVariants);
const clientBase = { v: enumeration(1), connectionEpoch: id, seq };
function clientRecord(type, fields) {
  return record({ ...clientBase, type: enumeration(type), ...fields });
}
const clientSchema = union("type", {
  hello: record({
    v: enumeration(1),
    type: enumeration("hello"),
    ticket: string(/^[A-Za-z0-9_-]{43}$/, 43),
    rulesHash: hash,
    assetBuildId: hash,
    worldContentHash: optional(hash),
    resume: optional(
      record({
        playSession: id,
        lastEventSeq: revision,
        // Locally presented motion at reconnect is diagnostic only. Resume restores
        // trusted server state even if the client continued moving during the gap.
        motion: optional(reportedMotion),
      }),
    ),
  }),
  input: clientRecord("input", {
    fieldEpoch: id,
    inputSeq: seq,
    targetTick: revision,
    motionEpoch: revision,
    motionConfig: revision,
    movementLocked: boolean,
    impulses: array(
      record({
        id: nullable(revision),
        source: enumeration("hit", "skill"),
        skillId: u32,
      }),
      2,
    ),
    horizontal: axis,
    vertical: axis,
    jump: boolean,
    attack: boolean,
    // Endpoint of exactly one local 30 ms step, validated in stream order.
    motion: reportedMotion,
  }),
  // Provisional outgoing digits follow the original input-edge roll (`009581a9`/`0066b05e`).
  // Reports are bounded telemetry. Server-generated damage and critical rolls remain final.
  "combat.hits": clientRecord("combat.hits", {
    fieldEpoch: id,
    feedbackId: nullable(id),
    inputSeq: nullable(u32),
    skillId: u32,
    hits: array(
      record({
        targetId: id,
        line: number(0, 120),
        damage: number(0, COMBAT_VALUE_LIMIT),
        critical: boolean,
      }),
      32,
    ),
  }),
  command: clientRecord("command", {
    fieldEpoch: id,
    operationId,
    expectedRevision: revision,
    action: actionSchema,
  }),
  ready: clientRecord("ready", { fieldEpoch: id, snapshotId: id }),
  ack: clientRecord("ack", { eventSeq: seq, snapshotId: id }),
  resync: clientRecord("resync", {
    fieldEpoch: id,
    lastEventSeq: seq,
    reason: enumeration("gap", "baseline", "prediction-overflow"),
  }),
  pong: clientRecord("pong", { nonce: id }),
  ...Object.fromEntries(
    Object.entries(WORLD_CLIENT_MESSAGES).map(([type, fields]) => [
      type,
      clientRecord(type, fields),
    ]),
  ),
});

const appearance = record({
  name: text,
  gender: enumeration(0, 1),
  skin: u32,
  face: template,
  hair: template,
  equipment: array(
    record({ slot: u32, templateId: template }),
    32,
    0,
    (value) => value?.slot,
  ),
});
function playerEntityFragments(value) {
  return (
    value.kind === "player" ||
    (value.playerMotion === undefined &&
      value.expression === undefined &&
      value.seat === undefined &&
      value.combatState === undefined &&
      value.skillVisuals === undefined &&
      value.skillVoices === undefined &&
      value.diseases === undefined &&
      value.skillDoor === undefined)
  );
}

function mobEntityFragments(value) {
  return (
    value.kind === "mob" ||
    (value.placementId === undefined && value.mobState === undefined)
  );
}

/** Closed per-tick presentation projection of another actor's own simulation. It carries
 *  no input, inventory or private checkpoint. Native player paths use opcode 0xb9;
 *  this wire adaptation publishes server-simulated samples every 30 ms. */
const playerMotionSchema = record({
  pathTick: optional(revision),
  state: enumeration("ground", "air", "ladder", "swim", "fly"),
  gravity: number(0, 1000000, false),
  fallSpeed: number(0, 1000000, false),
  ignoredFoothold: u32,
  // 009b4929: the drawing contact plane follows a foothold or a ladder's page, and it
  // is the only depth source while climbing, when no foothold is reported.
  contactLayer: number(0, 4096),
  contactGroup: number(0, 4096),
  ladder: nullable(
    record({ x: coordinate, top: coordinate, bottom: coordinate }),
  ),
});

const peerMotionSchema = record({
  id,
  tick: revision,
  durationMs: number(0, 32767),
  moveType: enumeration(0, 3),
  position: point,
  velocity: point,
  foothold: nullable(u32),
  facing,
  action: animation,
  actionStartTick: revision,
  playerMotion: playerMotionSchema,
});

const entity = record(
  {
    id,
    kind: enumeration("player", "mob", "npc", "drop", "reactor"),
    templateId: template,
    placementId: optional(string(LIFE_PLACEMENT_PATTERN, 71)),
    position: point,
    velocity: point,
    foothold: nullable(u32),
    facing,
    action: animation,
    actionStartTick: revision,
    appearance: nullable(appearance),
    playerMotion: optional(playerMotionSchema),
    dropMotion: optional(
      record({
        state: enumeration("waiting", "launching", "falling", "grounded"),
        age: u32,
        phaseAge: u32,
        sourceX: coordinate,
        sourceY: coordinate,
        groundX: coordinate,
        groundY: coordinate,
        durationMs: u32,
        launchSpeed: number(0, 10000, false),
        rotation: number(-1000000, 1000000, false),
        alpha: number(0, 1, false),
      }),
    ),
    ...DROP_ENTITY_FIELDS,
    ...COMBAT_ENTITY_FIELDS,
    ...WORLD_ENTITY_FIELDS,
  },
  (value) =>
    (value.kind === "player") === (value.appearance !== null) &&
    (value.kind === "drop") === (value.dropMotion !== undefined) &&
    (value.kind === "drop") === (value.dropInfo !== undefined) &&
    (value.kind === "reactor") === (value.reactor !== undefined) &&
    (value.kind === "npc" || value.npcSpeech === undefined) &&
    playerEntityFragments(value) &&
    mobEntityFragments(value),
);
const statKey = enumeration(
  "str",
  "dex",
  "int",
  "luk",
  "hp",
  "mp",
  "pad",
  "mad",
  "pdd",
  "mdd",
  "acc",
  "eva",
  "speed",
  "jump",
);
const equipment = record({
  upgradesRemaining: u32,
  upgradesUsed: u32,
  stats: array(
    record({ key: statKey, value: integer }),
    14,
    0,
    (value) => value?.key,
  ),
});
const location = union("kind", {
  inventory: record({ kind: enumeration("inventory"), tab, slot: u32 }),
  equipped: record({ kind: enumeration("equipped"), slot: u32 }),
});
// Only server-admitted rechargeable templates may publish zero remaining charges.
// Template-aware profile/database admission enforces that predicate; intents stay positive.
const item = record({
  id,
  templateId: template,
  owner: string(/^[\s\S]*$/u, 32),
  flags: number(0, 65535),
  expiresAt: nullable(revision),
  quantity: number(0, 2147483647),
  location,
  revision,
  equipment: nullable(equipment),
});
const skill = record({
  id: template,
  rank: u32,
  mastery: u32,
  cooldownUntil: revision,
});
const effect = record({
  id,
  templateId: template,
  kind: enumeration("skill", "item"),
  duration: nullable(number(1, Number.MAX_SAFE_INTEGER)),
  expiresAt: revision,
  cancelable: boolean,
});
const quest = record({
  id: template,
  state: enumeration("active", "claimed"),
  ready: boolean,
  revision,
  objectives: array(narrativeObjectiveSchema, 128),
});
const self = record(
  {
    entity,
    hp: u32,
    mp: u32,
    maxHp: u32,
    maxMp: u32,
    job: template,
    level: u32,
    exp: revision,
    ap: u32,
    sp: array(u32, 10, 10),
    stats: record({ str: u32, dex: u32, int: u32, luk: u32 }),
    effects: array(effect, 128, 0, (value) => value?.id),
  },
  (value) =>
    value.entity?.kind === "player" &&
    value.hp <= value.maxHp &&
    value.mp <= value.maxMp,
);
const capacities = record({
  equip: u32,
  use: u32,
  setup: u32,
  etc: u32,
  cash: u32,
});
const identity = (value) => value?.id;
export const snapshotPartSchema = union("kind", {
  "native-presentation": record(
    {
      kind: enumeration("native-presentation"),
      index: number(0, 63),
      total: number(1, 64),
      data: string(/^[\s\S]*$/u, 12000),
    },
    (value) => value.index < value.total,
  ),
  field: record({
    kind: enumeration("field"),
    field: worldDestinationSchema,
    characterRevision: revision,
    inventoryRevision: revision,
    socialRevision: revision,
    self,
  }),
  entities: record({
    kind: enumeration("entities"),
    entities: array(entity, 128, 0, identity),
  }),
  inventory: record({
    kind: enumeration("inventory"),
    items: array(item, 128, 0, identity),
    mesos,
    capacities,
  }),
  progress: record(
    {
      kind: enumeration("progress"),
      quests: array(quest, 128, 0, identity),
      skills: array(skill, 128, 0, identity),
    },
    (value) =>
      Array.isArray(value.quests) &&
      Array.isArray(value.skills) &&
      value.quests.length + value.skills.length <= 128,
  ),
});
const entityChange = union("kind", {
  upsert: record({ kind: enumeration("upsert"), entity }),
  remove: record({ kind: enumeration("remove"), entityId: id }),
});
const shopRow = record({
  rowId: u32,
  templateId: template,
  unitPrice: mesos,
  stock: nullable(u32),
});
const tradeOffer = record({
  ownerId: id,
  items: array(
    record(
      { item, quantity, ...TRADE_OFFER_ITEM_FIELDS },
      (value) => value.quantity <= value.item?.quantity,
    ),
    9,
    0,
    (value) => value?.item?.id,
  ),
  mesos,
  confirmed: boolean,
});
const part = number(0, 63),
  parts = number(1, 64);
function validPart(value) {
  return value.part < value.parts;
}
function validDialogue(value) {
  if (value.input !== "number" && value.input !== "text") {
    return value.minimum === null && value.maximum === null;
  }
  if (
    !Number.isSafeInteger(value.minimum) ||
    !Number.isSafeInteger(value.maximum) ||
    value.minimum > value.maximum
  ) {
    return false;
  }
  return value.input !== "text" || (value.minimum >= 0 && value.maximum <= 256);
}

function validSkillRank(value) {
  return (value.skillId === null) === (value.rank === null);
}
export const domainEventSchema = union("kind", {
  projectile: record(
    {
      kind: enumeration("projectile"),
      feedbackId: optional(nullable(id)),
      inputSeq: optional(nullable(u32)),
      actionId: id,
      actorId: id,
      targetId: id,
      templateId: template,
      skillId: nullable(template),
      source: point,
      destination: point,
      rank: nullable(number(1, 32767)),
      facing,
      durationMs: u32,
      launchTick: revision,
    },
    validSkillRank,
  ),
  combat: record(
    {
      kind: enumeration("combat"),
      actionId: id,
      actorId: id,
      skillId: nullable(template),
      rank: nullable(number(1, 32767)),
      hits: array(
        record({
          targetId: id,
          damage: number(0, COMBAT_VALUE_LIMIT),
          outcome: enumeration("hit", "miss", "guard"),
        }),
        32,
      ),
      impactTick: revision,
    },
    validSkillRank,
  ),
  "quest.ready": record({
    kind: enumeration("quest.ready"),
    questId: template,
    questRevision: revision,
  }),
  dialogue: record(
    {
      kind: enumeration("dialogue"),
      conversationId: id,
      step: u32,
      npcId: id,
      npcTemplateId: template,
      native: record({
        kind: enumeration(
          "say",
          "yes-no",
          "accept-decline",
          "choice",
          "number",
          "text",
        ),
        speaker: u32,
        prev: boolean,
        next: boolean,
        defaultValue: nullable(string(/^[\s\S]*$/u, 256)),
      }),
      contentId: hash,
      text: optional(string(/^[\s\S]*$/u, 65536)),
      choices: array(u32, 128, 0, true),
      input: enumeration("next", "yesno", "choice", "number", "text"),
      minimum: nullable(integer),
      maximum: nullable(integer),
      ...NARRATIVE_EVENT_FIELDS.dialogue,
    },
    validDialogue,
  ),
  "dialogue.closed": record({
    kind: enumeration("dialogue.closed"),
    conversationId: id,
  }),
  shop: record(
    {
      kind: enumeration("shop"),
      shopSession: id,
      npcId: id,
      npcTemplateId: template,
      revision,
      part,
      parts,
      rows: array(shopRow, 128, 0, (value) => value?.rowId),
    },
    validPart,
  ),
  chat: record({
    kind: enumeration("chat"),
    messageId: id,
    senderId: id,
    senderName: string(/^[\s\S]*$/u, 32),
    channel,
    text: chatText,
  }),
  trade: record(
    {
      kind: enumeration("trade"),
      tradeId: id,
      revision,
      participants: array(id, 2, 2, true),
      members: array(record({ id, appearance }), 2, 2, (value) => value?.id),
      offers: array(tradeOffer, 2, 2, (value) => value?.ownerId),
      ...TRADE_EVENT_FIELDS,
    },
    validTradeEvent,
  ),
  ...SOCIAL_EVENT_SCHEMAS,
  ...COMMERCE_EVENT_SCHEMAS,
  ...NARRATIVE_EVENT_SCHEMAS,
  ...DROP_EVENT_SCHEMAS,
  ...COMBAT_EVENT_SCHEMAS,
  ...WORLD_EVENT_SCHEMAS,
});
export const resultValueSchema = union("kind", {
  ...SOCIAL_RESULT_SCHEMAS,
  ...COMMERCE_RESULT_SCHEMAS,
  ...TRADE_RESULT_SCHEMAS,
  ...NARRATIVE_RESULT_SCHEMAS,
  ...DROP_RESULT_SCHEMAS,
  ...COMBAT_RESULT_SCHEMAS,
  ...WORLD_RESULT_SCHEMAS,
});
const serverBase = {
  v: enumeration(1),
  connectionEpoch: id,
  serverTick: revision,
};
/** One authoritative external impulse (mob hit knockback or a movement skill).
 *  `tick` is the field tick that published it; `skillId` is 0 for a mob hit. The
 *  client owns its own XY, so it merges the vector into its current kernel state at
 *  receipt through the same `applyExternalImpulse` entry point the authority used
 *  rather than replaying a pre-impulse checkpoint. */
const motionDivertSchema = record({
  id: nullable(revision),
  sourceId: optional(id),
  tick: revision,
  vx: coordinate,
  vy: coordinate,
  source: enumeration("hit", "skill"),
  skillId: u32,
});
function serverRecord(type, fields, check = null) {
  return record({ ...serverBase, type: enumeration(type), ...fields }, check);
}
export const serverSchema = union("type", {
  welcome: serverRecord("welcome", {
    playSession: id,
    fieldEpoch: id,
    rulesHash: hash,
    assetBuildId: hash,
    worldContentHash: optional(hash),
    serverTime: revision,
    tickMs: enumeration(30),
    inputLeadTicks: number(0, 8),
    inputBufferTicks: number(0, 4),
    resume: enumeration("continued", "snapshot"),
    limits: record({
      inputPerSecond: u32,
      commandPerSecond: u32,
      maxMessageBytes: number(1, 16384),
    }),
  }),
  snapshot: serverRecord(
    "snapshot",
    {
      snapshotId: id,
      fieldEpoch: id,
      eventSeq: seq,
      ackInputSeq: nullable(seq),
      part,
      parts,
      view: snapshotPartSchema,
    },
    validPart,
  ),
  state: serverRecord("state", {
    snapshotId: id,
    baseSnapshotId: id,
    fieldEpoch: id,
    eventSeq: seq,
    ackInputSeq: nullable(seq),
    changes: array(entityChange, 128),
  }),
  result: serverRecord(
    "result",
    {
      eventSeq: seq,
      operationId,
      status: enumeration("committed", "rejected"),
      code,
      domainRevision: revision,
      transactionId: nullable(id),
      value: optional(resultValueSchema),
    },
    (value) => (value.status === "committed") === (value.code === "OK"),
  ),
  event: serverRecord("event", {
    eventSeq: seq,
    fieldEpoch: id,
    event: domainEventSchema,
  }),
  transition: serverRecord(
    "transition",
    {
      eventSeq: seq,
      transitionId: id,
      phase: enumeration("prepare", "committed", "aborted"),
      sourceEpoch: id,
      destination: nullable(worldDestinationSchema),
      requiredContent: array(hash, 128, 0, true),
      deadline: revision,
      code,
      ...worldTransitionFields(entity, PROTOCOL.MAX_ENTITY_CHANGES),
    },
    (value) =>
      (value.phase === "aborted" || value.destination !== null) &&
      (value.preparation === undefined || value.phase === "prepare"),
  ),
  ping: serverRecord("ping", {
    nonce: id,
    serverTime: revision,
    roundTripMs: nullable(u32),
  }),
  closing: serverRecord("closing", { code, retryAfterMs: u32 }),
  /** The native move packet: an unacknowledged, per-tick stream of other actors' sampled
   *  motion. It is deliberately outside the ordered/acked publication sequence, so a slow
   *  round trip cannot throttle how often peers move on screen. */
  peers: serverRecord("peers", {
    fieldEpoch: id,
    tick: revision,
    entries: array(peerMotionSchema, PROTOCOL.MAX_PEER_MOTIONS),
  }),
  motion: serverRecord("motion", {
    fieldEpoch: id,
    motionEpoch: revision,
    motionConfig: revision,
    motionTick: revision,
    ackInputSeq: nullable(seq),
    paused: boolean,
    motion: motionSchema,
    // True only when the server owns this actor's XY for this tick (transition,
    // death, seat, ladder, or an unpredicted movement skill). Ordinary checkpoints
    // are observations: the browser is authoritative for its own position.
    authoritative: boolean,
    combat: optional(
      record({
        feedbackId: nullable(id),
        inputSeq: nullable(u32),
        locked: boolean,
      }),
    ),
    // External impulses the authority merged into this tick, in application order.
    // The client merges the same vector into its own state at receipt. Empty on
    // every ordinary tick.
    diverts: array(motionDivertSchema, 2),
  }),
});

export function decodeClient(source) {
  const value = decodeJson(source, {
    maxBytes: PROTOCOL.MAX_MESSAGE_BYTES,
    maxDepth: 8,
    maxNodes: CLIENT_SCHEMA_MAX_NODES,
  });
  if (value && Object.hasOwn(value, "v") && value.v !== 1) {
    throw protocolError("UNSUPPORTED_VERSION");
  }
  return validate(value, clientSchema, CLIENT_SCHEMA_MAX_NODES);
}
export function decodeServer(source) {
  const value = decodeJson(source, {
    maxBytes: PROTOCOL.MAX_SERVER_MESSAGE_BYTES,
    maxDepth: 16,
    maxNodes: 32768,
  });
  return validate(value, serverSchema);
}
export function actionDomain(action) {
  validate(action, actionSchema, CLIENT_SCHEMA_MAX_NODES);
  return domains.get(action.kind);
}
/** Transient outcomes survive reconnect only within their existing play session. */
export function actionEphemeral(action) {
  return EPHEMERAL_ACTIONS.has(action.kind);
}
/** Hash this canonical domain/action string, never incoming JSON bytes or socket epochs. */
export function canonicalAction(action) {
  const domain = actionDomain(action);
  return (
    '{"domain":' +
    JSON.stringify(domain) +
    ',"action":' +
    canonical(action, actionSchema) +
    "}"
  );
}
