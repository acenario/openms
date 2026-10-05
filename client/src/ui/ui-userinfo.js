import { JOB_LABELS } from "./ui-job-labels.js";
import { NativeScrollbar } from "./ui-scrollbar.js";
import { PROFILE_LIMITS } from "../profile/profile-validation.js";
import { replaceIcons } from "./ui-icons.js";
import { itemTooltip } from "./ui-tooltip.js";
import { monsterBookSummary } from "../character/monster-book.js";
import { isCustomQuest } from "../quests/custom-quests.js";

// 008ff863 mode-dependent original window dimensions and backgrounds.
const MODES = [
  { background: "backgrnd", height: 199, bottom: 177 },
  { background: "backgrnd2", height: 400, bottom: 378 },
  { background: "backgrnd5", height: 362, bottom: 340 },
  { background: "backgrnd7", height: 404, bottom: 382 },
];
const MODE_BUTTONS = [
  ["Pet", 93, 1],
  ["Taming", 5, 2],
  ["Collection", 145, 3],
];

/** Displays the selected loaded profile; absent ownership registries remain explicitly unavailable. */
export function layoutUserInfo(panel) {
  panel.userInfoMode = 0;
  panel.userInfoPages = [0, 0, 0, 0];
  panel.selectUserInfoMode = (mode) => selectMode(panel, mode);
  panel.localRefresh = () => refreshUserInfo(panel);
  selectMode(panel, 0);
}

function selectMode(panel, mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode >= MODES.length) {
    throw new Error("Invalid UserInfo mode");
  }
  panel.userInfoLayer?.destroy();
  panel.userInfoCollection = null;
  panel.userInfoCollectionSignature = null;
  panel.userInfoMode = mode;
  const style = MODES[mode];
  panel.height = style.height;
  panel.element.style.height = `${style.height}px`;
  const layer = panel.layer("Character information");
  panel.userInfoLayer = layer;
  panel.root.setChildIndex(layer.root, 0);
  layer.image(`UserInfo/${style.background}`, 0, 0);
  createActions(panel, layer);
  for (const [name, x, target] of MODE_BUTTONS) {
    layer.button(
      `UserInfo/Bt${name}${mode === target ? "Hide" : "Show"}`,
      x,
      style.bottom,
      {
        label: `${mode === target ? "Hide" : "Show"} ${name.toLowerCase()}`,
        action: () => selectMode(panel, mode === target ? 0 : target),
      },
    );
  }
  layer.button("UserInfo/BtExceptionShow", 199, style.bottom, {
    label: "Pet item exclusions",
    disabled: true,
    tooltip:
      "Pet pickup exclusion records are unavailable in the server projection.",
  });
  panel.userInfoValues = new Map();
  // 00901185 name centered at52; identity text rows begin at160,77.
  const name = layer.text("", 8, 144, 88);
  name.style.textAlign = "center";
  panel.userInfoValues.set("name", name);
  for (const [key, y] of [
    ["level", 77],
    ["job", 96],
    ["fame", 115],
    ["guild", 134],
    ["alliance", 153],
  ]) {
    panel.userInfoValues.set(key, layer.text("", 160, y, 104));
  }
  panel.userInfoPortrait = panel.owner.hooks.userInfoPortrait?.(layer, {
    x: 52,
    y: 133,
  });
  const portrait = panel.userInfoPortrait;
  if (portrait) {
    layer.cleanups.push(() => portrait.destroy());
    portrait.useSurfaceClock();
  }
  createModeBody(panel, layer);
  refreshUserInfo(panel);
  panel.owner.positionWindow(panel, panel.x, panel.y);
  panel.renderArtwork();
}

function createActions(panel, layer) {
  layer.button("UserInfo/BtItem", 208, 22, {
    label: "Equipped items",
    action: () => toggleAttachment(panel, "items"),
  });
  layer.button("UserInfo/BtWish", 208, 41, {
    label: "Wish list",
    action: () => toggleAttachment(panel, "wish"),
  });
  // 008ff6fc..008ff75b: self opens Family; another name requests that character's FamilyTree.
  layer.button("UserInfo/BtFamily", 105, 23, {
    label: "Family",
    action: () =>
      userInfoAction(panel, () =>
        panel.owner.hooks.userInfoFamily(panel.owner.hooks.userInfoProfile()),
      ),
  });
  layer.button("BtUP", 237, 114, {
    label: "Raise fame",
    disabled: true,
    tooltip: "Fame changes require a connected character service.",
  });
  layer.button("BtDown", 252, 114, {
    label: "Lower fame",
    disabled: true,
    tooltip: "Fame changes require a connected character service.",
  });
  panel.userInfoParty = layer.button("UserInfo/BtParty", 149, 23, {
    label: "Invite to party",
    action: () =>
      userInfoAction(panel, () =>
        panel.owner.hooks.userInfoParty(panel.owner.hooks.userInfoProfile()),
      ),
  });
  layer.button("UserInfo/BtTrade", 149, 42, {
    label: "Local trade simulation",
    tooltip: "Trade with the selected loaded local character.",
    action: () =>
      userInfoAction(panel, () => panel.owner.hooks.openLocalTrade()),
  });
}

async function userInfoAction(panel, action) {
  try {
    const result = await action();
    if (result?.ok === false && result.code !== "cancelled") {
      panel.owner.notice(result.reason);
    }
  } catch (error) {
    panel.owner.report(error);
  }
}

function createModeBody(panel, layer) {
  const mode = panel.userInfoMode;
  if (!mode) return;
  const top = mode === 1 ? 215 : mode === 2 ? 177 : 298;
  const extent = mode === 3 ? 73 : 112;
  panel.userInfoBody = layer.contentArea(16, top, 229, extent);
  panel.userInfoBody.style.overflow = "hidden";
  panel.userInfoScrollbar = new NativeScrollbar(
    layer,
    { x: 252, y: top, extent },
    (position) => {
      panel.userInfoPages[mode] = position;
      refreshModeBody(panel);
    },
  );
}

export function refreshUserInfo(panel) {
  if (panel.disposed) return;
  const profile = panel.owner.hooks.userInfoProfile?.();
  if (!profile) return;
  for (const [key, element] of panel.userInfoValues) {
    element.textContent = userInfoValue(profile, key);
  }
  const party = panel.owner.store.profile.social.party;
  panel.userInfoParty.setDisabled(
    profile === panel.owner.store.profile ||
      !party ||
      party.leaderId !== panel.owner.store.id,
  );
  panel.userInfoPortrait?.refresh(profile).catch((error) => {
    if (error.name !== "AbortError" && !panel.disposed) {
      panel.owner.report(error);
    }
  });
  refreshModeBody(panel);
  refreshAttachment(panel, profile);
}

function userInfoValue(profile, key) {
  if (key === "job") return JOB_LABELS[profile.job] || "Unknown job";
  if (key === "guild" || key === "alliance") {
    return profile.social[key]?.name ?? "";
  }
  return String(profile[key] ?? "");
}

function refreshModeBody(panel) {
  const mode = panel.userInfoMode;
  if (!mode) return;
  if (mode === 3) {
    refreshCollection(panel, panel.owner.hooks.userInfoProfile());
    return;
  }
  // No saved pet/mount actor exists; empty native fields do not manufacture ownership.
  panel.userInfoBody.replaceChildren();
  panel.userInfoScrollbar.setRange(1, 0);
}

/** 008ff2c7/008ff3ce: mutually exclusive attached240x162 item and wish lists. */
function toggleAttachment(panel, kind) {
  const previous = panel.userInfoAttachment;
  previous?.layer.destroy();
  panel.userInfoAttachment = null;
  if (previous?.kind === kind) {
    panel.owner.positionWindow(panel, panel.x, panel.y);
    panel.renderArtwork();
    return;
  }
  const layer = panel.layer(
    kind === "items" ? "Character equipped items" : "Character wish list",
  );
  layer.width = 240;
  layer.height = 162;
  layer.element.style.width = "240px";
  layer.element.style.height = "162px";
  // 00900dec attaches either child at parent.x +270 and parent.y.
  layer.position(270, 0);
  const state = { kind, layer, scrollbar: null, signature: null };
  panel.userInfoAttachment = state;
  try {
    layer.image(
      `UserInfo/${kind === "items" ? "backgrnd4" : "backgrnd3"}`,
      0,
      0,
    );
    layer.button("BtHide", 220, 6, {
      label: kind === "items" ? "Hide equipped items" : "Hide wish list",
      action: () => toggleAttachment(panel, kind),
    });
    state.scrollbar = new NativeScrollbar(
      layer,
      { x: 218, y: 33, extent: 112, style: 3 },
      () => refreshAttachment(panel, panel.owner.hooks.userInfoProfile()),
    );
    refreshAttachment(panel, panel.owner.hooks.userInfoProfile());
  } catch (error) {
    layer.destroy();
    panel.userInfoAttachment = null;
    panel.owner.report(error);
  }
  panel.owner.positionWindow(panel, panel.x, panel.y);
  panel.renderArtwork();
}

/** 00903e24 lists visible and covered equipment; pet/mount actors are separate native bodies. */
function userInfoEquipment(profile) {
  if (
    !Array.isArray(profile?.equipment) ||
    profile.equipment.length > PROFILE_LIMITS.equipment
  ) {
    throw new Error("Invalid UserInfo equipment records");
  }
  const records = [];
  for (const item of profile.equipment) {
    const position = -item.slot;
    const slot = position > 100 ? position - 100 : position;
    if (
      slot === 0 ||
      slot === 14 ||
      (slot >= 18 && slot <= 20) ||
      slot >= 52 ||
      Math.floor(item.id / 10000) === 181
    ) {
      continue;
    }
    records.push({ id: item.id, slot, cash: position > 100 });
  }
  // The separate170 cash weapon is inserted first at slot11; other covered items precede overlays.
  records.sort(
    (left, right) =>
      left.slot - right.slot ||
      (left.slot === 11
        ? Number(right.cash) - Number(left.cash)
        : Number(left.cash) - Number(right.cash)),
  );
  return records;
}

function refreshAttachment(panel, profile) {
  const state = panel.userInfoAttachment;
  if (!state || state.layer.disposed || !profile) return;
  const records =
    state.kind === "items"
      ? userInfoEquipment(profile)
      : userInfoWishes(panel, profile);
  const count = Math.max(1, records.length - 2);
  state.scrollbar.setRange(
    count,
    Math.min(state.scrollbar.position, count - 1),
  );
  const start = state.scrollbar.position;
  const visible = records.slice(start, start + 3);
  const signature = JSON.stringify([profile.name, start, visible]);
  if (state.signature === signature) return;
  state.signature = signature;
  for (const record of visible) {
    record.template =
      panel.owner.index.items[record.id] ??
      panel.owner.index.cashShop.specialItems[record.id];
    if (!record.template?.descriptor || !record.template.iconPath) {
      state.signature = null;
      throw new Error(`Original UserInfo item ${record.id} is not packaged`);
    }
  }
  replaceIcons(state.layer, visible, (layer, record, row) =>
    drawUserInfoItem(panel, layer, record, row),
  ).catch((error) => panel.owner.report(error));
}

/** 008fd648..008fd9c2: three rows, icon feet(17,64), name(57,32), ReqLv(57,53), value(93,50). */
function drawUserInfoItem(panel, layer, record, row) {
  const y = row * 40;
  layer.image(record.template.iconPath, 17, 64 + y, true);
  const name = layer.text(
    record.sn && record.count > 1
      ? `${record.template.name} (${record.count})`
      : record.template.name,
    57,
    32 + y,
    153,
  );
  name.style.cssText +=
    ";font:12px/14px Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  if (record.sn) {
    layer.button("UserInfo/BtPresent", 165, 50 + y, {
      label: `Gift ${record.template.name}`,
      disabled:
        panel.owner.hooks.userInfoProfile() === panel.owner.store.profile,
      action: () =>
        userInfoAction(panel, () =>
          panel.owner.hooks.userInfoGift(
            panel.owner.hooks.userInfoProfile(),
            record.sn,
          ),
        ),
    });
  } else {
    layer.image("UserInfo/ReqLv", 57, 53 + y);
    const level = layer.text(
      String(record.template.info?.reqLevel ?? 0),
      93,
      50 + y,
      117,
    );
    level.style.cssText += ";font:12px/14px Arial,sans-serif;";
  }
  layer.hit(
    record.template.name,
    { x: 17, y: 32 + y, width: 32, height: 32 },
    {},
    {
      tooltip: () => ({
        ...itemTooltip(
          { store: { profile: panel.owner.hooks.userInfoProfile() } },
          record.template,
          record.id,
          { equipped: !record.sn },
        ),
        source: { surface: layer, path: record.template.iconPath },
      }),
    },
  );
}

function userInfoWishes(panel, profile) {
  return profile.cash.wishlist.map((sn) => {
    const offer = panel.owner.index.cashShop.commodities[sn];
    if (!offer) {
      throw new Error(`Original wish-list commodity ${sn} is not packaged`);
    }
    return { sn, id: offer.itemId, count: offer.count };
  });
}

/** 00902af6..00903539 and the original character-info packet's book/medal fields. */
function refreshCollection(panel, profile) {
  const data = panel.owner.hooks.monsterBook().data;
  const summary = monsterBookSummary(profile.monsterBook);
  const medals = Object.entries(profile.quests)
    // Custom job quests (100000–100011) share the ≥29000 range but are state-only rows, not medals.
    .filter(
      ([id, state]) =>
        Number(id) >= 29000 && state.state === 2 && !isCustomQuest(id),
    )
    .sort(([left], [right]) => Number(left) - Number(right));
  const equipped = profile.equipment.find((item) => item.slot === -49);
  const count = Math.max(1, medals.length - 3);
  panel.userInfoScrollbar.setRange(
    count,
    Math.min(panel.userInfoPages[3], count - 1),
  );
  const start = panel.userInfoScrollbar.position;
  const signature = JSON.stringify([summary, medals, equipped, start]);
  if (signature === panel.userInfoCollectionSignature) return;
  panel.userInfoCollectionSignature = signature;
  panel.userInfoCollection?.destroy();
  const layer = panel.userInfoLayer.layer("Monster Book and medal collection");
  panel.userInfoCollection = layer;
  layer.image(`MonsterBook/icon/${summary.level - 1}`, 14, 182);
  layer.text(String(summary.level), 101, 181, 160);
  layer.text(data.cards[summary.cover]?.name ?? "", 101, 199, 160);
  layer.text(String(summary.total), 101, 217, 42);
  layer.text(String(summary.normal), 168, 217, 42);
  layer.text(String(summary.special), 236, 217, 30);
  layer.text(String(medals.length), 101, 265, 160);
  for (let row = 0; row < Math.min(4, medals.length - start); row++) {
    const quest = panel.owner.quests.catalog.records[medals[start + row][0]];
    const template = panel.owner.index.items[quest?.info?.viewMedalItem];
    if (template) layer.text(template.name, 52, 301 + row * 18, 193);
  }
  if (equipped) drawCollectionMedal(panel, layer, equipped);
}

function drawCollectionMedal(panel, layer, equipped) {
  const template = panel.owner.index.items[equipped.id];
  if (!template?.descriptor || !template.iconPath) {
    throw new Error(`Original equipped medal ${equipped.id} is not packaged`);
  }
  layer.text(template.name, 101, 247, 160);
  replaceIcons(layer, [{ template }], (icons) => {
    icons.image(template.iconPath, 8, 278, true);
    icons.hit(
      template.name,
      { x: 8, y: 246, width: 32, height: 32 },
      {},
      {
        tooltip: () => ({
          ...itemTooltip(
            { store: { profile: panel.owner.hooks.userInfoProfile() } },
            template,
            equipped.id,
            { equipped: true },
          ),
          source: { surface: icons, path: template.iconPath },
        }),
      },
    );
  }).catch((error) => panel.owner.report(error));
}
