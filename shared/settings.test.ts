import { expect, test } from "vitest";
import { boardViewValues } from "./settings";

test("older stored settings get defaults for newer fields; invalid values fall back", () => {
  expect(boardViewValues({ lastProjectId: "p" })).toEqual({ lastProjectId: "p", sendBehavior: "steer", startAgentOnCreate: true, boardSort: "manual", collapsedColumns: [] });
  expect(boardViewValues(undefined)).toEqual({ lastProjectId: "", sendBehavior: "steer", startAgentOnCreate: true, boardSort: "manual", collapsedColumns: [] });
  expect(boardViewValues({ sendBehavior: "bogus" }).sendBehavior).toBe("steer");
  expect(boardViewValues({ sendBehavior: "queue", startAgentOnCreate: false })).toMatchObject({ sendBehavior: "queue", startAgentOnCreate: false });
});

test("board sort is remembered and defaults to manual", () => {
  expect(boardViewValues({ boardSort: "priority" }).boardSort).toBe("priority");
  expect(boardViewValues({ lastProjectId: "p" }).boardSort).toBe("manual");
});

test("collapsed columns are remembered; unknown statuses invalidate", () => {
  expect(boardViewValues({ collapsedColumns: ["blocked"] }).collapsedColumns).toEqual(["blocked"]);
  expect(boardViewValues({ collapsedColumns: ["nope"] }).collapsedColumns).toEqual([]);
});
