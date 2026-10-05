import {
  canFormParty,
  DEFAULT_FRIEND_GROUP,
  PARTY_FORMATION_REFUSAL,
  SOCIAL_LIMITS,
  validateSearch,
} from "../profile/profile-social.js";
import {
  admitContact,
  cancelGroupInvitations,
  invite,
  memberIds,
  socialRequire,
  socialText,
} from "./local-social-context.js";

function friendInvite(context) {
  const target = context.target(),
    self = context.get();
  socialRequire(
    !self.social.friends.some((entry) => entry.id === context.payload.targetId),
    "already-friends",
    "That character is already on your buddy list.",
  );
  socialRequire(
    self.social.friends.length < SOCIAL_LIMITS.friends &&
      target.social.friends.length < SOCIAL_LIMITS.friends,
    "friend-capacity",
    "One of the buddy lists is full.",
  );
  const group = context.payload.groupId ?? DEFAULT_FRIEND_GROUP;
  socialRequire(
    self.social.groups.includes(group),
    "group-missing",
    "Choose an existing buddy group.",
  );
  const request = invite(context, "friend", context.payload.targetId);
  request.groupName = group;
  target.social.invitations.find((entry) => entry.id === request.id).groupName =
    group;
}

export function acceptFriend(context, request) {
  admitContact(context, request.fromId);
  const target = context.get(),
    sender = context.get(request.fromId);
  socialRequire(
    target.social.friends.length < SOCIAL_LIMITS.friends &&
      sender.social.friends.length < SOCIAL_LIMITS.friends,
    "friend-capacity",
    "One of the buddy lists is full.",
  );
  socialRequire(
    sender.social.groups.includes(request.groupName),
    "group-missing",
    "The invitation's buddy group no longer exists.",
  );
  if (!target.social.friends.some((entry) => entry.id === request.fromId)) {
    target.social.friends.push({
      id: request.fromId,
      group: DEFAULT_FRIEND_GROUP,
    });
  }
  if (!sender.social.friends.some((entry) => entry.id === context.actorId)) {
    sender.social.friends.push({
      id: context.actorId,
      group: request.groupName,
    });
  }
}

function friendRemove(context) {
  const self = context.get(),
    target = context.target();
  socialRequire(
    self.social.friends.some((entry) => entry.id === context.payload.targetId),
    "friend-missing",
    "That character is not on your buddy list.",
  );
  self.social.friends = self.social.friends.filter(
    (entry) => entry.id !== context.payload.targetId,
  );
  target.social.friends = target.social.friends.filter(
    (entry) => entry.id !== context.actorId,
  );
}

function friendGroup(context) {
  const social = context.get().social,
    payload = context.payload;
  if (payload.targetId) {
    const friend = social.friends.find(
      (entry) => entry.id === payload.targetId,
    );
    const name = payload.name ?? payload.groupId;
    socialRequire(
      friend && social.groups.includes(name),
      "group-missing",
      "Select a buddy and an existing group.",
    );
    friend.group = name;
    return;
  }
  if (payload.groupId) return editFriendGroup(context, payload);
  const name = socialText(payload.name, SOCIAL_LIMITS.groupName, "Group name");
  socialRequire(
    !social.groups.includes(name) &&
      social.groups.length < SOCIAL_LIMITS.groups,
    "group-capacity",
    "That group already exists or the group list is full.",
  );
  social.groups.push(name);
}

function editFriendGroup(context, payload) {
  const social = context.get().social;
  socialRequire(
    social.groups.includes(payload.groupId) &&
      payload.groupId !== DEFAULT_FRIEND_GROUP,
    "group-protected",
    "Select a non-default buddy group.",
  );
  if (payload.remove === true) {
    socialRequire(
      !social.friends.some((entry) => entry.group === payload.groupId),
      "group-not-empty",
      "Move this group's buddies before removing it.",
    );
    socialRequire(
      !social.invitations.some(
        (entry) =>
          entry.kind === "friend" &&
          entry.fromId === context.actorId &&
          entry.groupName === payload.groupId,
      ),
      "group-not-empty",
      "Cancel this group's pending buddy invitations before removing it.",
    );
    social.groups = social.groups.filter((name) => name !== payload.groupId);
    return;
  }
  const name = socialText(payload.name, SOCIAL_LIMITS.groupName, "Group name");
  socialRequire(
    !social.groups.includes(name),
    "group-exists",
    "That group already exists.",
  );
  social.groups[social.groups.indexOf(payload.groupId)] = name;
  for (const friend of social.friends) {
    if (friend.group === payload.groupId) friend.group = name;
  }
  for (const request of social.invitations) {
    if (
      request.kind !== "friend" ||
      request.fromId !== context.actorId ||
      request.groupName !== payload.groupId
    ) {
      continue;
    }
    const peer = context
      .get(request.toId)
      .social.invitations.find((entry) => entry.id === request.id);
    socialRequire(
      peer,
      "social-conflict",
      "A buddy invitation participant is missing.",
    );
    request.groupName = name;
    peer.groupName = name;
  }
}

function block(context) {
  const self = context.get();
  context.target();
  const targetId = context.payload.targetId;
  socialRequire(
    !self.social.blacklist.includes(targetId),
    "already-blocked",
    "That character is already blocked.",
  );
  self.social.blacklist.push(targetId);
  const matches = (entry) =>
    (entry.fromId === context.actorId && entry.toId === targetId) ||
    (entry.toId === context.actorId && entry.fromId === targetId);
  const cancelled = self.social.invitations.filter(matches);
  context.removeInvitations(matches);
  for (const request of cancelled) cancelBlockedCharter(context, request);
}

function cancelBlockedCharter(context, request) {
  if (!["guild-create", "alliance-create"].includes(request.kind)) return;
  const kind = request.kind === "guild-create" ? "guild" : "alliance";
  const founder = context.get(request.fromId),
    group = founder.social[kind];
  if (!group?.forming || group.id !== request.groupId) return;
  if (kind === "guild" && founder.social.party?.leaderId === request.fromId) {
    context.mirror("party", null, memberIds(founder.social.party));
  }
  context.mirror(kind, null, memberIds(group));
  cancelGroupInvitations(context, kind, group.id);
}

function unblock(context) {
  const self = context.get();
  socialRequire(
    self.social.blacklist.includes(context.payload.targetId),
    "not-blocked",
    "That character is not blocked.",
  );
  self.social.blacklist = self.social.blacklist.filter(
    (id) => id !== context.payload.targetId,
  );
}

function partyCreate(context) {
  const self = context.get();
  socialRequire(
    !self.social.party,
    "party-requirements",
    "Already have joined a party.",
  );
  socialRequire(
    canFormParty(self, context.capabilities?.partyForStarters),
    "party-requirements",
    PARTY_FORMATION_REFUSAL,
  );
  self.social.party = {
    id: context.uid(),
    leaderId: context.actorId,
    members: [context.actorId],
  };
  self.social.search = null;
}

function partyInvite(context) {
  if (!context.get().social.party) partyCreate(context);
  const party = context.group("party"),
    target = context.target();
  socialRequire(
    !target.social.party &&
      canFormParty(target, context.capabilities?.partyForStarters),
    "party-requirements",
    "The invited character is already in a party or is a Beginner, Noblesse or Legend below Lv. 10.",
  );
  socialRequire(
    party.members.length < SOCIAL_LIMITS.party,
    "party-full",
    "The party already has six members.",
  );
  invite(context, "party", context.payload.targetId, party);
}

export function acceptParty(context, request) {
  admitContact(context, request.fromId);
  if (request.groupName === "Join request") {
    return acceptPartySearch(context, request);
  }
  const self = context.get(),
    party = context.get(request.fromId).social.party;
  socialRequire(
    party?.id === request.groupId && !self.social.party,
    "party-requirements",
    "The party invitation is no longer applicable.",
  );
  socialRequire(
    canFormParty(self, context.capabilities?.partyForStarters),
    "party-requirements",
    PARTY_FORMATION_REFUSAL,
  );
  socialRequire(
    party.members.length < SOCIAL_LIMITS.party,
    "party-full",
    "The party already has six members.",
  );
  party.members.push(context.actorId);
  self.social.search = null;
  context.mirror("party", party);
}

function acceptPartySearch(context, request) {
  const party = context.group("party"),
    applicant = context.get(request.fromId),
    search = context.get().social.search;
  context.leader(party);
  socialRequire(
    party.id === request.groupId &&
      search?.partyId === party.id &&
      !search.paused &&
      !applicant.social.party,
    "search-missing",
    "This party is no longer accepting that join request.",
  );
  socialRequire(
    applicant.level >= search.minLevel &&
      applicant.level <= search.maxLevel &&
      (!search.jobs.length || search.jobs.includes(applicant.job)),
    "search-filter",
    "The applicant no longer matches the party search.",
  );
  socialRequire(
    party.members.length < SOCIAL_LIMITS.party,
    "party-full",
    "The party already has six members.",
  );
  party.members.push(request.fromId);
  applicant.social.search = null;
  context.mirror("party", party);
}

function partyLeave(context) {
  const party = context.group("party"),
    previous = memberIds(party);
  if (party.leaderId === context.actorId) {
    context.mirror("party", null, previous);
    cancelGroupInvitations(context, "party", party.id);
  } else {
    party.members = party.members.filter((id) => id !== context.actorId);
    context.mirror("party", party, previous);
  }
  for (const id of previous) context.get(id).social.search = null;
}

function partyExpel(context) {
  const party = context.group("party"),
    targetId = context.payload.targetId;
  context.leader(party);
  socialRequire(
    targetId !== context.actorId && party.members.includes(targetId),
    "party-member",
    "Select another party member.",
  );
  const previous = memberIds(party);
  party.members = party.members.filter((id) => id !== targetId);
  context.mirror("party", party, previous);
  context.get(targetId).social.search = null;
}

function partyLeader(context) {
  const party = context.group("party");
  context.leader(party);
  socialRequire(
    party.members.includes(context.payload.targetId),
    "party-member",
    "Select a party member.",
  );
  party.leaderId = context.payload.targetId;
  context.mirror("party", party);
  for (const id of party.members) context.get(id).social.search = null;
}

function messengerOpen(context) {
  const self = context.get();
  socialRequire(
    !self.social.messenger,
    "messenger-open",
    "A messenger session is already open.",
  );
  self.social.messenger = {
    id: context.uid(),
    members: [context.actorId],
    messages: [],
  };
}

function messengerInvite(context) {
  if (!context.get().social.messenger) messengerOpen(context);
  const session = context.group("messenger"),
    target = context.target();
  socialRequire(
    !target.social.messenger,
    "messenger-open",
    "The selected character is already in a messenger session.",
  );
  socialRequire(
    session.members.length < SOCIAL_LIMITS.messenger,
    "messenger-full",
    "Maple Messenger has three members.",
  );
  invite(context, "messenger", context.payload.targetId, session);
}

export function acceptMessenger(context, request) {
  admitContact(context, request.fromId);
  const session = context.get(request.fromId).social.messenger;
  socialRequire(
    session?.id === request.groupId && !context.get().social.messenger,
    "messenger-unavailable",
    "The messenger invitation is no longer applicable.",
  );
  socialRequire(
    session.members.length < SOCIAL_LIMITS.messenger,
    "messenger-full",
    "Maple Messenger has three members.",
  );
  session.members.push(context.actorId);
  context.mirror("messenger", session);
}

function messengerLeave(context) {
  const session = context.group("messenger"),
    previous = memberIds(session);
  session.members = session.members.filter((id) => id !== context.actorId);
  context.mirror(
    "messenger",
    session.members.length ? session : null,
    previous,
  );
  context.removeInvitations(
    (entry) => entry.kind === "messenger" && entry.fromId === context.actorId,
  );
}

function messengerSend(context) {
  const session = context.group("messenger"),
    self = context.get();
  const text = socialText(
    context.payload.text,
    SOCIAL_LIMITS.message,
    "Message",
  );
  socialRequire(text.trim(), "empty-message", "Enter a message.");
  session.messages.push({
    id: context.uid(),
    senderId: context.actorId,
    senderName: self.name,
    text,
    createdAt: context.now,
  });
  if (session.messages.length > SOCIAL_LIMITS.messages) {
    session.messages.shift();
  }
  context.mirror("messenger", session);
}

/** Cosmic register handler is empty; filters/description are explicit bounded local search policy. */
function searchWrite(context) {
  const self = context.get(),
    party = self.social.party;
  socialRequire(
    self.settings.gameOptions.allowPartySearch,
    "search-disabled",
    "Enable Party Search in Game Options before registering.",
  );
  socialRequire(
    !party || party.leaderId === context.actorId,
    "search-requirements",
    "Only an ungrouped character or party leader can register.",
  );
  socialRequire(
    canFormParty(self, context.capabilities?.partyForStarters),
    "search-requirements",
    PARTY_FORMATION_REFUSAL,
  );
  const search = searchListing(context.payload, self.social.search);
  search.partyId = party?.id ?? null;
  validateSearch(search);
  self.social.search = search;
}

function searchListing(payload, previous) {
  const search = searchFilters(payload, previous);
  search.text = payload.text ?? previous?.text ?? "";
  search.partyId = null;
  search.paused = payload.paused ?? previous?.paused ?? false;
  return search;
}

function searchFilters(payload, previous) {
  return {
    minLevel: payload.minLevel ?? previous?.minLevel ?? 1,
    maxLevel: payload.maxLevel ?? previous?.maxLevel ?? 200,
    jobs: payload.jobs ?? previous?.jobs ?? [],
  };
}

function searchRegister(context) {
  socialRequire(
    !context.get().social.search,
    "search-registered",
    "This character is already registered.",
  );
  searchWrite(context);
}

function searchUpdate(context) {
  socialRequire(
    context.get().social.search,
    "search-missing",
    "Register before editing the search listing.",
  );
  searchWrite(context);
}

function searchRemove(context) {
  socialRequire(
    context.get().social.search,
    "search-missing",
    "This character has no search listing.",
  );
  context.get().social.search = null;
}

function searchInvite(context) {
  const target = context.target(),
    search = target.social.search,
    self = context.get();
  socialRequire(
    target.settings.gameOptions.allowPartySearch,
    "search-disabled",
    "That character has disabled Party Search requests.",
  );
  socialRequire(
    search && !search.paused,
    "search-missing",
    "The selected search listing is no longer active.",
  );
  socialRequire(
    self.level >= search.minLevel &&
      self.level <= search.maxLevel &&
      (!search.jobs.length || search.jobs.includes(self.job)),
    "search-filter",
    "Your character does not match the search criteria.",
  );
  if (!search.partyId) return partyInvite(context);
  const party = target.social.party;
  socialRequire(
    !self.social.party &&
      party?.id === search.partyId &&
      party.leaderId === context.payload.targetId,
    "party-requirements",
    "The selected party is no longer recruiting.",
  );
  socialRequire(
    party.members.length < SOCIAL_LIMITS.party,
    "party-full",
    "The party already has six members.",
  );
  // A join request is answered by the actual leader, not auto-accepted for a peer.
  invite(context, "party", context.payload.targetId, {
    id: party.id,
    name: "Join request",
  });
}

export const CONTACT_ACTIONS = Object.freeze({
  "friend.invite": friendInvite,
  "friend.remove": friendRemove,
  "friend.group": friendGroup,
  "friend.block": block,
  "friend.unblock": unblock,
  "party.create": partyCreate,
  "party.invite": partyInvite,
  "party.leave": partyLeave,
  "party.expel": partyExpel,
  "party.leader": partyLeader,
  "messenger.open": messengerOpen,
  "messenger.invite": messengerInvite,
  "messenger.leave": messengerLeave,
  "messenger.send": messengerSend,
  "search.register": searchRegister,
  "search.update": searchUpdate,
  "search.remove": searchRemove,
  "search.invite": searchInvite,
});
