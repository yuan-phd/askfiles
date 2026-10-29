import { test, expect } from "@playwright/test";
import { REFUSAL_TEXT } from "../../src/renderer/api/client.js";
import { mockLibrary, pageUrl, answerEvents, refusalEvents, chunk, asVectorResult } from "./mocks.js";

const QUESTION = "How many days of annual leave do employees get?";

function captureOpenEvents(page) {
  const opened = [];
  page.on("console", (msg) => {
    const m = /^\[search\] open source (.*)$/.exec(msg.text());
    if (m) opened.push(JSON.parse(m[1]));
  });
  return opened;
}

test.describe("against a real upstream server", () => {
  test("answers a question with a source card from the seeded PDF", async ({ page }) => {
    test.skip(!!process.env.ASKFILES_UPSTREAM_SKIP, process.env.ASKFILES_UPSTREAM_SKIP);
    // qwen3 on four CPU cores reasons for a while before it answers.
    test.setTimeout(240_000);
    const opened = captureOpenEvents(page);
    const url = new URL(`${process.env.ASKFILES_PAGE_URL}/search/index.html`);
    url.search = new URLSearchParams({
      baseUrl: process.env.ASKFILES_UPSTREAM_URL,
      apiKey: process.env.ASKFILES_API_KEY,
      workspace: process.env.ASKFILES_WORKSPACE,
      folder: "/Users/test/Documents/Handbook",
    }).toString();
    await page.goto(url.toString());
    await expect(page.getByTestId("status-count")).toHaveText("1 document indexed");
    await expect(page.getByTestId("status-state")).toHaveAttribute("data-state", "ready");

    const streamResponse = page.waitForResponse((r) => r.url().endsWith("/stream-chat"), { timeout: 200_000 });
    await page.getByTestId("query").fill(QUESTION);
    await page.getByTestId("query").press("Enter");
    const events = (await (await streamResponse).text())
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)));
    const served = events.flatMap((e) => e.sources || []);
    expect(served.length, "the server returned sources for an answerable question").toBeGreaterThan(0);

    await expect(page.getByTestId("answer-text")).not.toBeEmpty({ timeout: 30_000 });
    const card = page.getByTestId("source-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("source-file")).toHaveText("handbook.pdf");
    await expect(card.getByTestId("source-passage").first()).toContainText("27 days of paid annual leave");
    await expect(card.getByTestId("source-passage").first()).not.toContainText("document_metadata");

    // Page and section title render only when the server sends them; a stock v1.19.0 server
    // sends neither (see the PR notes), so this asserts the card matches what was served.
    const servedPage = served.some((s) => s.page != null || s.pageNumber != null);
    const servedSection = served.some((s) => s.sectionTitle != null);
    await expect(card.getByTestId("source-page")).toBeVisible({ visible: servedPage });
    await expect(card.getByTestId("source-section")).toBeVisible({ visible: servedSection });
    console.log(`[e2e] real server sources carry page: ${servedPage}, section title: ${servedSection}`);

    await card.getByTestId("source-open").click();
    await expect.poll(() => opened.length).toBe(1);
    expect(opened[0]).toMatchObject({ title: "handbook.pdf" });
    await expect(page.getByTestId("recent-item").first()).toHaveText(QUESTION);

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/real-server-light.png`, fullPage: true });
    }
  });
});

test.describe("with the chat route mocked", () => {
  test("streams the answer and merges hits from the same section into one card", async ({ page }) => {
    const sources = [
      chunk({ id: "a", text: "Every employee receives 27 days of paid annual leave per year.", sectionTitle: "1 Annual leave", sectionIndex: 1, page: 4 }),
      chunk({ id: "b", text: "Unused leave can be carried over until the end of March.", sectionTitle: "1 Annual leave", sectionIndex: 1, page: 5 }),
      chunk({ id: "c", text: "Expense claims are submitted within 30 days.", sectionTitle: "2 Expense claims", sectionIndex: 2, page: 6 }),
    ];
    const { requests } = await mockLibrary(page, { stream: () => answerEvents("Employees receive 27 days of paid annual leave.", sources) });
    const opened = captureOpenEvents(page);
    await page.goto(pageUrl({ folder: "/Users/test/Documents" }));
    await expect(page.getByTestId("status-count")).toHaveText("3 documents indexed");
    await expect(page.getByTestId("status-folder")).toHaveText("/Users/test/Documents");

    await page.getByTestId("query").fill(QUESTION);
    await page.getByTestId("query").press("Enter");

    await expect(page.getByTestId("answer-text")).toHaveText("Employees receive 27 days of paid annual leave.");
    await expect(page.getByTestId("answer-text")).not.toContainText("reading");
    const cards = page.getByTestId("source-card");
    await expect(cards).toHaveCount(2);
    const merged = cards.nth(0);
    await expect(merged.getByTestId("source-file")).toHaveText("handbook.pdf");
    await expect(merged.getByTestId("source-section")).toHaveText("1 Annual leave");
    await expect(merged.getByTestId("source-page")).toHaveText("Pages 4 to 5");
    await expect(merged.getByTestId("source-passage")).toHaveCount(2);
    await expect(merged.getByTestId("source-count")).toHaveText("2 passages from this section");
    await expect(cards.nth(1).getByTestId("source-page")).toHaveText("Page 6");
    await expect(cards.nth(1).getByTestId("source-count")).toBeHidden();
    await expect(page.getByTestId("fallback")).toBeHidden();
    expect(requests.stream[0]).toEqual({ message: QUESTION, mode: "query", sessionId: "askfiles-search" });

    await merged.getByTestId("source-open").click();
    await expect.poll(() => opened).toEqual([
      { title: "handbook.pdf", url: "file:///library/handbook.pdf", sectionTitle: "1 Annual leave", sectionIndex: 1, page: 4 },
    ]);
  });

  test("a refusal answer renders the section list from vector search", async ({ page }) => {
    const near = [
      chunk({ id: "a", file: "travel-policy.pdf", text: "Train travel is booked in second class unless the trip exceeds four hours.", sectionTitle: "3 Booking travel", sectionIndex: 3, page: 2, score: 0.21 }),
      chunk({ id: "b", file: "travel-policy.pdf", text: "Hotels up to 120 euros per night are approved without a manager.", sectionTitle: "3 Booking travel", sectionIndex: 3, page: 3, score: 0.18 }),
      chunk({ id: "c", file: "handbook.pdf", text: "Expense claims are submitted through the finance portal.", sectionTitle: "2 Expense claims", sectionIndex: 2, page: 6, score: 0.12 }),
    ];
    const { requests } = await mockLibrary(page, {
      stream: () => refusalEvents(REFUSAL_TEXT),
      vector: () => near.map(asVectorResult),
    });
    await page.goto(pageUrl());
    await page.getByTestId("query").fill("Can I fly business class?");
    await page.getByTestId("query").press("Enter");

    const fallback = page.getByTestId("fallback");
    await expect(fallback).toBeVisible();
    await expect(page.getByTestId("answer-text")).toBeEmpty();
    await expect(page.getByTestId("sources")).toBeHidden();
    const items = page.getByTestId("fallback-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).getByTestId("fallback-section")).toHaveText("3 Booking travel");
    await expect(items.nth(0).getByTestId("fallback-file")).toHaveText("travel-policy.pdf");
    await expect(items.nth(0).getByTestId("fallback-page")).toHaveText("Pages 2 to 3");
    await expect(items.nth(1).getByTestId("fallback-section")).toHaveText("2 Expense claims");
    await expect(items.nth(1).getByTestId("fallback-page")).toHaveText("Page 6");
    expect(requests.vector[0]).toEqual({ query: "Can I fly business class?", topN: 8, scoreThreshold: 0 });
  });

  test("the fallback without section metadata shows file names, and says so when nothing matches", async ({ page }) => {
    let results = [chunk({ id: "a", text: "1 Annual leave\nEvery employee receives 27 days." })].map(asVectorResult);
    await mockLibrary(page, { stream: () => refusalEvents(REFUSAL_TEXT), vector: () => results });
    await page.goto(pageUrl());
    await page.getByTestId("query").fill("parking rules");
    await page.getByTestId("query").press("Enter");
    const item = page.getByTestId("fallback-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("fallback-section")).toHaveText("handbook.pdf");
    await expect(item.getByTestId("fallback-file")).toBeHidden();
    await expect(item.getByTestId("fallback-preview")).toHaveText("1 Annual leave Every employee receives 27 days.");

    results = [];
    await page.getByTestId("query").fill("weather tomorrow");
    await page.getByTestId("query").press("Enter");
    await expect(page.getByTestId("fallback-item")).toHaveCount(0);
    await expect(page.getByTestId("fallback")).toContainText("No section in your documents matches this question.");
  });

  test("keyboard: Shift+Enter adds a line, Escape clears, recent questions re-ask", async ({ page }) => {
    const { requests } = await mockLibrary(page, {
      history: ["What is the notice period?"],
      stream: (body) => answerEvents(`Answer to ${body.message}`, [chunk({ id: "a", text: "Body" })]),
    });
    await page.goto(pageUrl());
    await expect(page.getByTestId("recent-item")).toHaveText(["What is the notice period?"]);

    const query = page.getByTestId("query");
    await query.fill("first line");
    await query.press("Shift+Enter");
    await query.pressSequentially("second line");
    await expect(query).toHaveValue("first line\nsecond line");
    expect(requests.stream).toHaveLength(0);

    await query.press("Enter");
    await expect(page.getByTestId("answer-text")).toHaveText("Answer to first line second line");
    await expect(page.getByTestId("recent-item").first()).toHaveText("first line\nsecond line");

    await page.keyboard.press("Escape");
    await expect(query).toHaveValue("");
    await expect(page.getByTestId("answer")).toBeHidden();

    await page.getByTestId("recent-item").filter({ hasText: "notice period" }).click();
    await expect(page.getByTestId("answer-text")).toHaveText("Answer to What is the notice period?");
    await expect(query).toHaveValue("What is the notice period?");
  });

  test("the shell can report indexing state", async ({ page }) => {
    await mockLibrary(page);
    await page.goto(pageUrl());
    await expect(page.getByTestId("status-state")).toHaveAttribute("data-state", "ready");
    await page.evaluate(() => window.askfiles.setIndexStatus({ state: "indexing", pending: 4 }));
    await expect(page.getByTestId("status-state")).toHaveText("Indexing, 4 left");
    await page.evaluate(() => window.askfiles.setIndexStatus({ state: "idle" }));
    await expect(page.getByTestId("status-state")).toHaveText("Up to date");
  });

  test("a stream abort shows the error instead of an answer", async ({ page }) => {
    await mockLibrary(page, {
      stream: () => [{ uuid: "u", type: "abort", textResponse: null, sources: [], close: true, error: "model not found" }],
    });
    await page.goto(pageUrl());
    await page.getByTestId("query").fill(QUESTION);
    await page.getByTestId("query").press("Enter");
    await expect(page.getByTestId("error")).toHaveText("Something went wrong while answering: model not found");
    await expect(page.getByTestId("fallback")).toBeHidden();
  });

  test("reads config from window.shellConfig before query parameters", async ({ page }) => {
    await mockLibrary(page, { documents: 1 });
    await page.addInitScript((base) => {
      window.shellConfig = { baseUrl: base, apiKey: "test-key", workspace: "lib", folder: "/Users/shell/Docs" };
    }, "http://127.0.0.1:1");
    await page.goto(`${process.env.ASKFILES_PAGE_URL}/search/index.html?folder=ignored`);
    await expect(page.getByTestId("status-folder")).toHaveText("/Users/shell/Docs");
    await expect(page.getByTestId("status-count")).toHaveText("1 document indexed");
  });
});
