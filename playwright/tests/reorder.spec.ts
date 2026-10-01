// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect window state.
import { createBoardPage, expect, test } from "../fixtures/test";

const BOARD_NAME = "reorder-collab";

test.describe("collaborative paint ordering", () => {
  test("reordering keeps identity, syncs to peers, and survives re-entry", async ({
    boardPage,
    server,
    context,
  }) => {
    const peerPage = await context.newPage();
    const peerBoard = createBoardPage(peerPage, server);

    await Promise.all([
      boardPage.gotoBoardShell(BOARD_NAME),
      peerBoard.gotoBoardShell(BOARD_NAME),
    ]);
    await Promise.all([
      boardPage.waitForSocketConnected(),
      peerBoard.waitForSocketConnected(),
    ]);
    await boardPage.waitForBoardWritable();
    await peerBoard.waitForBoardWritable();

    // Draw two overlapping rectangles, then text over the same area.
    await boardPage.drawRectangle(
      "#ff0000",
      { x: 800, y: 600 },
      { x: 1000, y: 800 },
    );
    await boardPage.drawRectangle(
      "#00ff00",
      { x: 850, y: 650 },
      { x: 1050, y: 850 },
    );
    await boardPage.selectTool("text");
    await boardPage.createText(900, 720, "layer text");
    await boardPage.waitForBufferedWritesDrained();

    const orderBefore = await boardPage.readPaintOrder();
    expect(orderBefore).toHaveLength(3);

    await expect.poll(() => peerBoard.readPaintOrder()).toEqual(orderBefore);

    const bottomId = orderBefore[0] as string;
    const topId = orderBefore[2] as string;

    // First click selects the hand (pan mode); a second click toggles its
    // selector secondary mode used for selection actions.
    await boardPage.selectTool("hand");
    await boardPage.tool("hand").click();

    // Bring the first (bottom) rectangle to the front via the selection menu.
    await boardPage.selectWithHandSelector(bottomId);
    await boardPage.clickSelectionAction("bringFront");

    const expectedAfterFront = [
      orderBefore[1],
      orderBefore[2],
      orderBefore[0],
    ] as string[];
    await expect
      .poll(() => boardPage.readPaintOrder())
      .toEqual(expectedAfterFront);
    await expect
      .poll(() => peerBoard.readPaintOrder())
      .toEqual(expectedAfterFront);

    // Move one element: geometry only, the earlier reorder stays valid.
    await boardPage.moveSelection(
      bottomId,
      { x: 950, y: 750 },
      { x: 960, y: 760 },
    );
    await expect
      .poll(() => boardPage.readPaintOrder())
      .toEqual(expectedAfterFront);
    await expect
      .poll(() => peerBoard.readPaintOrder())
      .toEqual(expectedAfterFront);

    // Send the text to the back.
    await boardPage.selectWithHandSelector(topId);
    await boardPage.clickSelectionAction("sendBack");
    const expectedAfterBack = [
      topId,
      expectedAfterFront[0],
      expectedAfterFront[1],
    ] as string[];
    await expect
      .poll(() => boardPage.readPaintOrder())
      .toEqual(expectedAfterBack);
    await expect
      .poll(() => peerBoard.readPaintOrder())
      .toEqual(expectedAfterBack);

    // Wait for the debounced server-side save to land.
    await boardPage.page.waitForTimeout(3000);

    // A brand new participant joining later must see the confirmed order.
    const latePage = await context.newPage();
    const lateBoard = createBoardPage(latePage, server);
    await lateBoard.gotoBoard(BOARD_NAME);
    await lateBoard.waitForSocketConnected();
    await expect
      .poll(() => lateBoard.readPaintOrder())
      .toEqual(expectedAfterBack);

    // Re-entering after reload keeps the same order and the same identities.
    await boardPage.page.reload();
    await boardPage.gotoBoard(BOARD_NAME);
    await boardPage.waitForSocketConnected();
    await expect
      .poll(() => boardPage.readPaintOrder())
      .toEqual(expectedAfterBack);
    for (const id of expectedAfterBack) {
      await expect(boardPage.page.locator(`#${id}`)).toHaveCount(1);
    }
  });
});
