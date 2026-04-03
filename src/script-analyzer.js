// ─── Page analysis ───────────────────────────────────────────────────────────
// Runs inside the browser via page.evaluate() after navigation.
// Enumerates every <script> element and applies static regex analysis to
// inline scripts, detecting:
//   - DOM modifications (createElement, innerHTML, appendChild, etc.)
//   - Variables and functions added to the window scope
//   - Event listener registrations (addEventListener / on* handlers)
//   - Timer calls (setTimeout / setInterval)
// External scripts are listed by URL only — their source is unavailable here.

export async function analyzePageScripts(page) {
  return await page.evaluate(() => {
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

    return Array.from(document.querySelectorAll('script')).map((el, index) => {
      const isExternal = !!el.src;
      const content = el.textContent || '';
      const entry = {
        index,
        type: isExternal ? 'external' : 'inline',
        src: isExternal ? el.src : null,
        scriptType: el.type || 'text/javascript',
        sizeBytes: isExternal ? null : content.length,
        features: {
          domModification: false,
          windowAdditions: [],
          eventListeners: [],
          timers: [],
        },
      };

      if (!isExternal && content.trim()) {
        entry.features.domModification = detectDomModification(content);
        entry.features.windowAdditions = detectWindowAdditions(content);
        entry.features.eventListeners = detectListeners(content);
        entry.features.timers = detectTimers(content);
      }

      return entry;
    });
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
  console.log(`\nScripts (${result.scripts.length} total — ${inlineCount} inline, ${externalCount} external):`);
  console.log(
    `  ${'#'.padEnd(4)} ${'TYPE'.padEnd(9)} ${'SIZE'.padEnd(8)} ${'DOM'.padEnd(5)} ${'TIMERS'.padEnd(26)} ${'LISTENERS'.padEnd(30)} WINDOW ADDITIONS`
  );
  for (const s of result.scripts) {
    const idx       = String(s.index).padEnd(4);
    const type      = s.type.padEnd(9);
    const size      = (s.sizeBytes != null ? fmtSize(s.sizeBytes) : '-').padEnd(8);
    const dom       = (s.type === 'inline' ? (s.features.domModification ? 'yes' : 'no') : '-').padEnd(5);
    const timers    = (s.type === 'inline' ? (s.features.timers.join(', ') || '-') : '-').padEnd(26);
    const listeners = (s.type === 'inline' ? (s.features.eventListeners.join(', ') || '-') : (s.src ?? '-')).padEnd(30);
    const window_   = s.type === 'inline' ? (s.features.windowAdditions.join(', ') || '-') : '-';
    console.log(`  ${idx} ${type} ${size} ${dom} ${timers} ${listeners} ${window_}`);
  }
}

// ─── HTML output ─────────────────────────────────────────────────────────────

// CSS rules required by the scripts table. Embed in the report <style> block.
export const SCRIPTS_CSS = `
    .scripts td { vertical-align: top; }
    .scripts code { display: inline-block; background: #f0f0f0; border-radius: 3px; padding: 1px 4px; font-size: 11px; margin: 1px 1px; font-family: monospace; }
    .script-inline   { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #e8f5e9; color: #2e7d32; }
    .script-external { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #e3f2fd; color: #1565c0; }
    .feat-yes { color: #1a7a1a; font-weight: 600; }
    .feat-no  { color: #999; }`;

// Returns the full <h3> + <table> HTML block for one result entry.
// Returns an empty string when no scripts are present.
export function buildScriptsHtml(r) {
  if (!(r.scripts ?? []).length) return '';

  const rows = r.scripts.map((s) => {
    const isInline = s.type === 'inline';

    const domCell = isInline
      ? `<span class="${s.features.domModification ? 'feat-yes' : 'feat-no'}">${s.features.domModification ? 'yes' : 'no'}</span>`
      : '<span class="na">—</span>';

    const timersCell = isInline
      ? (s.features.timers.length
          ? s.features.timers.map((t) => `<code>${esc(t)}</code>`).join(' ')
          : '<span class="na">—</span>')
      : '<span class="na">—</span>';

    const listenersCell = isInline
      ? (s.features.eventListeners.length
          ? s.features.eventListeners.map((e) => `<code>${esc(e)}</code>`).join(' ')
          : '<span class="na">—</span>')
      : '<span class="na">—</span>';

    const windowCell = isInline
      ? (s.features.windowAdditions.length
          ? s.features.windowAdditions.map((v) => `<code>${esc(v)}</code>`).join(' ')
          : '<span class="na">—</span>')
      : '<span class="na">—</span>';

    const label = isInline
      ? `<span class="script-inline">inline</span> <span class="muted">${fmtSize(s.sizeBytes)}</span>`
      : `<span class="script-external">external</span> <span class="req-url" title="${esc(s.src ?? '')}">${esc(s.src ?? '')}</span>`;

    return `<tr>
        <td class="num">${s.index}</td>
        <td>${label}</td>
        <td>${domCell}</td>
        <td>${timersCell}</td>
        <td>${listenersCell}</td>
        <td>${windowCell}</td>
      </tr>`;
  }).join('');

  const inlineCount   = r.scripts.filter((s) => s.type === 'inline').length;
  const externalCount = r.scripts.filter((s) => s.type === 'external').length;

  return `<h3>Scripts <span class="muted">(${r.scripts.length} total — ${inlineCount} inline, ${externalCount} external)</span></h3>
            <table class="scripts">
              <thead>
                <tr><th>#</th><th>Source</th><th>DOM mod</th><th>Timers</th><th>Listeners</th><th>Window additions</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>`;
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
