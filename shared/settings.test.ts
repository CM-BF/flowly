import { expect, test } from "vitest";
import { boardViewValues } from "./settings";

test("older stored settings get defaults for newer fields; invalid values fall back", () => {
  expect(boardViewValues({ lastProjectId: "p" })).toEqual({ lastProjectId: "p", sendBehavior: "steer", startAgentOnCreate: true });
  expect(boardViewValues(undefined)).toEqual({ lastProjectId: "", sendBehavior: "steer", startAgentOnCreate: true });
  expect(boardViewValues({ sendBehavior: "bogus" }).sendBehavior).toBe("steer");
  expect(boardViewValues({ sendBehavior: "queue", startAgentOnCreate: false })).toMatchObject({ sendBehavior: "queue", startAgentOnCreate: false });
});
