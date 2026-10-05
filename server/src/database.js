import { MAX_TRANSACTION_PARTICIPANTS } from "./online-limits.js";
import { validateMarket } from "./market-state.js";
import { persistMarket, marketHasProperty } from "./database-market.js";
import { SQL } from "bun";
import { assertDatabaseSchema } from "./database-schema.js";
import { DEVELOPMENT_JSON } from "../../shared/development.js";
import {
  PROFILE_LIMITS,
  validateProfile,
  validateCharacterUids,
} from "../../client/src/profile/profile-validation.js";
import { createCash } from "../../client/src/profile/profile-domains.js";
import {
  createAccountStorage,
  validateAccountStorage,
} from "../../client/src/profile/account-storage.js";
import {
  hasSocialLinks,
  validateSocialCommit,
} from "../../client/src/profile/profile-social-transaction.js";
import { CASH_CURRENCIES } from "../../client/src/items/cash-commerce.js";
import {
  cacheProfile,
  flatten,
  flattenStorage,
  hydrateProfileItems,
  itemDeltas,
  MAX_ITEMS,
} from "./database-items.js";
import {
  admitCharacterSlot,
  MAX_ACCOUNT_CHARACTERS,
} from "./character-creation.js";
import { characterSummary } from "./character-summary.js";
import { persistCheckpoint } from "./database-checkpoint.js";
import {
  persistItemHistory,
  readItemHistory,
  readHistoryQuery,
} from "./database-history.js";

// Every actor checkpoints at 1 Hz in SERIALIZABLE, so same-tick checkpoints and commits
// can cancel one transaction as an SSI pivot several times in a row (three were observed
// live). Jittered exponential backoff desynchronizes the retries; worst case ~310 ms.
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 10;
const MAX_EVENTS = 256;
const LEASE_SECONDS = 45;

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), {
    code,
  });
}
function id() {
  return crypto.randomUUID();
}
function numeric(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw failure("SERVER_BUSY");
  return result;
}
function revision(actor, domain, hint = 0) {
  if (domain === "inventory") return actor.inventoryRevision;
  if (domain === "social") return actor.socialRevision;
  if (domain === "character") return actor.revision;
  if (!Number.isSafeInteger(hint) || hint < 0) throw failure("NOT_ALLOWED");
  return hint;
}
function rejected(code, domainRevision = 0) {
  return { status: "rejected", code, domainRevision, transactionId: null };
}

function validateCommitActors(actors) {
  if (
    !Array.isArray(actors) ||
    actors.length < 1 ||
    actors.length > MAX_TRANSACTION_PARTICIPANTS ||
    actors[0].passive ||
    new Set(actors.map((actor) => actor.id)).size !== actors.length
  ) {
    throw failure("NOT_ALLOWED");
  }
}

function validateParticipantFilters(name, mapId) {
  if (
    name !== null &&
    (typeof name !== "string" || !name.length || name.length > 32)
  ) {
    throw failure("NOT_ALLOWED");
  }
  if (mapId !== null && !/^\d{1,9}$/.test(String(mapId))) {
    throw failure("NOT_ALLOWED");
  }
}
function actorFromRow(row, profile) {
  return {
    id: row.id,
    accountId: row.account_id,
    profile,
    fence: numeric(row.fencing_generation),
    revision: numeric(row.revision),
    inventoryRevision: numeric(row.inventory_revision),
    socialRevision: numeric(row.social_revision),
  };
}

/** Kill counters belong only to a matching active quest lifecycle. */
function matchingQuestCycle(target, source, questId) {
  return (
    target.quests[questId]?.state === 1 &&
    source.quests[questId].state === 1 &&
    target.onlineState?.questCycles?.[questId] ===
      source.onlineState?.questCycles?.[questId]
  );
}

function mergeKillCounts(durable, kills) {
  for (const [mobId, count] of kills) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 4294967295) {
      throw failure("NOT_ALLOWED");
    }
    durable.kills[mobId] = Math.max(durable.kills[mobId] ?? 0, count);
  }
}

/** Merge server-observed kill counters, never quest lifecycle or reward authority. */
function mergeQuestKills(target, source) {
  const records = Object.entries(source.quests);
  if (records.length > PROFILE_LIMITS.quests) throw failure("NOT_ALLOWED");
  let total = 0;
  for (const [questId, progress] of records) {
    if (!matchingQuestCycle(target, source, questId)) continue;
    const kills = Object.entries(progress.kills);
    total += kills.length;
    if (
      kills.length > PROFILE_LIMITS.kills ||
      total > PROFILE_LIMITS.totalKills
    ) {
      throw failure("NOT_ALLOWED");
    }
    mergeKillCounts(target.quests[questId], kills);
  }
}

/** A new active lifecycle gets a transaction-stable identity, preventing stale kill carryover. */
function stampQuestCycles(before, after, transactionId) {
  const entries = Object.entries(after.quests);
  if (entries.length > PROFILE_LIMITS.quests) throw failure("NOT_ALLOWED");
  const cycles = {};
  for (const [questId, quest] of entries) {
    if (quest.state !== 1) continue;
    const prior = before.onlineState?.questCycles?.[questId];
    if (sameQuestRun(before, after, questId)) {
      if (prior !== undefined) cycles[questId] = prior;
    } else cycles[questId] = transactionId;
  }
  after.onlineState ??= { effects: [], cooldowns: {} };
  after.onlineState.questCycles = cycles;
  pruneQuestNotices(after.onlineState, cycles);
}

function sameQuestRun(before, after, id) {
  return (
    before.quests[id]?.state === 1 &&
    before.onlineState?.questLifecycle?.[id]?.cycle ===
      after.onlineState?.questLifecycle?.[id]?.cycle
  );
}

function pruneQuestNotices(state, cycles) {
  if (!state.questNotices) return;
  for (const id of Object.keys(state.questNotices)) {
    if (state.questNotices[id] !== cycles[id]) delete state.questNotices[id];
  }
}
function mergeTimedProfile(draft, live) {
  if (draft.mount && live.mount) draft.mount.tiredness = live.mount.tiredness;
  for (const pet of draft.pets) {
    const current = live.pets.find((entry) => entry.uid === pet.uid);
    if (!current) continue;
    pet.fullness = current.fullness;
    pet.summonedSlot = current.summonedSlot;
  }
}

function mutationDraft(durable, live) {
  const draft = structuredClone(durable);
  // Only continuous, lease-owned state crosses the checkpoint boundary.
  for (const key of ["hp", "mp", "maxHP", "maxMP"]) draft[key] = live[key];
  mergeTimedProfile(draft, live);
  draft.location = structuredClone(live.location);
  draft.onlineState = structuredClone(
    live.onlineState ?? { effects: [], cooldowns: {} },
  );
  for (const key of ["questCycles", "questLifecycle", "market"]) {
    if (durable.onlineState?.[key]) {
      draft.onlineState[key] = structuredClone(durable.onlineState[key]);
    } else delete draft.onlineState[key];
  }
  mergeQuestKills(draft, live);
  return draft;
}

function assertSessions(owners, serverProduced = false) {
  // A server-owned earned outcome may finish after logout; lease/fence checks still apply.
  if (serverProduced) return;
  for (const owner of owners) {
    if (
      owner.session &&
      (owner.session.revoked || owner.session.expiresAt <= Date.now())
    ) {
      throw failure("SESSION_EXPIRED");
    }
  }
}

/** Memoize the mutation and its RNG outcomes across SERIALIZABLE retries. */
async function planMutation(request, states) {
  const { owners, mutator, memo } = request;
  const baseline = JSON.stringify({ states, storage: request.storage });
  if (memo.plan && memo.plan.baseline !== baseline) {
    throw failure("SERVER_BUSY");
  }
  if (memo.plan) return;
  const drafts = states.map((state, index) =>
    mutationDraft(state.profile, owners[index].profile),
  );
  const storage = request.storage ? structuredClone(request.storage) : null;
  let result;
  try {
    result = (await mutator(drafts, storage)) ?? {};
  } catch (error) {
    if (!/^[A-Z_]+$/.test(error.code ?? "") || error.code === "SERVER_BUSY") {
      throw error;
    }
    result = { code: error.code };
  }
  memo.plan = { baseline, drafts, storage, result, transactionId: id() };
}

/** PostgreSQL is the only storage authority; profile JSON excludes all owned items and money. */
export async function openDatabase({ url, items }) {
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error("PostgreSQL DATABASE_URL required");
  }
  const database = new Database(
    new SQL(url, { max: 8, connectionTimeout: 10, idleTimeout: 30 }),
    items,
  );
  try {
    await assertDatabaseSchema(database.sql);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export class Database {
  constructor(sql, items) {
    this.sql = sql;
    this.items = items;
    this.owner = id();
  }
  async close() {
    await this.sql.close();
  }
  async readOutbox({ consumer, limit = 128 }) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(consumer) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_EVENTS
    ) {
      throw failure("NOT_ALLOWED");
    }
    return this
      .sql`SELECT * FROM outbox WHERE seq>COALESCE((SELECT seq FROM outbox_delivery WHERE consumer=${consumer}),0) ORDER BY seq LIMIT ${limit}`;
  }
  async acknowledgeOutbox({ consumer, sequence }) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(consumer) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      throw failure("NOT_ALLOWED");
    }
    await this
      .sql`INSERT INTO outbox_delivery(consumer,seq) VALUES(${consumer},${sequence}) ON CONFLICT(consumer) DO UPDATE SET seq=GREATEST(outbox_delivery.seq,EXCLUDED.seq)`;
  }
  async receipt(actor, operation) {
    const rows = await this
      .sql`SELECT r.digest,r.receipt FROM operation_receipt r JOIN character c ON c.id=r.character_id WHERE r.character_id=${actor.id} AND r.operation_id=${operation.operationId} AND c.account_id=${actor.accountId} AND c.fencing_generation=${actor.fence} AND c.lease_owner=${this.owner} AND c.lease_until>clock_timestamp()`;
    if (!rows[0]) return null;
    return rows[0].digest === operation.digest
      ? rows[0].receipt
      : rejected(
          "OPERATION_CONFLICT",
          revision(actor, operation.domain, operation.domainRevision),
        );
  }
  async auditDevelopment(entry) {
    if (
      new TextEncoder().encode(JSON.stringify(entry.action)).length >
        DEVELOPMENT_JSON.maxBytes ||
      !["requested", "committed", "rejected"].includes(entry.status)
    ) {
      throw failure("NOT_ALLOWED");
    }
    await this
      .sql`INSERT INTO development_audit(account_id,character_id,operation_id,action,status,code) VALUES(${entry.accountId},${entry.characterId},${entry.operationId},${entry.action},${entry.status},${entry.code})`;
  }
  async bindField(actor, membership) {
    const rows = await this
      .sql`UPDATE character SET field_instance=${membership.instanceId},field_epoch=${membership.fieldEpoch},map_id=${membership.mapId} WHERE id=${actor.id} AND fencing_generation=${actor.fence} AND lease_owner=${this.owner} AND lease_until>clock_timestamp() RETURNING id`;
    if (!rows.length) throw failure("STALE_CONNECTION");
  }
  validate(profile) {
    validateMarket(profile, this.items);
    const copy = structuredClone(profile);
    delete copy.onlineState;
    validateProfile(copy, this.items);
    validateCharacterUids([profile]);
    if (
      profile.onlineState &&
      JSON.stringify(profile.onlineState).length > 65536
    ) {
      throw failure("NOT_ALLOWED");
    }
    flatten(profile);
  }
  async createAccount({ name, passwordHash, role }) {
    if (
      !/^[A-Za-z0-9_-]{1,32}$/.test(name) ||
      !["player", "developer"].includes(role) ||
      typeof passwordHash !== "string" ||
      passwordHash.length > 1024
    ) {
      throw failure("NOT_ALLOWED");
    }
    const rows = await this
      .sql`INSERT INTO account(id,name,password_hash,role) VALUES(${id()},${name},${passwordHash},${role}) RETURNING id,name,password_hash,role`;
    return { id: rows[0].id, name, passwordHash, role };
  }
  /** Registration creates an account, not an implicit unrolled character.
   * Map loading, spawn validation and item ledgers belong to explicit creation. */
  async registerPlayer(name, passwordHash) {
    if (
      !/^[A-Za-z0-9_-]{3,16}$/.test(name) ||
      typeof passwordHash !== "string" ||
      passwordHash.length > 1024
    ) {
      throw failure("NOT_ALLOWED");
    }
    const accountId = id();
    const rows = await this
      .sql`INSERT INTO account(id,name,password_hash,role) VALUES(${accountId},${name},${passwordHash},'player') ON CONFLICT(name) DO NOTHING RETURNING id`;
    return rows[0]
      ? { id: accountId, name, passwordHash, role: "player" }
      : null;
  }
  async accountByName(name) {
    const rows = await this
      .sql`SELECT id,name,password_hash,role FROM account WHERE name=${name}`;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          name: row.name,
          passwordHash: row.password_hash,
          role: row.role,
        }
      : null;
  }
  async listCharacters(accountId) {
    const rows = await this
      .sql`SELECT c.id,c.profile,(SELECT COALESCE(jsonb_agg(worn.data),'[]'::jsonb) FROM (SELECT data FROM item_instance WHERE owner_id=c.id AND location='equipped' ORDER BY id LIMIT 33) worn) AS equipment FROM character c WHERE c.account_id=${accountId} AND c.deleted_at IS NULL ORDER BY c.id LIMIT 65`;
    if (rows.length > 64) throw failure("SERVER_BUSY");
    return rows.map((row) =>
      characterSummary(row.id, row.profile, row.equipment, this.items),
    );
  }

  /** Soft deletion keeps the append-only history tables' references valid, frees the
   * account's name slot and refuses every later play session. A live lease is refused
   * rather than stolen from its owner. */
  async deleteCharacter(accountId, characterId) {
    return this.transaction(async (tx) => {
      const accounts =
        await tx`SELECT id FROM account WHERE id=${accountId} FOR UPDATE`;
      if (!accounts[0]) throw failure("UNAUTHENTICATED");
      const rows =
        await tx`SELECT id,profile,lease_until>clock_timestamp() AS leased FROM character WHERE id=${characterId} AND account_id=${accountId} AND deleted_at IS NULL FOR UPDATE`;
      if (!rows[0]) throw failure("NOT_FOUND");
      if (rows[0].leased) throw failure("CHARACTER_BUSY");
      // As with an offline reset, mirrored links must be detached through social authority.
      if (hasSocialLinks(rows[0].profile.social)) throw failure("NOT_ALLOWED");
      if (marketHasProperty(rows[0].profile)) throw failure("NOT_ALLOWED");
      const transfers =
        await tx`SELECT id FROM item_instance WHERE owner_id=${characterId} AND location IN ('market','market-transfer') LIMIT 1`;
      if (transfers.length) throw failure("NOT_ALLOWED");
      const bids =
        await tx`SELECT id FROM market_listing WHERE summary->>'bidderId'=${characterId} AND (summary->>'bid')::bigint>0 LIMIT 1`;
      if (bids.length) throw failure("NOT_ALLOWED");
      await tx`UPDATE character SET deleted_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,field_instance=NULL,field_epoch=NULL WHERE id=${characterId}`;
      return { id: characterId };
    });
  }
  async createAccountCharacter(accountId, profile, admit) {
    this.validate(profile);
    const characterId = id();
    return this.transaction(async (tx) => {
      const accounts =
        await tx`SELECT id FROM account WHERE id=${accountId} FOR UPDATE`;
      if (!accounts[0]) throw failure("UNAUTHENTICATED");
      const rows =
        await tx`SELECT profile->>'name' AS name FROM character WHERE account_id=${accountId} AND deleted_at IS NULL ORDER BY id LIMIT ${MAX_ACCOUNT_CHARACTERS + 1}`;
      admitCharacterSlot(
        rows.map((row) => row.name),
        profile.name,
      );
      admit();
      await this.insertCharacter(tx, accountId, profile, characterId);
      return characterSummary(
        characterId,
        profile,
        profile.equipment,
        this.items,
      );
    });
  }
  async createCharacter(accountId, profile) {
    this.validate(profile);
    const characterId = id();
    await this.transaction((tx) =>
      this.insertCharacter(tx, accountId, profile, characterId),
    );
    return this.loadCharacter(accountId, characterId);
  }
  async insertCharacter(tx, accountId, profile, characterId) {
    await tx`INSERT INTO character(id,account_id,profile,meso,map_id) VALUES(${characterId},${accountId},${cacheProfile(profile)},${profile.meso},${Number(profile.location.mapId)})`;
    const empty = { inventory: [], equipment: [], meso: 0, cash: createCash() };
    const entry = {
      characterId,
      transactionId: characterId,
      reason: "bootstrap",
      revision: 0,
    };
    await this.materializeItems(tx, entry, flatten(empty), flatten(profile));
    await this.currencyLedger(tx, { ...entry, delta: profile.meso });
    await this.cashLedger(
      tx,
      entry,
      empty.cash.balances,
      profile.cash.balances,
    );
    await persistMarket(tx, this, entry, { before: empty, after: profile });
    const bootstrapSources = {};
    for (const uid of flatten(profile).keys()) {
      bootstrapSources[uid] = { source: "bootstrap" };
    }
    await persistItemHistory(tx, {
      transactionId: characterId,
      reason: "bootstrap",
      actorId: characterId,
      mapId: Number(profile.location.mapId),
      states: [{ id: characterId, accountId, profile: empty }],
      drafts: [profile],
      storageBefore: null,
      storageAfter: null,
      accountId: null,
      names: new Map([[`character:${characterId}`, profile.name]]),
      result: { itemSources: bootstrapSources },
    });
    await tx`INSERT INTO character_op_log(character_id,operation_id,transaction_id,kind,effect) VALUES(${characterId},${characterId},${characterId},'bootstrap',${{ kind: "bootstrap", profile }})`;
  }
  async hydrate(tx, row) {
    const rows =
      await tx`SELECT data,location,container_id FROM item_instance WHERE owner_id=${row.id} ORDER BY location,container_id,slot,id LIMIT ${MAX_ITEMS + 1}`;
    if (rows.length > MAX_ITEMS) throw failure("SERVER_BUSY");
    const profile = hydrateProfileItems(row.profile, rows, numeric(row.meso));
    this.validate(profile);
    return actorFromRow(row, profile);
  }
  async loadCharacter(accountId, characterId) {
    return this.transaction(async (tx) => {
      const rows =
        await tx`SELECT * FROM character WHERE id=${characterId} AND account_id=${accountId} AND deleted_at IS NULL FOR SHARE`;
      return rows[0] ? this.hydrate(tx, rows[0]) : null;
    });
  }
  async acquireLease(accountId, characterId) {
    return this.transaction(async (tx) => {
      const rows =
        await tx`UPDATE character SET fencing_generation=fencing_generation+1,lease_owner=${this.owner},lease_until=clock_timestamp()+${LEASE_SECONDS}*interval '1 second' WHERE id=${characterId} AND account_id=${accountId} AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`;
      if (!rows[0]) {
        // A deleted or foreign character is not "busy"; name the actual outcome.
        const present =
          await tx`SELECT id FROM character WHERE id=${characterId} AND account_id=${accountId} AND deleted_at IS NULL`;
        throw failure(present[0] ? "CHARACTER_BUSY" : "NOT_FOUND");
      }
      return this.hydrate(tx, rows[0]);
    });
  }
  async renewLease(actor) {
    const rows = await this
      .sql`UPDATE character SET lease_until=clock_timestamp()+${LEASE_SECONDS}*interval '1 second' WHERE id=${actor.id} AND fencing_generation=${actor.fence} AND lease_owner=${this.owner} AND lease_until>clock_timestamp() RETURNING id`;
    if (!rows.length) throw failure("STALE_CONNECTION");
  }
  async rotateLease(actor) {
    const rows = await this
      .sql`UPDATE character SET fencing_generation=fencing_generation+1,lease_until=clock_timestamp()+${LEASE_SECONDS}*interval '1 second' WHERE id=${actor.id} AND fencing_generation=${actor.fence} AND lease_owner=${this.owner} AND lease_until>clock_timestamp() RETURNING fencing_generation`;
    if (!rows.length) throw failure("STALE_CONNECTION");
    actor.fence = numeric(rows[0].fencing_generation);
  }
  async releaseLease(actor) {
    await this
      .sql`UPDATE character SET lease_owner=NULL,lease_until=NULL WHERE id=${actor.id} AND fencing_generation=${actor.fence} AND lease_owner=${this.owner}`;
  }
  async transaction(work) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        // The isolation level belongs to BEGIN itself. A separate
        // `SET TRANSACTION ISOLATION LEVEL` statement is only legal before any
        // query in the transaction, and a pooled client reused mid-flight can
        // already have run one, which made every retry fail with 25001.
        return await this.sql.begin(
          "ISOLATION LEVEL SERIALIZABLE",
          async (tx) => {
            await tx`SET LOCAL lock_timeout='2s'`;
            await tx`SET LOCAL statement_timeout='5s'`;
            await tx`SET LOCAL idle_in_transaction_session_timeout='5s'`;
            return work(tx);
          },
        );
      } catch (error) {
        const code = error.errno ?? error.code;
        if (code === "23505" && error.constraint === "character_active_name") {
          throw failure("NAME_TAKEN");
        }
        if (!["40001", "40P01"].includes(code)) throw error;
        if (attempt === MAX_ATTEMPTS - 1) throw failure("SERVER_BUSY", error);
        await Bun.sleep(Math.random() * RETRY_BASE_MS * 2 ** attempt);
      }
    }
    throw failure("SERVER_BUSY");
  }
  async lockActors(tx, actors) {
    const ordered = actors.toSorted((a, b) => a.id.localeCompare(b.id));
    const locked = new Map();
    for (const actor of ordered) {
      const rows =
        await tx`SELECT *,lease_until>clock_timestamp() AS lease_valid FROM character WHERE id=${actor.id} FOR UPDATE`;
      const row = rows[0];
      if (
        !row ||
        row.deleted_at ||
        row.account_id !== actor.accountId ||
        numeric(row.fencing_generation) !== actor.fence ||
        (actor.passive
          ? row.lease_valid || numeric(row.revision) !== actor.revision
          : row.lease_owner !== this.owner || !row.lease_valid)
      ) {
        throw failure("STALE_CONNECTION");
      }
      locked.set(actor.id, await this.hydrate(tx, row));
    }
    return actors.map((actor) => locked.get(actor.id));
  }
  async checkpoint(actor) {
    const fence = actor.fence;
    const profile = structuredClone(actor.profile);
    this.validate(profile);
    await this.transaction(async (tx) => {
      const [durable] = await this.lockActors(tx, [{ ...actor, fence }]);
      const current = mutationDraft(durable.profile, profile);
      this.validate(current);
      await persistCheckpoint(
        tx,
        this,
        { ...actor, fence },
        { current, durable: durable.profile },
      );
    });
  }
  async commit(actor, operation, mutator) {
    return this.commitMany([actor], operation, (profiles) =>
      mutator(profiles[0]),
    );
  }
  async commitMany(actors, operation, mutator, options = {}) {
    validateCommitActors(actors);
    const owners = actors.map((actor) => ({
      ...actor,
      profile: structuredClone(actor.profile),
    }));
    const memo = { plan: null };
    const request = {
      owners,
      operation,
      mutator,
      memo,
      account: options.account ?? null,
      serverProduced: options.serverProduced === true,
    };
    // A browser may stage a destination, but must never hold SQL locks while doing so.
    let outcome =
      operation.membership || options.prepareOutsideTransaction
        ? await this.prepareCommit(request)
        : null;
    outcome ??= await this.transaction((tx) => this.commitAttempt(tx, request));
    if (outcome.states) {
      for (let index = 0; index < actors.length; index += 1) {
        const state = outcome.states[index];
        mergeQuestKills(state.profile, actors[index].profile);
        actors[index].profile = state.profile;
        actors[index].revision = state.revision;
        actors[index].inventoryRevision = state.inventoryRevision;
        actors[index].socialRevision = state.socialRevision;
      }
    }
    Object.defineProperty(outcome.receipt, "applied", {
      value: Boolean(outcome.states),
    });
    return outcome.receipt;
  }
  async prepareCommit(request) {
    const prepared = await this.transaction(async (tx) => {
      assertSessions(request.owners, request.serverProduced);
      const states = await this.lockActors(tx, request.owners);
      request.storage = request.account
        ? await this.lockStorage(tx, request.owners[0])
        : null;
      const receipt = await this.admitCommit(tx, request, states);
      return { states, receipt };
    });
    if (prepared.receipt) return { receipt: prepared.receipt };
    await planMutation(request, prepared.states);
    assertSessions(request.owners, request.serverProduced);
    return null;
  }
  async operationReceipt(tx, owner, operation) {
    const rows =
      await tx`SELECT digest,receipt FROM operation_receipt WHERE character_id=${owner.id} AND operation_id=${operation.operationId}`;
    if (!rows[0]) return null;
    if (rows[0].digest !== operation.digest) {
      return rejected(
        "OPERATION_CONFLICT",
        revision(owner, operation.domain, operation.domainRevision),
      );
    }
    return rows[0].receipt;
  }
  async commitAttempt(tx, request) {
    const { owners } = request;
    assertSessions(owners, request.serverProduced);
    const states = await this.lockActors(tx, owners);
    request.storage = request.account
      ? await this.lockStorage(tx, owners[0])
      : null;
    const receipt = await this.admitCommit(tx, request, states);
    if (receipt) return { receipt };
    await planMutation(request, states);
    const outcome = await this.persistPlan(tx, request, states);
    assertSessions(owners, request.serverProduced);
    return outcome;
  }
  async admitCommit(tx, request, states) {
    const { owners, operation } = request;
    const prior = await this.operationReceipt(tx, owners[0], operation);
    if (prior) return prior;
    if (operation.fieldEpoch) {
      const membership =
        await tx`SELECT field_epoch FROM character WHERE id=${owners[0].id}`;
      if (
        membership[0].field_epoch &&
        membership[0].field_epoch !== operation.fieldEpoch
      ) {
        throw failure("STALE_FIELD");
      }
    }
    const current = revision(
      states[0],
      operation.domain,
      operation.domainRevision,
    );
    if (
      ["character", "inventory", "social"].includes(operation.domain) &&
      (current !== operation.expectedRevision ||
        (request.account &&
          request.storage.revision !== request.account.expectedRevision))
    ) {
      const receipt = rejected("STALE_REVISION", current);
      await this.storeReceipt(tx, owners[0].id, operation, receipt);
      return receipt;
    }
    return null;
  }
  async persistPlan(tx, request, states) {
    const { owners, operation, memo } = request;
    const { drafts, result, transactionId } = memo.plan;
    if (result.code && result.code !== "OK") {
      const receipt = rejected(
        result.code,
        revision(states[0], operation.domain, operation.domainRevision),
      );
      if (result.value !== undefined) receipt.value = result.value;
      await this.storeReceipt(tx, owners[0].id, operation, receipt);
      return { receipt };
    }
    if ((result.events?.length ?? 0) > MAX_EVENTS) throw failure("SERVER_BUSY");
    for (let index = 0; index < drafts.length; index += 1) {
      stampQuestCycles(states[index].profile, drafts[index], transactionId);
      this.validate(drafts[index]);
    }
    validateCharacterUids(drafts, MAX_TRANSACTION_PARTICIPANTS);
    validateSocialCommit(
      owners.map((owner) => owner.id),
      states.map((state) => state.profile),
      drafts,
    );
    if (memo.plan.storage) {
      memo.plan.storage.revision = numeric(request.storage.revision + 1);
      this.validateStorage(memo.plan.storage, drafts[0], owners[0].accountId);
      await this.removeChangedItems(
        tx,
        { accountId: owners[0].accountId },
        flattenStorage(request.storage),
        flattenStorage(memo.plan.storage),
      );
    }
    await this.socialNames(tx, result.socialNames);
    await this.entitlements(tx, transactionId, result);
    // Provenance reads the durable drafts before persistMutation installs the new profile.
    await this.recordItemHistory(tx, request, states);
    // Remove every changed owner row before inserting any transfer destination.
    for (let index = 0; index < states.length; index += 1) {
      await this.removeChangedItems(
        tx,
        { characterId: states[index].id },
        flatten(states[index].profile),
        flatten(drafts[index]),
      );
    }
    for (let index = 0; index < states.length; index += 1) {
      await this.persistMutation(tx, request, states[index], index);
    }
    if (memo.plan.storage) await this.persistStorage(tx, request);
    return this.publishPlan(tx, request, states);
  }
  async persistMutation(tx, request, state, index) {
    const { owners, operation, memo } = request;
    const { drafts, result, transactionId } = memo.plan;
    const draft = drafts[index];
    const entry = {
      transactionId,
      characterId: state.id,
      reason: operation.kind,
      revision: state.inventoryRevision + 1,
    };
    await this.materializeItems(
      tx,
      entry,
      flatten(state.profile),
      flatten(draft),
    );
    await this.currencyLedger(tx, {
      ...entry,
      delta: draft.meso - state.profile.meso,
    });
    await this.cashLedger(
      tx,
      entry,
      state.profile.cash.balances,
      draft.cash.balances,
    );
    await persistMarket(tx, this, entry, {
      before: state.profile,
      after: draft,
    });
    if (
      operation.domain === "social" ||
      JSON.stringify(state.profile.social) !== JSON.stringify(draft.social)
    ) {
      state.socialRevision += 1;
    }
    state.profile = structuredClone(draft);
    state.revision += 1;
    state.inventoryRevision += 1;
    await this.persistCharacter(
      tx,
      state,
      owners[index],
      index === 0 ? (operation.membership ?? null) : null,
    );
    const effect = {
      kind: operation.kind,
      profile: state.profile,
      value: result.value ?? null,
    };
    if (index === 0 && memo.plan.storage) {
      effect.accountStorage = memo.plan.storage;
    }
    await tx`INSERT INTO character_op_log(character_id,operation_id,transaction_id,kind,effect) VALUES(${state.id},${operation.operationId},${transactionId},${operation.kind},${effect})`;
  }
  async publishPlan(tx, request, states) {
    const { owners, operation, memo } = request;
    const { result, transactionId } = memo.plan;
    const receipt = {
      status: "committed",
      code: "OK",
      domainRevision:
        result.domainRevision ??
        revision(states[0], operation.domain, operation.domainRevision),
      transactionId,
      events: result.events ?? [],
    };
    if (result.value !== undefined) receipt.value = result.value;
    await this.storeReceipt(tx, owners[0].id, operation, receipt);
    for (const event of result.events ?? []) {
      await tx`INSERT INTO outbox(id,transaction_id,character_id,event) VALUES(${id()},${transactionId},${owners[0].id},${event})`;
    }
    return { receipt, states };
  }
  async persistCharacter(tx, state, owner, field) {
    const passive = owner.passive === true;
    const rows =
      await tx`UPDATE character SET profile=${cacheProfile(state.profile)},meso=${state.profile.meso},revision=${state.revision},inventory_revision=${state.inventoryRevision},social_revision=${state.socialRevision},map_id=${Number(state.profile.location.mapId)},field_instance=COALESCE(${field?.instanceId ?? null},field_instance),field_epoch=COALESCE(${field?.fieldEpoch ?? null},field_epoch),updated_at=clock_timestamp() WHERE id=${state.id} AND deleted_at IS NULL AND fencing_generation=${owner.fence} AND ((${passive} AND (lease_until IS NULL OR lease_until<=clock_timestamp())) OR (NOT ${passive} AND lease_owner=${this.owner} AND lease_until>clock_timestamp())) RETURNING id`;
    if (!rows.length) throw failure("STALE_CONNECTION");
  }
  async storeReceipt(tx, characterId, operation, receipt) {
    await tx`INSERT INTO operation_receipt(character_id,operation_id,digest,receipt) VALUES(${characterId},${operation.operationId},${operation.digest},${receipt})`;
  }
  async removeChangedItems(tx, owner, previous, next) {
    for (const [uid, value] of previous) {
      if (JSON.stringify(value) !== JSON.stringify(next.get(uid))) {
        await tx`DELETE FROM item_instance WHERE id=${uid} AND (owner_id=${owner.characterId ?? null} OR account_owner_id=${owner.accountId ?? null})`;
      }
    }
  }
  async materializeItems(tx, entry, previous, next) {
    const {
      characterId = null,
      accountId = null,
      transactionId,
      reason,
    } = entry;
    for (const [uid, value] of next) {
      if (JSON.stringify(previous.get(uid)) === JSON.stringify(value)) continue;
      await tx`INSERT INTO item_instance(id,owner_id,account_owner_id,template_id,quantity,location,container_id,tab,slot,revision,data) VALUES(${uid},${characterId},${accountId},${value.item.id},${value.item.count},${value.location},${value.containerId},${value.tab},${value.slot},${entry.revision},${value.item})`;
    }
    for (const [template, delta] of itemDeltas(previous, next)) {
      if (delta) {
        await this.ledgerPair(tx, {
          transactionId,
          characterId: characterId ?? `account:${accountId}`,
          asset: `item:${template}`,
          delta,
          reason,
        });
      }
    }
  }
  async loadParticipant(characterId) {
    return this.transaction(async (tx) => {
      const rows =
        await tx`SELECT * FROM character WHERE id=${characterId} AND deleted_at IS NULL FOR SHARE`;
      if (!rows[0]) return null;
      return { ...(await this.hydrate(tx, rows[0])), passive: true };
    });
  }
  async searchParticipants(query = {}) {
    const {
      name = null,
      mapId = null,
      partySearch = false,
      limit = 128,
    } = query;
    validateParticipantFilters(name, mapId);
    if (
      Object.keys(query).some(
        (key) => !["name", "mapId", "partySearch", "limit"].includes(key),
      ) ||
      typeof partySearch !== "boolean" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 128
    ) {
      throw failure("NOT_ALLOWED");
    }
    const rows = await this
      .sql`SELECT id,profile->>'name' AS name,profile->>'level' AS level,profile->>'job' AS job,map_id,lease_until>clock_timestamp() AS online FROM character WHERE deleted_at IS NULL AND (${name}::text IS NULL OR lower(profile->>'name')=lower(${name}::text)) AND (${mapId}::integer IS NULL OR map_id=${mapId}::integer) AND (NOT ${partySearch} OR jsonb_typeof(profile#>'{social,search}')='object') ORDER BY lower(profile->>'name'),id LIMIT ${limit}`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      level: numeric(row.level),
      job: numeric(row.job),
      mapId: String(row.map_id).padStart(9, "0"),
      online: Boolean(row.online),
    }));
  }
  validateStorage(storage, profile, accountId) {
    const ordinary = { ...profile };
    delete ordinary.onlineState;
    validateAccountStorage(storage, ordinary, this.items, accountId);
  }
  async lockStorage(tx, actor) {
    const initial = createAccountStorage(actor.accountId);
    await tx`INSERT INTO account_storage(account_id,state) VALUES(${actor.accountId},${initial}) ON CONFLICT(account_id) DO NOTHING`;
    const rows =
      await tx`SELECT state FROM account_storage WHERE account_id=${actor.accountId} FOR UPDATE`;
    const items =
      await tx`SELECT data FROM item_instance WHERE account_owner_id=${actor.accountId} ORDER BY slot,id LIMIT 49`;
    const storage = { ...rows[0].state, items: items.map((row) => row.data) };
    this.validateStorage(storage, actor.profile, actor.accountId);
    return storage;
  }
  async loadStorage(actor) {
    return this.transaction(async (tx) => {
      const [owner] = await this.lockActors(tx, [actor]);
      return this.lockStorage(tx, owner);
    });
  }
  async persistStorage(tx, request) {
    const { owners, operation, memo } = request;
    const { storage, transactionId } = memo.plan;
    const accountId = owners[0].accountId;
    const entry = {
      accountId,
      transactionId,
      reason: operation.kind,
      revision: storage.revision,
    };
    await this.materializeItems(
      tx,
      entry,
      flattenStorage(request.storage),
      flattenStorage(storage),
    );
    await this.currencyLedger(tx, {
      transactionId,
      characterId: `account:${accountId}`,
      reason: operation.kind,
      delta: storage.meso - request.storage.meso,
    });
    const cache = { ...storage, items: [] };
    await tx`UPDATE account_storage SET state=${cache},updated_at=clock_timestamp() WHERE account_id=${accountId}`;
  }
  /** Provenance rows come from the same committed delta as item_instance, so retries never double-write. */
  async recordItemHistory(tx, request, states) {
    const { owners, operation, memo } = request;
    const { drafts, result, transactionId } = memo.plan;
    await persistItemHistory(tx, {
      transactionId,
      reason: operation.kind,
      actorId: owners[0].id,
      mapId: Number(states[0].profile.location.mapId),
      states,
      drafts,
      storageBefore: request.storage,
      storageAfter: memo.plan.storage,
      accountId: request.account ? owners[0].accountId : null,
      names: new Map([[`character:${owners[0].id}`, owners[0].profile.name]]),
      result,
    });
  }
  /** A player may read an instance they currently own or have ever owned. */
  async itemHistory(actor, value) {
    const request = readHistoryQuery(value);
    const present = await this
      .sql`SELECT 1 AS owned FROM item_instance WHERE id=${request.uid} AND owner_id=${actor.id} LIMIT 1`;
    if (!present[0]) {
      const linked = await this
        .sql`SELECT 1 AS linked FROM item_history WHERE item_id=${request.uid} AND (from_owner_id=${actor.id} OR to_owner_id=${actor.id} OR actor_id=${actor.id} OR account_id=${actor.accountId}) LIMIT 1`;
      if (!linked[0]) throw failure("NOT_FOUND");
    }
    return readItemHistory(this.sql, request);
  }
  /** Administrative read used by the history CLI; it applies no ownership policy. */
  async itemHistoryTrail(value) {
    return readItemHistory(this.sql, value);
  }
  async cashLedger(tx, entry, before, after) {
    for (const asset of CASH_CURRENCIES) {
      const delta = after[asset] - before[asset];
      if (delta) await this.ledgerPair(tx, { ...entry, asset, delta });
    }
  }
  async socialNames(tx, names) {
    if (!names) return;
    const releases = names.release ?? [];
    const reserves = names.reserve ?? [];
    if (releases.length + reserves.length > 128) throw failure("NOT_ALLOWED");
    for (const entry of releases) {
      const rows =
        await tx`DELETE FROM social_name WHERE kind=${entry.kind} AND name=${entry.name} AND group_id=${entry.groupId} RETURNING group_id`;
      if (!rows.length) throw failure("NOT_ALLOWED");
    }
    for (const entry of reserves) {
      const rows =
        await tx`INSERT INTO social_name(kind,name,group_id) VALUES(${entry.kind},${entry.name},${entry.groupId}) ON CONFLICT(kind,name) DO UPDATE SET group_id=EXCLUDED.group_id WHERE social_name.group_id=EXCLUDED.group_id RETURNING group_id`;
      if (!rows.length) throw failure("NOT_ALLOWED");
    }
  }
  async currencyLedger(tx, entry) {
    const { transactionId, characterId, delta, reason } = entry;
    if (delta) {
      await this.ledgerPair(tx, {
        transactionId,
        characterId,
        asset: "meso",
        delta,
        reason,
      });
    }
  }
  async ledgerPair(tx, entry) {
    const { transactionId, characterId, asset, delta, reason } = entry;
    await tx`INSERT INTO ledger(transaction_id,account_key,asset,delta,reason) VALUES(${transactionId},${characterId},${asset},${delta},${reason}),(${transactionId},'system',${asset},${-delta},${reason})`;
  }
  async entitlements(tx, transactionId, result) {
    const grants = result.grantEntitlements ?? [];
    const consumes = result.consumeEntitlements ?? [];
    if (grants.length + consumes.length > MAX_EVENTS) {
      throw failure("SERVER_BUSY");
    }
    for (const entry of grants) {
      await tx`INSERT INTO entitlement(id,kind,granted_transaction) VALUES(${entry.id},${entry.kind},${transactionId})`;
    }
    for (const entry of consumes) {
      const rows =
        await tx`UPDATE entitlement SET consumed_transaction=${transactionId} WHERE id=${entry.id} AND kind=${entry.kind} AND consumed_transaction IS NULL RETURNING id`;
      if (!rows.length) throw failure("NOT_FOUND");
    }
  }
}
