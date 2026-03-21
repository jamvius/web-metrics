import { chromium, devices as playwrightDevices } from 'playwright';
import { collectMetrics } from './collector.js';
import { report } from './reporter.js';

// Browser context options per device (viewport, user agent, etc.)
const CONTEXT_OPTIONS = {
  desktop: { viewport: { width: 1350, height: 940 } },
  mobile: playwrightDevices['iPhone 15'],
};

// CDP throttling profiles matching Lighthouse defaults.
// Mobile: Slow 4G + 4x CPU. Desktop: no throttling.
const THROTTLING = {
  desktop: {
    cpu: 1,
    network: null,
  },
  mobile: {
    cpu: 4,
    network: {
      latency: 150,                                          // ms RTT
      downloadThroughput: Math.round(1.6 * 1024 * 1024 / 8), // 1.6 Mbps → bytes/s
      uploadThroughput: Math.round(750 * 1024 / 8),           // 750 Kbps → bytes/s
    },
  },
};

export async function run(config) {
  const browser = await chromium.launch({
    headless: config.browser?.headless ?? true,
  });

  const results = [];
  const patterns = config.requests?.patterns ?? [];
  const totalRuns = config.runs ?? 1;
  const deviceNames = config.devices ?? ['desktop', 'mobile'];

  for (const urlConfig of config.urls) {
    for (const deviceName of deviceNames) {
      const contextOptions = CONTEXT_OPTIONS[deviceName] ?? CONTEXT_OPTIONS.desktop;
      const throttling = THROTTLING[deviceName] ?? THROTTLING.desktop;
      const runResults = [];

      console.log(`\n[${urlConfig.name || urlConfig.url}] — ${deviceName} — ${totalRuns} run(s)`);

      for (let i = 0; i < totalRuns; i++) {
        process.stdout.write(`  Run ${i + 1}/${totalRuns} ... `);

        // Each run gets a fresh context so cache/state doesn't carry over
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        try {
          const result = await collectMetrics(page, urlConfig, patterns, throttling);
          runResults.push(result);
          process.stdout.write('done\n');
        } catch (err) {
          process.stdout.write(`FAILED: ${err.message}\n`);
        }

        await context.close();
      }

      results.push({
        name: urlConfig.name || urlConfig.url,
        url: urlConfig.url,
        device: deviceName,
        runs: runResults,
        stats: computeStats(runResults),
        groupedRequests: groupRequests(runResults),
      });
    }
  }

  await browser.close();

  report(results, config.output);
}

function computeStats(runs) {
  const metrics = ['lcp', 'fcp', 'cls', 'tbt', 'ttfb', 'dcl', 'load', 'si'];
  const stats = {};

  for (const metric of metrics) {
    const values = runs
      .map((r) => r.vitals[metric])
      .filter((v) => v !== null && v !== undefined);

    if (!values.length) {
      stats[metric] = null;
      continue;
    }

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const decimals = metric === 'cls' ? 3 : 0;

    stats[metric] = {
      mean: roundTo(mean, decimals),
      stddev: roundTo(Math.sqrt(variance), decimals),
      min: metric === 'cls' ? roundTo(Math.min(...values), decimals) : Math.min(...values),
      max: metric === 'cls' ? roundTo(Math.max(...values), decimals) : Math.max(...values),
    };
  }

  // Aggregate Lighthouse scores across runs
  const scores = runs.map((r) => r.score).filter((s) => s !== null);
  if (scores.length) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    stats.score = {
      mean: Math.round(mean),
      stddev: Math.round(Math.sqrt(variance)),
      min: Math.min(...scores),
      max: Math.max(...scores),
    };
  } else {
    stats.score = null;
  }

  return stats;
}

// Groups requests across all runs by method+url and computes stats
// for startOffset and duration.
function groupRequests(runs) {
  const map = new Map();

  for (const run of runs) {
    for (const req of run.requests) {
      const key = `${req.method}:${req.url}`;
      if (!map.has(key)) {
        map.set(key, {
          url: req.url,
          method: req.method,
          status: req.status,
          size: req.size,
          contentType: req.contentType,
          offsets: [],
          durations: [],
        });
      }
      const entry = map.get(key);
      entry.status = req.status;
      if (req.size) entry.size = req.size;
      if (req.startOffset != null) entry.offsets.push(req.startOffset);
      if (req.duration != null) entry.durations.push(req.duration);
    }
  }

  return Array.from(map.values())
    .map(({ offsets, durations, ...rest }) => ({
      ...rest,
      runs: Math.max(offsets.length, durations.length),
      startOffset: aggStats(offsets),
      duration: aggStats(durations),
    }))
    .sort((a, b) => (a.startOffset?.mean ?? 0) - (b.startOffset?.mean ?? 0));
}

function aggStats(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    mean: Math.round(mean),
    stddev: Math.round(Math.sqrt(variance)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
