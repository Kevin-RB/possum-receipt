"use client";

import {
  ChartColumnBigIcon,
  MessageCircleIcon,
  ReceiptTextIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { PossumMark } from "@/components/brand/possum-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

/**
 * The chat is the front door, so it comes first. `/` is the only chat URL —
 * there is no `/chat` alias.
 */
const navItems = [
  { icon: MessageCircleIcon, title: "Chat", url: "/" },
  { icon: ReceiptTextIcon, title: "Receipts", url: "/receipts" },
  { icon: ChartColumnBigIcon, title: "Overview", url: "/overview" },
];

export const AppSidebar = () => {
  const pathname = usePathname();

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="default" render={<Link href="/" />}>
              <PossumMark ground="var(--sidebar-accent)" />
              <span className="truncate font-semibold">Possum Receipts</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                // Exact match, not `startsWith`: the chat's URL is `/`, and a
                // prefix test would mark it active on every route.
                const isActive = pathname === item.url;

                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      // Generated primitives only set `data-active`, which is
                      // styling. Assistive technology needs the real attribute.
                      render={
                        <Link
                          aria-current={isActive ? "page" : undefined}
                          href={item.url}
                        />
                      }
                      isActive={isActive}
                    >
                      <item.icon />
                      {item.title}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
};
