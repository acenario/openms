import { expect, test } from "bun:test";
import { executeSocial } from "../src/interaction-social.js";
import { loadContent } from "../src/content.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { nativeOutcome } from "../../client/src/online/native-source.js";

const content = await loadContent();

function fixture(names = ["Developer", "Player"]) {
  const field = { epoch: "field", characters: new Map() },
    events = [];
  const actors = new Map(),
    saved = new Map();
  for (const name of names) {
    const profile = createProfile({
      mapId: "000050000",
      x: 167,
      y: 335,
      facing: 1,
    });
    profile.name = name;
    const actor = {
      id: crypto.randomUUID(),
      state: "active",
      session: { expiresAt: Date.now() + 60000 },
      field,
      profile,
      socialRevision: 0,
    };
    actors.set(actor.id, actor);
    field.characters.set(actor.id, actor);
    saved.set(actor.id, profile);
  }
  const world = {
    content,
    actors,
    publish: (actor, message) => events.push({ id: actor.id, ...message }),
    participants: {
      resolve: async (id) => id,
      load: async () => structuredClone(saved),
      commit: async (_, operation, ids, mutator) => {
        const drafts = structuredClone(saved),
          result = await mutator(drafts);
        for (const id of ids) {
          saved.set(id, drafts.get(id));
          actors.get(id).profile = drafts.get(id);
          actors.get(id).socialRevision++;
        }
        return {
          status: "committed",
          code: "OK",
          transactionId: operation.operationId,
          ...result,
        };
      },
    },
  };
  return { world, actors: [...actors.values()], saved, events };
}

function execute(probe, actor, request) {
  return executeSocial(
    actor,
    {
      operationId: crypto.randomUUID(),
      fieldEpoch: "field",
      expectedRevision: actor.socialRevision,
      action: { kind: "social.execute", request },
    },
    probe.world,
  );
}

test("buddy invitations survive an offline recipient, repeat Add, and become reciprocal only on acceptance", async () => {
  const probe = fixture(),
    [sender, receiver] = probe.actors;
  receiver.state = "offline";
  const request = { kind: "friend.invite", targetId: receiver.id };
  const first = await execute(probe, sender, request);
  const repeated = await execute(probe, sender, request);
  expect(repeated.value.invitationId).toBe(first.value.invitationId);
  expect(receiver.profile.social.invitations).toHaveLength(1);
  expect(sender.profile.social.friends).toHaveLength(0);
  receiver.state = "active";
  // JSONB reload changes object property order while the sender stays in memory.
  receiver.profile.social.invitations[0] = Object.fromEntries(
    Object.entries(receiver.profile.social.invitations[0]).reverse(),
  );
  await execute(probe, receiver, {
    kind: "invitation.accept",
    invitationId: first.value.invitationId,
  });
  expect(probe.saved.get(sender.id).social.friends[0].id).toBe(receiver.id);
  expect(probe.saved.get(receiver.id).social.friends[0].id).toBe(sender.id);
  expect(receiver.profile.social.invitations).toHaveLength(0);
  expect(new Set(probe.events.slice(-2).map((event) => event.id)).size).toBe(2);
});

test("buddy admission preserves blocks/preferences and exposes a useful closed refusal", async () => {
  const probe = fixture(),
    [sender, receiver] = probe.actors;
  await expect(
    execute(probe, sender, { kind: "friend.invite", targetId: sender.id }),
  ).rejects.toMatchObject({ code: "SOCIAL_SELF_TARGET" });
  receiver.profile.settings.gameOptions.allowFriend = false;
  await expect(
    execute(probe, sender, { kind: "friend.invite", targetId: receiver.id }),
  ).rejects.toMatchObject({ code: "INVITATION_DISABLED" });
  const outcome = nativeOutcome({
    status: "rejected",
    code: "INVITATION_DISABLED",
  });
  expect(outcome.reason).toContain("Game Options");
  expect(probe.saved.get(sender.id).social.invitations).toHaveLength(0);
});

test("an offline buddy can queue requests from different senders without duplicates", async () => {
  const probe = fixture(["Developer", "Player", "Third"]),
    [first, receiver, second] = probe.actors;
  receiver.state = "offline";
  const request = { kind: "friend.invite", targetId: receiver.id };
  await execute(probe, first, request);
  await execute(probe, second, request);
  await execute(probe, second, request);
  expect(receiver.profile.social.invitations).toHaveLength(2);
  receiver.state = "active";
  for (const invitation of [...receiver.profile.social.invitations]) {
    await execute(probe, receiver, {
      kind: "invitation.accept",
      invitationId: invitation.id,
    });
  }
  expect(receiver.profile.social.friends).toHaveLength(2);
  expect(first.profile.social.friends[0].id).toBe(receiver.id);
  expect(second.profile.social.friends[0].id).toBe(receiver.id);
});

// Cosmic USE_PARTY_FOR_STARTERS reaches the shared rule through the published catalog policy.
test("USE_PARTY_FOR_STARTERS gates a level 1 Beginner's party.create on the server", async () => {
  const probe = fixture(),
    [beginner] = probe.actors;
  await expect(
    execute(probe, beginner, { kind: "party.create" }),
  ).rejects.toThrow("cannot form a party");
  const catalog = content.catalog;
  probe.world.content = Object.create(content, {
    catalog: {
      value: {
        ...catalog,
        serverData: {
          ...catalog.serverData,
          policy: { USE_PARTY_FOR_STARTERS: true },
        },
      },
    },
  });
  await execute(probe, beginner, { kind: "party.create" });
  expect(beginner.profile.social.party.members).toEqual([beginner.id]);
});
