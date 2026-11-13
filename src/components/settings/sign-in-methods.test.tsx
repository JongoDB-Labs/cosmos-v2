// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => h.params }));

import { SignInMethods } from "./sign-in-methods";

afterEach(() => {
  cleanup();
  h.params = new URLSearchParams();
});

const methods = { google: { available: true, connected: false }, microsoft: { available: true, connected: false } };
const RETURN_TO = "/acme/settings/profile";

describe("Sign-in methods tells a session that can't connect what to do, in plain words", () => {
  it("a session that vouches for the address can connect, and sees no hint", () => {
    render(<SignInMethods {...methods} connectRefusal={null} returnTo={RETURN_TO} />);
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect Microsoft" })).toBeEnabled();
    expect(screen.queryByText(/sign in again/i)).toBeNull();
  });

  it("a session from before sessions recorded their method is asked to sign in again", () => {
    render(<SignInMethods {...methods} connectRefusal="connect_sign_in_again" returnTo={RETURN_TO} />);
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect Microsoft" })).toBeDisabled();
    expect(screen.getByText("To connect a sign-in method, sign out and sign in again, then connect it here.")).toBeInTheDocument();
  });

  it("a password an SSO session could have set is told how to make it count", () => {
    render(<SignInMethods {...methods} connectRefusal="connect_password_untrusted" returnTo={RETURN_TO} />);
    expect(screen.getByText(/Reset your password from the sign-in page, or sign in with Google or Microsoft/)).toBeInTheDocument();
  });

  it("the refusal a connect came back with is said once, not twice", () => {
    h.params = new URLSearchParams({ connect_error: "connect_sign_in_again" });
    render(<SignInMethods {...methods} connectRefusal="connect_sign_in_again" returnTo={RETURN_TO} />);
    expect(screen.getAllByText(/sign out and sign in again/)).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("sign out and sign in again");
  });
});
