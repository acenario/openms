import {
  readMigrations,
  applyMigrations,
} from "../../tools/database-migrations.js";
import { migrateDatabase } from "../../tools/migrate.js";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/database.js";
import { loadContent } from "../src/content.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { nearestSavedArrival } from "../../client/src/world/field-arrival.js";
import { protocolError } from "../../shared/protocol.js";
import { grantItem } from "../../client/src/items/inventory-model.js";
import { createMarketOrder } from "../src/market-orders.js";
import {
  marketSearch,
  dueMarketListings,
  deferMarketListing,
} from "../src/database-market.js";
import { advanceMarketSchedule } from "../src/market-schedule.js";
import { mutateMarket } from "../src/interaction-market.js";
import { rotateDefaultAccountPasswords } from "../src/production-accounts.js";
import { bootstrapDevelopmentAccounts } from "../tools/development-accounts.js";

const databaseUrl = process.env.OPENMS_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "PostgreSQL production default-password rotation preserves custom accounts and development restores defaults",
  async () => {
    await withDatabase(proveDefaultPasswordRotation);
  },
  30000,
);

async function proveDefaultPasswordRotation(database, content) {
  expect(await rotateDefaultAccountPasswords(database)).toEqual([]);
  expect(await database.accountByName("admin")).toBeNull();
  expect(await database.accountByName("player")).toBeNull();
  await bootstrapDevelopmentAccounts(database, content, {});
  const passwordHash = await Bun.password.hash("password");
  const unrelated = await database.createAccount({
    name: "other",
    passwordHash,
    role: "player",
  });
  const before = await defaultAccountState(database);
  const rotations = await Promise.all([
    rotateDefaultAccountPasswords(database),
    rotateDefaultAccountPasswords(database),
  ]);
  expect(rotations.flat().sort()).toEqual(["admin", "player"]);
  const rotated = await defaultAccountState(database);
  for (const entry of rotated) {
    expect(
      await Bun.password.verify("password", entry.account.passwordHash),
    ).toBe(false);
    expect(entry.account.passwordHash.startsWith("$argon2id$")).toBe(true);
  }
  expect(await rotateDefaultAccountPasswords(database)).toEqual([]);
  expect(await defaultAccountState(database)).toEqual(rotated);
  const custom = await Bun.password.hash("custom-admin-password");
  await database.sql`UPDATE account SET password_hash=${custom} WHERE name='admin'`;
  await database.sql`UPDATE account SET password_hash=${passwordHash} WHERE name='player'`;
  expect(await rotateDefaultAccountPasswords(database)).toEqual(["player"]);
  expect((await database.accountByName("admin")).passwordHash).toBe(custom);
  expect(await database.accountByName("other")).toEqual(unrelated);
  await bootstrapDevelopmentAccounts(database, content, {});
  const restored = await defaultAccountState(database);
  for (const [index, entry] of restored.entries()) {
    expect(
      await Bun.password.verify("password", entry.account.passwordHash),
    ).toBe(true);
    expect({ ...entry.account, passwordHash: null }).toEqual({
      ...before[index].account,
      passwordHash: null,
    });
    expect(entry.characters).toEqual(before[index].characters);
  }
}

async function defaultAccountState(database) {
  const result = [];
  for (const name of ["admin", "player"]) {
    const account = await database.accountByName(name);
    result.push({
      account,
      characters: await database.listCharacters(account.id),
    });
  }
  return result;
}

/** Separate database; never reset or mutate the supplied administrative database. */
async function withDatabase(run) {
  const name = `openms_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(databaseUrl, { max: 1 });
  let database = null;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    await migrateDatabase({ databaseUrl: url.href });
    const content = await loadContent();
    database = await openDatabase({ url: url.href, items: content.items });
    await run(database, content);
  } finally {
    if (database) await database.close();
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
}

async function characterFixture(database, content, label = "Database1") {
  const account = await database.createAccount({
    name: `database_proof_${label}`,
    passwordHash: await Bun.password.hash(randomUUID()),
    role: "player",
  });
  const manifest = await content.map(content.catalog.defaultMap);
  const arrival = nearestSavedArrival(manifest, { x: 0, y: 0, facing: 1 });
  const profile = createProfile({
    mapId: manifest.id,
    x: arrival.x,
    y: arrival.y,
    facing: 1,
  });
  profile.name = label;
  const created = await database.createCharacter(account.id, profile);
  const actor = await database.acquireLease(account.id, created.id);
  await database.bindField(actor, {
    instanceId: "database-proof",
    fieldEpoch: "proof-field",
    mapId: Number(manifest.id),
  });
  return { actor, profile };
}

function operation(actor) {
  return {
    operationId: randomUUID(),
    digest: createHash("sha256").update("database-proof-credit").digest("hex"),
    expectedRevision: actor.inventoryRevision,
    domain: "inventory",
    kind: "proof.credit",
    fieldEpoch: "proof-field",
  };
}

async function provePersistence(database, content) {
  const { actor, profile } = await characterFixture(database, content);
  const credit = operation(actor);
  const receipt = await database.commit(actor, credit, (draft) => {
    draft.meso += 25;
  });
  expect(receipt.status).toBe("committed");
  expect(await database.receipt(actor, credit)).toEqual(receipt);
  const replay = await database.commit(actor, credit, () => {
    throw new Error("Committed mutation ran twice");
  });
  expect(replay.transactionId).toBe(receipt.transactionId);
  const conflict = await database.commit(
    actor,
    { ...credit, digest: "a".repeat(64) },
    () => {
      throw new Error("Conflicting mutation ran");
    },
  );
  expect(conflict.code).toBe("OPERATION_CONFLICT");
  const rejected = await database.commit(actor, operation(actor), (draft) => {
    draft.meso += 999;
    throw protocolError("NOT_ALLOWED");
  });
  expect(rejected.status).toBe("rejected");
  const loaded = await database.loadCharacter(actor.accountId, actor.id);
  expect(loaded.profile.meso).toBe(25);
  expect(new Set(loaded.profile.equipment)).toEqual(new Set(profile.equipment));
  const stale = { ...actor };
  await database.rotateLease(actor);
  await expect(
    database.commit(stale, operation(stale), (draft) => {
      draft.meso++;
    }),
  ).rejects.toMatchObject({ code: "STALE_CONNECTION" });
}

test.skipIf(!databaseUrl)(
  "native PostgreSQL preserves owned JSON, atomic receipts and writer fences",
  async () => {
    await withDatabase(provePersistence);
  },
  30000,
);

async function proveMarketSearch(database, content) {
  const { actor } = await characterFixture(database, content);
  actor.realm = "public";
  const request = {
    kind: "mts.list",
    quantity: 4,
    price: 100,
    hours: 24,
    mode: "sale",
    buyNow: 0,
  };
  const context = {
    actor,
    content,
    now: Date.now(),
    operationId: randomUUID(),
  };
  const receipt = await database.commit(actor, operation(actor), (draft) => {
    grantItem(draft, content.items[2000000], 10);
    request.uid = draft.inventory.find((item) => item.id === 2000000).uid;
    createMarketOrder(draft, request, context);
  });
  expect(receipt.status).toBe("committed");
  const query = {
    tab: "sale",
    query: "",
    page: 0,
    now: context.now,
    itemIds: [],
  };
  await proveMarketFilters(database, actor, query);
  const restored = await database.loadCharacter(actor.accountId, actor.id);
  expect(restored.profile.onlineState.market.escrow[0].item.count).toBe(4);
  expect(
    restored.profile.inventory.find((item) => item.id === 2000000).count,
  ).toBe(6);
}

async function proveMarketFilters(database, actor, query) {
  const rows = await marketSearch(database, actor, query);
  expect(rows).toHaveLength(1);
  expect(rows[0].item.count).toBe(4);
  expect(
    await marketSearch(database, actor, { ...query, category: 1 }),
  ).toHaveLength(0);
  expect(
    await marketSearch(database, actor, { ...query, category: 2 }),
  ).toHaveLength(1);
  expect(
    await marketSearch(database, actor, {
      ...query,
      query: "red",
      itemIds: [2000000],
    }),
  ).toHaveLength(1);
  expect(
    await marketSearch(database, actor, { ...query, query: "missing" }),
  ).toHaveLength(0);
  expect(
    await marketSearch(database, actor, { ...query, tab: "cart" }),
  ).toHaveLength(0);
  actor.profile.onlineState.market.cart = [rows[0].summary.id];
  expect(
    await marketSearch(database, actor, { ...query, tab: "cart" }),
  ).toHaveLength(1);
}

async function marketRaceFixture(database, content) {
  const actors = [];
  for (const name of ["Seller", "Buyer", "BuyerTwo"]) {
    const { actor } = await characterFixture(database, content, name);
    actor.realm = "public";
    await database.commit(actor, operation(actor), (draft) => {
      draft.cash.balances.prepaid = 10000;
      if (name === "Seller") grantItem(draft, content.items[2000000], 4);
    });
    actors.push(actor);
  }
  const seller = actors[0];
  const request = {
    kind: "mts.list",
    uid: seller.profile.inventory[0].uid,
    quantity: 4,
    price: 100,
    hours: 24,
    mode: "sale",
    buyNow: 0,
  };
  await database.commit(seller, operation(seller), (draft) =>
    createMarketOrder(draft, request, {
      actor: seller,
      content,
      now: Date.now(),
      operationId: randomUUID(),
    }),
  );
  return actors;
}

async function proveMarketRace(database, content) {
  const [seller, buyer, second] = await marketRaceFixture(database, content);
  const staleSeller = { ...seller, profile: structuredClone(seller.profile) };
  const listing = {
    ...seller.profile.onlineState.market.listings[0],
    ownerId: seller.id,
  };
  const request = { kind: "mts.buy", listingId: listing.id, price: 100 };
  const context = { content, request, now: Date.now(), ownerId: seller.id };
  const purchase = operation(buyer);
  const receipt = await database.commitMany(
    [buyer, seller],
    purchase,
    ([b, s]) =>
      mutateMarket(
        new Map([
          [buyer.id, b],
          [seller.id, s],
        ]),
        { ...context, actor: buyer },
        listing,
      ),
  );
  expect(receipt.status).toBe("committed");
  const duplicate = await database.commitMany(
    [second, staleSeller],
    operation(second),
    ([b, s]) =>
      mutateMarket(
        new Map([
          [second.id, b],
          [seller.id, s],
        ]),
        { ...context, actor: second },
        listing,
      ),
  );
  expect(duplicate).toMatchObject({ status: "rejected", code: "NOT_FOUND" });
  const replay = await database.commitMany([buyer, seller], purchase, () => {
    throw new Error("Replayed purchase mutator executed");
  });
  expect(replay.transactionId).toBe(receipt.transactionId);
  await database.checkpoint(staleSeller);
  const loaded = await database.loadCharacter(seller.accountId, seller.id);
  expect(loaded.profile.onlineState.market.listings).toEqual([]);
  expect(loaded.profile.cash.balances.prepaid).toBe(10095);
  expect(
    (await database.loadCharacter(second.accountId, second.id)).profile.cash
      .balances.prepaid,
  ).toBe(10000);
  await database.releaseLease(buyer);
  await expect(
    database.deleteCharacter(buyer.accountId, buyer.id),
  ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
}

test.skipIf(!databaseUrl)(
  "native PostgreSQL MTS stale owner snapshots and replay cannot duplicate a sold lot",
  async () => {
    await withDatabase(proveMarketRace);
  },
  30000,
);

async function proveQuestCycleIdentity(database, content) {
  const { actor } = await characterFixture(database, content);
  await database.commit(actor, operation(actor), (draft) => {
    draft.quests[3458] = { state: 1, kills: {} };
    draft.onlineState ??= { effects: [], cooldowns: {} };
    draft.onlineState.questLifecycle = {
      3458: { cycle: "first", deadline: 1, completedAt: null, repeatAt: null },
    };
  });
  const first = actor.profile.onlineState.questCycles[3458];
  await database.commit(actor, operation(actor), (draft) => {
    draft.onlineState.questLifecycle[3458] = {
      cycle: "second",
      deadline: Date.now() + 1800000,
      completedAt: null,
      repeatAt: null,
    };
  });
  expect(actor.profile.onlineState.questCycles[3458]).not.toBe(first);
  expect(actor.profile.quests[3458].kills).toEqual({});
}

test.skipIf(!databaseUrl)(
  "native PostgreSQL quest reacceptance after timeout stamps a new kill cycle before expiry publication",
  async () => {
    await withDatabase(proveQuestCycleIdentity);
  },
  30000,
);

test.skipIf(!databaseUrl)(
  "native PostgreSQL MTS indexes canonical escrow and handles empty and populated filters",
  async () => {
    await withDatabase(proveMarketSearch);
  },
  30000,
);

/** Soft deletion keeps append-only history valid, frees the name and refuses later play. */
async function proveDeletion(database, content) {
  const account = await database.createAccount({
    name: "delete_proof",
    passwordHash: await Bun.password.hash(randomUUID()),
    role: "player",
  });
  const manifest = await content.map(content.catalog.defaultMap);
  const arrival = nearestSavedArrival(manifest, { x: 0, y: 0, facing: 1 });
  const profile = createProfile({
    mapId: manifest.id,
    x: arrival.x,
    y: arrival.y,
    facing: 1,
  });
  profile.name = "Deleted1";
  const created = await database.createCharacter(account.id, profile);
  expect(
    (await database.listCharacters(account.id)).map((row) => row.id),
  ).toEqual([created.id]);

  // A live lease is refused rather than stolen from its owner.
  const actor = await database.acquireLease(account.id, created.id);
  await expect(
    database.deleteCharacter(account.id, created.id),
  ).rejects.toMatchObject({ code: "CHARACTER_BUSY" });
  await database.releaseLease(actor);

  await database.deleteCharacter(account.id, created.id);
  expect(await database.listCharacters(account.id)).toEqual([]);
  // The deleted character's name is free again and its lease can never be taken.
  const replacement = createProfile({
    mapId: manifest.id,
    x: arrival.x,
    y: arrival.y,
    facing: 1,
  });
  replacement.name = "Deleted1";
  const recreated = await database.createAccountCharacter(
    account.id,
    replacement,
    () => {},
  );
  expect(recreated.name).toBe("Deleted1");
  await expect(
    database.acquireLease(account.id, created.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await database.loadCharacter(account.id, created.id)).toBeNull();

  // Deletion is account-scoped, and append-only history survives with valid references.
  const stranger = await database.createAccount({
    name: "delete_stranger",
    passwordHash: await Bun.password.hash(randomUUID()),
    role: "player",
  });
  await expect(
    database.deleteCharacter(stranger.id, recreated.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const history =
    await database.sql`SELECT count(*)::int AS entries FROM character_op_log WHERE character_id=${created.id}`;
  expect(history[0].entries).toBeGreaterThan(0);
  const receipts =
    await database.sql`SELECT count(*)::int AS entries FROM operation_receipt WHERE character_id=${created.id}`;
  expect(receipts[0].entries).toBe(0);
}

test.skipIf(!databaseUrl)(
  "native PostgreSQL soft deletion frees the name and refuses deleted characters",
  async () => {
    await withDatabase(proveDeletion);
  },
  30000,
);

async function proveGlobalNames(database, content) {
  const left = await characterFixture(database, content, "NameOwner");
  const right = await characterFixture(database, content, "NameOther");
  const profile = createProfile(left.profile.location);
  profile.name = "nameowner";
  await expect(
    database.createAccountCharacter(right.actor.accountId, profile, () => {}),
  ).rejects.toMatchObject({ code: "NAME_TAKEN" });
  const candidates = ["RaceName", "racename"].map((name) => {
    const next = createProfile(left.profile.location);
    next.name = name;
    return next;
  });
  const results = await Promise.allSettled([
    database.createAccountCharacter(
      left.actor.accountId,
      candidates[0],
      () => {},
    ),
    database.createAccountCharacter(
      right.actor.accountId,
      candidates[1],
      () => {},
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results.find((result) => result.status === "rejected").reason.code,
  ).toBe("NAME_TAKEN");
  await database.releaseLease(left.actor);
  await database.deleteCharacter(left.actor.accountId, left.actor.id);
  expect(
    (
      await database.createAccountCharacter(
        right.actor.accountId,
        profile,
        () => {},
      )
    ).name,
  ).toBe("nameowner");
}

test.skipIf(!databaseUrl)(
  "PostgreSQL enforces global names across accounts, casing, races and soft deletion",
  async () => {
    await withDatabase(proveGlobalNames);
  },
  30000,
);

async function proveCheckpointHistory(database, content) {
  const { actor } = await characterFixture(database, content);
  actor.profile.location.x++;
  await database.checkpoint(actor);
  const before =
    await database.sql`SELECT updated_at FROM character WHERE id=${actor.id}`;
  await database.checkpoint(actor);
  const after =
    await database.sql`SELECT updated_at FROM character WHERE id=${actor.id}`;
  expect(after[0].updated_at).toEqual(before[0].updated_at);
  for (let index = 0; index < 5; index++) {
    actor.profile.location.x++;
    await database.checkpoint(actor);
  }
  const count =
    await database.sql`SELECT count(*)::int AS n FROM character_snapshot WHERE character_id=${actor.id}`;
  expect(count[0].n).toBe(1);
  const restored = await database.loadCharacter(actor.accountId, actor.id);
  expect(restored.profile.location.x).toBe(actor.profile.location.x);
  await database.sql`INSERT INTO character_snapshot(character_id,fencing_generation,profile,created_at)
    SELECT ${actor.id},${actor.fence},profile,clock_timestamp()-interval '2 hours' FROM character,generate_series(1,200) WHERE id=${actor.id}`;
  await database.checkpoint(actor);
  const firstPrune =
    await database.sql`SELECT count(*)::int AS n FROM character_snapshot WHERE character_id=${actor.id}`;
  expect(firstPrune[0].n).toBe(73);
  await database.checkpoint(actor);
  const secondPrune =
    await database.sql`SELECT count(*)::int AS n FROM character_snapshot WHERE character_id=${actor.id}`;
  expect(secondPrune[0].n).toBe(60);
  await applyMigrations(database.sql, await readMigrations());
  actor.profile.location.x++;
  await database.checkpoint(actor);
  const remigrated =
    await database.sql`SELECT count(*)::int AS n FROM character_snapshot WHERE character_id=${actor.id}`;
  expect(remigrated[0].n).toBe(60);
  await database.releaseLease(actor);
  await expect(database.checkpoint(actor)).rejects.toMatchObject({
    code: "STALE_CONNECTION",
  });
}

test.skipIf(!databaseUrl)(
  "PostgreSQL checkpoints skip unchanged writes, sample history and prune bounded batches after restart",
  async () => {
    await withDatabase(proveCheckpointHistory);
  },
  30000,
);

/** Fail the next `count` transactions the way PostgreSQL cancels an SSI pivot (40001). */
function injectSerializationFailures(database, count) {
  const begin = database.sql.begin.bind(database.sql);
  let remaining = count;
  database.sql.begin = (options, work) =>
    begin(options, async (tx) => {
      const result = await work(tx);
      if (remaining-- > 0) {
        throw Object.assign(new Error("could not serialize access"), {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "40001",
        });
      }
      return result;
    });
  return () => {
    database.sql.begin = begin;
  };
}

async function proveReconnectCheckpointContention(database, content) {
  const { actor } = await characterFixture(database, content, "Successor");
  await database.checkpoint(actor);
  await database.releaseLease(actor);
  const successor = await database.acquireLease(actor.accountId, actor.id);
  expect(successor.fence).toBe(actor.fence + 1);
  successor.profile.hp -= 7;
  successor.profile.location.x += 13;
  // The live dev log showed three consecutive pivot cancellations of one checkpoint.
  const restore = injectSerializationFailures(database, 3);
  try {
    await database.checkpoint(successor);
  } finally {
    restore();
  }
  const durable = await database.loadCharacter(actor.accountId, actor.id);
  expect(durable.profile.hp).toBe(successor.profile.hp);
  expect(durable.profile.location.x).toBe(successor.profile.location.x);
  const exhaust = injectSerializationFailures(database, Infinity);
  try {
    await expect(database.checkpoint(successor)).rejects.toMatchObject({
      code: "SERVER_BUSY",
      cause: { errno: "40001" },
    });
  } finally {
    exhaust();
  }
}

test.skipIf(!databaseUrl)(
  "PostgreSQL retries a reconnected successor's checkpoint through repeated serialization pivots",
  async () => {
    await withDatabase(proveReconnectCheckpointContention);
  },
  30000,
);

async function proveLedgerIndex(database) {
  await database.sql`INSERT INTO ledger(transaction_id,account_key,asset,delta,reason)
    SELECT 'index-proof-'||n,'owner','meso',d,'test' FROM generate_series(1,10000) n CROSS JOIN (VALUES(1),(-1)) sides(d)`;
  await database.sql`ANALYZE ledger`;
  const plan =
    await database.sql`EXPLAIN (FORMAT JSON) SELECT asset FROM ledger WHERE transaction_id='index-proof-9999' GROUP BY asset HAVING sum(delta)<>0`;
  expect(JSON.stringify(plan)).toContain("ledger_transaction_asset");
  await expect(
    Promise.resolve(
      database.sql`INSERT INTO ledger(transaction_id,account_key,asset,delta,reason) VALUES('unbalanced','owner','meso',1,'test')`,
    ),
  ).rejects.toMatchObject({ errno: "23514" });
  await expect(
    Promise.resolve(
      database.sql`DELETE FROM ledger WHERE transaction_id='index-proof-1'`,
    ),
  ).rejects.toThrow("append-only");
}

test.skipIf(!databaseUrl)(
  "PostgreSQL ledger balance lookup uses its transaction index while retaining immutable balanced history",
  async () => {
    await withDatabase(proveLedgerIndex);
  },
  30000,
);

async function seedDueLots(database, owner) {
  for (let index = 0; index < 9; index++) {
    const summary = {
      id: `expiry-${index}`,
      bid: 0,
      bidderId: "",
      realm: "public",
      expiresAt: 1000,
    };
    await database.sql`INSERT INTO market_listing(id,owner_id,kind,item_id,price,expires_at,realm,summary)
      VALUES(${summary.id},${owner},'sale',2000000,1,1000,'public',${summary})`;
  }
}

async function proveExpiryFairness(database, content) {
  const { actor } = await characterFixture(database, content);
  await seedDueLots(database, actor.id);
  Object.assign(actor, {
    state: "active",
    realm: "public",
    field: { epoch: "expiry-field" },
  });
  const world = {
    database,
    actors: new Map([[actor.id, actor]]),
    now: 2000,
    publish() {},
    log() {},
  };
  const attempted = [];
  world.participants = {
    async commitProduced(_actor, _operation, resolve) {
      attempted.push(resolve());
      return { status: "rejected", code: "REQUIREMENTS_NOT_MET" };
    },
  };
  advanceMarketSchedule(world);
  await world.marketTask;
  expect(attempted).toHaveLength(8);
  expect(
    (await dueMarketListings(database, 7000)).map((row) => row.summary.id),
  ).toEqual(["expiry-8"]);
  world.now = 7000;
  advanceMarketSchedule(world);
  await world.marketTask;
  expect(attempted).toHaveLength(9);
  expect(await dueMarketListings(database, 7000)).toHaveLength(0);
  expect(await dueMarketListings(database, 12000)).toHaveLength(8);
  const row = (await dueMarketListings(database, 12000))[0];
  await deferMarketListing(database, row, 12000);
  const retried =
    await database.sql`SELECT retry_at,retry_count FROM market_listing WHERE id=${row.summary.id}`;
  expect(Number(retried[0].retry_at)).toBe(32000);
  expect(retried[0].retry_count).toBe(2);
}

test.skipIf(!databaseUrl)(
  "PostgreSQL expiry backoff advances past eight blocked listings and remains restart-safe",
  async () => {
    await withDatabase(proveExpiryFairness);
  },
  30000,
);

/** A pooled client can already have executed a statement when a transaction
 *  begins, so SERIALIZABLE must be part of BEGIN rather than a later
 *  `SET TRANSACTION ISOLATION LEVEL`, which PostgreSQL rejects with 25001. */
async function proveSerializableTransactionsUnderPoolContention(database) {
  const workers = 24;
  const steps = 20;
  const levels = new Set();
  const failures = [];
  const run = async (index) => {
    try {
      if (index % 2 === 0) {
        await database.transaction(async (tx) => {
          const [row] =
            await tx`SELECT current_setting('transaction_isolation') AS iso`;
          levels.add(row.iso);
          await tx`SELECT 1`;
        });
      } else {
        // A plain pooled parameterized read, like the delivery path's directory lookups.
        await database.searchParticipants({ limit: 1 });
      }
    } catch (error) {
      failures.push(error.message);
    }
  };
  await Promise.all(
    Array.from({ length: workers }, (_, worker) =>
      (async () => {
        for (let step = 0; step < steps; step++) {
          await run(worker * steps + step);
        }
      })(),
    ),
  );
  expect(failures.filter((message) => /ISOLATION LEVEL/.test(message))).toEqual(
    [],
  );
  expect(levels).toEqual(new Set(["serializable"]));
}

test.skipIf(!databaseUrl)(
  "PostgreSQL begins SERIALIZABLE with the transaction under pool contention",
  async () => {
    await withDatabase(proveSerializableTransactionsUnderPoolContention);
  },
  30000,
);
