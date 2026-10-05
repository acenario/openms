import {
  onlineQuestCatalog,
  questState,
  commitQuestLifecycle,
} from "./quest-lifecycle.js";
import {
  stateOf,
  isNpcEndpoint,
  checkConditions,
  transaction,
} from "../../client/src/quests/quest-rules.js";
import { questObjectives } from "../../client/src/quests/quest-journal-model.js";
import { isCustomQuest } from "../../client/src/quests/custom-quests.js";
import { learnedGrowth } from "../../client/src/character/offline-progression.js";
import {
  currentNpc,
  requireInteraction,
  serverRandomSamples,
  sampleReader,
  INTERACTION_LIMITS,
} from "./interaction-common.js";
import { operationFor, admitActor } from "./action-rules.js";
import {
  finishQuestDialogue,
  silentQuestAction,
} from "./interaction-quest-dialogue.js";
import { narrativeQuestSystem } from "./interaction-quest-system.js";
import { virtualNpcLease } from "./interaction-npc-lease.js";
import {
  questRewardEvents,
  publishNarrativeEvents,
} from "./interaction-npc-feedback.js";

import {
  closeConversation,
  interactionReceipt,
  requireCharacterRevision,
} from "./interaction-common.js";
import { startQuestDialogue } from "./interaction-quest-dialogue.js";
import {
  familyProgressIds,
  applyOnlineFamilyProgress,
} from "./social-family.js";

const MAX_QUESTS = 4096;
const MAX_OFFERS = 128;

function questAdmission(record, profile, npcId, stage) {
  requireInteraction(
    record?.supported && record.stages?.[stage],
    "CONTENT_MISMATCH",
  );
  requireInteraction(
    questState(profile, record) === stage,
    "REQUIREMENTS_NOT_MET",
  );
  const endpoint = record.stages[stage];
  requireInteraction(
    isNpcEndpoint(endpoint, npcId, record.stages[0]),
    "NOT_ALLOWED",
  );
  const context = { questId: record.id, npcId };
  requireInteraction(
    checkConditions(endpoint.check, profile, context).ok &&
      checkConditions(endpoint.actionCheck, profile, context).ok,
    "REQUIREMENTS_NOT_MET",
  );
  return endpoint;
}

export function questOffers(actor, world, lease) {
  // Browsing an active quest is allowed before its completion gates pass.
  // Only publishQuestDialogue can grant the separate confirmation/reward lease.
  const entries = narrativeQuestSystem(actor.profile, world).npcEntries(
    lease.npcTemplateId,
  );
  requireInteraction(entries.length <= MAX_OFFERS, "CONTENT_MISMATCH");
  return entries.map(({ record, state, ready }) => ({
    questId: record.id,
    action: state === 0 ? "accept" : "claim",
    state,
    ready,
  }));
}

/** Require the current authored confirmation before planning quest effects. */
function admitQuestConversation(actor, action, world) {
  const lease = actor.conversation;
  currentNpc(world, actor, lease);
  requireInteraction(
    action.conversationId === lease.id && action.step === lease.step,
    "STALE_REVISION",
  );
  const kind = action.kind === "quest.accept" ? "accept" : "claim";
  requireInteraction(
    lease.offers.some(
      (offer) => offer.questId === action.questId && offer.action === kind,
    ),
  );
  requireInteraction(
    lease.questDialogue?.mode === "confirm" &&
      lease.questDialogue.record.id === action.questId,
    "NOT_ALLOWED",
  );
  return lease;
}

/** Authored Check/Act and server lifecycle deadlines commit in one transaction. */
export async function executeQuest(actor, message, world) {
  const action = message.action;
  requireInteraction(!actor.tradeId, "CHARACTER_BUSY");
  if (action.kind === "medal.open") return openMedal(actor, message, world);
  if (action.kind === "medal.forfeit") {
    const system = narrativeQuestSystem(actor.profile, world);
    requireInteraction(
      system.isMedalRecord(
        onlineQuestCatalog(world.content).records[action.questId],
      ),
      "NOT_ALLOWED",
    );
    return abandonQuest(actor, message, world);
  }
  if (action.kind === "quest.abandon") {
    return abandonQuest(actor, message, world);
  }
  return commitQuestAction(actor, message, world, null);
}

/** Accept/claim against the admitted conversation; `silent` overrides its operation. */
async function commitQuestAction(actor, message, world, silent) {
  const action = message.action;
  const lease = admitQuestConversation(actor, action, world);
  const kind = action.kind === "quest.accept" ? "accept" : "claim";
  const record = onlineQuestCatalog(world.content).records[action.questId];
  const stage = kind === "accept" ? 0 : 1;
  const receipt = await commitQuest(actor, message, world, {
    lease,
    record,
    stage,
    ...silent,
  });
  if (receipt.status === "committed") {
    lease.step++;
    lease.expiresAt = Date.now() + INTERACTION_LIMITS.leaseMs;
    finishQuestDialogue(actor, world, lease);
    publishNarrativeEvents(actor, receipt, world);
  }
  return receipt;
}

function abandonQuest(actor, message, world) {
  const id = message.action.questId;
  return world.participants.commit(
    actor,
    operationFor(message),
    [actor.id],
    (profiles) => {
      const draft = profiles.get(actor.id);
      admitActor(actor, world, message.fieldEpoch);
      const record = onlineQuestCatalog(world.content).records[id];
      // The supported one-shot reference policy resets only this quest's progress, never items.
      requireInteraction(record?.supported, "CONTENT_MISMATCH");
      requireInteraction(
        stateOf(draft, id) === 1 && !(id >= 1200 && id <= 1399),
        "NOT_ALLOWED",
      );
      delete draft.quests[id];
      draft.settings.questTracker.ids = draft.settings.questTracker.ids.filter(
        (entry) => entry !== id,
      );
      return { value: { kind: "quest.changed", questId: id, state: 0 } };
    },
  );
}

function objectiveRows(system, record, profile) {
  const rows = questObjectives(system, record, profile);
  requireInteraction(rows.length <= 128, "CONTENT_MISMATCH");
  return rows.map((row) => ({
    kind: row.kind === "mob" ? "kill" : row.kind,
    templateId: row.templateId,
    current: row.current,
    required: row.required,
    done: row.done,
    progress: row.progress,
  }));
}

export function progressQuestViews(actor, world) {
  const entries = Object.entries(actor.profile.quests);
  requireInteraction(entries.length <= MAX_QUESTS, "CONTENT_MISMATCH");
  const views = [];
  const system = { catalog: onlineQuestCatalog(world.content) };
  for (const [key, progress] of entries) {
    // State-only custom quests have no journal record.
    if (progress.state === 0 || isCustomQuest(key)) continue;
    const id = Number(key);
    const record = onlineQuestCatalog(world.content).records[id];
    requireInteraction(record, "CONTENT_MISMATCH");
    if (progress.state === 1 && questState(actor.profile, record) === 0) {
      continue;
    }
    const stage = record.stages[1];
    const context = {
      questId: id,
      npcId: stage.check.npc || stage.actionCheck.npc,
    };
    const ready =
      progress.state === 1 &&
      record.supported &&
      checkConditions(stage.check, actor.profile, context).ok &&
      checkConditions(stage.actionCheck, actor.profile, context).ok;
    views.push({
      id,
      state: progress.state === 2 ? "claimed" : "active",
      ready: Boolean(ready),
      revision: actor.revision,
      objectives: objectiveRows(system, record, actor.profile),
    });
  }
  return views;
}

/** Native Title supplies an authored endpoint, not an invented physical placement. */
async function openMedal(actor, message, world) {
  requireCharacterRevision(actor, message);
  admitActor(actor, world, message.fieldEpoch);
  requireInteraction(actor.profile.hp > 0, "CHARACTER_BUSY");
  const { questId, stage } = message.action;
  const admission = narrativeQuestSystem(actor.profile, world).medalAdmission(
    questId,
    stage,
  );
  requireInteraction(admission.ok, "REQUIREMENTS_NOT_MET");
  const lease = virtualNpcLease(actor, admission.npcId, {
    kind: "medal",
    questId,
    stage,
  });
  closeConversation(actor, world);
  actor.conversation = lease;
  startQuestDialogue(actor, world, lease, questId);
  return (
    (await commitSilentQuest(actor, message, world, {
      operation: operationFor(message),
    })) ?? interactionReceipt(actor.revision)
  );
}

/**
 * A selected zero-page stage commits inside the selecting operation, as the
 * original client sends its action without dialogue (see silentQuestAction).
 * Returns null when the stage has dialogue; a refusal closes the conversation.
 */
export async function commitSilentQuest(actor, message, world, silent) {
  const lease = actor.conversation;
  const kind = silentQuestAction(lease);
  if (!kind) return null;
  const action = {
    kind,
    questId: lease.questDialogue.record.id,
    conversationId: lease.id,
    step: lease.step,
  };
  try {
    return await commitQuestAction(
      actor,
      { ...message, action },
      world,
      silent,
    );
  } finally {
    if (
      actor.conversation === lease &&
      lease.questDialogue.mode === "confirm"
    ) {
      closeConversation(actor, world);
    }
  }
}

/** EXP, quest rewards and every mirrored family level effect share one durable cohort. */
function commitQuest(actor, message, world, plan) {
  const now = Date.now();
  const samples = serverRandomSamples();
  const ids = [...new Set([actor.id, ...familyProgressIds(actor.profile)])];
  return world.participants.commit(
    actor,
    plan.operation ?? operationFor(message),
    ids,
    async (drafts) => {
      const draft = drafts.get(actor.id);
      const { lease, record, stage } = plan;
      currentNpc(world, actor, lease);
      questAdmission(record, draft, lease.npcTemplateId, stage);
      const growth = learnedGrowth(
        draft,
        world.content.catalog.ui.skills,
        now,
        { hp: 0, mp: 0 },
      );
      const result = transaction(draft, record, stage, {
        selected: message.action.rewardChoice,
        growth,
        items: world.content.items,
        // First sample keeps the weighted-reward draw; level-up rolls read the following ones.
        random: sampleReader(samples),
        now,
      });
      requireInteraction(
        result.ok,
        result.code === "reward-choice"
          ? "INVALID_MESSAGE"
          : "REQUIREMENTS_NOT_MET",
      );
      commitQuestLifecycle(draft, record, stage, {
        content: world.content,
        now,
        operationId: message.operationId,
      });
      if (stage === 1) {
        draft.settings.questTracker.ids =
          draft.settings.questTracker.ids.filter((id) => id !== record.id);
      }
      requireInteraction(
        Number.isInteger(result.levels) &&
          result.levels >= 0 &&
          result.levels <= 200,
        "CONTENT_MISMATCH",
      );
      applyQuestLevels(drafts, actor.id, result.levels, {
        now,
        operationId: message.operationId,
      });
      return {
        domainRevision: plan.domainRevision,
        value: { kind: "quest.changed", questId: record.id, state: stage + 1 },
        events: questRewardEvents(record, stage, result),
      };
    },
  );
}

function applyQuestLevels(drafts, actorId, levels, context) {
  for (let level = 0; level < levels; level++) {
    applyOnlineFamilyProgress(
      drafts,
      actorId,
      { kind: "level", maxHp: 0 },
      context,
    );
  }
}
