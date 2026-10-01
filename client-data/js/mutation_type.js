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
