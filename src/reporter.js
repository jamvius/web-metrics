import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { scoreLabel, scoreColor } from './score.js';

const THRESHOLDS = {
  lcp:  { good: 2500, poor: 4000, unit: 'ms' },
  fcp:  { good: 1800, poor: 3000, unit: 'ms' },
  cls:  { good: 0.1,  poor: 0.25, unit: '' },
  tbt:  { good: 200,  poor: 600,  unit: 'ms' },
  ttfb: { good: 800,  poor: 1800, unit: 'ms' },
  dcl:  { unit: 'ms' },
  load: { unit: 'ms' },
  si:   { good: 3400, poor: 5800, unit: 'ms' },
};

const METRICS = Object.keys(THRESHOLDS);

function rating(metric, value) {
  if (value === null || value === undefined) return 'na';
  const t = THRESHOLDS[metric];
  if (!t || t.good == null) return 'na';
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'needs-improvement';
  return 'poor';
}

function fmtVal(metric, value) {
  if (value === null || value === undefined) return 'N/A';
  return THRESHOLDS[metric]?.unit === 'ms' ? `${value}ms` : `${value}`;
}

function formatSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Console ────────────────────────────────────────────────────────────────

const RATING_LABEL = {
  good: '\x1b[32mGood\x1b[0m',
  'needs-improvement': '\x1b[33mNeeds improvement\x1b[0m',
  poor: '\x1b[31mPoor\x1b[0m',
  na: '-',
};

function printConsole(results) {
  for (const result of results) {
    const sep = '─'.repeat(72);
    console.log(`\n${sep}`);
    console.log(`\x1b[1m${result.name}\x1b[0m [${result.device}]  ${result.url}`);
    console.log(sep);

    if (!result.runs.length) {
      console.log('  All runs failed.');
      continue;
    }

    if (result.timedOutRuns > 0) {
      console.log(`  \x1b[33m⚠ ${result.timedOutRuns}/${result.runs.length} run(s) with timeout (partial metrics)\x1b[0m`);
    }

    // Performance score
    const sc = result.stats.score;
    if (sc) {
      const ansiColor = sc.mean >= 90 ? '\x1b[32m' : sc.mean >= 50 ? '\x1b[33m' : '\x1b[31m';
      const label = scoreLabel(sc.mean);
      console.log(
        `\nPerformance Score: ${ansiColor}\x1b[1m${sc.mean}\x1b[0m  ${label}` +
        (sc.min !== sc.max ? `  (min ${sc.min} / max ${sc.max})` : '')
      );
    }

    console.log('\nWeb Vitals (stats over all runs):');
    console.log(
      `  ${'METRIC'.padEnd(6)}  ${'MEAN'.padStart(9)}  ${'±STDDEV'.padStart(9)}  ${'MIN'.padStart(9)}  ${'MAX'.padStart(9)}  RATING`
    );

    for (const metric of METRICS) {
      const s = result.stats[metric];
      if (!s) {
        console.log(`  ${metric.toUpperCase().padEnd(6)}  ${'N/A'.padStart(9)}`);
        continue;
      }
      const r = rating(metric, s.mean);
      console.log(
        `  ${metric.toUpperCase().padEnd(6)}` +
        `  ${fmtVal(metric, s.mean).padStart(9)}` +
        `  ${('±' + fmtVal(metric, s.stddev)).padStart(9)}` +
        `  ${fmtVal(metric, s.min).padStart(9)}` +
        `  ${fmtVal(metric, s.max).padStart(9)}` +
        `  ${RATING_LABEL[r]}`
      );
    }

    if (result.groupedRequests?.length) {
      console.log(`\nRequests (grouped, ${result.runs.length} run(s)):`);
      console.log(
        `  ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} ${'OFFSET mean±sd'.padEnd(18)} ${'DURATION mean±sd'.padEnd(18)} ${'SIZE'.padEnd(8)} URL`
      );
      for (const req of result.groupedRequests) {
        const method  = req.method.padEnd(7);
        const status  = String(req.status ?? '-').padEnd(7);
        const offset  = req.startOffset
          ? `+${req.startOffset.mean}ms ±${req.startOffset.stddev}`.padEnd(18)
          : '-'.padEnd(18);
        const dur     = req.duration
          ? `${req.duration.mean}ms ±${req.duration.stddev}`.padEnd(18)
          : '-'.padEnd(18);
        const size    = formatSize(req.size).padEnd(8);
        console.log(`  ${method} ${status} ${offset} ${dur} ${size} ${req.url}`);
      }
    }
  }
  console.log(`\n${'─'.repeat(72)}\n`);
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function buildHtml(results) {
  const timestamp = new Date().toLocaleString();

  const blocks = results.map((r) => {
    const statsRows = METRICS.map((metric) => {
      const s = r.stats[metric];
      if (!s) return `<tr><td class="metric">${metric.toUpperCase()}</td><td colspan="4" class="na">N/A</td><td class="na">-</td></tr>`;
      const rat = rating(metric, s.mean);
      return `<tr>
        <td class="metric">${metric.toUpperCase()}</td>
        <td class="value">${fmtVal(metric, s.mean)}</td>
        <td class="value muted">±${fmtVal(metric, s.stddev)}</td>
        <td class="value muted">${fmtVal(metric, s.min)}</td>
        <td class="value muted">${fmtVal(metric, s.max)}</td>
        <td class="${rat}">${rat.replace('-', ' ')}</td>
      </tr>`;
    }).join('');

    const requestRows = (r.groupedRequests ?? []).map((req) => {
      const statusClass = req.status >= 400 ? 'status-error' : 'status-ok';
      const offsetCell = req.startOffset
        ? `+${req.startOffset.mean}ms <span class="muted">±${req.startOffset.stddev}</span>`
        : '-';
      const durCell = req.duration
        ? `${req.duration.mean}ms <span class="muted">±${req.duration.stddev}</span>`
        : '-';
      return `<tr>
        <td class="method">${esc(req.method)}</td>
        <td class="req-url" title="${esc(req.url)}">${esc(req.url)}</td>
        <td class="${statusClass}">${req.status ?? '-'}</td>
        <td class="num">${offsetCell}</td>
        <td class="num">${durCell}</td>
        <td class="muted">${formatSize(req.size)}</td>
        <td class="muted">${req.runs}/${r.runs.length}</td>
      </tr>`;
    }).join('');

    const requestsBlock = r.groupedRequests?.length
      ? `<h3>Requests <span class="muted">(${r.runs.length} run(s), mean ± stddev)</span></h3>
         <table class="requests">
           <thead>
             <tr><th>Method</th><th>URL</th><th>Status</th><th>Offset</th><th>Duration</th><th>Size</th><th>Runs</th></tr>
           </thead>
           <tbody>${requestRows}</tbody>
         </table>`
      : '';

    const noRuns = !r.runs.length
      ? `<p class="error-msg">All runs failed.</p>`
      : '';

    const timeoutWarning = r.timedOutRuns > 0
      ? `<p class="timeout-warning">${r.timedOutRuns}/${r.runs.length} run(s) with timeout — partial metrics</p>`
      : '';

    const sc = r.stats.score;
    const scoreBadge = sc
      ? `<div class="score-badge" style="--score-color:${scoreColor(sc.mean)}">
           <span class="score-num">${sc.mean}</span>
           <span class="score-lbl">${scoreLabel(sc.mean)}</span>
           ${sc.min !== sc.max ? `<span class="score-range">min ${sc.min} / max ${sc.max}</span>` : ''}
         </div>`
      : '';

    return `
      <section class="result">
        <div class="result-header">
          <div class="result-title">
            <h2>${esc(r.name)} <span class="device-badge ${r.device}">${r.device}</span></h2>
            <span class="url">${esc(r.url)}</span>
          </div>
          ${scoreBadge}
        </div>
        ${noRuns}
        ${timeoutWarning}
        <h3>Web Vitals</h3>
        <table class="vitals">
          <thead>
            <tr><th>Metric</th><th>Mean</th><th>±Std dev</th><th>Min</th><th>Max</th><th>Rating</th></tr>
          </thead>
          <tbody>${statsRows}</tbody>
        </table>
        ${requestsBlock}
      </section>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web Metrics Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; font-size: 14px; color: #1a1a1a; background: #f5f5f5; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .generated { color: #666; font-size: 12px; margin-bottom: 24px; }
    .result { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .result-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .result-title { flex: 1; min-width: 0; }
    h2 { font-size: 16px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .url { font-size: 12px; color: #555; display: block; }
    .score-badge { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 72px; min-width: 72px; height: 72px; border-radius: 50%; border: 4px solid var(--score-color); color: var(--score-color); text-align: center; }
    .score-num { font-size: 22px; font-weight: 700; line-height: 1; }
    .score-lbl { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; margin-top: 2px; }
    .score-range { font-size: 9px; color: #888; margin-top: 1px; }
    .device-badge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 4px; text-transform: uppercase; letter-spacing: .04em; }
    .device-badge.desktop { background: #e8eaf6; color: #3949ab; }
    .device-badge.mobile  { background: #fce4ec; color: #c62828; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #666; margin: 16px 0 8px; }
    h4 { font-size: 12px; color: #444; margin: 20px 0 6px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 4px; }
    th { text-align: left; padding: 6px 10px; background: #f0f0f0; border-bottom: 1px solid #ddd; }
    td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; }
    .metric { font-weight: 700; width: 58px; }
    .value { font-variant-numeric: tabular-nums; }
    .muted { color: #888; font-size: 12px; }
    .good  { color: #1a7a1a; font-weight: 600; }
    .needs-improvement { color: #a06000; font-weight: 600; }
    .poor  { color: #b00020; font-weight: 600; }
    .na    { color: #999; }
    .offset { color: #888; width: 80px; white-space: nowrap; }
    .method { font-weight: 600; width: 55px; }
    .req-url { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 12px; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .status-ok    { color: #1a7a1a; }
    .status-error { color: #b00020; font-weight: 600; }
    .error-msg { color: #b00020; margin: 8px 0; }
    .timeout-warning { color: #a06000; background: #fff8e1; border: 1px solid #ffe082; border-radius: 4px; padding: 6px 10px; margin: 8px 0; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Web Metrics Report</h1>
  <p class="generated">Generated: ${timestamp}</p>
  ${blocks.join('\n')}
</body>
</html>`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function report(results, outputConfig = {}, runInfo = {}) {
  printConsole(results);

  const { name = 'results', timestamp = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19) } = runInfo;

  // Output directory: <configName>/
  const outDir = name;
  mkdirSync(outDir, { recursive: true });

  const htmlPath = join(outDir, `${timestamp}.html`);
  writeFileSync(htmlPath, buildHtml(results));
  console.log(`HTML report saved to ${htmlPath}`);

  if (outputConfig?.json !== undefined) {
    const jsonPath = join(outDir, `${timestamp}.json`);
    writeFileSync(jsonPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
    console.log(`JSON results saved to ${jsonPath}`);
  }
}
