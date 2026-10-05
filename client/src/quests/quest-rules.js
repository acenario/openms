import { awardExperience } from "../character/offline-progression.js";
import { PROFILE_LIMITS } from "../profile/profile-validation.js";
import {
  itemCount,
  isEquipped,
  consumeTemplate,
  grantItem,
} from "../items/inventory-model.js";

const PROGRESS_FIELDS = [
  "level",
  "exp",
  "hp",
  "maxHP",
  "mp",
  "maxMP",
  "str",
  "dex",
  "int",
  "luk",
  "meso",
  "fame",
];

function fail(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

function stateOf(profile, id) {
  return profile.quests[id]?.state ?? 0;
}

function quantity(profile, id) {
  return itemCount(profile, id) + (isEquipped(profile, id) ? 1 : 0);
}

/** Original 00721d2c: positive minimum, negative maximum (-count), zero absence. */
function meetsQuantity(actual, required) {
  if (required > 0) return actual >= required;
  if (required < 0) return actual <= -required;
  return actual === 0;
}

function matchesNpc(check, npcId) {
  return !check.npc || check.npc === npcId;
}

/** Missing completion NPC inherits the start endpoint (Quest.wz 1008); explicit end NPC wins. */
export function questEndpointNpc(record, partition) {
  const stage = record.stages[Math.min(partition, 1)];
  const initial = record.stages[0];
  return (
    stage.check.npc ||
    stage.actionCheck.npc ||
    initial.check.npc ||
    initial.actionCheck.npc ||
    0
  );
}

function isNpcEndpoint(stage, npcId, initial = stage) {
  if (!stage.check.npc && !stage.actionCheck.npc) stage = initial;
  return Boolean(
    (stage.check.npc || stage.actionCheck.npc) &&
    matchesNpc(stage.check, npcId) &&
    matchesNpc(stage.actionCheck, npcId),
  );
}

/** Scalar admission runs before stock and progress gates to retain original failure precedence. */
function checkCharacterConditions(check, profile, npcId) {
  if (!matchesNpc(check, npcId)) {
    return fail("npc", `Requires NPC ${check.npc}`);
  }
  if (check.lvmin && profile.level < check.lvmin) {
    return fail("level", `Requires level ${check.lvmin} or higher`);
  }
  if (check.lvmax && profile.level > check.lvmax) {
    return fail("level", `Requires level ${check.lvmax} or lower`);
  }
  if (check.jobs.length && !check.jobs.includes(profile.job)) {
    return fail(
      "job",
      `Job ${profile.job} is not in the original allowed job list`,
      {
        allowedJobs: check.jobs,
      },
    );
  }
  if (check.pop && profile.fame < check.pop) {
    return fail("fame", `Requires fame ${check.pop}`);
  }
  return { ok: true };
}

/** Common local projections of Check/Act gates; unknown fields never reach admission. */
function checkConditions(check, profile, context) {
  const character = checkCharacterConditions(check, profile, context.npcId);
  if (!character.ok) return character;
  if (check.endmeso && profile.meso < check.endmeso) {
    return fail("meso", `Requires ${check.endmeso} mesos`);
  }
  const stock = checkItemConditions(check.items, profile);
  if (!stock.ok) return stock;
  return checkProgressConditions(check, profile, context.questId);
}

function checkItemConditions(items, profile) {
  for (const item of items) {
    const actual = quantity(profile, item.id);
    if (!meetsQuantity(actual, item.count)) {
      return fail(
        "item",
        `Item ${item.id}: ${actual}; original condition ${item.count}`,
      );
    }
  }
  return { ok: true };
}

function checkProgressConditions(check, profile, questId) {
  for (const quest of check.quests) {
    if (!questRequirementMet(profile, quest)) {
      return fail("quest", `Quest ${quest.id} must have state ${quest.state}`);
    }
  }
  for (const mob of check.mobs) {
    const actual = profile.quests[questId]?.kills[mob.id] ?? 0;
    if (actual < mob.count) {
      return fail("mob", `Monster ${mob.id}: ${actual}/${mob.count}`);
    }
  }
  return { ok: true };
}

function questRequirementMet(profile, quest) {
  if (stateOf(profile, quest.id) === quest.state) return true;
  // Server-owned completion history remains valid while a repeatable quest is active again.
  return (
    quest.state === 2 &&
    profile.onlineState?.questLifecycle?.[quest.id]?.completedAt !== null &&
    Number.isSafeInteger(
      profile.onlineState?.questLifecycle?.[quest.id]?.completedAt,
    )
  );
}

/** Original reward job mask 00716926; gender-specific rewards need absent profile gender. */
function eligibleItem(item, profile) {
  if (item.job === undefined || item.job === -1) return true;
  const family = Math.trunc(profile.job / 100);
  return family === 9 || (item.job & (1 << (family & 31))) !== 0;
}

/** Cosmic ItemAction96..125: one cumulative-weight choice among eligible original rows.
 * This server-reference policy consumes the injected gameplay stream only inside commit. */
function weightedReward(act, profile, random) {
  const total = rewardWeightTotal(act, profile);
  if (!total) return null;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("Quest random source outside [0,1)");
  }
  let choice = Math.floor(sample * total);
  for (const item of act.items) {
    if (!eligibleItem(item, profile) || !(item.prop > 0)) continue;
    if (choice < item.prop) return item;
    choice -= item.prop;
  }
  throw new Error("Quest reward selection exceeded its cumulative weights");
}

/** Validate the eligible pool before consuming its single transaction-owned draw. */
function rewardWeightTotal(act, profile) {
  let total = 0;
  for (const item of act.items) {
    if (!eligibleItem(item, profile) || item.prop === undefined) continue;
    if (!Number.isSafeInteger(item.prop) || item.prop < -1) {
      throw new Error("Invalid original quest reward weight");
    }
    if (item.prop > 0) total += item.prop;
  }
  if (total > 0x7fffffff) {
    throw new Error("Quest reward weight exceeds server integer range");
  }
  return total;
}

function rewardItems(act, profile, selected, random = null) {
  const result = [],
    choices = [];
  for (const item of act.items) {
    if (!eligibleItem(item, profile)) continue;
    if (item.prop === -1) choices.push(item);
    else if (item.prop === undefined) result.push(item);
  }
  if (choices.length) {
    const chosen = choices.find((item) => item.index === selected);
    if (!chosen) {
      return fail("reward-choice", "Select an original item reward", {
        choices,
      });
    }
    result.push(chosen);
  }
  if (random) {
    const weighted = weightedReward(act, profile, random);
    if (weighted) result.push(weighted);
  }
  return { ok: true, items: result, choices };
}

/** Validate every debit against pre-transaction stock, not a reward's net positive offset. */
function checkItemDebits(counts, items) {
  const debits = new Map();
  for (const item of items) {
    if (item.count < 0) {
      debits.set(item.id, (debits.get(item.id) ?? 0) - item.count);
    }
  }
  for (const [id, debit] of debits) {
    if ((counts.get(id) ?? 0) < debit) {
      return fail(
        "item",
        `Cannot consume ${debit} of item ${id}; equipped items are not removed automatically`,
      );
    }
  }
  return { ok: true };
}

function transactItems(draft, items, templates) {
  const counts = new Map();
  for (const item of draft.inventory) {
    counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
  }
  const debits = checkItemDebits(counts, items);
  if (!debits.ok) return debits;
  for (const item of items) {
    if (item.count < 0) consumeTemplate(draft, item.id, -item.count);
  }
  for (const item of items) {
    if (item.count > 0) grantItem(draft, templates?.[item.id], item.count);
  }
  return { ok: true };
}

function transactQuestStates(draft, actions, completingId, now) {
  for (const change of actions) {
    const previous = stateOf(draft, change.id);
    if (change.id === completingId || change.state < previous) {
      return fail(
        "quest-action",
        `Quest ${change.id} action would reset or contradict a one-shot quest`,
      );
    }
    if (previous === change.state) continue;
    draft.quests[change.id] = {
      state: change.state,
      kills: { ...(draft.quests[change.id]?.kills ?? {}) },
    };
    if (change.state === 2) draft.quests[change.id].completedAt = now;
  }
  if (Object.keys(draft.quests).length > PROFILE_LIMITS.quests) {
    return fail("quest-capacity", "Local quest record capacity reached");
  }
  return { ok: true };
}

function transaction(
  profile,
  record,
  stage,
  { selected, growth, items, random, now = Date.now() },
) {
  const act = record.stages[stage].act;
  const rewards = rewardItems(act, profile, selected, random);
  if (!rewards.ok) return rewards;
  const draft = profile;
  const inventory = transactItems(draft, rewards.items, items);
  if (!inventory.ok) return inventory;
  draft.meso += act.money;
  draft.fame += act.pop;
  if (
    !Number.isSafeInteger(draft.meso) ||
    draft.meso < 0 ||
    !Number.isSafeInteger(draft.fame)
  ) {
    return fail("economy", "Reward or debit exceeds local economy bounds");
  }
  const states = transactQuestStates(draft, act.quests, record.id, now);
  if (!states.ok) return states;
  const levels = awardExperience(draft, act.exp, {
    growth,
    items,
    random,
  });
  const kills =
    stage === 0 ? Object.create(null) : { ...profile.quests[record.id].kills };
  draft.quests[record.id] = { state: stage + 1, kills };
  if (stage === 1) draft.quests[record.id].completedAt = now;
  for (const key of PROGRESS_FIELDS) {
    if (!Number.isSafeInteger(draft[key])) {
      return fail("profile", `Reward exceeds safe ${key} bounds`);
    }
  }
  return {
    ok: true,
    draft,
    levels,
    rewards: {
      exp: act.exp,
      money: act.money,
      pop: act.pop,
      items: rewards.items,
    },
    nextQuest: act.nextQuest,
  };
}

export {
  fail,
  stateOf,
  isNpcEndpoint,
  checkConditions,
  rewardItems,
  transaction,
};
