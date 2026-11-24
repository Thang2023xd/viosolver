/**
 * VioEdu Auto Solver AI - High Precision Bulletproof Engine
 * 1. Immediate UI feedback on all button clicks (never silent)
 * 2. Reverse-DOM question card finder (from Submit button, Câu hỏi header, or input)
 * 3. Two-way live config sync with popup (instant token hydration)
 * 4. Dual-mode solver: Trắc nghiệm (A,B,C,D) & Điền số vào ô trống
 */

(function () {
  'use strict';

  const isTopWindow = window === window.top;
  if (!isTopWindow) return;

  let config = {
    provider: 'vireonix',
    vireonixModel: 'auto',
    antiBurstPacing: true,
    enableCache: true,
    autoFailover: true,
    groqApiKey: '',
    openRouterApiKey: '',
    openRouterModel: 'openrouter/free',
    autoSolve: false,
    autoSubmit: false,
    answerDelayMs: 1200
  };

  let isSolving = false;
  let lastSolvedQuestionId = null;
  let interceptedNetworkQuestion = null;
  let observer = null;
  let debounceTimer = null;
  let autoRetryTimer = null;
  let pendingAutoSolve = false;
  const autoRetryCounts = new Map();
  const autoFailureCooldowns = new Map();
  let lastSolveTime = 0;
  let isAuthenticated = false;
  let engineStarted = false;

  init();

  async function init() {
    console.log('[VioEdu-QA] Initializing...');
    await loadConfig();
    listenToRuntimeMessages();
    const ok = await refreshAuthState();
    if (ok) {
      enterAuthenticatedMode();
    } else {
      enterGateMode();
    }
  }

  function refreshAuthState() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_STAFF_AUTH' }, res => {
        isAuthenticated = !!(res && res.success && res.authenticated);
        resolve(isAuthenticated);
      });
    });
  }

  function removeHud() {
    const existing = document.getElementById('vioedu-ai-hud');
    if (existing) existing.remove();
  }

  function stopEngine() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
    isSolving = false;
  }

  function enterGateMode() {
    stopEngine();
    removeHud();
    createGateHUD();
  }

  function enterAuthenticatedMode() {
    removeHud();
    createOverlayHUD();
    if (!engineStarted) {
      listenToNetworkInterceptor();
      engineStarted = true;
    }
    updateObserverState();
    setTimeout(() => { if (config.autoSolve) checkAndSolve(); }, 1500);
    setTimeout(() => { if (config.autoSolve) checkAndSolve(); }, 3500);
  }

  async function loadConfig() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_CONFIG' }, res => {
        if (res && res.config) {
          config = { ...config, ...res.config };
        } else {
          chrome.storage.local.get(null, stored => {
            if (stored) config = { ...config, ...stored };
          });
        }
        resolve();
      });
    });
  }

  function listenToRuntimeMessages() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'STAFF_AUTH_CHANGED') {
        if (request.authenticated) {
          isAuthenticated = true;
          enterAuthenticatedMode();
        } else {
          isAuthenticated = false;
          enterGateMode();
        }
        sendResponse({ success: true });
        return;
      }
      if (request.action === 'CONFIG_UPDATED' && request.config) {
        if (!isAuthenticated) {
          sendResponse({ success: false, error: 'locked' });
          return;
        }
        config = { ...config, ...request.config };
        updateHUDFromConfig();
        updateObserverState();
        addLog('Đã áp dụng cài đặt mới từ Popup', 'success');
        sendResponse({ success: true });
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (Object.prototype.hasOwnProperty.call(changes, 'staffAuthUntil') ||
          Object.prototype.hasOwnProperty.call(changes, 'staffKey')) {
        refreshAuthState().then(ok => {
          if (ok) enterAuthenticatedMode();
          else enterGateMode();
        });
        return;
      }
      if (!isAuthenticated) return;
      for (const [key, change] of Object.entries(changes)) {
        config[key] = change.newValue;
      }
      updateHUDFromConfig();
      updateObserverState();
    });
  }

  function createGateHUD() {
    removeHud();
    const hud = document.createElement('div');
    hud.id = 'vioedu-ai-hud';
    hud.innerHTML = `
      <div class="vio-header">
        <div class="vio-title">
          <span class="vio-badge">QA</span> VioEdu
          <span class="vio-badge-locked">LOCKED</span>
        </div>
        <div class="vio-controls">
          <button id="vio-btn-minimize" title="Thu nhỏ">−</button>
        </div>
      </div>
      <div class="vio-body" id="vio-hud-body">
        <div class="vio-gate-head">
          <h3>Unlock required</h3>
          <p>Nhập Staff Key để mở tool kiểm tra đáp án.</p>
        </div>
        <div class="vio-status-row">
          <span class="vio-indicator thinking" id="vio-status-indicator"></span>
          <span id="vio-status-text">Chờ xác thực User</span>
        </div>
        <div class="vio-auth-box gate" style="display:block;">
          <div class="vio-auth-desc" id="vio-gate-msg">Key phải có trong whitelist GitHub.</div>
          <input type="text" id="vio-input-staff-key" placeholder="VIO1.12...." style="margin-bottom:10px;">
          <button id="vio-btn-activate-key" class="vio-btn-primary" style="width:100%;">Kích hoạt key</button>
        </div>
      </div>
    `;
    document.body.appendChild(hud);
    makeDraggable(hud);

    document.getElementById('vio-btn-minimize').addEventListener('click', () => {
      const body = document.getElementById('vio-hud-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('vio-btn-activate-key').addEventListener('click', () => {
      const key = (document.getElementById('vio-input-staff-key').value || '').trim();
      const msg = document.getElementById('vio-gate-msg');
      if (!key) {
        msg.textContent = 'Vui lòng nhập Staff Key.';
        msg.style.color = '#f07178';
        return;
      }
      msg.textContent = 'Đang kiểm tra GitHub whitelist...';
      msg.style.color = '#e8b84a';
      chrome.runtime.sendMessage({ action: 'ACTIVATE_STAFF_KEY', key }, res => {
        if (!res || !res.success) {
          msg.textContent = (res && res.error) || 'Kích hoạt thất bại';
          msg.style.color = '#f07178';
          return;
        }
        isAuthenticated = true;
        enterAuthenticatedMode();
      });
    });
  }

  function updateHUDFromConfig() {
    const selProvider = document.getElementById('vio-select-provider');
    const chkAutoSolve = document.getElementById('vio-chk-autosolve');
    const chkAutoSubmit = document.getElementById('vio-chk-autosubmit');

    if (selProvider && ['vireonix', 'openrouter', 'groq'].includes(config.provider)) {
      selProvider.value = config.provider;
    }
    if (chkAutoSolve) chkAutoSolve.checked = !!config.autoSolve;
    if (chkAutoSubmit) chkAutoSubmit.checked = !!config.autoSubmit;

    updateProviderAuthBoxUI();
  }

  function updateProviderAuthBoxUI() {
    const groqAuthBox = document.getElementById('vio-groq-auth-box');
    const openRouterAuthBox = document.getElementById('vio-openrouter-auth-box');
    if (!groqAuthBox || !openRouterAuthBox) return;

    groqAuthBox.style.display = config.provider === 'groq' ? 'block' : 'none';
    openRouterAuthBox.style.display = config.provider === 'openrouter' ? 'block' : 'none';

    const groqKeyInput = document.getElementById('vio-input-groq-key');
    const groqStatus = document.getElementById('vio-groq-key-status');
    if (groqKeyInput) groqKeyInput.value = config.groqApiKey || '';
    if (groqStatus) {
      groqStatus.textContent = config.groqApiKey
        ? 'Groq key saved (' + config.groqApiKey.length + ' characters).'
        : 'No Groq key saved.';
    }

    const openRouterInput = document.getElementById('vio-input-openrouter-key');
    const openRouterStatus = document.getElementById('vio-openrouter-key-status');
    if (openRouterInput) openRouterInput.value = config.openRouterApiKey || '';
    if (openRouterStatus) {
      openRouterStatus.textContent = config.openRouterApiKey
        ? 'OpenRouter key saved (' + config.openRouterApiKey.length + ' characters).'
        : 'No OpenRouter key saved.';
    }
  }

  function saveHudCredential(storageKey, inputId, statusId, label) {
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    const value = (input && input.value || '').trim();
    if (status) {
      status.textContent = 'Saving and verifying...';
      status.style.color = '#e8b84a';
    }

    chrome.storage.local.set({ [storageKey]: value }, () => {
      const writeError = chrome.runtime.lastError;
      if (writeError) {
        if (status) {
          status.textContent = 'Save failed: ' + writeError.message;
          status.style.color = '#f07178';
        }
        addLog('Could not save ' + label + ': ' + writeError.message, 'error');
        return;
      }

      chrome.storage.local.get([storageKey], saved => {
        const readError = chrome.runtime.lastError;
        if (readError || saved[storageKey] !== value) {
          const reason = readError ? readError.message : 'saved value did not match';
          if (status) {
            status.textContent = 'Save failed: ' + reason;
            status.style.color = '#f07178';
          }
          addLog('Could not verify ' + label + ' save: ' + reason, 'error');
          return;
        }

        config[storageKey] = value;
        updateProviderAuthBoxUI();
        if (status) {
          status.textContent = value ? label + ' saved (' + value.length + ' characters).' : label + ' cleared.';
          status.style.color = '#3dd6a5';
        }
        addLog(value ? label + ' saved and verified.' : label + ' cleared.', 'success');
      });
    });
  }

  function listenToNetworkInterceptor() {
    window.addEventListener('__VIO_QUESTION_EVENT__', (event) => {
      const detail = event.detail;
      if (detail && detail.data) {
        const rawQ = detail.data.question || detail.data.content || detail.data.title || detail.data.cau_hoi || '';
        const qStr = typeof rawQ === 'string' ? rawQ : '';
        if (!qStr || looksLikeTopicList(qStr)) {
          addLog('Bỏ qua gói tin không phải đề bài (topic/list).', 'warn');
          return;
        }
        interceptedNetworkQuestion = detail.data;
        addLog(`Bắt được gói tin câu hỏi`, 'info');
        if (config.autoSolve && (findExerciseSubmitButton(document) || hasQuestionHeader(document))) {
          triggerDebouncedSolve();
        }
      }
    });
  }

  function checkExplanationScreen() {
    const buttons = Array.from(document.querySelectorAll('button, a.btn, div[role="button"]'));
    const ackBtn = buttons.find(b => (b.innerText || '').trim().toLowerCase() === 'đã hiểu' && b.offsetParent !== null);
    if (ackBtn) {
      addLog('Màn hình giải thích ("Đã hiểu"). Bấm nút "Đã hiểu" để qua câu tiếp.', 'warn');
      if (config.autoSubmit) {
        setTimeout(() => simulateClick(ackBtn), 1500);
      }
      return true;
    }
    return false;
  }

  // --- HUD OVERLAY (chỉ khi đã auth) ---
  function createOverlayHUD() {
    removeHud();

    const hud = document.createElement('div');
    hud.id = 'vioedu-ai-hud';
    hud.innerHTML = `
      <div class="vio-header">
        <div class="vio-title">
          <span class="vio-badge">QA</span> VioEdu
          <span id="vio-mode-badge" class="vio-badge-dom">LIVE</span>
        </div>
        <div class="vio-controls">
          <button id="vio-btn-minimize" title="Thu nhỏ">−</button>
        </div>
      </div>
      <div class="vio-body" id="vio-hud-body">
        <div class="vio-status-row">
          <span class="vio-indicator ready" id="vio-status-indicator"></span>
          <span id="vio-status-text">Đang sẵn sàng</span>
        </div>

        <div class="vio-field">
          <label>AI Provider</label>
          <select id="vio-select-provider">
            <option value="vireonix">Vireonix.ai — Free</option>
            <option value="openrouter">OpenRouter</option>
            <option value="groq">Groq — Free tier</option>
          </select>
        </div>

        <div id="vio-groq-auth-box" class="vio-auth-box" style="display: none;">
          <label for="vio-input-groq-key">Groq API Key</label>
          <input type="password" id="vio-input-groq-key" placeholder="gsk_..." style="margin-bottom: 8px;">
          <div id="vio-groq-key-status" class="vio-auth-desc">No Groq key saved.</div>
          <button id="vio-btn-save-groq-key" class="vio-btn-auth" style="width: 100%;">Save Groq Key</button>
          <button id="vio-btn-groq-console" class="vio-btn-auth" style="width: 100%; margin-top: 6px;">Open Groq Console</button>
        </div>

        <div id="vio-openrouter-auth-box" class="vio-auth-box" style="display: none;">
          <label for="vio-input-openrouter-key">OpenRouter API Key</label>
          <input type="password" id="vio-input-openrouter-key" placeholder="sk-or-v1-..." style="margin-bottom: 8px;">
          <div id="vio-openrouter-key-status" class="vio-auth-desc">No OpenRouter key saved.</div>
          <button id="vio-btn-save-openrouter-key" class="vio-btn-auth" style="width: 100%;">Save OpenRouter Key</button>
        </div>

        <div class="vio-field-row">
          <label>
            <input type="checkbox" id="vio-chk-autosolve" ${config.autoSolve ? 'checked' : ''}>
            Auto giải
          </label>
          <label>
            <input type="checkbox" id="vio-chk-autosubmit" ${config.autoSubmit ? 'checked' : ''}>
            Auto nộp
          </label>
        </div>

        <div class="vio-actions">
          <button id="vio-btn-solve-now" class="vio-btn-primary">Giải câu hiện tại</button>
        </div>

        <div class="vio-log-box" id="vio-log-box">
          <div class="vio-log-entry info">Sẵn sàng · bấm giải hoặc bật auto.</div>
        </div>
      </div>
    `;

    document.body.appendChild(hud);
    makeDraggable(hud);

    document.getElementById('vio-btn-minimize').addEventListener('click', () => {
      const body = document.getElementById('vio-hud-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    const selProvider = document.getElementById('vio-select-provider');
    selProvider.value = (config.provider || 'vireonix');

    selProvider.addEventListener('change', (e) => {
      config.provider = e.target.value;
      chrome.storage.local.set({ provider: config.provider });
      updateProviderAuthBoxUI();
      addLog(`Chuyển AI sang: ${config.provider}`, 'info');
    });

    updateProviderAuthBoxUI();

    document.getElementById('vio-btn-save-groq-key').addEventListener('click', () => {
      saveHudCredential('groqApiKey', 'vio-input-groq-key', 'vio-groq-key-status', 'Groq API key');
    });

    document.getElementById('vio-btn-save-openrouter-key').addEventListener('click', () => {
      saveHudCredential('openRouterApiKey', 'vio-input-openrouter-key', 'vio-openrouter-key-status', 'OpenRouter API key');
    });

    document.getElementById('vio-btn-groq-console').addEventListener('click', () => {
      window.open('https://console.groq.com/keys', 'GroqConsole');
    });

    const chkAutoSolve = document.getElementById('vio-chk-autosolve');
    chkAutoSolve.addEventListener('change', (e) => {
      config.autoSolve = e.target.checked;
      chrome.storage.local.set({ autoSolve: config.autoSolve });
      updateObserverState();
      addLog(`Tự động giải: ${config.autoSolve ? 'BẬT' : 'TẮT'}`, 'info');
      if (config.autoSolve) checkAndSolve();
    });

    const chkAutoSubmit = document.getElementById('vio-chk-autosubmit');
    chkAutoSubmit.addEventListener('change', (e) => {
      config.autoSubmit = e.target.checked;
      chrome.storage.local.set({ autoSubmit: config.autoSubmit });
      addLog(`Tự động nộp: ${config.autoSubmit ? 'BẬT' : 'TẮT'}`, 'info');
    });

    document.getElementById('vio-btn-solve-now').addEventListener('click', (e) => {
      e.preventDefault();
      console.log('[VioEdu-QA] Clicked Solve Now');
      solveCurrentQuestion(true);
    });
  }

  async function ensureStaffAuth(manual = false) {
    const ok = await refreshAuthState();
    if (!ok) {
      if (manual) enterGateMode();
      else if (!document.getElementById('vio-input-staff-key')) enterGateMode();
      return false;
    }
    return true;
  }

  function makeDraggable(element) {
    const header = element.querySelector('.vio-header');
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    header.onmousedown = (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
      document.onmousemove = (e2) => {
        e2.preventDefault();
        pos1 = pos3 - e2.clientX;
        pos2 = pos4 - e2.clientY;
        pos3 = e2.clientX;
        pos4 = e2.clientY;
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
        element.style.bottom = 'auto';
        element.style.right = 'auto';
      };
    };
  }

  function setStatus(text, type = 'ready') {
    if (!isTopWindow) return;
    const statusText = document.getElementById('vio-status-text');
    const indicator = document.getElementById('vio-status-indicator');
    if (statusText) statusText.innerText = text;
    if (indicator) indicator.className = 'vio-indicator ' + type;
  }

  function addLog(text, type = 'info') {
    if (!isTopWindow) return;
    const logBox = document.getElementById('vio-log-box');
    if (!logBox) return;
    const entry = document.createElement('div');
    entry.className = `vio-log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    entry.innerText = `[${time}] ${text}`;
    logBox.prepend(entry);
    while (logBox.children.length > 25) {
      logBox.removeChild(logBox.lastChild);
    }
  }

  // --- CLEAN MATH LATEX EXTRACTOR ---
  function extractCleanMathText(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);

    const junk = clone.querySelectorAll('.zoom-btn, [class*="zoom"], .btn-action, button, [class*="btn"]');
    junk.forEach(j => j.remove());

    const katexNodes = Array.from(clone.querySelectorAll('.katex'));
    katexNodes.forEach(k => {
      const texSpan = k.querySelector('annotation[encoding="application/x-tex"]') || k.querySelector('annotation');
      let tex = texSpan ? texSpan.textContent.trim() : '';
      if (!tex) {
        const math = k.querySelector('math');
        if (math && math.getAttribute('alttext')) {
          tex = math.getAttribute('alttext').trim();
        }
      }

      if (tex) {
        k.replaceWith(document.createTextNode(` $${tex}$ `));
      } else {
        const htmlPart = k.querySelector('.katex-html');
        if (htmlPart) htmlPart.remove();
      }
    });

    const mathJaxNodes = Array.from(clone.querySelectorAll('.MathJax, math'));
    mathJaxNodes.forEach(m => {
      const tex = m.getAttribute('alttext') || (m.querySelector('annotation') ? m.querySelector('annotation').textContent : '');
      if (tex) {
        m.replaceWith(document.createTextNode(` $${tex.trim()}$ `));
      }
    });

    return clone.innerText.replace(/\s+/g, ' ').trim();
  }

  // --- BULLETPROOF QUESTION CARD FINDER ---
  function queryPageElements(root, selector) {
    if (!root || !root.querySelectorAll) return [];
    return Array.from(root.querySelectorAll(selector)).filter(el =>
      !(el.closest && el.closest('#vioedu-ai-hud'))
    );
  }

  function findExerciseSubmitButton(root = document) {
    const buttons = queryPageElements(root, 'button, a.btn, div[role="button"]');
    return buttons.find(b => {
      const t = (b.innerText || '').toLowerCase().trim();
      if (b.offsetParent !== null && /^(answer|check|submit|continue)$/i.test(t)) return true;
      return (
        b.offsetParent !== null &&
        (t === 'trả lời' ||
          t.includes('✓ trả lời') ||
          t.includes('trả lời') ||
          t.includes('nộp bài') ||
          b.classList.contains('btn-submit'))
      );
    }) || null;
  }

  function hasQuestionHeader(root = document) {
    const nodes = queryPageElements(root, 'h1, h2, h3, h4, h5, div, span, p, strong, b');
    return nodes.some(el => {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 60) return false;
      return /Câu\s*(hỏi)?\s*(số)?\s*\d+/i.test(t);
    });
  }

  function looksLikeTopicList(text) {
    if (!text) return true;
    const raw = String(text).trim();
    if (raw.length < 8) return true;
    const t = raw.toLowerCase();

    const topicKeywords = [
      'danh sách chủ đề', 'danh sách bài', 'chọn chủ đề', 'chọn bài học',
      'lộ trình', 'chương trình học', 'mục lục', 'khóa học', 'bài học của bạn',
      'các chủ đề', 'topic list', 'lesson list', 'curriculum', 'chỉ có danh sách',
      'only a list of topics', 'no specific exercise'
    ];
    if (topicKeywords.some(k => t.includes(k))) return true;

    const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const shortLines = lines.filter(l => l.length > 0 && l.length <= 48);
    // Many short title-like lines without exercise verbs => topic/menu screen
    if (shortLines.length >= 6 && shortLines.length / lines.length >= 0.65) {
      const hasExerciseVerb = /(tính|chọn|điền|nối|ghép|trả lời|match|choose|select|fill|complete|which|identify|drag|drop|blank|stress|syllable|sound|contain|does)/i.test(raw);
      if (!hasExerciseVerb) return true;
    }
    return false;
  }

  function hasExercisePrompt(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    if (/give the correct form|form of the verb|verb in brackets|complete the sentence|complete each sentence|fill in the blank|write the correct form|rewrite without changing (the )?meaning|rewrite the sentence|complete the second sentence|use the word given|key word transformation/.test(t)) return true;
    return (
      /câu\s*(hỏi)?\s*(số)?\s*\d+/i.test(text) ||
      /(bạn hãy|hãy chọn|hãy điền|hãy tính|tính|chọn đáp án|điền vào|ô trống|nối|ghép|chỗ chấm)/i.test(text) ||
      /\b(match|choose|select|identify|find|complete|fill|write|answer|which|listen|read|drag|drop|underline|circle|contain|does|sound|stress|syllable|blank)\b/i.test(t) ||
      /\?/.test(text) ||
      /\.{2,}|…/.test(text) ||
      /[=+\-×÷]/.test(text) ||
      false
    );
  }

  function isWordBankHint(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return (
      t.includes('drag and drop') ||
      t.includes('drag the') ||
      t.includes('drop the') ||
      t.includes('into the blank') ||
      t.includes('into the blanks') ||
      t.includes('click vào đáp án') ||
      t.includes('tự động điền') ||
      t.includes('điền vào chỗ chấm') ||
      t.includes('chỗ chấm') ||
      (/\.{2,}|…/.test(text) && (t.includes('click') || t.includes('drag') || t.includes('điền') || t.includes('đáp án')))
    );
  }

  function isExerciseCard(card) {
    if (!card || card.offsetParent === null) return false;
    if (card.id === 'vioedu-ai-hud' || (card.closest && card.closest('#vioedu-ai-hud'))) return false;
    if (card.offsetWidth < 280 || card.offsetHeight < 120) return false;
    const text = (card.innerText || '').trim();
    if (looksLikeTopicList(text)) return false;
    const hasSubmit = !!findExerciseSubmitButton(card) || !!findExerciseSubmitButton(document);
    const hasHeader = hasQuestionHeader(card) || hasQuestionHeader(document);
    const hasInteract =
      card.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, input[type="radio"], input[type="checkbox"], [role="checkbox"], [role="radio"]') ||
      card.querySelector('.ant-select, [role="combobox"], [role="listbox"], .dropdown, .select-box') ||
      findOptionsInCard(card).length >= 2 ||
      Array.from(card.querySelectorAll('button, div[role="button"], .answer-chip, .word-item')).some(b => {
        const t = (b.innerText || '').trim();
        const r = b.getBoundingClientRect();
        return t.length >= 1 && t.length <= 40 && r.width >= 36 && r.height >= 22 && !/trả lời|nộp/i.test(t);
      });
    if (!(hasSubmit || hasHeader || (hasInteract && hasExercisePrompt(text)))) return false;
    if (!hasInteract && !hasExercisePrompt(text)) return false;
    return true;
  }

  function isValidParsedQuestion(parsed) {
    if (!parsed) return false;
    const q = (parsed.questionText || '').trim();
    if (q.length < 8) return false;
    if (looksLikeTopicList(q)) return false;
    if (/no specific exercise|only a list of topics|not a question|không có câu hỏi/i.test(q)) return false;

    const hasChoices = (parsed.options || []).length >= 2;
    const hasInputs = (parsed.inputs || []).length >= 1;
    const hasMatch = (parsed.leftItems || []).length >= 2 && (parsed.rightItems || []).length >= 2;
    const hasWords = (parsed.interactiveWords || []).length >= 2;
    const hasDropdown = (parsed.dropdowns || []).length >= 1;
    const isWordBank = parsed.type === 'word_bank';

    if (parsed.type === 'fill_blank' && !hasInputs && !isWordBank) return false;
    if (!(hasChoices || hasInputs || hasMatch || hasWords || hasDropdown || isWordBank)) return false;

    const pageHasExercise = !!findExerciseSubmitButton(document) || hasQuestionHeader(document);
    if (!pageHasExercise && !parsed.card) return false;
    if (parsed.card && !isExerciseCard(parsed.card)) return false;
    if (!hasExercisePrompt(q) && !hasChoices && !hasMatch && !hasWords && !hasDropdown) return false;

    return true;
  }

  function findQuestionCard() {
    if (checkExplanationScreen()) return null;

    // STRATEGY 1: Reverse trace from green Submit Button ("✓ Trả lời")
    const submitBtn = findExerciseSubmitButton(document);

    if (submitBtn) {
      let p = submitBtn.parentElement;
      while (p && p !== document.body) {
        const pText = p.innerText || '';
        const pTextLower = pText.toLowerCase();
        if (
          p.offsetWidth > 300 &&
          p.offsetHeight > 140 &&
          !looksLikeTopicList(pText) &&
          (hasExercisePrompt(pText) || pText.includes('Câu hỏi') || pText.includes('chọn') || pText.includes('điền') || p.querySelector('.katex, math, input:not([type="hidden"]), select, input[type="checkbox"], input[type="radio"], .ant-select, [role="combobox"]')) &&
          !pText.startsWith('Giải thích')
        ) {
          if (isExerciseCard(p)) return p;
        }
        p = p.parentElement;
      }
    }

    // STRATEGY 2: Find header matching "Câu hỏi số \d+" (strict — no loose English-only cues)
    const all = queryPageElements(document, 'h1, h2, h3, h4, h5, div, span, p, strong, b');
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (/Câu\s*(hỏi)?\s*(số)?\s*\d+/i.test(t) && t.length < 80) {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const pText = p.innerText || '';
          if (p.offsetWidth > 300 && p.offsetHeight > 140 && !pText.startsWith('Giải thích') && !looksLikeTopicList(pText)) {
            if (isExerciseCard(p)) return p;
          }
          p = p.parentElement;
        }
      }
    }

    // STRATEGY 3 (strict): input near an exercise submit button only
    if (submitBtn) {
      const inputs = queryPageElements(document, 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea')
        .filter(inp => inp.offsetParent !== null);
      for (const input of inputs) {
        let p = input.parentElement;
        while (p && p !== document.body) {
          if (p.contains(submitBtn) && p.offsetWidth > 300 && p.offsetHeight > 140 && isExerciseCard(p)) {
            return p;
          }
          p = p.parentElement;
        }
      }
    }

    // English exercise pages may lack a Vietnamese header or recognizable submit label.
    const answerControls = queryPageElements(document,
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [role="combobox"]'
    ).filter(el => el.offsetParent !== null);
    for (const control of answerControls) {
      let p = control.parentElement;
      while (p && p !== document.body) {
        if (p.offsetWidth > 300 && p.offsetHeight > 120 && isExerciseCard(p)) return p;
        p = p.parentElement;
      }
    }

    // Some VioEdu multiple-choice pages render answer cards with custom divs
    // and decorative radio circles instead of real input elements.
    const promptNodes = queryPageElements(document, 'h1, h2, h3, h4, h5, p, span, strong, b, div')
      .filter(el => {
        const t = (el.innerText || '').trim();
        return t.length >= 12 && t.length <= 220 && hasExercisePrompt(t);
      });
    for (const prompt of promptNodes) {
      let p = prompt.parentElement;
      while (p && p !== document.body) {
        if (p.offsetWidth > 300 && p.offsetHeight > 120 && isExerciseCard(p)) return p;
        p = p.parentElement;
      }
    }

    return null;
  }

  function isMultiChoiceText(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    // Keep this strict — broad phrases caused single-choice misclassified as multi
    return (
      t.includes('select all that apply') ||
      t.includes('choose all that apply') ||
      t.includes('all that apply') ||
      t.includes('choose the correct answers') ||
      t.includes('which words') ||
      t.includes('which sentences') ||
      t.includes('những từ nào') ||
      t.includes('những đáp án nào') ||
      t.includes('chọn các đáp án') ||
      t.includes('các phương án nào') ||
      t.includes('những câu nào') ||
      t.includes('chọn tất cả') ||
      t.includes('các ý đúng') ||
      t.includes('chọn nhiều') ||
      t.includes('các câu đúng')
    );
  }

  function findOptionsInCard(card) {
    if (!card) return [];

    // 1. Checkboxes (Multi-choice)
    const checkboxes = Array.from(card.querySelectorAll('input[type="checkbox"], [role="checkbox"], .ant-checkbox-input, .custom-checkbox input'));
    if (checkboxes.length >= 2) {
      return checkboxes.map((cb, idx) => {
        const parent = cb.closest('label, div, li') || cb;
        return {
          index: idx,
          element: parent,
          inputElement: cb,
          isCheckbox: true,
          text: extractCleanMathText(parent)
        };
      });
    }

    // 2. Radio buttons (Single-choice)
    const radios = Array.from(card.querySelectorAll('input[type="radio"]'));
    if (radios.length >= 2) {
      return radios.map((r, idx) => ({
        index: idx,
        element: r.closest('label, div, li') || r,
        inputElement: r,
        isRadio: true,
        text: extractCleanMathText(r.closest('label, div, li') || r)
      }));
    }

    // 3. Word bank clickable chips / buttons (e.g. "Click vào đáp án phía dưới để tự động điền")
    const submitBtn = findSubmitButton(card);
    const chips = Array.from(card.querySelectorAll('button, a.btn, div.btn, .answer-chip, .word-item, div[role="button"]')).filter(b => {
      if (b === submitBtn || b.contains(submitBtn) || (submitBtn && submitBtn.contains(b))) return false;
      const t = (b.innerText || '').trim();
      const r = b.getBoundingClientRect();
      return t.length >= 1 && t.length <= 80 && r.width >= 40 && r.width <= 320 && r.height >= 24 && r.height <= 90 && b.offsetParent !== null;
    });

    if (chips.length >= 2 && chips.length <= 10) {
      return chips.map((c, idx) => ({
        index: idx,
        element: c,
        isChip: true,
        text: extractCleanMathText(c)
      }));
    }

    // 4. Generic card/div option boxes (horizontal or vertical layout)
    const divs = Array.from(card.querySelectorAll('div, li, label')).filter(d => {
      if (d === card || d.contains(card)) return false;
      const h = d.offsetHeight;
      const w = d.offsetWidth;
      const t = (d.innerText || '').trim();
      return h >= 28 && h <= 140 && w >= 70 && w <= 650 && t.length >= 1 && t.length <= 200;
    });

    const top = divs.filter(d => !divs.some(other => other !== d && other.contains(d) && other.innerText.trim() === d.innerText.trim()));
    if (top.length >= 2 && top.length <= 8) {
      return top.map((el, idx) => {
        const innerCb = el.querySelector('input[type="checkbox"], [role="checkbox"], .ant-checkbox-input, .custom-checkbox input');
        const innerRadio = el.querySelector('input[type="radio"]');
        return {
          index: idx,
          element: el,
          inputElement: innerCb || innerRadio || el,
          isCheckbox: !!innerCb,
          isRadio: !!innerRadio,
          text: extractCleanMathText(el)
        };
      });
    }

    return [];
  }

  function scrapeOpenDropdownOptions() {
    const menus = queryPageElements(document,
      '[role="listbox"], .ant-select-dropdown, .rc-virtual-list, .dropdown-menu, .select-dropdown, ul[role="listbox"]'
    ).filter(m => m.offsetParent !== null || (m.getBoundingClientRect().height > 0 && m.getBoundingClientRect().width > 0));

    const opts = [];
    const pushEl = (el) => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 80) return;
      if (/^(chọn|select|please select)$/i.test(text)) return;
      if (opts.some(o => o.text.toLowerCase() === text.toLowerCase())) return;
      opts.push({ index: opts.length, text, element: el });
    };

    for (const menu of menus) {
      Array.from(menu.querySelectorAll('[role="option"], .ant-select-item, li, div, button, span')).forEach(pushEl);
    }

    // Fallback: visible Yes/No style items near open menus
    if (opts.length < 2) {
      queryPageElements(document, 'li, div, button, span').forEach(el => {
        if (el.offsetParent === null) return;
        const text = (el.innerText || '').trim();
        if (/^(yes|no|có|không|true|false)$/i.test(text)) pushEl(el);
      });
    }
    return opts;
  }

  function findDropdownsInCard(card) {
    if (!card) return [];
    const selects = Array.from(card.querySelectorAll('select'));
    const validSelects = selects.filter(s => s.offsetParent !== null);
    if (validSelects.length > 0) {
      return validSelects.map(sel => {
        const rawOpts = Array.from(sel.querySelectorAll('option'));
        const options = rawOpts
          .map((o, idx) => ({ index: idx, value: o.value, text: (o.innerText || o.text || '').trim(), element: o }))
          .filter(o => o.text && !o.text.toLowerCase().includes('chọn') && o.value !== '');
        return {
          element: sel,
          options: options.length > 0 ? options : rawOpts.map((o, idx) => ({ index: idx, value: o.value, text: o.text.trim(), element: o }))
        };
      });
    }

    // Custom dropdown triggers
    let triggers = Array.from(card.querySelectorAll('.ant-select, .select-box, [role="combobox"], .dropdown-toggle, .ant-select-selector')).filter(d => d.offsetParent !== null);

    // VioEdu often uses a "Chọn" box without ant classes
    if (triggers.length === 0) {
      triggers = Array.from(card.querySelectorAll('div, button, span')).filter(el => {
        if (el.offsetParent === null) return false;
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return (/^(chọn|select)$/i.test(t) || t.toLowerCase() === 'chọn') && r.width >= 50 && r.width <= 420 && r.height >= 28 && r.height <= 72;
      });
    }

    if (triggers.length === 0) return [];

    const openOpts = scrapeOpenDropdownOptions();
    return triggers.map(el => ({
      element: el,
      options: openOpts.length >= 2 ? openOpts : [],
      isCustom: true
    }));
  }

  async function revealCustomDropdownChoices() {
    const card = findQuestionCard();
    if (!card) return;
    const dropdown = findDropdownsInCard(card).find(dd => dd.isCustom && (!dd.options || dd.options.length < 2));
    if (!dropdown || scrapeOpenDropdownOptions().length >= 2) return;
    simulateClick(dropdown.element);
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  function findInputsInCard(card) {
    if (!card) return [];
    const inputs = Array.from(card.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]), textarea'));
    return inputs.filter(inp => inp.offsetParent !== null);
  }

  function isWordClickInstruction(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return (
      t.includes('click on the word') ||
      t.includes('click the word') ||
      t.includes('click a word') ||
      t.includes('tap the word') ||
      t.includes('underline the word') ||
      t.includes('underline') ||
      t.includes('circle the word') ||
      t.includes('gạch chân') ||
      t.includes('gạch dưới') ||
      t.includes('khoanh tròn từ') ||
      t.includes('tìm từ') ||
      t.includes('chọn từ trong') ||
      t.includes('chọn từ có') ||
      t.includes('nhấp vào từ') ||
      t.includes('bấm vào từ') ||
      t.includes('xác định từ') ||
      t.includes('click vào từ') ||
      t.includes('drag the word') ||
      (t.includes('sound') && (t.includes('/') || t.includes('word')) && !/\byes\b|\bno\b/.test(t) && !t.includes('contain the sound') && !t.includes('contains the sound'))
    );
  }

  function isMatchingHint(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return (
      t.includes('match') ||
      t.includes('nối') ||
      t.includes('ghép') ||
      t.includes('cặp') ||
      t.includes('pair the') ||
      t.includes('draw a line') ||
      t.includes('draw lines') ||
      t.includes('expressions with') ||
      /\bconnect\b.{0,100}\b(each|the following|pairs?|columns?|with|to)\b/i.test(t) ||
      /draw (a|the) line(s)? (to connect|between|from)/i.test(t) ||
      t.includes('nối câu') ||
      t.includes('nối các') ||
      t.includes('nối với') ||
      t.includes('nối từng') ||
      t.includes('ghép câu') ||
      t.includes('ghép với') ||
      t.includes('tương ứng')
    );
  }

  function findInteractiveWordsInCard(card) {
    if (!card) return null;

    // Prefer dedicated clickable word nodes
    const taggedWords = Array.from(card.querySelectorAll(
      '.word, .word-item, .clickable-word, [class*="word"], span[style*="cursor"], span[onclick], u, mark'
    )).filter(el => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return t.length >= 1 && t.length <= 28 && !t.includes('\n') && r.height > 0 && el.offsetParent !== null;
    });
    if (taggedWords.length >= 3) {
      const leaf = taggedWords.filter(s => !taggedWords.some(other => other !== s && other.contains(s)));
      if (leaf.length >= 2) {
        const words = leaf.map((el, idx) => {
          const raw = (el.innerText || '').trim();
          const clean = raw.replace(/^[.,/#!$%^&*;:{}=\-_`~()?"']+|[.,/#!$%^&*;:{}=\-_`~()?"']+$/g, '');
          return { index: idx, rawText: raw, word: clean.toLowerCase(), element: el };
        }).filter(w => w.word.length >= 1);
        if (words.length >= 2) {
          return {
            container: leaf[0].parentElement || card,
            sentence: words.map(w => w.rawText).join(' '),
            words
          };
        }
      }
    }

    // Look for paragraph/container containing clickable word spans
    const paragraphs = Array.from(card.querySelectorAll('p, div.sentence, div.content, .question-text, div')).filter(p => {
      if (p === card || p.contains(card)) return false;
      const spans = Array.from(p.querySelectorAll('span, a, b, i, em, u')).filter(s => {
        const t = (s.innerText || '').trim();
        return t.length >= 1 && t.length <= 30 && !t.includes('\n') && s.offsetParent !== null;
      });
      return spans.length >= 2;
    });

    for (const p of paragraphs) {
      if (isWordClickInstruction((p.innerText || '').trim()) && (p.innerText || '').trim().length < 100) continue;
      const rawSpans = Array.from(p.querySelectorAll('span, a, b, i, em, u')).filter(s => {
        const t = (s.innerText || '').trim();
        // allow short multi-char tokens; single punctuation skip later
        return t.length >= 1 && t.length <= 30 && !t.includes('\n');
      });

      const leafSpans = rawSpans.filter(s => !rawSpans.some(other => other !== s && other.contains(s)));
      // Need enough tokens to look like a sentence, not A/B/C options
      if (leafSpans.length >= 3) {
        const words = leafSpans.map((el, idx) => {
          const raw = (el.innerText || '').trim();
          const clean = raw.replace(/^[.,/#!$%^&*;:{}=\-_`~()?"']+|[.,/#!$%^&*;:{}=\-_`~()?"']+$/g, '');
          return {
            index: idx,
            rawText: raw,
            word: clean.toLowerCase(),
            element: el
          };
        }).filter(w => w.word.length >= 1);

        if (words.length >= 3) {
          return {
            container: p,
            sentence: words.map(w => w.rawText).join(' '),
            words: words
          };
        }
      }
    }

    // FALLBACK: If the question instruction is a word-click type but words are plain text (not wrapped in spans),
    // find the sentence paragraph and extract individual words as synthetic click targets.
    const fullText = (card.innerText || '');
    if (isWordClickInstruction(fullText)) {
      // Find the sentence line(s) — typically the second visible paragraph (first is the instruction)
      const allBlocks = Array.from(card.querySelectorAll('p, div')).filter(el => {
        if (el === card || el.contains(card)) return false;
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        // A sentence block: has multiple words, is visible, and is NOT the instruction line
        return t.length >= 5 && t.split(/\s+/).length >= 3 && r.height > 10 && r.height < 120 &&
               el.offsetParent !== null && !isWordClickInstruction(t);
      });

      // Pick the best sentence block (the one that doesn't match the instruction text)
      for (const block of allBlocks) {
        const sentenceText = (block.innerText || '').trim();
        // Skip if this block IS the instruction
        if (isWordClickInstruction(sentenceText)) continue;
        // Skip if too long (probably the entire card text)
        if (sentenceText.length > 200 || sentenceText.includes('\n')) continue;

        // Check if the block has individual child elements per word (span, etc.)
        const childEls = Array.from(block.children).filter(c => {
          const ct = (c.innerText || '').trim();
          return ct.length >= 1 && ct.length <= 30;
        });

        if (childEls.length >= 3) {
          // Words are wrapped in child elements
          const words = childEls.map((el, idx) => {
            const raw = (el.innerText || '').trim();
            const clean = raw.replace(/^[.,/#!$%^&*;:{}=\-_`~()?"']+|[.,/#!$%^&*;:{}=\-_`~()?"']+$/g, '');
            return { index: idx, rawText: raw, word: clean.toLowerCase(), element: el };
          }).filter(w => w.word.length >= 1);
          if (words.length >= 2) {
            return { container: block, sentence: sentenceText, words };
          }
        }

        // Words are plain text — split and create synthetic targets
        // The entire block element is the click target; we'll send word list to AI
        // and handle clicking via text-based targeting at apply time
        const rawWords = sentenceText.split(/\s+/).filter(w => w.length >= 1);
        if (rawWords.length >= 2) {
          const words = rawWords.map((w, idx) => {
            const clean = w.replace(/^[.,/#!$%^&*;:{}=\-_`~()?"']+|[.,/#!$%^&*;:{}=\-_`~()?"']+$/g, '');
            return { index: idx, rawText: w, word: clean.toLowerCase(), element: block, isPlainText: true };
          }).filter(w => w.word.length >= 1);
          if (words.length >= 2) {
            return { container: block, sentence: sentenceText, words, isPlainText: true };
          }
        }
      }
    }

    return null;
  }

  function findMatchingItemsInCard(card) {
    if (!card) return null;

    // Radio/checkbox options are multiple choice, even when laid out in two columns.
    const cbs = card.querySelectorAll('input[type="checkbox"], [role="checkbox"], .ant-checkbox');
    if (cbs.length >= 2) return null;
    const radios = card.querySelectorAll('input[type="radio"], [role="radio"], .ant-radio');
    if (radios.length >= 2) return null;

    const cardText = card.innerText || '';
    const hinted = isMatchingHint(cardText);
    // A two-column choice grid can look like matching. Require explicit pair/match wording.
    if (!hinted) return null;

    const cardRect = card.getBoundingClientRect();
    if (cardRect.width < 250) return null;
    const midX = cardRect.left + cardRect.width / 2;
    const submitBtn = findSubmitButton(card);

    const elements = Array.from(card.querySelectorAll('div, li, button, a, span')).filter(el => {
      if (el === card || el.contains(card)) return false;
      if (submitBtn && (el === submitBtn || submitBtn.contains(el) || el.contains(submitBtn))) return false;
      const r = el.getBoundingClientRect();
      const t = (el.innerText || '').trim();
      if (!t || t.length < 2 || t.length > 200) return false;
      if (/^(trả lời|nộp bài|tiếp tục|câu hỏi)/i.test(t)) return false;
      if (isMatchingHint(t) && t.length < 80) return false; // skip instruction line itself
      return r.width >= 40 && r.width <= 520 && r.height >= 20 && r.height <= 200 && el.offsetParent !== null;
    });

    const candidates = elements.filter(el => !elements.some(other => other !== el && other.contains(el) && (other.innerText || '').trim() === (el.innerText || '').trim()));

    const left = [];
    const right = [];

    candidates.forEach(el => {
      const r = el.getBoundingClientRect();
      const text = extractCleanMathText(el);
      if (!text || text.length < 2) return;
      // Ignore very wide full-width rows (instruction / sentence)
      if (r.width > cardRect.width * 0.72) return;
      const centerX = r.left + r.width / 2;

      if (centerX < midX - 8) {
        if (!left.some(item => item.text === text)) {
          left.push({ element: el, text, top: r.top, left: r.left });
        }
      } else if (centerX > midX + 8) {
        if (!right.some(item => item.text === text)) {
          right.push({ element: el, text, top: r.top, left: r.left });
        }
      }
    });

    const leftTops = left.map(i => i.top);
    const rightTops = right.map(i => i.top);
    const leftVerticalSpread = leftTops.length >= 2 ? (Math.max(...leftTops) - Math.min(...leftTops)) : 0;
    const rightVerticalSpread = rightTops.length >= 2 ? (Math.max(...rightTops) - Math.min(...rightTops)) : 0;

    // With strong hint, allow slightly flatter columns; otherwise require clear vertical stacks
    const minSpread = hinted ? 22 : 35;
    if (leftVerticalSpread < minSpread || rightVerticalSpread < minSpread) {
      return null;
    }

    const hasDots = card.querySelector('.dot, .circle, .point, svg circle, [class*="dot"], [class*="circle"], [class*="connector"], [class*="line"], [class*="match"], [class*="join"]') !== null;
    const hasRoundElements = Array.from(card.querySelectorAll('div, span')).some(el => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const br = parseFloat(style.borderRadius) || 0;
      return r.width >= 6 && r.width <= 35 && r.height >= 6 && r.height <= 35 &&
             Math.abs(r.width - r.height) <= 6 &&
             br >= r.width * 0.3;
    });
    if (!hinted && !hasDots && !hasRoundElements) {
      return null;
    }

    left.sort((a, b) => a.top - b.top);
    right.sort((a, b) => a.top - b.top);

    if (left.length >= 2 && right.length >= 2 && Math.abs(left.length - right.length) <= 2) {
      return {
        left: left.map((item, idx) => ({ index: idx, element: item.element, text: item.text })),
        right: right.map((item, idx) => ({ index: idx, element: item.element, text: item.text }))
      };
    }

    return null;
  }

  function findSubmitButton(card) {
    const root = card || document;
    const buttons = Array.from(root.querySelectorAll('button, a.btn, div[role="button"]'));
    return buttons.find(b => {
      const t = (b.innerText || '').toLowerCase();
      return (t.includes('trả lời') || t.includes('tiếp tục') || t.includes('nộp bài')) && b.offsetParent !== null;
    }) || null;
  }

  function getOptionElement(parsed, idx) {
    if (parsed.options && parsed.options[idx]) {
      const opt = parsed.options[idx];
      if (opt.inputElement && opt.inputElement.isConnected) return opt.inputElement;
      if (opt.element && opt.element.isConnected) return opt.element;
    }

    // Fallback: search live DOM card
    const card = parsed.card || findQuestionCard();
    if (card) {
      const freshOptions = findOptionsInCard(card);
      if (freshOptions[idx]) {
        return freshOptions[idx].inputElement || freshOptions[idx].element;
      }
      const targetText = (parsed.options && parsed.options[idx]?.text || '').trim().toLowerCase();
      if (targetText) {
        const match = freshOptions.find(o => {
          const ot = (o.text || '').trim().toLowerCase();
          return ot.includes(targetText) || targetText.includes(ot);
        });
        if (match) return match.inputElement || match.element;
      }
    }
    return null;
  }

  function buildQuestionText(fullText, options) {
    let qText = fullText;
    (options || []).forEach(opt => {
      if (opt.text) qText = qText.replace(opt.text, '');
    });
    return qText.replace(/Trả lời/g, '').replace(/Câu hỏi số \d+/g, '').replace(/\s+/g, ' ').trim();
  }

  function parseCurrentQuestion() {
    const card = findQuestionCard();

    if (card) {
      const fullText = extractCleanMathText(card);
      const isMultiText = isMultiChoiceText(fullText) || (interceptedNetworkQuestion && (interceptedNetworkQuestion.type === 'multiple' || interceptedNetworkQuestion.is_multi));
      const dropdowns = findDropdownsInCard(card);
      const options = findOptionsInCard(card);
      const inputs = findInputsInCard(card);
      const hasRadios = options.some(o => o.isRadio);
      const hasRealCheckboxes = options.some(o => o.isCheckbox);
      const chipOptions = options.filter(o => o.isChip);
      const qText = buildQuestionText(fullText, options);
      const fillHint = /điền|ô trống|fill in|enter the|write the|nhập/i.test(qText || fullText);
      const wordBank = isWordBankHint(fullText);
      const wordClickQ = isWordClickInstruction(fullText);
      const matchHint = isMatchingHint(fullText);

      // A) Matching / nối câu — MUST be before single_choice (column items look like options)
      const matching = findMatchingItemsInCard(card);
      if (matching && matching.left.length >= 2 && matching.right.length >= 2) {
        const headerText = (fullText.split('\n').find(l => isMatchingHint(l)) || fullText.split('\n')[0] || 'Nối các cặp tương ứng:').trim();
        return {
          id: `match_${matching.left.map(l => l.text.slice(0, 8)).join('_')}`,
          card,
          questionText: headerText,
          options: [],
          inputs: [],
          leftItems: matching.left,
          rightItems: matching.right,
          type: 'matching'
        };
      }
      // Strong nối/match wording but columns not parsed yet — still block falling into single_choice
      if (matchHint && !hasRadios && !hasRealCheckboxes && inputs.length === 0 && !wordBank) {
        // try once more with network left/right if present later; for now continue to word_click
      }

      // B) Word click / gạch chân — before single_choice & word_bank
      const wordPick = findInteractiveWordsInCard(card);
      if (wordClickQ && wordPick && wordPick.words.length >= 2) {
        return {
          id: `word_${wordPick.words.map(w => w.word).join('_').slice(0, 30)}`,
          card,
          questionText: fullText,
          sentence: wordPick.sentence,
          interactiveWords: wordPick.words,
          isPlainTextWords: !!wordPick.isPlainText,
          options: wordPick.words.map(w => ({ index: w.index, text: w.rawText })),
          inputs: [],
          type: 'word_click'
        };
      }
      // Instruction says underline/gạch chân even if spans not ready — avoid mislabel as MCQ
      if (wordClickQ && !hasRadios && !hasRealCheckboxes && inputs.length === 0 && !wordBank) {
        if (wordPick && wordPick.words.length >= 2) {
          return {
            id: `word_${wordPick.words.map(w => w.word).join('_').slice(0, 30)}`,
            card,
            questionText: fullText,
            sentence: wordPick.sentence,
            interactiveWords: wordPick.words,
            isPlainTextWords: !!wordPick.isPlainText,
            options: wordPick.words.map(w => ({ index: w.index, text: w.rawText })),
            inputs: [],
            type: 'word_click'
          };
        }
      }

      // C) Dropdown — native or custom "Chọn" (Yes/No etc.)
      if (dropdowns.length > 0 && !wordClickQ && !matchHint) {
        const dd = dropdowns[0];
        const openOpts = scrapeOpenDropdownOptions();
        const ddOpts = (dd.options && dd.options.length >= 2) ? dd.options
          : (openOpts.length >= 2 ? openOpts : null);
        if (dd && ddOpts && ddOpts.length >= 2) {
          return {
            id: `dd_${(qText || fullText).slice(0, 30)}_${ddOpts.length}`,
            card,
            questionText: qText || fullText,
            options: ddOpts,
            dropdowns: [{ ...dd, options: ddOpts }],
            inputs: [],
            type: 'dropdown'
          };
        }
      }

      // D) Word bank / drag-drop chips into blanks
      if (wordBank && !wordClickQ && !matchHint && (chipOptions.length >= 2 || options.length >= 2)) {
        const bankOpts = chipOptions.length >= 2 ? chipOptions : options;
        return {
          id: `bank_${(qText || fullText).slice(0, 30)}_${bankOpts.length}`,
          card,
          questionText: qText || fullText,
          options: bankOpts,
          inputs: [],
          type: 'word_bank',
          blankCount: Math.max(1, ((qText || fullText).match(/\.{2,}|…|_{2,}/g) || []).length)
        };
      }

      // 1) Single choice — skip if this is clearly gạch chân / nối
      if (!wordClickQ && !matchHint && options.length >= 2 && (hasRadios || (!hasRealCheckboxes && !isMultiText && inputs.length === 0 && !fillHint && !wordBank))) {
        return {
          id: `single_${(qText || fullText).slice(0, 30)}_${options.length}`,
          card,
          questionText: qText || fullText,
          options,
          inputs: [],
          type: 'single_choice'
        };
      }

      // 2) Multi choice
      if (!wordClickQ && !matchHint && options.length >= 2 && (hasRealCheckboxes || isMultiText) && !hasRadios) {
        return {
          id: `multi_${fullText.slice(0, 30)}_${options.length}`,
          card,
          questionText: fullText,
          options,
          inputs: [],
          type: 'multi_choice'
        };
      }

      // 3) Fill blank — typed inputs only
      if (inputs.length > 0 && !wordClickQ && !matchHint) {
        return {
          id: `fill_${(qText || fullText).slice(0, 35)}_${inputs.length}`,
          card,
          questionText: qText || fullText,
          options: [],
          inputs,
          type: 'fill_blank'
        };
      }

      // Last resort word_click if we found interactive words
      if (wordClickQ && wordPick && wordPick.words.length >= 2) {
        return {
          id: `word_${wordPick.words.map(w => w.word).join('_').slice(0, 30)}`,
          card,
          questionText: fullText,
          sentence: wordPick.sentence,
          interactiveWords: wordPick.words,
          isPlainTextWords: !!wordPick.isPlainText,
          options: wordPick.words.map(w => ({ index: w.index, text: w.rawText })),
          inputs: [],
          type: 'word_click'
        };
      }

      if (!wordClickQ && !matchHint && options.length >= 2 && hasExercisePrompt(qText || fullText) && !wordBank) {
        return {
          id: `single_${(qText || fullText).slice(0, 30)}_${options.length}`,
          card,
          questionText: qText || fullText,
          options,
          inputs: [],
          type: 'single_choice'
        };
      }

      return null;
    }

    // Network fallback ONLY when page already looks like an exercise room
    if (
      interceptedNetworkQuestion &&
      (findExerciseSubmitButton(document) || hasQuestionHeader(document))
    ) {
      const net = interceptedNetworkQuestion;
      const qText = typeof net.question === 'string' ? net.question : '';
      if (!qText || looksLikeTopicList(qText) || !hasExercisePrompt(qText)) return null;
      const isMultiNet = isMultiChoiceText(qText) || net.type === 'multiple' || net.is_multi;
      const opts = (net.answers || []).map((o, idx) => ({
        index: idx,
        text: typeof o === 'string' ? o : (o.content || o.text || JSON.stringify(o))
      }));
      if (opts.length === 0) return null;
      return {
        id: `net_${qText.slice(0, 30)}`,
        card: null,
        questionText: qText,
        options: opts,
        inputs: [],
        type: isMultiNet ? 'multi_choice' : 'single_choice',
        isNetwork: true
      };
    }

    return null;
  }

  function findClickableTarget(el) {
    if (!el) return el;
    // Check for dot/point/circle child or adjacent sibling
    const dot = el.querySelector('.dot, .circle, .point, svg, circle, [class*="dot"], [class*="point"], [class*="circle"]');
    if (dot && dot.offsetParent !== null) return dot;
    if (el.nextElementSibling && (el.nextElementSibling.matches('.dot, .circle, .point, svg, [class*="dot"]') || el.nextElementSibling.querySelector('svg, circle'))) {
      return el.nextElementSibling;
    }
    if (el.previousElementSibling && (el.previousElementSibling.matches('.dot, .circle, .point, svg, [class*="dot"]') || el.previousElementSibling.querySelector('svg, circle'))) {
      return el.previousElementSibling;
    }
    return el;
  }

  function setNativeInputValue(input, value) {
    if (!input) return;
    input.focus();
    const cleanVal = String(value).trim();
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, cleanVal);
    } else {
      input.value = cleanVal;
    }
    const tracker = input._valueTracker;
    if (tracker) {
      tracker.setValue(cleanVal);
    }
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
  }

  // --- SOLVER DISPATCHER ---

  async function solveCurrentQuestion(manual = false) {
    if (isSolving) {
      if (!manual) pendingAutoSolve = true;
      else addLog('A solve is already running. Please wait.', 'warn');
      return;
    }

    isSolving = true;
    let solvingQuestionId = null;
    try {
      const authed = await ensureStaffAuth(manual);
      if (!authed) return;

      if (manual) {
        addLog('Scanning the current question...', 'info');
        setStatus('Scanning...', 'thinking');
      }

      if (checkExplanationScreen()) {
        if (manual) addLog('Explanation screen detected. Continue past it first.', 'warn');
        return;
      }

      await revealCustomDropdownChoices();

      const parsed = parseCurrentQuestion();
      if (!parsed || !isValidParsedQuestion(parsed)) {
        if (manual) addLog('No valid exercise detected yet.', 'warn');
        setStatus('Waiting for question', 'error');
        return;
      }

      if (!manual) {
        const failedUntil = autoFailureCooldowns.get(parsed.id) || 0;
        if (failedUntil > Date.now()) {
          setStatus('Provider limit reached; auto paused', 'error');
          return;
        }
        if (failedUntil) autoFailureCooldowns.delete(parsed.id);
      }

      if (!manual && parsed.id === lastSolvedQuestionId) return;

      solvingQuestionId = parsed.id;
      lastSolveTime = Date.now();
      setStatus('Sending to AI...', 'thinking');
      const typeLabels = { matching: 'Matching', fill_blank: 'Fill blank', multi_choice: 'Multiple choice', dropdown: 'Dropdown', word_click: 'Select word', word_bank: 'Word bank', single_choice: 'Multiple choice' };
      addLog('Solving [' + (typeLabels[parsed.type] || 'Question') + ']: "' + parsed.questionText.slice(0, 45) + '..."', 'info');

      const aiResponse = await sendToAiService({
        questionText: parsed.questionText,
        options: (parsed.options || []).map(o => ({ index: o.index, text: o.text })),
        leftItems: (parsed.leftItems || []).map(i => ({ index: i.index, text: i.text })),
        rightItems: (parsed.rightItems || []).map(i => ({ index: i.index, text: i.text })),
        blankCount: parsed.blankCount || (parsed.inputs || []).length || 1,
        type: parsed.type,
        overrideProvider: config.provider
      });

      setStatus('Applying answer...', 'answering');
      await applyAnswer(parsed, aiResponse);
      lastSolvedQuestionId = parsed.id;
      autoRetryCounts.delete(parsed.id);
      setStatus('Answered', 'success');
      interceptedNetworkQuestion = null;
    } catch (err) {
      console.error('[VioEdu-AI] Error:', err);
      const providerLimited = !manual && solvingQuestionId && config.autoSolve && isProviderLimitError(err);
      if (providerLimited) {
        setStatus('Provider limit reached; auto paused', 'error');
        addLog('Provider limit reached: ' + err.message + ' Auto retry paused for 60 seconds.', 'warn');
        autoFailureCooldowns.set(solvingQuestionId, Date.now() + 60_000);
      } else {
        setStatus('Error: ' + err.message, 'error');
        addLog('Error: ' + err.message, 'error');
        if (!manual && solvingQuestionId && config.autoSolve) scheduleAutoRetry(solvingQuestionId);
      }
    } finally {
      isSolving = false;
      const shouldDrain = pendingAutoSolve && isAuthenticated && config.autoSolve;
      pendingAutoSolve = false;
      if (shouldDrain) triggerDebouncedSolve();
    }
  }

  async function applyAnswer(parsed, aiResult) {
    // 0.3. Word selection / Underline click in sentence
    if (parsed.type === 'word_click' && parsed.interactiveWords && parsed.interactiveWords.length > 0) {
      let targetIndices = [];
      if (aiResult.chosenIndices && Array.isArray(aiResult.chosenIndices)) {
        targetIndices = aiResult.chosenIndices;
      } else if (typeof aiResult.chosenIndex === 'number') {
        targetIndices = [aiResult.chosenIndex];
      }

      // If target by word string (may be comma-separated for multiple words)
      const chosenWordRaw = String(aiResult.chosenWord || aiResult.chosenOption || aiResult.fillValue || '').toLowerCase().trim();
      const chosenWords = chosenWordRaw.includes(',') ? chosenWordRaw.split(',').map(w => w.trim()) : [chosenWordRaw];

      if (chosenWords[0] && targetIndices.length === 0) {
        for (const cw of chosenWords) {
          if (!cw) continue;
          const foundIdx = parsed.interactiveWords.findIndex(w =>
            w.word === cw || w.rawText.toLowerCase() === cw || w.rawText.toLowerCase().includes(cw)
          );
          if (foundIdx >= 0 && !targetIndices.includes(foundIdx)) targetIndices.push(foundIdx);
        }
      }

      addLog(`AI chọn gạch chân từ: "${chosenWords.join(', ') || targetIndices.map(i => parsed.interactiveWords[i]?.rawText).join(', ')}"`, 'success');
      if (aiResult.explanation) addLog(`Giải: ${aiResult.explanation}`, 'info');

      for (const idx of targetIndices) {
        if (parsed.interactiveWords[idx]) {
          const wordEntry = parsed.interactiveWords[idx];
          if (wordEntry.isPlainText) {
            // Plain text word: click the container element at the approximate word position
            // Try to find if the DOM has since re-rendered with clickable spans
            const freshCard = parsed.card || findQuestionCard();
            const freshWordPick = freshCard ? findInteractiveWordsInCard(freshCard) : null;
            let clicked = false;

            if (freshWordPick && !freshWordPick.isPlainText) {
              // DOM re-rendered with real spans — find matching word
              const match = freshWordPick.words.find(w => w.word === wordEntry.word || w.rawText.toLowerCase() === wordEntry.rawText.toLowerCase());
              if (match && match.element) {
                simulateClick(match.element);
                clicked = true;
              }
            }

            if (!clicked) {
              // Click the container — VioEdu may use event delegation
              simulateClick(wordEntry.element);
            }
          } else {
            // Normal span-wrapped word
            simulateClick(wordEntry.element);
          }
          await new Promise(r => setTimeout(r, 200));
          addLog(`Đã click gạch chân từ: [${parsed.interactiveWords[idx].rawText}]`, 'success');
        }
      }

      if (config.autoSubmit) {
        setTimeout(() => {
          const btn = findSubmitButton(parsed.card);
          if (btn) simulateClick(btn);
        }, config.answerDelayMs || 1200);
      }
      return;
    }

    // 0. Word bank — click chips into blanks (NOT single-choice)
    if (parsed.type === 'word_bank' && parsed.options && parsed.options.length > 0) {
      let values = [];
      if (Array.isArray(aiResult.fillValues) && aiResult.fillValues.length) {
        values = aiResult.fillValues.map(v => String(v).trim());
      } else if (aiResult.fillValue) {
        values = String(aiResult.fillValue).split(/[,|]/).map(v => v.trim()).filter(Boolean);
      } else if (Array.isArray(aiResult.chosenOptions) && aiResult.chosenOptions.length) {
        values = aiResult.chosenOptions.map(v => String(v).trim());
      } else if (aiResult.chosenOption) {
        values = [String(aiResult.chosenOption).trim()];
      } else if (typeof aiResult.chosenIndex === 'number' && parsed.options[aiResult.chosenIndex]) {
        values = [parsed.options[aiResult.chosenIndex].text];
      }

      if (!values.length) values = [parsed.options[0].text];
      addLog(`AI chọn từ điền: [${values.join(', ')}]`, 'success');
      if (aiResult.explanation) addLog(`Giải: ${aiResult.explanation}`, 'info');

      const used = new Set();
      for (const val of values) {
        const needle = val.toLowerCase();
        const opt = parsed.options.find((o, idx) => {
          if (used.has(idx)) return false;
          const ot = (o.text || '').toLowerCase().trim();
          return ot === needle || ot.includes(needle) || needle.includes(ot);
        });
        if (opt) {
          used.add(opt.index);
          simulateClick(opt.element);
          await new Promise(r => setTimeout(r, 220));
          addLog(`Đã click chip [${opt.text}]`, 'success');
        } else {
          addLog(`Không thấy chip cho "${val}"`, 'warn');
        }
      }

      if (config.autoSubmit) {
        setTimeout(() => {
          const btn = findSubmitButton(parsed.card);
          if (btn) simulateClick(btn);
        }, config.answerDelayMs || 1200);
      }
      return;
    }

    // 0. Dropdown question (<select> / custom Chọn)
    if (parsed.type === 'dropdown' && parsed.dropdowns && parsed.dropdowns.length > 0) {
      const dd = parsed.dropdowns[0];
      const targetText = String(aiResult.chosenOption || aiResult.chosenText || aiResult.fillValue || '').toLowerCase().trim();
      addLog(`AI chọn phương án dropdown: "${targetText}"`, 'success');

      if (dd.element && dd.element.tagName === 'SELECT') {
        const select = dd.element;
        let matchedOpt = Array.from(select.options).find(o =>
          (o.text || '').toLowerCase().trim() === targetText || (o.value || '').toLowerCase().trim() === targetText
        );
        if (!matchedOpt && !targetText && typeof aiResult.chosenIndex === 'number' && select.options[aiResult.chosenIndex]) {
          matchedOpt = select.options[aiResult.chosenIndex];
        }

        if (matchedOpt) {
          select.value = matchedOpt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
          addLog(`Đã chọn [${matchedOpt.text}] trong dropdown`, 'success');
        }
      } else if (dd.element) {
        let liveOpts = scrapeOpenDropdownOptions();
        if (liveOpts.length < 2) {
          simulateClick(dd.element);
          await new Promise(r => setTimeout(r, 280));
          liveOpts = scrapeOpenDropdownOptions();
        }
        if (liveOpts.length < 2 && parsed.options) {
          liveOpts = parsed.options.filter(o => o.element);
        }
        let matched = liveOpts.find(o => (o.text || '').toLowerCase().trim() === targetText);
        if (!matched) {
          matched = liveOpts.find(o => (o.text || '').toLowerCase().includes(targetText));
        }
        if (!matched && !targetText && typeof aiResult.chosenIndex === 'number') matched = liveOpts[aiResult.chosenIndex];
        if (matched && matched.element) {
          simulateClick(matched.element);
          addLog(`Đã chọn [${matched.text}] trong dropdown`, 'success');
        } else {
          addLog(`Không click được option dropdown "${targetText}"`, 'warn');
        }
      }

      if (config.autoSubmit) {
        setTimeout(() => {
          const btn = findSubmitButton(parsed.card);
          if (btn) simulateClick(btn);
        }, config.answerDelayMs || 1200);
      }
      return;
    }

    // 0.1. Multi-choice (Chọn nhiều đáp án / Checkbox)
    const aiMultiIndices = Array.isArray(aiResult.chosenIndices) && aiResult.chosenIndices.length > 0
      ? aiResult.chosenIndices
      : (Array.isArray(aiResult.chosenOptions) && aiResult.chosenOptions.length > 1
        ? aiResult.chosenOptions.map(opt => {
            const code = String(opt).toUpperCase().charCodeAt(0);
            return (code >= 65 && code <= 90) ? code - 65 : parseInt(opt, 10);
          }).filter(i => !isNaN(i) && i >= 0)
        : null);

    const isMultiChoiceQuestion = parsed.type === 'multi_choice' || (aiMultiIndices && aiMultiIndices.length > 1);

    if (isMultiChoiceQuestion && parsed.options && parsed.options.length > 0) {
      let indices = aiMultiIndices;
      if (!indices || indices.length === 0) {
        if (typeof aiResult.chosenIndex === 'number') indices = [aiResult.chosenIndex];
        else if (aiResult.chosenOption) {
          const code = String(aiResult.chosenOption).toUpperCase().charCodeAt(0);
          if (code >= 65 && code <= 90) indices = [code - 65];
        }
      }

      if (!indices || indices.length === 0) indices = [0];

      addLog(`AI chọn các ý (${indices.length} đáp án): [${indices.map(i => String.fromCharCode(65 + i)).join(', ')}]`, 'success');
      if (aiResult.explanation) addLog(`Giải: ${aiResult.explanation}`, 'info');

      for (const idx of indices) {
        const targetEl = getOptionElement(parsed, idx);
        if (targetEl) {
          simulateClick(targetEl);
          await new Promise(r => setTimeout(r, 220));
          addLog(`Đã tích chọn phương án [${String.fromCharCode(65 + idx)}]: ${parsed.options[idx]?.text?.slice(0, 25) || ''}`, 'success');
        } else {
          addLog(`Không tìm thấy phần tử DOM cho phương án [${String.fromCharCode(65 + idx)}]`, 'warn');
        }
      }

      if (config.autoSubmit) {
        setTimeout(() => {
          const btn = findSubmitButton(parsed.card);
          if (btn) simulateClick(btn);
        }, config.answerDelayMs || 1200);
      }
      return;
    }

    // 0.2. Matching / Connect pairs
    if (parsed.type === 'matching' && parsed.leftItems && parsed.rightItems) {
      const pairs = aiResult.pairs || [];
      addLog(`AI ghép được ${pairs.length} cặp tương ứng`, 'success');
      if (aiResult.explanation) addLog(`Giải thích: ${aiResult.explanation}`, 'info');

      for (const pair of pairs) {
        const lIdx = pair.leftIndex;
        const rIdx = pair.rightIndex;
        if (lIdx !== undefined && rIdx !== undefined && parsed.leftItems[lIdx] && parsed.rightItems[rIdx]) {
          const lItem = parsed.leftItems[lIdx];
          const rItem = parsed.rightItems[rIdx];
          addLog(`Nối: "${lItem.text.slice(0, 22)}..." ➔ "${rItem.text.slice(0, 22)}..."`, 'info');

          const lTarget = findClickableTarget(lItem.element);
          const rTarget = findClickableTarget(rItem.element);

          simulateClick(lTarget);
          await new Promise(r => setTimeout(r, 250));
          simulateClick(rTarget);
          await new Promise(r => setTimeout(r, 350));
        }
      }

      // Auto Submit
      if (config.autoSubmit) {
        setTimeout(() => {
          const btn = findSubmitButton(parsed.card);
          if (btn) {
            addLog(`Tự động nộp: "${btn.innerText.trim()}"`, 'info');
            simulateClick(btn);
          }
        }, config.answerDelayMs || 1200);
      }
      return;
    }

    // 1. Fill in the blank
    if (parsed.type === 'fill_blank' || parsed.inputs.length > 0) {
      let valToFill = aiResult.fillValue;
      if (!valToFill && aiResult.fillValues && aiResult.fillValues.length > 0) {
        valToFill = aiResult.fillValues[0];
      }
      if (!valToFill) {
        valToFill = aiResult.calculation || aiResult.chosenText || aiResult.answer;
      }

      if (typeof valToFill === 'string') {
        const numMatch = valToFill.match(/-?\d+(\.\d+)?/);
        if (numMatch && valToFill.length > 15) {
          valToFill = numMatch[0];
        }
      }

      addLog(`AI tính ra kết quả: ${valToFill}`, 'success');
      if (aiResult.explanation) addLog(`Giải: ${aiResult.explanation}`, 'info');

      if (parsed.inputs.length > 0) {
        parsed.inputs.forEach((inp, idx) => {
          const itemVal = (aiResult.fillValues && aiResult.fillValues[idx] !== undefined) ? aiResult.fillValues[idx] : valToFill;
          setNativeInputValue(inp, itemVal);
          addLog(`Đã điền [${itemVal}] vào ô trống #${idx + 1}`, 'success');
        });
      }
    } else {
      // 2. Multiple choice
      addLog(`AI chọn đáp án: ${JSON.stringify(aiResult.chosenOption || aiResult.chosenText || aiResult.chosenIndex)}`, 'success');
      if (aiResult.explanation) addLog(`Giải: ${aiResult.explanation}`, 'info');

      let targetIdx = aiResult.chosenIndex;
      if (typeof targetIdx !== 'number' && parsed.options.length > 0) {
        if (aiResult.chosenOption) {
          const code = String(aiResult.chosenOption).toUpperCase().charCodeAt(0);
          if (code >= 65 && code <= 68) targetIdx = code - 65;
        }
        if (targetIdx === undefined && aiResult.chosenText) {
          targetIdx = parsed.options.findIndex(opt =>
            opt.text.toLowerCase().includes(String(aiResult.chosenText).toLowerCase().trim())
          );
        }
      }

      const targetEl = getOptionElement(parsed, targetIdx ?? 0);
      if (targetEl) {
        simulateClick(targetEl);
        addLog(`Đã click chọn đáp án [${String.fromCharCode(65 + (targetIdx ?? 0))}]`, 'success');
      } else if (parsed.options.length > 0) {
        const fallbackEl = getOptionElement(parsed, 0);
        if (fallbackEl) simulateClick(fallbackEl);
        addLog(`Chọn đáp án 1 (Dự phòng)`, 'warn');
      }
    }

    // Auto Submit
    if (config.autoSubmit) {
      setTimeout(() => {
        const btn = findSubmitButton(parsed.card);
        if (btn) {
          addLog(`Tự động nộp: "${btn.innerText.trim()}"`, 'info');
          simulateClick(btn);
        }
      }, config.answerDelayMs || 1200);
    }
  }

  function simulateClick(element) {
    if (!element) return;
    const targets = new Set();
    targets.add(element);

    const innerInput = element.querySelector('input, [role="checkbox"], [role="radio"], .ant-checkbox-inner, .checkbox, .check-box, .box');
    if (innerInput) targets.add(innerInput);

    const parentLabel = element.closest('label, li, .option-item');
    if (parentLabel) targets.add(parentLabel);

    targets.forEach(el => {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
        try {
          el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
        } catch (e) {}
      });
      if (typeof el.click === 'function') {
        try { el.click(); } catch (e) {}
      }
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        try {
          el.checked = !el.checked;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {}
      }
    });
  }

  function sendToAiService(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'SOLVE_QUESTION', payload }, res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res.success) return reject(new Error(res.error || 'Lỗi từ AI'));
        resolve(res.data);
      });
    });
  }

  function checkAndSolve() {
    if (!isAuthenticated || !config.autoSolve) return;
    if (isSolving) {
      pendingAutoSolve = true;
      return;
    }
    solveCurrentQuestion(false);
  }

  function triggerDebouncedSolve() {
    if (!isAuthenticated || !config.autoSolve) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      solveCurrentQuestion(false);
    }, 900);
  }

  function scheduleAutoRetry(questionId) {
    const retries = autoRetryCounts.get(questionId) || 0;
    if (retries >= 2) {
      addLog('Auto retry limit reached for this question.', 'warn');
      return;
    }
    autoRetryCounts.set(questionId, retries + 1);
    clearTimeout(autoRetryTimer);
    autoRetryTimer = setTimeout(() => {
      autoRetryTimer = null;
      if (config.autoSolve && isAuthenticated) triggerDebouncedSolve();
    }, 1200 * (retries + 1));
  }

  function isProviderLimitError(err) {
    return /http\s*(?:402|429)|rate.?limit|quota|too many requests|insufficient credits|daily.{0,20}limit/i.test(String(err && err.message || err));
  }

  function updateObserverState() {
    if (!isAuthenticated) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      clearTimeout(debounceTimer);
      clearTimeout(autoRetryTimer);
      debounceTimer = null;
      autoRetryTimer = null;
      pendingAutoSolve = false;
      return;
    }
    if (config.autoSolve) {
      if (!observer) {
        observer = new MutationObserver(records => {
          const pageChanged = records.some(record => {
            const target = record.target.nodeType === Node.ELEMENT_NODE
              ? record.target
              : record.target.parentElement;
            return !(target && target.closest && target.closest('#vioedu-ai-hud'));
          });
          if (!pageChanged || !config.autoSolve) return;
          if (isSolving) {
            pendingAutoSolve = true;
            return;
          }
          triggerDebouncedSolve();
        });
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } else {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      clearTimeout(debounceTimer);
      clearTimeout(autoRetryTimer);
      debounceTimer = null;
      autoRetryTimer = null;
      pendingAutoSolve = false;
    }
  }

})();
