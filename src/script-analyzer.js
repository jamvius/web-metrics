// ─── Page analysis ───────────────────────────────────────────────────────────
// Runs inside the browser via page.evaluate() after navigation.
// Enumerates every <script> element, cross-references PerformanceResourceTiming
// for external scripts, then returns the list sorted by real execution order:
//   1. Sync scripts (no async/defer/module) — in DOM order (parser-blocking)
//   2. Deferred / module scripts            — in DOM order (after HTML parse)
//   3. Async scripts                        — by responseEnd (first-loaded, first-run)
//
// Inline scripts are always statically analysed.
// External scripts are statically analysed when their source was captured via
// the Playwright response interceptor (collector.js) and passed in externalContents.
// The analysis detects:
//   - DOM modifications (createElement, innerHTML, appendChild, etc.)
//   - Variables and functions added to the window scope
//   - Event listener registrations (addEventListener / on* handlers)
//   - Timer calls (setTimeout / setInterval)
//
// @param {import('playwright').Page} page
// @param {Map<string,string>} externalContents  URL → source code captured by collector

export async function analyzePageScripts(page, externalContents = new Map()) {
  // Serialize the Map to a plain object for the page.evaluate() boundary.
  const extContentsObj = Object.fromEntries(externalContents);

  return await page.evaluate((extContents) => {
    // ── Resource timing for external scripts ──────────────────────────────
    const resourceTimings = new Map();
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry.initiatorType === 'script') {
        resourceTimings.set(entry.name, {
          startTime:   Math.round(entry.startTime),
          duration:    Math.round(entry.duration),
          responseEnd: Math.round(entry.responseEnd),
        });
      }
    }

    // ── Static analysis helpers ───────────────────────────────────────────
    const DOM_MOD_PATTERNS = [
      /document\.(createElement|createTextNode|createElementNS|createDocumentFragment|write|writeln)\s*\(/,
      /\.(innerHTML|outerHTML|textContent|innerText)\s*=/,
      /\.(appendChild|insertBefore|replaceChild|removeChild|prepend|append|before|after|replaceWith|insertAdjacentHTML|insertAdjacentElement|insertAdjacentText)\s*\(/,
      /\.(setAttribute|removeAttribute|toggleAttribute)\s*\(/,
      /\.classList\.(add|remove|toggle|replace)\s*\(/,
      /\.style\.\w+\s*=/,
    ];

    function detectDomModification(code) {
      return DOM_MOD_PATTERNS.some((re) => re.test(code));
    }

    function detectWindowAdditions(code) {
      const names = new Set();
      for (const m of code.matchAll(/window\.(\w+)\s*=/g)) names.add(m[1]);
      for (const m of code.matchAll(/^(?:var|let|const)\s+(\w+)/gm)) names.add(m[1]);
      for (const m of code.matchAll(/^function\s+(\w+)\s*\(/gm)) names.add(m[1]);
      return [...names];
    }

    function detectListeners(code) {
      const events = new Set();
      for (const m of code.matchAll(/\.addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/g)) events.add(m[1]);
      for (const m of code.matchAll(/\.(on[a-z]+)\s*=/g)) events.add(m[1]);
      return [...events];
    }

    function detectTimers(code) {
      const timers = [];
      if (/\bsetTimeout\s*\(/.test(code)) timers.push('setTimeout');
      if (/\bsetInterval\s*\(/.test(code)) timers.push('setInterval');
      return timers;
    }

    // ── Build entry per <script> element ─────────────────────────────────
    const scripts = Array.from(document.querySelectorAll('script')).map((el, domIndex) => {
      const isExternal = !!el.src;
      const isModule   = el.type === 'module';
      const isAsync    = el.async && isExternal;
      const isDefer    = (el.defer || isModule) && isExternal;

      // Source: inline textContent, or intercepted body for external scripts.
      const content  = isExternal ? (extContents[el.src] || '') : (el.textContent || '');
      // analyzed=true means static analysis will be / was performed.
      const analyzed = !isExternal || !!extContents[el.src];

      const entry = {
        domIndex,
        type:       isExternal ? 'external' : 'inline',
        src:        isExternal ? el.src : null,
        scriptType: el.type || 'text/javascript',
        loadMode:   isAsync ? 'async' : isDefer ? 'defer' : 'sync',
        analyzed,
        sizeBytes:  isExternal ? (content.length || null) : content.length,
        timing:     isExternal ? (resourceTimings.get(el.src) ?? null) : null,
        features: {
          domModification:  false,
          windowAdditions:  [],
          eventListeners:   [],
          timers:           [],
        },
      };

      if (analyzed && content.trim()) {
        entry.features.domModification = detectDomModification(content);
        entry.features.windowAdditions = detectWindowAdditions(content);
        entry.features.eventListeners  = detectListeners(content);
        entry.features.timers          = detectTimers(content);
      }

      return entry;
    });

    // ── Sort by execution order ───────────────────────────────────────────
    const sync   = scripts.filter((s) => s.loadMode === 'sync');
    const defer  = scripts.filter((s) => s.loadMode === 'defer');
    const async_ = scripts
      .filter((s) => s.loadMode === 'async')
      .sort((a, b) => (a.timing?.responseEnd ?? 0) - (b.timing?.responseEnd ?? 0));

    return [...sync, ...defer, ...async_].map((s, i) => ({ ...s, execOrder: i + 1 }));
  }, extContentsObj);
}

// ─── Runner aggregation ──────────────────────────────────────────────────────
// Script analysis is structural (not a per-run metric).
// Returns the scripts array from the first successful run.

export function aggregateScripts(runResults) {
  return runResults.find((r) => r.scripts?.length)?.scripts ?? [];
}

// ─── Console output ──────────────────────────────────────────────────────────

export function printScriptsConsole(result) {
  if (!result.scripts?.length) return;

  const inlineCount    = result.scripts.filter((s) => s.type === 'inline').length;
  const externalCount  = result.scripts.filter((s) => s.type === 'external').length;
  const analyzedExtCount = result.scripts.filter((s) => s.type === 'external' && s.analyzed).length;
  console.log(
    `\nScripts (${result.scripts.length} total — ${inlineCount} inline, ${externalCount} external` +
    (analyzedExtCount ? `, ${analyzedExtCount} external analyzed` : '') +
    `, sorted by execution order):`
  );

  // ── External scripts ──
  const external = result.scripts.filter((s) => s.type === 'external');
  if (external.length) {
    console.log(`\n  External scripts:`);
    console.log(
      `  ${'EXEC'.padEnd(5)} ${'MODE'.padEnd(6)} ${'ANALYZED'.padEnd(9)} ${'START'.padEnd(9)} ${'DUR'.padEnd(9)} URL`
    );
    for (const s of external) {
      const exec     = `#${s.execOrder}`.padEnd(5);
      const mode     = s.loadMode.padEnd(6);
      const analyzed = (s.analyzed ? 'yes' : 'no').padEnd(9);
      const start    = (s.timing ? `+${s.timing.startTime}ms` : '-').padEnd(9);
      const dur      = (s.timing ? `${s.timing.duration}ms` : '-').padEnd(9);
      console.log(`  ${exec} ${mode} ${analyzed} ${start} ${dur} ${s.src}`);
    }
  }

  // ── Features table (inline + analyzed external) ──
  const analyzed = result.scripts.filter((s) => s.analyzed);
  if (analyzed.length) {
    console.log(`\n  Script features (inline + analyzed external):`);
    console.log(
      `  ${'EXEC'.padEnd(5)} ${'TYPE'.padEnd(9)} ${'SIZE'.padEnd(8)} ${'DOM'.padEnd(5)} ${'TIMERS'.padEnd(26)} ${'LISTENERS'.padEnd(30)} WINDOW ADDITIONS`
    );
    for (const s of analyzed) {
      const exec      = `#${s.execOrder}`.padEnd(5);
      const type      = s.type.padEnd(9);
      const size      = (s.sizeBytes != null ? fmtSize(s.sizeBytes) : '-').padEnd(8);
      const dom       = (s.features.domModification ? 'yes' : 'no').padEnd(5);
      const timers    = (s.features.timers.join(', ') || '-').padEnd(26);
      const listeners = (s.features.eventListeners.join(', ') || '-').padEnd(30);
      const window_   = s.features.windowAdditions.join(', ') || '-';
      console.log(`  ${exec} ${type} ${size} ${dom} ${timers} ${listeners} ${window_}`);
    }
  }
}

// ─── HTML output ─────────────────────────────────────────────────────────────

// CSS rules required by the scripts tables. Embed in the report <style> block.
export const SCRIPTS_CSS = `
    .scripts-section h4 { font-size: 12px; color: #444; margin: 16px 0 6px; font-weight: 600; text-transform: none; letter-spacing: 0; }
    .scripts td { vertical-align: top; }
    .scripts code { display: inline-block; background: #f0f0f0; border-radius: 3px; padding: 1px 4px; font-size: 11px; margin: 1px 1px; font-family: monospace; }
    .script-inline   { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #e8f5e9; color: #2e7d32; }
    .script-external { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #e3f2fd; color: #1565c0; }
    .load-sync  { display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; background: #fce4ec; color: #880e4f; }
    .load-defer { display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; background: #fff8e1; color: #f57f17; }
    .load-async { display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; background: #e8f5e9; color: #1b5e20; }
    .analyzed-yes { color: #1a7a1a; font-size: 11px; }
    .analyzed-no  { color: #bbb; font-size: 11px; }
    .exec-order { font-weight: 700; color: #555; font-size: 12px; }
    .feat-yes { color: #1a7a1a; font-weight: 600; }
    .feat-no  { color: #999; }`;

// Returns the full scripts section HTML block for one result entry.
// Returns an empty string when no scripts are present.
export function buildScriptsHtml(r) {
  if (!(r.scripts ?? []).length) return '';

  const inlineCount      = r.scripts.filter((s) => s.type === 'inline').length;
  const externalCount    = r.scripts.filter((s) => s.type === 'external').length;
  const analyzedExtCount = r.scripts.filter((s) => s.type === 'external' && s.analyzed).length;

  const subtitle = `${r.scripts.length} total — ${inlineCount} inline, ${externalCount} external` +
    (analyzedExtCount ? `, ${analyzedExtCount} external analyzed` : '');

  // ── External scripts table ──
  const external = r.scripts.filter((s) => s.type === 'external');
  const externalTable = external.length ? `
    <h4>External scripts — sorted by execution order</h4>
    <table class="scripts">
      <thead>
        <tr><th>Exec #</th><th>Mode</th><th>Analyzed</th><th>URL</th><th>Load start</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${external.map((s) => {
          const analyzedCell = s.analyzed
            ? '<span class="analyzed-yes">&#10003; yes</span>'
            : '<span class="analyzed-no">—</span>';
          const startCell = s.timing ? `+${s.timing.startTime}ms` : '<span class="na">—</span>';
          const durCell   = s.timing ? `${s.timing.duration}ms`   : '<span class="na">—</span>';
          return `<tr>
            <td class="exec-order">#${s.execOrder}</td>
            <td><span class="load-${s.loadMode}">${s.loadMode}</span></td>
            <td>${analyzedCell}</td>
            <td class="req-url" title="${esc(s.src ?? '')}">${esc(s.src ?? '')}</td>
            <td class="num">${startCell}</td>
            <td class="num">${durCell}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<p class="muted" style="font-size:12px;margin:6px 0">No external scripts.</p>';

  // ── Features table: inline + analyzed external ──
  const analyzedScripts = r.scripts.filter((s) => s.analyzed);
  const featuresTable = analyzedScripts.length ? `
    <h4>Features — inline &amp; analyzed external scripts</h4>
    <table class="scripts">
      <thead>
        <tr><th>Exec #</th><th>Type</th><th>Size</th><th>DOM mod</th><th>Timers</th><th>Listeners</th><th>Window additions</th></tr>
      </thead>
      <tbody>
        ${analyzedScripts.map((s) => {
          const typeLabel = s.type === 'inline'
            ? '<span class="script-inline">inline</span>'
            : '<span class="script-external">external</span>';
          const domCell = `<span class="${s.features.domModification ? 'feat-yes' : 'feat-no'}">${s.features.domModification ? 'yes' : 'no'}</span>`;
          const timersCell = s.features.timers.length
            ? s.features.timers.map((t) => `<code>${esc(t)}</code>`).join(' ')
            : '<span class="na">—</span>';
          const listenersCell = s.features.eventListeners.length
            ? s.features.eventListeners.map((e) => `<code>${esc(e)}</code>`).join(' ')
            : '<span class="na">—</span>';
          const windowCell = s.features.windowAdditions.length
            ? s.features.windowAdditions.map((v) => `<code>${esc(v)}</code>`).join(' ')
            : '<span class="na">—</span>';
          return `<tr>
            <td class="exec-order">#${s.execOrder}</td>
            <td>${typeLabel}</td>
            <td class="muted">${fmtSize(s.sizeBytes)}</td>
            <td>${domCell}</td>
            <td>${timersCell}</td>
            <td>${listenersCell}</td>
            <td>${windowCell}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<p class="muted" style="font-size:12px;margin:6px 0">No scripts analyzed for features (configure <code>scripts.analyzeDomains</code> to analyze external scripts).</p>';

  return `<h3>Scripts <span class="muted">(${subtitle})</span></h3>
          <div class="scripts-section">
            ${externalTable}
            ${featuresTable}
          </div>`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
