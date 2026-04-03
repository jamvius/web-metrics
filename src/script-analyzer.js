// ─── Page analysis ───────────────────────────────────────────────────────────
// Runs inside the browser via page.evaluate() after navigation.
// Enumerates every <script> element, cross-references PerformanceResourceTiming
// for external scripts, then returns the list sorted by real execution order:
//   1. Sync scripts (no async/defer/module) — in DOM order (parser-blocking)
//   2. Deferred / module scripts            — in DOM order (after HTML parse)
//   3. Async scripts                        — by responseEnd (first-loaded, first-run)
//
// Inline scripts are also statically analysed for:
//   - DOM modifications (createElement, innerHTML, appendChild, etc.)
//   - Variables and functions added to the window scope
//   - Event listener registrations (addEventListener / on* handlers)
//   - Timer calls (setTimeout / setInterval)

export async function analyzePageScripts(page) {
  return await page.evaluate(() => {
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
      // async and defer are only meaningful on external scripts; module scripts
      // are deferred by default even without the defer attribute.
      const isAsync    = el.async && isExternal;
      const isDefer    = (el.defer || isModule) && isExternal;
      const content    = el.textContent || '';

      const entry = {
        domIndex,                             // original DOM position
        type:       isExternal ? 'external' : 'inline',
        src:        isExternal ? el.src : null,
        scriptType: el.type || 'text/javascript',
        loadMode:   isAsync ? 'async' : isDefer ? 'defer' : 'sync',
        sizeBytes:  isExternal ? null : content.length,
        timing:     isExternal ? (resourceTimings.get(el.src) ?? null) : null,
        features: {
          domModification:  false,
          windowAdditions:  [],
          eventListeners:   [],
          timers:           [],
        },
      };

      if (!isExternal && content.trim()) {
        entry.features.domModification = detectDomModification(content);
        entry.features.windowAdditions = detectWindowAdditions(content);
        entry.features.eventListeners  = detectListeners(content);
        entry.features.timers          = detectTimers(content);
      }

      return entry;
    });

    // ── Sort by execution order ───────────────────────────────────────────
    // Inline scripts are always sync (parser-blocking at their DOM position).
    // External scripts have loadMode derived from async/defer/module attributes.
    const sync  = scripts.filter((s) => s.loadMode === 'sync');   // DOM order
    const defer = scripts.filter((s) => s.loadMode === 'defer');  // DOM order
    const async_ = scripts
      .filter((s) => s.loadMode === 'async')
      .sort((a, b) => (a.timing?.responseEnd ?? 0) - (b.timing?.responseEnd ?? 0));

    const sorted = [...sync, ...defer, ...async_];
    return sorted.map((s, execOrder) => ({ ...s, execOrder: execOrder + 1 }));
  });
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

  const inlineCount   = result.scripts.filter((s) => s.type === 'inline').length;
  const externalCount = result.scripts.filter((s) => s.type === 'external').length;
  console.log(`\nScripts (${result.scripts.length} total — ${inlineCount} inline, ${externalCount} external, sorted by execution order):`);

  // ── External scripts sub-table ──
  const external = result.scripts.filter((s) => s.type === 'external');
  if (external.length) {
    console.log(`\n  External scripts:`);
    console.log(
      `  ${'EXEC'.padEnd(5)} ${'MODE'.padEnd(6)} ${'START'.padEnd(9)} ${'DUR'.padEnd(9)} URL`
    );
    for (const s of external) {
      const exec  = `#${s.execOrder}`.padEnd(5);
      const mode  = s.loadMode.padEnd(6);
      const start = (s.timing ? `+${s.timing.startTime}ms` : '-').padEnd(9);
      const dur   = (s.timing ? `${s.timing.duration}ms` : '-').padEnd(9);
      console.log(`  ${exec} ${mode} ${start} ${dur} ${s.src}`);
    }
  }

  // ── All scripts feature table ──
  console.log(`\n  Script features (inline only):`);
  const inline = result.scripts.filter((s) => s.type === 'inline');
  if (!inline.length) {
    console.log(`    (no inline scripts)`);
  } else {
    console.log(
      `  ${'EXEC'.padEnd(5)} ${'SIZE'.padEnd(8)} ${'DOM'.padEnd(5)} ${'TIMERS'.padEnd(26)} ${'LISTENERS'.padEnd(30)} WINDOW ADDITIONS`
    );
    for (const s of inline) {
      const exec      = `#${s.execOrder}`.padEnd(5);
      const size      = fmtSize(s.sizeBytes).padEnd(8);
      const dom       = (s.features.domModification ? 'yes' : 'no').padEnd(5);
      const timers    = (s.features.timers.join(', ') || '-').padEnd(26);
      const listeners = (s.features.eventListeners.join(', ') || '-').padEnd(30);
      const window_   = s.features.windowAdditions.join(', ') || '-';
      console.log(`  ${exec} ${size} ${dom} ${timers} ${listeners} ${window_}`);
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
    .exec-order { font-weight: 700; color: #555; font-size: 12px; }
    .feat-yes { color: #1a7a1a; font-weight: 600; }
    .feat-no  { color: #999; }`;

// Returns the full scripts section HTML block for one result entry.
// Returns an empty string when no scripts are present.
export function buildScriptsHtml(r) {
  if (!(r.scripts ?? []).length) return '';

  const inlineCount   = r.scripts.filter((s) => s.type === 'inline').length;
  const externalCount = r.scripts.filter((s) => s.type === 'external').length;

  // ── External scripts table ──
  const external = r.scripts.filter((s) => s.type === 'external');
  const externalTable = external.length ? `
    <h4>External scripts — sorted by execution order</h4>
    <table class="scripts">
      <thead>
        <tr><th>Exec #</th><th>Mode</th><th>URL</th><th>Load start</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${external.map((s) => {
          const modeClass = `load-${s.loadMode}`;
          const startCell = s.timing ? `+${s.timing.startTime}ms` : '<span class="na">—</span>';
          const durCell   = s.timing ? `${s.timing.duration}ms`   : '<span class="na">—</span>';
          return `<tr>
            <td class="exec-order">#${s.execOrder}</td>
            <td><span class="${modeClass}">${s.loadMode}</span></td>
            <td class="req-url" title="${esc(s.src ?? '')}">${esc(s.src ?? '')}</td>
            <td class="num">${startCell}</td>
            <td class="num">${durCell}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<p class="muted" style="font-size:12px;margin:6px 0">No external scripts.</p>';

  // ── Inline scripts table ──
  const inline = r.scripts.filter((s) => s.type === 'inline');
  const inlineTable = inline.length ? `
    <h4>Inline scripts — features</h4>
    <table class="scripts">
      <thead>
        <tr><th>Exec #</th><th>Size</th><th>DOM mod</th><th>Timers</th><th>Listeners</th><th>Window additions</th></tr>
      </thead>
      <tbody>
        ${inline.map((s) => {
          const domCell = `<span class="${s.features.domModification ? 'feat-yes' : 'feat-no'}">${s.features.domModification ? 'yes' : 'no'}</span>`;
          const timersCell    = s.features.timers.length
            ? s.features.timers.map((t) => `<code>${esc(t)}</code>`).join(' ')
            : '<span class="na">—</span>';
          const listenersCell = s.features.eventListeners.length
            ? s.features.eventListeners.map((e) => `<code>${esc(e)}</code>`).join(' ')
            : '<span class="na">—</span>';
          const windowCell    = s.features.windowAdditions.length
            ? s.features.windowAdditions.map((v) => `<code>${esc(v)}</code>`).join(' ')
            : '<span class="na">—</span>';
          return `<tr>
            <td class="exec-order">#${s.execOrder}</td>
            <td class="muted">${fmtSize(s.sizeBytes)}</td>
            <td>${domCell}</td>
            <td>${timersCell}</td>
            <td>${listenersCell}</td>
            <td>${windowCell}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<p class="muted" style="font-size:12px;margin:6px 0">No inline scripts.</p>';

  return `<h3>Scripts <span class="muted">(${r.scripts.length} total — ${inlineCount} inline, ${externalCount} external)</span></h3>
          <div class="scripts-section">
            ${externalTable}
            ${inlineTable}
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
