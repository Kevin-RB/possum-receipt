// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SignupForm } from "@/components/signup-form";

interface SignUpResult {
  error: { message: string } | null;
}

/**
 * The account's zone is captured once, at sign-up, from the only party that
 * knows it — the browser. It is the fallback for "today" whenever a request
 * carries no viewer zone (a job, or a request from before the cookie existed),
 * so a sign-up that omits it leaves that fallback with nothing to read.
 */
const signUpEmail = vi.hoisted(() =>
  vi.fn<(payload: Record<string, unknown>) => Promise<SignUpResult>>()
);

// @ts-expect-error the form only reaches `signUp.email`; the rest of the client
// is never called here, and stubbing it would be noise.
vi.mock(import("@/lib/auth-client"), () => ({
  signUp: { email: signUpEmail },
}));

const fill = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe(SignupForm, () => {
  beforeEach(() => {
    signUpEmail.mockReset();
    // Fails, so the form reports an error instead of navigating away.
    signUpEmail.mockResolvedValue({ error: { message: "not today" } });
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      calendar: "gregory",
      locale: "en-AU",
      numberingSystem: "latn",
      timeZone: "America/Bogota",
    });
  });

  it("sends the browser's own zone with the credentials", async () => {
    render(<SignupForm />);

    fill("Name", "Ana");
    fill("Email", "ana@example.com");
    fill("Invite code", "possum");
    fill("Password", "correct-horse");
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(signUpEmail).toHaveBeenCalledOnce());

    expect(signUpEmail).toHaveBeenCalledWith({
      email: "ana@example.com",
      inviteCode: "possum",
      name: "Ana",
      password: "correct-horse",
      timezone: "America/Bogota",
    });
  });
});
