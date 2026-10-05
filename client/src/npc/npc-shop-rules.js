import { profileError } from "../profile/profile-validation.js";
import {
  consumeItem,
  consumeTemplate,
  effectiveItemStackLimit,
  grantItem,
  inventoryType,
  isRechargeable,
  itemCount,
} from "../items/inventory-model.js";

export const SHOP_LIMITS = Object.freeze({
  rows: 8192,
  /** Cosmic `Shop` row `ShopItem((short) 1000, ...)`, sent as the open-shop row's max-per-slot short. */
  quantity: 1000,
  mesos: 2147483647,
  listeners: 64,
});
export const SHOP_PITCH_ITEM = 4000517;

/** Native/Cosmic commerce amounts are whole units, never floating currency. */
export function shopInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw profileError("shop-value", `Invalid shop ${field}.`);
  }
  return value;
}

/** Main supplies only an admitted literal shop, never candidate SQL/script dependencies. */
export function shopRows(context) {
  shopInteger(context.shopId, 1, SHOP_LIMITS.mesos, "ID");
  if (!Array.isArray(context.rows) || context.rows.length > SHOP_LIMITS.rows) {
    throw profileError(
      "shop-rows",
      "The authored shop rows are unavailable or exceed the package limit.",
    );
  }
  const rows = [];
  const sources = new Set();
  let position = Infinity;
  for (const input of context.rows) {
    if (!input || input.shopId !== context.shopId) {
      throw profileError("shop-row", "The row belongs to another shop.");
    }
    inventoryType(input.itemId);
    shopInteger(input.price, 0, SHOP_LIMITS.mesos, "price");
    shopInteger(input.pitch, 0, SHOP_LIMITS.mesos, "pitch price");
    shopInteger(
      input.position,
      -SHOP_LIMITS.mesos - 1,
      SHOP_LIMITS.mesos,
      "position",
    );
    shopInteger(input.sourceRow, 0, Number.MAX_SAFE_INTEGER, "source row");
    if (position < input.position || sources.has(input.sourceRow)) {
      throw profileError(
        "shop-order",
        "Shop rows must retain distinct SQL row identities in position DESC order.",
      );
    }
    position = input.position;
    sources.add(input.sourceRow);
    rows.push(
      Object.freeze({
        shopId: input.shopId,
        itemId: input.itemId,
        price: input.price,
        pitch: input.pitch,
        position: input.position,
        sourceRow: input.sourceRow,
      }),
    );
  }
  return Object.freeze(rows);
}

export function shopTemplate(items, id) {
  const template = items[id];
  if (
    !template?.descriptor ||
    template.id !== id ||
    !template.info ||
    !template.source
  ) {
    throw profileError(
      "item-unavailable",
      `Original item metadata and artwork are unavailable for ${id}.`,
    );
  }
  return template;
}

/** Native 00754499..ee: quest, notSale, cash and expiring instances are excluded.
 * 00756a99 additionally blocks sealed items. Trade-block alone is NOT a sell restriction.
 */
export function saleItem(profile, items, uid) {
  const entry = profile.inventory.find((item) => item.uid === uid);
  return saleEntry(entry, items);
}

/** Already-owned instance projection avoids a second inventory scan for every displayed row. */
export function saleEntry(entry, items) {
  if (!entry || entry.slot <= 0) {
    throw profileError(
      "item-missing",
      "The selected inventory item is no longer available.",
    );
  }
  const template = shopTemplate(items, entry.id);
  if (
    template.info.quest ||
    template.info.notSale ||
    template.info.cash ||
    entry.expiresAt !== null
  ) {
    throw profileError(
      "item-not-saleable",
      "This item cannot be sold to an NPC shop.",
    );
  }
  return { entry, template };
}

/** Cosmic ItemInformationProvider.getRoundedUnitPrice uses five binary fraction bits.
 * Preserve its halfway-up choice rather than decimal rounding of the WZ double.
 */
export function shopUnitPrice(template) {
  const value = template.info.unitPrice ?? 0;
  if (!Number.isFinite(value) || value < 0 || value > SHOP_LIMITS.mesos) {
    throw profileError(
      "item-price",
      "Original rechargeable unit price is invalid.",
    );
  }
  return Math.floor(value * 32 + 0.5) / 32;
}

/** Selling uses WZ info/price, plus remaining ammunition's unitPrice, never SQL buy price. */
export function salePrice(template, count) {
  const price = template.info.price ?? -1;
  shopInteger(price, -1, SHOP_LIMITS.mesos, "item sale price");
  if (price === -1) {
    throw profileError(
      "item-price",
      "The original item has no NPC sale price.",
    );
  }
  const amount = isRechargeable(template.id)
    ? price + Math.ceil(count * shopUnitPrice(template))
    : price * count;
  return shopInteger(amount, 0, SHOP_LIMITS.mesos, "sale proceeds");
}

function paymentPrice(row) {
  if (row.price > 0) return { currency: "meso", price: row.price };
  if (row.pitch > 0) return { currency: "pitch", price: row.pitch };
  throw profileError(
    "shop-recharge-only",
    "This authored row has no purchase price; it is not a free item.",
  );
}

/**
 * Largest single purchase of one shop row. The v83 client prompts for a count only for
 * non-rechargeable Use/Setup/Etc items (`004284be`); every other row is a yes/no buy of
 * one (`007561c1`, string 0x350). The prompt's maximum is the row's max-per-slot short
 * decoded at `007529ad` (row+0x30, passed to the number dialog at `00756522`), not the
 * item's slotMax or the affordable count; mesos are checked after the prompt.
 */
export function shopBuyLimit(itemId) {
  const type = inventoryType(itemId);
  return type >= 2 && type <= 4 && !isRechargeable(itemId)
    ? SHOP_LIMITS.quantity
    : 1;
}

function admitPurchase(profile, template, count) {
  if (Math.floor(template.id / 1000) === 5000) {
    throw profileError(
      "shop-pet-item",
      "This item requires its original pet instance authority.",
    );
  }
  shopInteger(count, 1, shopBuyLimit(template.id), "purchase quantity");
  if (
    template.info.only === 1 &&
    (count > 1 ||
      profile.inventory.some((entry) => entry.id === template.id) ||
      profile.equipment.some((entry) => entry.id === template.id))
  ) {
    throw profileError(
      "unique-item",
      "You cannot carry more than one for this item.",
    );
  }
}

function admitPitch(profile, items, amount) {
  shopTemplate(items, SHOP_PITCH_ITEM);
  if (itemCount(profile, SHOP_PITCH_ITEM) < amount) {
    throw profileError(
      "insufficient-pitch",
      "You do not have enough Perfect Pitch.",
    );
  }
  for (const entry of profile.inventory) {
    if (entry.id !== SHOP_PITCH_ITEM) continue;
    if (
      entry.flags & 1 ||
      (entry.expiresAt !== null && entry.expiresAt <= Date.now())
    ) {
      throw profileError(
        "pitch-unavailable",
        "The payment includes sealed or expired Perfect Pitch.",
      );
    }
  }
}

export function buyQuote(profile, items, row, count) {
  if (!row) {
    throw profileError("shop-row", "Select an authored shop item first.");
  }
  const template = shopTemplate(items, row.itemId);
  admitPurchase(profile, template, count);
  const payment = paymentPrice(row);
  const amount = shopInteger(
    payment.price * count,
    1,
    SHOP_LIMITS.mesos,
    "purchase total",
  );
  if (payment.currency === "meso" && profile.meso < amount) {
    throw profileError("insufficient-mesos", "You do not have enough mesos.");
  }
  if (payment.currency === "pitch") admitPitch(profile, items, amount);
  const units = isRechargeable(template.id)
    ? effectiveItemStackLimit(profile, template)
    : count;
  return {
    kind: "buy",
    itemId: template.id,
    template,
    count,
    units,
    amount,
    currency: payment.currency,
  };
}

export function sellQuote(profile, items, uid, count) {
  const { entry, template } = saleItem(profile, items, uid);
  if (entry.flags & 1) {
    throw profileError(
      "item-sealed",
      "Sealed items cannot be\r\nsold, traded, or dropped.",
    );
  }
  const rechargeable = isRechargeable(entry.id);
  shopInteger(
    count,
    rechargeable && entry.count === 0 ? 0 : 1,
    entry.count,
    "sale quantity",
  );
  const units = rechargeable ? entry.count : count;
  const amount = salePrice(template, units);
  shopInteger(
    profile.meso + amount,
    0,
    SHOP_LIMITS.mesos,
    "resulting meso balance",
  );
  return {
    kind: "sell",
    itemId: entry.id,
    uid,
    template,
    count: units,
    units,
    amount,
    currency: "meso",
  };
}

export function rechargeCost(profile, template, count) {
  if (!isRechargeable(template.id)) {
    throw profileError(
      "not-rechargeable",
      "This is not rechargeable ammunition.",
    );
  }
  const maximum = effectiveItemStackLimit(profile, template);
  const units = maximum - count;
  if (units <= 0) {
    throw profileError(
      "already-recharged",
      "This ammunition is already fully charged.",
    );
  }
  const unitPrice = shopUnitPrice(template);
  if (unitPrice <= 0) {
    throw profileError(
      "recharge-price",
      "The original item has no positive recharge price.",
    );
  }
  const amount = shopInteger(
    Math.ceil(unitPrice * units),
    1,
    SHOP_LIMITS.mesos,
    "recharge total",
  );
  return { maximum, units, amount };
}

export function rechargeQuote(profile, items, uid) {
  const { entry, template } = saleItem(profile, items, uid);
  const { maximum, units, amount } = rechargeCost(
    profile,
    template,
    entry.count,
  );
  if (profile.meso < amount) {
    throw profileError("insufficient-mesos", "You do not have enough mesos.");
  }
  return {
    kind: "recharge",
    itemId: entry.id,
    uid,
    template,
    count: maximum,
    units,
    amount,
    currency: "meso",
  };
}

/** Native0075750b chooses the first changed inventory slot after the successful buy response. */
function grantPurchase(profile, quote) {
  const before = new Map();
  for (const entry of profile.inventory) {
    if (entry.id === quote.itemId) before.set(entry.uid, entry.count);
  }
  grantItem(profile, quote.template, quote.units);
  let selected = null;
  for (const entry of profile.inventory) {
    if (entry.id !== quote.itemId || before.get(entry.uid) === entry.count) {
      continue;
    }
    if (!selected || entry.slot < selected.slot) selected = entry;
  }
  if (!selected) {
    throw profileError(
      "shop-grant",
      "No purchased inventory instance was produced.",
    );
  }
  quote.uid = selected.uid;
}

/** Only detached ProfileStore drafts may reach this primitive; capacity precedes payment. */
export function applyShopQuote(profile, quote) {
  if (quote.kind === "buy") {
    grantPurchase(profile, quote);
    if (quote.currency === "pitch") {
      consumeTemplate(profile, SHOP_PITCH_ITEM, quote.amount);
    } else profile.meso -= quote.amount;
  } else if (quote.kind === "sell") {
    consumeItem(profile, quote.uid, quote.units);
    profile.meso += quote.amount;
  } else if (quote.kind === "recharge") {
    const entry = profile.inventory.find((item) => item.uid === quote.uid);
    entry.count = quote.count;
    profile.meso -= quote.amount;
  } else {
    throw profileError("shop-operation", "Unknown shop operation.");
  }
}
