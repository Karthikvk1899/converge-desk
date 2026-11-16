// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { App } from "../web/main.tsx";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows an explicit local-storage disclosure and gates sign-in", () => {
  render(<App />);
  expect(
    screen.getByRole("button", { name: /Connect to workspace/ }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Document contents and unacknowledged edits are stored/),
  ).toBeInTheDocument();
});
it("shows failed authentication without saving tokens", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "invalid credential" }),
    }),
  );
  render(<App />);
  fireEvent.change(screen.getByLabelText("Access credential"), {
    target: { value: "example" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Connect to workspace/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid credential",
  );
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
