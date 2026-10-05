import { expect, test } from "bun:test";
import { createProfile } from "../src/profile/profile-validation.js";
import { SocialContext } from "../src/social/local-social-context.js";
import {
  acceptParty,
  CONTACT_ACTIONS,
} from "../src/social/local-social-actions.js";

function run(profiles, actorId, action, { capabilities, ...payload } = {}) {
  const context = new SocialContext(
    profiles,
    actorId,
    { requestId: action, ...payload },
    0,
  );
  context.capabilities = capabilities;
  return CONTACT_ACTIONS[action](context);
}

function profiles(...stats) {
  return new Map(
    stats.map(([job, level], index) => [
      `c${index}`,
      Object.assign(
        createProfile({ mapId: "100000000", x: 0, y: 0, facing: 1 }),
        {
          job,
          level,
        },
      ),
    ]),
  );
}

// Client 0052fce1/0052fecf gate only jobs 0/1000/2000/2001 below level 10 (string 0x14c1).
test("only beginner-family characters below level 10 cannot form a party", () => {
  expect(() => run(profiles([0, 9]), "c0", "party.create")).toThrow(
    "Characters whose level is below Lv. 10, such as Beginners, Noblesses, and Legends cannot form a party.",
  );
  for (const job of [1000, 2000, 2001]) {
    expect(() => run(profiles([job, 9]), "c0", "party.create")).toThrow();
  }
  const beginner = profiles([0, 10]);
  run(beginner, "c0", "party.create");
  expect(beginner.get("c0").social.party.members).toEqual(["c0"]);
});

test("a level 9 Magician can create, invite and accept", () => {
  const party = profiles([200, 9], [200, 9], [0, 9]);
  run(party, "c0", "party.create");
  run(party, "c0", "party.invite", { targetId: "c1" });
  const request = party.get("c1").social.invitations[0];
  acceptParty(
    new SocialContext(party, "c1", { requestId: "accept" }, 0),
    request,
  );
  expect(party.get("c0").social.party.members).toEqual(["c0", "c1"]);
  expect(() => run(party, "c0", "party.invite", { targetId: "c2" })).toThrow();
});

// Cosmic USE_PARTY_FOR_STARTERS server policy (infra/gameplay-definitions/policy.json).
test("USE_PARTY_FOR_STARTERS admits level 9 beginners only when enabled", () => {
  const off = profiles([0, 9]);
  expect(() =>
    run(off, "c0", "party.create", {
      capabilities: { partyForStarters: false },
    }),
  ).toThrow("cannot form a party");
  const on = { partyForStarters: true };
  const party = profiles([0, 9], [1000, 9], [2000, 1]);
  run(party, "c0", "party.create", { capabilities: on });
  run(party, "c0", "party.invite", { targetId: "c1", capabilities: on });
  const context = new SocialContext(party, "c1", { requestId: "accept" }, 0);
  context.capabilities = on;
  acceptParty(context, party.get("c1").social.invitations[0]);
  expect(party.get("c0").social.party.members).toEqual(["c0", "c1"]);
  party.get("c2").settings.gameOptions.allowPartySearch = true;
  run(party, "c2", "search.register", {
    minLevel: 1,
    maxLevel: 200,
    capabilities: on,
  });
  expect(party.get("c2").social.search).toBeTruthy();
});
