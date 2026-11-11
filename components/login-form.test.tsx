// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/components/login-form";

// @ts-expect-error the form only reaches `signIn.email`; the rest of the client
// is never called here, and stubbing it would be noise.
vi.mock(import("@/lib/auth-client"), () => ({
  signIn: { email: vi.fn<() => void>() },
}));

describe(LoginForm, () => {
  it("lets password managers fill the email and does not autocorrect it", () => {
    render(<LoginForm />);

    const email = screen.getByLabelText("Email");

    expect(email.getAttribute("type")).toBe("email");
    // `username` is the token password managers pair a credential with.
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("spellcheck")).toBe("false");
  });
});
