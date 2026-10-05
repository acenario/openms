import { inventoryType, isRechargeable } from "../items/inventory-model.js";
import {
  saleEntry,
  salePrice,
  rechargeCost,
  shopBuyLimit,
} from "../npc/npc-shop-rules.js";

/** A complete paged server offer plus catalog-only display quotes. Purchases remain server-admitted. */
export class NativeShop {
  constructor(owner, event, rows) {
    this.owner = owner;
    this.event = event;
    this.npc = {
      id: event.npcTemplateId,
      name:
        owner.catalog.quests.strings.npc[event.npcTemplateId] ??
        String(event.npcTemplateId),
    };
    this.rows = rows.map((row) => ({
      ...row,
      row: row.rowId,
      itemId: row.templateId,
      price: row.unitPrice,
      pitch: 0,
      currency: "meso",
      pricePerUnit: row.unitPrice,
      template: owner.catalog.ui.items[row.templateId],
      rechargeable: isRechargeable(row.templateId),
    }));
    this.pending = false;
    this.lastTransaction = null;
    this.destroyed = false;
    this.listeners = new Set();
    this.unsubscribe = owner.store.subscribe(() => this.changed());
  }
  subscribe(listener) {
    if (this.listeners.size >= 64) {
      throw new Error("Shop observer budget exceeded");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
  snapshot() {
    const profile = this.owner.store.profile;
    const inventory = [];
    for (const item of profile.inventory) {
      try {
        inventory.push(this.saleView(item));
      } catch (error) {
        if (error.code !== "item-not-saleable" && error.code !== "item-price") {
          inventory.push({
            ...item,
            type: inventoryType(item.id),
            template: this.owner.catalog.ui.items[item.id],
            unavailable: true,
            reason: error.message,
          });
        }
      }
    }
    inventory.sort((a, b) => a.type - b.type || a.slot - b.slot);
    return {
      rows: this.rows,
      self: profile,
      inventory,
      mesos: profile.meso,
      pending: this.pending,
      committing: this.pending,
      lastTransaction: this.lastTransaction,
    };
  }
  saleView(item) {
    const { template } = saleEntry(item, this.owner.catalog.ui.items);
    const rechargeable = isRechargeable(item.id);
    let rechargePrice = null;
    if (rechargeable) {
      try {
        rechargePrice = rechargeCost(
          this.owner.store.profile,
          template,
          item.count,
        ).amount;
      } catch (error) {
        if (
          error.code !== "already-recharged" &&
          error.code !== "recharge-price"
        ) {
          throw error;
        }
      }
    }
    return {
      ...item,
      template,
      type: inventoryType(item.id),
      rechargeable,
      unitPrice: salePrice(template, rechargeable ? item.count : 1),
      rechargePrice,
    };
  }
  async prompt(request) {
    if (this.pending || this.destroyed) return null;
    this.pending = true;
    this.changed();
    try {
      return await this.owner.ui.prompt({ ...request, owner: this });
    } finally {
      this.pending = false;
      this.changed();
    }
  }
  quantity(text, max) {
    return this.prompt({ kind: "number", text, value: 1, min: 1, max });
  }
  confirm(text) {
    return this.prompt({ kind: "confirm", text });
  }
  async buy({ row }) {
    const record = this.rows.find((entry) => entry.row === row);
    if (!record) {
      throw new Error("This server shop row is no longer available.");
    }
    const max = shopBuyLimit(record.itemId);
    const quantity =
      max === 1
        ? (await this.confirm("Are you sure you want to buy it?")) === true
          ? 1
          : null
        : await this.quantity("How many are you willing to buy?", max);
    if (quantity === null) return { ok: false, code: "cancelled" };
    return this.run({
      kind: "shop.buy",
      shopSession: this.event.shopSession,
      rowId: row,
      quantity,
    });
  }
  async sell({ uid }) {
    const item = this.owner.inventory.item(uid);
    const quantity =
      item.count === 1 || isRechargeable(item.id)
        ? (await this.confirm("Are you sure you want to sell it?")) === true
          ? item.count
          : null
        : await this.quantity("How many are you willing to sell?", item.count);
    if (quantity === null) return { ok: false, code: "cancelled" };
    return this.run({
      kind: "shop.sell",
      shopSession: this.event.shopSession,
      itemId: uid,
      quantity,
    });
  }
  async recharge(uid) {
    if (
      (await this.confirm("Are you sure you want to recharge it?")) !== true
    ) {
      return { ok: false, code: "cancelled" };
    }
    return this.run({
      kind: "shop.recharge",
      shopSession: this.event.shopSession,
      itemId: uid,
    });
  }
  async run(action) {
    if (this.pending || this.destroyed) {
      return {
        ok: false,
        reason: "The shop is unavailable or a request is pending.",
      };
    }
    this.pending = true;
    this.changed();
    try {
      const result = await this.owner.request(action);
      if (!result.ok) this.owner.report(result.reason);
      else {
        const value = result.receipt?.value;
        if (
          value?.kind !== "shop.transaction" ||
          value.shopSession !== this.event.shopSession
        ) {
          return {
            ok: false,
            code: "OUTCOME_UNKNOWN",
            reason: "The server did not publish the shop transaction.",
            receipt: result.receipt,
          };
        }
        this.lastTransaction = {
          ok: true,
          kind: value.action,
          itemId: value.itemId,
          uid: value.uid,
          count: value.count,
          amount: value.amount,
          currency: value.currency,
          revision: result.receipt.domainRevision,
        };
      }
      return result;
    } finally {
      this.pending = false;
      this.changed();
    }
  }
  async close() {
    const result = await this.owner.request(
      {
        kind: "npc.answer",
        conversationId: this.event.shopSession,
        step: this.event.revision,
        answer: { kind: "cancel" },
      },
      this.event.revision,
    );
    if (!result.ok) this.owner.report(result.reason);
    return result;
  }
  destroy() {
    this.destroyed = true;
    this.unsubscribe();
    this.listeners.clear();
  }
}
