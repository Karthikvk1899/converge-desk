import { test, expect, type Page } from "@playwright/test";
import { principal, create, request, Peer } from "../tests/client.ts";
import { randomUUID } from "node:crypto";
async function signIn(page: Page, token: string, title: string) {
  await page.goto("/");
  await page.getByLabel("Access credential").fill(token);
  await page.getByRole("button", { name: /Connect to workspace/ }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.locator(".connection")).toHaveText("online");
  await expect(
    page.getByRole("textbox", { name: "Document editor" }),
  ).toBeVisible();
}
test("two browsers merge offline edits, persist unsent work, checkpoint and preview safely", async ({
  browser,
  page,
}) => {
  const tenant = "browser-" + randomUUID().slice(0, 8);
  const a = await principal(tenant, "Alice"),
    b = await principal(tenant, "Bob");
  const d = await create(a.token, "Incident handoff");
  const second = await browser.newContext();
  const bob = await second.newPage();
  await signIn(page, a.token, "Incident handoff");
  await signIn(bob, b.token, "Incident handoff");
  const editor = page.getByRole("textbox", { name: "Document editor" });
  const remote = bob.getByRole("textbox", { name: "Document editor" });
  await editor.fill("# Incident notes\nInitial assessment.\n");
  await expect(remote).toContainText("Initial assessment");
  await expect(page.getByTestId("pending")).toHaveText("0 pending");
  await page.context().setOffline(true);
  await expect(page.locator(".connection")).toHaveText("offline");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("Offline finding.", { delay: 30 });
  await expect(page.getByTestId("pending")).not.toHaveText("0 pending");
  await expect(page.locator(".saved")).toHaveText("Saved on this device");
  await remote.press("ControlOrMeta+End");
  await remote.press("Enter");
  await remote.pressSequentially("Bob found a fix.", { delay: 30 });
  await expect(bob.getByTestId("pending")).toHaveText("0 pending", {
    timeout: 30000,
  });
  await page.context().setOffline(false);
  await expect(page.locator(".connection")).toHaveText("online");
  await expect(editor).toContainText("Bob found a fix.");
  await expect(remote).toContainText("Offline finding.");
  await expect(page.getByTestId("pending")).toHaveText("0 pending", {
    timeout: 30000,
  });
  await page.getByLabel("Checkpoint label").fill("Reviewed handoff");
  await page
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Checkpoint saved");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".markdown h1")).toHaveText("Incident notes");
  await page.screenshot({
    path: "test-results/collaboration-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/collaboration-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await signIn(page, a.token, "Incident handoff");
  await expect(
    page.getByRole("textbox", { name: "Document editor" }),
  ).toContainText("Offline finding.");
  const checkpoints = await (
    await request(`/api/documents/${d.id}/checkpoints`, a.token)
  ).json();
  expect(checkpoints).toHaveLength(1);
  await second.close();
});
test("pending edits survive page reload before server acknowledgment", async ({
  page,
}) => {
  const a = await principal("reload-" + randomUUID().slice(0, 8), "Alice");
  await create(a.token, "Recovery note");
  await signIn(page, a.token, "Recovery note");
  await page.context().setOffline(true);
  await expect(page.locator(".connection")).toHaveText("offline");
  await page
    .getByRole("textbox", { name: "Document editor" })
    .fill("Persisted without server acknowledgment.");
  await expect(page.locator(".saved")).toHaveText("Saved on this device");
  await expect(page.getByTestId("pending")).not.toHaveText("0 pending");
  // Navigate away while offline, then reconnect to load the shell; pending state must come from IndexedDB.
  await page.goto("about:blank");
  await page.context().setOffline(false);
  await signIn(page, a.token, "Recovery note");
  await expect(
    page.getByRole("textbox", { name: "Document editor" }),
  ).toContainText("Persisted without server acknowledgment.");
  await expect(page.getByTestId("pending")).toHaveText("0 pending", {
    timeout: 30000,
  });
});

test("large validated remote edits render and raw HTML cannot execute in preview", async ({
  page,
}) => {
  const a = await principal("render-" + randomUUID().slice(0, 8), "Alice");
  const d = await create(
    a.token,
    "Rendering boundary",
    '# Safe heading\n\n<script>alert(1)</script>\n<img src="https://example.invalid/x" onerror="alert(1)">\n',
  );
  await signIn(page, a.token, "Rendering boundary");
  const editor = page.getByRole("textbox", { name: "Document editor" });
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("Local draft.");
  await expect(page.getByTestId("pending")).toHaveText("0 pending", {
    timeout: 30000,
  });
  const peer = await Peer.connect(a.token, d.id);
  try {
    await peer.ack(
      peer.send(peer.edit("remote-start " + "x".repeat(5000) + " remote-end")),
    );
    await expect(
      page.getByRole("textbox", { name: "Document editor" }),
    ).toContainText("remote-end");
    await editor.press("ControlOrMeta+z");
    await expect(editor).not.toContainText("Local draft.");
    await expect(editor).toContainText("remote-end");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator(".markdown h1")).toHaveText("Safe heading");
    await expect(page.locator(".markdown script, .markdown img")).toHaveCount(
      0,
    );
    await expect(page.locator(".markdown")).toContainText("remote-end");
  } finally {
    peer.close();
  }
});
