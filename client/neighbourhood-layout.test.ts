import { describe, expect, test } from "vitest";
import { neighbourhoodLayout, type NeighbourhoodLayout } from "./geometry";

// CARD-TREE-SPEC §2.6: the Dependencies section reserves the map's height from the node counts alone.
const bottom = (layout: NeighbourhoodLayout, nodeH: number) =>
  Math.max(layout.centre + nodeH, ...[...layout.left, ...layout.right].map((s) => s.y + nodeH));

describe("neighbourhoodLayout", () => {
  test.each([0, 1, 2, 3, 4, 5])("%i blockers and blocked cards: the reserved height is where the last node ends", (n) => {
    for (const vertical of [false, true]) {
      const layout = neighbourhoodLayout(n, Math.max(0, n - 1), 40, 8, { vertical });
      expect(layout.height).toBe(bottom(layout, 40));
      expect([...layout.left, ...layout.right].every((s) => s.y >= 0)).toBe(true);
    }
  });

  test("past four a side, three cards and one +n more node", () => {
    const layout = neighbourhoodLayout(5, 9, 40, 8);
    expect(layout.left.map((s) => s.more)).toEqual([0, 0, 0, 2]);
    expect(layout.right.map((s) => s.more)).toEqual([0, 0, 0, 6]);
    expect(neighbourhoodLayout(4, 0, 40, 8).left.map((s) => s.more)).toEqual([0, 0, 0, 0]);
  });

  test("horizontal: columns are centred on the card and each bus reaches the card's middle", () => {
    const layout = neighbourhoodLayout(3, 1, 40, 8);
    if (layout.vertical) throw new Error("expected horizontal");
    expect(layout.height).toBe(3 * 40 + 2 * 8);
    expect(layout.centre).toBe(48);
    expect(layout.right).toEqual([{ y: 48, more: 0 }]);
    expect(layout.leftBus).toEqual({ top: 20, bottom: 116 });
    expect(layout.rightBus).toEqual({ top: 68, bottom: 68 });
    const alone = neighbourhoodLayout(0, 0, 44, 8);
    expect(alone).toMatchObject({ height: 44, centre: 0, leftBus: null, rightBus: null });
  });

  test("vertical: blockers above, the card, blocked cards below, on one rail", () => {
    const layout = neighbourhoodLayout(2, 1, 40, 12, { vertical: true });
    if (!layout.vertical) throw new Error("expected vertical");
    expect(layout.left.map((s) => s.y)).toEqual([0, 52]);
    expect(layout.centre).toBe(104);
    expect(layout.right.map((s) => s.y)).toEqual([156]);
    expect(layout.rail).toEqual({ top: 20, bottom: 176 });
    expect(neighbourhoodLayout(0, 0, 40, 12, { vertical: true })).toMatchObject({ height: 40, rail: null });
  });

  test("vertical: a caption row above each side says which cards it waits for and which it blocks", () => {
    const layout = neighbourhoodLayout(1, 2, 40, 8, { vertical: true, caption: 18 });
    if (!layout.vertical) throw new Error("expected vertical");
    expect(layout.captions).toEqual({ left: 0, right: 114 });
    expect(layout.left.map((s) => s.y)).toEqual([18]);
    expect(layout.centre).toBe(66);
    expect(layout.right.map((s) => s.y)).toEqual([132, 180]);
    expect(layout.height).toBe(220);
    expect(layout.height).toBe(bottom(layout, 40));
    // Nothing reserved for a side with no cards.
    const blocksOnly = neighbourhoodLayout(0, 1, 40, 8, { vertical: true, caption: 18 });
    expect(blocksOnly).toMatchObject({ centre: 0, captions: { left: null, right: 48 }, height: 40 + 8 + 18 + 40 });
  });
});
