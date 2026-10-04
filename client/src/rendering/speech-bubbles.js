import {
  CanvasSource,
  Container,
  Sprite,
  Texture,
  TilingSprite,
} from "pixi.js";
import { loadVisualBundle } from "./visual-resources.js";
import { check } from "./stream-network.js";
// 008d379c / 004ca25d bound the original edit length; the fork accepts longer chat and
// a bubble shows at most BUBBLE_TEXT_LIMIT characters of it (the chat log keeps the rest).
import { BUBBLE_TEXT_LIMIT, CHAT_LIMIT } from "../social/chat-rules.js";

const NAME_LIMIT = 13;
const MAX_TEXT_UNITS = BUBBLE_TEXT_LIMIT + NAME_LIMIT + 3;

/** The start of a long message, so a bubble never outgrows its screen space. */
function bubbleText(text) {
  if (text.length <= BUBBLE_TEXT_LIMIT) return text;
  return `${text.slice(0, BUBBLE_TEXT_LIMIT - 3)}...`;
}
const FIRST_PRINTABLE = 0x20;
const PRINTABLE_COUNT = 95;
const DISPLAY_MS = 5000; // 00937495 / 00978b4f push 0x1388.
const PART_NAMES = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se", "arrow"];
const TILED = new Set(["n", "w", "c", "e", "s"]);
const MAX_COLUMNS = 7; // 00489941: seven center tiles for ordinary speech.
const FONT = "12px Arial, sans-serif"; // Browser substitute for the original font rasterizer.
const SKIN_ALPHA = 253 / 255; // 0048a707: Copy(..., alpha=0xfd), before drawing text.
const DESTROY_DISPLAY = Object.freeze({ children: true });
const SPEECH_DEPTH = 398300; // 0048af8b..90: native world B + 0x613dc.

/** Validate the one ordinary WZ skin before constructing any display resources. */
function skinParts(resource, skin = "0") {
  const assets = resource.manifest.metadata?.assets;
  if (!assets || resource.manifest.entities.length !== PART_NAMES.length) {
    throw new Error("Invalid ordinary speech skin");
  }
  const parts = Object.create(null);
  for (const name of PART_NAMES) {
    parts[name] = skinPart(resource, assets, name, skin);
  }
  return parts;
}

/** Read one already-counted WZ part and reject missing or composite canvases. */
function skinPart(resource, assets, name, skin) {
  const id = `${skin}/${name}`;
  const asset = assets[id];
  const entity = resource.manifest.entities.find((entry) => entry.id === id);
  const frames = entity?.actions.default;
  const frame = frames?.[0];
  const texture = resource.textures.get(frame?.parts?.[0]?.texture);
  if (!asset || frames?.length !== 1 || frame.parts.length !== 1 || !texture) {
    throw new Error(`Invalid speech canvas ${id}`);
  }
  validateCanvasGeometry(asset, texture, id);
  return { asset, texture };
}

/** Skin dimensions are bounded WZ pixels and must match the decoded canvas. */
function invalidCanvasDimensions(asset, texture) {
  return (
    texture.width !== asset.width ||
    texture.height !== asset.height ||
    asset.width < 1 ||
    asset.width > 32 ||
    asset.height < 1 ||
    asset.height > 32
  );
}

function validateCanvasGeometry(asset, texture, id) {
  if (
    invalidCanvasDimensions(asset, texture) ||
    !Number.isFinite(asset.origin?.x) ||
    !Number.isFinite(asset.origin?.y) ||
    Math.abs(asset.origin.x) > 32 ||
    Math.abs(asset.origin.y) > 32
  ) {
    throw new Error(`Invalid speech canvas geometry ${id}`);
  }
}

/** Resize tiled parts without stretching the underlying WZ texture. */
function sizeSprite(sprite, width, height) {
  if (width !== undefined) sprite.width = width;
  if (height !== undefined) sprite.height = height;
  sprite.visible = width !== 0;
}

/** The field supplies a stable world head anchor and finite camera coordinates. */
function validateHeadAnchor(pose, camera) {
  if (
    !Number.isFinite(pose?.x) ||
    !Number.isFinite(pose?.headY) ||
    !Number.isFinite(camera?.x) ||
    !Number.isFinite(camera?.y)
  ) {
    throw new Error("Speech needs a finite avatar head anchor and camera");
  }
}

function isLineBreak(character) {
  return character === " " || ".,!?".includes(character);
}

/** Canvas.dll 50005347: integer glyph advances, with punctuation kept at word boundaries. */
export function speechLineEnd(text, start, maximum, advances) {
  let width = 0;
  let sawSpace = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    width += advances[text.charCodeAt(index) - FIRST_PRINTABLE];
    if (character === " ") sawSpace = true;
    if (width <= maximum) continue;
    if (!sawSpace || character === " ") return index;
    if (index + 1 === text.length || isLineBreak(character)) return index + 1;
    // 50005457 starts with the NEXT glyph, so a following punctuation mark stays here.
    for (let boundary = index + 1; boundary >= start; boundary--) {
      if (isLineBreak(text[boundary])) return boundary + 1;
    }
    throw new Error("Speech word boundary is missing");
  }
  return text.length;
}

/** Canvas.dll 500051cd sums cached per-glyph advances; it does not kern a whole string. */
function speechTextWidth(text, advances) {
  let width = 0;
  for (let index = 0; index < text.length; index++) {
    width += advances[text.charCodeAt(index) - FIRST_PRINTABLE];
  }
  return width;
}

/** 0048966c..00489888: bound the entire authored border, not just each edge. */
function skinMargins(parts) {
  const { nw, n, ne, w, e, sw, s, se, arrow } = parts;
  return {
    left: Math.max(nw.asset.origin.x, w.asset.origin.x, sw.asset.origin.x),
    right: Math.max(
      ne.asset.width - ne.asset.origin.x,
      e.asset.width - e.asset.origin.x,
      se.asset.width - se.asset.origin.x,
    ),
    top: Math.max(nw.asset.origin.y, n.asset.origin.y, ne.asset.origin.y),
    bottom: Math.max(
      sw.asset.height - sw.asset.origin.y,
      s.asset.height - s.asset.origin.y,
      se.asset.height - se.asset.origin.y,
      arrow.asset.height - arrow.asset.origin.y,
    ),
  };
}

/** One local utterance, world anchored and rendered below the UI. No server-message log. */
export class SpeechBubbles {
  constructor(app, services) {
    this.app = app;
    this.services = services;
    this.root = new Container({ label: "local-speech", zIndex: SPEECH_DEPTH });
    this.root.eventMode = "none";
    this.root.visible = false;
    this.scene = null;
    this.resource = null;
    this.parts = null;
    this.sprites = Object.create(null);
    this.text = "";
    this.remainingMs = -1;
    this.width = 0;
    this.height = 0;
    this.lines = [];
    this.advances = new Uint16Array(PRINTABLE_COUNT);
    this.lineWidths = [];
    this.fontAscent = 0;
    this.destroyed = false;
    this.maxTextUnits = MAX_TEXT_UNITS;
    this.prepared = [];
    this.ownsResource = true;
  }

  /** Transfer the presentation into the live field's world-transform/lifetime boundary. */
  setScene(scene) {
    if (
      this.destroyed ||
      this.root.destroyed ||
      scene?.destroyed ||
      !scene?.container ||
      scene.container.destroyed
    ) {
      throw new Error("Speech needs a live field");
    }
    if (this.scene === scene) return;
    if (this.scene) this.scene.removeWorldContainer(this.root);
    scene.addWorldContainer(this.root, SPEECH_DEPTH);
    this.scene = scene;
  }

  async prepare(catalog, signal) {
    if (this.destroyed || this.resource) {
      throw new Error("Speech owner is not fresh");
    }
    const record = catalog.ui?.speechBubbles;
    if (!record?.bundle || !Number.isInteger(record.color)) {
      throw new Error("Speech catalog is missing");
    }
    const resource = await loadVisualBundle(
      record.bundle,
      this.services,
      signal,
    );
    try {
      check(signal);
      if (this.destroyed) {
        throw new Error("Speech owner was destroyed while loading");
      }
      this.parts = skinParts(resource);
      this.buildDisplay(record.color);
      this.resource = resource;
      return this;
    } catch (error) {
      resource.destroy();
      this.destroy();
      throw error;
    }
  }

  /** NPCs share one map-owned skin lease; all glyph/layout work precedes gameplay. */
  prepareNpc(resource, record) {
    if (this.resource || this.destroyed || !Number.isInteger(record.color)) {
      throw new Error("NPC speech owner requires a fresh original npc skin");
    }
    this.maxTextUnits = 256;
    this.advances = new Uint16Array(65536 - FIRST_PRINTABLE);
    this.parts = skinParts(resource, "npc");
    this.buildDisplay(record.color);
    this.resource = resource;
    this.ownsResource = false;
  }

  /** Cache an authored utterance's compact raster and integer layout once. */
  prepareUtterance(text) {
    if (typeof text !== "string" || text.length > this.maxTextUnits) {
      throw new Error("Unsupported NPC speech text");
    }
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) < FIRST_PRINTABLE) {
        throw new Error("Unsupported NPC speech text");
      }
    }
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index) - FIRST_PRINTABLE;
      if (!this.advances[code]) {
        this.advances[code] = Math.max(
          1,
          Math.round(this.context.measureText(text[index]).width),
        );
      }
    }
    this.layoutText(text);
    const canvas = document.createElement("canvas");
    const width = this.width + this.leftMargin + this.rightMargin;
    const height = this.height + this.topMargin + this.bottomMargin;
    canvas.width = Math.ceil(width * this.resolution);
    canvas.height = Math.ceil(height * this.resolution);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("NPC speech raster is unavailable");
    const texture = new Texture({
      source: new CanvasSource({
        resource: canvas,
        resolution: this.resolution,
      }),
    });
    context.drawImage(this.canvas, 0, 0);
    const prepared = {
      text,
      texture,
      width: this.width,
      height: this.height,
      lines: this.lines.slice(),
      lineWidths: this.lineWidths.slice(),
    };
    this.prepared.push(prepared);
    return prepared;
  }

  /** Selection changes references and existing skin transforms, never text layout. */
  showPrepared(prepared) {
    this.text = prepared.text;
    this.width = prepared.width;
    this.height = prepared.height;
    this.lines = prepared.lines;
    this.lineWidths = prepared.lineWidths;
    this.textSprite.texture = prepared.texture;
    this.layoutSkin();
    this.remainingMs = DISPLAY_MS;
    this.root.visible = false;
  }
  buildDisplay(color) {
    for (const name of PART_NAMES) {
      const part = this.parts[name];
      const sprite = TILED.has(name)
        ? new TilingSprite({
            texture: part.texture,
            width: part.asset.width,
            height: part.asset.height,
          })
        : new Sprite(part.texture);
      sprite.alpha = SKIN_ALPHA;
      this.sprites[name] = sprite;
      this.root.addChild(sprite);
    }
    this.sprites.sRight = new TilingSprite({ texture: this.parts.s.texture });
    this.sprites.sRight.alpha = SKIN_ALPHA;
    this.root.addChild(this.sprites.sRight);
    this.canvas = document.createElement("canvas");
    const margins = skinMargins(this.parts);
    this.leftMargin = margins.left;
    this.rightMargin = margins.right;
    this.topMargin = margins.top;
    this.bottomMargin = margins.bottom;
    // Native punctuation fitting can overrun seven tiles; a single line then rounds to nine.
    this.textWidth =
      this.parts.c.asset.width * (MAX_COLUMNS + 2) +
      this.leftMargin +
      this.rightMargin;
    this.textHeight =
      this.parts.c.asset.height * this.maxTextUnits +
      this.topMargin +
      this.bottomMargin;
    this.context = this.canvas.getContext("2d");
    if (!this.context) throw new Error("Speech text canvas is unavailable");
    this.textColor = `#${((color >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
    this.textTexture = new Texture({
      source: new CanvasSource({
        resource: this.canvas,
        width: this.textWidth,
        height: this.textHeight,
        resolution: this.app.renderer.resolution,
      }),
    });
    this.syncDensity(this.app.renderer.resolution);
    this.measureAdvances();
    this.textSprite = new Sprite(this.textTexture);
    this.root.addChild(this.textSprite);
  }

  /** Browser Arial is the font boundary; retain native integer, independently measured advances. */
  measureAdvances() {
    for (let index = 0; index < PRINTABLE_COUNT; index++) {
      const character = String.fromCharCode(index + FIRST_PRINTABLE);
      const width = Math.round(this.context.measureText(character).width);
      if (width < 1 || width > this.parts.c.asset.width) {
        throw new Error("Speech font exceeds the ordinary glyph budget");
      }
      this.advances[index] = width;
    }
  }

  printable(text, maximum) {
    return (
      typeof text === "string" &&
      text.length >= 1 &&
      text.length <= maximum &&
      !/[^\x20-\x7e]/.test(text)
    );
  }

  /** Field speech formats the sender; native Cash preview 00978b2c passes only its edit text. */
  show(text, senderName = null) {
    if (
      !this.resource ||
      this.destroyed ||
      !this.scene ||
      this.scene.destroyed
    ) {
      return false;
    }
    if (
      !this.printable(text, CHAT_LIMIT) ||
      (senderName !== null && !this.printable(senderName, NAME_LIMIT))
    ) {
      return false;
    }
    this.syncDensity(this.app.renderer.resolution);
    if (text !== this.text || senderName !== this.senderName) {
      const shown = bubbleText(text);
      this.layoutText(senderName === null ? shown : `${senderName} : ${shown}`);
      this.layoutSkin();
      this.text = text;
      this.senderName = senderName;
    }
    this.remainingMs = DISPLAY_MS;
    // update() places it at the current avatar origin before making it visible.
    this.root.visible = false;
    return true;
  }

  /** Logical shaping happens only on submission; density changes only redraw existing lines. */
  layoutText(text) {
    const tile = this.parts.c.asset;
    const maximum = tile.width * MAX_COLUMNS;
    this.lines.length = 0;
    this.lineWidths.length = 0;
    let start = 0;
    for (
      let count = 0;
      start < text.length && count < this.maxTextUnits;
      count++
    ) {
      const end = speechLineEnd(text, start, maximum, this.advances);
      if (end <= start) throw new Error("Speech glyph exceeds its line budget");
      let trimmed = end;
      if (end < text.length) {
        // 00489b55..00489bd3 strips boundary whitespace, not punctuation or inner spaces.
        while (trimmed > start && text[trimmed - 1] === " ") trimmed--;
      }
      const line = text.slice(start, trimmed);
      this.lines.push(line);
      this.lineWidths.push(speechTextWidth(line, this.advances));
      start = end;
      while (start < text.length && text[start] === " ") start++;
    }
    if (start < text.length) throw new Error("Speech line budget exceeded");
    const columns =
      this.lines.length === 1
        ? Math.max(1, Math.ceil(this.lineWidths[0] / tile.width) | 1)
        : MAX_COLUMNS;
    this.width = columns * tile.width;
    this.height = this.lines.length * tile.height;
    this.rasterText();
  }

  /** Called by the renderer-density owner on resize, including while simulation is paused. */
  syncDensity(resolution) {
    if (this.destroyed || !this.textTexture || this.resolution === resolution) {
      return;
    }
    if (!Number.isFinite(resolution) || resolution <= 0) {
      throw new Error("Invalid speech text resolution");
    }
    this.resolution = resolution;
    this.textTexture.source.resize(this.textWidth, this.textHeight, resolution);
    this.context.setTransform(resolution, 0, 0, resolution, 0, 0);
    this.context.font = FONT;
    this.context.textBaseline = "alphabetic";
    // Canvas.dll50004d84 selects TA_TOP's font cell, not Canvas2D's em-square top.
    this.fontAscent = this.context.measureText("Mg").fontBoundingBoxAscent;
    if (!Number.isFinite(this.fontAscent) || this.fontAscent <= 0) {
      throw new Error("Speech font-cell metrics are unavailable");
    }
    this.context.fillStyle = this.textColor;
    this.rasterText();
  }

  rasterText() {
    this.context.clearRect(0, 0, this.textWidth, this.textHeight);
    this.context.save();
    this.context.beginPath();
    this.context.rect(
      0,
      0,
      this.width + this.leftMargin + this.rightMargin,
      this.height + this.topMargin + this.bottomMargin,
    );
    this.context.clip();
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      // 0048a806..0048a829 centers EACH line with signed integer division.
      let x =
        this.leftMargin + Math.trunc((this.width - this.lineWidths[i]) / 2);
      const y =
        this.topMargin - 1 + this.fontAscent + i * this.parts.c.asset.height;
      for (let character = 0; character < line.length; character++) {
        this.context.fillText(line[character], x, y);
        x += this.advances[line.charCodeAt(character) - FIRST_PRINTABLE];
      }
    }
    this.context.restore();
    this.textTexture.source.update();
  }

  /** 0048a029 replaces the middle bottom tile with arrow, preserving every WZ origin. */
  layoutSkin() {
    const width = this.width;
    const height = this.height;
    this.place("nw", 0, 0).visible = true;
    this.place("ne", width, 0).visible = true;
    this.place("sw", 0, height).visible = true;
    this.place("se", width, height).visible = true;
    sizeSprite(this.place("n", 0, 0), width);
    sizeSprite(this.place("w", 0, 0), this.parts.w.asset.width, height);
    sizeSprite(this.place("e", width, 0), this.parts.e.asset.width, height);
    sizeSprite(this.place("c", 0, 0), width, height);
    const half = (width - this.parts.c.asset.width) / 2;
    sizeSprite(this.place("s", 0, height), half);
    this.place("arrow", half, height).visible = true;
    const right = this.sprites.sRight;
    right.position.set(
      half + this.parts.c.asset.width - this.parts.s.asset.origin.x,
      height - this.parts.s.asset.origin.y,
    );
    right.width = half;
    right.height = this.parts.s.asset.height;
    right.visible = half > 0;
    this.textSprite.position.set(-this.leftMargin, -this.topMargin);
  }

  place(name, x, y) {
    const sprite = this.sprites[name];
    const asset = this.parts[name].asset;
    sprite.position.set(x - asset.origin.x, y - asset.origin.y);
    return sprite;
  }

  /** pose.headY is world feetY minus the original first-canvas avatar height (004519aa). */
  update(ms, pose, camera) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("Invalid speech elapsed milliseconds");
    }
    if (this.destroyed || !this.scene || this.remainingMs < 0) return;
    this.syncDensity(this.app.renderer.resolution);
    this.remainingMs -= ms;
    // 0048e6d4 keeps the layer at exact equality and releases it after the deadline.
    if (this.remainingMs < 0) {
      this.root.visible = false;
      return;
    }
    validateHeadAnchor(pose, camera);
    // 00489d66 centers at x+3; 0048e85a leaves five pixels above the first-canvas anchor.
    this.root.position.set(
      Math.round(pose.x + 3 - this.width / 2),
      Math.round(pose.headY - 5 - this.bottomMargin - this.height),
    );
    // No viewport clamping: the original field layer follows the character, not the HUD.
    this.root.visible = true;
  }

  snapshot() {
    return {
      authority: "offline-local-speech",
      ready: this.resource !== null,
      visible: Boolean(
        this.root.visible &&
        this.scene?.container.visible &&
        this.root.renderable &&
        !this.scene.destroyed,
      ),
      text: this.text,
      remainingMs: Math.max(0, this.remainingMs),
      lines: this.lines.length,
      width: this.width,
      lineText: this.lines.slice(),
      lineWidths: this.lineWidths.slice(),
      height: this.height,
      worldX: this.root.x,
      worldY: this.root.y,
      screenX: this.scene ? this.root.x - this.scene.camera.x : null,
      screenY: this.scene ? this.root.y - this.scene.camera.y : null,
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.scene) this.scene.removeWorldContainer(this.root);
    if (!this.root.destroyed) this.root.destroy(DESTROY_DISPLAY);
    this.textTexture?.destroy(true);
    if (this.ownsResource) this.resource?.destroy();
    for (const prepared of this.prepared) {
      prepared.texture.destroy(true);
    }
    this.prepared.length = 0;
    this.resource = null;
    this.scene = null;
    this.remainingMs = -1;
    this.lines = [];
    this.lineWidths = [];
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
  }
}
