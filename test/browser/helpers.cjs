"use strict";

// Optional real-browser regressions. Use an externally installed Playwright
// and Chromium so the app and its normal test suite need no new dependencies.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const server = require("../helpers/server");

async function openBrowser() {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox"],
  });
}

async function signedInPage(browser, baseUrl, t) {
  const user = await server.registerUser(baseUrl, "browser");
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addCookies([{ name: "connect.sid", value: user.c.cookie(), url: baseUrl }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => require("node:assert/strict").deepEqual(errors, [], "browser exceptions"));
  return { page, user };
}

module.exports = { ...server, openBrowser, signedInPage };
