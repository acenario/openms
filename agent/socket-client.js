// Browserless game client: the real OnlineTransport + OnlinePrediction + motion kernel,
// driven by virtual keys. No Chrome, no rendering.
// ponytail: browser globals are shimmed process-wide (one account per process). The
// upstream version should inject fetch/WebSocket/baseUrl/identity into OnlineTransport.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { OnlineTransport } from "../client/src/online/transport.js";
import { OnlinePrediction } from "../client/src/online/prediction.js";
import { createSimulation } from "../client/src/physics/simulation.js";
import { powMessage, satisfiesProofOfWork } from "../shared/proof-of-work.js";

const nativeFetch = globalThis.fetch;
const NativeWebSocket = globalThis.WebSocket;
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

function shimBrowser(game) {
  globalThis.location = new URL(`${game}/`);
  globalThis.fetch = async (input, init = {}) => {
    const { credentials: _sameOrigin, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Origin", game);
    if (jar.size) headers.set("Cookie", cookieHeader());
    const response = await nativeFetch(new URL(input, game), { ...rest, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return response;
  };
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, { protocols: [protocols].flat(), headers: { Cookie: cookieHeader(), Origin: game } });
      this.addEventListener("message", (e) => remember("recv", e.data));
    }
    send(data) {
      remember("sent", data);
      return super.send(data);
    }
  };
}

/** Last few frames each way, for diagnosing server protocol closes. */
const TRACE_LIMIT = 12;
export const trace = { sent: [], recv: [] };
function remember(direction, data) {
  const list = trace[direction];
  list.push(String(data).slice(0, 400));
  if (list.length > TRACE_LIMIT) list.shift();
}

function solve(challenge) {
  const encoder = new TextEncoder();
  for (let nonce = 0; nonce < 1e8; nonce++) {
    const message = encoder.encode(powMessage(challenge.challengeId, String(nonce)));
    const digest = new Uint8Array(new Bun.CryptoHasher("sha256").update(message).digest());
    if (satisfiesProofOfWork(digest, challenge.bits))
      return { challengeId: challenge.challengeId, nonce: String(nonce), csrfToken: challenge.loginToken };
  }
  throw new Error("proof of work exhausted");
}

const CREDENTIALS = join(import.meta.dir, "credentials.json");

/** Local agent credentials; `create` mints a random password for a new agent. */
export function agentCredentials(name, { create = false } = {}) {
  const all = existsSync(CREDENTIALS) ? JSON.parse(readFileSync(CREDENTIALS, "utf8")) : {};
  const account = name.toLowerCase();
  if (!all[account] && create) {
    all[account] = { account, password: randomBytes(9).toString("base64url"), character: name };
    writeFileSync(CREDENTIALS, JSON.stringify(all, null, 2));
  }
  if (!all[account]) throw new Error(`no credentials for ${name}; create the agent first (create.js)`);
  return all[account];
}

/**
 * Sign in (registering the account on first use when `register`), without entering the world.
 * @returns {Promise<{transport, cred, characters, catalog, origin}>}
 */
export async function signIn({ name, game, callbacks = {}, register = false }) {
  const origin = new URL(game).origin;
  shimBrowser(origin);
  const cred = agentCredentials(name, { create: register });
  const catalog = await (await nativeFetch(`${origin}/generated/catalog.json`)).json();
  const transport = new OnlineTransport(callbacks);
  // Browser bundles compile their identity in; a headless client adopts the server's.
  transport.verifyCompiledIdentity = () => {};
  await transport.initialize();
  const credentials = () => ({ name: cred.account, password: cred.password });
  let characters;
  try {
    characters = await transport.login({ ...credentials(), proof: solve(await transport.challenge()) });
  } catch (e) {
    if (!register) throw e;
    characters = await transport.register({ ...credentials(), proof: solve(await transport.challenge()) });
  }
  return { transport, cred, characters, catalog, origin };
}

/**
 * Sign in and enter the world.
 * @returns {Promise<{transport, prediction, held, self: () => object, close: () => Promise<void>}>}
 */
export async function connect({ name, game, onEvent = () => {}, onStatus = () => {} }) {
  const physicsCache = new Map();
  const physics = async (mapId) => {
    const key = String(mapId).padStart(9, "0");
    if (!physicsCache.has(key)) {
      const descriptor = catalog.maps[key];
      if (!descriptor) throw new Error(`map ${key} not in catalog`);
      physicsCache.set(key, (await (await nativeFetch(new URL(descriptor.url, origin))).json()).physics);
    }
    return physicsCache.get(key);
  };

  /** Held virtual keys; jumpPressed is a one-step edge cleared after each advance. */
  const held = { left: false, right: false, up: false, down: false, jump: false, attack: false, jumpPressed: false };
  let prediction = null;
  let installedEpoch = null;
  const { transport, cred, characters, catalog, origin } = await signIn({ name, game, callbacks: {
    onStatus,
    onEvent,
    onMotion: (message) => prediction.observe(message),
    onTiming: (value) => prediction.timing(value),
    onSnapshot: async (snapshot) => {
      // Like the browser's refreshesInstalledField(): a refresh of the same field instance
      // (e.g. a peer joined) keeps the running predictor. Reinstalling would rewind its
      // tick and resend already-sent targetTicks => server INVALID_MESSAGE.
      if (prediction.simulation && installedEpoch === snapshot.fieldEpoch) return;
      const world = await physics(snapshot.field.mapId);
      prediction.install(createSimulation(world, snapshot.self.entity.position), snapshot.serverTick);
      installedEpoch = snapshot.fieldEpoch;
    },
  } });
  prediction = new OnlinePrediction({
    onInput: (sample) => transport.sendInput(sample),
    onResync: (reason) => transport.resync(reason),
  });
  const me = characters.find((c) => c.name === cred.character);
  if (!me) throw new Error(`account ${cred.account} has no character ${cred.character}`);
  // A just-closed connection keeps the character for a ~30 s reconnect grace.
  for (let attempt = 0; ; attempt++) {
    try {
      await transport.connect({ characterId: me.id });
      break;
    } catch (e) {
      if (e.code !== "CHARACTER_BUSY" || attempt >= 12) throw e;
      transport.disconnect();
      await Bun.sleep(5000);
    }
  }
  for (let i = 0; i < 100 && !(transport.model?.self && prediction.simulation); i++) await Bun.sleep(100);
  if (!prediction.simulation) throw new Error("entered world but no simulation installed");

  // 30 ms kernel quanta; poll faster so steps are never late.
  const stepper = setInterval(() => {
    if (transport.status !== "active") return;
    if (prediction.advance(performance.now(), held)) held.jumpPressed = false;
  }, 10);

  return {
    transport,
    prediction,
    held,
    character: cred.character,
    self: () => prediction.simulation,
    close: async () => {
      clearInterval(stepper);
      await transport.revoke().catch(() => {}); // explicit logout: no grace period
      transport.close();
    },
  };
}
