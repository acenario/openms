import { worldFamily } from "../../client/src/skills/skill-world-rules.js";
import { resetMovementStream } from "./movement-stream.js";
import { SkillSystem } from "../../client/src/skills/skill-system.js";
import { SkillCosts } from "../../client/src/skills/skill-costs.js";
import { awaitSkillInput } from "./skill-input-order.js";
import { AvatarVisuals } from "../../client/src/character/avatar-visuals.js";
import { AuthorityCombat } from "./combat-controller.js";
import { AuthoritySkillResources, authorityLayer } from "./skill-resources.js";
import { createCombatHooks, emitCombat, death } from "./skill-hooks.js";
import { combatOperation } from "./combat-rewards.js";
import {
  AuthoritySkillDrops,
  prepareSkillDrops,
  admitSkillDrops,
  commitSkillDrops,
  releaseSkillDrops,
  commitPickpocketDrops,
} from "./skill-drops.js";
import { rebuildActorEffects, syncActorEffects } from "./action-character.js";
import { admitActor, ruleError } from "./action-rules.js";
import { prepareActorCombat } from "./field-combat.js";
import { recordMotionDivert } from "./field-diverts.js";
import { protocolError } from "../../shared/schema.js";
import {
  preparePartyVisual,
  publishPartyVisuals,
} from "./party-skill-visuals.js";
import {
  retainsReceivedEffect,
  setSkillCooldown,
} from "./skill-durable-state.js";
import {
  partySkillKind,
  partySkillTargets,
  partySkillError,
  applyPartySkill,
} from "./party-skills.js";

/** Shared controllers can spend resources only in a paid server phase. */
class AuthorityCosts extends SkillCosts {
  constructor(system) {
    super(system);
    this.paid = null;
  }
  error(skill, info) {
    return this.paid?.skill === skill && this.paid.info === info
      ? null
      : super.error(skill, info);
  }
  consume(skill, info) {
    const paid = this.paid;
    if (!paid || paid.skill !== skill || paid.info !== info) {
      throw new Error("Skill phase lacks committed resource debit");
    }
    this.paid = null;
    this.projectilePAD = paid.costs.projectilePAD;
    this.projectileId = paid.costs.projectileId;
    this.mpRestore = paid.costs.mpRestore;
    this.mesoSpent = paid.costs.mesoSpent;
    return null;
  }
}

class AuthoritySkills extends SkillSystem {
  publishCast(skill, info, rank) {
    this.resources.feedbackId = this.feedbackOperations?.get(skill.id) ?? null;
    try {
      super.publishCast(skill, info, rank);
    } finally {
      this.resources.feedbackId = null;
      this.feedbackOperations?.delete(skill.id);
    }
    const actor = this.hooks.actor;
    const state = this.states.get(skill.id);
    actor.profile.onlineState.cooldowns[`skill:${skill.id}`] =
      this.hooks.now() + state.cooldown;
    syncActorEffects(actor, this.hooks.world);
    emitCombat(this.hooks.world, actor, {
      kind: "skill.cast",
      actorId: actor.id,
      skillId: skill.id,
      rank,
      actionId: actor.skillField.actionId ?? actor.id,
      position: { x: actor.simulation.x, y: actor.simulation.y },
    });
  }
}

function authorityStore(world, actor) {
  return {
    id: actor.id,
    draft: null,
    operationScope: null,
    listeners: new Set(),
    get profile() {
      return this.draft ?? actor.profile;
    },
    get profileTransactionPending() {
      return Boolean(!this.draft && actor.pending && !actor.skillExecuting);
    },
    markDirty() {
      actor.runtimeDirty = true;
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    rebind(next) {
      actor = next;
    },
    async commitProfile(mutator) {
      const scope = this.operationScope;
      if (scope?.used) throw protocolError("SERVER_BUSY");
      if (scope) scope.used = true;
      const operation =
        scope?.operation ?? combatOperation(actor, "skill.profile");
      let fresh = false,
        value;
      const receipt = await world.participants.commit(
        actor,
        operation,
        [actor.id],
        async (drafts) => {
          fresh = true;
          try {
            value = await mutator(drafts.get(actor.id));
          } catch (error) {
            throw ruleError(error);
          }
          return value;
        },
      );
      if (scope) scope.receipt = receipt;
      if (receipt.status !== "committed") {
        throw protocolError(receipt.code ?? "NOT_ALLOWED");
      }
      if (!fresh) throw protocolError("STALE_REVISION");
      return value;
    },
  };
}

/** Bind an original workflow to exactly one already-admitted wire operation. */
export async function runSkillOperation(world, actor, operation, run) {
  const store = actor.skills?.store;
  if (!store || store.operationScope) throw protocolError("SERVER_BUSY");
  const previous = actor.skillExecuting;
  const scope = { operation, used: false, receipt: null };
  store.operationScope = scope;
  actor.skillExecuting = true;
  try {
    const value = await run();
    return { receipt: scope.receipt, value };
  } finally {
    store.operationScope = null;
    actor.skillExecuting = previous;
  }
}

function skillActorBlocked(actor) {
  return (
    actor.state !== "active" ||
    Boolean(
      actor.retiring ||
      actor.deliveryError ||
      actor.tradeId ||
      actor.conversation,
    )
  );
}

function skillHooks(world, actor, scene) {
  return {
    actor,
    world,
    items: world.content.items,
    now: () => world.now,
    random: world.random,
    partySkillError: (skill, info) =>
      partySkillError(world, actor, skill, info),
    retainsReceivedEffect: (id, state) =>
      retainsReceivedEffect(actor, world.now, id, state),
    report: (error) => {
      actor.admission = error.code ?? error.message;
    },
    rebind(next) {
      actor = next;
    },
    targetState: (mob, state) =>
      actor.bound === false ? state : (mob.controllerState ??= state),
    controlsMob: (mob) =>
      actor.bound !== false && mob.controllerOwnerId === actor.id,
    gameplay: () => actor.skillField,
    drops: () => actor.skillDrops,
    isBlocked: () => skillActorBlocked(actor),
    isCurrent: () => actor.field === scene.field && !actor.session.revoked,
    validateCast: () => actor.skillField.skillCastError(),
    supportsAction: (action) =>
      scene.actor.actions.has(action) ||
      actor.skills.worldController.supportsAction(action),
    validateAttack: (entry, info) =>
      actor.skillField.skillAttackError(entry, info),
    admitAttack: (entry, info, hit) =>
      actor.skillField.beginSkillAttack(entry, info, hit),
    startAction: (action) => actor.skillField.beginSkillPose(action),
    // The client merges the same vector locally; recording it here names the skill.
    onExternalImpulse: (simulation, vx, vy, skillId) =>
      recordMotionDivert(actor, simulation, {
        vx,
        vy,
        source: "skill",
        skillId,
      }),
    travelDoor: (destination) => world.travelSkillDoor(actor, destination),
    prepareEnhancement: () => prepareEnhancement(world),
    enhancementError: () =>
      world.content.catalog.ui.bundles.EnchantSkill
        ? null
        : "Original enhancement surface is unavailable",
    openEnhancement: () =>
      emitCombat(
        world,
        actor,
        { kind: "skill.utility", actorId: actor.id, window: "EnchantSkill" },
        true,
      ),
    commitSkillPhase: (entry, info, publish) =>
      queueSkillPhase(world, actor, { skill: entry, info, publish }),
  };
}

async function prepareEnhancement(world) {
  const descriptor = world.content.catalog.ui.bundles.EnchantSkill;
  if (!descriptor) throw protocolError("CONTENT_MISMATCH");
  await world.content.json(descriptor);
}

/** Async preparation validates all learned controllers and authored resources before admission. */
export async function prepareActorSkills(
  world,
  actor,
  previous = actor.skills,
) {
  actor.skillPreparing = true;
  actor.skillExecuting = true;
  if (!previous && !actor.skillTravelCandidate) {
    actor.profile.onlineState.effects =
      actor.profile.onlineState.effects.filter(
        (row) =>
          row.kind === "item" ||
          world.content.catalog.ui.skills[row.templateId]?.classification
            .owner === "state",
      );
  }
  const preparation = prepareSkillRuntime(world, actor, previous);
  const { scene, resources, avatars } = preparation;
  try {
    const avatar = await avatars.prepare(actor.profile);
    scene.avatarOwner = { resource: avatar };
    scene.actor = resources.createAnimation(avatar.entity, avatar.textures);
    scene.actor.setPosition(actor.simulation.x, actor.simulation.y);
    scene.presentation = {
      x: actor.simulation.x,
      y: actor.simulation.y,
      facing: actor.simulation.facing,
      action: actor.simulation.action,
      playback: "loop",
    };
    installSkillRuntime(world, actor, previous, preparation);
    await actor.skills.prepare();
    if (previous && previous !== actor.skills) previous.destroy();
    actor.skillField.projectActor();
  } catch (error) {
    discardSkillPreparation(actor, preparation);
    throw error;
  } finally {
    actor.skillPreparing = false;
    actor.skillExecuting = false;
  }
}

function prepareSkillRuntime(world, actor, previous) {
  const store = previous?.store ?? authorityStore(world, actor);
  const layer = authorityLayer();
  const scene = {
    field: actor.field,
    manifest: actor.field.manifest,
    simulation: actor.simulation,
    overlays: layer,
    addWorldContainer(node, depth) {
      node.zIndex = depth;
      layer.addChild(node);
    },
    removeWorldContainer(node) {
      layer.removeChild(node);
    },
  };
  const hooks = skillHooks(world, actor, scene);
  const resources = new AuthoritySkillResources(world, actor, scene, hooks);
  hooks.resources = resources;
  hooks.createAnimation = resources.createAnimation.bind(resources);
  hooks.loadVisual = resources.loadVisual.bind(resources);
  const avatars = new AvatarVisuals(
    {
      loadVisual: (descriptor, services, signal) =>
        resources.loadVisual(descriptor, signal),
    },
    world.content.catalog,
  );
  return {
    store,
    scene,
    hooks,
    resources,
    avatars,
    priorField: actor.skillField,
    priorDrops: actor.skillDrops,
  };
}

function installSkillRuntime(world, actor, previous, { scene, store, hooks }) {
  actor.skills = new AuthoritySkills(
    scene,
    store,
    world.content.catalog,
    hooks,
  );
  actor.skills.costs = new AuthorityCosts(actor.skills);
  actor.skills.debitCosts = new SkillCosts(actor.skills);
  actor.skillDrops = new AuthoritySkillDrops(world, actor);
  actor.skillField = new AuthorityCombat(world, actor, {
    scene,
    store,
    hooks: createCombatHooks(world, actor),
  });
  actor.hitboxes = actor.skillField.hitboxes;
  actor.combat = actor.skillField.combat;
  actor.skillGeneration = (actor.skillGeneration ?? 0) + 1;
  if (previous && !previous.destroyed) actor.skills.inherit(previous);
  actor.temporaryStats = actor.skills.effects;
  rebuildActorEffects(actor, world);
  Object.assign(actor, profileResourceKeys(actor.profile));
}

function discardSkillPreparation(
  actor,
  { scene, resources, priorField, priorDrops },
) {
  if (actor.skills?.scene === scene) actor.skills.destroy();
  if (actor.skillField !== priorField) actor.skillField?.destroy();
  if (actor.skillDrops !== priorDrops) actor.skillDrops?.destroy();
  scene.actor?.container.destroy();
  scene.avatarOwner?.resource.destroy();
  resources.destroy();
}

function admitCast(world, actor, action) {
  admitActor(actor, world, actor.field.epoch);
  if (!actor.skills || actor.skillPreparing || actor.skillTask) {
    throw protocolError("SERVER_BUSY");
  }
  if (
    action.target &&
    (action.target.kind !== "entity" || action.target.entityId !== actor.id)
  ) {
    throw protocolError("NOT_ALLOWED");
  }
  const system = actor.skills;
  if (!system.level(action.skillId)) {
    throw protocolError("REQUIREMENTS_NOT_MET");
  }
  const id = system.activationId(action.skillId);
  const skill = system.catalog[id],
    rank = system.level(id),
    info = system.info(id, rank);
  const error = system.castError(skill, info);
  if (error) {
    actor.admission = error;
    throw protocolError(
      error.includes("cooldown") || error.includes("action is active")
        ? "COOLDOWN"
        : "REQUIREMENTS_NOT_MET",
    );
  }
  return { system, skill, info, rank, controller: system.controllerFor(skill) };
}

export async function castSkill(world, actor, action, operation) {
  actor.skillExecuting = true;
  let drops = null;
  let motionAdmitted = false;
  try {
    await awaitSkillInput(world, actor, action.skillId);
    const plan = admitCast(world, actor, action);
    if (plan.controller.basicFallback) {
      return await castBasicFallback(world, actor, plan, operation);
    }
    if (plan.skill.id === 4211006) {
      const targets = plan.system.combatController.targets;
      drops = prepareSkillDrops(
        actor,
        plan.skill,
        targets.selected,
        targets.count,
      );
    }
    const deferred = Boolean(plan.controller.deferredCost?.(plan.skill));
    let fresh = false;
    const receipt = deferred
      ? await world.participants.commit(actor, operation, [actor.id], () => {
          fresh = true;
          return {
            value: {
              kind: "skill.cast",
              skillId: plan.skill.id,
              rank: plan.rank,
              deferred: true,
              dropPlanId: null,
            },
          };
        })
      : await debitSkill(world, actor, {
          skill: plan.skill,
          info: plan.info,
          operation,
          drops,
        });
    if (
      receipt.status !== "committed" ||
      (deferred ? !fresh : !plan.system.costs.paid)
    ) {
      return receipt;
    }
    publishPaidCast(world, actor, plan, {
      operation,
      drops,
      receipt,
      deferred,
    });
    motionAdmitted = true;
    return receipt;
  } finally {
    finishCastMotion(actor, action.skillId, drops, motionAdmitted);
  }
}

function finishCastMotion(actor, skillId, drops, admitted) {
  if (!admitted && worldFamily(skillId) === "impulse") {
    resetMovementStream(actor);
  }
  if (drops) releaseSkillDrops(drops);
  actor.skillExecuting = false;
  actor.movementBarrier = null;
}

async function castBasicFallback(world, actor, plan, operation) {
  let fresh = false;
  const receipt = await world.participants.commit(
    actor,
    operation,
    [actor.id],
    () => {
      fresh = true;
      return {
        value: {
          kind: "skill.cast",
          skillId: plan.skill.id,
          rank: plan.rank,
          deferred: false,
          dropPlanId: null,
        },
      };
    },
  );
  if (receipt.status === "committed" && fresh) {
    plan.controller.castBasicFallback();
  }
  return receipt;
}

function publishPaidCast(
  world,
  actor,
  plan,
  { operation, drops, receipt, deferred },
) {
  admitActor(actor, world, operation.fieldEpoch);
  plan.system.feedbackOperations ??= new Map();
  plan.system.feedbackOperations.set(plan.skill.id, operation.operationId);
  if (drops) commitSkillDrops(actor, drops, receipt);
  if (!deferred) {
    plan.system.costs.consume(plan.skill, plan.info);
    if (plan.skill.classification.owner === "state") {
      plan.system.utilityController.events.consume(plan.skill);
    }
  }
  publishCastPresentation(actor, plan, operation.operationId);
  if (!deferred) plan.system.publishCast(plan.skill, plan.info, plan.rank);
  publishPartyVisuals(world, actor, plan, receipt.value.partyEffects);
  world.publish(actor, { type: "snapshot-request" });
}

function publishCastPresentation(actor, plan, operationId) {
  const resources = plan.system.resources;
  resources.feedbackId = operationId;
  try {
    const kind = partySkillKind(plan.skill, plan.info);
    if (kind === "dispel") actor.skillField.dispelSkill(plan.info, false);
    if (["resurrection", "time-leap", "dispel"].includes(kind)) {
      if (plan.skill.actions.length) {
        plan.system.hooks.startAction(plan.skill.actions[0]);
      }
    } else plan.controller.cast(plan.skill, plan.info, plan.rank);
  } finally {
    resources.feedbackId = null;
  }
}

async function debitSkill(
  world,
  actor,
  { skill, info, operation, drops = null },
) {
  const system = actor.skills;
  const targets = partySkillTargets(world, actor, skill, info);
  await preparePartyVisual(actor, skill, targets);
  let debit = null;
  const receipt = await world.participants.commit(
    actor,
    operation,
    [actor.id, ...targets.map((target) => target.id)],
    (drafts) => {
      admitActor(actor, world, operation.fieldEpoch);
      admitSkillDrops(actor, drops);
      system.store.draft = drafts.get(actor.id);
      try {
        const costs = system.debitCosts;
        const denied = costs.consume(skill, info);
        if (denied) {
          actor.admission = denied;
          throw protocolError("REQUIREMENTS_NOT_MET");
        }
        debit = { skill, info, costs };
        const partyEffects = applyPartySkill(
          world,
          actor,
          { skill, info, targets },
          drafts,
        );
        if (operation.kind !== "skill.phase") {
          setSkillCooldown(drafts.get(actor.id), skill.id, info, world.now);
        }
        return {
          value: {
            kind: "skill.cast",
            skillId: skill.id,
            rank: system.level(skill.id),
            deferred: false,
            debitId: operation.operationId,
            dropPlanId: drops?.id ?? null,
            partyEffects,
          },
          consumeEntitlements: drops?.consumeEntitlements ?? [],
        };
      } finally {
        system.store.draft = null;
      }
    },
  );
  if (
    receipt.status === "committed" &&
    receipt.value?.debitId === operation.operationId &&
    debit
  ) {
    system.costs.paid = debit;
  }
  return receipt;
}

function queueSkillPhase(world, actor, { skill, info, publish }) {
  if (!skill || actor.skillTask) return;
  const generation = actor.skillGeneration;
  const operation = combatOperation(actor, "skill.phase");
  actor.skillTask = debitSkill(world, actor, { skill, info, operation })
    .then((receipt) => {
      if (
        receipt.status !== "committed" ||
        !actor.skills.costs.paid ||
        actor.skillGeneration !== generation
      ) {
        return;
      }
      actor.skillExecuting = true;
      try {
        admitActor(actor, world, operation.fieldEpoch);
        publish();
      } finally {
        actor.skillExecuting = false;
      }
    })
    .catch((error) => {
      actor.admission = error.code ?? error.message;
      actor.skills.combatController.cancelHold();
      actor.skills.utilityController.interruptChakra();
    })
    .finally(() => {
      actor.skillTask = null;
    });
}

export function releaseSkill(world, actor, action) {
  if (!actor.skills) throw protocolError("CHARACTER_BUSY");
  if (
    actor.pending ||
    actor.skillTask ||
    actor.skillPreparing ||
    actor.skillField?.hasPendingIncoming
  ) {
    const pending = actor.skillRelease;
    if (
      !pending ||
      pending.kind !== "skill.cancel" ||
      (action.kind === "skill.cancel" && action.skillId === undefined)
    ) {
      actor.skillRelease = action;
    }
    return { code: "OK" };
  }
  if (action.kind === "skill.cancel") actor.skills.cancelHold(action.skillId);
  else actor.skills.release(action.skillId);
  return { code: "OK" };
}

/** Called once after physics, before actor combat. Shared controllers own their exact clocks. */
function skillClockBlocked(actor) {
  return (
    !actor.skills ||
    actor.state !== "active" ||
    actor.retiring ||
    actor.deliveryError ||
    actor.skillPreparing ||
    actor.pending ||
    actor.skillTask ||
    actor.skillField?.hasPendingIncoming
  );
}

/**
 * A held clock still owes its buff/cooldown time: published expiries are `world.now + remaining`,
 * so skipping held ticks would push them later and outlast the wall-clock duration.
 */
function holdSkillClock(actor, ms) {
  if (actor.skills) actor.skillClockHeldMs = (actor.skillClockHeldMs ?? 0) + ms;
}

export function advanceActorSkills(world, actor, ms = 30) {
  if (skillClockBlocked(actor)) return holdSkillClock(actor, ms);
  if (actor.skillRelease) {
    const release = actor.skillRelease;
    actor.skillRelease = null;
    releaseSkill(world, actor, release);
    if (actor.skillTask) return holdSkillClock(actor, ms);
  }
  actor.skills.utilityController.input(actor.input);
  const hp = actor.profile.hp;
  actor.skills.step(ms);
  const held = actor.skillClockHeldMs ?? 0;
  if (held > 0) {
    actor.skillClockHeldMs = 0;
    actor.skills.advanceTimers(held);
  }
  syncActorEffects(actor, world);
  if (hp > 0 && actor.profile.hp === 0 && !actor.skillField.dead) {
    death(world, actor);
  }
}

export async function flushPickpocket(world, actor) {
  if (actor.skillField.rewardJobs.size) return;
  const plan = actor.skillDrops.takePickpocketPlan();
  if (!plan) return;
  const operation = combatOperation(actor, "combat.pickpocket");
  try {
    const receipt = await world.participants.commitProduced(
      actor,
      operation,
      () => [actor.id],
      () => ({
        value: { kind: "combat.pickpocket", pickpocketPlanId: plan.id },
        grantEntitlements: plan.grantEntitlements,
      }),
    );
    commitPickpocketDrops(world, actor, plan, receipt);
  } finally {
    releaseSkillDrops(plan);
  }
}

export async function settleActorSkills(actor) {
  const failures = [];
  for (;;) {
    const jobs = acceptedSkillJobs(actor);
    if (jobs.size) {
      for (const result of await Promise.allSettled(jobs)) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      continue;
    }
    if (actor.skillDrops?.pickpocketPlan) {
      try {
        await flushPickpocket(actor.skills.hooks.world, actor);
      } catch (error) {
        failures.push(error);
      }
      continue;
    }
    break;
  }
  if (actor.skillField?.incomingFailure) {
    failures.push(actor.skillField.incomingFailure);
  }
  if (failures.length) {
    throw new AggregateError(failures, "Accepted skill outcomes failed");
  }
}

function acceptedSkillJobs(actor) {
  const jobs = new Set(actor.skillField?.rewardJobs ?? []);
  if (actor.skillTask) jobs.add(actor.skillTask);
  if (actor.questTask) jobs.add(actor.questTask);
  if (actor.skillField?.incomingTask) jobs.add(actor.skillField.incomingTask);
  return jobs;
}

export function disposeActorSkills(actor, logout = false) {
  actor.skillGeneration++;
  actor.skillRelease = null;
  actor.skills?.combatController.onDeath();
  actor.skills?.utilityController.interruptChakra();
  if (!logout) return;
  actor.skills?.onDeath();
  actor.skills?.destroy();
  actor.skillField?.destroy();
  actor.skillField?.scene.avatarOwner.resource.destroy();
  actor.skillDrops?.destroy();
  actor.skills = null;
  // Runtime teardown is not death: durable timers continue while the account is offline.
}

/** Destination runtime is fully prepared against a detached server draft before travel commits. */
export async function prepareSkillTravel(world, actor, destination) {
  await settleActorSkills(actor);
  return await prepareRuntimeCandidate(world, actor, destination);
}

async function prepareRuntimeCandidate(world, actor, destination) {
  const candidate = {
    ...actor,
    field: destination.field,
    simulation: destination.simulation,
    profile: structuredClone(destination.profile ?? actor.profile),
    skills: null,
    skillField: null,
    skillDrops: null,
    skillTask: null,
    skillPreparing: false,
    skillExecuting: false,
    pending: false,
    bound: false,
    skillTravelCandidate: true,
    world,
  };
  prepareActorCombat(world, candidate);
  await prepareActorSkills(world, candidate, null);
  return candidate;
}

/** No asset loading or persistent mutation occurs here; the durable profile is already installed. */
export function bindSkillTravel(actor, candidate) {
  const previous = actor.skills;
  const priorField = actor.skillField;
  const priorDrops = actor.skillDrops;
  const skills = candidate.skills;
  if (previous) {
    skills.unsubscribe();
    skills.store = previous.store;
    skills.unsubscribe = skills.store.subscribe(skills.onChange);
  }
  for (const key of [
    "skills",
    "skillField",
    "skillDrops",
    "hitboxes",
    "combat",
    "attackState",
    "combatPresentation",
    "skillAvatarKey",
    "skillLearnedKey",
  ]) {
    actor[key] = candidate[key];
  }
  skills.store.rebind(actor);
  skills.hooks.rebind(actor);
  skills.hooks.actor = actor;
  skills.resources.actor = actor;
  actor.skillField.actor = actor;
  actor.skillField.store = skills.store;
  // The candidate store reads the detached travel draft; recovery must mutate the live one.
  actor.skillField.recovery.store = skills.store;
  actor.skillField.hooks.rebind(actor);
  for (const [id, state] of skills.combatController.targets.states) {
    const shared = (state.mob.controllerState ??= state);
    skills.combatController.targets.states.set(id, shared);
  }
  actor.skillDrops.actor = actor;
  actor.skillGeneration++;
  actor.skillRelease = null;
  actor.skillExecuting = true;
  if (previous) skills.inherit(previous);
  actor.temporaryStats = skills.effects;
  skills.refresh();
  actor.skillField.presentActor(0);
  skills.present(0);
  actor.skillField.projectActor();
  actor.skillExecuting = false;
  candidate.bound = true;
  previous?.scene.avatarOwner.resource.destroy();
  priorDrops?.destroy();
  previous?.destroy();
  priorField?.destroy();
}

export function releaseSkillTravel(candidate) {
  if (!candidate || candidate.bound) return;
  candidate.skills?.destroy();
  candidate.skillField?.destroy();
  if (!candidate.avatarTransferred) {
    candidate.skills?.scene.avatarOwner.resource.destroy();
  }
  candidate.skillDrops?.destroy();
}

function profileResourceKeys(profile) {
  return {
    skillAvatarKey: JSON.stringify([
      profile.gender,
      profile.appearance,
      profile.equipment
        .map((entry) => [entry.slot, entry.id])
        .sort((a, b) => a[0] - b[0]),
    ]),
    skillLearnedKey: JSON.stringify([profile.job, profile.skills]),
  };
}

/** Called inside the participant mutator, after the draft change and before durable commitment. */
export async function prepareProfileSkills(world, actor, profile) {
  if (!actor.skills) return null;
  const keys = profileResourceKeys(profile);
  if (
    keys.skillAvatarKey === actor.skillAvatarKey &&
    keys.skillLearnedKey === actor.skillLearnedKey
  ) {
    return null;
  }
  return await prepareRuntimeCandidate(world, actor, {
    field: actor.field,
    simulation: { ...actor.simulation },
    profile,
  });
}

/** Preserve the original live combat/controllers; refresh their original metadata after profile publication. */
export async function synchronizeActorSkills(world, actor, prepared = null) {
  const system = actor.skills;
  if (!system || actor.skillPreparing) {
    releaseSkillTravel(prepared);
    return;
  }
  const keys = profileResourceKeys(actor.profile);
  const avatarChanged = keys.skillAvatarKey !== actor.skillAvatarKey;
  const learnedChanged = keys.skillLearnedKey !== actor.skillLearnedKey;
  const executing = actor.skillExecuting;
  actor.skillExecuting = true;
  let previous = null;
  try {
    if (avatarChanged) {
      previous = await replaceAuthorityAvatar(world, actor, prepared);
    }
    system.refresh();
    if (avatarChanged || learnedChanged) await system.prepare();
    rebuildActorEffects(actor, world);
    system.utilityController.pets.presentation.step(0);
    actor.skillField.presentActor(0);
    system.present(0);
    actor.skillField.projectActor();
    Object.assign(actor, keys);
  } finally {
    previous?.animation.container.destroy();
    previous?.resource.destroy();
    actor.skillExecuting = executing;
    releaseSkillTravel(prepared);
  }
}

async function replaceAuthorityAvatar(world, actor, prepared) {
  const system = actor.skills;
  const visuals = new AvatarVisuals(
    {
      loadVisual: (descriptor, services, signal) =>
        system.resources.loadVisual(descriptor, signal),
    },
    world.content.catalog,
  );
  const resource =
    prepared?.skills.scene.avatarOwner.resource ??
    (await visuals.prepare(actor.profile));
  const animation = system.resources.createAnimation(
    resource.entity,
    resource.textures,
  );
  let combat;
  try {
    combat = actor.skillField.prepareCombatReplacement(
      animation.avatar.combat,
      animation,
    );
  } catch (error) {
    animation.container.destroy();
    if (!prepared) resource.destroy();
    throw error;
  }
  const scene = system.scene;
  const previous = {
    animation: scene.actor,
    resource: scene.avatarOwner.resource,
  };
  animation.container.renderable = previous.animation.container.renderable;
  scene.actor = animation;
  scene.avatarOwner.resource = resource;
  actor.skillField.replaceCombat(animation.avatar.combat, combat);
  actor.combat = animation.avatar.combat;
  if (prepared) prepared.avatarTransferred = true;
  return previous;
}
