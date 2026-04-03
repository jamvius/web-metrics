import speedline from 'speedline-core';
import { computeLighthouseScore } from './score.js';
import { analyzePageScripts } from './script-analyzer.js';

// Injected into the page before navigation to collect vitals via PerformanceObserver
const INIT_SCRIPT = `
  window.__webMetrics = { lcp: null, fcp: null, cls: 0, tbt: 0 };

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) {
        window.__webMetrics.lcp = entries[entries.length - 1].startTime;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          window.__webMetrics.fcp = entry.startTime;
        }
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__webMetrics.cls += entry.value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // TBT counts blocking time: the portion of each long task beyond 50ms
        window.__webMetrics.tbt += Math.max(entry.duration - 50, 0);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (_) {}
`;

export async function collectMetrics(page, urlConfig, patterns, throttling = null) {
  // Apply CDP throttling before navigation to match Lighthouse conditions
  const cdp = await page.context().newCDPSession(page);

  if (throttling?.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: throttling.network.latency,
      downloadThroughput: throttling.network.downloadThroughput,
      uploadThroughput: throttling.network.uploadThroughput,
    });
  }

  if (throttling?.cpu > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttling.cpu });
  }

  // Accumulate Chrome trace events for Speed Index calculation (speedline-core)
  const traceEvents = [];
  cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.screenshot',
    transferMode: 'ReportEvents',
  });

  const requestMap = new Map(); // Playwright Request object -> tracking data
  const trackedRequests = [];

  await page.addInitScript(INIT_SCRIPT);

  page.on('request', (request) => {
    if (!matchesPatterns(request.url(), patterns)) return;
    requestMap.set(request, {
      url: request.url(),
      method: request.method(),
    });
  });

  // response fires when headers arrive — capture status and content metadata
  page.on('response', async (response) => {
    const entry = requestMap.get(response.request());
    if (!entry) return;

    entry.status = response.status();
    try {
      const headers = response.headers();
      const contentLength = parseInt(headers['content-length'] || '0', 10);
      if (contentLength > 0) entry.size = contentLength;
      const contentType = headers['content-type']?.split(';')[0];
      if (contentType) entry.contentType = contentType;
    } catch (_) {}
  });

  // requestfinished fires when the body is fully received — only here is responseEnd set
  page.on('requestfinished', (request) => {
    const entry = requestMap.get(request);
    if (!entry) return;

    const t = request.timing();
    entry.absStartTime = t.startTime;
    // responseEnd is ms elapsed since startTime, so it already equals the total duration
    entry.duration = t.responseEnd >= 0 ? Math.round(t.responseEnd) : null;

    trackedRequests.push(entry);
    requestMap.delete(request);
  });

  // requestfailed fires for aborted/failed requests — clean up the map
  page.on('requestfailed', (request) => requestMap.delete(request));

  let timedOut = false;
  try {
    await page.goto(urlConfig.url, {
      waitUntil: urlConfig.waitUntil ?? 'networkidle',
      timeout: urlConfig.timeout ?? 30000,
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      timedOut = true;
    } else {
      throw err;
    }
  }

  // Give LCP/CLS observers time to flush (skip on timeout to avoid extra delay)
  if (!timedOut) {
    await page.waitForTimeout(500);
  }

  // Stop tracing and wait for all chunks to arrive
  const traceComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  await traceComplete;

  // Calculate Speed Index from the trace (same approach as Lighthouse)
  let si = null;
  try {
    const siResult = await speedline({ traceEvents });
    si = Math.round(siResult.speedIndex);
  } catch (_) {
    // speedline fails if there are too few screenshot frames (e.g. very fast pages)
  }

  let vitals = { lcp: null, fcp: null, cls: null, tbt: null, ttfb: null, dcl: null, load: null };
  try {
    vitals = await page.evaluate(() => {
      const m = window.__webMetrics;
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        lcp: m.lcp != null ? Math.round(m.lcp) : null,
        fcp: m.fcp != null ? Math.round(m.fcp) : null,
        cls: parseFloat(m.cls.toFixed(3)),
        tbt: Math.round(m.tbt),
        ttfb: nav ? Math.round(nav.responseStart) : null,
        dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav ? Math.round(nav.loadEventEnd) : null,
      };
    });
  } catch (_) {
    // Page may be unresponsive after timeout — keep null vitals
  }

  vitals.si = si;

  const score = computeLighthouseScore(vitals);

  // Compute startOffset using Chrome's internal clock (same source as request.timing())
  let navigationStart = null;
  try {
    navigationStart = await page.evaluate(() => performance.timing.navigationStart);
  } catch (_) {}

  for (const req of trackedRequests) {
    req.startOffset = navigationStart != null ? Math.round(req.absStartTime - navigationStart) : null;
    delete req.absStartTime;
  }

  trackedRequests.sort((a, b) => a.startOffset - b.startOffset);

  let scripts = [];
  try {
    scripts = await analyzePageScripts(page);
  } catch (_) {}

  return {
    name: urlConfig.name || urlConfig.url,
    url: urlConfig.url,
    timestamp: new Date().toISOString(),
    timedOut,
    score,
    vitals,
    requests: trackedRequests,
    scripts,
  };
}

function matchesPatterns(url, patterns) {
  if (!patterns.length) return false;
  return patterns.some((p) => new RegExp(p).test(url));
}
