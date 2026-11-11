// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock(import("next/navigation"), () => ({
  usePathname: () => "/receipts",
}));

const { AppSidebar } = await import("./app-sidebar");
const { SidebarProvider } = await import("@/components/ui/sidebar");

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  );

const mediaQueryList = (query: string) => ({
  addEventListener: vi.fn<() => void>(),
  matches: false,
  media: query,
  removeEventListener: vi.fn<() => void>(),
});

describe(AppSidebar, () => {
  // jsdom has no `matchMedia`, and `SidebarProvider` asks it whether the
  // viewport is mobile. A desktop viewport keeps the rail inert.
  beforeAll(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn<
        (query: string) => {
          addEventListener: () => void;
          matches: boolean;
          media: string;
          removeEventListener: () => void;
        }
      >(mediaQueryList)
    );
  });

  it("marks the current route for assistive technology", () => {
    renderSidebar();

    expect(
      screen
        .getByRole("link", { name: "Receipts" })
        .getAttribute("aria-current")
    ).toBe("page");
  });

  it("leaves the other routes unmarked", () => {
    renderSidebar();

    for (const name of ["Chat", "Overview"]) {
      expect(
        screen.getByRole("link", { name }).getAttribute("aria-current")
      ).toBeNull();
    }
  });
});
