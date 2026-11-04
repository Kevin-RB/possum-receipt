import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { warnOnce } from "@/lib/warn-once";

describe(warnOnce, () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockReturnValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns the first time a key is seen", () => {
    warnOnce("first-run", "hello");

    expect(warn).toHaveBeenCalledWith("hello");
  });

  it("stays quiet afterwards, because the second line carries nothing", () => {
    warnOnce("repeat", "hello");
    warnOnce("repeat", "hello");
    warnOnce("repeat", "hello");

    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps keys independent", () => {
    warnOnce("one", "first");
    warnOnce("two", "second");

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
