import {
  apField,
  admitAp,
  apGain,
  catalogJobs,
} from "../../client/src/character/ap-rules.js";
import { recalculateVitals } from "../../client/src/character/character-stats.js";
import {
  allocationError,
  allocateSkill,
  profileSkillLevel,
} from "../../client/src/skills/skill-allocation-rules.js";
import {
  consumeItem,
  inventoryType,
} from "../../client/src/items/inventory-model.js";
import { setSimulationSeat } from "../../client/src/physics/simulation.js";
import {
  prepareItemSpec,
  applyAlchemist,
  applyItemVitals,
  inspectItemSpec,
} from "../../client/src/items/item-effects.js";
import { USE_INTERVAL_MS } from "../../client/src/items/item-use.js";
import {
  TemporaryStats,
  temporaryState,
  configureTemporaryState,
  MAX_TEMPORARY_STATS,
  TEMPORARY_STATS,
} from "../../client/src/skills/temporary-stats.js";
import {
  admitActor,
  onlineState,
  ownedItem,
  reject,
  ruleError,
  createServerRandom,
} from "./action-rules.js";

import { executeNativePreference } from "./action-native.js";
import {
  hydrateSkillClocks,
  syncSkillDiseases,
} from "./skill-durable-state.js";
// Online command engineering bound; each point still uses the shared reference-policy rule.
export const MAX_ALLOCATION_BATCH = 256;

function allocateStats(profile, action, context) {
  if (
    action.amount > MAX_ALLOCATION_BATCH ||
    action.amount > profile.remainingAp
  ) {
    reject(
      "REQUIREMENTS_NOT_MET",
      "AP allocation exceeds the bounded batch or available points.",
    );
  }
  const catalog = context.world.content.catalog;
  const jobs = catalogJobs(catalog);
  const growth = { random: context.random, now: context.now };
  for (let point = 0; point < action.amount; point++) {
    // The explicit protocol HP/MP intent replaces only the offline UI warning, not its admissions.
    admitAp(profile, action.stat, true, jobs);
    profile[apField(action.stat)] += apGain(
      profile,
      action.stat,
      catalog,
      growth,
    );
    profile.remainingAp--;
  }
  recalculateVitals(
    profile,
    context.world.content.items,
    context.actor.temporaryStats?.derived,
  );
}

function allocateSkills(profile, action, context) {
  if (profile.hp <= 0 || action.amount > MAX_ALLOCATION_BATCH) {
    reject(
      "REQUIREMENTS_NOT_MET",
      "Skill allocation requires a living character and bounded batch.",
    );
  }
  const skill = context.world.content.catalog.ui.skills[action.skillId];
  for (let point = 0; point < action.amount; point++) {
    const reason = allocationError(profile, skill, context.now);
    if (reason) reject("REQUIREMENTS_NOT_MET", reason);
    allocateSkill(profile, skill);
  }
}

function cancelBuff(profile, action, context) {
  const effects = onlineState(profile).effects;
  const index = effects.findIndex((effect) => effect.id === action.effectId);
  const effect = effects[index];
  if (!effect || effect.expiresAt <= context.now) {
    reject("NOT_FOUND", "The owned effect is no longer active.");
  }
  if (!effect.cancelable || !["item", "skill"].includes(effect.kind)) {
    reject(
      "NOT_ALLOWED",
      "Hostile or noncancelable effects cannot be cleared.",
    );
  }
  effects.splice(index, 1);
  const temporary = new TemporaryStats();
  projectEffects(profile, context.now, temporary);
  recalculateVitals(profile, context.world.content.items, temporary.derived);
}

export async function executeCharacter(actor, message, world, operation) {
  const context = {
    actor,
    world,
    now: world.now,
    random: createServerRandom(),
  };
  return world.participants.commit(
    actor,
    operation,
    [actor.id],
    async (drafts) => {
      const profile = drafts.get(actor.id);
      try {
        admitActor(actor, world, message.fieldEpoch);
        context.now = world.now;
        switch (message.action.kind) {
          case "stats.allocate":
            allocateStats(profile, message.action, context);
            break;
          case "skills.allocate":
            allocateSkills(profile, message.action, context);
            break;
          case "buff.cancel":
            cancelBuff(profile, message.action, context);
            break;
          case "settings.save":
          case "key-bindings.save":
          case "skill-macros.save":
          case "quest.track":
          case "quest.notice":
            await executeNativePreference(profile, message.action, context);
            break;
          default:
            reject("INVALID_MESSAGE", "Not a character mutation.");
        }
        return {};
      } catch (error) {
        throw ruleError(error);
      }
    },
  );
}

function alchemist(profile, context) {
  const skills = context.world.content.catalog.ui.skills;
  return {
    level(id) {
      return profileSkillLevel(skills, profile, id, context.now);
    },
    info(id, rank) {
      return skills[id]?.levels?.[rank];
    },
  };
}

/** Validated item effect publication is represented durably before its live stat projection. */
function isChairItem(template, itemId) {
  return (
    inventoryType(itemId) === 3 &&
    Math.floor(itemId / 10000) === 301 &&
    template?.id === itemId
  );
}

function useChairItem(item, context) {
  const sim = context.actor.simulation;
  if (sim.seat) {
    setSimulationSeat(sim, null);
    return { value: { kind: "chair.toggle", templateId: item.id } };
  }
  if (
    context.actor.profile.hp <= 0 ||
    context.actor.attackState?.active ||
    (context.actor.skillField?.phase &&
      context.actor.skillField.phase !== "idle") ||
    context.world.now < (context.actor.castUntil ?? 0) ||
    context.actor.alertUntil > context.world.now ||
    sim.state !== "ground" ||
    sim.vx !== 0 ||
    sim.vy !== 0
  ) {
    reject("REQUIREMENTS_NOT_MET", "Stand still on the ground before sitting.");
  }
  setSimulationSeat(sim, {
    id: item.id,
    x: Math.trunc(sim.x),
    y: Math.trunc(sim.y),
  });
  return { value: { kind: "chair.toggle", templateId: item.id } };
}

export function useItem(profile, action, context) {
  const item = ownedItem(profile, context.actor, action.itemId, context.now);
  const otherTarget =
    action.target &&
    (action.target.kind !== "entity" ||
      action.target.entityId !== context.actor.id);
  if (item.slot < 0 || item.count < 1 || otherTarget) {
    reject(
      "NOT_ALLOWED",
      "The admitted consumable is an owned inventory self-use item.",
    );
  }
  const template = context.items[item.id];
  if (isChairItem(template, item.id)) return useChairItem(item, context);
  const state = onlineState(profile);
  if ((state.cooldowns["item.use"] ?? 0) > context.now) {
    reject("COOLDOWN", "Item-use admission interval is active.");
  }
  const effect = prepareItemSpec(template);
  if (!effect) {
    reject(
      "REQUIREMENTS_NOT_MET",
      "This item requires an unavailable conditional, targeted, pickup or special effect controller.",
    );
  }
  applyAlchemist(effect, alchemist(profile, context));
  if (effect.state) installItemEffect(state, item.id, effect, context.now);
  consumeItem(profile, item.uid, 1);
  applyItemVitals(profile, effect.values);
  state.cooldowns["item.use"] = context.now + USE_INTERVAL_MS;
  return {};
}

export function installItemEffect(state, templateId, effect, now) {
  const index = state.effects.findIndex(
    (entry) => entry.kind === "item" && entry.templateId === templateId,
  );
  if (index < 0 && state.effects.length >= MAX_TEMPORARY_STATS) {
    reject("SERVER_BUSY", "Temporary stat capacity is full.");
  }
  const row = {
    id: crypto.randomUUID(),
    templateId,
    kind: "item",
    cancelable: true,
    expiresAt: now + effect.values.time,
    duration: effect.values.time,
    spec: { ...effect.values },
  };
  if (index >= 0) state.effects.splice(index, 1);
  state.effects.push(row);
  return row;
}

/** Rebuild only at join/commit boundaries. Runtime ticks reuse the prepared source arrays. */
export function rebuildActorEffects(actor, world) {
  if (actor.skills) {
    hydrateRuntimeEffects(actor, world);
    return;
  }
  actor.temporaryStats ??= new TemporaryStats();
  projectEffects(actor.profile, world.now, actor.temporaryStats);
  recalculateVitals(
    actor.profile,
    world.content.items,
    actor.temporaryStats.derived,
  );
}

function projectEffects(profile, now, temporary) {
  const effects = onlineState(profile).effects;
  if (effects.length > MAX_TEMPORARY_STATS) {
    reject("CONTENT_MISMATCH", "Persisted temporary stat capacity is invalid.");
  }
  temporary.clear();
  for (const effect of effects) {
    if (effect.expiresAt <= now) continue;
    const state = temporaryState(effect.kind, effect.templateId);
    configureTemporaryState(state, effect.spec, effect.expiresAt - now);
    state.expiresAt = effect.expiresAt;
    state.itemValues = effect.spec;
    temporary.start(state);
  }
}

function hydrateRuntimeEffects(actor, world) {
  const system = actor.skills,
    effects = system.effects;
  actor.temporaryStats = effects;
  if (effects.reservation) return;
  const rows = onlineState(actor.profile).effects;
  removeExpiredRuntimeEffects(system, rows, world.now);
  for (const row of rows) hydrateRuntimeSource(actor, world, row);
  hydrateSkillClocks(actor, world.now);
  system.refresh();
  system.recompute();
}

function removeExpiredRuntimeEffects(system, rows, now) {
  const effects = system.effects;
  for (let index = effects.count - 1; index >= 0; index--) {
    const source = effects.sources[index];
    if (
      rows.some(
        (row) =>
          row.kind === source.kind &&
          row.templateId === source.id &&
          row.expiresAt > now,
      )
    ) {
      continue;
    }
    effects.remove(source.source);
    if (source.kind === "skill") {
      system.controllerFor(system.catalog[source.id])?.cancel?.(source.id);
    }
  }
}

function hydrateRuntimeSource(actor, world, row) {
  const system = actor.skills,
    effects = system.effects;
  if (row.expiresAt <= world.now) return;
  const prior = effects.find(
    row.kind === "item" ? -row.templateId : row.templateId,
  );
  if (prior && prior.wireId === row.id) return;
  const source =
    row.kind === "item"
      ? inspectItemSpec(world.content.items[row.templateId]).state
      : system.states.get(row.templateId);
  if (!source) {
    reject("CONTENT_MISMATCH", "Missing learned temporary source.");
  }
  configureTemporaryState(source, row.spec, row.expiresAt - world.now);
  source.totalMs = row.duration;
  source.rank = row.rank ?? system.level(row.templateId);
  source.wireId = row.id;
  source.expiresAt =
    row.kind === "item"
      ? row.expiresAt
      : (actor.profile.skills[row.templateId]?.expiresAt ?? null);
  source.itemValues = row.kind === "item" ? row.spec : null;
  effects.start(source);
  source.remaining = hydratedRemaining(actor, row, world.now);
}

/** Held skill-clock time is debited from every source on release; a hydrated row already counts it. */
function hydratedRemaining(actor, row, now) {
  return row.expiresAt - now + (actor.skillClockHeldMs ?? 0);
}

/** Serialize active source changes, preserving the native controller/source identity. */
export function syncActorEffects(actor, world) {
  const effects = actor.skills.effects;
  if (effects.reservation) return;
  const rows = onlineState(actor.profile).effects;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!effects.find(row.kind === "item" ? -row.templateId : row.templateId)) {
      rows.splice(index, 1);
    }
  }
  for (let index = 0; index < effects.count; index++) {
    syncRuntimeSource(actor, world, effects.sources[index], rows);
  }
  syncRuntimeCooldowns(actor, world);
  syncSkillDiseases(actor, world.now);
}

function syncRuntimeSource(actor, world, source, rows) {
  let row = null;
  for (const entry of rows) {
    if (entry.kind === source.kind && entry.templateId === source.id) {
      row = entry;
      break;
    }
  }
  if (!row) {
    row = {
      id: crypto.randomUUID(),
      kind: source.kind,
      templateId: source.id,
      cancelable: true,
      expiresAt: 0,
      duration: source.totalMs,
      rank: source.rank,
      spec: source.kind === "item" ? { ...source.itemValues } : {},
    };
    rows.push(row);
  }
  source.wireId = row.id;
  row.expiresAt = world.now + source.remaining;
  row.duration = source.totalMs;
  row.rank = source.rank;
  row.cancelable = actor.skills.canCancelEffect(source.kind, source.id);
  if (source.kind !== "item") syncRuntimeSourceStats(source, row);
}

function syncRuntimeSourceStats(source, row) {
  for (let stat = 0; stat < TEMPORARY_STATS.length; stat++) {
    const value = source.values[stat];
    if (value) row.spec[TEMPORARY_STATS[stat]] = value;
    else delete row.spec[TEMPORARY_STATS[stat]];
  }
}

function syncRuntimeCooldowns(actor, world) {
  const cooldowns = onlineState(actor.profile).cooldowns;
  for (const key in cooldowns) {
    if (!key.startsWith("skill:")) continue;
    const state = actor.skills.states.get(Number(key.slice(6)));
    if (state?.cooldown > 0) cooldowns[key] = world.now + state.cooldown;
    else delete cooldowns[key];
  }
}

/** Bounded, allocation-free expiration; world owns checkpoint/revision publication of the change. */
export function expireActorEffects(actor, world) {
  if (actor.skills) return false; // The shared skill clock expires sources, including final recovery ticks.
  const effects = actor.profile.onlineState?.effects;
  if (!effects) return false;
  let changed = false;
  for (let index = effects.length - 1; index >= 0; index--) {
    const effect = effects[index];
    if (effect.expiresAt > world.now) continue;
    actor.temporaryStats?.remove(
      effect.kind === "item" ? -effect.templateId : effect.templateId,
    );
    effects.splice(index, 1);
    changed = true;
  }
  if (changed) {
    actor.temporaryStats?.recompute();
    recalculateVitals(
      actor.profile,
      world.content.items,
      actor.temporaryStats?.derived,
    );
  }
  return changed;
}
