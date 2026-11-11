// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UseThemeProps } from "next-themes";
import type { SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseTheme = vi.fn<() => UseThemeProps>();

const setTheme = () => vi.fn<(value: SetStateAction<string>) => void>();

vi.mock(import("next-themes"), () => ({
  useTheme: () => mockUseTheme(),
}));

const { ThemeToggle } = await import("./theme-toggle");

/**
 * The trigger opens on the press, in a frame Base UI schedules, so the menu is
 * awaited rather than asserted on synchronously.
 */
const openMenu = async () => {
  fireEvent.mouseDown(screen.getByLabelText("Theme"));

  await waitFor(() => {
    expect(screen.getByRole("menu")).toBeTruthy();
  });
};

const systemItem = () =>
  screen
    .getAllByRole("menuitemradio")
    .find((item) => item.textContent?.startsWith("System"));

describe(ThemeToggle, () => {
  beforeEach(() => {
    mockUseTheme.mockReturnValue({
      resolvedTheme: "dark",
      setTheme: setTheme(),
      systemTheme: "dark",
      theme: "system",
      themes: [],
    });
  });

  it("names what the system option currently resolves to", async () => {
    render(<ThemeToggle />);
    await openMenu();

    expect(systemItem()?.textContent).toBe("System (currently dark)");
  });

  it("reports the system preference even while an override is applied", async () => {
    // The reader pinned light, but "System" still means "follow the OS", so its
    // label must not claim the applied theme.
    mockUseTheme.mockReturnValue({
      resolvedTheme: "light",
      setTheme: setTheme(),
      systemTheme: "dark",
      theme: "light",
      themes: [],
    });

    render(<ThemeToggle />);
    await openMenu();

    expect(systemItem()?.textContent).toBe("System (currently dark)");
  });

  it("leaves the explicit options unqualified", async () => {
    render(<ThemeToggle />);
    await openMenu();

    const labels = screen
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent);

    expect(labels).toStrictEqual(["Light", "Dark", "System (currently dark)"]);
  });
});
