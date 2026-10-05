import { canFormParty } from "../profile/profile-social.js";
import { FAMILY_ENTITLEMENTS, familyDay } from "./local-social-family.js";
import { memberIds } from "./local-social-context.js";

export function participantView(store, catalog) {
  const profile = store.profile,
    mapId = profile.location.mapId;
  return {
    id: store.id,
    name: profile.name,
    level: profile.level,
    job: profile.job,
    mapId,
    mapName:
      catalog.mapNames?.[Number(mapId)] || "Original map name unavailable",
    hp: profile.hp,
    maxHp: profile.maxHP,
    online: true,
    leader: false,
    local: true,
    persistence: store.temporary ? "temporary" : "durable",
  };
}

function memberView(service, id) {
  const store = service.getParticipant(id);
  // A missing saved identity is not replaced by a fabricated remote roster member.
  return store
    ? participantView(store, service.catalog)
    : { id, name: "Local character unavailable", online: false, local: true };
}

function groupView(service, group) {
  if (!group) return null;
  const view = structuredClone(group);
  view.members = view.members.map((member) => {
    const id = typeof member === "string" ? member : member.id;
    return {
      ...memberView(service, id),
      ...(typeof member === "string" ? {} : member),
      leader: group.leaderId === id,
      rankTitle:
        typeof member === "string" ? "" : group.ranks?.[member.rank - 1] || "",
    };
  });
  return view;
}

function entitlementViews(service, family) {
  const own = family.members.find((member) => member.id === service.store.id),
    day = familyDay(Date.now());
  return FAMILY_ENTITLEMENTS.map((entry) => {
    const used = own.used.some((use) => use.id === entry.id && use.day === day);
    let reason = used
      ? "Already used today."
      : own.reputation < entry.cost
        ? "Not enough family reputation."
        : "";
    if (
      ["travel", "summon"].includes(entry.kind) &&
      !service.hooks.prepareFamilyTravel
    ) {
      reason =
        "Original field-limit and portal-zero travel preparation is not attached.";
    }
    if (
      !["travel", "summon"].includes(entry.kind) &&
      !service.hooks.familyRates
    ) {
      reason = "Family EXP/drop-rate reward consumers are not attached.";
    }
    return { ...entry, used, available: !reason && !service.busy, reason };
  });
}

function familyView(service, family) {
  const view = groupView(service, family);
  if (!view) return null;
  view.selfId = service.store.id;
  view.entitlements = entitlementViews(service, family);
  const day = familyDay(Date.now());
  for (const member of view.members) {
    if (member.reputationDay !== day) member.todayReputation = 0;
  }
  const self = view.members.find((member) => member.id === service.store.id);
  view.reputation = self.reputation;
  view.todayReputation = self.todayReputation;
  view.totalReputation = self.totalReputation;
  return view;
}

/** Read-only genealogy of an exact loaded identity; never projects peer entitlements or authority. */
export function familyTreeView(service, id) {
  const store = service.getParticipant(id);
  if (!store) {
    return {
      ok: false,
      code: "character-not-loaded",
      reason: "The selected family member is no longer loaded.",
    };
  }
  const family = store.profile.social.family;
  if (!family) {
    return {
      ok: true,
      familyId: null,
      root: participantView(store, service.catalog),
      members: [],
      leaderId: null,
    };
  }
  for (const member of family.members) {
    if (!service.getParticipant(member.id)) {
      return {
        ok: false,
        code: "family-member-unavailable",
        reason: "A saved member of this family is not loaded.",
      };
    }
  }
  const view = groupView(service, family),
    day = familyDay(Date.now());
  for (const member of view.members) {
    if (member.reputationDay !== day) member.todayReputation = 0;
  }
  const root = view.members.find((member) => member.id === id);
  if (!root) {
    return {
      ok: false,
      code: "family-member-missing",
      reason: "The selected character is absent from their saved family.",
    };
  }
  return {
    ok: true,
    familyId: family.id,
    root,
    members: view.members,
    leaderId: family.leaderId,
  };
}

export function requestsView(service, entries) {
  return entries.map((entry) => ({
    ...entry,
    invitationId: entry.id,
    fromName: memberView(service, entry.fromId).name,
    toName: memberView(service, entry.toId).name,
    incoming: entry.toId === service.store.id,
  }));
}

function medalsView(service) {
  const profile = service.store.profile,
    result = [];
  for (const entries of [profile.inventory, profile.equipment]) {
    for (const item of entries) {
      if (Math.floor(item.id / 10000) !== 114) continue;
      result.push({
        uid: item.uid,
        id: item.id,
        name:
          service.catalog.ui?.items?.[item.id]?.name ??
          "Original medal name unavailable",
        equipped: item.slot < 0,
        category: 100,
      });
    }
  }
  return result;
}

function permissions(service, social) {
  const state = {
    active: !service.busy,
    id: service.store.id,
    job: service.store.profile.job,
    level: service.store.profile.level,
    allowPartySearch:
      service.store.profile.settings.gameOptions.allowPartySearch,
    guildRank:
      social.guild?.members.find((member) => member.id === service.store.id)
        ?.rank ?? 6,
    allianceRank:
      social.alliance?.members.find((member) => member.id === service.store.id)
        ?.rank ?? 6,
  };
  const { active } = state;
  const result = {};
  for (const action of service.actions) result[action] = active;
  partyPermissions(result, social, state);
  guildMembershipPermissions(result, social, state);
  guildManagementPermissions(result, social, state);
  alliancePermissions(result, social, state);
  familyPermissions(result, social, state);
  messengerPermissions(result, social, active);
  searchPermissions(result, social, state);
  for (const action of [
    "medal.equip",
    "medal.challenge",
    "medal.forfeit",
    "medal.claim",
  ]) {
    result[action] = active && typeof service.medalHook(action) === "function";
  }
  return result;
}

function partyPermissions(result, social, { active, id, job, level }) {
  for (const action of ["party.expel", "party.leader"]) {
    result[action] = active && social.party?.leaderId === id;
  }
  result["party.create"] =
    active && !social.party && canFormParty({ job, level });
  result["party.leave"] = active && Boolean(social.party);
}

function guildMembershipPermissions(
  result,
  social,
  { active, level, guildRank },
) {
  result["guild.create"] =
    active && !social.guild && !social.party && level >= 10;
  result["guild.leave"] = active && guildRank > 1 && guildRank <= 5;
  result["alliance.create"] = active && guildRank === 1 && !social.alliance;
}

function guildManagementPermissions(result, social, { active, guildRank }) {
  for (const action of [
    "guild.invite",
    "guild.expel",
    "guild.rank",
    "guild.notice",
  ]) {
    result[action] = active && guildRank <= 2 && !social.guild.forming;
  }
  for (const action of ["guild.leader", "guild.emblem", "guild.disband"]) {
    result[action] = active && guildRank === 1;
  }
}

function alliancePermissions(
  result,
  social,
  { active, allianceRank, guildRank },
) {
  for (const action of [
    "alliance.invite",
    "alliance.expel",
    "alliance.leader",
  ]) {
    result[action] = active && allianceRank === 1;
  }
  for (const action of ["alliance.rank", "alliance.notice"]) {
    result[action] = active && allianceRank <= 2;
  }
  result["alliance.leave"] =
    active && Boolean(social.alliance) && guildRank === 1;
}

function familyPermissions(result, social, { active, id }) {
  result["family.precept"] = active && social.family?.leaderId === id;
  for (const action of ["family.sever", "family.entitlement"]) {
    result[action] = active && Boolean(social.family);
  }
}

function messengerPermissions(result, social, active) {
  result["messenger.open"] = active && !social.messenger;
  for (const action of ["messenger.leave", "messenger.send"]) {
    result[action] = active && Boolean(social.messenger);
  }
}

function searchPermissions(
  result,
  social,
  { active, id, job, level, allowPartySearch },
) {
  const eligible =
    active &&
    allowPartySearch &&
    canFormParty({ job, level }) &&
    (!social.party || social.party.leaderId === id);
  result["search.register"] = eligible && !social.search;
  result["search.update"] = eligible && Boolean(social.search);
  result["search.remove"] = active && Boolean(social.search);
}

export function socialView(service) {
  const social = service.store.profile.social,
    participants = service.participants();
  const partySearch = [];
  for (const participant of participants) {
    const search = service.getParticipant(participant.id).profile.social.search;
    if (search && (!search.paused || participant.id === service.store.id)) {
      partySearch.push({ ...participant, ...structuredClone(search) });
    }
  }
  const alliance = groupView(service, social.alliance);
  if (alliance) {
    alliance.guilds = social.alliance.guilds.map((id) => {
      const memberId = memberIds(social.alliance).find(
        (member) =>
          service.getParticipant(member)?.profile.social.guild?.id === id,
      );
      const guild = groupView(
        service,
        service.getParticipant(memberId)?.profile.social.guild,
      );
      return guild || { id, name: "Local guild unavailable", members: [] };
    });
  }
  return {
    self: participantView(service.store, service.catalog),
    participants,
    local: true,
    busy: service.busy,
    participantErrors: structuredClone(service.participantErrors),
    friendGroups: [...social.groups],
    friends: social.friends.map((entry) => ({
      ...memberView(service, entry.id),
      group: entry.group,
    })),
    blacklist: social.blacklist.map((id) => memberView(service, id)),
    requests: requestsView(service, social.invitations),
    party: groupView(service, social.party),
    guild: groupView(service, social.guild),
    alliance,
    family: familyView(service, social.family),
    messenger: groupView(service, social.messenger),
    partySearch,
    medals: medalsView(service),
    medalQuests: service.medalEntries(),
    permissions: permissions(service, social),
  };
}
