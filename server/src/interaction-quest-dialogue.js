import { onlineQuestCatalog, questState } from "./quest-lifecycle.js";
import { QuestDialogue } from "../../client/src/quests/quest-dialogue.js";
import {
  checkConditions,
  isNpcEndpoint,
} from "../../client/src/quests/quest-rules.js";
import {
  closeConversation,
  currentNpc,
  interactionReceipt,
  publishInteraction,
  requireInteraction,
  storeDialogue,
  INTERACTION_LIMITS,
} from "./interaction-common.js";

function status(record, npcId, profile) {
  const state = questState(profile, record);
  if (!record.supported || state > 1) {
    return { ok: false, state, code: "quest" };
  }
  const stage = record.stages[state];
  const context = { questId: record.id, npcId };
  const result = checkConditions(stage.check, profile, context);
  if (!result.ok) return { ...result, state };
  return { ...checkConditions(stage.actionCheck, profile, context), state };
}

export function startQuestDialogue(actor, world, lease, questId) {
  const record = onlineQuestCatalog(world.content).records[questId];
  const state = questState(actor.profile, record);
  requireInteraction(
    record?.supported &&
      state < 2 &&
      isNpcEndpoint(
        record.stages[state],
        lease.npcTemplateId,
        record.stages[0],
      ) &&
      (state === 1 || status(record, lease.npcTemplateId, actor.profile).ok),
    "REQUIREMENTS_NOT_MET",
  );
  const system = {
    store: { profile: actor.profile },
    state: (profile) => questState(profile, record),
    status: (entry, npcId) => status(entry, npcId, actor.profile),
  };
  const dialogue = new QuestDialogue(system, record, lease.npcTemplateId);
  const view = dialogue.snapshot();
  requireInteraction(view.choices.length <= 128, "CONTENT_MISMATCH");
  storeDialogue(world, actor, lease, view.text);
  lease.questDialogue = dialogue;
  lease.step++;
  lease.menu = null;
  lease.view = null;
  if (silentQuestAction(lease)) {
    grantQuestOffer(actor, lease, view);
    return;
  }
  return publishQuestDialogue(actor, world, lease);
}

/**
 * Original 00717740/00717963 return 1 for a Say stage without pages, so the
 * client sends the accept/complete action with no dialogue. A reward choice
 * still needs the 0071808a selection, so that shape keeps its confirmation.
 */
export function silentQuestAction(lease) {
  const view = lease.questDialogue?.snapshot();
  if (view?.mode !== "confirm" || view.pageCount || view.rewardChoices.length) {
    return null;
  }
  return view.stage === 0 ? "quest.accept" : "quest.claim";
}

function grantQuestOffer(actor, lease, view) {
  lease.offers = [];
  if (
    view.mode === "confirm" &&
    status(lease.questDialogue.record, lease.npcTemplateId, actor.profile).ok
  ) {
    lease.offers.push({
      questId: view.questId,
      action: view.stage === 0 ? "accept" : "claim",
    });
  }
}

export function publishQuestDialogue(actor, world, lease) {
  const dialogue = lease.questDialogue;
  dialogue.system.store.profile = actor.profile;
  const view = dialogue.snapshot();
  grantQuestOffer(actor, lease, view);
  if (view.mode === "closed") {
    closeConversation(actor, world);
    return;
  }
  requireInteraction(view.choices.length <= 128, "CONTENT_MISMATCH");
  requireInteraction(view.rewardChoices.length <= 128, "CONTENT_MISMATCH");
  const contentId = storeDialogue(world, actor, lease, view.text);
  publishInteraction(world, actor, {
    kind: "dialogue",
    conversationId: lease.id,
    step: lease.step,
    npcId: lease.npcId,
    npcTemplateId: lease.npcTemplateId,
    quest: {
      questId: view.questId,
      stage: view.stage,
      mode: view.mode,
      rewardChoices: view.rewardChoices.map(({ index, id, count }) => ({
        index,
        id,
        count,
      })),
    },
    native: {
      kind:
        view.mode === "confirm" && view.stage === 0
          ? "accept-decline"
          : view.choices.length
            ? "choice"
            : "say",
      speaker: 0,
      prev: view.canPrevious,
      next:
        view.mode === "offer" || (view.mode !== "confirm" && !view.finalPage),
      defaultValue: null,
    },
    contentId,
    choices: view.choices,
    input: view.choices.length ? "choice" : "next",
    minimum: null,
    maximum: null,
  });
}

function validateQuestAdvance(dialogue, view, answer) {
  if (answer.kind === "next" || answer.kind === "choice") {
    requireInteraction(
      dialogue.steps < 2048 &&
        view.mode !== "confirm" &&
        view.mode !== "closed",
      "NOT_ALLOWED",
    );
    requireInteraction(
      view.choices.length
        ? answer.kind === "choice" && view.choices.includes(answer.choiceId)
        : answer.kind === "next",
      "NOT_ALLOWED",
    );
  }
}

export function answerQuestDialogue(actor, message, world, lease) {
  currentNpc(world, actor, lease);
  const dialogue = lease.questDialogue;
  const answer = message.action.answer;
  const view = dialogue.snapshot();
  if (answer.kind === "cancel") {
    closeConversation(actor, world);
    return interactionReceipt(lease.step + 1);
  }
  validateQuestAdvance(dialogue, view, answer);
  if (answer.kind === "yesno") {
    requireInteraction(
      answer.value === false && view.stage === 0 && view.mode === "confirm",
      "NOT_ALLOWED",
    );
    requireInteraction(dialogue.reject(), "NOT_ALLOWED");
  } else if (answer.kind === "previous") {
    requireInteraction(dialogue.previous());
  } else {
    requireInteraction(
      answer.kind === "next" || answer.kind === "choice",
      "INVALID_MESSAGE",
    );
    const outcome = dialogue.advance(
      answer.kind === "choice" ? answer.choiceId : null,
    );
    requireInteraction(outcome.ok, "NOT_ALLOWED");
  }
  lease.step++;
  lease.expiresAt = Date.now() + INTERACTION_LIMITS.leaseMs;
  publishQuestDialogue(actor, world, lease);
  return interactionReceipt(lease.step);
}

export function finishQuestDialogue(actor, world, lease) {
  const dialogue = lease.questDialogue;
  dialogue.committed({ ok: true });
  lease.offers = [];
  publishQuestDialogue(actor, world, lease);
}
