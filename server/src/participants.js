import { PROFILE_LIMITS } from "../../client/src/profile/profile-validation.js";
import { projectCharacterStats } from "../../client/src/character/character-stats.js";
import { refreshSocial } from "./social-presentation.js";
import { prepareStorage } from "./interaction-storage.js";
import { refreshPickupConditions } from "./drop-conditions.js";
import { autoRegisterQuests } from "./action-native.js";
import {
  prepareProfileSkills,
  releaseSkillTravel,
  synchronizeActorSkills,
} from "./field-skills.js";
import { ParticipantProducers } from "./participant-producers.js";
import { MAX_TRANSACTION_PARTICIPANTS } from "./online-limits.js";

const GROUPS = new Set(["party", "guild", "alliance", "family", "messenger"]);

function refuse(code) {
  throw Object.assign(new Error(code), { code });
}

function cohortIds(ids, first = null) {
  if (!Array.isArray(ids)) refuse("NOT_ALLOWED");
  const result = new Set(first ? [first] : []);
  for (const id of ids) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      refuse("NOT_ALLOWED");
    }
    result.add(id);
  }
  if (!result.size || result.size > MAX_TRANSACTION_PARTICIPANTS) {
    refuse("SERVER_BUSY");
  }
  return [...result];
}

function endpoints(profile, options, add) {
  for (const kind of options.groups) {
    for (const member of profile.social[kind]?.members ?? []) {
      add(typeof member === "string" ? member : member.id);
    }
  }
  if (options.invitations) {
    for (const invitation of profile.social.invitations) {
      add(invitation.fromId);
      add(invitation.toId);
    }
  }
}

/** Full profiles never leave this server-private coordinator. Public readers project explicitly. */
export class Participants {
  constructor(world) {
    this.world = world;
    this.database = world.database;
    this.publishedReceipts = new WeakSet();
    this.producers = new ParticipantProducers(this);
  }

  async resolve(nameOrId) {
    if (
      typeof nameOrId !== "string" ||
      !nameOrId.trim() ||
      nameOrId.length > 64
    ) {
      refuse("NOT_ALLOWED");
    }
    const key = nameOrId.trim();
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key)) {
      const actor =
        this.world.actors.get(key) ??
        (await this.database.loadParticipant(key));
      if (!actor) refuse("NOT_FOUND");
      return actor.id;
    }
    const matches = await this.database.searchParticipants({
      name: key,
      limit: 2,
    });
    if (!matches.length) refuse("NOT_FOUND");
    if (matches.length !== 1) refuse("NOT_ALLOWED");
    return matches[0].id;
  }

  async owner(id) {
    const live = this.world.actors.get(id);
    if (live) return live;
    const saved = await this.database.loadParticipant(id);
    if (!saved) refuse("NOT_FOUND");
    return this.world.actors.get(id) ?? saved;
  }

  async load(ids, { groups = [], invitations = false } = {}) {
    if (
      !Array.isArray(groups) ||
      groups.some((kind) => !GROUPS.has(kind)) ||
      typeof invitations !== "boolean"
    ) {
      refuse("NOT_ALLOWED");
    }
    const queue = cohortIds(ids);
    const included = new Set(queue);
    const result = new Map();
    const add = (id) => {
      if (included.has(id)) return;
      if (included.size >= PROFILE_LIMITS.characters) refuse("SERVER_BUSY");
      cohortIds([id]);
      included.add(id);
      queue.push(id);
    };
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      const owner = await this.owner(id);
      const profile = structuredClone(owner.profile);
      this.database.validate(profile);
      result.set(id, profile);
      endpoints(profile, { groups, invitations }, add);
    }
    return result;
  }

  reserve(actor, owners, operation, produced = false) {
    if (this.world.closed || this.world.actors.get(actor.id) !== actor) {
      refuse("STALE_CONNECTION");
    }
    for (const owner of owners) {
      if (owner.passive) continue;
      this.admitOwner(actor, owner, produced);
      this.admitReservation(actor, owner, operation, produced);
    }
    const held = [];
    for (const owner of owners) {
      if (owner.passive || owner.pending) continue;
      owner.pending = true;
      owner.pendingOperation = operation.operationId;
      owner.pendingOwner = actor.id;
      held.push(owner);
    }
    return held;
  }

  admitOwner(actor, owner, produced) {
    if (this.world.actors.get(owner.id) !== owner) refuse("STALE_CONNECTION");
    const settling = produced && owner.retiring && owner.settling;
    if (owner.retiring && !settling) {
      refuse(owner === actor ? "STALE_CONNECTION" : "SERVER_BUSY");
    }
    if (owner !== actor && owner.state !== "active" && !settling) {
      refuse("SERVER_BUSY");
    }
  }

  admitReservation(actor, owner, operation, produced) {
    if (!owner.pending && !produced && this.producedPending(owner.id)) {
      refuse("SERVER_BUSY");
    }
    if (
      owner.pending &&
      (owner.pendingOperation !== operation.operationId ||
        owner.pendingOwner !== actor.id)
    ) {
      refuse("SERVER_BUSY");
    }
  }

  /** Fresh commands cannot overtake accepted effects or another owned operation. */
  busy(actor) {
    return Boolean(
      actor.pending ||
      actor.skillTask ||
      actor.skillField?.hasPendingIncoming ||
      actor.skillField?.rewardJobs.size ||
      actor.skillDrops?.pickpocketPlan ||
      this.producedPending(actor.id),
    );
  }

  release(held) {
    for (const owner of held) {
      owner.pending = false;
      owner.pendingOperation = null;
      owner.pendingOwner = null;
    }
    if (held.length) this.signalIdle();
  }

  async context(actor, operation, keys) {
    const owners = await Promise.all(
      keys.map((id) => (id === actor.id ? actor : this.owner(id))),
    );
    return { actor, operation, keys, owners };
  }

  async commit(actor, operation, ids, mutator) {
    const context = await this.context(
      actor,
      operation,
      cohortIds(ids, actor.id),
    );
    const held = this.reserve(actor, context.owners, operation);
    return this.mutate(context, mutator, held);
  }

  async prepareProfiles(context, drafts, prepared) {
    for (let index = 0; index < context.owners.length; index += 1) {
      const owner = context.owners[index];
      if (owner.passive || context.operation.runtimePrepared === owner.id) {
        continue;
      }
      const candidate = await prepareProfileSkills(
        this.world,
        owner,
        drafts[index],
      );
      if (candidate) prepared.set(owner.id, candidate);
    }
  }

  async installProfiles(context, prepared) {
    for (const owner of context.owners) {
      if (owner.passive || context.operation.runtimePrepared === owner.id) {
        continue;
      }
      const candidate = prepared.get(owner.id);
      try {
        await synchronizeActorSkills(this.world, owner, candidate);
        prepared.delete(owner.id);
      } catch (error) {
        this.world.deliveryFailed(owner, error);
      }
    }
  }

  async mutate(context, mutator, held) {
    const prepared = new Map();
    try {
      const receipt = await this.database.commitMany(
        context.owners,
        context.operation,
        async (drafts, storage) => {
          const profiles = new Map(
            context.keys.map((id, index) => [id, drafts[index]]),
          );
          const result = (await mutator(profiles, storage)) ?? {};
          if (!result.code || result.code === "OK") {
            if (context.operation.kind !== "quest.track") {
              for (let index = 0; index < context.owners.length; index += 1) {
                await autoRegisterQuests(
                  drafts[index],
                  this.world,
                  context.owners[index].questTrackerExclusions,
                );
              }
            }
            await this.prepareProfiles(context, drafts, prepared);
          }
          return result;
        },
        {
          account: context.account,
          prepareOutsideTransaction: true,
          serverProduced: context.produced === true,
        },
      );
      if (receipt.status === "committed") {
        if (receipt.applied && context.produced) {
          // Commands waiting for their slot rebase over exactly these increments.
          for (const owner of context.owners) {
            owner.producedCommits = (owner.producedCommits ?? 0) + 1;
          }
        }
        if (receipt.applied) await this.installProfiles(context, prepared);
        const ids = context.account
          ? [...this.world.actors.values()]
              .filter((peer) => peer.accountId === context.actor.accountId)
              .map((peer) => peer.id)
          : context.keys;
        await this.deliver(ids);
        if (context.actor.state !== "transitioning") {
          this.publishedReceipts.add(receipt);
        }
      }
      return receipt;
    } finally {
      for (const candidate of prepared.values()) releaseSkillTravel(candidate);
      this.release(held);
    }
  }

  commitProduced(actor, operation, cohortResolver, mutator) {
    if (
      typeof cohortResolver !== "function" ||
      operation.domain !== "character"
    ) {
      refuse("NOT_ALLOWED");
    }
    const keys = cohortIds(cohortResolver(actor.profile), actor.id);
    return this.producers.enqueue(
      { actor, operation, cohortResolver, mutator },
      keys,
    );
  }

  async runProduced(entry) {
    for (;;) {
      const changed = this.producers.nextChange();
      const keys = cohortIds(
        entry.cohortResolver(entry.actor.profile),
        entry.actor.id,
      );
      this.producers.setKeys(entry, keys);
      const context = await this.context(
        entry.actor,
        { ...entry.operation },
        keys,
      );
      let held;
      try {
        held = this.reserve(
          entry.actor,
          context.owners,
          context.operation,
          true,
        );
      } catch (error) {
        if (error.code !== "SERVER_BUSY") throw error;
        await changed;
        continue;
      }
      context.operation.expectedRevision = entry.actor.revision;
      context.produced = true;
      return this.mutate(context, entry.mutator, held);
    }
  }

  producedPending(id) {
    return this.producers.has(id);
  }

  signalIdle() {
    this.producers.signal();
  }

  async waitIdle(actor) {
    while (actor.pending || actor.renewing) await this.producers.nextChange();
  }

  async search(query = {}) {
    const entries = await this.database.searchParticipants(query);
    return entries.map((entry) => ({
      ...entry,
      online: Boolean(this.world.actors.get(entry.id)?.connection?.data.ready),
    }));
  }

  storage(actor) {
    return this.database.loadStorage(actor);
  }

  async account(actor, operation, expectedStorageRevision, mutator) {
    if (
      !Number.isSafeInteger(expectedStorageRevision) ||
      expectedStorageRevision < 0
    ) {
      refuse("NOT_ALLOWED");
    }
    const context = await this.context(actor, operation, [actor.id]);
    context.account = { expectedRevision: expectedStorageRevision };
    const held = this.reserve(actor, context.owners, operation);
    return this.mutate(
      context,
      (profiles, storage) => mutator(profiles.get(actor.id), storage),
      held,
    );
  }
  async reconcile(actor, receipt, force = false) {
    if (
      receipt.status === "committed" &&
      (force || (receipt.transactionId && !this.publishedReceipts.has(receipt)))
    ) {
      await this.deliver([actor.id]);
      this.publishedReceipts.add(receipt);
    }
    return receipt;
  }

  /** A committed mutation cannot become a refusal because a recipient failed to render it. */
  async deliver(ids) {
    try {
      await this.publish(ids);
    } catch (error) {
      for (const id of ids) {
        const actor = this.world.actors.get(id);
        if (actor) this.world.deliveryFailed(actor, error);
      }
    }
  }

  async publish(ids) {
    const changed = [...new Set(ids)];
    if (changed.length > 128) refuse("SERVER_BUSY");
    const refreshed = await refreshSocial(this.world, changed);
    const recipients = new Set([...changed, ...refreshed]);
    for (const id of recipients) {
      const actor = this.world.actors.get(id);
      if (
        !actor ||
        actor.state !== "active" ||
        actor.retiring ||
        actor.deliveryError ||
        actor.session?.revoked ||
        actor.session?.expiresAt <= Date.now()
      ) {
        continue;
      }
      try {
        refreshPickupConditions(actor);
        projectCharacterStats(actor.profile, actor.statHooks, actor.stats);
        await prepareStorage(actor, this.world);
        this.world.publish(actor, { type: "snapshot-request" });
      } catch (error) {
        this.world.deliveryFailed(actor, error);
      }
    }
  }
}
