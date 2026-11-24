document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const provider = $('provider'), groqBox = $('groq-box'), routerBox = $('openrouter-box'), vireonixInfo = $('vireonix-info');
  const vireonixQuota = $('vireonix-quota');
  const antiBurstPacing = $('antiBurstPacing'), enableCache = $('enableCache'), autoFailover = $('autoFailover');
  const gateScreen = $('gate-screen');
  const settingsScreen = $('settings-screen');
  const staffStatus = $('staff-auth-status');
  const staffStatusOk = $('staff-auth-status-ok');

  let settingsLoaded = false;

  const updateVisibility = value => {
    if (vireonixInfo) vireonixInfo.style.display = value === 'vireonix' ? 'block' : 'none';
    groqBox.style.display = value === 'groq' ? 'block' : 'none';
    routerBox.style.display = value === 'openrouter' ? 'block' : 'none';
  };

  const formatRemaining = ms => {
    if (ms <= 0) return '0 phút';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)} phút`;
  };

  const setLockedUI = (locked, authRes) => {
    if (locked) {
      gateScreen.style.display = 'block';
      settingsScreen.style.display = 'none';
      staffStatus.innerHTML = '<span style="color:#f07178;font-weight:600;">Chưa xác thực / hết hạn</span>';
      return;
    }
    gateScreen.style.display = 'none';
    settingsScreen.style.display = 'block';
    const until = new Date(authRes.expiresAt).toLocaleString();
    staffStatusOk.innerHTML = `Còn <strong style="color:#3dd6a5">${formatRemaining(authRes.remainingMs)}</strong> · hết hạn ${until}`;
  };

  const refreshStaffAuth = () => new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'GET_STAFF_AUTH' }, async res => {
      if (res && (res.locked || (res.error && /khóa|HWID|tamper|integrity/i.test(res.error)))) {
        gateScreen.style.display = 'block';
        settingsScreen.style.display = 'none';
        staffStatus.innerHTML = `<span style="color:#f07178;font-weight:600;">Integrity lock</span><br><span style="color:#94a3b8;font-size:11px;">${res.error || 'Extension đã khóa trên máy này.'}</span>`;
        resolve(false);
        return;
      }
      const ok = !!(res && res.success && res.authenticated);
      setLockedUI(!ok, res || {});
      if (ok && !settingsLoaded) {
        await loadSettingsPanel();
        settingsLoaded = true;
      }
      resolve(ok);
    });
  });

  const defaults = {
    provider: 'vireonix',
    vireonixModel: 'auto',
    vireonixBaseUrl: 'https://vireonix.ai',
    antiBurstPacing: true,
    enableCache: true,
    autoFailover: true,
    openRouterApiKey: '',
    openRouterModel: 'openrouter/free',
    groqApiKey: '',
    groqModel: 'openai/gpt-oss-120b',
    answerDelayMs: 1200,
    autoSolve: false,
    autoSubmit: false
  };

  async function loadSettingsPanel() {
    const cfg = await chrome.storage.local.get(defaults);
    provider.value = ['vireonix', 'groq', 'openrouter'].includes(cfg.provider) ? cfg.provider : 'vireonix';
    $('groqApiKey').value = cfg.groqApiKey || '';
    $('groqModel').value = cfg.groqModel || 'openai/gpt-oss-120b';
    $('openRouterApiKey').value = cfg.openRouterApiKey || '';
    $('openRouterModel').value = cfg.openRouterModel || 'openrouter/free';
    $('answerDelayMs').value = cfg.answerDelayMs || 1200;
    $('autoSolve').checked = !!cfg.autoSolve;
    $('autoSubmit').checked = !!cfg.autoSubmit;
    if (antiBurstPacing) antiBurstPacing.checked = cfg.antiBurstPacing !== false;
    if (enableCache) enableCache.checked = cfg.enableCache !== false;
    if (autoFailover) autoFailover.checked = cfg.autoFailover !== false;
    updateVisibility(provider.value);

    chrome.runtime.sendMessage({ action: 'GET_VIREONIX_LIMITS' }, res => {
      if (res && res.success && res.data && res.data.remaining) {
        const rem = res.data.remaining;
        const pct = Math.round(rem.output ?? rem.overall ?? 100);
        if (vireonixQuota) {
          vireonixQuota.innerHTML = `<span style="color: ${pct > 20 ? '#34d399' : '#f87171'}; font-weight: 600;">${pct}%</span> (Reset: ${new Date(rem.resets_at).toLocaleTimeString()})`;
        }
      } else if (vireonixQuota) {
        vireonixQuota.innerText = 'Bình thường (Đang sẵn sàng)';
      }
    });
  }

  provider.addEventListener('change', e => updateVisibility(e.target.value));
  await refreshStaffAuth();

  $('link-groq-keys').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://console.groq.com/keys' }); });

  $('btn-activate-key').addEventListener('click', () => {
    const key = $('staffKey').value.trim();
    if (!key) {
      staffStatus.innerHTML = '<span style="color:#f87171;">Vui lòng nhập Staff Key.</span>';
      return;
    }
    staffStatus.innerHTML = '<span style="color:#fbbf24;">Đang kiểm tra GitHub whitelist...</span>';
    chrome.runtime.sendMessage({ action: 'ACTIVATE_STAFF_KEY', key }, async res => {
      if (!res || !res.success) {
        staffStatus.innerHTML = `<span style="color:#f87171;">${(res && res.error) || 'Kích hoạt thất bại'}</span>`;
        return;
      }
      $('staffKey').value = '';
      await refreshStaffAuth();
      // Báo content script reload HUD
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: 'STAFF_AUTH_CHANGED', authenticated: true }).catch(() => {});
    });
  });

  $('btn-clear-key').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_STAFF_AUTH' }, async () => {
      settingsLoaded = false;
      await refreshStaffAuth();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: 'STAFF_AUTH_CHANGED', authenticated: false }).catch(() => {});
    });
  });

  const mintButton = $('btn-mint-key');
  if (mintButton) mintButton.addEventListener('click', () => {
    const adminPass = $('adminPass').value;
    const ttlHours = parseInt($('mintTtl').value, 10);
    chrome.runtime.sendMessage({ action: 'MINT_STAFF_KEY', adminPass, ttlHours }, res => {
      if (!res || !res.success) {
        $('mintedKey').value = '';
        staffStatusOk.innerHTML = `<span style="color:#f87171;">${(res && res.error) || 'Không tạo được key'}</span>`;
        return;
      }
      $('mintedKey').value = res.key;
      $('mintedKey').select();
      staffStatusOk.innerHTML = `<span style="color:#a78bfa;">Đã tạo key ${ttlHours}h — nhớ thêm vào GitHub whitelist.</span>`;
    });
  });

  $('btn-save').addEventListener('click', async () => {
    const updated = {
      provider: provider.value,
      antiBurstPacing: antiBurstPacing ? antiBurstPacing.checked : true,
      enableCache: enableCache ? enableCache.checked : true,
      autoFailover: autoFailover ? autoFailover.checked : true,
      groqApiKey: $('groqApiKey').value.trim(),
      groqModel: $('groqModel').value.trim() || 'openai/gpt-oss-120b',
      openRouterApiKey: $('openRouterApiKey').value.trim(),
      openRouterModel: $('openRouterModel').value.trim() || 'openrouter/free',
      answerDelayMs: parseInt($('answerDelayMs').value, 10) || 1200,
      autoSolve: $('autoSolve').checked,
      autoSubmit: $('autoSubmit').checked
    };
    const status = $('status-msg');
    status.style.display = 'block';
    status.style.color = '#e8b84a';
    status.textContent = 'Saving and verifying...';

    try {
      await chrome.storage.local.set(updated);
      const saved = await chrome.storage.local.get(['provider', 'openRouterApiKey', 'groqApiKey']);
      const keyValue = saved.provider === 'openrouter'
        ? String(saved.openRouterApiKey || '')
        : (saved.provider === 'groq' ? String(saved.groqApiKey || '') : '');
      const keyLabel = saved.provider === 'openrouter' ? 'OpenRouter API key' : 'Groq API key';
      const needsKey = saved.provider === 'openrouter' || saved.provider === 'groq';

      if (saved.provider !== updated.provider ||
          saved.openRouterApiKey !== updated.openRouterApiKey ||
          saved.groqApiKey !== updated.groqApiKey) {
        throw new Error('Storage readback did not match the values just saved.');
      }

      status.style.color = needsKey && !keyValue ? '#f07178' : '#3dd6a5';
      status.textContent = needsKey && !keyValue
        ? `Settings saved, but ${keyLabel} is empty.`
        : (needsKey ? `Saved ${saved.provider}; ${keyLabel}: ${keyValue.length} characters.` : 'Settings saved.');
      setTimeout(() => { status.style.display = 'none'; }, 5000);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: 'CONFIG_UPDATED', config: updated }).catch(() => {});
    } catch (error) {
      status.style.color = '#f07178';
      status.textContent = `Save failed: ${error.message || error}`;
    }
  });
});
