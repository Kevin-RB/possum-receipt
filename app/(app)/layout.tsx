import { cookies } from "next/headers";

import { AppSidebar } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <TooltipProvider>
      <SidebarProvider className="h-dvh min-h-0" defaultOpen={defaultOpen}>
        <AppSidebar />
        <SidebarInset className="min-h-0">
          {/* The shell owns the viewport height, so the header has to clear the
              notch itself rather than letting the browser letterbox the page.
              `px-safe-4` does the same for the sides, where a landscape iPhone
              puts the notch, without pinching the normal 1rem inset. */}
          <header className="px-safe-4 pt-safe flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2">
            <SidebarTrigger />
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </header>
          {/* The one scroll area for every page: no document scrolling, so the
              header stays put and the iOS URL bar cannot resize mid-scroll.
              `scrollbar-gutter: stable` keeps the bar's width reserved when a
              page is short enough not to scroll. Without it the content area
              gains the scrollbar's width the moment the last receipt page is
              six rows instead of ten, and the whole table moves sideways.
              `px-safe` pads the same side insets the header has, so a page is
              clear of the notch in landscape; it adds nothing on a device that
              reports no inset, because each page brings its own padding. */}
          <div className="px-safe pb-safe flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto overscroll-contain">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
};

export default AppLayout;
