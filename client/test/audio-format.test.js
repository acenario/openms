import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishSound } from "../tools/audiovisual-data.js";

// Synthetic MPEG framing, not a decoder fixture or original recording.
function frame({ bitrate = 9, rate = 0, mono = false, padding = 0 } = {}) {
  const kbps = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ][bitrate];
  const hz = [44100, 48000, 32000][rate];
  const bytes = Buffer.alloc(Math.floor((144000 * kbps) / hz) + padding);
  bytes.writeUInt32BE(
    (0xfffb0000 |
      (bitrate << 12) |
      (rate << 10) |
      (padding << 9) |
      (mono ? 0xc0 : 0)) >>>
      0,
  );
  return bytes;
}
function sound(data, overrides = {}) {
  return {
    type: "Sound_DX8",
    data,
    value: {
      field30: 52,
      field34: 1,
      majorType: "83eb36e44f52ce119f530020af0ba770",
      subType: "87eb36e44f52ce119f530020af0ba770",
      sampleSize: 1,
      formatFlags: 1,
      formatType: "00000000000000000000000000000000",
      formatData: Buffer.alloc(0),
      ...overrides,
    },
  };
}
async function published(node, inspect) {
  const output = await mkdtemp(join(tmpdir(), "maple-audio-format-"));
  try {
    await mkdir(join(output, "audio"));
    const descriptor = await publishSound(
      { output },
      node,
      "synthetic MPEG framing",
    );
    await inspect(
      descriptor,
      await readFile(join(output, "audio", `${descriptor.sha256}.mp3`)),
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
function rejected(node) {
  return expect(
    publishSound(
      { output: "unused-rejected-audio" },
      node,
      "synthetic MPEG framing",
    ),
  ).rejects.toThrow();
}

test("elementary MP3 skips exact ID3 framing and preserves variable-bitrate encoded bytes", async () => {
  const id3 = Buffer.from([
    0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 0xff, 0xfb, 0, 0,
  ]);
  const tag = Buffer.alloc(128);
  tag.write("TAG");
  const bytes = Buffer.concat([
    id3,
    frame(),
    frame({ bitrate: 13, padding: 1 }),
    tag,
  ]);
  await published(sound(bytes), (descriptor, encoded) => {
    expect(descriptor.channels).toBe(2);
    expect(descriptor.sampleRate).toBe(44100);
    expect(descriptor.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(encoded.equals(bytes)).toBe(true);
  });
  await published(
    sound(
      Buffer.concat([
        frame({ rate: 2, mono: true }),
        frame({ rate: 2, mono: true }),
      ]),
    ),
    (descriptor) => {
      expect(descriptor.channels).toBe(1);
      expect(descriptor.sampleRate).toBe(32000);
    },
  );
});

test("elementary MP3 rejects truncated frames, false sync and changing stream parameters", async () => {
  const first = frame();
  await rejected(sound(Buffer.concat([first, first.subarray(0, -1)])));
  await rejected(sound(Buffer.concat([Buffer.from([0]), first, first])));
  await rejected(sound(Buffer.concat([first, frame({ mono: true })])));
  await rejected(sound(Buffer.concat([first, frame({ rate: 1 })])));
  const reserved = Buffer.from(first);
  reserved[2] |= 0x0c;
  await rejected(sound(Buffer.concat([first, reserved])));
});

test("elementary MP3 rejects invalid ID3 sizes and unknown or mismatched envelopes", async () => {
  const frames = Buffer.concat([frame(), frame()]);
  const invalidSize = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0x80, 0, 0, 0]);
  await rejected(sound(Buffer.concat([invalidSize, frames])));
  invalidSize[6] = 0x7f;
  await rejected(sound(Buffer.concat([invalidSize, frames])));
  await rejected(
    sound(frames, { subType: "00000000000000000000000000000000" }),
  );
  await rejected(sound(frames, { formatData: Buffer.from([0]) }));
  await rejected(sound(frames, { sampleSize: 0 }));
});

test("wrapped MP3 continues to derive its format from the original WAVEFORMATEX", async () => {
  const formatData = Buffer.alloc(18);
  formatData.writeUInt16LE(0x55, 0);
  formatData.writeUInt16LE(1, 2);
  formatData.writeUInt32LE(22050, 4);
  const node = sound(Buffer.from([1, 2, 3]), {
    subType: "8beb36e44f52ce119f530020af0ba770",
    formatType: "819f580556c3ce11bf0100aa0055595a",
    field34: 2,
    sampleSize: 0,
    formatData,
  });
  await published(node, (descriptor) => {
    expect(descriptor.channels).toBe(1);
    expect(descriptor.sampleRate).toBe(22050);
  });
  formatData.writeUInt16LE(1, 16);
  await rejected(node);
});

// Mob.img/2110300/Damage envelope shape: WAVE_FORMAT_PCM, mono, 44,100 Hz, 16-bit.
function pcm(samples, overrides = {}) {
  const format = Buffer.from("0100010044ac000088580100020010000000", "hex");
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    data.writeInt16LE(((index % 64) - 32) * 512, index * 2);
  }
  return sound(data, {
    field30: Math.floor((samples / 44100) * 1000),
    field34: 2,
    subType: "8beb36e44f52ce119f530020af0ba770",
    sampleSize: 0,
    formatType: "819f580556c3ce11bf0100aa0055595a",
    formatData: format,
    ...overrides,
  });
}

test("original PCM is packaged unchanged in a RIFF/WAVE container", async () => {
  const output = await mkdtemp(join(tmpdir(), "maple-audio-pcm-"));
  try {
    await mkdir(join(output, "audio"));
    const node = pcm(44100);
    const descriptor = await publishSound({ output }, node, "synthetic PCM");
    expect(descriptor).toMatchObject({
      encoding: 1,
      channels: 1,
      sampleRate: 44100,
      durationMs: 1000,
    });
    const wav = await readFile(
      join(output, "audio", `${descriptor.sha256}.wav`),
    );
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.subarray(20, 38).equals(node.value.formatData)).toBe(true);
    expect(wav.subarray(46).equals(node.data)).toBe(true);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("inconsistent PCM fields and unknown format tags stay rejected", async () => {
  const wrongRate = Buffer.from("0100010044ac000044ac0000020010000000", "hex");
  const adpcm = Buffer.from("0200010044ac000088580100020010000000", "hex");
  for (const formatData of [wrongRate, adpcm]) {
    await expect(
      publishSound({ output: tmpdir() }, pcm(44100, { formatData }), "bad"),
    ).rejects.toThrow();
  }
  await expect(
    publishSound({ output: tmpdir() }, pcm(44100, { field30: 900 }), "bad"),
  ).rejects.toThrow("Inconsistent original PCM sound envelope");
});
