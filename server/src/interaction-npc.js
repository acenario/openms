import { decodeResponse } from "../../client/src/npc/npc-script-runtime.js";
import {
  npcReferences,
  resolveNpcRoute,
  npcEnvironment,
} from "./interaction-npc-content.js";
import { boundedNpcTurn, replayNpcPlan } from "./interaction-npc-executor.js";
import { openShop, admitShop } from "./interaction-shop.js";
import { questOffers } from "./interaction-quest.js";
import { publishNpcMenu, answerNpcMenu } from "./interaction-npc-menu.js";
import {
  startAuthoredDialogue,
  answerAuthoredDialogue,
} from "./interaction-npc-authored.js";
import { answerQuestDialogue } from "./interaction-quest-dialogue.js";
import { operationFor } from "./action-rules.js";
import { admitActor } from "./action-rules.js";
import { portalNpcProgram, virtualNpcLease } from "./interaction-npc-lease.js";
import {
  npcRewardEvents,
  publishNarrativeEvents,
} from "./interaction-npc-feedback.js";

import {
  familyProgressIds,
  applyOnlineFamilyProgress,
} from "./social-family.js";
import {
  closeConversation,
  currentNpc,
  freshLease,
  interactionReceipt,
  publishInteraction,
  requireCharacterRevision,
  requireInteraction,
  serverRandomSamples,
  storeDialogue,
  INTERACTION_LIMITS,
} from "./interaction-common.js";

export async function executeNpc(actor, message, world) {
  if (message.action.kind === "npc.open") return openNpc(actor, message, world);
  if (message.action.answer.kind === "cancel") {
    return cancelNpc(actor, message, world);
  }
  const lease = actor.conversation;
  currentNpc(world, actor, lease);
  requireInteraction(
    message.action.conversationId === lease.id &&
      message.action.step === lease.step &&
      message.expectedRevision === lease.step,
    "STALE_REVISION",
  );
  if (lease.unavailable) {
    requireInteraction(
      ["cancel", "next"].includes(message.action.answer.kind),
      "NOT_ALLOWED",
    );
    closeConversation(actor, world);
    return interactionReceipt(lease.step + 1);
  }
  if (lease.questDialogue) {
    return answerQuestDialogue(actor, message, world, lease);
  }
  if (lease.menu) {
    const receipt = answerNpcMenu(actor, message, world, lease);
    return receipt ?? runRoute(actor, message, world, lease);
  }
  if (lease.authored) {
    return answerAuthoredDialogue(actor, message, world, lease);
  }
  requireInteraction(lease.view, "NOT_ALLOWED");
  if (lease.view.kind === "storage") {
    requireInteraction(message.action.answer.kind === "cancel", "NOT_ALLOWED");
    closeConversation(actor, world);
    return interactionReceipt(lease.step + 1);
  }
  const input = decodeResponse(
    { ...lease.view, sessionId: lease.id, revision: lease.step },
    wireResponse(lease, message.action.answer),
  );
  if (input.local) {
    closeConversation(actor, world);
    return interactionReceipt(lease.step + 1);
  }
  return runTurn(actor, message, world, { lease, input });
}

/** Cancel has no script effects and is idempotent for this actor's conversation ID. */
function cancelNpc(actor, message, world) {
  admitActor(actor, world, actor.field.epoch);
  const lease = actor.conversation;
  if (lease?.id !== message.action.conversationId) {
    return interactionReceipt(actor.revision);
  }
  closeConversation(actor, world);
  return interactionReceipt(lease.step + 1);
}

async function openNpc(actor, message, world) {
  requireCharacterRevision(actor, message);
  requireInteraction(!actor.tradeId && actor.profile.hp > 0, "CHARACTER_BUSY");
  const npc = world.npc(actor, message.action.npcId);
  const references = await npcReferences(world);
  requireCharacterRevision(actor, message);
  const lease = freshLease(actor, npc);
  currentNpc(world, actor, lease);
  const route = resolveNpcRoute(references, npc, world.content.catalog);
  const offers = questOffers(actor, world, lease);
  closeConversation(actor, world);
  // Like the offline interaction, no talk endpoint and no quest is a no-op.
  if (!offers.length && !route) return interactionReceipt(actor.revision);
  actor.conversation = lease;
  actor.shop = null;
  lease.route = route;
  if (offers.length) lease.menu = offers;
  return openLease(actor, message, world, lease);
}

/**
 * Every opening view (menu, shop, storage, script) runs under the acquired
 * lease; a refused or failed opening releases it rather than leaving the
 * character's portals and NPCs blocked until the lease expires.
 */
async function openLease(actor, message, world, lease) {
  try {
    if (lease.menu?.length) {
      lease.step++;
      publishNpcMenu(actor, world, lease);
      return interactionReceipt(actor.revision);
    }
    const receipt = await runRoute(actor, message, world, lease);
    if (receipt.status !== "committed") releaseLease(actor, world, lease);
    return receipt;
  } catch (error) {
    releaseLease(actor, world, lease);
    throw error;
  }
}

/** A newer conversation acquired during an awaited opening stays untouched. */
function releaseLease(actor, world, lease) {
  if (actor.conversation === lease) closeConversation(actor, world);
}

/** Only the authenticated original tutorial portal may acquire this virtual conversation. */
export async function openPortalNpc(actor, portal, world) {
  const field = actor.field;
  admitActor(actor, world, field.epoch);
  const program = portalNpcProgram(actor, portal);
  if (actor.conversation) return;
  requireInteraction(!actor.tradeId && actor.profile.hp > 0, "CHARACTER_BUSY");
  const characters = await world.database.listCharacters(actor.accountId);
  admitActor(actor, world, field.epoch);
  requireInteraction(actor.field === field, "STALE_FIELD");
  if (
    actor.profile.level < program.openNpc.minimumAccountLevel &&
    !characters.some(
      (entry) => entry.level >= program.openNpc.minimumAccountLevel,
    )
  ) {
    return;
  }
  if (actor.conversation) return;
  const lease = virtualNpcLease(actor, program.openNpc.npcId, {
    kind: "portal",
    portalId: portal.id,
  });
  const references = await npcReferences(world);
  admitActor(actor, world, field.epoch);
  requireInteraction(
    !actor.conversation && actor.field === field,
    "CHARACTER_BUSY",
  );
  lease.route = resolveNpcRoute(
    references,
    { templateId: lease.npcTemplateId },
    world.content.catalog,
  );
  requireInteraction(lease.route?.status === "supported", "CONTENT_MISMATCH");
  actor.conversation = lease;
  const message = {
    operationId: crypto.randomUUID(),
    expectedRevision: actor.revision,
    fieldEpoch: field.epoch,
    action: { kind: "npc.open", npcId: lease.npcId },
  };
  const receipt = await openLease(actor, message, world, lease);
  requireInteraction(receipt.status === "committed", receipt.code);
}

async function runRoute(actor, message, world, lease) {
  const route = lease.route;
  if (route?.status === "blocked") return unavailableNpc(actor, world, lease);
  requireInteraction(route?.status === "supported", "CONTENT_MISMATCH");
  if (route.precedence === "authored-dialogue") {
    const step = startAuthoredDialogue(actor, world, lease, route);
    return interactionReceipt(
      message.action.kind === "npc.open" ? actor.revision : step,
    );
  }
  if (route.precedence === "standard-shop-fallback") {
    lease.step++;
    await openShop(actor, world, lease, route.shopId);
    return interactionReceipt(
      message.action.kind === "npc.open" ? actor.revision : lease.step,
    );
  }
  lease.compilation = route;
  lease.environment = await npcEnvironment(
    world,
    lease,
    await npcReferences(world),
    route,
  );
  return runTurn(actor, message, world, { lease, input: { start: true } });
}

/** Server availability feedback is explicit; it does not invent an authored script or reward. */
async function unavailableNpc(actor, world, lease) {
  world.log?.("npc.unavailable", {
    source: lease.npcTemplateId,
    reason: lease.route.blockers
      ?.slice(0, 8)
      .map((blocker) => `${blocker.source}:${blocker.line} ${blocker.reason}`)
      .join("; "),
  });
  lease.unavailable = true;
  lease.step++;
  lease.view = {
    kind: "say",
    speaker: 0,
    prev: false,
    next: false,
    text: "#eService unavailable#n\r\nThis NPC's service is not available on this server yet.",
  };
  await publishNpcView(actor, world, lease);
  return interactionReceipt(actor.revision);
}

function wireResponse(lease, answer) {
  const response = { sessionId: lease.id, revision: lease.step };
  if (answer.kind === "cancel") response.action = "close";
  else if (answer.kind === "next") {
    response.action =
      lease.view.kind === "say" && !lease.view.next ? "acknowledge" : "next";
  } else if (answer.kind === "previous") response.action = "previous";
  else if (answer.kind === "yesno") {
    response.action =
      lease.view.kind === "accept-decline"
        ? answer.value
          ? "accept"
          : "decline"
        : answer.value
          ? "yes"
          : "no";
  } else if (answer.kind === "choice") {
    response.action = "choose";
    response.value = answer.choiceId;
  } else {
    response.action = answer.kind;
    response.value = answer.value;
  }
  return response;
}

function turnRequest(actor, lease, input) {
  requireInteraction((lease.turns ?? 0) < 2048, "SESSION_EXPIRED");
  return {
    compilation: lease.compilation,
    environment: lease.environment,
    state: lease.vmState,
    profile: scriptProfile(actor.profile),
    input,
    now: Date.now(),
    samples: serverRandomSamples(),
  };
}

function scriptProfile(profile) {
  const snapshot = structuredClone(profile);
  delete snapshot.onlineState;
  return snapshot;
}

async function admitView(actor, world, lease, view) {
  if (view.kind === "closed") return;
  if (view.kind === "shop") {
    await admitShop(world, view.shopId);
    return;
  }
  if (view.kind === "storage") {
    requireInteraction(
      typeof world.openStorage === "function" &&
        world.content.catalog.ui.npcPortraits[lease.npcTemplateId]?.storage,
      "CONTENT_MISMATCH",
    );
    requireInteraction(view.npcId === lease.npcTemplateId, "NOT_ALLOWED");
    return;
  }
  requireInteraction(
    ["say", "yes-no", "accept-decline", "choice", "number", "text"].includes(
      view.kind,
    ),
    "CONTENT_MISMATCH",
  );
  requireInteraction(
    view.kind !== "choice" || view.choices.length <= 128,
    "CONTENT_MISMATCH",
  );
  requireInteraction(
    view.kind !== "text" || view.minLength <= 256,
    "CONTENT_MISMATCH",
  );
  storeDialogue(world, actor, lease, view.text);
}

function sameDestination(first, second) {
  return (
    first?.mapId === second?.mapId &&
    first?.portal === second?.portal &&
    first?.randomSpawn === second?.randomSpawn
  );
}

async function runTurn(actor, message, world, { lease, input }) {
  currentNpc(world, actor, lease);
  const request = turnRequest(actor, lease, input);
  let result = await boundedNpcTurn(world, request);
  currentNpc(world, actor, lease);
  requireInteraction(actor.conversation === lease, "SESSION_EXPIRED");
  await admitView(actor, world, lease, result.view);
  let receipt = interactionReceipt(
    message.action.kind === "npc.open" ? actor.revision : lease.step + 1,
  );
  if (result.operations.length) {
    const committed = await commitTurn(actor, message, world, {
      lease,
      request,
      result,
    });
    receipt = committed.receipt;
    result = committed.result;
    if (receipt.status !== "committed") return receipt;
  }
  lease.step++;
  lease.turns = (lease.turns ?? 0) + 1;
  lease.vmState = result.state;
  lease.view = result.view;
  lease.expiresAt = Date.now() + INTERACTION_LIMITS.leaseMs;
  try {
    await finishTurnView(actor, world, lease);
  } catch (error) {
    if (!receipt.applied) throw error;
    world.deliveryFailed(actor, error);
  }
  publishNarrativeEvents(actor, receipt, world);
  return receipt;
}

async function prepareTurnPlan(actor, world, turn, draft) {
  const { lease, message, destination } = turn;
  currentNpc(world, actor, lease, Boolean(destination));
  requireInteraction(actor.conversation === lease, "SESSION_EXPIRED");
  if (message.action.kind === "npc.answer") {
    requireInteraction(
      message.expectedRevision === lease.step,
      "STALE_REVISION",
    );
  }
  const request = { ...turn.request, profile: scriptProfile(draft) };
  const prepared = await boundedNpcTurn(world, request);
  requireInteraction(
    sameDestination(
      destination,
      prepared.effects.find((effect) => effect.kind === "warp"),
    ),
    "REQUIREMENTS_NOT_MET",
  );
  requireInteraction(
    JSON.stringify(prepared.view) === JSON.stringify(turn.view),
    "REQUIREMENTS_NOT_MET",
  );
  currentNpc(world, actor, lease, Boolean(destination));
  return { request, prepared };
}

async function replayTurnPlan(actor, world, turn, profiles) {
  const draft = profiles.get(actor.id);
  const { request, prepared } = await prepareTurnPlan(
    actor,
    world,
    turn,
    draft,
  );
  const previousLevel = draft.level;
  turn.result = replayNpcPlan(draft, request, prepared);
  const familyProgress = {
    now: world.now,
    operationId: turn.message.operationId,
  };
  for (let level = previousLevel + 1; level <= draft.level; level++) {
    applyOnlineFamilyProgress(
      profiles,
      actor.id,
      { kind: "level", maxHp: 0 },
      familyProgress,
    );
  }
  return {
    domainRevision:
      turn.message.action.kind === "npc.answer"
        ? turn.lease.step + 1
        : undefined,
    value: {
      kind: "npc.turn",
      conversationId: turn.lease.id,
      step: turn.lease.step + 1,
    },
    events: npcRewardEvents(turn.lease, turn.result),
  };
}

async function commitTurn(actor, message, world, execution) {
  const destination = execution.result.effects.find(
    (effect) => effect.kind === "warp",
  );
  const turn = {
    ...execution,
    message,
    destination,
    view: execution.result.view,
  };
  const operation = {
    ...operationFor(message),
    domainRevision: turn.lease.step,
  };
  const ids = [actor.id, ...familyProgressIds(actor.profile)];
  const mutate = (profiles) => replayTurnPlan(actor, world, turn, profiles);
  let receipt;
  if (destination) {
    receipt = await world.transition(actor, destination, {
      ...operation,
      ids,
      mutate,
    });
  } else {
    receipt = await world.participants.commit(actor, operation, ids, mutate);
  }
  if (receipt.status === "committed") {
    try {
      world.publish(actor, { type: "snapshot-request" });
    } catch (error) {
      world.deliveryFailed(actor, error);
    }
  }
  return { receipt, result: turn.result };
}

async function finishTurnView(actor, world, lease) {
  if (actor.field.epoch !== lease.fieldEpoch) {
    closeConversation(actor, world);
    return;
  }
  await publishNpcView(actor, world, lease);
  if (lease.view.kind === "closed" && !lease.offers.length) {
    closeConversation(actor, world);
  }
}

/** Translate an admitted authored prompt into its wire input kind. */
function dialogueInput(view) {
  if (view.kind === "say") return "next";
  if (["yes-no", "accept-decline"].includes(view.kind)) return "yesno";
  return view.kind;
}

function dialogueBounds(view) {
  if (view.kind === "number") return { minimum: view.min, maximum: view.max };
  if (view.kind === "text") {
    return { minimum: view.minLength, maximum: Math.min(view.maxLength, 256) };
  }
  return { minimum: null, maximum: null };
}

export async function publishNpcView(actor, world, lease = actor.conversation) {
  const view = lease?.view;
  if (!view || view.kind === "closed") return;
  if (view.kind === "shop") {
    await openShop(actor, world, lease, view.shopId);
    return;
  }
  if (view.kind === "storage") {
    await world.openStorage(actor, lease);
    return;
  }
  requireInteraction(
    ["say", "yes-no", "accept-decline", "choice", "number", "text"].includes(
      view.kind,
    ),
    "CONTENT_MISMATCH",
  );
  const input = dialogueInput(view);
  const choices =
    view.kind === "choice" ? view.choices.map((choice) => choice.id) : [];
  requireInteraction(choices.length <= 128, "CONTENT_MISMATCH");
  const contentId = storeDialogue(world, actor, lease, view.text);
  publishInteraction(world, actor, {
    kind: "dialogue",
    conversationId: lease.id,
    step: lease.step,
    npcId: lease.npcId,
    npcTemplateId: lease.npcTemplateId,
    native: {
      kind: view.kind,
      speaker: view.speaker,
      prev: view.prev === true,
      next: view.next === true,
      defaultValue:
        view.defaultValue === undefined ? null : String(view.defaultValue),
    },
    contentId,
    choices,
    input,
    ...dialogueBounds(view),
  });
}
