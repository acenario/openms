import { Gate, check, aborted } from "../rendering/stream-network.js";

const MAX_PCM_BYTES = 160 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const MAX_SOURCES = 24;
const MAX_PENDING = 32;
const PCM_SCAN_SAMPLES = 65536;

/** Yield between bounded validation slices, never skipping original decoded samples. */
function yieldAudioWork() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function scanPCM(samples, signal) {
  let energy = 0,
    peak = 0;
  for (let start = 0; start < samples.length; start += PCM_SCAN_SAMPLES) {
    check(signal);
    const end = Math.min(start + PCM_SCAN_SAMPLES, samples.length);
    for (let index = start; index < end; index++) {
      const sample = samples[index];
      if (!Number.isFinite(sample)) {
        throw new Error("Native audio decoder returned nonfinite PCM");
      }
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    if (end < samples.length) await yieldAudioWork();
  }
  check(signal);
  return { energy, peak };
}

/** Original Sound_DX8 5180c8a7: hundredths-of-dB to WebAudio amplitude. */
export function originalVolumeGain(volume) {
  if (!Number.isInteger(volume) || volume < 0 || volume > 128) {
    throw new Error("Audio volume must be 0..128");
  }
  const attenuation =
    volume < 1
      ? -10000
      : volume < 128
        ? 625 - Math.trunc(1280000 / (15 * volume + 128))
        : 0;
  return Math.pow(10, attenuation / 2000);
}

/** 0043fdab: truncate backend master * spatial percentage / 100 before DX8 curve. */
function eventGain(volume, percent) {
  return (
    originalVolumeGain(Math.trunc((volume * percent) / 100)) /
    originalVolumeGain(volume)
  );
}

/** Validate every native decoded sample outside rendering, retaining source duration separately. */
async function validatePCM(buffer, descriptor, signal) {
  const bytes = buffer.length * buffer.numberOfChannels * 4;
  if (
    bytes > MAX_PCM_BYTES ||
    buffer.numberOfChannels !== descriptor.channels ||
    buffer.sampleRate < 8000 ||
    buffer.sampleRate > 96000 ||
    Math.abs(buffer.duration * 1000 - descriptor.durationMs) >
      Math.max(300, descriptor.durationMs * 0.01)
  ) {
    throw new Error(
      `Native audio decode incompatible with ${descriptor.source}`,
    );
  }
  let energy = 0,
    peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const result = await scanPCM(buffer.getChannelData(channel), signal);
    energy += result.energy;
    peak = Math.max(peak, result.peak);
  }
  if (energy === 0) {
    throw new Error(`Original sound decoded to silence: ${descriptor.source}`);
  }
  return {
    bytes,
    frames: buffer.length,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    durationMs: buffer.duration * 1000,
    rms: Math.sqrt(energy / (buffer.length * buffer.numberOfChannels)),
    peak,
  };
}

/** One native output graph, serial decode admission, pinned cache ownership and bounded voices. */
export class AudioEngine {
  constructor(network, onError) {
    this.network = network;
    this.onError = onError;
    this.context = null;
    this.initializing = null;
    this.abort = new AbortController();
    this.bgmController = new AbortController();
    this.decodeGate = new Gate(1);
    this.cache = new Map();
    this.sources = new Set();
    this.cacheBytes = 0;
    this.pending = 0;
    this.decoded = 0;
    this.lastDecode = null;
    this.lastCapture = null;
    this.capture = null;
    this.bgm = null;
    this.wanted = null;
    this.destroyed = false;
    // Browser starting preference, not the original settings slider default.
    this.settings = {
      BGM: { volume: 64, mute: false },
      SE: { volume: 64, mute: false },
    };
  }
  async enable() {
    if (this.destroyed) throw aborted();
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.initializing = this.createGraph();
    }
    const resume = this.context.resume();
    await this.initializing;
    await resume;
    check(this.abort.signal);
    if (this.context.state !== "running") {
      throw new Error("Browser audio gesture did not enable output");
    }
    // A field can change while the context is suspended and retain the old voice.
    if (this.wanted?.source !== this.bgm?.entry.source) {
      await this.setBGM(this.wanted);
    }
  }
  async createGraph() {
    await this.context.audioWorklet.addModule(
      new URL("./audio-capture-worklet.js", import.meta.url),
    );
    check(this.abort.signal);
    this.tap = new AudioWorkletNode(this.context, "runtime-pcm-tap", {
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    this.tap.port.onmessage = this.receiveCapture.bind(this);
    this.tap.onprocessorerror = this.processorError.bind(this);
    this.masters = {
      BGM: this.context.createGain(),
      SE: this.context.createGain(),
    };
    for (const category of ["BGM", "SE"]) {
      this.masters[category].connect(this.tap);
      this.applyVolume(category);
    }
    this.tap.connect(this.context.destination);
  }
  processorError() {
    const error = new Error(
      "Live PCM output processor failed; audio acceptance unavailable",
    );
    this.failCapture(error);
    this.onError(error);
  }
  setVolume(category, volume, mute) {
    if (!Object.hasOwn(this.settings, category) || typeof mute !== "boolean") {
      throw new Error("Invalid audio setting");
    }
    originalVolumeGain(volume);
    this.settings[category].volume = volume;
    this.settings[category].mute = mute;
    if (this.masters) this.applyVolume(category);
  }
  applyVolume(category) {
    const setting = this.settings[category];
    this.masters[category].gain.setValueAtTime(
      setting.mute ? 0 : originalVolumeGain(setting.volume),
      this.context.currentTime,
    );
    for (const voice of this.sources) {
      if (voice.category === category) {
        voice.gain.gain.value = eventGain(setting.volume, voice.percent);
      }
    }
  }
  evict(incoming, replacingBGM = false) {
    // Preserve the old audible track during replacement; steady-state cache stays160MiB.
    const limit =
      MAX_PCM_BYTES + (replacingBGM ? (this.bgm?.entry.bytes ?? 0) : 0);
    for (const [key, entry] of this.cache) {
      if (
        this.cacheBytes + incoming <= limit &&
        this.cache.size < MAX_CACHE_ENTRIES
      ) {
        break;
      }
      if (entry.users) continue;
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
    if (
      this.cacheBytes + incoming > limit ||
      this.cache.size >= MAX_CACHE_ENTRIES
    ) {
      throw new Error("Pinned PCM cache budget exhausted");
    }
  }
  async acquire(descriptor, signal, replacingBGM = false) {
    if (++this.pending > MAX_PENDING) {
      this.pending--;
      throw new Error("Audio decode queue limit exceeded");
    }
    try {
      return await this.decodeGate.run(async () => {
        check(signal);
        check(this.abort.signal);
        try {
          let entry = this.cache.get(descriptor.sha256);
          if (!entry) {
            entry = await this.decode(descriptor, signal, replacingBGM);
          }
          check(signal);
          check(this.abort.signal);
          entry.users++;
          this.cache.delete(descriptor.sha256);
          this.cache.set(descriptor.sha256, entry);
          if (replacingBGM) this.replaceBGM(entry);
          return entry;
        } catch (error) {
          if (replacingBGM) this.evict(0);
          throw error;
        }
      }, signal);
    } finally {
      this.pending--;
    }
  }
  async decode(descriptor, signal, replacingBGM) {
    if (
      // WAVE_FORMAT_MPEGLAYER3 MP3 or WAVE_FORMAT_PCM in a RIFF container.
      ![0x55, 0x01].includes(descriptor.encoding) ||
      descriptor.bytes > 16 * 1024 * 1024 ||
      !Number.isFinite(descriptor.durationMs) ||
      descriptor.durationMs <= 0 ||
      descriptor.durationMs > 600000 ||
      ![1, 2].includes(descriptor.channels)
    ) {
      throw new Error("Invalid packaged audio envelope");
    }
    const predicted =
      Math.ceil(
        (descriptor.durationMs / 1000 + 0.3) * this.context.sampleRate,
      ) *
      descriptor.channels *
      4;
    if (predicted > MAX_PCM_BYTES) {
      throw new Error("Original track exceeds decoded PCM budget");
    }
    this.evict(predicted, replacingBGM);
    const activity = this.network.activity?.begin();
    try {
      return await this.decodeSource(descriptor, signal, replacingBGM);
    } finally {
      this.network.activity?.end(activity);
    }
  }
  async decodeSource(descriptor, signal, replacingBGM) {
    const encoded = await this.network.load(descriptor, signal);
    check(this.abort.signal);
    const buffer = await this.context.decodeAudioData(encoded);
    check(signal);
    check(this.abort.signal);
    const metrics = await validatePCM(
      buffer,
      descriptor,
      AbortSignal.any([signal, this.abort.signal]),
    );
    this.evict(metrics.bytes, replacingBGM);
    const entry = {
      buffer,
      users: 0,
      bytes: metrics.bytes,
      source: descriptor.source,
    };
    this.cache.set(descriptor.sha256, entry);
    this.cacheBytes += entry.bytes;
    this.decoded++;
    this.lastDecode = {
      source: descriptor.source,
      sha256: descriptor.sha256,
      ...metrics,
    };
    return entry;
  }
  start(entry, category, loop, percent = 100) {
    if (this.sources.size >= MAX_SOURCES) {
      throw new Error("Audio voice budget exhausted");
    }
    const source = this.context.createBufferSource();
    source.buffer = entry.buffer;
    source.loop = loop;
    const gain = this.context.createGain();
    gain.gain.value = eventGain(this.settings[category].volume, percent);
    source.connect(gain);
    gain.connect(this.masters[category]);
    const voice = { source, gain, entry, category, percent, ended: false };
    source.onended = () => this.releaseVoice(voice);
    this.sources.add(voice);
    source.start();
    return voice;
  }
  releaseVoice(voice) {
    if (voice.ended) return;
    voice.ended = true;
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.source.buffer = null;
    voice.entry.users--;
    this.sources.delete(voice);
    if (this.bgm === voice) this.bgm = null;
  }
  stopVoice(voice) {
    if (!voice || voice.ended) return;
    voice.source.stop();
    this.releaseVoice(voice);
  }
  /** Warm a source without starting a voice or changing either channel's settings. */
  async prepareSound(descriptor, signal) {
    if (!this.context || !this.masters) return { status: "gesture-required" };
    const entry = await this.acquire(descriptor, signal);
    entry.users--;
    return { status: "prepared", source: descriptor.source };
  }
  async playSound(descriptor, signal, percent = 100) {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new Error("Sound event percentage must be within 0..100");
    }
    if (!this.context || this.context.state !== "running" || !this.masters) {
      return { status: "gesture-required" };
    }
    // A retained PCM hit has no network/decode admission delay.
    let entry = this.cache.get(descriptor.sha256);
    if (entry) {
      entry.users++;
      this.cache.delete(descriptor.sha256);
      this.cache.set(descriptor.sha256, entry);
    } else entry = await this.acquire(descriptor, signal);
    try {
      check(signal);
      check(this.abort.signal);
      if (this.context.state !== "running") {
        entry.users--;
        return { status: "gesture-required" };
      }
      this.start(entry, "SE", false, percent);
      this.lastSound = {
        source: descriptor.source,
        sha256: descriptor.sha256,
        percent,
      };
      return { status: "playing", source: descriptor.source };
    } catch (error) {
      entry.users--;
      throw error;
    }
  }
  async setBGM(descriptor) {
    this.wanted = descriptor;
    this.bgmController.abort();
    this.bgmController = new AbortController();
    if (!descriptor) {
      this.stopVoice(this.bgm);
      return;
    }
    if (!this.context || !this.masters || this.context.state !== "running") {
      return;
    }
    if (this.bgm?.entry.source === descriptor.source) return;
    const signal = AbortSignal.any([
      this.abort.signal,
      this.bgmController.signal,
    ]);
    // Commit inside decode admission, before another SE/BGM demand can observe
    // both replacement buffers pinned above the steady-state cache budget.
    await this.acquire(descriptor, signal, true);
  }
  replaceBGM(entry) {
    let voice;
    try {
      voice = this.start(entry, "BGM", true);
    } catch (error) {
      entry.users--;
      throw error;
    }
    // Switch without guessing the original unresolved fade interpolation.
    this.stopVoice(this.bgm);
    this.bgm = voice;
    this.evict(0);
  }
  capturePCM(seconds = 2) {
    if (!this.tap || this.context.state !== "running") {
      return Promise.reject(new Error("Live audio is not enabled"));
    }
    if (
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 5 ||
      this.capture
    ) {
      return Promise.reject(
        new Error("Invalid or overlapping live PCM request"),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.failCapture(new Error("Live PCM capture timed out")),
        seconds * 1000 + 5000,
      );
      this.capture = { resolve, reject, timer };
      this.tap.port.postMessage({
        frames: Math.ceil(seconds * this.context.sampleRate),
      });
    });
  }
  async receiveCapture(event) {
    if (!this.capture) return;
    if (event.data.error) {
      this.failCapture(new Error(event.data.error));
      return;
    }
    const pending = this.capture;
    clearTimeout(pending.timer);
    this.capture = null;
    try {
      const samples = new Float32Array(event.data.buffer);
      const { energy, peak } = await scanPCM(samples, this.abort.signal);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", samples.buffer),
      );
      check(this.abort.signal);
      const result = {
        frames: samples.length / 2,
        channels: 2,
        sampleRate: event.data.sampleRate,
        rms: Math.sqrt(energy / samples.length),
        peak,
        audible: energy > 0,
        sha256: Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        representation:
          "interleaved stereo float32 native little-endian, post BGM/SE gains",
      };
      this.lastCapture = result;
      pending.resolve({ ...result, pcm: samples.buffer });
    } catch (error) {
      pending.reject(error);
    }
  }
  failCapture(error) {
    if (!this.capture) return;
    clearTimeout(this.capture.timer);
    this.capture.reject(error);
    this.capture = null;
  }
  snapshot() {
    return {
      state: this.context?.state ?? "gesture-required",
      cacheBytes: this.cacheBytes,
      cacheEntries: this.cache.size,
      pending: this.pending,
      voices: this.sources.size,
      bgm: this.bgm?.entry.source ?? null,
      decoded: this.decoded,
      lastDecode: this.lastDecode,
      lastSound: this.lastSound ?? null,
      lastCapture: this.lastCapture,
      settings: { BGM: { ...this.settings.BGM }, SE: { ...this.settings.SE } },
    };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.bgmController.abort();
    this.failCapture(aborted());
    for (const voice of this.sources) this.stopVoice(voice);
    this.cache.clear();
    this.cacheBytes = 0;
    if (this.tap) {
      this.tap.port.onmessage = null;
      this.tap.port.close();
      this.tap.disconnect();
    }
    if (this.masters) {
      this.masters.BGM.disconnect();
      this.masters.SE.disconnect();
    }
    if (this.context) this.context.close().catch(this.onError);
  }
}
