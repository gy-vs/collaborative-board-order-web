const test = require("node:test");
const assert = require("node:assert/strict");

const { BoardData } = require("../server/board/data.mjs");
const {
  readCanonicalBoardState,
} = require("../server/persistence/svg_board_store.mjs");
const {
  normalizeIncomingMessage,
} = require("../server/socket/message_validation.mjs");
const {
  MutationType,
  getMutationType,
} = require("../client-data/js/message_tool_metadata.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HAND_TOOL = 7;
const RECT_TOOL = 3;

/** @param {string} historyDir */
function createConfig(historyDir) {
  return {
    HISTORY_DIR: historyDir,
    MAX_BOARD_SIZE: 1_000_000,
    MAX_CHILDREN: 10_000,
    MAX_ITEM_COUNT: 100_000,
    MAX_SAVE_DELAY: 100,
    SAVE_INTERVAL: 0,
    SEQ_REPLAY_RETENTION_MS: 1000,
  };
}

/** @param {any} board @param {string} id */
function seedRect(board, id) {
  const result = board.processMessage({
    tool: RECT_TOOL,
    type: MutationType.CREATE,
    id,
    x: 0,
    y: 0,
    x2: 10,
    y2: 10,
    color: "#000000",
    size: 2,
  });
  assert.equal(result.ok, true);
}

/**
 * @param {{id: string, position: "front" | "back"}[]} children
 * @returns {any}
 */
function reorderBatch(children) {
  return {
    tool: HAND_TOOL,
    type: MutationType.BATCH,
    _children: children.map((child) => ({
      type: MutationType.REORDER,
      ...child,
    })),
  };
}

test("reorder moves a single item to front and back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const board = new BoardData("single", createConfig(dir));
  for (const id of ["a", "b", "c"]) seedRect(board, id);

  assert.deepEqual(board.paintOrder, ["a", "b", "c"]);
  assert.equal(
    board.processMessage(reorderBatch([{ id: "a", position: "front" }])).ok,
    true,
  );
  assert.deepEqual(board.paintOrder, ["b", "c", "a"]);

  assert.equal(
    board.processMessage(reorderBatch([{ id: "a", position: "back" }])).ok,
    true,
  );
  assert.deepEqual(board.paintOrder, ["a", "b", "c"]);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reorder keeps the group's current relative order regardless of message order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const board = new BoardData("group", createConfig(dir));
  for (const id of ["a", "b", "c", "d"]) seedRect(board, id);

  // Selection order sent in reverse must not flip the group's internal order.
  assert.equal(
    board.processMessage(
      reorderBatch([
        { id: "d", position: "front" },
        { id: "b", position: "front" },
        { id: "a", position: "front" },
      ]),
    ).ok,
    true,
  );
  assert.deepEqual(board.paintOrder, ["c", "a", "b", "d"]);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reorder rejects missing items and invalid positions atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const board = new BoardData("invalid", createConfig(dir));
  for (const id of ["a", "b"]) seedRect(board, id);

  const missing = board.processMessage(
    reorderBatch([{ id: "ghost", position: "front" }]),
  );
  assert.equal(missing.ok, false);
  assert.deepEqual(board.paintOrder, ["a", "b"]);

  // One bad child aborts the whole batch, so the valid sibling is not moved.
  const mixed = board.processMessage(
    /** @type {any} */ ({
      tool: HAND_TOOL,
      type: MutationType.BATCH,
      _children: [
        { type: MutationType.REORDER, id: "a", position: "front" },
        { type: MutationType.REORDER, id: "b", position: "sideways" },
      ],
    }),
  );
  assert.equal(mixed.ok, false);
  assert.deepEqual(board.paintOrder, ["a", "b"]);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reorder persists into the stored SVG and survives reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const name = "persist";
  const board = new BoardData(name, createConfig(dir));
  for (const id of ["a", "b", "c"]) seedRect(board, id);
  board.processMessage(reorderBatch([{ id: "a", position: "front" }]));
  await board.save();

  const reloaded = await readCanonicalBoardState(name, { historyDir: dir });
  assert.deepEqual(reloaded.paintOrder, ["b", "c", "a"]);

  // A shape created after the reorder stays on top.
  seedRect(board, "d");
  await board.save();
  const reloaded2 = await readCanonicalBoardState(name, { historyDir: dir });
  assert.deepEqual(reloaded2.paintOrder, ["b", "c", "a", "d"]);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a reorder arriving during a save is persisted on the following save", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const name = "concurrent";
  const board = new BoardData(name, createConfig(dir));
  for (const id of ["a", "b", "c"]) seedRect(board, id);
  board.processMessage(reorderBatch([{ id: "a", position: "front" }]));

  const firstSave = board.save();
  // A second reorder lands while the first ordered rewrite is still running.
  board.processMessage(reorderBatch([{ id: "b", position: "front" }]));
  await firstSave;
  await board.save();

  const reloaded = await readCanonicalBoardState(name, { historyDir: dir });
  // After front(a): b,c,a then front(b): c,a,b.
  assert.deepEqual(reloaded.paintOrder, ["c", "a", "b"]);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reordering preserves pencil path content across reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const name = "pencil";
  const board = new BoardData(name, createConfig(dir));
  seedRect(board, "a");
  for (const mutation of [
    { tool: 1, type: MutationType.CREATE, id: "p", color: "#000000", size: 2 },
    { tool: 1, type: MutationType.APPEND, parent: "p", x: 0, y: 0 },
    { tool: 1, type: MutationType.APPEND, parent: "p", x: 5, y: 7 },
  ]) {
    assert.equal(board.processMessage(/** @type {any} */ (mutation)).ok, true);
  }
  // The pencil is created last (on top); push it behind the rectangle.
  board.processMessage(reorderBatch([{ id: "p", position: "back" }]));
  await board.save();

  const reloaded = await readCanonicalBoardState(name, { historyDir: dir });
  assert.deepEqual(reloaded.paintOrder, ["p", "a"]);
  const pencil = reloaded.itemsById.get("p");
  assert.equal(pencil?.payload?.kind, "children");
  const pointCount =
    (pencil?.payload?.persistedChildCount || 0) +
    (pencil?.payload?.appendedChildren?.length || 0);
  assert.equal(pointCount, 2);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("moving a reordered item does not change its stacking position", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-reorder-"));
  const board = new BoardData("move", createConfig(dir));
  for (const id of ["a", "b"]) seedRect(board, id);
  board.processMessage(reorderBatch([{ id: "a", position: "front" }]));
  assert.deepEqual(board.paintOrder, ["b", "a"]);

  // A hand transform update only changes geometry, never paint order.
  const moved = board.processMessage(
    /** @type {any} */ ({
      tool: HAND_TOOL,
      type: MutationType.BATCH,
      _children: [
        {
          type: MutationType.UPDATE,
          id: "a",
          transform: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 60 },
        },
      ],
    }),
  );
  assert.equal(moved.ok, true);
  assert.deepEqual(board.paintOrder, ["b", "a"]);
  assert.equal(board.get("a")?.transform?.e, 50);

  board.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("incoming REORDER message validation accepts only front/back", () => {
  const config = { MAX_BOARD_SIZE: 1_000_000, MAX_CHILDREN: 10_000 };
  const capabilities = { canOpen: true, canEdit: true, canClear: false };
  const accepted = normalizeIncomingMessage(
    config,
    {
      tool: HAND_TOOL,
      type: MutationType.BATCH,
      _children: [{ type: MutationType.REORDER, id: "a", position: "front" }],
    },
    capabilities,
  );
  assert.equal(accepted.ok, true);

  const rejected = normalizeIncomingMessage(
    config,
    {
      tool: HAND_TOOL,
      type: MutationType.BATCH,
      _children: [{ type: MutationType.REORDER, id: "a", position: 42 }],
    },
    capabilities,
  );
  assert.equal(rejected.ok, false);
});

test("REORDER mutation type is recognized by shared metadata", () => {
  assert.equal(
    getMutationType({ type: MutationType.REORDER }),
    MutationType.REORDER,
  );
  assert.equal(MutationType.REORDER, 8);
});
