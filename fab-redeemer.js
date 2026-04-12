// ==UserScript==
// @name         FAB Free Auto Redeemer
// @namespace    https://wendystudios.com
// @version      1.0.0
// @description  Detect free assets on fab.com, hide already-owned ones, and auto-redeem unclaimed free assets with the best license.
// @author       WendyStudios
// @match        https://www.fab.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
     1. CONSTANTS & CONFIG DEFAULTS
     ================================================================ */

  const STORAGE_KEY = 'fab-free-redeemer-config';
  const PANEL_ID = 'fab-free-redeemer-panel';
  const MAX_LOG_LINES = 120;

  const LICENSE_OPTIONS = [
    { value: 'auto', label: 'Auto (Best Free)' },
    { value: 'professional', label: 'Professional' },
    { value: 'personal', label: 'Personal' },
    { value: 'personal-reference', label: 'Personal - Reference Only' },
    { value: 'cc-by', label: 'CC-BY' },
    { value: 'legacy-ue', label: 'Legacy UE Marketplace' },
  ];

  const DEFAULT_CONFIG = {
    preferredLicense: 'auto',
    delayBetweenClaims: 200,
    hideOwnedAssets: true,
    autoScroll: false,
    prehideCandidates: false,
    scrollDelay: 3000,
    maxIdleScrollRounds: 5,
    panelCollapsed: false,
  };

  /* ================================================================
     2. STATE
     ================================================================ */

  const state = {
    running: false,
    config: { ...DEFAULT_CONFIG },
    ownershipCache: new Map(),
    scannedCards: [],
    stats: { visible: 0, hidden: 0, added: 0, skipped: 0, failed: 0, processed: 0 },
    dom: {},
    observer: null,
  };

  /* ================================================================
     3. UTILITY HELPERS
     ================================================================ */

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getCsrfToken() {
    const m = document.cookie.match(/fab_csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  function fabFetch(url, opts = {}) {
    const csrf = getCsrfToken();
    const headers = {
      'X-CsrfToken': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      ...(opts.headers || {}),
    };
    return fetch(url, { credentials: 'include', ...opts, headers });
  }

  function extractListingId(href) {
    const m = href.match(/\/listings\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  function timestamp() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  /* ================================================================
     4. CONFIG PERSISTENCE
     ================================================================ */

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        Object.assign(state.config, saved);
      }
    } catch { /* use defaults */ }
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
    } catch { /* silent */ }
  }

  /* ================================================================
     5. CSS INJECTION
     ================================================================ */

  function injectStyles() {
    const css = `
      #${PANEL_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        width: 320px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px;
        color: #e0e0e0;
        background: rgba(22, 22, 30, 0.96);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.45);
        backdrop-filter: blur(12px);
        overflow: hidden;
        user-select: none;
        transition: box-shadow 0.2s;
      }
      #${PANEL_ID}:hover { box-shadow: 0 8px 40px rgba(0,0,0,0.55); }

      /* HEADER */
      .far-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: rgba(255,255,255,0.04);
        cursor: grab;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .far-header:active { cursor: grabbing; }
      .far-title {
        font-weight: 700;
        font-size: 13px;
        letter-spacing: 0.3px;
        color: #fff;
      }
      .far-collapse-btn {
        background: none;
        border: none;
        color: #999;
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.15s;
      }
      .far-collapse-btn:hover { color: #fff; }

      /* BODY */
      .far-body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 80vh;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .far-body::-webkit-scrollbar { width: 4px; }
      .far-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
      .far-body.far-hidden { display: none; }

      /* SECTION LABELS */
      .far-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: #888;
        margin-bottom: 4px;
      }

      /* CUSTOM DROPDOWN */
      .far-dropdown-wrap {
        position: relative;
      }
      .far-dropdown-btn {
        width: 100%;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        padding: 6px 10px;
        color: #e0e0e0;
        font-size: 12px;
        cursor: pointer;
        text-align: left;
        display: flex;
        justify-content: space-between;
        align-items: center;
        transition: border-color 0.15s;
      }
      .far-dropdown-btn:hover { border-color: rgba(255,255,255,0.2); }
      .far-dropdown-btn .far-dd-arrow { font-size: 10px; opacity: 0.5; }
      .far-dropdown-list {
        display: none;
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        background: rgba(30,30,40,0.98);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        overflow: hidden;
        z-index: 10;
        box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      }
      .far-dropdown-list.far-open { display: block; }
      .far-dropdown-item {
        padding: 7px 10px;
        cursor: pointer;
        transition: background 0.1s;
      }
      .far-dropdown-item:hover { background: rgba(255,255,255,0.08); }
      .far-dropdown-item.far-selected { color: #6ee76e; }

      /* INPUTS */
      .far-input {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        padding: 6px 10px;
        color: #e0e0e0;
        font-size: 12px;
        width: 70px;
        transition: border-color 0.15s;
      }
      .far-input:focus { outline: none; border-color: rgba(255,255,255,0.25); }

      /* CHECKBOXES */
      .far-check-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 0;
      }
      .far-check-row input[type=checkbox] {
        accent-color: #6ee76e;
        width: 14px;
        height: 14px;
        cursor: pointer;
      }
      .far-check-row label {
        cursor: pointer;
        color: #ccc;
        font-size: 12px;
      }

      /* ROW HELPERS */
      .far-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .far-row label {
        color: #ccc;
        font-size: 12px;
        white-space: nowrap;
      }

      /* BUTTONS */
      .far-btn {
        border: none;
        border-radius: 6px;
        padding: 7px 0;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        transition: filter 0.15s, transform 0.1s;
        width: 100%;
      }
      .far-btn:hover { filter: brightness(1.1); }
      .far-btn:active { transform: scale(0.98); }
      .far-btn-start {
        background: linear-gradient(135deg, #2ecc71, #27ae60);
        color: #fff;
      }
      .far-btn-stop {
        background: linear-gradient(135deg, #e74c3c, #c0392b);
        color: #fff;
      }
      .far-btn-secondary {
        background: rgba(255,255,255,0.08);
        color: #ccc;
        border: 1px solid rgba(255,255,255,0.1);
      }

      .far-btn-row {
        display: flex;
        gap: 8px;
      }
      .far-btn-row .far-btn { flex: 1; }

      /* PROGRESS */
      .far-progress-wrap {
        background: rgba(255,255,255,0.06);
        border-radius: 4px;
        height: 6px;
        overflow: hidden;
      }
      .far-progress-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #2ecc71, #27ae60);
        border-radius: 4px;
        transition: width 0.3s ease;
      }

      /* STATUS */
      .far-status {
        font-size: 11px;
        color: #aaa;
        min-height: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* STATS */
      .far-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px 12px;
      }
      .far-stat {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #bbb;
      }
      .far-stat-val { font-weight: 600; color: #fff; }

      /* LOG */
      .far-log {
        background: rgba(0,0,0,0.25);
        border-radius: 6px;
        padding: 6px 8px;
        min-height: 60px;
        max-height: 150px;
        overflow-y: auto;
        font-family: 'Cascadia Mono', 'Fira Code', monospace;
        font-size: 10px;
        line-height: 1.5;
        flex-shrink: 0;
      }
      .far-log::-webkit-scrollbar { width: 3px; }
      .far-log::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      .far-log-line { padding: 1px 0; }
      .far-log-time { color: #666; margin-right: 6px; }
      .far-log-success { color: #2ecc71; }
      .far-log-warn { color: #f39c12; }
      .far-log-error { color: #e74c3c; }
      .far-log-info { color: #aaa; }

      /* SOCIAL */
      .far-social {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 6px;
      }
      .far-social-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 7px 0;
        border-radius: 6px;
        text-decoration: none;
        font-size: 14px;
        font-weight: 600;
        transition: filter 0.15s, transform 0.1s;
        border: 1px solid rgba(255,255,255,0.06);
      }
      .far-social-btn:hover { filter: brightness(1.2); transform: translateY(-1px); }
      .far-social-coffee { background: rgba(255,206,84,0.15); color: #ffce54; }
      .far-social-steam { background: rgba(102,153,204,0.15); color: #6699cc; }
      .far-social-wendy { background: rgba(155,89,182,0.15); color: #9b59b6; }
      .far-social-discord { background: rgba(114,137,218,0.15); color: #7289da; }

      /* DIVIDER */
      .far-divider {
        border: none;
        border-top: 1px solid rgba(255,255,255,0.06);
        margin: 2px 0;
      }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ================================================================
     6. PANEL CREATION
     ================================================================ */

  function createCustomDropdown(options, selected, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'far-dropdown-wrap';

    const btn = document.createElement('button');
    btn.className = 'far-dropdown-btn';
    btn.type = 'button';
    const selOpt = options.find((o) => o.value === selected) || options[0];
    btn.innerHTML = `<span class="far-dd-label">${selOpt.label}</span><span class="far-dd-arrow">\u25BC</span>`;

    const list = document.createElement('div');
    list.className = 'far-dropdown-list';

    options.forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'far-dropdown-item' + (opt.value === selected ? ' far-selected' : '');
      item.textContent = opt.label;
      item.dataset.value = opt.value;
      item.addEventListener('click', () => {
        list.querySelectorAll('.far-dropdown-item').forEach((i) => i.classList.remove('far-selected'));
        item.classList.add('far-selected');
        btn.querySelector('.far-dd-label').textContent = opt.label;
        list.classList.remove('far-open');
        onChange(opt.value);
      });
      list.appendChild(item);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      list.classList.toggle('far-open');
    });

    document.addEventListener('click', () => list.classList.remove('far-open'));

    wrap.appendChild(btn);
    wrap.appendChild(list);
    return wrap;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // Header
    const header = document.createElement('div');
    header.className = 'far-header';
    const title = document.createElement('span');
    title.className = 'far-title';
    title.textContent = 'FAB Free Auto Redeemer';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'far-collapse-btn';
    collapseBtn.textContent = state.config.panelCollapsed ? '\u25BC' : '\u25B2';
    collapseBtn.title = 'Toggle panel';
    header.appendChild(title);
    header.appendChild(collapseBtn);

    // Body
    const body = document.createElement('div');
    body.className = 'far-body' + (state.config.panelCollapsed ? ' far-hidden' : '');

    // --- Config section ---
    const cfgLabel = document.createElement('div');
    cfgLabel.className = 'far-label';
    cfgLabel.textContent = 'Configuration';

    // Preferred license
    const licRow = document.createElement('div');
    const licLabel = document.createElement('label');
    licLabel.textContent = 'Preferred license';
    licLabel.className = 'far-label';
    licLabel.style.marginBottom = '2px';
    const licDD = createCustomDropdown(LICENSE_OPTIONS, state.config.preferredLicense, (val) => {
      state.config.preferredLicense = val;
      saveConfig();
    });

    // Delay
    const delayRow = document.createElement('div');
    delayRow.className = 'far-row';
    const delayLabel = document.createElement('label');
    delayLabel.textContent = 'Delay between claims (ms)';
    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.className = 'far-input';
    delayInput.value = state.config.delayBetweenClaims;
    delayInput.min = 100;
    delayInput.step = 100;
    delayInput.addEventListener('change', () => {
      state.config.delayBetweenClaims = Math.max(100, parseInt(delayInput.value, 10) || 600);
      delayInput.value = state.config.delayBetweenClaims;
      saveConfig();
    });
    delayRow.appendChild(delayLabel);
    delayRow.appendChild(delayInput);

    // Checkboxes
    function makeCheck(id, label, configKey) {
      const row = document.createElement('div');
      row.className = 'far-check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'far-' + id;
      cb.checked = state.config[configKey];
      cb.addEventListener('change', () => {
        state.config[configKey] = cb.checked;
        saveConfig();
        if (configKey === 'hideOwnedAssets') syncOwnedAndHideVisibleCards();
      });
      const lbl = document.createElement('label');
      lbl.htmlFor = 'far-' + id;
      lbl.textContent = label;
      row.appendChild(cb);
      row.appendChild(lbl);
      return row;
    }

    const chkHide = makeCheck('hide', 'Hide already owned free assets', 'hideOwnedAssets');
    const chkScroll = makeCheck('scroll', 'Auto-scroll for more results', 'autoScroll');
    const chkPrehide = makeCheck('prehide', 'Instant-filter pending free cards', 'prehideCandidates');

    // --- Action section ---
    const actLabel = document.createElement('div');
    actLabel.className = 'far-label';
    actLabel.textContent = 'Actions';

    const btnRow = document.createElement('div');
    btnRow.className = 'far-btn-row';

    const actionBtn = document.createElement('button');
    actionBtn.className = 'far-btn far-btn-start';
    actionBtn.textContent = 'Start';
    actionBtn.addEventListener('click', () => {
      if (state.running) stopRun();
      else startRun();
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'far-btn far-btn-secondary';
    refreshBtn.textContent = 'Refresh Filter';
    refreshBtn.addEventListener('click', () => {
      syncOwnedAndHideVisibleCards();
      addLog('Filter refreshed', 'info');
    });

    btnRow.appendChild(actionBtn);
    btnRow.appendChild(refreshBtn);

    // Progress
    const progressWrap = document.createElement('div');
    progressWrap.className = 'far-progress-wrap';
    const progressBar = document.createElement('div');
    progressBar.className = 'far-progress-bar';
    progressWrap.appendChild(progressBar);

    // Status
    const statusLine = document.createElement('div');
    statusLine.className = 'far-status';
    statusLine.textContent = 'Ready';

    // Stats
    const statsLabel = document.createElement('div');
    statsLabel.className = 'far-label';
    statsLabel.textContent = 'Statistics';

    const statsGrid = document.createElement('div');
    statsGrid.className = 'far-stats';
    function statEl(name) {
      const s = document.createElement('div');
      s.className = 'far-stat';
      s.innerHTML = `<span>${name}</span><span class="far-stat-val" id="far-stat-${name.toLowerCase().replace(/\s+/g, '-')}">0</span>`;
      return s;
    }
    ['Visible candidates', 'Hidden owned', 'Added', 'Skipped owned', 'Failed', 'Processed'].forEach((n) => statsGrid.appendChild(statEl(n)));

    // Log
    const logLabel = document.createElement('div');
    logLabel.className = 'far-label';
    logLabel.textContent = 'Log';
    const logBox = document.createElement('div');
    logBox.className = 'far-log';

    // Social
    const socialDiv = document.createElement('div');
    socialDiv.className = 'far-social';
    const socials = [
      { cls: 'far-social-coffee', icon: '\u2615', url: 'https://buymeacoffee.com/bielarano', title: 'Coffee' },
      { cls: 'far-social-steam', icon: '\uD83C\uDFAE', url: 'https://store.steampowered.com/publisher/WendyStudios', title: 'Steam' },
      { cls: 'far-social-wendy', icon: '\uD83C\uDF10', url: 'https://wendystudios.com', title: 'WendyStudios' },
      { cls: 'far-social-discord', icon: '\uD83D\uDCAC', url: 'https://discord.wendystudios.com', title: 'Discord' },
    ];
    socials.forEach((s) => {
      const a = document.createElement('a');
      a.className = 'far-social-btn ' + s.cls;
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = s.title;
      a.textContent = s.icon;
      socialDiv.appendChild(a);
    });

    // Assemble body
    body.appendChild(cfgLabel);
    body.appendChild(licLabel);
    body.appendChild(licDD);
    body.appendChild(delayRow);
    body.appendChild(chkHide);
    body.appendChild(chkScroll);
    body.appendChild(chkPrehide);
    body.appendChild(document.createElement('hr')).className = 'far-divider';
    body.appendChild(actLabel);
    body.appendChild(btnRow);
    body.appendChild(progressWrap);
    body.appendChild(statusLine);
    body.appendChild(document.createElement('hr')).className = 'far-divider';
    body.appendChild(statsLabel);
    body.appendChild(statsGrid);
    body.appendChild(document.createElement('hr')).className = 'far-divider';
    body.appendChild(logLabel);
    body.appendChild(logBox);
    body.appendChild(document.createElement('hr')).className = 'far-divider';
    body.appendChild(socialDiv);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // Store DOM refs
    state.dom.panel = panel;
    state.dom.header = header;
    state.dom.body = body;
    state.dom.collapseBtn = collapseBtn;
    state.dom.actionBtn = actionBtn;
    state.dom.progressBar = progressBar;
    state.dom.statusLine = statusLine;
    state.dom.logBox = logBox;

    // --- Collapse ---
    collapseBtn.addEventListener('click', () => {
      state.config.panelCollapsed = !state.config.panelCollapsed;
      body.classList.toggle('far-hidden', state.config.panelCollapsed);
      collapseBtn.textContent = state.config.panelCollapsed ? '\u25BC' : '\u25B2';
      saveConfig();
    });

    // --- Drag ---
    let dragging = false;
    let dragX = 0;
    let dragY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target === collapseBtn) return;
      dragging = true;
      dragX = e.clientX - panel.offsetLeft;
      dragY = e.clientY - panel.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dragX) + 'px';
      panel.style.top = (e.clientY - dragY) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  /* ================================================================
     7. PANEL LOGIC
     ================================================================ */

  function updateActionButton() {
    const btn = state.dom.actionBtn;
    if (!btn) return;
    if (state.running) {
      btn.textContent = 'Stop';
      btn.className = 'far-btn far-btn-stop';
    } else {
      btn.textContent = 'Start';
      btn.className = 'far-btn far-btn-start';
    }
  }

  function setStatus(text) {
    if (state.dom.statusLine) state.dom.statusLine.textContent = text;
  }

  function setProgress(pct) {
    if (state.dom.progressBar) state.dom.progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function updateStats() {
    const ids = {
      'visible-candidates': state.stats.visible,
      'hidden-owned': state.stats.hidden,
      'added': state.stats.added,
      'skipped-owned': state.stats.skipped,
      'failed': state.stats.failed,
      'processed': state.stats.processed,
    };
    for (const [k, v] of Object.entries(ids)) {
      const el = document.getElementById('far-stat-' + k);
      if (el) el.textContent = v;
    }
  }

  function addLog(msg, type = 'info') {
    const box = state.dom.logBox;
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'far-log-line';
    line.innerHTML = `<span class="far-log-time">${timestamp()}</span><span class="far-log-${type}">${escapeHtml(msg)}</span>`;
    box.insertBefore(line, box.firstChild);
    while (box.children.length > MAX_LOG_LINES) box.removeChild(box.lastChild);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /* ================================================================
     8. API LAYER
     ================================================================ */

  async function checkOwnershipBulk(ids) {
    if (!ids.length) return;
    // Filter out already-cached ids
    const uncached = ids.filter((id) => !state.ownershipCache.has(id));
    if (uncached.length) {
      const batchSize = 50;
      const promises = [];
      for (let i = 0; i < uncached.length; i += batchSize) {
        const batch = uncached.slice(i, i + batchSize);
        const qs = batch.map((id) => 'listing_ids=' + encodeURIComponent(id)).join('&');
        promises.push(
          fabFetch('https://www.fab.com/i/users/me/listings-states?' + qs)
            .then((resp) => resp.ok ? resp.json() : null)
            .then((data) => {
              if (!data) return;
              const results = Array.isArray(data) ? data : (data.results || []);
              results.forEach((r) => state.ownershipCache.set(r.uid, !!r.acquired));
              batch.forEach((id) => { if (!state.ownershipCache.has(id)) state.ownershipCache.set(id, false); });
            })
            .catch((e) => addLog('Ownership check failed: ' + e.message, 'error'))
        );
      }
      await Promise.all(promises);
    }
  }

  async function getListingDetail(id) {
    try {
      const resp = await fabFetch('https://www.fab.com/i/listings/' + id);
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async function addToLibrary(listingId, offerId) {
    const body = new URLSearchParams();
    body.append('offer_id', offerId);
    try {
      const resp = await fabFetch('https://www.fab.com/i/listings/' + listingId + '/add-to-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (resp.ok || resp.status === 204) return { success: true };
      if (resp.status === 409) return { success: true, alreadyOwned: true };
      const text = await resp.text().catch(() => '');
      return { success: false, error: `HTTP ${resp.status}: ${text}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /* ================================================================
     9. CARD DETECTION & HIDING
     ================================================================ */

  function scanVisibleCards() {
    const cards = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/listings/"]');

    links.forEach((link) => {
      const id = extractListingId(link.getAttribute('href'));
      if (!id || seen.has(id)) return;
      seen.add(id);

      // Walk up to find the card container (typically a grid item)
      let container = link;
      for (let i = 0; i < 8; i++) {
        if (!container.parentElement) break;
        const parent = container.parentElement;
        // Stop if we reach a container with many children (likely the grid itself)
        if (parent.children.length > 3) break;
        container = parent;
      }

      // Try to extract a name
      let name = '';
      const titleEl = container.querySelector('h2, h3, [class*="title"], [class*="name"]');
      if (titleEl) name = titleEl.textContent.trim();
      if (!name) name = link.textContent.trim().substring(0, 60) || id.substring(0, 12);

      cards.push({ id, name, el: container, link });
    });

    state.scannedCards = cards;
    return cards;
  }

  function isCardLikelyFree(card) {
    // Check URL for free filter
    if (window.location.search.includes('is_free=true') || window.location.search.includes('price=free')) {
      return true;
    }
    // Check card text for "Free" badge
    const text = card.el.textContent || '';
    if (/\bfree\b/i.test(text)) return true;
    // Check for price == 0 or "$ 0" patterns
    if (/\$\s*0(\.00)?/.test(text)) return true;
    return false;
  }

  function hideCard(card) {
    if (card.el && card.el.style.display !== 'none') {
      card.el.style.display = 'none';
      card.el.dataset.farHidden = 'true';
    }
  }

  function showCard(card) {
    if (card.el && card.el.dataset.farHidden === 'true') {
      card.el.style.display = '';
      delete card.el.dataset.farHidden;
    }
  }

  function applyHidePass(freeCards) {
    let hiddenCount = 0;
    let visibleCount = 0;
    freeCards.forEach((c) => {
      const owned = state.ownershipCache.get(c.id);
      if (owned && state.config.hideOwnedAssets) {
        hideCard(c);
        hiddenCount++;
      } else {
        showCard(c);
        if (!owned) visibleCount++;
      }
    });
    state.stats.visible = visibleCount;
    state.stats.hidden = hiddenCount;
    updateStats();
  }

  async function syncOwnedAndHideVisibleCards() {
    setStatus('Syncing ownership states...');
    const cards = scanVisibleCards();
    const freeCards = cards.filter(isCardLikelyFree);

    // Pre-hide candidates if configured
    if (state.config.prehideCandidates) {
      freeCards.forEach((c) => { if (!state.ownershipCache.has(c.id)) hideCard(c); });
    }

    // Immediately hide any already-cached owned cards before network calls
    applyHidePass(freeCards);

    const ids = freeCards.map((c) => c.id);
    await checkOwnershipBulk(ids);

    // Final pass after all ownership data is in
    applyHidePass(freeCards);
    setStatus('Ready');
  }

  /* ================================================================
     10. LICENSE SCORING
     ================================================================ */

  const LICENSE_PRIORITY = {
    'professional': 100,
    'personal': 80,
    'cc-by': 60,
    'legacy-ue': 50,
    'personal-reference': 20,
  };

  function slugify(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function scoreLicense(license, preferred) {
    const slug = slugify(license.slug || license.name || '');
    const name = (license.name || '').toLowerCase();
    let score = 0;

    // Base priority
    for (const [key, pts] of Object.entries(LICENSE_PRIORITY)) {
      if (slug.includes(key) || name.includes(key.replace(/-/g, ' '))) {
        score += pts;
        break;
      }
    }

    // Boost if matches preferred
    if (preferred !== 'auto') {
      const prefSlug = preferred;
      if (slug.includes(prefSlug) || name.includes(prefSlug.replace(/-/g, ' '))) {
        score += 200;
      }
    }

    // Penalize reference-only unless preferred
    if ((slug.includes('reference') || name.includes('reference')) && preferred !== 'personal-reference') {
      score -= 50;
    }

    return score;
  }

  function pickBestFreeOffer(detail, preferred) {
    // Detail may have licenses or offers arrays
    let offers = detail.licenses || detail.offers || [];
    if (!Array.isArray(offers)) offers = [];

    // Filter to free offers
    const freeOffers = offers.filter((o) => {
      const price = o.priceTier?.price ?? o.price ?? null;
      return price === 0 || price === '0' || price === '0.00';
    });

    if (!freeOffers.length) return null;

    // Score each
    let best = null;
    let bestScore = -Infinity;
    for (const o of freeOffers) {
      const s = scoreLicense(o, preferred);
      if (s > bestScore) {
        bestScore = s;
        best = o;
      }
    }
    return best;
  }

  /* ================================================================
     11. CORE LOOP
     ================================================================ */

  async function processLoop() {
    const cards = scanVisibleCards();
    const freeCards = cards.filter(isCardLikelyFree);
    const candidates = freeCards.filter((c) => !state.ownershipCache.get(c.id));
    const total = candidates.length;
    let idx = 0;

    for (const card of candidates) {
      if (!state.running) break;

      idx++;
      state.stats.processed++;
      setStatus('Processing: ' + card.name);
      setProgress((idx / total) * 100);

      // Re-check ownership (may have been updated)
      if (state.ownershipCache.get(card.id)) {
        state.stats.skipped++;
        addLog('Skipped already owned: ' + card.name, 'warn');
        updateStats();
        continue;
      }

      // Get listing detail
      const detail = await getListingDetail(card.id);
      if (!detail) {
        state.stats.failed++;
        addLog('Failed loading listing detail: ' + card.name, 'error');
        updateStats();
        await sleep(state.config.delayBetweenClaims);
        continue;
      }

      // Pick best free offer
      const offer = pickBestFreeOffer(detail, state.config.preferredLicense);
      if (!offer) {
        state.stats.failed++;
        addLog('No free offer found: ' + card.name, 'error');
        updateStats();
        await sleep(state.config.delayBetweenClaims);
        continue;
      }

      const offerId = offer.offerId || offer.offer_id || offer.uid || offer.id;
      if (!offerId) {
        state.stats.failed++;
        addLog('No offerId in offer: ' + card.name, 'error');
        updateStats();
        await sleep(state.config.delayBetweenClaims);
        continue;
      }

      // Claim
      const result = await addToLibrary(card.id, offerId);
      if (result.success) {
        if (result.alreadyOwned) {
          state.stats.skipped++;
          addLog('Already owned (conflict): ' + card.name, 'warn');
        } else {
          state.stats.added++;
          addLog('Added: ' + card.name, 'success');
        }
        state.ownershipCache.set(card.id, true);
        if (state.config.hideOwnedAssets) hideCard(card);
      } else {
        state.stats.failed++;
        addLog('Failed: ' + card.name + ' - ' + result.error, 'error');
      }

      updateStats();
      await sleep(state.config.delayBetweenClaims);
    }

    // Auto-scroll
    if (state.running && state.config.autoScroll) {
      await autoScrollLoop();
    }
  }

  /* ================================================================
     12. AUTO-SCROLL
     ================================================================ */

  async function autoScrollLoop() {
    let idleRounds = 0;
    while (state.running && idleRounds < state.config.maxIdleScrollRounds) {
      const prevCount = state.scannedCards.length;
      setStatus('Scrolling for more results...');

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(state.config.scrollDelay);

      // Small adjustment scroll to trigger lazy loading
      window.scrollBy(0, -200);
      await sleep(500);
      window.scrollBy(0, 250);
      await sleep(state.config.scrollDelay);

      const newCards = scanVisibleCards();
      if (newCards.length > prevCount) {
        idleRounds = 0;
        addLog('Found ' + (newCards.length - prevCount) + ' new cards after scroll', 'info');
        // Sync ownership for new cards
        await syncOwnedAndHideVisibleCards();
        // Process new candidates
        await processLoop();
      } else {
        idleRounds++;
        addLog('No new cards found (idle round ' + idleRounds + '/' + state.config.maxIdleScrollRounds + ')', 'warn');
      }
    }

    if (idleRounds >= state.config.maxIdleScrollRounds) {
      addLog('Auto-scroll finished: no more results', 'info');
    }
  }

  /* ================================================================
     13. START / STOP
     ================================================================ */

  async function startRun() {
    if (state.running) return;
    state.running = true;
    state.stats.added = 0;
    state.stats.skipped = 0;
    state.stats.failed = 0;
    state.stats.processed = 0;
    setProgress(0);
    updateActionButton();
    updateStats();
    addLog('Run started', 'info');
    setStatus('Starting...');

    try {
      await syncOwnedAndHideVisibleCards();
      await processLoop();
    } catch (e) {
      addLog('Unexpected error: ' + e.message, 'error');
    }

    state.running = false;
    updateActionButton();
    setProgress(100);
    setStatus(state.stats.added > 0 ? 'Finished \u2014 ' + state.stats.added + ' added' : 'Finished');
    addLog('Run completed', 'info');
  }

  function stopRun() {
    state.running = false;
    updateActionButton();
    setStatus('Stopped');
    addLog('Run stopped by user', 'warn');
  }

  /* ================================================================
     14. MUTATION OBSERVER
     ================================================================ */

  function setupObserver() {
    if (state.observer) state.observer.disconnect();

    let debounceTimer = null;
    state.observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!state.running && state.config.hideOwnedAssets) {
          syncOwnedAndHideVisibleCards();
        }
        updateStats();
      }, 500);
    });

    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ================================================================
     15. BOOT
     ================================================================ */

  function boot() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot);
      return;
    }

    loadConfig();
    injectStyles();
    createPanel();
    addLog('Panel loaded', 'info');
    syncOwnedAndHideVisibleCards();
    setupObserver();
  }

  boot();
})();
