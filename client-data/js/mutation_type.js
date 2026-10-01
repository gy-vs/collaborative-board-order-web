export const MutationType = Object.freeze(
  /** @type {const} */ ({
    CREATE: 1,
    UPDATE: 2,
    DELETE: 3,
    APPEND: 4,
    BATCH: 5,
    CLEAR: 6,
    COPY: 7,
    REORDER: 8,
  }),
);
/**
 * Position argument of a REORDER mutation: move the item to the back or the
 * front of the paint order.
 */
export const ReorderPosition = Object.freeze(
  /** @type {const} */ ({
    BACK: 0,
    FRONT: 1,
  }),
);
/** @typedef {typeof MutationType[keyof typeof MutationType]} MessageType */

/**
 * @param {unknown} type
 * @returns {MessageType | undefined}
 */
export function getMutationTypeCode(type) {
  return typeof type === "number" &&
    type >= MutationType.CREATE &&
    type <= MutationType.REORDER
    ? /** @type {MessageType} */ (type)
    : undefined;
}
