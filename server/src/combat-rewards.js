import { randomUUID, createHash } from "node:crypto";
import {
  awardExperience,
  learnedGrowth,
} from "../../client/src/character/offline-progression.js";
import { applyOnlineFamilyProgress } from "./social-family.js";
import {
  prepareKillDrops,
  commitKillDrops,
  releaseKillDrops,
} from "./field-drops.js";
import { progressQuestViews } from "./interaction-quest.js";

import {
  planKillCredit,
  killCreditIds,
  assignKillLoot,
} from "./kill-credit.js";
import { protocolError } from "../../shared/schema.js";
import { commitPickpocketDrops, releaseSkillDrops } from "./skill-drops.js";
import { broadcastLevelUp } from "./field-effects.js";
import { dropBirths } from "./database-history.js";

export function combatOperation(actor, kind, operationId = randomUUID()) {
  return {
    operationId,
    kind,
    domain: "character",
    fieldEpoch: actor.field.epoch,
    expectedRevision: actor.revision,
    digest: createHash("sha256")
      .update(`${kind}:${actor.id}:${actor.field.epoch}:${operationId}`)
      .digest("hex"),
  };
}

/** Label every rolled ground drop with the monster or pickpocket skill that produced it. */
function killItemBirths(plan, pickpocket, mob, owner) {
  const mapId = Number(owner.profile.location.mapId);
  const births = dropBirths(plan.requests, {
    source: "monster",
    sourceId: String(mob.templateId),
    mapId,
  });
  if (!pickpocket) return births;
  return births.concat(
    dropBirths(pickpocket.requests, {
      source: "skill",
      sourceId: String(mob.templateId),
      mapId,
      detail: { skill: "pickpocket" },
    }),
  );
}

/** One generation has one producer; EXP, quests, family and loot escrow share its receipt. */
export async function rewardKill(world, actor, mob, showdown = 0) {
  if (mob.rewardGeneration === mob.deaths) return;
  mob.rewardGeneration = mob.deaths;
  const field = actor.field;
  const operation = combatOperation(actor, "combat.reward");
  mob.killDropRate = 1 + showdown / 100;
  let plan = null;
  const pickpocket = actor.skillDrops.takePickpocketPlan();
  const credit = mob.creditPlan ?? planKillCredit(world, actor, mob);
  try {
    const receipt = await world.participants.commitProduced(
      actor,
      operation,
      () => killCreditIds(credit),
      async (drafts) => {
        if (
          world.actors.get(actor.id) !== actor ||
          actor.field !== field ||
          field.characters.get(actor.id) !== actor
        ) {
          throw protocolError("STALE_FIELD");
        }
        plan = await prepareKillDrops(world, credit.lootOwner, mob);
        assignKillLoot(credit, plan);
        const rewards = awardKillProgress(world, credit, drafts, {
          mob,
          operation,
        });
        const own = rewards.find((row) => row.actorId === actor.id);
        const amount = own?.amount ?? 0,
          levels = own?.levels ?? 0;
        return {
          value: {
            kind: "combat.reward",
            amount,
            levels,
            dropPlanId: plan.id,
            pickpocketPlanId: pickpocket?.id ?? null,
            rewards,
          },
          grantEntitlements: pickpocket
            ? [...plan.grantEntitlements, ...pickpocket.grantEntitlements]
            : plan.grantEntitlements,
          itemBirths: killItemBirths(plan, pickpocket, mob, credit.lootOwner),
        };
      },
    );
    if (receipt.status !== "committed" || !plan) return;
    commitKillDrops(world, credit.lootOwner, plan, receipt);
    if (pickpocket) commitPickpocketDrops(world, actor, pickpocket, receipt);
    if (receipt.value?.dropPlanId !== plan.id) return;
    for (const reward of receipt.value.rewards) {
      publishKillReward(world, world.actors.get(reward.actorId), reward, field);
    }
  } finally {
    if (plan) releaseKillDrops(field, plan);
    if (pickpocket) releaseSkillDrops(pickpocket);
  }
}

function awardKillProgress(world, credit, drafts, context) {
  return credit.rewards.map((member) =>
    awardMemberProgress(world, member, drafts, context),
  );
}

function awardMemberProgress(world, member, drafts, { mob, operation }) {
  const { actor, amount } = member;
  const profile = drafts.get(actor.id);
  const beforeReady = readyQuests(profile, actor, world);
  const growth = learnedGrowth(
    profile,
    world.content.catalog.ui.skills,
    world.now,
    { hp: 0, mp: 0 },
  );
  const levels = awardExperience(profile, amount, {
    growth,
    items: world.content.items,
    random: world.random,
  });
  progressKills(profile, actor, world, mob.templateId);
  const context = { now: world.now, operationId: operation.operationId };
  applyOnlineFamilyProgress(
    drafts,
    actor.id,
    { kind: mob.template.info.boss ? "boss" : "kill", maxHp: mob.maxHP },
    context,
  );
  for (let index = 0; index < levels; index++) {
    applyOnlineFamilyProgress(
      drafts,
      actor.id,
      { kind: "level", maxHp: 0 },
      context,
    );
  }
  const newlyReady = [...readyQuests(profile, actor, world)].filter(
    (id) => !beforeReady.has(id),
  );
  return { actorId: actor.id, amount, levels, newlyReady };
}

function publishKillReward(world, actor, reward, field) {
  if (!actor || actor.field !== field) return;
  world.publish(actor, {
    type: "event",
    fieldEpoch: field.epoch,
    event: {
      kind: "combat.reward",
      actorId: actor.id,
      amount: reward.amount,
      levels: reward.levels,
    },
  });
  broadcastLevelUp(world, actor, reward.levels);
  for (const questId of reward.newlyReady) {
    world.publish(actor, {
      type: "event",
      fieldEpoch: field.epoch,
      event: { kind: "quest.ready", questId, questRevision: actor.revision },
    });
  }
}

function progressKills(profile, actor, world, templateId) {
  const viewActor = { ...actor, profile };
  for (const quest of progressQuestViews(viewActor, world)) {
    if (quest.state !== "active") continue;
    for (const objective of quest.objectives) {
      if (objective.kind !== "kill" || objective.templateId !== templateId) {
        continue;
      }
      profile.quests[quest.id].kills[templateId] = Math.min(
        objective.required,
        objective.current + 1,
      );
    }
  }
}

function readyQuests(profile, actor, world) {
  const result = new Set();
  for (const quest of progressQuestViews({ ...actor, profile }, world)) {
    if (quest.ready) result.add(quest.id);
  }
  return result;
}
