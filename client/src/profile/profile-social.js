import {
  domainArray,
  domainId,
  domainInteger,
  domainInvalid,
  domainKeys,
  domainText,
  domainUnique,
} from "./profile-domain-validation.js";

/** Server limits: party6, messenger3, buddy group16, guild notice100, family precept200.
 * Roster32, invitations96, history64 and retained board64 are explicit browser budgets. */
export const SOCIAL_LIMITS = Object.freeze({
  members: 32,
  party: 6,
  messenger: 3,
  friends: 20,
  groups: 20,
  groupName: 16,
  invitations: 96,
  messages: 64,
  message: 256,
  board: 64,
  comments: 64,
  guildName: 12,
  notice: 100,
  precept: 200,
  guildRankName: 45,
  allianceRankName: 11,
  allianceNotice: 20,
  guildCapacity: 10,
});
/** Native 0052fce1/0052fecf refuse jobs 0/1000/2000/2001 below level10 with string 0x14c1;
 * other jobs (a level8 Magician) may form parties. See docs/offline-binding-actions.md.
 * partyForStarters is the Cosmic USE_PARTY_FOR_STARTERS server policy switch (default false). */
export const PARTY_FORMATION_REFUSAL =
  "Characters whose level is below Lv. 10, such as Beginners, Noblesses, and Legends cannot form a party.";
export function canFormParty({ job, level }, partyForStarters = false) {
  return (
    partyForStarters || level >= 10 || ![0, 1000, 2000, 2001].includes(job)
  );
}
/** Published gameplay policy from the catalog; absent means the original client rule. */
export function partyForStarters(catalog) {
  return catalog?.serverData?.policy?.USE_PARTY_FOR_STARTERS === true;
}
export const SOCIAL_KINDS = Object.freeze([
  "friend",
  "party",
  "guild",
  "guild-create",
  "alliance",
  "alliance-create",
  "family",
  "messenger",
  "family-summon",
]);
export const DEFAULT_FRIEND_GROUP = "Default Group";

export function createSocial() {
  return {
    groups: [DEFAULT_FRIEND_GROUP],
    friends: [],
    blacklist: [],
    invitations: [],
    party: null,
    guild: null,
    alliance: null,
    family: null,
    messenger: null,
    search: null,
    familyEffects: [],
  };
}

function ids(value, max, path) {
  domainArray(value, max, path);
  for (const id of value) domainId(id, path);
  domainUnique(value, path);
}

function members(value, max, path) {
  ids(value, max, path);
  if (!value.length) domainInvalid(path);
}

function ranked(value, max, path) {
  domainArray(value, max, path);
  if (!value.length) domainInvalid(path);
  for (const member of value) {
    domainKeys(member, ["id", "rank"], path);
    domainId(member.id, path);
    domainInteger(member.rank, 1, 5, path);
  }
  domainUnique(
    value.map((member) => member.id),
    path,
  );
}

function groupLeader(value, rankedMembers = false) {
  domainId(value.id, "group id");
  domainId(value.leaderId, "group leader");
  const list = rankedMembers
    ? value.members.map((member) => member.id)
    : value.members;
  if (!list.includes(value.leaderId)) domainInvalid("group leader membership");
  if (
    rankedMembers &&
    (value.members.filter((member) => member.rank === 1).length !== 1 ||
      value.members.find((member) => member.id === value.leaderId).rank !== 1)
  ) {
    domainInvalid("group leader rank");
  }
}

export function validateRankTitles(
  value,
  maximum = SOCIAL_LIMITS.guildRankName,
) {
  domainArray(value, 5, "rank titles");
  if (value.length !== 5) domainInvalid("rank titles");
  for (const title of value) domainText(title, maximum, "rank title", 1);
}

export function validateEmblem(value) {
  domainKeys(
    value,
    ["background", "backgroundColor", "logo", "logoColor"],
    "guild emblem",
  );
  for (const field of ["background", "logo"]) {
    domainInteger(value[field], 0, 65535, "emblem shape");
  }
  for (const field of ["backgroundColor", "logoColor"]) {
    domainInteger(value[field], 0, 255, "emblem color");
  }
}

function validateParty(value) {
  domainKeys(value, ["id", "leaderId", "members"], "party");
  members(value.members, SOCIAL_LIMITS.party, "party members");
  groupLeader(value);
}

function validateGuild(value) {
  domainKeys(
    value,
    [
      "id",
      "name",
      "leaderId",
      "members",
      "ranks",
      "notice",
      "emblem",
      "forming",
      "threads",
    ],
    "guild",
  );
  domainText(value.name, SOCIAL_LIMITS.guildName, "guild name", 3);
  if (!/^[A-Za-z]+$/.test(value.name)) domainInvalid("guild name");
  ranked(value.members, SOCIAL_LIMITS.guildCapacity, "guild members");
  groupLeader(value, true);
  validateRankTitles(value.ranks);
  domainText(value.notice, SOCIAL_LIMITS.notice, "guild notice");
  validateEmblem(value.emblem);
  if (typeof value.forming !== "boolean") domainInvalid("guild charter");
  domainArray(value.threads, SOCIAL_LIMITS.board, "guild board");
  for (const thread of value.threads) validateThread(thread);
  domainUnique(
    value.threads.map((thread) => thread.id),
    "guild threads",
  );
}

function validateThread(value) {
  domainKeys(
    value,
    ["id", "authorId", "title", "text", "notice", "createdAt", "comments"],
    "guild thread",
  );
  domainId(value.id, "thread id");
  domainId(value.authorId, "thread author");
  domainText(value.title, 25, "thread title", 1);
  domainText(value.text, 600, "thread text", 1);
  domainInteger(value.createdAt, 0, Number.MAX_SAFE_INTEGER, "thread time");
  if (typeof value.notice !== "boolean") domainInvalid("thread notice");
  domainArray(value.comments, SOCIAL_LIMITS.comments, "thread comments");
  for (const comment of value.comments) {
    domainKeys(comment, ["id", "authorId", "text", "createdAt"], "comment");
    domainId(comment.id, "comment id");
    domainId(comment.authorId, "comment author");
    domainText(comment.text, 25, "comment text", 1);
    domainInteger(
      comment.createdAt,
      0,
      Number.MAX_SAFE_INTEGER,
      "comment time",
    );
  }
  domainUnique(
    value.comments.map((comment) => comment.id),
    "comments",
  );
}

function validateAlliance(value) {
  domainKeys(
    value,
    [
      "id",
      "name",
      "leaderId",
      "members",
      "guilds",
      "notice",
      "ranks",
      "forming",
    ],
    "alliance",
  );
  domainText(value.name, 12, "alliance name", 1);
  if (/\s/.test(value.name)) domainInvalid("alliance name");
  ranked(value.members, SOCIAL_LIMITS.members, "alliance members");
  groupLeader(value, true);
  members(value.guilds, 2, "alliance guilds");
  validateRankTitles(value.ranks, SOCIAL_LIMITS.allianceRankName);
  domainText(value.notice, SOCIAL_LIMITS.allianceNotice, "alliance notice");
  if (typeof value.forming !== "boolean") domainInvalid("alliance charter");
}

function validateInvitation(value) {
  domainKeys(
    value,
    ["id", "kind", "fromId", "toId", "groupId", "groupName", "createdAt"],
    "invitation",
  );
  for (const field of ["id", "fromId", "toId"]) {
    domainId(value[field], "invitation identity");
  }
  if (value.fromId === value.toId || !SOCIAL_KINDS.includes(value.kind)) {
    domainInvalid("invitation participants");
  }
  if (value.groupId !== null) domainId(value.groupId, "invitation group");
  domainText(value.groupName, 16, "invitation group name");
  domainInteger(value.createdAt, 0, Number.MAX_SAFE_INTEGER, "invitation time");
}

function validateFamily(value) {
  domainKeys(value, ["id", "leaderId", "members", "precept"], "family");
  domainArray(value.members, SOCIAL_LIMITS.members, "family members");
  if (!value.members.length) domainInvalid("family members");
  for (const member of value.members) validateFamilyMember(member);
  domainUnique(
    value.members.map((member) => member.id),
    "family members",
  );
  domainId(value.id, "family id");
  domainId(value.leaderId, "family leader");
  domainText(value.precept, SOCIAL_LIMITS.precept, "family precept");
  validateFamilyTree(value);
}

function validateFamilyMember(value) {
  domainKeys(
    value,
    [
      "id",
      "parentId",
      "reputation",
      "reputationDay",
      "todayReputation",
      "totalReputation",
      "used",
    ],
    "family member",
  );
  domainId(value.id, "family member");
  if (value.parentId !== null) domainId(value.parentId, "family parent");
  domainInteger(value.reputation, -2147483648, 2147483647, "family reputation");
  domainInteger(
    value.reputationDay,
    0,
    Number.MAX_SAFE_INTEGER,
    "family reputation day",
  );
  domainInteger(
    value.todayReputation,
    -2147483648,
    2147483647,
    "family daily reputation",
  );
  domainInteger(
    value.totalReputation,
    0,
    2147483647,
    "family total reputation",
  );
  domainArray(value.used, 11, "family entitlements");
  for (const entry of value.used) {
    domainKeys(entry, ["id", "day"], "used entitlement");
    domainInteger(entry.id, 0, 10, "entitlement id");
    domainInteger(entry.day, 0, Number.MAX_SAFE_INTEGER, "entitlement day");
  }
  domainUnique(
    value.used.map((entry) => entry.id),
    "family entitlements",
  );
}

function validateFamilyEffects(value) {
  domainArray(value, 2, "family effects");
  for (const entry of value) {
    domainKeys(entry, ["kind", "rate", "expiresAt"], "family effect");
    if (
      !["exp", "drop"].includes(entry.kind) ||
      ![1.5, 2].includes(entry.rate)
    ) {
      domainInvalid("family effect");
    }
    domainInteger(
      entry.expiresAt,
      0,
      Number.MAX_SAFE_INTEGER,
      "family effect time",
    );
  }
  domainUnique(
    value.map((entry) => entry.kind),
    "family effects",
  );
}

/** Every chain reaches the single root; cycles and more than two juniors are rejected. */
function validateFamilyTree(value) {
  const entries = new Map(value.members.map((member) => [member.id, member]));
  const root = entries.get(value.leaderId);
  if (!root || root.parentId !== null) domainInvalid("family root");
  const juniors = new Map();
  for (const member of value.members) {
    if (member.id !== root.id && !entries.has(member.parentId)) {
      domainInvalid("family parent");
    }
    const count = (juniors.get(member.parentId) ?? 0) + 1;
    juniors.set(member.parentId, count);
    if (member.parentId !== null && count > 2) {
      domainInvalid("family junior capacity");
    }
    validateFamilyAncestry(member, root, entries);
  }
}

function validateFamilyAncestry(member, root, entries) {
  const seen = new Set();
  let current = member;
  for (
    let depth = 0;
    current !== root && depth < SOCIAL_LIMITS.members;
    depth++
  ) {
    if (seen.has(current.id)) domainInvalid("family cycle");
    seen.add(current.id);
    current = entries.get(current.parentId);
    if (!current) domainInvalid("family parent");
  }
  if (current !== root) domainInvalid("family depth");
}

function validateMessenger(value) {
  domainKeys(value, ["id", "members", "messages"], "messenger");
  domainId(value.id, "messenger id");
  members(value.members, SOCIAL_LIMITS.messenger, "messenger members");
  domainArray(value.messages, SOCIAL_LIMITS.messages, "messenger messages");
  for (const message of value.messages) {
    domainKeys(
      message,
      ["id", "senderId", "senderName", "text", "createdAt"],
      "messenger message",
    );
    domainId(message.id, "message id");
    domainId(message.senderId, "message sender");
    domainText(message.senderName, 32, "message sender name", 1);
    domainText(message.text, SOCIAL_LIMITS.message, "message text", 1);
    domainInteger(
      message.createdAt,
      0,
      Number.MAX_SAFE_INTEGER,
      "message time",
    );
  }
  domainUnique(
    value.messages.map((message) => message.id),
    "messenger messages",
  );
}

export function validateSearch(value) {
  domainKeys(
    value,
    ["minLevel", "maxLevel", "jobs", "text", "partyId", "paused"],
    "party search",
  );
  // Search criteria cover character levels; canFormParty gates the registering actor.
  domainInteger(value.minLevel, 1, 200, "search minimum level");
  domainInteger(value.maxLevel, value.minLevel, 200, "search maximum level");
  domainArray(value.jobs, 64, "search jobs");
  for (const job of value.jobs) domainInteger(job, 0, 9999, "search job");
  domainUnique(value.jobs, "search jobs");
  domainText(value.text, 100, "search description");
  if (value.partyId !== null) domainId(value.partyId, "search party");
  if (typeof value.paused !== "boolean") domainInvalid("search paused");
}

export function validateSocial(value) {
  domainKeys(
    value,
    [
      "groups",
      "friends",
      "blacklist",
      "invitations",
      "party",
      "guild",
      "alliance",
      "family",
      "messenger",
      "search",
      "familyEffects",
    ],
    "social",
  );
  domainArray(value.groups, SOCIAL_LIMITS.groups, "friend groups");
  for (const group of value.groups) {
    domainText(group, SOCIAL_LIMITS.groupName, "friend group", 1);
  }
  domainUnique(value.groups, "friend groups");
  if (!value.groups.includes(DEFAULT_FRIEND_GROUP)) {
    domainInvalid("default friend group");
  }
  domainArray(value.friends, SOCIAL_LIMITS.friends, "friends");
  for (const friend of value.friends) {
    domainKeys(friend, ["id", "group"], "friend");
    domainId(friend.id, "friend id");
    if (!value.groups.includes(friend.group)) domainInvalid("friend group");
  }
  domainUnique(
    value.friends.map((friend) => friend.id),
    "friends",
  );
  ids(value.blacklist, SOCIAL_LIMITS.members, "blacklist");
  domainArray(value.invitations, SOCIAL_LIMITS.invitations, "invitations");
  for (const invitation of value.invitations) validateInvitation(invitation);
  domainUnique(
    value.invitations.map((invitation) => invitation.id),
    "invitations",
  );
  if (value.party !== null) validateParty(value.party);
  if (value.guild !== null) validateGuild(value.guild);
  if (value.alliance !== null) validateAlliance(value.alliance);
  if (value.family !== null) validateFamily(value.family);
  if (value.messenger !== null) validateMessenger(value.messenger);
  if (value.search !== null) validateSearch(value.search);
  validateFamilyEffects(value.familyEffects);
}

/** Every mirrored membership and invitation must include its durable row owner. */
export function validateSocialOwner(value, ownerId) {
  for (const kind of ["party", "guild", "alliance", "family", "messenger"]) {
    const group = value[kind];
    if (!group) continue;
    const memberIds = group.members.map((member) =>
      typeof member === "string" ? member : member.id,
    );
    if (
      !memberIds.includes(ownerId) ||
      memberIds.some((id) => id.length > 64)
    ) {
      domainInvalid(`${kind} owner`);
    }
  }
  validateInvitationOwner(value.invitations, ownerId);
  for (const id of [
    ...value.friends.map((entry) => entry.id),
    ...value.blacklist,
  ]) {
    if (id === ownerId || id.length > 64) domainInvalid("social character id");
  }
}

function validateInvitationOwner(invitations, ownerId) {
  for (const invitation of invitations) {
    if (invitation.fromId !== ownerId && invitation.toId !== ownerId) {
      domainInvalid("invitation owner");
    }
    if (invitation.fromId.length > 64 || invitation.toId.length > 64) {
      domainInvalid("invitation character id");
    }
  }
}
