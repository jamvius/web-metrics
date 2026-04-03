# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Node.js CLI tool that navigates to a configured list of URLs using Playwright (headless Chromium), collects Web Vitals (LCP, FCP, CLS, TBT, TTFB), and tracks the timing and status of network requests matching configurable regexp patterns. Each URL is measured across multiple devices and repeated N times; results include mean, stddev, min, and max per metric. Output is a self-contained HTML report and optionally JSON.

## Commands

```bash
# Install dependencies (also downloads Chromium)
npm install
npx playwright install chromium

# Run with the default config.json
npm start

# Run with a specific config
node src/index.js my-config.json
```

## Architecture

The flow is: `index.js` reads the JSON config → `runner.js` opens a browser, iterates URLs × devices × runs → `collector.js` measures one page → `reporter.js` writes output.

**`src/runner.js`** controls the outer loops. For each URL × device combination it creates N fresh browser contexts (so cache/state never carries over between runs), calls `collectMetrics` for each, and computes aggregate statistics with `computeStats`. The result array has the shape `{ name, url, device, runs[], stats }`.

**`src/collector.js`** is the measurement core. It injects `INIT_SCRIPT` into the page *before* navigation to register `PerformanceObserver` listeners for LCP, FCP, CLS and long tasks (TBT). Playwright's `page.on('request')` / `page.on('response')` track request start offsets and response status/duration against a `Map<Request, data>`. After `page.goto()` settles, `page.evaluate()` reads `window.__webMetrics` for the vitals; TTFB comes from `performance.getEntriesByType('navigation')[0].responseStart`. When `scripts.analyzeDomains` is configured, the `response` listener also buffers the body of matching external scripts (resource type `script`) so they can be statically analysed by `src/script-analyzer.js`.

**`src/script-analyzer.js`** enumerates all `<script>` elements after navigation, cross-references `PerformanceResourceTiming` for timing data, sorts them by execution order (sync → defer → async by responseEnd), and runs static regex analysis. Inline scripts are always analysed from their `textContent`; external scripts are analysed when their source was captured by the response interceptor in `collector.js` and passed in via `externalContents`. Exports: `analyzePageScripts`, `aggregateScripts`, `printScriptsConsole`, `buildScriptsHtml`, `SCRIPTS_CSS`.

**Request offset**: `startOffset = Date.now()` at request time minus `Date.now()` captured just before `page.goto()`. Wall-clock based, so very early requests may appear at offset 0.

**`src/reporter.js`** produces console output (ANSI) and a self-contained HTML file. HTML is built via template literals with no external dependencies. The stats table shows Mean / ±Stddev / Min / Max per vital; requests are shown per-run below the stats.

## Device profiles (`runner.js`)

| Key | Profile |
|---|---|
| `"desktop"` | Viewport 1280×720, default UA |
| `"mobile"` | `playwright.devices['iPhone 15']` (390×844, mobile UA) |

## Config schema

| Field | Type | Default | Description |
|---|---|---|---|
| `runs` | number | `1` | Number of times each URL is measured |
| `devices` | string[] | `["desktop","mobile"]` | Device keys to test |
| `urls[].url` | string | — | URL to measure |
| `urls[].name` | string | — | Label in output |
| `urls[].waitUntil` | string | `"networkidle"` | Playwright `waitUntil` |
| `urls[].timeout` | number | `30000` | Navigation timeout ms |
| `requests.patterns` | string[] | `[]` | Regexp strings; matching requests are tracked |
| `scripts.analyzeDomains` | string[] | `[]` | Regexp strings; external scripts whose URL matches are downloaded during navigation and statically analysed for DOM mutations, window additions, event listeners, and timers (same analysis as inline scripts) |
| `output.html` | string | `"results.html"` | HTML report path |
| `output.json` | string | — | JSON output path (optional) |
| `browser.headless` | boolean | `true` | |

## Web Vitals thresholds

| Metric | Good | Poor |
|---|---|---|
| LCP | ≤ 2500ms | > 4000ms |
| FCP | ≤ 1800ms | > 3000ms |
| CLS | ≤ 0.1 | > 0.25 |
| TBT | ≤ 200ms | > 600ms |
| TTFB | ≤ 800ms | > 1800ms |
