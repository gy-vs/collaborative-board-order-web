// Layer reordering (bring to front / send to back) keeps identity, geometry
// and collaborative state consistent.
import { createBoardPage, expect, test } from "../fixtures/test";

const RECT_A = {
  type: "rect",
  id: "reorder-rect-a",
  tool: "rectangle",
  x: 100,
  y: 100,
  x2: 300,
  y2: 260,
  color: "#111111",
  size: 4,
};
const RECT_B = {
  type: "rect",
  id: "reorder-rect-b",
  tool: "rectangle",
  x: 180,
  y: 160,
  x2: 380,
  y2: 320,
  color: "#222222",
  size: 4,
};
const OVERLAP_POINT = { x: 240, y: 210 };

test.describe("layer reordering", () => {
  test("bring to front changes overlap hit target and persists across reload", async ({
    boardPage,
    server,
    page,
  }) => {
    await server.writeBoard(server.dataPath, "reorder-front", {
      [RECT_A.id]: RECT_A,
      [RECT_B.id]: RECT_B,
    });
    await boardPage.gotoBoard("reorder-front");
    await boardPage.selectTool("hand");

    expect(await boardPage.elementAtBoardPoint(OVERLAP_POINT)).toBe(
      "reorder-rect-b",
    );

    await boardPage.selectElementWithHand("reorder-rect-a");
    await boardPage.clickSelectionButton("layerFront");

    await expect
      .poll(() => boardPage.elementAtBoardPoint(OVERLAP_POINT))
      .toBe("reorder-rect-a");
    await expect
      .poll(() => boardPage.readDrawingOrder("rect"))
      .toEqual(["reorder-rect-b", "reorder-rect-a"]);

    // Moving afterwards must not alter the stacking relationship.
    await boardPage.moveSelection(
      "reorder-rect-a",
      { x: 120, y: 120 },
      { x: 125, y: 125 },
    );
    await expect
      .poll(() => boardPage.readDrawingOrder("rect"))
      .toEqual(["reorder-rect-b", "reorder-rect-a"]);

    await server.waitForStoredBoard(
      server.dataPath,
      "reorder-front",
      (storedBoard) => {
        return (
          Object.keys(storedBoard).join(",") === "reorder-rect-b,reorder-rect-a"
        );
      },
    );

    await page.reload();
    await expect(page.locator("#reorder-rect-a")).toBeVisible();
    await expect
      .poll(() => boardPage.elementAtBoardPoint(OVERLAP_POINT))
      .toBe("reorder-rect-a");
  });

  test("send to back is visible on a second participant and survives rejoin", async ({
    boardPage,
    server,
    context,
  }) => {
    const peerPage = await context.newPage();
    const peerBoard = createBoardPage(peerPage, server);

    await server.writeBoard(server.dataPath, "reorder-collab", {
      [RECT_A.id]: RECT_A,
      [RECT_B.id]: RECT_B,
    });
    await Promise.all([
      boardPage.gotoBoard("reorder-collab"),
      peerBoard.gotoBoard("reorder-collab"),
    ]);
    await Promise.all([
      boardPage.waitForSocketConnected(),
      peerBoard.waitForSocketConnected(),
    ]);
    await boardPage.selectTool("hand");

    await boardPage.selectElementWithHand("reorder-rect-b");
    await boardPage.clickSelectionButton("layerBack");

    await expect
      .poll(() => boardPage.readDrawingOrder("rect"))
      .toEqual(["reorder-rect-b", "reorder-rect-a"]);
    await expect
      .poll(() => peerBoard.readDrawingOrder("rect"))
      .toEqual(["reorder-rect-b", "reorder-rect-a"]);
    await expect
      .poll(() => peerBoard.elementAtBoardPoint(OVERLAP_POINT))
      .toBe("reorder-rect-a");

    await server.waitForStoredBoard(
      server.dataPath,
      "reorder-collab",
      (storedBoard) =>
        Object.keys(storedBoard).join(",") === "reorder-rect-b,reorder-rect-a",
    );

    const latecomerPage = await context.newPage();
    const latecomer = createBoardPage(latecomerPage, server);
    await latecomer.gotoBoard("reorder-collab");
    await expect(latecomerPage.locator("#reorder-rect-a")).toBeVisible();
    await expect
      .poll(() => latecomer.readDrawingOrder("rect"))
      .toEqual(["reorder-rect-b", "reorder-rect-a"]);
    await expect
      .poll(() => latecomer.elementAtBoardPoint(OVERLAP_POINT))
      .toBe("reorder-rect-a");
  });

  test("newly drawn shapes still appear above reordered ones", async ({
    boardPage,
    server,
  }) => {
    await server.writeBoard(server.dataPath, "reorder-then-draw", {
      [RECT_A.id]: RECT_A,
      [RECT_B.id]: RECT_B,
    });
    await boardPage.gotoBoard("reorder-then-draw");
    await boardPage.selectTool("hand");

    await boardPage.selectElementWithHand("reorder-rect-b");
    await boardPage.clickSelectionButton("layerBack");
    await expect
      .poll(() => boardPage.readDrawingOrder("rect"))
      .toEqual(["reorder-rect-b", "reorder-rect-a"]);

    await boardPage.drawRectangle(
      "#333333",
      { x: 220, y: 190 },
      { x: 280, y: 240 },
    );
    await boardPage.waitForBufferedWritesDrained();

    await expect
      .poll(() => boardPage.elementAtBoardPoint({ x: 250, y: 215 }))
      .not.toBe("reorder-rect-b");
    const order = await boardPage.readDrawingOrder("rect");
    expect(order[0]).toBe("reorder-rect-b");
    expect(order[order.length - 1]).not.toBe("reorder-rect-b");
  });

  test("read-only participant sees the board but cannot reorder layers", async ({
    boardPage,
    server,
  }) => {
    await server.writeBoard(server.dataPath, "reorder-readonly-board", {
      __wbo_meta__: { readonly: true },
      [RECT_A.id]: RECT_A,
      [RECT_B.id]: RECT_B,
    });
    await boardPage.gotoBoard("reorder-readonly-board");
    await boardPage.waitForSocketConnected();
    await boardPage.selectTool("hand");

    // The selector secondary mode (and therefore the layer action buttons) is
    // not available without edit permission.
    const canActivateSelector = await boardPage.page.evaluate(() => {
      const tool = window.WBOApp.toolRegistry.current;
      return !!(tool && tool.name === "hand" && tool.secondary);
    });
    expect(canActivateSelector).toBe(false);

    // Even a crafted local reorder broadcast must be refused by the server and
    // leave the authoritative stacking unchanged.
    await boardPage.page.evaluate(() => {
      window.__reorderRejected = false;
      window.WBOApp.connection.socket?.on("mutation_rejected", () => {
        window.__reorderRejected = true;
      });
    });
    await boardPage.emitBroadcast({
      tool: 7,
      type: 8,
      _children: [{ type: 8, id: "reorder-rect-a", position: "front" }],
    });
    await expect
      .poll(() => boardPage.page.evaluate(() => !!window.__reorderRejected))
      .toBe(true);
    expect(await boardPage.readDrawingOrder("rect")).toEqual([
      "reorder-rect-a",
      "reorder-rect-b",
    ]);

    await server.waitForStoredBoard(
      server.dataPath,
      "reorder-readonly-board",
      (storedBoard) =>
        Object.keys(storedBoard).join(",") === "reorder-rect-a,reorder-rect-b",
    );
  });
});
