// Headless avatar renderer: the client's own AvatarVisuals composition, drawn into RGBA in Bun.
// No browser, no GPU. Exports renderAvatar() and sheet(); used by create.js for look checks.
// ponytail: nearest-neighbour blit, no rotation/flip support (avatar idle frames use neither).
import { inflateSync } from "node:zlib";
import { AvatarVisuals } from "../client/src/character/avatar-visuals.js";
import { encodePNG } from "../client/src/assets/png.js";

// ---------- minimal PNG decode (8-bit RGBA / RGB / grey+alpha / grey, non-interlaced) ----------
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
function decodePNG(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width, height, colorType;
  const idat = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit non-interlaced PNG");
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels >= 3) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
        out[d + 3] = channels === 4 ? line[s + 3] : 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = channels === 2 ? line[s + 1] : 255;
      }
    }
    prev.set(line);
  }
  return { width, height, rgba: out };
}

// ---------- asset loading with caches ----------
export function assets(origin) {
  const json = new Map();
  const atlases = new Map();
  const getJson = async (url) => {
    if (!json.has(url)) json.set(url, fetch(new URL(url, origin)).then((r) => r.json()));
    return json.get(url);
  };
  const getAtlas = async (url) => {
    if (!atlases.has(url))
      atlases.set(url, fetch(new URL(url, origin)).then(async (r) => decodePNG(new Uint8Array(await r.arrayBuffer()))));
    return atlases.get(url);
  };
  /** AvatarVisuals loader: textures carry their atlas URL instead of a GPU texture. */
  const loadVisual = async (descriptor) => {
    const manifest = await getJson(descriptor.url);
    const textures = new Map();
    for (const [id, t] of Object.entries(manifest.textures))
      textures.set(id, { ...t, atlasUrl: manifest.atlases[t.atlas].url });
    return { manifest, textures, destroy() {} };
  };
  return { getAtlas, loadVisual };
}

/**
 * Draw one avatar frame. profile = {gender, appearance:{skin,face,hair}, equipment:[{id,slot}]}.
 * @returns {Promise<{width:number,height:number,rgba:Uint8Array}>}
 */
export async function renderAvatar({ catalog, store, profile, frame = 0, background = [205, 221, 238, 255] }) {
  const visuals = new AvatarVisuals({ loadVisual: store.loadVisual }, catalog);
  const prepared = await visuals.prepare(profile);
  const action = prepared.standAction;
  const parts = prepared.entity.actions[action][frame].parts
    .filter((p) => !p.expression || p.expression === "default")
    .slice()
    .sort((a, b) => a.z - b.z); // same order as client/src/rendering/animation-timing.js
  const image = await composite(parts, (id) => prepared.textures.get(id), store, background, prepared.bounds);
  prepared.destroy();
  return image;
}

/**
 * Alpha-blend texture parts (already z-sorted) onto a background. texture(id) returns
 * {x,y,width,height,atlasUrl}. Bounds default to the parts' own extent.
 */
export async function composite(parts, texture, store, background = [205, 221, 238, 255], bounds = null) {
  if (!bounds) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of parts) {
      const t = texture(p.texture);
      left = Math.min(left, p.x); top = Math.min(top, p.y);
      right = Math.max(right, p.x + t.width); bottom = Math.max(bottom, p.y + t.height);
    }
    bounds = { left, top, width: right - left, height: bottom - top };
  }
  const pad = 4;
  const { left, top, width: w, height: h } = bounds;
  const width = w + pad * 2, height = h + pad * 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(background, i);
  for (const part of parts) {
    const t = texture(part.texture);
    const atlas = await store.getAtlas(t.atlasUrl);
    const ox = part.x - left + pad, oy = part.y - top + pad;
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        const s = ((t.y + y) * atlas.width + (t.x + x)) * 4;
        const alpha = atlas.rgba[s + 3] / 255;
        if (!alpha) continue;
        const dx = ox + x, dy = oy + y;
        if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
        const d = (dy * width + dx) * 4;
        for (let c = 0; c < 3; c++) rgba[d + c] = atlas.rgba[s + c] * alpha + rgba[d + c] * (1 - alpha);
        rgba[d + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

/** Lay images out in a row, scaled up (nearest neighbour) so small sprites are legible. */
export function sheet(images, scale = 3, gap = 6) {
  const height = Math.max(...images.map((i) => i.height)) * scale;
  const width = images.reduce((sum, i) => sum + i.width * scale + gap, gap);
  const rgba = new Uint8Array(width * height * 4).fill(255);
  let ox = gap;
  for (const img of images) {
    const oy = height - img.height * scale; // align feet
    for (let y = 0; y < img.height * scale; y++)
      for (let x = 0; x < img.width * scale; x++) {
        const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
        rgba.set(img.rgba.subarray(s, s + 4), ((oy + y) * width + ox + x) * 4);
      }
    ox += img.width * scale + gap;
  }
  return encodePNG(width, height, rgba);
}
