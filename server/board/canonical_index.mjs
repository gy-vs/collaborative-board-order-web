import {
  cloneBounds,
  cloneCanonicalItem,
  effectiveChildCount,
} from "./canonical_items.mjs";

/**
 * @param {{itemsById: Map<string, any>}} state
 * @param {string} id
 * @returns {any}
 */
function getCanonicalItem(state, id) {
  const item = state.itemsById.get(id);
  return item && item.deleted !== true ? item : undefined;
}

/**
 * @param {{itemsById: Map<string, any>, liveItemCount: number}} state
 * @returns {void}
 */
function rebuildLiveItemCount(state) {
  let liveItemCount = 0;
  for (const item of state.itemsById.values()) {
    if (item?.deleted !== true) liveItemCount += 1;
  }
  state.liveItemCount = liveItemCount;
}

/**
 * @param {{liveItemCount: number}} state
 * @returns {number}
 */
function authoritativeItemCount(state) {
  return state.liveItemCount;
}

/**
 * @param {{
 *   itemsById: Map<string, any>,
 *   paintOrder: string[],
 *   nextPaintOrder: number,
 *   liveItemCount: number,
 * }} state
 * @param {any} item
 * @returns {void}
 */
function upsertCanonicalItem(state, item) {
  if (!item || typeof item.id !== "string") return;
  const existing = state.itemsById.get(item.id);
  const hadItem = existing !== undefined;
  state.itemsById.set(item.id, item);
  if (!hadItem) {
    state.paintOrder.push(item.id);
  }
  const hadLiveItem = existing !== undefined && existing.deleted !== true;
  const hasLiveItem = item.deleted !== true;
  if (!hadLiveItem && hasLiveItem) state.liveItemCount += 1;
  if (hadLiveItem && !hasLiveItem) state.liveItemCount -= 1;
  state.nextPaintOrder = Math.max(state.nextPaintOrder, item.paintOrder + 1);
}

/**
 * @param {{itemsById: Map<string, any>, liveItemCount: number}} state
 * @param {string} id
 * @returns {void}
 */
function removeCanonicalItem(state, id) {
  const existing = state.itemsById.get(id);
  if (!existing || existing.deleted === true) return;
  const next = {
    ...existing,
    deleted: true,
    dirty: true,
  };
  state.itemsById.set(id, next);
  state.liveItemCount -= 1;
}

/**
 * @param {{
 *   itemsById: Map<string, any>,
 *   paintOrder: string[],
 *   nextPaintOrder: number,
 *   liveItemCount: number,
 *   trimPaintOrderIndex: number,
 * }} state
 * @param {Map<string, any>} [persistedSnapshot]
 * @param {Set<string>} [persistedIds]
 * @returns {{paintOrder: string[], nextPaintOrder: number}}
 */
function finalizePersistedCanonicalItems(
  state,
  persistedSnapshot = state.itemsById,
  persistedIds = new Set(persistedSnapshot.keys()),
) {
  let removedItems = false;
  for (const [id, item] of state.itemsById.entries()) {
    const persistedItem = persistedSnapshot.get(id);
    if (!persistedItem) continue;
    if (persistedItem !== item) {
      if (persistedItem.deleted === true) continue;
      if (!persistedIds.has(id)) continue;
      delete item.copySource;
      if (
        item.payload?.kind === "children" &&
        persistedItem.payload?.kind === "children"
      ) {
        item.payload.persistedChildCount = effectiveChildCount(persistedItem);
        item.payload.appendedChildren = (
          item.payload.appendedChildren || []
        ).slice((persistedItem.payload.appendedChildren || []).length);
      }
      state.itemsById.set(id, item);
      continue;
    }
    if (item.deleted === true) {
      state.itemsById.delete(id);
      removedItems = true;
      continue;
    }
    if (!persistedIds.has(id)) continue;
    if (item.dirty !== true && !item.copySource) continue;
    const next = cloneCanonicalItem(item);
    next.dirty = false;
    if (next.payload?.kind === "children") {
      next.payload.persistedChildCount = effectiveChildCount(next);
      next.payload.appendedChildren = [];
    } else if (next.payload?.kind === "text") {
      delete next.payload.modifiedText;
      delete next.copySource;
    }
    if (next.copySource && next.payload?.kind !== "text") {
      delete next.copySource;
    }
    state.itemsById.set(id, next);
  }
  if (removedItems) {
    const paintOrder = state.paintOrder.filter((id) => state.itemsById.has(id));
    const nextPaintOrder = paintOrder.reduce((max, id) => {
      const item = state.itemsById.get(id);
      return item ? Math.max(max, item.paintOrder + 1) : max;
    }, 0);
    state.paintOrder = paintOrder;
    state.nextPaintOrder = nextPaintOrder;
    rebuildLiveItemCount(state);
    state.trimPaintOrderIndex = 0;
  }
  return {
    paintOrder: state.paintOrder,
    nextPaintOrder: state.nextPaintOrder,
  };
}

/**
 * Moves a group of live items together to the front or the back of the paint
 * order while keeping their relative order. The persisted SVG is
 * order-significant, so callers must flag `state.paintOrderDirty = true` when
 * the order actually changes. Item identity, geometry, and attributes are
 * preserved.
 *
 * @param {{
 *   itemsById: Map<string, any>,
 *   paintOrder: string[],
 *   nextPaintOrder: number,
 * }} state
 * @param {string[]} ids ids to move, already in their current paint order
 * @param {0 | 1} position 0 sends the group to the back, 1 brings it to front
 * @returns {{ok: true, changed: boolean} | {ok: false, reason: string}}
 */
function reorderCanonicalItems(state, ids, position) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, reason: "invalid reorder" };
  }
  const selected = new Set(ids);
  if (selected.size !== ids.length) {
    return { ok: false, reason: "duplicate reorder id" };
  }
  for (const id of ids) {
    if (!getCanonicalItem(state, id) || !state.paintOrder.includes(id)) {
      return { ok: false, reason: "object not found" };
    }
  }
  const moved = state.paintOrder.filter((id) => selected.has(id));
  const others = state.paintOrder.filter((id) => !selected.has(id));
  const nextOrder =
    position === 1 ? others.concat(moved) : moved.concat(others);
  if (nextOrder.every((id, index) => state.paintOrder[index] === id)) {
    return { ok: true, changed: false };
  }
  state.paintOrder = nextOrder;
  nextOrder.forEach((orderedId, index) => {
    const orderedItem = state.itemsById.get(orderedId);
    if (!orderedItem || orderedItem.paintOrder === index) return;
    state.itemsById.set(orderedId, { ...orderedItem, paintOrder: index });
  });
  state.nextPaintOrder = Math.max(state.nextPaintOrder, nextOrder.length);
  return { ok: true, changed: true };
}

export {
  authoritativeItemCount,
  cloneBounds,
  finalizePersistedCanonicalItems,
  getCanonicalItem,
  rebuildLiveItemCount,
  removeCanonicalItem,
  reorderCanonicalItems,
  upsertCanonicalItem,
};
