"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMounted } from "@/hooks/use-mounted";

/**
 * Three explicit choices rather than a light/dark switch, because "system" is a
 * real stored value: a two-state toggle has to either drop it or lie about
 * which mode is active while it is in effect.
 */
const options = [
  { icon: SunIcon, label: "Light", value: "light" },
  { icon: MoonIcon, label: "Dark", value: "dark" },
  { icon: MonitorIcon, label: "System", value: "system" },
] as const;

/**
 * The icon for the active choice, keyed by the value `next-themes` stores.
 * Returns the element rather than the component so nothing is constructed
 * during render.
 */
const iconFor = (value: string | undefined) => {
  const { icon: Icon } =
    options.find((option) => option.value === value) ?? options[2];

  return <Icon />;
};

export const ThemeToggle = () => {
  const { setTheme, systemTheme, theme } = useTheme();

  // `theme` is undefined until next-themes has read localStorage, which it
  // cannot do on the server. Rendering the resolved icon before mount would
  // pick the wrong one and have it corrected a frame later.
  const mounted = useMounted();
  const active = mounted ? (theme ?? "system") : "system";

  // The system option names what it currently resolves to. It is the system
  // preference, not the applied theme: a reader overriding to light is still
  // being told what "System" would follow. The value is browser-only, so it
  // joins the label only after mount — the server never had it.
  const system = mounted ? systemTheme : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label="Theme" />}
      >
        {iconFor(active)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={active}
          onValueChange={(value) => {
            if (value) {
              setTheme(value);
            }
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              // Radio items keep the menu open by default, which suits a
              // filter menu you tune in place. A theme is picked once, so the
              // menu should get out of the way.
              closeOnClick
            >
              <option.icon />
              {option.value === "system" && system
                ? `System (currently ${system})`
                : option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
