// Captures the page states for the PR in light and dark mode. Runs only with SCREENSHOT_DIR set:
//   SCREENSHOT_DIR=docs/screenshots/search npx playwright test screenshots
import { test } from "@playwright/test";
import { REFUSAL_TEXT } from "../../src/renderer/api/client.js";
import { mockLibrary, pageUrl, answerEvents, refusalEvents, chunk, asVectorResult } from "./mocks.js";

const dir = process.env.SCREENSHOT_DIR;
const history = ["Who approves travel over 500 euros?", "What is the notice period?", "年假可以结转吗?"];
const sources = [
  chunk({ id: "a", text: "Every employee of Northwind receives 27 days of paid annual leave per year.", sectionTitle: "1 Annual leave", sectionIndex: 1, page: 4 }),
  chunk({ id: "b", text: "Unused leave can be carried over until the end of March of the next year.", sectionTitle: "1 Annual leave", sectionIndex: 1, page: 5 }),
  chunk({ id: "c", file: "员工手册-2026.pdf", text: "每位员工每年享有二十七天带薪年假。未使用的年假可结转至次年三月底。", sectionTitle: "第三章 休假", sectionIndex: 3, page: 12 }),
];
const near = [
  chunk({ id: "a", file: "travel-policy.pdf", text: "Train travel is booked in second class unless the trip exceeds four hours.", sectionTitle: "3 Booking travel", sectionIndex: 3, page: 2 }),
  chunk({ id: "b", file: "handbook.pdf", text: "Expense claims are submitted through the finance portal within 30 days.", sectionTitle: "2 Expense claims", sectionIndex: 2, page: 6 }),
  chunk({ id: "c", file: "员工手册-2026.pdf", text: "出差报销须在三十天内通过财务系统提交。", sectionTitle: "第五章 报销", sectionIndex: 5, page: 18 }),
];

for (const scheme of ["light", "dark"]) {
  test(`screenshot answer ${scheme}`, async ({ page }) => {
    test.skip(!dir, "SCREENSHOT_DIR not set");
    await page.emulateMedia({ colorScheme: scheme });
    await mockLibrary(page, {
      documents: 14,
      history,
      stream: () => answerEvents("Employees receive 27 days of paid annual leave per year. Unused days can be carried over until the end of March of the following year.", sources),
    });
    await page.goto(pageUrl({ folder: "/Users/anna/Documents/HR" }));
    await page.getByTestId("query").fill("How many days of annual leave do I get?");
    await page.getByTestId("query").press("Enter");
    await page.getByTestId("source-card").nth(1).waitFor();
    await page.screenshot({ path: `${dir}/answer-${scheme}.png`, fullPage: true });
  });

  test(`screenshot fallback ${scheme}`, async ({ page }) => {
    test.skip(!dir, "SCREENSHOT_DIR not set");
    await page.emulateMedia({ colorScheme: scheme });
    await mockLibrary(page, { documents: 14, history, stream: () => refusalEvents(REFUSAL_TEXT), vector: () => near.map(asVectorResult) });
    await page.goto(pageUrl({ folder: "/Users/anna/Documents/HR" }));
    await page.evaluate(() => window.askfiles.setIndexStatus({ state: "indexing", pending: 3 }));
    await page.getByTestId("query").fill("Can I fly business class?");
    await page.getByTestId("query").press("Enter");
    await page.getByTestId("fallback-item").nth(2).waitFor();
    await page.screenshot({ path: `${dir}/fallback-${scheme}.png`, fullPage: true });
  });
}
