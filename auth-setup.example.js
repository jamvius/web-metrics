/**
 * Example auth setup script for web-metrics.
 *
 * This file is executed once before measurements begin.
 * It receives the Playwright browser instance and the path where
 * storageState (cookies + localStorage) should be saved.
 *
 * Reference it in config.json:
 *   "auth": {
 *     "setupScript": "./auth-setup.js",
 *     "storageState": "./auth-state.json"
 *   }
 *
 * Copy this file to auth-setup.js and adapt it to your login flow.
 */

export default async function setup(browser, storageStatePath, loginUrl = 'https://example.com/login') {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(loginUrl);

  await page.fill('input[name="email"]', process.env.AUTH_EMAIL ?? '');
  await page.fill('input[name="password"]', process.env.AUTH_PASSWORD ?? '');
  await page.click('button[type="submit"]');

  // Wait until navigation confirms a successful login
  await page.waitForURL('**/dashboard', { timeout: 15000 });

  // Save cookies and localStorage so contexts can reuse them
  await context.storageState({ path: storageStatePath });

  await context.close();
}
