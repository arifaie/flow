'use strict';

window.Flow = window.Flow || {};

(function (ns) {
  /**
   * Flow — Zero-Cost Private GitHub Gist Cloud Sync Engine
   * - Syncs tasks, projects, folders, and custom presets across PC, Phone & Tablet
   *   using a private/secret Gist inside the user's own GitHub account.
   * - Credentials (PAT + Gist ID) are stored strictly in device-local localStorage
   *   and NEVER inside workspace data or repository code.
   * - Auto-discovers existing `flow-workspace-sync.json` secret Gists so linking
   *   a second device (like a phone) only requires pasting your token!
   */
  const SYNC_CONFIG_KEY = 'flow_gh_sync_cfg_v1';
  const GIST_FILENAME = 'flow-workspace-sync.json';
  const GIST_DESCRIPTION = 'Flow — Private Cross-Device Task & Project Sync';

  function loadConfig() {
    try {
      const raw = localStorage.getItem(SYNC_CONFIG_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token && parsed.gistId) return parsed;
      return null;
    } catch (_) {
      return null;
    }
  }

  function saveConfig(cfg) {
    try {
      if (!cfg) localStorage.removeItem(SYNC_CONFIG_KEY);
      else localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(cfg));
    } catch (_) {}
  }

  let config = loadConfig();
  let status = config ? 'synced' : 'disconnected'; // 'disconnected' | 'syncing' | 'synced' | 'error'
  let lastError = null;
  let pushTimer = null;
  let isApplyingRemote = false;
  let lastPullCheckAt = 0;

  const statusListeners = new Set();

  function notifyStatus() {
    const snapshot = getStatus();
    statusListeners.forEach((fn) => fn(snapshot));
  }

  function getStatus() {
    return {
      isConnected: Boolean(config && config.token && config.gistId),
      status,
      lastError,
      username: config ? config.username || '' : '',
      gistId: config ? config.gistId || '' : '',
      lastSyncedAt: config ? config.lastSyncedAt || null : null
    };
  }

  async function ghRequest(path, token, options = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method: options.method || 'GET',
      headers: Object.assign(
        {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28'
        },
        options.body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!res.ok) {
      let detail = `GitHub API ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson && errJson.message) detail = errJson.message;
      } catch (_) {}
      throw new Error(detail);
    }

    return res.json();
  }

  function parseGistPayload(gist) {
    if (!gist || !gist.files || !gist.files[GIST_FILENAME]) return null;
    const file = gist.files[GIST_FILENAME];
    if (!file.content) return null;
    try {
      return JSON.parse(file.content);
    } catch (_) {
      return null;
    }
  }

  async function findExistingFlowGist(token) {
    const gists = await ghRequest('/gists?per_page=60', token);
    if (!Array.isArray(gists)) return null;
    return gists.find((g) => g && g.files && g.files[GIST_FILENAME]) || null;
  }

  async function pushToCloud() {
    if (!config || !config.token || !config.gistId) return { ok: false };
    status = 'syncing';
    lastError = null;
    notifyStatus();

    try {
      const payload = ns.Store.getExportablePayload();
      await ghRequest(`/gists/${encodeURIComponent(config.gistId)}`, config.token, {
        method: 'PATCH',
        body: {
          description: GIST_DESCRIPTION,
          files: {
            [GIST_FILENAME]: {
              content: JSON.stringify(payload, null, 2)
            }
          }
        }
      });

      config.lastSyncedAt = Date.now();
      saveConfig(config);
      status = 'synced';
      notifyStatus();
      return { ok: true };
    } catch (err) {
      status = 'error';
      lastError = err.message || 'Sync push failed';
      notifyStatus();
      return { ok: false, error: lastError };
    }
  }

  async function pullFromCloud(options = {}) {
    const { forceApply = false, pushIfLocalNewer = false } = options;
    if (!config || !config.token || !config.gistId) return { ok: false };

    status = 'syncing';
    lastError = null;
    notifyStatus();

    try {
      const gist = await ghRequest(`/gists/${encodeURIComponent(config.gistId)}`, config.token);
      const remoteData = parseGistPayload(gist);

      if (!remoteData) {
        // Remote Gist exists without our file yet — initialize it from local
        return await pushToCloud();
      }

      const localUpdated = Number(ns.Store.getState().updatedAt) || 0;
      const remoteUpdated = Number(remoteData.updatedAt) || 0;

      if (forceApply || remoteUpdated > localUpdated) {
        isApplyingRemote = true;
        ns.Store.replaceStateFromCloud(remoteData);
        isApplyingRemote = false;
        config.lastSyncedAt = Date.now();
        saveConfig(config);
        status = 'synced';
        notifyStatus();
        return { ok: true, action: 'pulled' };
      } else if (pushIfLocalNewer && localUpdated > remoteUpdated) {
        return await pushToCloud();
      }

      config.lastSyncedAt = Date.now();
      saveConfig(config);
      status = 'synced';
      notifyStatus();
      return { ok: true, action: 'up_to_date' };
    } catch (err) {
      isApplyingRemote = false;
      status = 'error';
      lastError = err.message || 'Sync pull failed';
      notifyStatus();
      return { ok: false, error: lastError };
    }
  }

  async function connect({ token, gistId = '' }) {
    const cleanToken = String(token || '').trim();
    let cleanGistId = String(gistId || '').trim();
    if (!cleanToken) {
      return { ok: false, error: 'Please enter a GitHub Personal Access Token.' };
    }

    status = 'syncing';
    lastError = null;
    notifyStatus();

    try {
      // 1. Verify token & fetch GitHub username
      const user = await ghRequest('/user', cleanToken);
      const username = user.login || 'GitHub User';

      // 2. Locate existing Gist or create a new private Gist
      let targetGist = null;
      let createdNew = false;

      if (cleanGistId) {
        targetGist = await ghRequest(`/gists/${encodeURIComponent(cleanGistId)}`, cleanToken);
      } else {
        const discovered = await findExistingFlowGist(cleanToken);
        if (discovered) {
          targetGist = await ghRequest(`/gists/${encodeURIComponent(discovered.id)}`, cleanToken);
          cleanGistId = targetGist.id;
        } else {
          const initialPayload = ns.Store.getExportablePayload();
          targetGist = await ghRequest('/gists', cleanToken, {
            method: 'POST',
            body: {
              description: GIST_DESCRIPTION,
              public: false,
              files: {
                [GIST_FILENAME]: {
                  content: JSON.stringify(initialPayload, null, 2)
                }
              }
            }
          });
          cleanGistId = targetGist.id;
          createdNew = true;
        }
      }

      config = {
        token: cleanToken,
        gistId: cleanGistId,
        username,
        lastSyncedAt: Date.now()
      };
      saveConfig(config);

      if (!createdNew) {
        const remoteData = parseGistPayload(targetGist);
        const localIsUntouchedSeed = !ns.Store.getState().hasUserEdits;
        if (remoteData && (localIsUntouchedSeed || (Number(remoteData.updatedAt) || 0) >= (Number(ns.Store.getState().updatedAt) || 0))) {
          isApplyingRemote = true;
          ns.Store.replaceStateFromCloud(remoteData);
          isApplyingRemote = false;
        } else {
          await pushToCloud();
        }
      }

      status = 'synced';
      lastError = null;
      notifyStatus();
      return { ok: true, username, gistId: cleanGistId, createdNew };
    } catch (err) {
      status = 'error';
      lastError = err.message || 'Could not connect to GitHub';
      notifyStatus();
      return { ok: false, error: lastError };
    }
  }

  function disconnect() {
    clearTimeout(pushTimer);
    config = null;
    saveConfig(null);
    status = 'disconnected';
    lastError = null;
    notifyStatus();
  }

  function schedulePush() {
    if (isApplyingRemote || !config || !config.token || !config.gistId) return;
    clearTimeout(pushTimer);
    status = 'syncing';
    notifyStatus();
    pushTimer = setTimeout(() => {
      pushToCloud();
    }, 1100);
  }

  function init() {
    ns.Store.onDataMutated(schedulePush);

    if (config && config.token && config.gistId) {
      pullFromCloud({ pushIfLocalNewer: true });
    }

    const checkOnWake = () => {
      if (!config || !config.token || !config.gistId) return;
      const now = Date.now();
      if (now - lastPullCheckAt < 8000) return;
      lastPullCheckAt = now;
      pullFromCloud({ pushIfLocalNewer: true });
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkOnWake();
    });
    window.addEventListener('focus', checkOnWake);
    window.addEventListener('online', checkOnWake);
  }

  ns.CloudSync = {
    init,
    getStatus,
    subscribe: (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    connect,
    disconnect,
    syncNow: () => pullFromCloud({ pushIfLocalNewer: true })
  };
})(window.Flow);
