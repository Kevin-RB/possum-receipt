import { describe, expect, it, vi } from "vitest";

import { isUserMessage, reportError, USER_ERROR } from "./errors";

describe(isUserMessage, () => {
  it("accepts wording from the catalogue", () => {
    expect(isUserMessage(USER_ERROR.generic)).toBeTruthy();
    expect(isUserMessage(USER_ERROR.modelUnavailable)).toBeTruthy();
  });

  it("rejects anything the app did not write", () => {
    expect(isUserMessage('{"error":"Unauthorized"}')).toBeFalsy();
    expect(isUserMessage("Failed after 3 attempts. Last error: …")).toBeFalsy();
    expect(isUserMessage("")).toBeFalsy();
  });
});

describe(reportError, () => {
  it("logs the cause under the failing boundary", () => {
    const spy = vi.spyOn(console, "error").mockReturnValue();
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:1234");

    reportError("receipts.delete", cause);

    expect(spy).toHaveBeenCalledWith("[receipts.delete]", cause);
    spy.mockRestore();
  });
});
