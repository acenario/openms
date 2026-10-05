import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { at, value, resolveNode } from "../src/assets/image.js";
import { resource } from "./atlas.js";
import { LIMITS } from "../src/rendering/stream-validation.js";

const MAX_SOUNDS = 512;
const MAX_EFFECT_FRAMES = 256;
const MAX_ELEMENTARY_MP3_BYTES = 32 * 1024 * 1024;
// ISO/IEC 11172-3 MPEG-1 Layer III header indices (kbps and Hz).
const MPEG1_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const COMBAT_SOUND_NAMES = Object.freeze({
  Mob: /^(Damage|Die|Attack[1-8]|CharDam[12])$/,
  Weapon: /^Attack$/,
});
const BASIC_EFFECTS = [
  "Teleport",
  "LevelUp",
  "JobChanged",
  "QuestClear",
  "ItemLevelUp",
  "IncEXP",
  "Transform",
  "TransformOnLadder",
  "Flying",
  "Flying1",
  "Enchant/Success",
  "Enchant/Failure",
];

/** Original backend state/GUID envelope is independent of WAVE channel/rate fields. */
function validateSoundEnvelope(envelope, source) {
  if (
    !envelope ||
    !Number.isInteger(envelope.field30) ||
    envelope.field30 <= 0 ||
    envelope.field30 > 600000 ||
    ![1, 2].includes(envelope.field34) ||
    envelope.formatFlags !== 1 ||
    envelope.majorType !== "83eb36e44f52ce119f530020af0ba770" ||
    !Buffer.isBuffer(envelope.formatData)
  ) {
    throw new Error(`Invalid original sound envelope: ${source}`);
  }
}

/** Skip the bounded ID3v2.3 framing demonstrated in original Sound.wz. */
function elementaryAudioStart(bytes, source) {
  if (bytes.toString("latin1", 0, 3) !== "ID3") return 0;
  if (
    bytes.length < 10 ||
    bytes[3] !== 3 ||
    bytes[4] !== 0 ||
    (bytes[5] & 0x1f) !== 0 ||
    ((bytes[6] | bytes[7] | bytes[8] | bytes[9]) & 0x80) !== 0
  ) {
    throw new Error(`Unsupported original ID3 framing: ${source}`);
  }
  const start =
    10 + (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9];
  if (start > bytes.length - 4) {
    throw new Error(`Truncated original ID3 framing: ${source}`);
  }
  return start;
}

/** Read one complete MPEG-1 Layer III frame; never hunt for speculative sync. */
function elementaryFrame(bytes, offset, end, source) {
  if (offset + 4 > end) {
    throw new Error(`Truncated original MPEG frame: ${source}`);
  }
  const header = bytes.readUInt32BE(offset);
  const bitrate = MPEG1_BITRATES[(header >>> 12) & 15];
  const sampleRate = MPEG1_SAMPLE_RATES[(header >>> 10) & 3];
  if (
    header >>> 21 !== 0x7ff ||
    ((header >>> 19) & 3) !== 3 ||
    ((header >>> 17) & 3) !== 1 ||
    !bitrate ||
    !sampleRate ||
    (header & 3) === 2
  ) {
    throw new Error(`Unsupported original MPEG frame: ${source}`);
  }
  const size =
    Math.floor((144000 * bitrate) / sampleRate) + ((header >>> 9) & 1);
  if (offset + size > end) {
    throw new Error(`Truncated original MPEG frame: ${source}`);
  }
  return { size, sampleRate, channels: ((header >>> 6) & 3) === 3 ? 1 : 2 };
}

/** Validate every frame within the byte cap, allowing only a terminal ID3v1 tag. */
function elementarySoundFormat(bytes, source) {
  if (bytes.length > MAX_ELEMENTARY_MP3_BYTES) {
    throw new Error(`Original MPEG stream exceeds byte limit: ${source}`);
  }
  let offset = elementaryAudioStart(bytes, source);
  const end =
    bytes.length >= 128 &&
    bytes.toString("latin1", bytes.length - 128, bytes.length - 125) === "TAG"
      ? bytes.length - 128
      : bytes.length;
  const first = elementaryFrame(bytes, offset, end, source);
  offset += first.size;
  let frames = 1;
  while (offset < end) {
    const frame = elementaryFrame(bytes, offset, end, source);
    if (
      frame.channels !== first.channels ||
      frame.sampleRate !== first.sampleRate
    ) {
      throw new Error(`Changing original MPEG stream format: ${source}`);
    }
    offset += frame.size;
    frames++;
  }
  if (frames < 2) throw new Error(`Incomplete original MPEG stream: ${source}`);
  return { channels: first.channels, sampleRate: first.sampleRate };
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_MPEGLAYER3 = 0x0055;

/**
 * Microsoft mmreg.h WAVE_FORMAT_PCM in the same FORMAT_WaveFormatEx block as the
 * wrapped MP3 family: 40 original Mob/Pet nodes (for example Mob.img/2110300/Damage)
 * carry mono 44,100 Hz 16-bit samples with cbSize 0. Field consistency is checked;
 * samples are never transcoded.
 */
function pcmSoundFormat(node, source) {
  const data = node.value.formatData;
  const channels = data.readUInt16LE(2),
    sampleRate = data.readUInt32LE(4),
    bits = data.readUInt16LE(14),
    blockAlign = data.readUInt16LE(12);
  if (
    data.length !== 18 ||
    data.readUInt16LE(16) !== 0 ||
    ![8, 16].includes(bits) ||
    blockAlign !== (channels * bits) / 8 ||
    data.readUInt32LE(8) !== sampleRate * blockAlign ||
    node.data.length % blockAlign !== 0 ||
    Math.abs(
      (node.data.length / (sampleRate * blockAlign)) * 1000 -
        node.value.field30,
    ) > 1
  ) {
    throw new Error(`Inconsistent original PCM sound envelope: ${source}`);
  }
  return { channels, sampleRate, encoding: WAVE_FORMAT_PCM };
}

/** Accept only the measured native-stream or existing WAVEFORMATEX envelope. */
function originalSoundFormat(node, source) {
  const envelope = node.value;
  const data = envelope.formatData;
  if (
    envelope.subType === "87eb36e44f52ce119f530020af0ba770" &&
    envelope.sampleSize === 1 &&
    envelope.field34 === 1 &&
    envelope.formatType === "00000000000000000000000000000000" &&
    data.length === 0
  ) {
    return {
      ...elementarySoundFormat(node.data, source),
      encoding: WAVE_FORMAT_MPEGLAYER3,
    };
  }
  return waveFormatEx(node, source);
}

/** FORMAT_WaveFormatEx block: wrapped MP3 or PCM; every other tag is unsupported. */
function waveFormatEx(node, source) {
  const envelope = node.value;
  const data = envelope.formatData;
  if (
    envelope.subType !== "8beb36e44f52ce119f530020af0ba770" ||
    envelope.sampleSize !== 0 ||
    envelope.formatType !== "819f580556c3ce11bf0100aa0055595a" ||
    data.length < 18 ||
    data.length !== 18 + data.readUInt16LE(16)
  ) {
    throw new Error(`Unsupported original sound format: ${source}`);
  }
  const tag = data.readUInt16LE(0);
  if (tag === WAVE_FORMAT_PCM) return pcmSoundFormat(node, source);
  if (tag !== WAVE_FORMAT_MPEGLAYER3) {
    throw new Error(`Unsupported original sound format: ${source}`);
  }
  return {
    channels: data.readUInt16LE(2),
    sampleRate: data.readUInt32LE(4),
    encoding: WAVE_FORMAT_MPEGLAYER3,
  };
}

/** RIFF/WAVE container around the original fmt block and untouched PCM samples. */
function waveContainer(node) {
  const fmt = node.value.formatData,
    header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + 8 + fmt.length + 8 + node.data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(fmt.length, 16);
  const data = Buffer.alloc(8);
  data.write("data", 0, "latin1");
  data.writeUInt32LE(node.data.length, 4);
  return Buffer.concat([header, fmt, data, node.data]);
}

/** Validate the original MPEG envelope, never transcode its payload. */
export function soundFormat(node, source) {
  if (node?.type !== "Sound_DX8" || !node.data?.length) {
    throw new Error(`Missing sound ${source}`);
  }
  const envelope = node.value;
  validateSoundEnvelope(envelope, source);
  const data = envelope.formatData;
  const { channels, sampleRate, encoding } = originalSoundFormat(node, source);
  if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000) {
    throw new Error(`Invalid original sound envelope: ${source}`);
  }
  return {
    channels,
    sampleRate,
    encoding,
    durationMs: envelope.field30,
    envelope: { ...envelope, formatData: data.toString("hex") },
  };
}

export async function publishSound(context, node, source) {
  return publishResolvedSound(context, resolveNode(node), source);
}

async function publishResolvedSound(context, node, source) {
  const format = soundFormat(node, source);
  const payload =
    format.encoding === WAVE_FORMAT_PCM
      ? await resource(context.output, "audio", "wav", waveContainer(node))
      : await resource(context.output, "audio", "mp3", node.data);
  return {
    ...payload,
    source,
    ...format,
  };
}

async function soundFamily(context, category) {
  const root = context.image("Sound", `${category}.img`);
  const names = Object.keys(root.children);
  if (names.length > MAX_SOUNDS) {
    throw new Error(`Sound family exceeds ${MAX_SOUNDS}`);
  }
  const result = {};
  for (const name of names) {
    result[name] = await publishSound(
      context,
      at(root, name),
      `Sound.wz:${category}.img/${name}`,
    );
  }
  return result;
}

/** Original generic-layer delay conversion, shared with aggregate source preflight. */
export function effectDelay(canvas) {
  const rawDelay = value(canvas, "delay", null);
  // Original 00439750 -> 0043e86f -> 0043ea3e -> 0043f768: 120 ms.
  const delay = rawDelay === null ? 120 : Number(rawDelay);
  if (!Number.isFinite(delay) || delay < 0 || delay > 60000) {
    throw new Error("Invalid effect delay");
  }
  return delay;
}

export function effectAlpha(canvas, carried) {
  const rawStart = Number(value(canvas, "a0", -1)),
    rawEnd = Number(value(canvas, "a1", -1));
  const start = rawStart < 0 ? carried : rawStart,
    end = rawEnd < 0 ? start : rawEnd;
  if (start > 255 || end > 255) throw new Error("Invalid effect alpha");
  return { start, end };
}

/** Shared original generic-layer timing, including NPC-owned MapleTV layers. */
export async function effectFrames(context, node) {
  const names = Object.keys(node.children)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  if (!names.length || names.length > MAX_EFFECT_FRAMES) {
    throw new Error("Effect frame count outside bounds");
  }
  const frames = [];
  let carried = 255;
  for (const name of names) {
    const canvas = at(node, name);
    const delay = effectDelay(canvas);
    const { start, end } = effectAlpha(canvas, carried);
    frames.push({
      delay,
      parts: [{ ...(await context.part(canvas)), opacity: start / 255 }],
      alphaEnd: end / 255,
    });
    carried = end;
  }
  return { frames, supported: true };
}

async function publishEffect(context, imageName, name, archive = "Effect") {
  const source = `${archive}.wz:${imageName}/${name}`;
  const extracted = await effectFrames(
    context,
    at(context.image(archive, imageName), name),
  );
  const id = `effect:${imageName}/${name}`;
  const entity = {
    id,
    order: 0,
    kind: "effect",
    x: 0,
    y: 0,
    z: 0,
    visible: true,
    flip: false,
    opacity: 1,
    action: "play",
    actions: { play: extracted.frames },
  };
  const metadata = {
    source,
    timingSupported: extracted.supported,
    activation:
      archive === "UI"
        ? "authored-tutorial-portal"
        : name === "LevelUp" || name === "QuestClear"
          ? "committed-gameplay-event"
          : "local-preview-only",
    durationMs: extracted.frames.reduce(
      (total, frame) => total + frame.delay,
      0,
    ),
  };
  const bundle = await context.bundle({ id, entities: [entity], metadata });
  return { bundle, ...metadata };
}

/** Only the admitted source programs can add generic UI effects to this release. */
async function tutorialEffects(context, effects) {
  const paths = new Set();
  for (const program of Object.values(context.portalPrograms)) {
    for (const branch of program.branches) paths.add(branch.path);
  }
  for (const path of paths) {
    const [archive, imageName, name] = path.split("/");
    if (
      archive !== "UI" ||
      imageName !== "tutorial.img" ||
      !/^\d+$/.test(name)
    ) {
      throw new Error(`Invalid original tutorial effect path: ${path}`);
    }
    effects[path] = await publishEffect(context, imageName, name, archive);
  }
}

/** Exact digit canvases consumed by 00435444/00437d0f; no rasterized text substitute. */
async function combatDigits(context) {
  const actions = {};
  const root = context.image("Effect", "BasicEff.img");
  for (const family of [
    "NoRed0",
    "NoRed1",
    "NoBlue0",
    "NoBlue1",
    "NoViolet0",
    "NoViolet1",
    "NoCri0",
    "NoCri1",
  ]) {
    for (const [name, canvas] of Object.entries(at(root, family).children)) {
      actions[`${family}/${name}`] = [
        { delay: 1000, parts: [await context.part(canvas)] },
      ];
    }
  }
  actions["Catch/Success"] = (
    await effectFrames(context, at(root, "Catch/Success"))
  ).frames;
  const failure = at(root, "Catch/Fail");
  const part = {
    ...(await context.part(failure)),
    x: -Math.trunc(failure.width / 2),
    y: -failure.height,
  };
  //004392c8..0043941c:200ms opaque,200ms fade; fixed canvas-width/height anchor.
  actions["Catch/Fail"] = [
    { delay: 200, parts: [{ ...part, opacity: 1 }], alphaEnd: 1 },
    { delay: 200, parts: [{ ...part, opacity: 1 }], alphaEnd: 0 },
  ];
  return context.bundle({
    id: "combat-digits",
    entities: [
      {
        id: "combat-digits",
        kind: "effect",
        order: 0,
        x: 0,
        y: 0,
        z: 0,
        visible: true,
        flip: false,
        opacity: 1,
        action: "NoRed0/0",
        actions,
      },
    ],
    metadata: {
      source: "Effect.wz:BasicEff.img/No*;Catch/{Success,Fail}",
      consumer: "00437d0f;00438eb6",
    },
  });
}

/** Publish only authored map mobs; absent sound nodes mean silence, never substitute audio. */
async function combatSounds(context, mapIds) {
  const result = { Mob: {}, Weapon: {} };
  const ids = new Set();
  for (const mapId of mapIds) {
    const map = context.image("Map", `Map/Map${mapId[0]}/${mapId}.img`);
    const life = map.children.life;
    if (!life) continue;
    const records = Object.values(life.children);
    if (records.length > 4096) {
      throw new Error("Combat life sound budget exceeded");
    }
    for (const record of records) {
      if (value(record, "type", "") === "m") {
        ids.add(String(value(record, "id", "")).padStart(7, "0"));
      }
    }
  }
  const mobs = context.image("Sound", "Mob.img");
  for (const id of ids) {
    result.Mob[Number(id)] = mobs.children[id]
      ? await soundChildren(context, "Mob", id, at(mobs, id))
      : {};
  }
  const weapons = context.image("Sound", "Weapon.img");
  const families = Object.entries(weapons.children);
  if (families.length > MAX_SOUNDS) {
    throw new Error("Weapon sound family bound exceeded");
  }
  for (const [weaponSfx, weapon] of families) {
    result.Weapon[weaponSfx] = await soundChildren(
      context,
      "Weapon",
      weaponSfx,
      weapon,
    );
  }
  return result;
}

async function soundChildren(context, category, id, root) {
  const result = {};
  const entries = Object.entries(resolveNode(root).children);
  if (entries.length > MAX_SOUNDS) {
    throw new Error("Combat sound family budget exceeded");
  }
  for (const [name, node] of entries) {
    if (!COMBAT_SOUND_NAMES[category].test(name)) continue;
    result[name] = await retainedCombatSound(
      context,
      node,
      `Sound.wz:${category}.img/${id}/${name}`,
    );
  }
  return result;
}

/** Preserve unresolved original aliases as explicit unavailable records, never repaired audio. */
async function retainedCombatSound(context, node, source) {
  let resolved;
  try {
    resolved = resolveNode(node);
  } catch (error) {
    return {
      available: false,
      source,
      alias: node.value,
      reason: error.message,
    };
  }
  return {
    available: true,
    descriptor: await publishResolvedSound(context, resolved, source),
  };
}

function mapMobIds(context, mapIds) {
  const ids = new Set();
  for (const mapId of mapIds) {
    const map = context.image("Map", `Map/Map${mapId[0]}/${mapId}.img`);
    for (const record of Object.values(map.children.life?.children ?? {})) {
      if (value(record, "type", "") === "m") {
        ids.add(String(value(record, "id", "")).padStart(7, "0"));
      }
    }
  }
  return ids;
}

function combatSoundSources(context, category, ids) {
  const root = context.image("Sound", `${category}.img`),
    rows = [];
  for (const id of ids ?? Object.keys(root.children)) {
    if (!root.children[id]) continue;
    for (const [name, node] of Object.entries(
      resolveNode(root.children[id]).children,
    )) {
      if (!COMBAT_SOUND_NAMES[category].test(name)) continue;
      // Unresolved aliases are retained as unavailable records, not failures.
      rows.push({
        node,
        source: `Sound.wz:${category}.img/${id}/${name}`,
        optional: true,
      });
    }
  }
  return rows;
}

/** Every Sound.wz node extractAudiovisual publishes, so preflight validates the same set. */
export function audiovisualSoundSources(context, mapIds) {
  const rows = [];
  for (const category of ["UI", "Game"]) {
    for (const name of Object.keys(
      context.image("Sound", `${category}.img`).children,
    )) {
      rows.push({
        node: at(context.image("Sound", `${category}.img`), name),
        source: `Sound.wz:${category}.img/${name}`,
      });
    }
  }
  rows.push(
    ...combatSoundSources(context, "Mob", mapMobIds(context, mapIds)),
    ...combatSoundSources(context, "Weapon", null),
    {
      node: at(context.image("Sound", "BgmUI.img"), "Title"),
      source: "Sound.wz:BgmUI.img/Title",
    },
  );
  return rows;
}

/** Immutable catalog metadata; audio and visual payloads remain separately demand-loaded. */
export async function extractAudiovisual(context, mapIds) {
  if (!Array.isArray(mapIds) || mapIds.length > LIMITS.maps) {
    throw new Error("Invalid audiovisual map selection");
  }
  mkdirSync(resolve(context.output, "audio"), { recursive: true });
  const index = { schemaVersion: 1, maps: {}, sounds: {}, effects: {} };
  const bgms = new Map();
  for (const mapId of mapIds) {
    if (!/^\d{9}$/.test(mapId)) throw new Error(`Invalid map id ${mapId}`);
    const map = context.image("Map", `Map/Map${mapId[0]}/${mapId}.img`);
    const info = at(map, "info");
    const bgm = value(info, "bgm", "");
    // Track names are original WZ child keys, not JavaScript identifiers.
    if (!/^[A-Za-z0-9_]+\/[^/\\]+$/.test(bgm)) {
      throw new Error(`Unsupported map BGM ${bgm}`);
    }
    const [image, name] = bgm.split("/");
    if (!bgms.has(bgm)) {
      bgms.set(
        bgm,
        await publishSound(
          context,
          at(context.image("Sound", `${image}.img`), name),
          `Sound.wz:${image}.img/${name}`,
        ),
      );
    }
    index.maps[mapId] = {
      bgm: bgms.get(bgm),
      effect: value(info, "effect", null),
    };
  }
  for (const category of ["UI", "Game"]) {
    index.sounds[category] = await soundFamily(context, category);
  }
  index.combat = {
    digits: await combatDigits(context),
    sounds: await combatSounds(context, mapIds),
  };
  for (const name of BASIC_EFFECTS) {
    index.effects[name] = await publishEffect(context, "BasicEff.img", name);
  }
  for (const name of ["Bubbling", "Viewrange", "NpcSummon", "NpcReturn"]) {
    index.effects[name] = await publishEffect(context, "MapEff.img", name);
  }
  await tutorialEffects(context, index.effects);
  // Login/title music is a BgmUI member, not reached from any map's info/bgm.
  // Native login dispatch is not recovered, so the descriptor names its exact source.
  index.login = {
    bgm: await publishSound(
      context,
      at(context.image("Sound", "BgmUI.img"), "Title"),
      "Sound.wz:BgmUI.img/Title",
    ),
  };
  return index;
}
