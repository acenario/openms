import { socialEqual } from "../../client/src/profile/social-equality.js";
import { CONTACT_ACTIONS } from "../../client/src/social/local-social-actions.js";
import { GROUP_ACTIONS } from "../../client/src/social/local-social-groups.js";
import { BOARD_ACTIONS } from "../../client/src/social/local-social-board.js";
import { FAMILY_ACTIONS } from "../../client/src/social/local-social-family.js";
import { INVITATION_ACTIONS } from "../../client/src/social/local-social-invitations.js";
import {
  SocialContext,
  socialRequire,
  admitContact,
  admitInvitationPreference,
} from "../../client/src/social/local-social-context.js";
import { partyForStarters } from "../../client/src/profile/profile-social.js";
import { validateSocialCommit } from "../../client/src/profile/profile-social-transaction.js";
import { admitActor, operationFor, ruleError } from "./action-rules.js";
import {
  requireInteraction,
  publishInteraction,
} from "./interaction-common.js";
import { familyTravelRequest, prepareSocialTravel } from "./social-family.js";

const ACTIONS = Object.freeze({
  ...CONTACT_ACTIONS,
  ...GROUP_ACTIONS,
  ...BOARD_ACTIONS,
  ...FAMILY_ACTIONS,
  ...INVITATION_ACTIONS,
});
const MAX_COHORT = 32;
const GROUPS = ["party", "guild", "alliance", "family", "messenger"];

function affectedGroups(kind, invitationKind) {
  const domain = kind.split(".")[0];
  const selected =
    domain === "invitation" ? invitationKind?.split("-")[0] : domain;
  if (
    selected === "guild" ||
    selected === "alliance" ||
    kind === "friend.block"
  ) {
    return ["party", "guild", "alliance"];
  }
  if (selected === "family") return ["family", "party"];
  return GROUPS.includes(selected)
    ? [selected]
    : selected === "search"
      ? ["party"]
      : [];
}

function foundingIds(world, actor) {
  const ids = [];
  requireInteraction(actor.field.characters.size <= 128, "SERVER_BUSY");
  for (const peer of actor.field.characters.values()) {
    const social = peer.profile.social;
    if (
      peer.id !== actor.id &&
      peer.state === "active" &&
      peer.profile.level >= 10 &&
      !social.party &&
      !social.guild &&
      !social.invitations.some(
        (entry) => entry.kind === "guild-create" && entry.toId === peer.id,
      )
    ) {
      ids.push(peer.id);
    }
  }
  requireInteraction(ids.length < MAX_COHORT, "SERVER_BUSY");
  return ids;
}

async function loadCohort(world, actor, request) {
  const ids = new Set([actor.id]);
  if (request.targetId) {
    request.targetId = await world.participants.resolve(request.targetId);
    ids.add(request.targetId);
  }
  const invitation = actor.profile.social.invitations.find(
    (entry) => entry.id === request.invitationId,
  );
  if (invitation) {
    ids.add(invitation.fromId);
    ids.add(invitation.toId);
  }
  if (request.kind === "guild.create") {
    for (const id of foundingIds(world, actor)) ids.add(id);
    return world.participants.load([...ids]);
  }
  const groups = affectedGroups(request.kind, invitation?.kind);
  const invitations =
    request.kind === "friend.group" ||
    request.kind === "friend.block" ||
    groups.length > 0 ||
    request.kind.startsWith("invitation.");
  return world.participants.load([...ids], { groups, invitations });
}

function sameLiveField(world, leftId, rightId) {
  const left = world.actors.get(leftId),
    right = world.actors.get(rightId);
  return Boolean(
    left?.state === "active" &&
    right?.state === "active" &&
    left.field === right.field &&
    left.session &&
    right.session &&
    !left.session.revoked &&
    !right.session.revoked &&
    left.session.expiresAt > Date.now() &&
    right.session.expiresAt > Date.now(),
  );
}

function invitationPhysicalIds(actorId, invitation, drafts) {
  const ids = new Set();
  if (
    ["family", "guild-create", "alliance-create"].includes(invitation?.kind)
  ) {
    ids.add(invitation.fromId);
  }
  if (invitation?.kind === "guild-create") {
    for (const member of drafts.get(invitation.fromId).social.guild?.members ??
      []) {
      ids.add(member.id);
    }
    ids.add(actorId);
  }
  return ids;
}

function physicalIds(actorId, request, drafts) {
  const self = drafts.get(actorId);
  if (request.kind === "invitation.accept") {
    const invitation = self.social.invitations.find(
      (entry) => entry.id === request.invitationId,
    );
    return invitationPhysicalIds(actorId, invitation, drafts);
  }
  if (request.kind === "guild.create") return new Set(drafts.keys());
  const ids = new Set();
  if (request.kind === "family.invite") ids.add(request.targetId);
  if (request.kind === "alliance.create") {
    for (const id of self.social.party?.members ?? []) {
      if (drafts.get(id)?.social.guild?.leaderId === id) ids.add(id);
    }
  }
  return ids;
}

function socialOptions(world, actor, request, travel) {
  return {
    now: Date.now(),
    travel,
    capabilities: {
      familyRates: world.familyRates === true,
      familyTravel: typeof world.travelParticipants === "function",
      emblems: world.content.catalog.ui.social?.emblems,
      partyForStarters: partyForStarters(world.content.catalog),
    },
    sameField: (left, right) => sameLiveField(world, left, right),
    admitPhysical(drafts) {
      const ids = physicalIds(actor.id, request, drafts);
      for (const id of ids) {
        socialRequire(
          sameLiveField(world, actor.id, id),
          "social-presence",
          "Both characters must be present together in the same live field.",
        );
        if (
          request.kind === "guild.create" ||
          (request.kind === "invitation.accept" &&
            drafts
              .get(actor.id)
              .social.invitations.some(
                (entry) =>
                  entry.id === request.invitationId &&
                  entry.kind === "guild-create",
              ))
        ) {
          socialRequire(
            drafts.get(id).level >= 10,
            "guild-requirements",
            "Guild cofounders must be level 10 or higher.",
          );
        }
      }
    },
  };
}

function createContext(profiles, actorId, request, options) {
  const context = new SocialContext(profiles, actorId, request, options.now);
  context.allowed = new Set(profiles.keys());
  context.capabilities = options.capabilities;
  context.travel = options.travel;
  context.sameField = options.sameField;
  return context;
}

function namedGroups(profiles) {
  const names = new Map();
  for (const profile of profiles.values()) {
    for (const kind of ["guild", "alliance"]) {
      const group = profile.social[kind];
      if (group) {
        names.set(`${kind}:${group.id}`, {
          kind,
          name: group.name.toLowerCase(),
          groupId: group.id,
        });
      }
    }
  }
  return names;
}

/** Database must consume this metadata in the same serializable mutation as the charter. */
export function socialNameChanges(before, after) {
  const oldNames = namedGroups(before),
    nextNames = namedGroups(after);
  return {
    reserve: [...nextNames]
      .filter(([key]) => !oldNames.has(key))
      .map(([, value]) => value),
    release: [...oldNames]
      .filter(([key]) => !nextNames.has(key))
      .map(([, value]) => value),
  };
}

function mutateSocial(drafts, actor, request, options) {
  options.travel?.validate(drafts);
  options.admitPhysical(drafts);
  const ids = [...drafts.keys()];
  const originals = new Map();
  for (const [id, profile] of drafts) {
    originals.set(id, structuredClone(profile));
  }
  const context = createContext(drafts, actor.id, request, options);
  if (request.kind === "messenger.send") {
    requireInteraction(
      (context.get().onlineState?.mutedUntil ?? 0) <= options.now,
      "NOT_ALLOWED",
    );
    for (const id of context.group("messenger").members) {
      if (id !== actor.id) admitContact(context, id);
    }
  }
  applySocialAction(context);
  validateSocialCommit(ids, [...originals.values()], [...drafts.values()]);
  return {
    value: { kind: "social.result", action: request.kind, ...context.result },
    socialNames: socialNameChanges(originals, drafts),
  };
}

/** Repeating Add Buddy while its mirrored request is pending reuses that request. */
function applySocialAction(context) {
  const request = context.payload;
  const previous =
    request.kind === "friend.invite"
      ? context
          .get()
          .social.invitations.find(
            (entry) =>
              entry.kind === "friend" &&
              entry.fromId === context.actorId &&
              entry.toId === request.targetId,
          )
      : null;
  if (!previous) return ACTIONS[request.kind](context);
  const target = admitContact(context, request.targetId);
  admitInvitationPreference(context, "friend", request.targetId);
  socialRequire(
    target.social.invitations.some((entry) => socialEqual(entry, previous)),
    "social-conflict",
    "The buddy invitation participants disagree.",
  );
  context.result.invitationId = previous.id;
}

async function commitSocial(world, actor, message, state) {
  const { profiles, request, options, travelRequest } = state;
  const ids = [...profiles.keys()];
  const mutate = (drafts) => mutateSocial(drafts, actor, request, options);
  if (travelRequest && travelRequest.kind !== "summon-invite") {
    return world.travelParticipants(actor, message, {
      destination: { mapId: options.travel.location.mapId, portal: 0 },
      ids,
      mutate,
    });
  }
  return world.participants.commit(actor, operationFor(message), ids, mutate);
}

/** Every native operation resolves real identities and runs the shared rules on one detached cohort. */
export async function executeSocial(actor, message, world) {
  let travel = null;
  try {
    admitActor(actor, world, message.fieldEpoch);
    requireInteraction(!actor.tradeId, "CHARACTER_BUSY");
    requireInteraction(
      message.expectedRevision === actor.socialRevision,
      "STALE_REVISION",
    );
    const request = {
      ...message.action.request,
      requestId: message.operationId,
    };
    socialRequire(
      Object.hasOwn(ACTIONS, request.kind),
      "social-action",
      "Unknown social operation.",
    );
    const profiles = await loadCohort(world, actor, request);
    requireInteraction(
      profiles.size > 0 && profiles.size <= MAX_COHORT,
      "SERVER_BUSY",
    );
    const travelRequest = familyTravelRequest(
      actor.id,
      request,
      profiles.get(actor.id),
    );
    if (travelRequest) {
      travel = await prepareSocialTravel(world, actor, profiles, travelRequest);
    }
    const options = socialOptions(world, actor, request, travel);
    const preflight = new Map();
    for (const [id, profile] of profiles) {
      preflight.set(id, structuredClone(profile));
    }
    mutateSocial(preflight, actor, request, options);
    const receipt = await commitSocial(world, actor, message, {
      profiles,
      request,
      options,
      travelRequest,
    });
    if (receipt.status === "committed") {
      publishSocialChange(world, actor, request, profiles);
    }
    return receipt;
  } catch (error) {
    world.log?.("social.refused", {
      character: actor.id,
      action: message.action.request.kind,
      rule: error.code,
      reason: String(error.message).slice(0, 256),
    });
    throw ruleError(error);
  } finally {
    travel?.release();
  }
}

function publishSocialChange(world, actor, request, profiles) {
  for (const id of profiles.keys()) {
    const peer = world.actors.get(id);
    if (peer?.state !== "active") continue;
    publishInteraction(world, peer, {
      kind: "social.changed",
      actorId: actor.id,
      action: request.kind,
      revision: peer.socialRevision,
    });
  }
}
