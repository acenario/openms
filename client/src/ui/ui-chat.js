import { Graphics } from "pixi.js";
import { HUD_CLIENT_Y } from "./ui-hud.js";
import { ChatChannels } from "../social/chat-channels.js";
import { ChatLog } from "./chat-log.js";
import {
  CHAT_LIMIT,
  CHAT_RATE_LIMITS,
  sanitizeChat,
  admitChat,
} from "../social/chat-rules.js";

// 00490701 bounds history to eight; 008d379a selects 70 for ordinary users.
const HISTORY_LIMIT = 8;
const REPEAT_WINDOW_MS = CHAT_RATE_LIMITS.repeat;
const FLOOD_WINDOW_MS = CHAT_RATE_LIMITS.flood;
const FLOOD_COOLDOWN_MS = CHAT_RATE_LIMITS.cooldown;
// UI.wz:StatusBar.img/base/backgrnd2: textbox rows0..28; row29 begins the lower HUD gap.
const TEXTBOX_ROWS = 29;
export const CHAT_CHANNELS = Object.freeze([
  "To a buddy",
  "To Group",
  "To the party",
  "To the Guild",
  "To Alliance",
  "To Spouse",
  "Whisper",
  "To All",
]);
// 008d57aa jump table / 008d53cd..008d542b.
const NEXT_CHANNEL = [5, 2, 3, 4, 6, 1, 7, 0];

function validChannelIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < CHAT_CHANNELS.length;
}

/** 008d536c and 008dfb36: edit child is distinct from the log child. */
export class UIChat {
  constructor(owner, panel) {
    this.owner = owner;
    this.panel = panel;
    this.state = 1;
    this.height = 70;
    this.history = [];
    this.historyIndex = 0;
    this.recalledSubmission = false;
    this.recent = [];
    this.recentStarted = -Infinity;
    this.submitTimes = new Float64Array(4).fill(-Infinity);
    this.submitIndex = 0;
    this.blockedUntil = -Infinity;
    this.composing = false;
    this.pending = false;
    this._submission = null;
    this.disposed = false;
    this.messages = new ChatLog(panel);
    this.log = this.messages.element;
    this.createTextboxBacking();
    this.layer = panel.layer("Chat input", { isolated: true });
    // Keep editor and channel popup above the log, within the HUD's own stacking context.
    this.layer.element.style.zIndex = "3";
    this.layer.listen(this.layer.element, "focusin", () => {
      this.owner.hooks.clearInput();
    });
    this.createInput();
    this.createSelector();
    this.maximum = this.backing.button("BtMax", 536, HUD_CLIENT_Y + 519, {
      label: "Expand chat",
      action: () => {
        this.setState(3);
        this.input.focus();
      },
    });
    this.minimum = this.backing.button("BtMin", 536, HUD_CLIENT_Y + 519, {
      label: "Minimize chat",
      action: () => this.close(),
    });
    this.maximum.element.style.zIndex = "3";
    this.minimum.element.style.zIndex = "3";
    this.resizeHighlight = panel.image("base/chat", 0, HUD_CLIENT_Y + 434);
    this.resizeHighlight.container.visible = false;
    this.grip = panel.hit(
      "Resize chat",
      { x: 0, y: HUD_CLIENT_Y + 435, width: 580, height: 10 },
      {
        pointerdown: (event) => this.beginResize(event),
        pointerenter: () => {
          this.resizeHighlight.container.visible = true;
        },
        pointerleave: () => {
          if (!this.resizeStart) this.resizeHighlight.container.visible = false;
        },
      },
    );
    this.grip.dataset.cursorState = "7";
    this.grip.style.zIndex = "1";
    this.grip.hidden = true;
    this.setState(1);
  }

  /** The native cd0 backing is independent of edit children; keep the reported minimized log behind it. */
  createTextboxBacking() {
    this.log.style.zIndex = "1";
    const path = "base/backgrnd2";
    const asset = this.panel.assets[path];
    this.hudBacking = this.panel.sprites.find((sprite) => sprite.id === path);
    if (!this.hudBacking || !asset || asset.height <= TEXTBOX_ROWS) {
      throw new Error("Chat textbox backing is missing from the HUD");
    }
    this.backing = this.panel.layer("Chat textbox backing", { isolated: true });
    this.backing.element.style.zIndex = "2";
    const strip = this.backing.image(path, 2, HUD_CLIENT_Y + 507);
    strip.container.rasterClip = {
      x: 0,
      y: 0,
      width: asset.width,
      height: TEXTBOX_ROWS,
    };
    // Do not paint the translucent WZ strip twice. The original Pixi image keeps only the lower HUD.
    this.backingMask = new Graphics()
      .rect(0, TEXTBOX_ROWS, asset.width, asset.height - TEXTBOX_ROWS)
      .fill(0xffffff);
    this.backingMask.eventMode = "none";
    this.hudBacking.container.addChild(this.backingMask);
    this.hudBacking.container.mask = this.backingMask;
  }

  createInput() {
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.maxLength = CHAT_LIMIT;
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Chat message");
    // The edit owns its backing; a transparent black-text input leaks the world/log through it.
    this.input.style.cssText = `position:absolute;left:85px;top:${HUD_CLIENT_Y + 520}px;width:440px;height:12px;padding:0;border:0;outline:0;background:#fff;color:#000;font:12px Arial,sans-serif;line-height:12px;pointer-events:auto;user-select:text;`;
    this.layer.element.append(this.input);
    this.layer.listen(this.input, "compositionstart", () => {
      this.composing = true;
    });
    this.layer.listen(this.input, "compositionend", () => {
      this.composing = false;
    });
    this.layer.listen(this.input, "blur", () => {
      this.owner.hooks.clearInput();
    });
    this.layer.listen(this.input, "focus", () => {
      if (this.state === 1) this.setState(2);
      this.owner.hooks.clearInput();
    });
  }

  createSelector() {
    this.selector = new ChatChannels(this.layer, CHAT_CHANNELS, () =>
      this.open(),
    );
  }

  setState(state, publish = true) {
    const changed = state !== this.state;
    // Minimize only the history. The channel selector and draft remain usable.
    if (state === 1 && this.layer.element.contains(document.activeElement)) {
      document.activeElement.blur();
      this.composing = false;
    }
    this.state = state;
    this.layer.root.visible = true;
    this.layer.element.hidden = false;
    this.layer.element.inert = false;
    this.grip.hidden = state !== 3;
    this.maximum.setVisible(state !== 3);
    this.minimum.setVisible(state === 3);
    this.resizeHighlight.container.visible = false;
    // Native stored height may become a two-pixel-larger span (including 507 -> 509).
    const expanded = this.height + (this.height % 13 === 0 ? 2 : 0);
    this.resizeHighlight.setPosition(0, HUD_CLIENT_Y + 504 - expanded);
    const top = state === 3 ? 510 - expanded : state === 1 ? 513 : 486;
    const height = state === 3 ? expanded - 2 : 25;
    this.log.style.top = `${HUD_CLIENT_Y + top}px`;
    this.log.style.height = `${height}px`;
    // Compact history is intentionally hidden per the requested presentation.
    // Keep native child geometry/scroll layout; delivery must not reveal old rows.
    this.log.style.visibility = state === 3 ? "visible" : "hidden";
    this.log.inert = state !== 3;
    // 008dbf61 fills the expanded log with ARGB 0x80000000, never a compact overlay.
    this.log.style.background =
      state === 3 ? "rgba(0,0,0,0.5019607843)" : "transparent";
    this.grip.style.top = `${HUD_CLIENT_Y + 504 - expanded}px`;
    this.selector.show(false);
    this.owner.hooks.clearInput();
    this.publishStateChange(publish, changed);
  }
  publishStateChange(publish, changed) {
    if (publish && changed && !this.resizeStart) this.publishSettings();
  }

  open() {
    this.setState(this.state === 3 ? 3 : 2);
    this.input.focus();
  }

  close(clear = false) {
    if (clear) this.input.value = "";
    this.input.blur();
    this.setState(1);
    this.owner.hooks.focusGame();
  }

  /** 008d5aaf releases edit focus without minimizing an expanded log. */
  exitEdit(clear = false) {
    if (clear) this.input.value = "";
    if (this.state === 2) this.setState(1);
    this.input.blur();
    this.owner.hooks.focusGame();
  }

  handle(event) {
    if (this.selector.handle(event)) return true;
    if (event.target !== this.input) return false;
    event.stopImmediatePropagation();
    // keyCode 229 covers browser IME Enter delivery with isComposing already false.
    if (event.isComposing || this.composing || event.keyCode === 229) {
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      this.selector.selectedIndex = NEXT_CHANNEL[this.selector.selectedIndex];
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.repeat) return true;
      if (this.input.value) {
        this.submit().catch((error) => this.owner.report(error));
      } else this.exitEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.exitEdit(true);
    } else {
      this.handleNavigationKey(event);
    }
    return true;
  }

  /** Empty horizontal movement leaves the edit; vertical movement recalls history. */
  handleNavigationKey(event) {
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !this.input.value
    ) {
      event.preventDefault();
      this.exitEdit();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      this.recall(event.key === "ArrowUp" ? -1 : 1);
    }
  }

  /** Submit the real edit buffer; outcomes distinguish local admission from server delivery. */
  async submit() {
    // 008d549f sanitizes non-ASCII bytes; trim helpers are 00474414/004744c9.
    if (this.pending) return { accepted: false, reason: "chat-pending" };
    const text = sanitizeChat(this.input.value);
    this.input.value = "";
    if (!text) {
      this.exitEdit();
      return { accepted: false, reason: "empty-chat" };
    }
    const result = this.submitText(text);
    this.input.focus();
    return result;
  }

  /** The native input owns original history/flood gates; the local authority owns routing. */
  async submitText(text, channelIndex = this.selector.selectedIndex) {
    const rejection = this.#submissionRejection(text, channelIndex);
    if (rejection) return rejection;
    text = sanitizeChat(text);
    if (!text) return { accepted: false, reason: "empty-chat" };
    const now = this.owner.hooks.now?.() ?? performance.now();
    if (!Number.isFinite(now) || now < 0) {
      return { accepted: false, reason: "invalid-chat-clock" };
    }
    if (!this.admit(text, now)) {
      return {
        accepted: false,
        reason: "chat-rate-limit",
        retryAt: this.blockedUntil,
      };
    }
    this.pending = true;
    this._submission = this.submitToAuthority(text, channelIndex);
    return this._submission;
  }

  #submissionRejection(text, channelIndex) {
    if (this.disposed || this.pending || this.composing) {
      return { accepted: false, reason: "chat-blocked" };
    }
    if (typeof text !== "string" || text.length > CHAT_LIMIT) {
      this.owner.status(`Chat is limited to ${CHAT_LIMIT} characters.`);
      return { accepted: false, reason: "chat-length" };
    }
    if (!validChannelIndex(channelIndex)) {
      return { accepted: false, reason: "invalid-chat-channel" };
    }
    return null;
  }

  waitForIdle() {
    return this._submission ?? Promise.resolve();
  }

  async submitToAuthority(text, channelIndex) {
    try {
      const result = await this.owner.hooks.onChatSubmit?.(text, channelIndex);
      if (!result || typeof result.accepted !== "boolean") {
        throw new TypeError(
          "Chat authority returned no explicit submission outcome",
        );
      }
      if (this.disposed) return result;
      this.submissionOutcome(result, text);
      return result;
    } catch (error) {
      this.owner.report(error);
      return { accepted: false, reason: error.message ?? "chat-failed" };
    } finally {
      this.pending = false;
    }
  }

  submissionOutcome(result, text) {
    if (!result.accepted) {
      if (
        result.delivery === "channel-selected" &&
        validChannelIndex(result.channelIndex)
      ) {
        this.selector.selectedIndex = result.channelIndex;
      }
      this.owner.status(
        result.reason ?? "The local chat authority did not accept the message.",
      );
      return;
    }
    if (
      result.delivery !== "local-only" &&
      result.delivery !== "local-session" &&
      result.delivery !== "server" &&
      result.delivery !== "pending"
    ) {
      throw new TypeError(
        "Chat authority did not identify a supported delivery",
      );
    }
    this.remember(text);
    if (result.delivery === "server" || result.delivery === "pending") return;
    this.owner.status(
      result.delivery === "local-only"
        ? "Local speech displayed; not sent to a server."
        : "Delivered to the permitted loaded local participants; no server was contacted.",
    );
  }

  /** Enter text through this edit owner, without DOM event synthesis or bypassing submission. */
  async send(text, channel = this.selector.selectedIndex) {
    if (typeof text !== "string" || text.length > CHAT_LIMIT) {
      return { accepted: false, reason: "chat-length", maximum: CHAT_LIMIT };
    }
    const index =
      typeof channel === "string" ? CHAT_CHANNELS.indexOf(channel) : channel;
    if (!validChannelIndex(index)) {
      return { accepted: false, reason: "invalid-chat-channel" };
    }
    if (
      this.pending ||
      this.disposed ||
      this.composing ||
      this.owner.blocksGameplay() ||
      !this.owner.visible
    ) {
      return { accepted: false, reason: "chat-blocked" };
    }
    this.open();
    this.selector.selectedIndex = index;
    this.input.value = text;
    return this.submit();
  }

  /** Demand-only metadata for normal input clients; limits are owned here, not copied by callers. */
  describe() {
    return {
      maximum: CHAT_LIMIT,
      channels: CHAT_CHANNELS.slice(),
      selectedChannel: this.selector.selectedIndex,
      localChannel: 7,
      repeatWindowMs: REPEAT_WINDOW_MS,
      floodWindowMs: FLOOD_WINDOW_MS,
      floodCooldownMs: FLOOD_COOLDOWN_MS,
      blockedUntil: Number.isFinite(this.blockedUntil)
        ? this.blockedUntil
        : null,
    };
  }

  applySettings(settings) {
    if (
      !Number.isInteger(settings.height) ||
      settings.height < 26 ||
      settings.height > 507 ||
      ![1, 2, 3].includes(settings.state)
    ) {
      throw new TypeError("Invalid chat configuration");
    }
    this.height = settings.height;
    this.setState(settings.state, false);
  }

  /** Producers own received records and explicitly pending local feedback. */
  receive(record) {
    this.messages.append(record);
    if (record.source === "local-system" || record.source === "gameplay") {
      this.owner.notices?.publishSimple(record.text);
    }
  }

  queryLog(offset = 0, limit = 20) {
    return this.messages.page(offset, limit);
  }

  /** 004904be: four equal messages / 30 s or four submissions / 2 s block for 2800 ms. */
  admit(text, now) {
    if (admitChat(this, text, now)) return true;
    this.owner.status(
      "Chat is too frequent; wait 2.8 seconds before speaking again.",
    );
    return false;
  }

  remember(text) {
    if (this.history[this.history.length - 1] !== text) {
      if (this.history.length === HISTORY_LIMIT) {
        this.history.shift();
        this.historyIndex--;
      }
      this.history.push(text);
    }
    this.recalledSubmission = this.history[this.historyIndex] === text;
    if (!this.recalledSubmission) this.historyIndex = this.history.length;
  }

  recall(direction) {
    if (!this.history.length) return;
    // 0049081b/004908a4 clamp to first/last history entry, not an invented saved draft.
    if (direction < 0 && this.recalledSubmission) {
      this.historyIndex++;
      this.recalledSubmission = false;
    }
    this.historyIndex = Math.max(
      0,
      Math.min(this.history.length - 1, this.historyIndex + direction),
    );
    this.input.value = this.history[this.historyIndex];
    this.input.setSelectionRange(
      this.input.value.length,
      this.input.value.length,
    );
  }

  beginResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.resizeStart = { y: event.clientY, height: this.height };
  }

  move(event) {
    if (!this.resizeStart) return;
    const delta =
      (this.resizeStart.y - event.clientY) / this.owner.screenScaleY;
    if (Math.abs(delta) < 14) return;
    this.height = Math.max(
      26,
      Math.min(507, this.resizeStart.height + Math.trunc(delta / 13) * 13),
    );
    this.setState(3);
  }

  publishSettings() {
    this.owner.hooks.onChatSettings?.({
      state: this.state,
      height: this.height,
    });
  }
  endResize() {
    if (this.resizeStart) this.publishSettings();
    this.resizeStart = null;
    this.resizeHighlight.container.visible = false;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.layer.destroy();
    this.hudBacking.container.mask = null;
    this.backingMask.removeFromParent();
    this.backingMask.destroy();
    this.backing.destroy();
    this.messages.destroy();
    this.grip.remove();
  }
}
