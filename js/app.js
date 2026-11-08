'use strict';

window.Flow = window.Flow || {};

(function (ns) {
  const { Store, icon } = ns;

  /* HTML Escape helper for complete XSS safety */
  function esc(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Ephemeral UI state (modals, popovers, inline column forms, drag state) */
  const uiLocal = {
    tabletSidebarOpen: false,
    renamingStageId: null,
    addingTaskStageId: null,
    addingColumnOpen: false,
    newColumnCategory: 'active',
    activeModal: null, // 'new_list' | 'new_folder' | 'my_day_picker' | 'save_preset' | 'mobile_capture'
    modalContext: {},
    myDaySearch: '',
    dropdown: null, // { x, y, items }
    lastRenderedViewKey: ''
  };

  /* DOM References */
  let dom = {};

  function cacheDom() {
    dom = {
      sidebar: document.getElementById('sidebar'),
      sidebarScroll: document.getElementById('sidebar-scroll'),
      sidebarScrim: document.getElementById('sidebar-scrim'),
      workspaceHeaderLeft: document.getElementById('workspace-header-left'),
      workspaceHeaderRight: document.getElementById('workspace-header-right'),
      captureZone: document.getElementById('workspace-capture-zone'),
      workspaceBody: document.getElementById('workspace-body'),
      detailPane: document.getElementById('detail-pane'),
      detailInner: document.getElementById('detail-pane-inner'),
      detailScrim: document.getElementById('detail-scrim'),
      mobileNav: document.getElementById('mobile-bottom-nav'),
      mobileFab: document.getElementById('mobile-fab'),
      modalMount: document.getElementById('modal-mount'),
      dropdownMount: document.getElementById('dropdown-mount'),
      toastContainer: document.getElementById('toast-container')
    };
  }

  /* ========================================================================
     Gentle Toast Notifications
     ======================================================================== */
  function showToast(message, options = {}) {
    const { variant = 'default', actionLabel = null, onAction = null, duration = 3800 } = options;
    const el = document.createElement('div');
    el.className = `toast ${variant === 'warning' ? 'is-warning' : ''}`;
    el.innerHTML = `
      <span>${esc(message)}</span>
      ${actionLabel ? `<button type="button" class="toast-action-btn">${esc(actionLabel)}</button>` : ''}
    `;

    if (actionLabel && typeof onAction === 'function') {
      el.querySelector('.toast-action-btn').addEventListener('click', () => {
        onAction();
        el.remove();
      });
    }

    dom.toastContainer.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) {
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
        el.style.transition = 'opacity 180ms ease, transform 180ms ease';
        setTimeout(() => el.remove(), 190);
      }
    }, duration);
  }

  function notifyBlockedTask(task, blocker) {
    // Shake all visible instances of this task card
    document.querySelectorAll(`.task-card[data-task-id="${CSS.escape(task.id)}"]`).forEach((card) => {
      card.classList.remove('is-blocked-shake');
      void card.offsetWidth;
      card.classList.add('is-blocked-shake');
    });

    showToast(`⚠️ Blocked by "${blocker.title}" — complete it first.`, {
      variant: 'warning',
      actionLabel: 'View Blocker',
      onAction: () => Store.selectTask(blocker.id),
      duration: 4500
    });
  }

  /* ========================================================================
     Dropdown Popover Engine
     ======================================================================== */
  function openDropdown(anchorRect, items) {
    const menuWidth = 205;
    const estimatedHeight = items.length * 34 + 16;
    const x = Math.min(anchorRect.left, window.innerWidth - menuWidth - 12);
    const y =
      anchorRect.bottom + estimatedHeight > window.innerHeight - 12
        ? Math.max(12, anchorRect.top - estimatedHeight)
        : anchorRect.bottom + 4;

    uiLocal.dropdown = { x: Math.max(12, x), y, items };
    renderDropdown();
  }

  function closeDropdown() {
    if (!uiLocal.dropdown) return;
    uiLocal.dropdown = null;
    dom.dropdownMount.innerHTML = '';
  }

  function renderDropdown() {
    if (!uiLocal.dropdown) {
      dom.dropdownMount.innerHTML = '';
      return;
    }
    const { x, y, items } = uiLocal.dropdown;
    dom.dropdownMount.innerHTML = `
      <div class="dropdown-menu" style="left:${x}px; top:${y}px" role="menu">
        ${items
          .map((item, idx) =>
            item.divider
              ? `<div class="dropdown-divider"></div>`
              : `<button type="button" class="dropdown-item ${item.danger ? 'is-danger' : ''}" data-dd-idx="${idx}">
                  ${item.icon ? icon(item.icon, 14) : ''}
                  <span>${esc(item.label)}</span>
                </button>`
          )
          .join('')}
      </div>
    `;

    dom.dropdownMount.querySelectorAll('[data-dd-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = items[Number(btn.dataset.ddIdx)];
        closeDropdown();
        if (item && typeof item.onClick === 'function') item.onClick();
      });
    });
  }

  /* ========================================================================
     Sidebar Rendering (Desktop & Tablet)
     ======================================================================== */
  let deferredInstallPrompt = null;

  function getSyncPillMarkup(extraClass = '') {
    if (!ns.CloudSync) return '';
    const st = ns.CloudSync.getStatus();
    if (!st.isConnected) {
      return `<button type="button" class="sync-pill-btn ${extraClass}" data-open-sync="true" title="Set up free GitHub cross-device sync">${icon('cloud', 13)} <span>Sync</span></button>`;
    }
    if (st.status === 'syncing') {
      return `<button type="button" class="sync-pill-btn is-syncing ${extraClass}" data-open-sync="true" title="Syncing with GitHub Gist...">${icon('refresh', 13)} <span>Syncing</span></button>`;
    }
    if (st.status === 'error') {
      return `<button type="button" class="sync-pill-btn is-error ${extraClass}" data-open-sync="true" title="${esc(st.lastError || 'Sync error')}">${icon('alert', 13)} <span>Sync Issue</span></button>`;
    }
    return `<button type="button" class="sync-pill-btn is-synced ${extraClass}" data-open-sync="true" title="Synced across devices as @${esc(st.username)}">${icon('cloudCheck', 13)} <span>Synced</span></button>`;
  }

  function renderSyncButtons() {
    const sbBtn = document.getElementById('btn-sidebar-sync');
    if (sbBtn && ns.CloudSync) {
      const st = ns.CloudSync.getStatus();
      sbBtn.className = 'sync-pill-btn ' + (st.isConnected ? (st.status === 'syncing' ? 'is-syncing' : st.status === 'error' ? 'is-error' : 'is-synced') : '');
      if (!st.isConnected) {
        sbBtn.innerHTML = `${icon('cloud', 13)} <span>Sync</span>`;
      } else if (st.status === 'syncing') {
        sbBtn.innerHTML = `${icon('refresh', 13)} <span>Syncing</span>`;
      } else if (st.status === 'error') {
        sbBtn.innerHTML = `${icon('alert', 13)} <span>Error</span>`;
      } else {
        sbBtn.innerHTML = `${icon('cloudCheck', 13)} <span>Synced</span>`;
      }
    }
    const hdrMount = document.getElementById('header-sync-slot');
    if (hdrMount) {
      hdrMount.innerHTML = getSyncPillMarkup('is-header-sync');
    }
  }

  function renderSidebar() {
    const state = Store.getState();
    const { activeView, sidebarCollapsed } = state.ui;

    dom.sidebar.classList.toggle('is-desktop-collapsed', Boolean(sidebarCollapsed));
    dom.sidebar.classList.toggle('is-tablet-open', Boolean(uiLocal.tabletSidebarOpen));
    dom.sidebarScrim.classList.toggle('is-visible', Boolean(uiLocal.tabletSidebarOpen));

    const inboxCount = state.tasks.filter((t) => t.listId === 'inbox' && !t.isCompleted).length;
    const todayCount = Store.getTodayTasks().filter((t) => !t.isCompleted).length;

    const countForList = (listId) =>
      state.tasks.filter((t) => t.listId === listId && !t.isCompleted).length;

    const countForFolder = (folderId) => {
      const childIds = new Set(state.lists.filter((l) => l.folderId === folderId).map((l) => l.id));
      return state.tasks.filter((t) => childIds.has(t.listId) && !t.isCompleted).length;
    };

    const rootLists = state.lists.filter((l) => !l.folderId);
    const tags = Store.getAllTagsWithCounts();

    dom.sidebarScroll.innerHTML = `
      <!-- Core Smart Views -->
      <div class="nav-section">
        <button type="button" class="nav-item ${activeView.type === 'inbox' ? 'is-active' : ''}" data-nav-type="inbox" data-nav-id="inbox">
          <span class="nav-item-icon">${icon('inbox', 17)}</span>
          <span class="nav-item-label">Inbox</span>
          ${inboxCount > 0 ? `<span class="nav-count">${inboxCount}</span>` : ''}
        </button>

        <button type="button" class="nav-item is-today ${activeView.type === 'today' ? 'is-active' : ''}" data-nav-type="today" data-nav-id="today">
          <span class="nav-item-icon">${icon('sunFilled', 17)}</span>
          <span class="nav-item-label">Today</span>
          ${todayCount > 0 ? `<span class="nav-count">${todayCount}</span>` : ''}
        </button>
      </div>

      <!-- Folders & Project Lists -->
      <div class="nav-section">
        <div class="nav-section-header">
          <span>Projects</span>
          <div class="nav-section-actions">
            <button type="button" class="icon-btn is-sm" id="btn-sidebar-new-folder" title="New Folder">
              ${icon('folderPlus', 14)}
            </button>
            <button type="button" class="icon-btn is-sm" id="btn-sidebar-new-list" title="New Project List">
              ${icon('plus', 15)}
            </button>
          </div>
        </div>

        ${state.folders
          .map((folder) => {
            const folderLists = state.lists.filter((l) => l.folderId === folder.id);
            const fCount = countForFolder(folder.id);
            const isFolderActive = activeView.type === 'folder' && activeView.id === folder.id;
            return `
              <div class="folder-group">
                <div class="folder-row ${isFolderActive ? 'is-active' : ''}">
                  <button type="button" class="folder-chevron-btn ${folder.isExpanded ? 'is-expanded' : ''}" data-toggle-folder="${esc(folder.id)}" title="Expand / Collapse">
                    ${icon('chevronRight', 14)}
                  </button>
                  <button type="button" class="folder-main-btn" data-nav-type="folder" data-nav-id="${esc(folder.id)}" title="Open Folder Roll-Up View">
                    <span class="nav-item-icon">${icon('folder', 15)}</span>
                    <span class="nav-item-label">${esc(folder.name)}</span>
                    ${fCount > 0 ? `<span class="nav-count">${fCount}</span>` : ''}
                  </button>
                </div>
                ${
                  folder.isExpanded
                    ? `<div class="folder-children">
                        ${folderLists
                          .map((lst) => {
                            const c = countForList(lst.id);
                            const isActive = activeView.type === 'list' && activeView.id === lst.id;
                            return `
                              <button type="button" class="nav-item ${isActive ? 'is-active' : ''}" data-nav-type="list" data-nav-id="${esc(lst.id)}">
                                <span class="list-color-dot" style="background:${esc(lst.color)}"></span>
                                <span class="nav-item-label">${esc(lst.name)}</span>
                                ${c > 0 ? `<span class="nav-count">${c}</span>` : ''}
                              </button>
                            `;
                          })
                          .join('')}
                      </div>`
                    : ''
                }
              </div>
            `;
          })
          .join('')}

        ${rootLists
          .map((lst) => {
            const c = countForList(lst.id);
            const isActive = activeView.type === 'list' && activeView.id === lst.id;
            return `
              <button type="button" class="nav-item ${isActive ? 'is-active' : ''}" data-nav-type="list" data-nav-id="${esc(lst.id)}">
                <span class="list-color-dot" style="background:${esc(lst.color)}"></span>
                <span class="nav-item-label">${esc(lst.name)}</span>
                ${c > 0 ? `<span class="nav-count">${c}</span>` : ''}
              </button>
            `;
          })
          .join('')}
      </div>

      <!-- Tags Section -->
      <div class="nav-section">
        <div class="nav-section-header">
          <span>Tags</span>
        </div>
        ${
          tags.length === 0
            ? `<div style="padding:2px 8px; font-size:12px; color:var(--text-subtle)">Add #tags in any task</div>`
            : `<div class="sidebar-tags-wrap">
                ${tags
                  .map(
                    ({ tag, open }) => `
                      <button type="button" class="sidebar-tag-chip ${
                        activeView.type === 'tag' && activeView.id === tag ? 'is-active' : ''
                      }" data-nav-type="tag" data-nav-id="${esc(tag)}">
                        <span>#${esc(tag)}</span>
                        ${open > 0 ? `<span style="opacity:0.65">${open}</span>` : ''}
                      </button>
                    `
                  )
                  .join('')}
              </div>`
        }
      </div>
    `;
  }

  /* ========================================================================
     Mobile Bottom Navigation Bar (< 768px)
     4 persistent tabs: Inbox, Today ☀️, Projects 📁, Tags #
     ======================================================================== */
  function renderMobileNav() {
    const state = Store.getState();
    const { activeView } = state.ui;
    const inboxCount = state.tasks.filter((t) => t.listId === 'inbox' && !t.isCompleted).length;
    const todayCount = Store.getTodayTasks().filter((t) => !t.isCompleted).length;

    const isProjectsTab =
      activeView.type === 'projects_hub' ||
      activeView.type === 'list' ||
      activeView.type === 'folder';
    const isTagsTab = activeView.type === 'tags_hub' || activeView.type === 'tag';

    dom.mobileNav.innerHTML = `
      <button type="button" class="mobile-nav-tab ${activeView.type === 'inbox' ? 'is-active' : ''}" data-mobile-tab="inbox">
        <span class="nav-pill">${icon('inbox', 19)}</span>
        <span>Inbox</span>
        ${inboxCount > 0 ? `<span class="mobile-nav-badge">${inboxCount}</span>` : ''}
      </button>

      <button type="button" class="mobile-nav-tab is-today-tab ${activeView.type === 'today' ? 'is-active' : ''}" data-mobile-tab="today">
        <span class="nav-pill">${icon('sunFilled', 19)}</span>
        <span>Today ☀️</span>
        ${todayCount > 0 ? `<span class="mobile-nav-badge" style="background:var(--sun)">${todayCount}</span>` : ''}
      </button>

      <button type="button" class="mobile-nav-tab ${isProjectsTab ? 'is-active' : ''}" data-mobile-tab="projects_hub">
        <span class="nav-pill">${icon('folder', 19)}</span>
        <span>Projects 📁</span>
      </button>

      <button type="button" class="mobile-nav-tab ${isTagsTab ? 'is-active' : ''}" data-mobile-tab="tags_hub">
        <span class="nav-pill">${icon('hash', 19)}</span>
        <span>Tags #</span>
      </button>
    `;
  }

  /* ========================================================================
     Workspace Header & Smart Quick-Capture Zone
     ======================================================================== */
  function getCaptureDefaults() {
    const state = Store.getState();
    const { activeView } = state.ui;

    if (activeView.type === 'list') {
      return { defaultListId: activeView.id, defaultIsInMyDay: false, defaultTag: null };
    }
    if (activeView.type === 'folder') {
      const firstChild = state.lists.find((l) => l.folderId === activeView.id);
      return {
        defaultListId: firstChild ? firstChild.id : 'inbox',
        defaultIsInMyDay: false,
        defaultTag: null
      };
    }
    if (activeView.type === 'today') {
      return { defaultListId: 'inbox', defaultIsInMyDay: true, defaultTag: null };
    }
    if (activeView.type === 'tag') {
      return { defaultListId: 'inbox', defaultIsInMyDay: false, defaultTag: activeView.id };
    }
    return { defaultListId: 'inbox', defaultIsInMyDay: false, defaultTag: null };
  }

  function renderWorkspaceHeader() {
    const state = Store.getState();
    const { activeView, sidebarCollapsed } = state.ui;

    let titleHtml = '';
    let subtitleHtml = '';
    let rightControlsHtml = '';

    if (activeView.type === 'inbox') {
      const openCount = state.tasks.filter((t) => t.listId === 'inbox' && !t.isCompleted).length;
      titleHtml = `${icon('inbox', 19)} <span>Inbox</span>`;
      subtitleHtml = openCount === 0
        ? 'Zero unassigned items — clear mind'
        : `${openCount} unassigned ${openCount === 1 ? 'task' : 'tasks'} ready to triage`;
    } else if (activeView.type === 'today') {
      const todayTasks = Store.getTodayTasks();
      const doneCount = todayTasks.filter((t) => t.isCompleted).length;
      titleHtml = `<span>Today</span> <span style="font-size:17px">☀️</span>`;
      subtitleHtml = `${ns.formatFullTodayHeading()} · ${doneCount}/${todayTasks.length} completed`;
      rightControlsHtml = `
        <button type="button" class="btn btn-sun" id="btn-open-myday-picker">
          ${icon('sparkles', 15)}
          <span>Add to My Day</span>
        </button>
      `;
    } else if (activeView.type === 'list') {
      const list = state.lists.find((l) => l.id === activeView.id);
      if (list) {
        const folder = list.folderId ? state.folders.find((f) => f.id === list.folderId) : null;
        const mode = list.defaultView || 'kanban';
        titleHtml = `<span class="list-color-dot" style="width:10px;height:10px;background:${esc(list.color)}"></span> <span>${esc(list.name)}</span>`;
        subtitleHtml = `${folder ? `${esc(folder.name)} · ` : ''}${list.stages.length} pipeline stages`;
        rightControlsHtml = `
          <div class="view-switcher" role="tablist" aria-label="View Switcher">
            <button type="button" class="view-switch-btn ${mode === 'kanban' ? 'is-active' : ''}" data-switch-view="kanban" data-list-id="${esc(list.id)}">
              ${icon('columns', 14)}
              <span>Board</span>
            </button>
            <button type="button" class="view-switch-btn ${mode === 'list' ? 'is-active' : ''}" data-switch-view="list" data-list-id="${esc(list.id)}">
              ${icon('list', 14)}
              <span>List</span>
            </button>
          </div>
          <button type="button" class="icon-btn" id="btn-list-options" data-list-id="${esc(list.id)}" title="Project & Preset Options">
            ${icon('more', 17)}
          </button>
        `;
      }
    } else if (activeView.type === 'folder') {
      const folder = state.folders.find((f) => f.id === activeView.id);
      if (folder) {
        const childLists = state.lists.filter((l) => l.folderId === folder.id);
        const mode = state.ui.folderViewMode || 'kanban';
        titleHtml = `${icon('folder', 19)} <span>${esc(folder.name)}</span>`;
        subtitleHtml = `Folder Roll-Up · ${childLists.length} ${childLists.length === 1 ? 'project' : 'projects'} unified into Open → Active → Done`;
        rightControlsHtml = `
          <div class="view-switcher" role="tablist">
            <button type="button" class="view-switch-btn ${mode === 'kanban' ? 'is-active' : ''}" data-switch-view="kanban" data-list-id="__folder__">
              ${icon('columns', 14)}
              <span>Roll-Up Board</span>
            </button>
            <button type="button" class="view-switch-btn ${mode === 'list' ? 'is-active' : ''}" data-switch-view="list" data-list-id="__folder__">
              ${icon('list', 14)}
              <span>List</span>
            </button>
          </div>
          <button type="button" class="icon-btn" id="btn-folder-options" data-folder-id="${esc(folder.id)}" title="Folder Options">
            ${icon('more', 17)}
          </button>
        `;
      }
    } else if (activeView.type === 'tag') {
      titleHtml = `${icon('hash', 18)} <span>${esc(activeView.id)}</span>`;
      subtitleHtml = 'Filtered across Inbox and all project pipelines';
    } else if (activeView.type === 'projects_hub') {
      titleHtml = `${icon('folder', 19)} <span>Projects & Folders</span>`;
      subtitleHtml = 'Tap a folder for Roll-Up or a project to open its board';
      rightControlsHtml = `
        <button type="button" class="btn btn-secondary" id="btn-hub-new-folder">${icon('folderPlus', 14)} <span>Folder</span></button>
        <button type="button" class="btn btn-primary" id="btn-hub-new-list">${icon('plus', 14)} <span>New List</span></button>
      `;
    } else if (activeView.type === 'tags_hub') {
      titleHtml = `${icon('hash', 19)} <span>Tags</span>`;
      subtitleHtml = 'Filter tasks across every workspace pipeline';
    }

    dom.workspaceHeaderLeft.innerHTML = `
      <button type="button" class="icon-btn desktop-collapse-btn" id="btn-toggle-desktop-sidebar" title="${sidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}">
        ${icon('sidebar', 17)}
      </button>
      <button type="button" class="icon-btn tablet-hamburger-btn" id="btn-toggle-tablet-sidebar" title="Open Navigation">
        ${icon('menu', 18)}
      </button>
      <div class="workspace-title-group">
        <h1 class="workspace-title">${titleHtml}</h1>
        ${subtitleHtml ? `<div class="workspace-subtitle">${subtitleHtml}</div>` : ''}
      </div>
    `;

    dom.workspaceHeaderRight.innerHTML = `<span id="header-sync-slot">${getSyncPillMarkup('is-header-sync')}</span>` + rightControlsHtml;
  }

  function renderCaptureZone(forceMount = false) {
    const state = Store.getState();
    const { activeView } = state.ui;
    const viewKey = `${activeView.type}:${activeView.id}`;

    if (activeView.type === 'projects_hub' || activeView.type === 'tags_hub') {
      dom.captureZone.innerHTML = '';
      dom.captureZone.style.display = 'none';
      uiLocal.lastRenderedViewKey = viewKey;
      return;
    }

    dom.captureZone.style.display = '';
    if (!forceMount && uiLocal.lastRenderedViewKey === viewKey && dom.captureZone.querySelector('#quick-capture-input')) {
      return;
    }
    uiLocal.lastRenderedViewKey = viewKey;

    const defaults = getCaptureDefaults();
    const targetList = Store.getListById(defaults.defaultListId);
    let placeholder = `Add a task to ${targetList.name}... (try #urgent, today, tomorrow, @Project)`;
    if (activeView.type === 'today') {
      placeholder = `Add a task to Today ☀️... (try #tag, tomorrow, @${ state.lists[0] ? state.lists[0].name : 'Project' })`;
    }

    dom.captureZone.innerHTML = `
      <form class="quick-capture-card" id="quick-capture-form" autocomplete="off">
        <div class="quick-capture-row">
          <span class="quick-capture-plus">${icon('plus', 15, 2.2)}</span>
          <input
            type="text"
            id="quick-capture-input"
            class="quick-capture-input"
            placeholder="${esc(placeholder)}"
            aria-label="Quick add task"
          />
          <button type="submit" class="quick-capture-submit">Add</button>
        </div>
        <div class="quick-capture-meta">
          <div class="nlp-tokens-preview" id="nlp-tokens-preview">
            <span style="font-size:11.5px; color:var(--text-subtle)">Smart syntax: <code>#tag</code> · <code>today</code> / <code>☀️</code> · <code>tomorrow</code> · <code>@List</code></span>
          </div>
          <div class="nlp-hint-chips">
            <button type="button" class="nlp-hint-btn" data-insert-token="☀️">☀️ Today</button>
            <button type="button" class="nlp-hint-btn" data-insert-token="tomorrow">Tomorrow</button>
            <button type="button" class="nlp-hint-btn" data-insert-token="#urgent">#urgent</button>
            ${
              activeView.type !== 'list' && state.lists.length > 0
                ? `<button type="button" class="nlp-hint-btn" data-insert-token="@&quot;${esc(state.lists[0].name)}&quot;">@${esc(state.lists[0].name)}</button>`
                : ''
            }
          </div>
        </div>
      </form>
    `;

    bindCaptureFormEvents(dom.captureZone.querySelector('#quick-capture-form'));
  }

  function bindCaptureFormEvents(formEl, onAfterSubmit = null) {
    if (!formEl) return;
    const inputEl = formEl.querySelector('.quick-capture-input');
    const previewEl = formEl.querySelector('.nlp-tokens-preview');

    const updatePreview = () => {
      const val = inputEl.value;
      if (!val.trim()) {
        previewEl.innerHTML = `<span style="font-size:11.5px; color:var(--text-subtle)">Smart syntax: <code>#tag</code> · <code>today</code> / <code>☀️</code> · <code>tomorrow</code> · <code>@List</code></span>`;
        return;
      }
      const state = Store.getState();
      const defaults = getCaptureDefaults();
      const parsed = ns.parseQuickCapture(val, {
        lists: state.lists,
        ...defaults
      });
      const targetList = Store.getListById(parsed.listId);

      const chips = [];
      chips.push(`<span class="nlp-token-pill">${icon('folder', 11)} ${esc(targetList.name)}</span>`);
      if (parsed.isInMyDay) {
        chips.push(`<span class="nlp-token-pill is-sun">☀️ Today</span>`);
      }
      if (parsed.dueDate) {
        const badge = ns.formatDueDateBadge(parsed.dueDate);
        chips.push(`<span class="nlp-token-pill">${icon('calendar', 11)} ${esc(badge ? badge.label : parsed.dueDate)}</span>`);
      }
      parsed.tags.forEach((t) => {
        chips.push(`<span class="nlp-token-pill">#${esc(t)}</span>`);
      });

      previewEl.innerHTML = chips.join('');
    };

    inputEl.addEventListener('input', updatePreview);

    formEl.querySelectorAll('[data-insert-token]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = btn.dataset.insertToken;
        const cur = inputEl.value;
        inputEl.value = cur && !cur.endsWith(' ') ? `${cur} ${token} ` : `${cur}${token} `;
        inputEl.focus();
        updatePreview();
      });
    });

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = inputEl.value.trim();
      if (!raw) return;

      const state = Store.getState();
      const defaults = getCaptureDefaults();
      const parsed = ns.parseQuickCapture(raw, {
        lists: state.lists,
        ...defaults
      });

      const created = Store.createTask({
        title: parsed.title,
        listId: parsed.listId,
        isInMyDay: parsed.isInMyDay,
        dueDate: parsed.dueDate,
        tags: parsed.tags
      });

      inputEl.value = '';
      updatePreview();

      if (created && parsed.matchedList && state.ui.activeView.type !== 'list' && parsed.listId !== 'inbox' && !parsed.isInMyDay) {
        showToast(`Added "${created.title}" to ${parsed.matchedList.name}`, {
          actionLabel: 'Open List',
          onAction: () => Store.setActiveView('list', parsed.listId)
        });
      }

      if (typeof onAfterSubmit === 'function') onAfterSubmit(created);
    });
  }

  /* ========================================================================
     Task Card Component (Shared across Kanban, Today, Inbox, Folder Roll-Up)
     ======================================================================== */
  function renderTaskCardHTML(task, options = {}) {
    const {
      draggable = false,
      showContextPill = false,
      showInboxMoveDropdown = false,
      showMobileStageSelect = false
    } = options;

    const state = Store.getState();
    const isSelected = state.ui.selectedTaskId === task.id;
    const blocker = Store.getActiveBlocker(task);
    const dueBadge = ns.formatDueDateBadge(task.dueDate);
    const list = Store.getListById(task.listId);
    const stage = Store.getStageForTask(task);

    const totalSubs = task.subtasks.length;
    const doneSubs = task.subtasks.filter((s) => s.isCompleted).length;
    const isSubsExpanded = (state.ui.expandedCardSubtasks || []).includes(task.id);

    const hasBadges =
      Boolean(blocker) ||
      showContextPill ||
      Boolean(dueBadge) ||
      totalSubs > 0 ||
      task.tags.length > 0;

    return `
      <article
        class="task-card ${task.isCompleted ? 'is-completed' : ''} ${isSelected ? 'is-selected' : ''}"
        data-task-id="${esc(task.id)}"
        ${draggable ? 'draggable="true"' : ''}
      >
        <div class="task-card-top">
          <button
            type="button"
            class="task-checkbox ${task.isCompleted ? 'is-checked' : ''} ${blocker && !task.isCompleted ? 'is-blocked' : ''}"
            data-action="toggle-complete"
            data-task-id="${esc(task.id)}"
            aria-label="${task.isCompleted ? 'Mark incomplete' : 'Mark complete'}"
            title="${blocker && !task.isCompleted ? `Blocked by: ${esc(blocker.title)}` : 'Toggle completed'}"
          >
            ${icon('check', 12, 2.6)}
          </button>

          <div class="task-title-text">${esc(task.title)}</div>

          <button
            type="button"
            class="sun-toggle-btn ${task.isInMyDay ? 'is-active' : ''}"
            data-action="toggle-myday"
            data-task-id="${esc(task.id)}"
            title="${task.isInMyDay ? 'Pinned to Today ☀️ (click to remove)' : 'Add to Today ☀️'}"
            aria-label="Toggle My Day"
          >
            ${icon(task.isInMyDay ? 'sunFilled' : 'sun', 15)}
          </button>
        </div>

        ${
          hasBadges
            ? `<div class="task-card-badges">
                ${
                  blocker
                    ? `<span class="pill-badge pill-blocker" title="Complete '${esc(blocker.title)}' to unblock">
                        ⚠️ Blocked by: ${esc(blocker.title)}
                      </span>`
                    : ''
                }
                ${
                  showContextPill
                    ? `<span class="pill-badge pill-context">
                        ${
                          list.id === 'inbox'
                            ? `[Inbox]`
                            : `[${esc(list.name)}: ${esc(stage ? stage.name : 'Open')}]`
                        }
                      </span>`
                    : ''
                }
                ${
                  dueBadge
                    ? `<span class="pill-badge pill-date ${
                        dueBadge.status === 'today'
                          ? 'is-today'
                          : dueBadge.status === 'overdue' && !task.isCompleted
                          ? 'is-overdue'
                          : ''
                      }">
                        ${icon('calendar', 11)}
                        <span>${esc(dueBadge.label)}</span>
                      </span>`
                    : ''
                }
                ${
                  totalSubs > 0
                    ? `<button
                        type="button"
                        class="pill-badge pill-subtasks ${isSubsExpanded ? 'is-expanded' : ''} ${doneSubs === totalSubs ? 'is-all-done' : ''}"
                        data-action="toggle-card-subtasks"
                        data-task-id="${esc(task.id)}"
                        title="Expand/collapse inline subtasks"
                      >
                        ${icon('subtasks', 11)}
                        <span>${doneSubs}/${totalSubs}</span>
                        ${icon(isSubsExpanded ? 'chevronDown' : 'chevronRight', 11)}
                      </button>`
                    : ''
                }
                ${task.tags
                  .map(
                    (tg) =>
                      `<button type="button" class="pill-badge pill-tag" data-action="filter-tag" data-tag="${esc(tg)}">#${esc(tg)}</button>`
                  )
                  .join('')}
              </div>`
            : ''
        }

        ${
          totalSubs > 0 && isSubsExpanded
            ? `<div class="card-inline-subtasks" data-stop-card-open="true">
                ${task.subtasks
                  .map(
                    (sub) => `
                      <label class="card-subtask-row ${sub.isCompleted ? 'is-done' : ''}" data-action="toggle-inline-subtask" data-task-id="${esc(task.id)}" data-sub-id="${esc(sub.id)}">
                        <span class="mini-check ${sub.isCompleted ? 'is-checked' : ''}">${icon('check', 10, 2.8)}</span>
                        <span>${esc(sub.title)}</span>
                      </label>
                    `
                  )
                  .join('')}
              </div>`
            : ''
        }

        ${
          showInboxMoveDropdown && state.lists.length > 0
            ? `<div class="card-quick-actions" data-stop-card-open="true">
                <select class="compact-select" data-action="quick-move-list" data-task-id="${esc(task.id)}" aria-label="Move task to project">
                  <option value="">📁 Move to Project...</option>
                  ${state.lists
                    .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`)
                    .join('')}
                </select>
              </div>`
            : ''
        }

        ${
          showMobileStageSelect && list.id !== 'inbox' && list.stages.length > 1
            ? `<div class="card-quick-actions mobile-stage-select-wrap" data-stop-card-open="true">
                <select class="compact-select" data-action="quick-change-stage" data-task-id="${esc(task.id)}" aria-label="Change stage">
                  ${list.stages
                    .map(
                      (st) =>
                        `<option value="${esc(st.id)}" ${st.id === task.stageId ? 'selected' : ''}>Stage: ${esc(st.name)}</option>`
                    )
                    .join('')}
                </select>
              </div>`
            : ''
        }
      </article>
    `;
  }

  /* ========================================================================
     Workspace Body Views
     ======================================================================== */
  function renderWorkspaceBody() {
    const state = Store.getState();
    const { activeView } = state.ui;

    if (activeView.type === 'list') {
      const list = state.lists.find((l) => l.id === activeView.id);
      if (!list) {
        Store.setActiveView('inbox', 'inbox');
        return;
      }
      if ((list.defaultView || 'kanban') === 'kanban') {
        dom.workspaceBody.className = 'workspace-body is-kanban-mode';
        renderProjectKanban(list);
      } else {
        dom.workspaceBody.className = 'workspace-body';
        renderProjectListView(list);
      }
      return;
    }

    if (activeView.type === 'folder') {
      const folder = state.folders.find((f) => f.id === activeView.id);
      if (!folder) {
        Store.setActiveView('today', 'today');
        return;
      }
      if ((state.ui.folderViewMode || 'kanban') === 'kanban') {
        dom.workspaceBody.className = 'workspace-body is-kanban-mode';
        renderFolderRollUpKanban(folder);
      } else {
        dom.workspaceBody.className = 'workspace-body';
        renderFolderRollUpList(folder);
      }
      return;
    }

    dom.workspaceBody.className = 'workspace-body';

    if (activeView.type === 'today') {
      renderTodayView();
    } else if (activeView.type === 'inbox') {
      renderInboxView();
    } else if (activeView.type === 'tag') {
      renderTagView(activeView.id);
    } else if (activeView.type === 'projects_hub') {
      renderMobileProjectsHub();
    } else if (activeView.type === 'tags_hub') {
      renderMobileTagsHub();
    }
  }

  function renderTodayView() {
    const state = Store.getState();
    const allToday = Store.getTodayTasks();
    const openTasks = allToday.filter((t) => !t.isCompleted);
    const doneTasks = allToday.filter((t) => t.isCompleted);

    dom.workspaceBody.innerHTML = `
      <div class="list-view-container">
        ${
          openTasks.length === 0 && doneTasks.length === 0
            ? `<div class="empty-state-box">
                <div class="empty-state-icon" style="background:var(--sun-soft); color:var(--sun-strong)">${icon('sunFilled', 22)}</div>
                <div class="empty-state-title">Your Today board is calm and clear</div>
                <div style="font-size:13px; max-width:360px; margin:0 auto 14px">
                  Pin tasks from any project with the ☀️ Sun icon, set a due date for today, or hand-pick tasks below.
                </div>
                <button type="button" class="btn btn-sun" id="btn-empty-myday-picker">
                  ${icon('sparkles', 15)} <span>Pick tasks for Today</span>
                </button>
              </div>`
            : `
              <div class="list-section">
                ${
                  openTasks.length === 0
                    ? `<div class="empty-state-box" style="padding:22px">
                        <div class="empty-state-title">🎉 Everything planned for today is complete!</div>
                        <div style="font-size:12.5px">Enjoy the momentum or pull another task from your projects.</div>
                      </div>`
                    : openTasks
                        .map((t) =>
                          renderTaskCardHTML(t, {
                            showContextPill: true,
                            showMobileStageSelect: true
                          })
                        )
                        .join('')
                }
              </div>

              ${
                doneTasks.length > 0
                  ? `<div class="list-section">
                      <div class="list-section-header">
                        <button type="button" class="list-section-title" data-action="toggle-completed-section">
                          ${icon(state.ui.showCompletedInLists ? 'chevronDown' : 'chevronRight', 14)}
                          <span>Completed Today (${doneTasks.length})</span>
                        </button>
                      </div>
                      ${
                        state.ui.showCompletedInLists
                          ? doneTasks
                              .map((t) => renderTaskCardHTML(t, { showContextPill: true }))
                              .join('')
                          : ''
                      }
                    </div>`
                  : ''
              }
            `
        }
      </div>
    `;
  }

  function renderInboxView() {
    const state = Store.getState();
    const inboxTasks = state.tasks.filter((t) => t.listId === 'inbox');
    const openTasks = inboxTasks.filter((t) => !t.isCompleted);
    const doneTasks = inboxTasks.filter((t) => t.isCompleted);

    dom.workspaceBody.innerHTML = `
      <div class="list-view-container">
        ${
          openTasks.length === 0 && doneTasks.length === 0
            ? `<div class="empty-state-box">
                <div class="empty-state-icon">${icon('inbox', 22)}</div>
                <div class="empty-state-title">Inbox Zero</div>
                <div style="font-size:13px; max-width:360px; margin:0 auto">
                  Capture thoughts above in seconds. Move them to a project pipeline or pin to Today ☀️ whenever you're ready.
                </div>
              </div>`
            : `
              <div class="list-section">
                ${openTasks
                  .map((t) =>
                    renderTaskCardHTML(t, {
                      showInboxMoveDropdown: true
                    })
                  )
                  .join('')}
              </div>
              ${
                doneTasks.length > 0
                  ? `<div class="list-section">
                      <div class="list-section-header">
                        <button type="button" class="list-section-title" data-action="toggle-completed-section">
                          ${icon(state.ui.showCompletedInLists ? 'chevronDown' : 'chevronRight', 14)}
                          <span>Completed (${doneTasks.length})</span>
                        </button>
                      </div>
                      ${
                        state.ui.showCompletedInLists
                          ? doneTasks.map((t) => renderTaskCardHTML(t)).join('')
                          : ''
                      }
                    </div>`
                  : ''
              }
            `
        }
      </div>
    `;
  }

  function renderProjectKanban(list) {
    const state = Store.getState();
    const listTasks = state.tasks.filter((t) => t.listId === list.id);

    dom.workspaceBody.innerHTML = `
      <!-- Mobile Stage Quick-Jump Strip (< 768px) -->
      <div class="kanban-mobile-dots" id="kanban-mobile-dots">
        ${list.stages
          .map((st, idx) => {
            const c = listTasks.filter((t) => t.stageId === st.id).length;
            return `<button type="button" class="kanban-stage-jump-pill ${idx === 0 ? 'is-active' : ''}" data-jump-col-idx="${idx}">
              ${esc(st.name)} (${c})
            </button>`;
          })
          .join('')}
      </div>

      <div class="kanban-board" id="kanban-board">
        ${list.stages
          .map((stage, idx) => {
            const cards = listTasks.filter((t) => t.stageId === stage.id);
            const isRenaming = uiLocal.renamingStageId === stage.id;
            const isAddingCard = uiLocal.addingTaskStageId === stage.id;

            return `
              <section
                class="kanban-column"
                data-stage-id="${esc(stage.id)}"
                data-list-id="${esc(list.id)}"
                data-col-idx="${idx}"
              >
                <header class="kanban-column-header">
                  <div class="kanban-column-title-wrap">
                    <span class="stage-backbone-dot is-${esc(stage.category)}" title="Backbone state: ${esc(stage.category.toUpperCase())}"></span>
                    ${
                      isRenaming
                        ? `<input type="text" class="kanban-rename-input" id="kanban-rename-input" data-list-id="${esc(list.id)}" data-stage-id="${esc(stage.id)}" value="${esc(stage.name)}" />`
                        : `<span class="kanban-column-title" data-dblclick-rename="${esc(stage.id)}" title="Double-click to rename stage">${esc(stage.name)}</span>`
                    }
                    <span class="kanban-column-count">${cards.length}</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:4px">
                    <span class="stage-category-tag">${esc(stage.category)}</span>
                    <button type="button" class="icon-btn is-sm" data-action="stage-menu" data-list-id="${esc(list.id)}" data-stage-id="${esc(stage.id)}" title="Stage options">
                      ${icon('more', 14)}
                    </button>
                  </div>
                </header>

                <div class="kanban-column-cards" data-drop-zone="stage" data-stage-id="${esc(stage.id)}">
                  ${
                    cards.length === 0
                      ? `<div class="kanban-empty-drop">Drop tasks here</div>`
                      : cards
                          .map((task) =>
                            renderTaskCardHTML(task, {
                              draggable: true,
                              showMobileStageSelect: true
                            })
                          )
                          .join('')
                  }
                </div>

                <footer class="kanban-column-footer">
                  ${
                    isAddingCard
                      ? `<form class="kanban-inline-add-form" data-inline-stage-form="${esc(stage.id)}" data-list-id="${esc(list.id)}">
                          <input type="text" class="kanban-inline-add-input" placeholder="Task title (#tag, tomorrow)..." required />
                          <div style="display:flex; justify-content:flex-end; gap:6px">
                            <button type="button" class="btn btn-secondary" style="height:27px; font-size:12px" data-action="cancel-inline-card">Cancel</button>
                            <button type="submit" class="btn btn-primary" style="height:27px; font-size:12px">Add</button>
                          </div>
                        </form>`
                      : `<button type="button" class="kanban-quick-add-btn" data-action="open-inline-card" data-stage-id="${esc(stage.id)}">
                          ${icon('plus', 14)}
                          <span>Add task</span>
                        </button>`
                  }
                </footer>
              </section>
            `;
          })
          .join('')}

        <!-- Add Custom Stage Column -->
        <div class="kanban-add-column-card">
          ${
            uiLocal.addingColumnOpen
              ? `<form id="add-stage-form" data-list-id="${esc(list.id)}" style="display:flex; flex-direction:column; gap:10px">
                  <div style="font-size:12.5px; font-weight:600; color:var(--text-primary)">New Pipeline Stage</div>
                  <input type="text" id="new-stage-name-input" class="form-input" style="height:34px" placeholder="e.g., QA Review" required />
                  <div class="form-field" style="gap:4px">
                    <label style="font-size:11.5px; color:var(--text-muted); font-weight:500">3-State Backbone Mapping</label>
                    <select id="new-stage-category-select" class="detail-select">
                      <option value="open" ${uiLocal.newColumnCategory === 'open' ? 'selected' : ''}>Open (Not started)</option>
                      <option value="active" ${uiLocal.newColumnCategory === 'active' ? 'selected' : ''}>Active (In progress)</option>
                      <option value="done" ${uiLocal.newColumnCategory === 'done' ? 'selected' : ''}>Done (Auto-completes task)</option>
                    </select>
                  </div>
                  <div style="display:flex; justify-content:flex-end; gap:6px">
                    <button type="button" class="btn btn-secondary" style="height:30px" data-action="cancel-add-stage">Cancel</button>
                    <button type="submit" class="btn btn-primary" style="height:30px">Create Stage</button>
                  </div>
                </form>`
              : `<button type="button" class="kanban-add-column-trigger" data-action="open-add-stage">
                  ${icon('plus', 15)}
                  <span>Add Stage</span>
                </button>`
          }
        </div>
      </div>
    `;

    setupKanbanInteractions();
  }

  function renderProjectListView(list) {
    const state = Store.getState();
    const listTasks = state.tasks.filter((t) => t.listId === list.id);

    dom.workspaceBody.innerHTML = `
      <div class="list-view-container">
        ${list.stages
          .map((stage) => {
            const cards = listTasks.filter((t) => t.stageId === stage.id);
            return `
              <div class="list-section">
                <div class="list-section-header">
                  <div class="list-section-title">
                    <span class="stage-backbone-dot is-${esc(stage.category)}"></span>
                    <span>${esc(stage.name)}</span>
                    <span style="color:var(--text-subtle); font-weight:500">(${cards.length})</span>
                  </div>
                </div>
                ${
                  cards.length === 0
                    ? `<div style="padding:8px 12px; font-size:12.5px; color:var(--text-subtle); border:1px dashed var(--border-subtle); border-radius:var(--radius-card)">No tasks in ${esc(stage.name)}</div>`
                    : cards
                        .map((t) =>
                          renderTaskCardHTML(t, {
                            showMobileStageSelect: true
                          })
                        )
                        .join('')
                }
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  /* ------------------------------------------------------------------------
     Folder Roll-Up View (3 Master Backbone Columns: Open -> Active -> Done)
     ------------------------------------------------------------------------ */
  function renderFolderRollUpKanban(folder) {
    const state = Store.getState();
    const childLists = state.lists.filter((l) => l.folderId === folder.id);
    const childIds = new Set(childLists.map((l) => l.id));
    const folderTasks = state.tasks.filter((t) => childIds.has(t.listId));

    const masterColumns = [
      { category: 'open', name: 'Open' },
      { category: 'active', name: 'Active' },
      { category: 'done', name: 'Done' }
    ];

    dom.workspaceBody.innerHTML = `
      <div class="kanban-mobile-dots" id="kanban-mobile-dots">
        ${masterColumns
          .map((mc, idx) => {
            const c = folderTasks.filter((t) => {
              const st = Store.getStageForTask(t);
              return (st ? st.category : 'open') === mc.category;
            }).length;
            return `<button type="button" class="kanban-stage-jump-pill ${idx === 0 ? 'is-active' : ''}" data-jump-col-idx="${idx}">
              ${mc.name} (${c})
            </button>`;
          })
          .join('')}
      </div>

      <div class="kanban-board" id="kanban-board">
        ${masterColumns
          .map((mc, idx) => {
            const cards = folderTasks.filter((t) => {
              const st = Store.getStageForTask(t);
              return (st ? st.category : 'open') === mc.category;
            });
            return `
              <section
                class="kanban-column"
                data-backbone-category="${mc.category}"
                data-col-idx="${idx}"
              >
                <header class="kanban-column-header">
                  <div class="kanban-column-title-wrap">
                    <span class="stage-backbone-dot is-${mc.category}"></span>
                    <span class="kanban-column-title" style="cursor:default">${mc.name}</span>
                    <span class="kanban-column-count">${cards.length}</span>
                  </div>
                  <span class="stage-category-tag">Roll-up</span>
                </header>
                <div class="kanban-column-cards" data-drop-zone="backbone" data-backbone-category="${mc.category}">
                  ${
                    cards.length === 0
                      ? `<div class="kanban-empty-drop">Drop tasks to move to ${mc.name}</div>`
                      : cards
                          .map((task) =>
                            renderTaskCardHTML(task, {
                              draggable: true,
                              showContextPill: true,
                              showMobileStageSelect: true
                            })
                          )
                          .join('')
                  }
                </div>
              </section>
            `;
          })
          .join('')}
      </div>
    `;

    setupKanbanInteractions();
  }

  function renderFolderRollUpList(folder) {
    const state = Store.getState();
    const childLists = state.lists.filter((l) => l.folderId === folder.id);
    const childIds = new Set(childLists.map((l) => l.id));
    const folderTasks = state.tasks.filter((t) => childIds.has(t.listId));

    const masterColumns = [
      { category: 'open', name: 'Open' },
      { category: 'active', name: 'Active' },
      { category: 'done', name: 'Done' }
    ];

    dom.workspaceBody.innerHTML = `
      <div class="list-view-container">
        ${masterColumns
          .map((mc) => {
            const cards = folderTasks.filter((t) => {
              const st = Store.getStageForTask(t);
              return (st ? st.category : 'open') === mc.category;
            });
            return `
              <div class="list-section">
                <div class="list-section-header">
                  <div class="list-section-title">
                    <span class="stage-backbone-dot is-${mc.category}"></span>
                    <span>${mc.name}</span>
                    <span style="color:var(--text-subtle); font-weight:500">(${cards.length})</span>
                  </div>
                </div>
                ${
                  cards.length === 0
                    ? `<div style="padding:8px 12px; font-size:12.5px; color:var(--text-subtle); border:1px dashed var(--border-subtle); border-radius:var(--radius-card)">No tasks in ${mc.name}</div>`
                    : cards.map((t) => renderTaskCardHTML(t, { showContextPill: true })).join('')
                }
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  function renderTagView(tag) {
    const state = Store.getState();
    const matching = state.tasks.filter((t) => t.tags.includes(tag));
    const openTasks = matching.filter((t) => !t.isCompleted);
    const doneTasks = matching.filter((t) => t.isCompleted);

    dom.workspaceBody.innerHTML = `
      <div class="list-view-container">
        ${
          matching.length === 0
            ? `<div class="empty-state-box">
                <div class="empty-state-icon">${icon('hash', 20)}</div>
                <div class="empty-state-title">No tasks tagged #${esc(tag)}</div>
              </div>`
            : `
              <div class="list-section">
                ${openTasks.map((t) => renderTaskCardHTML(t, { showContextPill: true })).join('')}
              </div>
              ${
                doneTasks.length > 0
                  ? `<div class="list-section">
                      <div class="list-section-header">
                        <span class="list-section-title">Completed (${doneTasks.length})</span>
                      </div>
                      ${doneTasks.map((t) => renderTaskCardHTML(t, { showContextPill: true })).join('')}
                    </div>`
                  : ''
              }
            `
        }
      </div>
    `;
  }

  /* Mobile Directory Hubs (< 768px) */
  function renderMobileProjectsHub() {
    const state = Store.getState();
    const rootLists = state.lists.filter((l) => !l.folderId);
    const countOpen = (listId) => state.tasks.filter((t) => t.listId === listId && !t.isCompleted).length;

    dom.workspaceBody.innerHTML = `
      <div class="mobile-hub-grid">
        ${state.folders
          .map((folder) => {
            const children = state.lists.filter((l) => l.folderId === folder.id);
            return `
              <div class="hub-card">
                <button type="button" class="hub-card-row" style="background:var(--bg-tonal-subtle); font-weight:600" data-nav-type="folder" data-nav-id="${esc(folder.id)}">
                  <span style="display:flex; align-items:center; gap:9px">
                    ${icon('folder', 17)}
                    <span>${esc(folder.name)}</span>
                  </span>
                  <span style="font-size:11.5px; color:var(--accent); font-weight:600">Roll-Up →</span>
                </button>
                ${children
                  .map(
                    (lst) => `
                      <button type="button" class="hub-card-row" data-nav-type="list" data-nav-id="${esc(lst.id)}">
                        <span style="display:flex; align-items:center; gap:10px">
                          <span class="list-color-dot" style="background:${esc(lst.color)}"></span>
                          <span>${esc(lst.name)}</span>
                        </span>
                        <span style="font-size:12px; color:var(--text-muted)">${countOpen(lst.id)} open</span>
                      </button>
                    `
                  )
                  .join('')}
              </div>
            `;
          })
          .join('')}

        ${
          rootLists.length > 0
            ? `<div class="hub-card">
                ${rootLists
                  .map(
                    (lst) => `
                      <button type="button" class="hub-card-row" data-nav-type="list" data-nav-id="${esc(lst.id)}">
                        <span style="display:flex; align-items:center; gap:10px">
                          <span class="list-color-dot" style="background:${esc(lst.color)}"></span>
                          <span>${esc(lst.name)}</span>
                        </span>
                        <span style="font-size:12px; color:var(--text-muted)">${countOpen(lst.id)} open</span>
                      </button>
                    `
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>
    `;
  }

  function renderMobileTagsHub() {
    const tags = Store.getAllTagsWithCounts();
    dom.workspaceBody.innerHTML = `
      <div class="mobile-hub-grid">
        ${
          tags.length === 0
            ? `<div class="empty-state-box">
                <div class="empty-state-title">No tags yet</div>
                <div style="font-size:13px">Include <code>#tagname</code> when creating any task.</div>
              </div>`
            : `<div class="hub-card">
                ${tags
                  .map(
                    ({ tag, open, total }) => `
                      <button type="button" class="hub-card-row" data-nav-type="tag" data-nav-id="${esc(tag)}">
                        <span style="display:flex; align-items:center; gap:8px; font-weight:500">
                          ${icon('hash', 16)}
                          <span>${esc(tag)}</span>
                        </span>
                        <span style="font-size:12px; color:var(--text-muted)">${open} active · ${total} total</span>
                      </button>
                    `
                  )
                  .join('')}
              </div>`
        }
      </div>
    `;
  }

  /* ========================================================================
     Clean Task Detail Drawer (Desktop 380px Split / Mobile Bottom Sheet)
     ======================================================================== */
  let currentDetailTaskId = null;

  function renderDetailDrawer(forceFull = false) {
    const state = Store.getState();
    const taskId = state.ui.selectedTaskId;
    const task = taskId ? Store.getTaskById(taskId) : null;

    const isOpen = Boolean(task);
    dom.detailPane.classList.toggle('is-open', isOpen);
    dom.detailScrim.classList.toggle('is-visible', isOpen && window.innerWidth <= 1024);

    if (!task) {
      currentDetailTaskId = null;
      return;
    }

    // Avoid clobbering active typing cursor inside Title / Notes / Subtask input
    const activeEl = document.activeElement;
    if (
      !forceFull &&
      currentDetailTaskId === task.id &&
      activeEl &&
      dom.detailInner.contains(activeEl) &&
      (activeEl.matches('.detail-title-input') ||
        activeEl.matches('.detail-notes-textarea') ||
        activeEl.matches('.detail-subtask-title-input') ||
        activeEl.matches('.detail-tag-input'))
    ) {
      return;
    }

    currentDetailTaskId = task.id;
    const list = Store.getListById(task.listId);
    const blocker = Store.getActiveBlocker(task);
    const allLists = [ns.INBOX_LIST, ...state.lists];
    const candidateBlockers = state.tasks.filter((t) => t.id !== task.id && (!t.isCompleted || t.id === task.blockedByTaskId));

    const createdLabel = new Date(task.createdAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    dom.detailInner.innerHTML = `
      <div class="detail-header" id="detail-sheet-drag-header">
        <button
          type="button"
          class="btn btn-sun ${task.isInMyDay ? 'is-active' : ''}"
          data-action="toggle-myday"
          data-task-id="${esc(task.id)}"
        >
          ${icon(task.isInMyDay ? 'sunFilled' : 'sun', 15)}
          <span>${task.isInMyDay ? 'Added to My Day ☀️' : 'Add to My Day ☀️'}</span>
        </button>

        <button type="button" class="icon-btn" id="btn-close-detail" title="Close panel (Esc)">
          ${icon('x', 18)}
        </button>
      </div>

      <div class="detail-body">
        <!-- Title + Checkbox -->
        <div class="detail-title-row">
          <button
            type="button"
            class="task-checkbox ${task.isCompleted ? 'is-checked' : ''} ${blocker && !task.isCompleted ? 'is-blocked' : ''}"
            style="width:22px; height:22px; min-width:22px; margin-top:4px"
            data-action="toggle-complete"
            data-task-id="${esc(task.id)}"
          >
            ${icon('check', 14, 2.6)}
          </button>
          <textarea
            rows="2"
            class="detail-title-input"
            id="detail-title-input"
            aria-label="Task title"
          >${esc(task.title)}</textarea>
        </div>

        ${
          blocker
            ? `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; border-radius:var(--radius-card); background:var(--danger-soft); border:1px solid var(--danger-border); color:var(--danger-strong); font-size:12.5px; font-weight:500">
                <span>⚠️ Blocked by: <strong>${esc(blocker.title)}</strong></span>
                <button type="button" class="toast-action-btn" style="background:#FFE4E6; color:var(--danger-strong)" data-open-blocker="${esc(blocker.id)}">Open</button>
              </div>`
            : ''
        }

        <!-- Pipeline, Stage, Due Date & Blocker Controls -->
        <div class="detail-grid">
          <div class="detail-field-row">
            <span class="detail-field-label">${icon('folder', 14)} <span>List</span></span>
            <select class="detail-select" id="detail-list-select">
              ${allLists
                .map(
                  (l) =>
                    `<option value="${esc(l.id)}" ${l.id === list.id ? 'selected' : ''}>${esc(l.name)}</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="detail-field-row">
            <span class="detail-field-label">${icon('columns', 14)} <span>Stage</span></span>
            <select class="detail-select" id="detail-stage-select">
              ${list.stages
                .map(
                  (st) =>
                    `<option value="${esc(st.id)}" ${st.id === task.stageId ? 'selected' : ''}>${esc(st.name)} (${st.category})</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="detail-field-row">
            <span class="detail-field-label">${icon('calendar', 14)} <span>Due Date</span></span>
            <input
              type="date"
              class="detail-date-input"
              id="detail-duedate-input"
              value="${esc(task.dueDate || '')}"
            />
          </div>
          <div class="date-quick-chips">
            <button type="button" class="nlp-hint-btn" data-quick-date="${ns.getTodayISO()}">Today</button>
            <button type="button" class="nlp-hint-btn" data-quick-date="${ns.getOffsetDateISO(1)}">Tomorrow</button>
            <button type="button" class="nlp-hint-btn" data-quick-date="${ns.getOffsetDateISO(7)}">+1 Week</button>
            ${task.dueDate ? `<button type="button" class="nlp-hint-btn" data-quick-date="">Clear</button>` : ''}
          </div>

          <div class="detail-field-row">
            <span class="detail-field-label">${icon('alert', 14)} <span>Blocked By</span></span>
            <select class="detail-select ${blocker ? 'is-blocked-active' : ''}" id="detail-blocker-select">
              <option value="">None (Unblocked)</option>
              ${candidateBlockers
                .map((other) => {
                  const oList = Store.getListById(other.listId);
                  return `<option value="${esc(other.id)}" ${other.id === task.blockedByTaskId ? 'selected' : ''}>
                    ${other.isCompleted ? '✓ ' : ''}${esc(other.title)} (${esc(oList.name)})
                  </option>`;
                })
                .join('')}
            </select>
          </div>
        </div>

        <!-- Subtask Checklist Builder -->
        <div class="detail-block">
          <div class="detail-block-label">
            <span>Subtasks ${task.subtasks.length > 0 ? `(${task.subtasks.filter((s) => s.isCompleted).length}/${task.subtasks.length})` : ''}</span>
          </div>
          <div class="detail-subtask-list">
            ${task.subtasks
              .map(
                (sub) => `
                  <div class="detail-subtask-item">
                    <button type="button" class="mini-check ${sub.isCompleted ? 'is-checked' : ''}" data-detail-sub-toggle="${esc(sub.id)}">
                      ${icon('check', 10, 2.8)}
                    </button>
                    <input
                      type="text"
                      class="detail-subtask-title-input ${sub.isCompleted ? 'is-done' : ''}"
                      data-detail-sub-input="${esc(sub.id)}"
                      value="${esc(sub.title)}"
                    />
                    <button type="button" class="icon-btn is-sm" data-detail-sub-del="${esc(sub.id)}" title="Remove subtask">
                      ${icon('x', 13)}
                    </button>
                  </div>
                `
              )
              .join('')}
          </div>
          <form class="detail-subtask-add" id="detail-add-subtask-form">
            ${icon('plus', 14)}
            <input type="text" id="detail-new-subtask-input" placeholder="Add a subtask..." />
          </form>
        </div>

        <!-- Tag Chips -->
        <div class="detail-block">
          <div class="detail-block-label"><span>Tags</span></div>
          <div class="detail-tags-box">
            ${task.tags
              .map(
                (tg) => `
                  <span class="detail-tag-chip">
                    <span>#${esc(tg)}</span>
                    <button type="button" class="detail-tag-remove" data-remove-tag="${esc(tg)}" aria-label="Remove tag">
                      ${icon('x', 11)}
                    </button>
                  </span>
                `
              )
              .join('')}
            <form id="detail-add-tag-form" style="display:inline-flex">
              <input type="text" class="detail-tag-input" id="detail-new-tag-input" placeholder="+ Add #tag" />
            </form>
          </div>
        </div>

        <!-- Clean Notes Scratchpad -->
        <div class="detail-block">
          <div class="detail-block-label"><span>Notes</span></div>
          <textarea
            class="detail-notes-textarea"
            id="detail-notes-textarea"
            placeholder="Jot down context, links, or scratchpad notes..."
          >${esc(task.notes)}</textarea>
        </div>
      </div>

      <div class="detail-footer">
        <span>Created ${esc(createdLabel)}</span>
        <button type="button" class="btn-danger-ghost" id="btn-delete-task" style="display:inline-flex; align-items:center; gap:5px">
          ${icon('trash', 14)}
          <span>Delete</span>
        </button>
      </div>
    `;

    bindDetailDrawerEvents(task.id);
  }

  function bindDetailDrawerEvents(taskId) {
    const closeBtn = dom.detailInner.querySelector('#btn-close-detail');
    if (closeBtn) closeBtn.addEventListener('click', () => Store.selectTask(null));

    const openBlockerBtn = dom.detailInner.querySelector('[data-open-blocker]');
    if (openBlockerBtn) {
      openBlockerBtn.addEventListener('click', () => {
        Store.selectTask(openBlockerBtn.dataset.openBlocker);
      });
    }

    const titleInput = dom.detailInner.querySelector('#detail-title-input');
    if (titleInput) {
      const autoResize = () => {
        titleInput.style.height = 'auto';
        titleInput.style.height = `${titleInput.scrollHeight}px`;
      };
      autoResize();
      titleInput.addEventListener('input', () => {
        autoResize();
        Store.updateTaskFields(taskId, { title: titleInput.value });
      });
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleInput.blur();
        }
      });
    }

    const listSelect = dom.detailInner.querySelector('#detail-list-select');
    if (listSelect) {
      listSelect.addEventListener('change', () => {
        Store.moveTaskToList(taskId, listSelect.value);
        renderDetailDrawer(true);
      });
    }

    const stageSelect = dom.detailInner.querySelector('#detail-stage-select');
    if (stageSelect) {
      stageSelect.addEventListener('change', () => {
        const res = Store.moveTaskToStage(taskId, stageSelect.value);
        if (!res.ok && res.reason === 'blocked') {
          notifyBlockedTask(res.task, res.blocker);
        }
        renderDetailDrawer(true);
      });
    }

    const dueInput = dom.detailInner.querySelector('#detail-duedate-input');
    if (dueInput) {
      dueInput.addEventListener('change', () => {
        Store.updateTaskFields(taskId, { dueDate: dueInput.value || null });
        renderDetailDrawer(true);
      });
    }

    dom.detailInner.querySelectorAll('[data-quick-date]').forEach((btn) => {
      btn.addEventListener('click', () => {
        Store.updateTaskFields(taskId, { dueDate: btn.dataset.quickDate || null });
        renderDetailDrawer(true);
      });
    });

    const blockerSelect = dom.detailInner.querySelector('#detail-blocker-select');
    if (blockerSelect) {
      blockerSelect.addEventListener('change', () => {
        Store.updateTaskFields(taskId, { blockedByTaskId: blockerSelect.value || null });
        renderDetailDrawer(true);
      });
    }

    // Subtask controls
    dom.detailInner.querySelectorAll('[data-detail-sub-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        Store.toggleSubtask(taskId, btn.dataset.detailSubToggle);
        renderDetailDrawer(true);
      });
    });

    dom.detailInner.querySelectorAll('[data-detail-sub-input]').forEach((inp) => {
      inp.addEventListener('change', () => {
        Store.updateSubtaskTitle(taskId, inp.dataset.detailSubInput, inp.value);
      });
    });

    dom.detailInner.querySelectorAll('[data-detail-sub-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        Store.deleteSubtask(taskId, btn.dataset.detailSubDel);
        renderDetailDrawer(true);
      });
    });

    const addSubForm = dom.detailInner.querySelector('#detail-add-subtask-form');
    if (addSubForm) {
      addSubForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = addSubForm.querySelector('#detail-new-subtask-input');
        if (inp.value.trim()) {
          Store.addSubtask(taskId, inp.value.trim());
          renderDetailDrawer(true);
          const nextInp = dom.detailInner.querySelector('#detail-new-subtask-input');
          if (nextInp) nextInp.focus();
        }
      });
    }

    // Tags
    dom.detailInner.querySelectorAll('[data-remove-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        Store.removeTagFromTask(taskId, btn.dataset.removeTag);
        renderDetailDrawer(true);
      });
    });

    const addTagForm = dom.detailInner.querySelector('#detail-add-tag-form');
    const tagInput = dom.detailInner.querySelector('#detail-new-tag-input');
    if (addTagForm && tagInput) {
      const commitTag = () => {
        if (tagInput.value.trim()) {
          Store.addTagToTask(taskId, tagInput.value);
          renderDetailDrawer(true);
          const next = dom.detailInner.querySelector('#detail-new-tag-input');
          if (next) next.focus();
        }
      };
      addTagForm.addEventListener('submit', (e) => {
        e.preventDefault();
        commitTag();
      });
      tagInput.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === ',') {
          e.preventDefault();
          commitTag();
        }
      });
    }

    // Notes Scratchpad
    const notesEl = dom.detailInner.querySelector('#detail-notes-textarea');
    if (notesEl) {
      notesEl.addEventListener('input', () => {
        Store.updateTaskFields(taskId, { notes: notesEl.value });
      });
    }

    // Delete Task with Undo Toast
    const delBtn = dom.detailInner.querySelector('#btn-delete-task');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        const deleted = Store.deleteTask(taskId);
        if (deleted) {
          showToast(`Deleted "${deleted.title}"`, {
            actionLabel: 'Undo',
            onAction: () => Store.restoreDeletedTask(deleted)
          });
        }
      });
    }
  }

  /* ========================================================================
     Modals:
     1. Create Project List (with 1-click Built-in & Custom Pipeline Presets)
     2. Create Folder
     3. Save Current Board Stages as Custom Preset
     4. "Add to My Day" Quick-Picker
     5. Mobile FAB Quick-Capture Sheet
     ======================================================================== */
  function closeModal() {
    uiLocal.activeModal = null;
    uiLocal.modalContext = {};
    dom.modalMount.innerHTML = '';
  }

  function openModal(name, context = {}) {
    uiLocal.activeModal = name;
    uiLocal.modalContext = context;
    renderModal();
  }

  function renderModal() {
    const state = Store.getState();
    const modal = uiLocal.activeModal;
    if (!modal) {
      dom.modalMount.innerHTML = '';
      return;
    }

    if (modal === 'new_list') {
      const presets = Store.getAllPresets();
      const selectedPresetId = uiLocal.modalContext.presetId || presets[0].id;
      const selectedFolderId = uiLocal.modalContext.folderId || '';
      const selectedColor = uiLocal.modalContext.color || ns.LIST_COLORS[state.lists.length % ns.LIST_COLORS.length];

      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true">
          <form class="modal-card" id="modal-new-list-form" autocomplete="off">
            <div class="modal-header">
              <h2 class="modal-title">New Project List</h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body">
              <div class="form-field">
                <label class="form-label" for="new-list-name">Project Name</label>
                <input type="text" id="new-list-name" class="form-input" placeholder="e.g., Q4 Brand Campaign" value="${esc(uiLocal.modalContext.draftName || '')}" required />
              </div>

              <div style="display:grid; grid-template-columns: 1fr auto; gap:12px; align-items:end">
                <div class="form-field">
                  <label class="form-label" for="new-list-folder">Folder (Optional)</label>
                  <select id="new-list-folder" class="form-input">
                    <option value="">No Folder (Root Level)</option>
                    ${state.folders
                      .map(
                        (f) => `<option value="${esc(f.id)}" ${f.id === selectedFolderId ? 'selected' : ''}>${esc(f.name)}</option>`
                      )
                      .join('')}
                  </select>
                </div>

                <div class="form-field">
                  <label class="form-label">Accent</label>
                  <div style="display:flex; gap:6px; height:38px; align-items:center">
                    ${ns.LIST_COLORS.map(
                      (c) => `
                        <button
                          type="button"
                          data-pick-color="${c}"
                          style="width:20px; height:20px; border-radius:50%; background:${c}; border:${c === selectedColor ? '2.5px solid #0F172A' : '2px solid transparent'}"
                          aria-label="Pick color"
                        ></button>
                      `
                    ).join('')}
                  </div>
                </div>
              </div>

              <div class="form-field">
                <label class="form-label">1-Click Pipeline Stage Preset</label>
                <div style="display:flex; flex-direction:column; gap:8px">
                  ${presets
                    .map(
                      (p) => `
                        <div class="preset-option-card ${p.id === selectedPresetId ? 'is-selected' : ''}" data-pick-preset="${esc(p.id)}">
                          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px">
                            <span style="font-weight:600; font-size:13.5px; color:var(--text-primary)">${esc(p.name)}</span>
                            ${
                              !p.isBuiltIn
                                ? `<button type="button" class="icon-btn is-sm" data-delete-preset="${esc(p.id)}" title="Delete custom preset">${icon('trash', 13)}</button>`
                                : ''
                            }
                          </div>
                          <div class="preset-stage-flow">
                            ${p.stages
                              .map(
                                (st, i) => `
                                  <span class="preset-stage-chip">
                                    <span class="stage-backbone-dot is-${esc(st.category)}" style="width:7px;height:7px"></span>
                                    <span>${esc(st.name)}</span>
                                  </span>
                                  ${i < p.stages.length - 1 ? `<span style="color:var(--text-subtle); font-size:11px">→</span>` : ''}
                                `
                              )
                              .join('')}
                          </div>
                        </div>
                      `
                    )
                    .join('')}
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-modal-close="true">Cancel</button>
              <button type="submit" class="btn btn-primary">Create Project</button>
            </div>
          </form>
        </div>
      `;

      const nameInput = dom.modalMount.querySelector('#new-list-name');
      const folderSel = dom.modalMount.querySelector('#new-list-folder');
      if (nameInput && !uiLocal.modalContext.keepBlur) nameInput.focus();

      dom.modalMount.querySelectorAll('[data-pick-preset]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-delete-preset]')) return;
          uiLocal.modalContext.draftName = nameInput.value;
          uiLocal.modalContext.folderId = folderSel.value;
          uiLocal.modalContext.presetId = el.dataset.pickPreset;
          uiLocal.modalContext.keepBlur = true;
          renderModal();
        });
      });

      dom.modalMount.querySelectorAll('[data-delete-preset]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          Store.deleteCustomPreset(btn.dataset.deletePreset);
          uiLocal.modalContext.presetId = 'preset_standard';
          renderModal();
        });
      });

      dom.modalMount.querySelectorAll('[data-pick-color]').forEach((btn) => {
        btn.addEventListener('click', () => {
          uiLocal.modalContext.draftName = nameInput.value;
          uiLocal.modalContext.folderId = folderSel.value;
          uiLocal.modalContext.color = btn.dataset.pickColor;
          uiLocal.modalContext.keepBlur = true;
          renderModal();
        });
      });

      dom.modalMount.querySelector('#modal-new-list-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const created = Store.createList({
          name: nameInput.value,
          folderId: folderSel.value || null,
          presetId: selectedPresetId,
          color: selectedColor
        });
        closeModal();
        if (created) showToast(`Created project "${created.name}"`);
      });
    } else if (modal === 'new_folder') {
      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true">
          <form class="modal-card" style="max-width:400px" id="modal-new-folder-form" autocomplete="off">
            <div class="modal-header">
              <h2 class="modal-title">New Folder</h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body">
              <div class="form-field">
                <label class="form-label" for="new-folder-name">Folder Name</label>
                <input type="text" id="new-folder-name" class="form-input" placeholder="e.g., Client Work" required />
              </div>
              <div style="font-size:12.5px; color:var(--text-muted)">
                Folders group related project lists and unlock a unified 3-column <strong>Open → Active → Done</strong> Roll-Up view.
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-modal-close="true">Cancel</button>
              <button type="submit" class="btn btn-primary">Create Folder</button>
            </div>
          </form>
        </div>
      `;
      const inp = dom.modalMount.querySelector('#new-folder-name');
      if (inp) inp.focus();
      dom.modalMount.querySelector('#modal-new-folder-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = Store.createFolder(inp.value);
        closeModal();
        if (f) showToast(`Created folder "${f.name}"`);
      });
    } else if (modal === 'save_preset') {
      const list = state.lists.find((l) => l.id === uiLocal.modalContext.listId);
      if (!list) {
        closeModal();
        return;
      }
      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true">
          <form class="modal-card" style="max-width:430px" id="modal-save-preset-form" autocomplete="off">
            <div class="modal-header">
              <h2 class="modal-title">Save Pipeline Preset</h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body">
              <div class="form-field">
                <label class="form-label" for="preset-name-input">Preset Name</label>
                <input type="text" id="preset-name-input" class="form-input" placeholder="e.g., Engineering Sprint Flow" value="${esc(list.name)} Template" required />
              </div>
              <div class="preset-stage-flow">
                ${list.stages
                  .map(
                    (st, i) => `
                      <span class="preset-stage-chip">
                        <span class="stage-backbone-dot is-${esc(st.category)}" style="width:7px;height:7px"></span>
                        <span>${esc(st.name)}</span>
                      </span>
                      ${i < list.stages.length - 1 ? `<span style="color:var(--text-subtle); font-size:11px">→</span>` : ''}
                    `
                  )
                  .join('')}
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-modal-close="true">Cancel</button>
              <button type="submit" class="btn btn-primary">Save Preset</button>
            </div>
          </form>
        </div>
      `;
      const inp = dom.modalMount.querySelector('#preset-name-input');
      if (inp) {
        inp.focus();
        inp.select();
      }
      dom.modalMount.querySelector('#modal-save-preset-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const saved = Store.saveListStagesAsPreset(list.id, inp.value);
        closeModal();
        if (saved) showToast(`Saved preset "${saved.name}" for future lists!`);
      });
    } else if (modal === 'rename_entity') {
      const { kind, id, currentName } = uiLocal.modalContext;
      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true">
          <form class="modal-card" style="max-width:400px" id="modal-rename-entity-form" autocomplete="off">
            <div class="modal-header">
              <h2 class="modal-title">Rename ${kind === 'folder' ? 'Folder' : 'Project List'}</h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body">
              <div class="form-field">
                <label class="form-label" for="rename-entity-input">Name</label>
                <input type="text" id="rename-entity-input" class="form-input" value="${esc(currentName)}" required />
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-modal-close="true">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      `;
      const inp = dom.modalMount.querySelector('#rename-entity-input');
      if (inp) {
        inp.focus();
        inp.select();
      }
      dom.modalMount.querySelector('#modal-rename-entity-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const next = inp.value.trim();
        if (next) {
          if (kind === 'folder') Store.renameFolder(id, next);
          else Store.renameList(id, next);
        }
        closeModal();
      });
    } else if (modal === 'my_day_picker') {
      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true">
          <div class="modal-card">
            <div class="modal-header">
              <h2 class="modal-title" style="display:flex; align-items:center; gap:8px">
                <span style="color:var(--sun)">${icon('sunFilled', 18)}</span>
                <span>Add Tasks to My Day</span>
              </h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body" style="gap:12px">
              <input
                type="text"
                id="myday-picker-search"
                class="form-input"
                placeholder="Search uncompleted tasks across all projects..."
                value="${esc(uiLocal.myDaySearch)}"
              />
              <div id="myday-picker-results" style="display:flex; flex-direction:column; gap:7px; max-height:340px; overflow-y:auto"></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-primary" data-modal-close="true">Done</button>
            </div>
          </div>
        </div>
      `;

      const resultsEl = dom.modalMount.querySelector('#myday-picker-results');
      const renderPickerItems = () => {
        const curState = Store.getState();
        const todayISO = ns.getTodayISO();
        const query = (uiLocal.myDaySearch || '').toLowerCase().trim();
        const candidates = curState.tasks.filter(
          (t) =>
            !t.isCompleted &&
            !t.isInMyDay &&
            t.dueDate !== todayISO &&
            (!query || t.title.toLowerCase().includes(query))
        );

        resultsEl.innerHTML =
          candidates.length === 0
            ? `<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px">
                All open tasks are already in Today or match no filter!
              </div>`
            : candidates
                .map((t) => {
                  const lst = Store.getListById(t.listId);
                  const stg = Store.getStageForTask(t);
                  return `
                    <div class="picker-item-row">
                      <div style="min-width:0; flex:1">
                        <div style="font-size:13.5px; font-weight:500; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(t.title)}</div>
                        <div style="font-size:11.5px; color:var(--text-muted)">${esc(lst.name)}${lst.id !== 'inbox' && stg ? ` · ${esc(stg.name)}` : ''}</div>
                      </div>
                      <button type="button" class="btn btn-sun" style="height:30px; padding:0 10px" data-pick-myday="${esc(t.id)}">
                        ☀️ Add
                      </button>
                    </div>
                  `;
                })
                .join('');

        resultsEl.querySelectorAll('[data-pick-myday]').forEach((btn) => {
          btn.addEventListener('click', () => {
            Store.toggleMyDay(btn.dataset.pickMyday, true);
            renderPickerItems();
          });
        });
      };

      renderPickerItems();

      const searchInp = dom.modalMount.querySelector('#myday-picker-search');
      if (searchInp) {
        searchInp.focus();
        searchInp.addEventListener('input', () => {
          uiLocal.myDaySearch = searchInp.value;
          renderPickerItems();
        });
      }
    } else if (modal === 'cloud_sync') {
      const st = ns.CloudSync.getStatus();
      const lastSyncStr = st.lastSyncedAt
        ? new Date(st.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'Never';

      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true">
          <div class="modal-card">
            <div class="modal-header">
              <h2 class="modal-title" style="display:flex; align-items:center; gap:8px">
                ${icon(st.isConnected ? 'cloudCheck' : 'cloud', 18)}
                <span>GitHub Cross-Device Sync</span>
              </h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body">
              ${
                st.isConnected
                  ? `
                    <div style="padding:12px 14px; border-radius:var(--radius-card); background:var(--state-done-soft); border:1px solid var(--state-done-border); color:#065F46; font-size:13px; display:flex; flex-direction:column; gap:4px">
                      <div style="font-weight:600">âœ“ Connected to @${esc(st.username)}'s Private GitHub Gist</div>
                      <div style="font-size:12px; opacity:0.9">Last synced: ${esc(lastSyncStr)} Â· Gist ID: <code>${esc(st.gistId.slice(0, 10))}...</code></div>
                    </div>

                    <div style="font-size:13px; color:var(--text-secondary); line-height:1.5">
                      To sync your phone or tablet: open your bookmarked Flow URL on that device, tap <strong>Sync</strong>, and paste the same GitHub token â€” Flow will automatically discover this workspace!
                    </div>

                    <div style="display:flex; flex-wrap:wrap; gap:8px">
                      <button type="button" class="btn btn-primary" id="btn-sync-now">${icon('refresh', 14)} <span>Sync Now</span></button>
                      <button type="button" class="btn btn-secondary" id="btn-copy-gist-id">${icon('copy', 14)} <span>Copy Gist ID</span></button>
                      <button type="button" class="btn btn-secondary" style="color:var(--danger)" id="btn-disconnect-sync">Disconnect Device</button>
                    </div>
                  `
                  : `
                    <div style="font-size:13px; color:var(--text-secondary); line-height:1.5">
                      Sync your projects and tasks across your PC, phone, and tablet for <strong>free</strong> using a secret GitHub Gist in your own account. Your token stays strictly on your device.
                    </div>

                    <a
                      href="https://github.com/settings/tokens/new?description=Flow%20Cloud%20Sync&scopes=gist"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="btn btn-secondary"
                      style="justify-content:center; text-decoration:none"
                    >
                      ${icon('external', 14)}
                      <span>1. Generate GitHub Token ('gist' scope pre-selected)</span>
                    </a>

                    <form id="cloud-sync-connect-form" style="display:flex; flex-direction:column; gap:12px" autocomplete="off">
                      <div class="form-field">
                        <label class="form-label" for="sync-token-input">2. Paste GitHub Personal Access Token</label>
                        <input type="password" id="sync-token-input" class="form-input" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" required />
                      </div>
                      <div class="form-field">
                        <label class="form-label" for="sync-gist-input">Existing Gist ID (Optional â€” auto-detected if blank)</label>
                        <input type="text" id="sync-gist-input" class="form-input" placeholder="Leave blank to auto-find or create private Gist" />
                      </div>
                      <div id="sync-connect-error" style="display:none; font-size:12.5px; color:var(--danger); font-weight:500"></div>
                      <button type="submit" class="btn btn-primary" id="btn-connect-sync-submit" style="height:38px">
                        ${icon('cloudCheck', 15)}
                        <span>Connect &amp; Sync Across Devices</span>
                      </button>
                    </form>
                  `
              }

              <div style="border-top:1px solid var(--border-subtle); padding-top:12px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px">
                <span style="font-size:12px; color:var(--text-muted)">Offline File Backup</span>
                <div style="display:flex; gap:6px">
                  <button type="button" class="btn btn-secondary" style="height:30px; font-size:12px" id="btn-export-json">${icon('download', 13)} <span>Export JSON</span></button>
                  <label class="btn btn-secondary" style="height:30px; font-size:12px; cursor:pointer">
                    ${icon('upload', 13)} <span>Import JSON</span>
                    <input type="file" id="input-import-json" accept="application/json,.json" style="display:none" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      const connectForm = dom.modalMount.querySelector('#cloud-sync-connect-form');
      if (connectForm) {
        const tokInp = connectForm.querySelector('#sync-token-input');
        const gistInp = connectForm.querySelector('#sync-gist-input');
        const errBox = connectForm.querySelector('#sync-connect-error');
        const subBtn = connectForm.querySelector('#btn-connect-sync-submit');
        if (tokInp) tokInp.focus();

        connectForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          subBtn.disabled = true;
          subBtn.textContent = 'Connecting to GitHub...';
          errBox.style.display = 'none';
          const res = await ns.CloudSync.connect({
            token: tokInp.value,
            gistId: gistInp.value
          });
          if (!res.ok) {
            subBtn.disabled = false;
            subBtn.textContent = 'Connect & Sync Across Devices';
            errBox.textContent = 'âš ï¸ ' + res.error;
            errBox.style.display = 'block';
          } else {
            showToast(res.createdNew ? `â˜ï¸ Created private sync Gist for @${res.username}!` : `â˜ï¸ Linked & synced with @${res.username}'s workspace!`);
            renderModal();
          }
        });
      }

      const syncNowBtn = dom.modalMount.querySelector('#btn-sync-now');
      if (syncNowBtn) {
        syncNowBtn.addEventListener('click', async () => {
          syncNowBtn.disabled = true;
          const res = await ns.CloudSync.syncNow();
          syncNowBtn.disabled = false;
          if (res.ok) {
            showToast('â˜ï¸ Workspace synced with GitHub');
            renderModal();
          } else {
            showToast('âš ï¸ ' + (res.error || 'Sync failed'), { variant: 'warning' });
          }
        });
      }

      const copyGistBtn = dom.modalMount.querySelector('#btn-copy-gist-id');
      if (copyGistBtn) {
        copyGistBtn.addEventListener('click', () => {
          if (navigator.clipboard && st.gistId) {
            navigator.clipboard.writeText(st.gistId);
            showToast('Copied Gist ID to clipboard');
          }
        });
      }

      const discBtn = dom.modalMount.querySelector('#btn-disconnect-sync');
      if (discBtn) {
        discBtn.addEventListener('click', () => {
          ns.CloudSync.disconnect();
          showToast('Disconnected cloud sync on this device');
          renderModal();
        });
      }

      const expBtn = dom.modalMount.querySelector('#btn-export-json');
      if (expBtn) {
        expBtn.addEventListener('click', () => {
          const blob = new Blob([JSON.stringify(Store.getExportablePayload(), null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `flow-backup-${ns.getTodayISO()}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }

      const impInput = dom.modalMount.querySelector('#input-import-json');
      if (impInput) {
        impInput.addEventListener('change', (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const data = JSON.parse(String(reader.result));
              data.updatedAt = Date.now();
              Store.replaceStateFromCloud(data);
              closeModal();
              showToast('Imported workspace backup');
            } catch (_) {
              showToast('Invalid Flow backup JSON file', { variant: 'warning' });
            }
          };
          reader.readAsText(file);
        });
      }
    } else if (modal === 'mobile_capture') {
      dom.modalMount.innerHTML = `
        <div class="modal-backdrop" data-modal-dismiss="true" style="align-items:flex-end; padding:0">
          <div class="modal-card" style="max-width:100%; border-radius:20px 20px 0 0; padding-bottom:env(safe-area-inset-bottom, 0px)">
            <div class="modal-header" style="padding:14px 16px">
              <h2 class="modal-title">Quick Capture</h2>
              <button type="button" class="icon-btn" data-modal-close="true">${icon('x', 18)}</button>
            </div>
            <div class="modal-body" style="padding:14px 16px 20px">
              <form class="quick-capture-card" id="mobile-modal-capture-form" autocomplete="off">
                <div class="quick-capture-row">
                  <span class="quick-capture-plus">${icon('plus', 15, 2.2)}</span>
                  <input type="text" class="quick-capture-input" placeholder="What needs to get done?" required />
                  <button type="submit" class="quick-capture-submit">Save</button>
                </div>
                <div class="quick-capture-meta">
                  <div class="nlp-tokens-preview"></div>
                  <div class="nlp-hint-chips">
                    <button type="button" class="nlp-hint-btn" data-insert-token="☀️">☀️ Today</button>
                    <button type="button" class="nlp-hint-btn" data-insert-token="tomorrow">Tomorrow</button>
                    <button type="button" class="nlp-hint-btn" data-insert-token="#urgent">#urgent</button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      `;
      const mForm = dom.modalMount.querySelector('#mobile-modal-capture-form');
      bindCaptureFormEvents(mForm, () => closeModal());
      const mInput = mForm.querySelector('.quick-capture-input');
      if (mInput) mInput.focus();
    }

    dom.modalMount.querySelectorAll('[data-modal-close]').forEach((b) => {
      b.addEventListener('click', closeModal);
    });
    const backdrop = dom.modalMount.querySelector('[data-modal-dismiss]');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal();
      });
    }
  }

  /* ========================================================================
     Kanban Interactions:
     - Inline Column Header Rename (Double-Click)
     - Inline Column Add Task / Add Stage
     - Desktop HTML5 Drag-and-Drop + Vertical Reordering
     - Touch Long-Press Drag-and-Drop + Edge Auto-Scroll + Scroll-Snap Sync
     ======================================================================== */
  function setupKanbanInteractions() {
    const board = dom.workspaceBody.querySelector('#kanban-board');
    if (!board) return;

    // Focus active inline rename input if open
    const renameInp = board.querySelector('#kanban-rename-input');
    if (renameInp) {
      renameInp.focus();
      renameInp.select();
      const commit = () => {
        const val = renameInp.value.trim();
        const listId = renameInp.dataset.listId;
        const stageId = renameInp.dataset.stageId;
        uiLocal.renamingStageId = null;
        if (val) Store.renameStage(listId, stageId, val);
        else renderWorkspaceBody();
      };
      renameInp.addEventListener('blur', commit);
      renameInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          renameInp.blur();
        } else if (e.key === 'Escape') {
          uiLocal.renamingStageId = null;
          renderWorkspaceBody();
        }
      });
    }

    // Focus inline add-task input if open
    const inlineCardForm = board.querySelector('[data-inline-stage-form]');
    if (inlineCardForm) {
      const inp = inlineCardForm.querySelector('input');
      if (inp) inp.focus();
      inlineCardForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = inp.value.trim();
        if (!raw) return;
        const listId = inlineCardForm.dataset.listId;
        const stageId = inlineCardForm.dataset.inlineStageForm;
        const parsed = ns.parseQuickCapture(raw, {
          lists: Store.getState().lists,
          defaultListId: listId
        });
        Store.createTask({
          title: parsed.title,
          listId,
          stageId,
          isInMyDay: parsed.isInMyDay,
          dueDate: parsed.dueDate,
          tags: parsed.tags
        });
        inp.value = '';
        const nextForm = dom.workspaceBody.querySelector(`[data-inline-stage-form="${CSS.escape(stageId)}"] input`);
        if (nextForm) nextForm.focus();
      });
    }

    // Focus add-stage form if open
    const addStageForm = board.querySelector('#add-stage-form');
    if (addStageForm) {
      const nameInp = addStageForm.querySelector('#new-stage-name-input');
      const catSel = addStageForm.querySelector('#new-stage-category-select');
      if (nameInp) nameInp.focus();
      addStageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const listId = addStageForm.dataset.listId;
        uiLocal.addingColumnOpen = false;
        Store.addStage(listId, nameInp.value, catSel.value);
      });
    }

    // Sync Mobile Stage Jump Pills with Scroll-Snap
    const dotsWrap = dom.workspaceBody.querySelector('#kanban-mobile-dots');
    if (dotsWrap) {
      dotsWrap.querySelectorAll('[data-jump-col-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.jumpColIdx);
          const col = board.querySelector(`.kanban-column[data-col-idx="${idx}"]`);
          if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        });
      });

      board.addEventListener(
        'scroll',
        () => {
          const cols = Array.from(board.querySelectorAll('.kanban-column'));
          if (!cols.length) return;
          const center = board.scrollLeft + board.clientWidth / 2;
          let activeIdx = 0;
          let bestDist = Infinity;
          cols.forEach((c, i) => {
            const colCenter = c.offsetLeft + c.offsetWidth / 2;
            const dist = Math.abs(center - colCenter);
            if (dist < bestDist) {
              bestDist = dist;
              activeIdx = i;
            }
          });
          dotsWrap.querySelectorAll('[data-jump-col-idx]').forEach((b, i) => {
            b.classList.toggle('is-active', i === activeIdx);
          });
        },
        { passive: true }
      );
    }

    // --- Desktop HTML5 Drag-and-Drop ---
    let draggedTaskId = null;

    board.querySelectorAll('.task-card[draggable="true"]').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        draggedTaskId = card.dataset.taskId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedTaskId);
        requestAnimationFrame(() => card.classList.add('is-dragging'));
      });

      card.addEventListener('dragend', () => {
        draggedTaskId = null;
        card.classList.remove('is-dragging');
        board.querySelectorAll('.kanban-column.is-drag-over').forEach((c) => c.classList.remove('is-drag-over'));
      });
    });

    board.querySelectorAll('.kanban-column').forEach((col) => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('is-drag-over');
      });

      col.addEventListener('dragleave', (e) => {
        if (!col.contains(e.relatedTarget)) {
          col.classList.remove('is-drag-over');
        }
      });

      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('is-drag-over');
        const taskId = draggedTaskId || e.dataTransfer.getData('text/plain');
        if (!taskId) return;

        // Find card directly under cursor for clean vertical placement
        let beforeTaskId = null;
        const cardsInCol = Array.from(col.querySelectorAll('.task-card'));
        for (const candidate of cardsInCol) {
          if (candidate.dataset.taskId === taskId) continue;
          const rect = candidate.getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) {
            beforeTaskId = candidate.dataset.taskId;
            break;
          }
        }

        executeColumnDrop(col, taskId, beforeTaskId);
      });
    });

    // --- Touch Long-Press Drag-and-Drop Fallback for Mobile/Tablet ---
    setupTouchKanbanDrag(board);
  }

  function executeColumnDrop(colEl, taskId, beforeTaskId = null) {
    if (!colEl || !taskId) return;
    if (colEl.dataset.stageId) {
      const res = Store.moveTaskToStage(taskId, colEl.dataset.stageId, beforeTaskId);
      if (!res.ok && res.reason === 'blocked') {
        notifyBlockedTask(res.task, res.blocker);
      }
    } else if (colEl.dataset.backboneCategory) {
      const res = Store.moveTaskToBackboneCategory(taskId, colEl.dataset.backboneCategory, beforeTaskId);
      if (!res.ok && res.reason === 'blocked') {
        notifyBlockedTask(res.task, res.blocker);
      } else if (!res.ok && res.reason === 'no_active_stage') {
        showToast(`"${res.list.name}" only has Open and Done stages.`);
      }
    }
  }

  function setupTouchKanbanDrag(board) {
    let holdTimer = null;
    let activeDrag = null;

    board.querySelectorAll('.task-card[draggable="true"]').forEach((card) => {
      card.addEventListener(
        'touchstart',
        (e) => {
          if (e.touches.length !== 1) return;
          if (e.target.closest('button, select, input, label')) return;

          const touch = e.touches[0];
          const startX = touch.clientX;
          const startY = touch.clientY;
          const rect = card.getBoundingClientRect();

          holdTimer = setTimeout(() => {
            const ghost = card.cloneNode(true);
            ghost.classList.add('task-card-touch-ghost');
            ghost.style.width = `${rect.width}px`;
            ghost.style.left = `${rect.left}px`;
            ghost.style.top = `${rect.top}px`;
            document.body.appendChild(ghost);
            card.classList.add('is-dragging');

            activeDrag = {
              taskId: card.dataset.taskId,
              card,
              ghost,
              offsetX: startX - rect.left,
              offsetY: startY - rect.top,
              hoveredCol: null
            };
          }, 240);

          const cancelIfMovedEarly = (moveEvt) => {
            if (activeDrag) return;
            const t = moveEvt.touches[0];
            if (Math.hypot(t.clientX - startX, t.clientY - startY) > 10) {
              clearTimeout(holdTimer);
              holdTimer = null;
            }
          };

          card.addEventListener('touchmove', cancelIfMovedEarly, { passive: true, once: false });
          card.addEventListener(
            'touchend',
            () => {
              clearTimeout(holdTimer);
              card.removeEventListener('touchmove', cancelIfMovedEarly);
            },
            { once: true }
          );
        },
        { passive: true }
      );
    });

    board.addEventListener(
      'touchmove',
      (e) => {
        if (!activeDrag) return;
        e.preventDefault();
        const touch = e.touches[0];
        activeDrag.ghost.style.left = `${touch.clientX - activeDrag.offsetX}px`;
        activeDrag.ghost.style.top = `${touch.clientY - activeDrag.offsetY}px`;

        // Auto-scroll horizontal Kanban board near viewport edges
        if (touch.clientX > window.innerWidth - 48) {
          board.scrollLeft += 14;
        } else if (touch.clientX < 48) {
          board.scrollLeft -= 14;
        }

        const elUnder = document.elementFromPoint(touch.clientX, touch.clientY);
        const col = elUnder ? elUnder.closest('.kanban-column') : null;
        board.querySelectorAll('.kanban-column.is-drag-over').forEach((c) => {
          if (c !== col) c.classList.remove('is-drag-over');
        });
        if (col) col.classList.add('is-drag-over');
        activeDrag.hoveredCol = col;
      },
      { passive: false }
    );

    const finishTouchDrag = () => {
      clearTimeout(holdTimer);
      if (!activeDrag) return;
      const { taskId, card, ghost, hoveredCol } = activeDrag;
      activeDrag = null;
      ghost.remove();
      card.classList.remove('is-dragging');
      board.querySelectorAll('.kanban-column.is-drag-over').forEach((c) => c.classList.remove('is-drag-over'));
      if (hoveredCol) {
        executeColumnDrop(hoveredCol, taskId, null);
      }
    };

    board.addEventListener('touchend', finishTouchDrag);
    board.addEventListener('touchcancel', finishTouchDrag);
  }

  /* ========================================================================
     Mobile Bottom Sheet Swipe-Down-to-Dismiss Gesture
     ======================================================================== */
  function setupBottomSheetSwipe() {
    let startY = 0;
    let deltaY = 0;
    let tracking = false;

    dom.detailPane.addEventListener(
      'touchstart',
      (e) => {
        if (window.innerWidth >= 768) return;
        const onHandle = e.target.closest('.bottom-sheet-handle-bar, .detail-header');
        const detailBody = dom.detailPane.querySelector('.detail-body');
        const atTopOfScroll = detailBody && detailBody.scrollTop <= 0;
        if (!onHandle && !atTopOfScroll) return;

        startY = e.touches[0].clientY;
        deltaY = 0;
        tracking = true;
      },
      { passive: true }
    );

    dom.detailPane.addEventListener(
      'touchmove',
      (e) => {
        if (!tracking || window.innerWidth >= 768) return;
        const curY = e.touches[0].clientY;
        const diff = curY - startY;
        if (diff > 4) {
          deltaY = diff;
          dom.detailPane.classList.add('is-dragging-sheet');
          dom.detailPane.style.transform = `translateY(${deltaY}px)`;
        }
      },
      { passive: true }
    );

    const endSwipe = () => {
      if (!tracking) return;
      tracking = false;
      dom.detailPane.classList.remove('is-dragging-sheet');
      dom.detailPane.style.transform = '';
      if (deltaY > 80) {
        Store.selectTask(null);
      }
      deltaY = 0;
    };

    dom.detailPane.addEventListener('touchend', endSwipe);
    dom.detailPane.addEventListener('touchcancel', endSwipe);
  }

  /* ========================================================================
     Global Delegated Event Listeners
     ======================================================================== */
  function bindGlobalEvents() {
    // Close dropdown popover on outside click
    document.addEventListener('click', (e) => {
      if (uiLocal.dropdown && !e.target.closest('.dropdown-menu')) {
        closeDropdown();
      }
    });

    // Sidebar navigation & actions
    dom.sidebar.addEventListener('click', (e) => {
      const folderToggle = e.target.closest('[data-toggle-folder]');
      if (folderToggle) {
        e.stopPropagation();
        Store.toggleFolderExpanded(folderToggle.dataset.toggleFolder);
        return;
      }

      const navBtn = e.target.closest('[data-nav-type]');
      if (navBtn) {
        uiLocal.tabletSidebarOpen = false;
        uiLocal.addingColumnOpen = false;
        uiLocal.addingTaskStageId = null;
        Store.setActiveView(navBtn.dataset.navType, navBtn.dataset.navId);
        return;
      }

      if (e.target.closest('#btn-sidebar-new-list, #btn-footer-new-list')) {
        openModal('new_list');
      } else if (e.target.closest('#btn-sidebar-new-folder')) {
        openModal('new_folder');
      } else if (e.target.closest('#btn-sidebar-sync')) {
        openModal('cloud_sync');
      } else if (e.target.closest('#btn-install-pwa')) {
        if (deferredInstallPrompt) {
          deferredInstallPrompt.prompt();
          deferredInstallPrompt.userChoice.finally(() => {
            deferredInstallPrompt = null;
            const b = document.getElementById('btn-install-pwa');
            if (b) b.style.display = 'none';
          });
        }
      } else if (e.target.closest('#btn-reset-demo')) {
        if (window.confirm('Clear all tasks, projects, and folders in this workspace?')) {
          Store.resetDemoData();
          showToast('Workspace cleared');
        }
      }
    });

    dom.sidebarScrim.addEventListener('click', () => {
      uiLocal.tabletSidebarOpen = false;
      renderSidebar();
    });

    dom.detailScrim.addEventListener('click', () => {
      Store.selectTask(null);
    });

    // Mobile Bottom Nav & FAB
    dom.mobileNav.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mobile-tab]');
      if (!tab) return;
      Store.selectTask(null);
      Store.setActiveView(tab.dataset.mobileTab, tab.dataset.mobileTab);
    });

    dom.mobileFab.addEventListener('click', () => {
      openModal('mobile_capture');
    });

    // Workspace Header Controls
    document.getElementById('workspace-header').addEventListener('click', (e) => {
      if (e.target.closest('[data-open-sync]')) {
        openModal('cloud_sync');
        return;
      }
      if (e.target.closest('#btn-toggle-desktop-sidebar')) {
        Store.toggleSidebarCollapsed();
        return;
      }
      if (e.target.closest('#btn-toggle-tablet-sidebar')) {
        uiLocal.tabletSidebarOpen = !uiLocal.tabletSidebarOpen;
        renderSidebar();
        return;
      }
      if (e.target.closest('#btn-open-myday-picker')) {
        uiLocal.myDaySearch = '';
        openModal('my_day_picker');
        return;
      }
      if (e.target.closest('#btn-hub-new-list')) {
        openModal('new_list');
        return;
      }
      if (e.target.closest('#btn-hub-new-folder')) {
        openModal('new_folder');
        return;
      }

      const viewSwitch = e.target.closest('[data-switch-view]');
      if (viewSwitch) {
        Store.setListViewMode(viewSwitch.dataset.listId, viewSwitch.dataset.switchView);
        return;
      }

      const listOptBtn = e.target.closest('#btn-list-options');
      if (listOptBtn) {
        e.stopPropagation();
        const listId = listOptBtn.dataset.listId;
        const list = Store.getListById(listId);
        openDropdown(listOptBtn.getBoundingClientRect(), [
          {
            label: 'Save stages as preset',
            icon: 'bookmark',
            onClick: () => openModal('save_preset', { listId })
          },
          {
            label: 'Add pipeline stage',
            icon: 'plus',
            onClick: () => {
              Store.setListViewMode(listId, 'kanban');
              uiLocal.addingColumnOpen = true;
              renderWorkspaceBody();
            }
          },
          {
            label: 'Rename project',
            icon: 'edit',
            onClick: () => openModal('rename_entity', { kind: 'list', id: listId, currentName: list.name })
          },
          { divider: true },
          {
            label: 'Delete project',
            icon: 'trash',
            danger: true,
            onClick: () => {
              Store.deleteList(listId);
              showToast(`Deleted project "${list.name}" (tasks moved safely to Inbox)`);
            }
          }
        ]);
        return;
      }

      const folderOptBtn = e.target.closest('#btn-folder-options');
      if (folderOptBtn) {
        e.stopPropagation();
        const folderId = folderOptBtn.dataset.folderId;
        const folder = Store.getState().folders.find((f) => f.id === folderId);
        if (!folder) return;
        openDropdown(folderOptBtn.getBoundingClientRect(), [
          {
            label: 'New project in folder',
            icon: 'plus',
            onClick: () => openModal('new_list', { folderId })
          },
          {
            label: 'Rename folder',
            icon: 'edit',
            onClick: () => openModal('rename_entity', { kind: 'folder', id: folderId, currentName: folder.name })
          },
          { divider: true },
          {
            label: 'Delete folder',
            icon: 'trash',
            danger: true,
            onClick: () => {
              Store.deleteFolder(folderId);
              showToast(`Deleted folder "${folder.name}"`);
            }
          }
        ]);
      }
    });

    // Workspace Body Delegated Events (Cards, Checkboxes, Sun, Subtasks, Stage Menus)
    dom.workspaceBody.addEventListener('dblclick', (e) => {
      const colTitle = e.target.closest('[data-dblclick-rename]');
      if (colTitle) {
        uiLocal.renamingStageId = colTitle.dataset.dblclickRename;
        renderWorkspaceBody();
      }
    });

    dom.workspaceBody.addEventListener('change', (e) => {
      const moveSelect = e.target.closest('[data-action="quick-move-list"]');
      if (moveSelect && moveSelect.value) {
        const res = Store.moveTaskToList(moveSelect.dataset.taskId, moveSelect.value);
        if (res.ok) {
          showToast(`Moved to ${res.list.name}`, {
            actionLabel: 'Open',
            onAction: () => Store.setActiveView('list', res.list.id)
          });
        }
        return;
      }

      const stageSelect = e.target.closest('[data-action="quick-change-stage"]');
      if (stageSelect && stageSelect.value) {
        const res = Store.moveTaskToStage(stageSelect.dataset.taskId, stageSelect.value);
        if (!res.ok && res.reason === 'blocked') {
          notifyBlockedTask(res.task, res.blocker);
          renderWorkspaceBody();
        }
      }
    });

    dom.workspaceBody.addEventListener('click', (e) => {
      // Mobile hub navigation
      const hubNav = e.target.closest('[data-nav-type]');
      if (hubNav) {
        Store.setActiveView(hubNav.dataset.navType, hubNav.dataset.navId);
        return;
      }

      if (e.target.closest('#btn-empty-myday-picker')) {
        uiLocal.myDaySearch = '';
        openModal('my_day_picker');
        return;
      }

      // Toggle Completed section visibility
      if (e.target.closest('[data-action="toggle-completed-section"]')) {
        Store.toggleShowCompletedInLists();
        return;
      }

      // Task checkbox toggle
      const checkBtn = e.target.closest('[data-action="toggle-complete"]');
      if (checkBtn) {
        e.stopPropagation();
        const res = Store.toggleTaskCompleted(checkBtn.dataset.taskId);
        if (!res.ok && res.reason === 'blocked') {
          notifyBlockedTask(res.task, res.blocker);
        }
        return;
      }

      // My Day Sun toggle
      const sunBtn = e.target.closest('[data-action="toggle-myday"]');
      if (sunBtn) {
        e.stopPropagation();
        const active = Store.toggleMyDay(sunBtn.dataset.taskId);
        showToast(active ? '☀️ Pinned to Today' : 'Removed from Today');
        return;
      }

      // Expand/collapse inline subtasks on card face
      const subBadgeBtn = e.target.closest('[data-action="toggle-card-subtasks"]');
      if (subBadgeBtn) {
        e.stopPropagation();
        Store.toggleCardSubtasksExpanded(subBadgeBtn.dataset.taskId);
        return;
      }

      // Check/uncheck inline subtask directly on card face
      const inlineSubRow = e.target.closest('[data-action="toggle-inline-subtask"]');
      if (inlineSubRow) {
        e.preventDefault();
        e.stopPropagation();
        Store.toggleSubtask(inlineSubRow.dataset.taskId, inlineSubRow.dataset.subId);
        return;
      }

      // Filter by #tag pill click
      const tagPill = e.target.closest('[data-action="filter-tag"]');
      if (tagPill) {
        e.stopPropagation();
        Store.setActiveView('tag', tagPill.dataset.tag);
        return;
      }

      // Kanban Stage Column Menu
      const stageMenuBtn = e.target.closest('[data-action="stage-menu"]');
      if (stageMenuBtn) {
        e.stopPropagation();
        const { listId, stageId } = stageMenuBtn.dataset;
        const list = Store.getListById(listId);
        const stageIdx = list.stages.findIndex((s) => s.id === stageId);
        const stage = list.stages[stageIdx];
        if (!stage) return;

        openDropdown(stageMenuBtn.getBoundingClientRect(), [
          {
            label: 'Rename stage',
            icon: 'edit',
            onClick: () => {
              uiLocal.renamingStageId = stageId;
              renderWorkspaceBody();
            }
          },
          { divider: true },
          {
            label: `${stage.category === 'open' ? '✓ ' : ''}Map to Open`,
            onClick: () => {
              const r = Store.changeStageCategory(listId, stageId, 'open');
              if (!r.ok) showToast('Every pipeline needs at least one Open and one Done stage.', { variant: 'warning' });
            }
          },
          {
            label: `${stage.category === 'active' ? '✓ ' : ''}Map to Active`,
            onClick: () => {
              const r = Store.changeStageCategory(listId, stageId, 'active');
              if (!r.ok) showToast('Every pipeline needs at least one Open and one Done stage.', { variant: 'warning' });
            }
          },
          {
            label: `${stage.category === 'done' ? '✓ ' : ''}Map to Done`,
            onClick: () => {
              const r = Store.changeStageCategory(listId, stageId, 'done');
              if (!r.ok) showToast('Every pipeline needs at least one Open and one Done stage.', { variant: 'warning' });
            }
          },
          { divider: true },
          ...(stageIdx > 0
            ? [
                {
                  label: 'Move column left',
                  icon: 'arrowLeft',
                  onClick: () => Store.reorderStage(listId, stageId, 'left')
                }
              ]
            : []),
          ...(stageIdx < list.stages.length - 1
            ? [
                {
                  label: 'Move column right',
                  icon: 'arrowRight',
                  onClick: () => Store.reorderStage(listId, stageId, 'right')
                }
              ]
            : []),
          {
            label: 'Delete stage',
            icon: 'trash',
            danger: true,
            onClick: () => {
              const r = Store.deleteStage(listId, stageId);
              if (!r.ok) {
                showToast('Cannot delete the only Open or Done stage in a pipeline.', { variant: 'warning' });
              } else if (r.movedCount > 0) {
                showToast(`Deleted "${stage.name}" (${r.movedCount} tasks moved to ${r.fallbackStage.name})`);
              }
            }
          }
        ]);
        return;
      }

      // Kanban inline add card / stage triggers
      const openInlineCard = e.target.closest('[data-action="open-inline-card"]');
      if (openInlineCard) {
        uiLocal.addingTaskStageId = openInlineCard.dataset.stageId;
        renderWorkspaceBody();
        return;
      }
      if (e.target.closest('[data-action="cancel-inline-card"]')) {
        uiLocal.addingTaskStageId = null;
        renderWorkspaceBody();
        return;
      }
      if (e.target.closest('[data-action="open-add-stage"]')) {
        uiLocal.addingColumnOpen = true;
        renderWorkspaceBody();
        return;
      }
      if (e.target.closest('[data-action="cancel-add-stage"]')) {
        uiLocal.addingColumnOpen = false;
        renderWorkspaceBody();
        return;
      }

      // Ignore clicks inside stop-propagation card controls
      if (e.target.closest('[data-stop-card-open]')) return;

      // Clicking a Task Card opens the Detail Drawer / Bottom Sheet
      const cardEl = e.target.closest('.task-card[data-task-id]');
      if (cardEl) {
        const clickedId = cardEl.dataset.taskId;
        Store.selectTask(clickedId);
      }
    });

    // Detail Pane Delegated Toggle Actions (Checkbox & Sun button inside header/title)
    dom.detailInner.addEventListener('click', (e) => {
      const checkBtn = e.target.closest('[data-action="toggle-complete"]');
      if (checkBtn) {
        e.stopPropagation();
        const res = Store.toggleTaskCompleted(checkBtn.dataset.taskId);
        if (!res.ok && res.reason === 'blocked') {
          notifyBlockedTask(res.task, res.blocker);
        }
        renderDetailDrawer(true);
        return;
      }

      const sunBtn = e.target.closest('[data-action="toggle-myday"]');
      if (sunBtn) {
        e.stopPropagation();
        Store.toggleMyDay(sunBtn.dataset.taskId);
        renderDetailDrawer(true);
      }
    });

    // Keyboard Shortcuts: Esc closes modals/drawers, '/' or 'n' focuses Quick Capture
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (uiLocal.dropdown) {
          closeDropdown();
        } else if (uiLocal.activeModal) {
          closeModal();
        } else if (uiLocal.tabletSidebarOpen) {
          uiLocal.tabletSidebarOpen = false;
          renderSidebar();
        } else if (Store.getState().ui.selectedTaskId) {
          Store.selectTask(null);
        }
        return;
      }

      const tag = document.activeElement ? document.activeElement.tagName : '';
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (!isTyping && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '/' || e.key === 'n')) {
        const qInput = document.getElementById('quick-capture-input');
        if (qInput) {
          e.preventDefault();
          qInput.focus();
        }
      }
    });

    // Keep scrim synced across viewport resizes
    window.addEventListener('resize', () => {
      const hasSelected = Boolean(Store.getState().ui.selectedTaskId);
      dom.detailScrim.classList.toggle('is-visible', hasSelected && window.innerWidth <= 1024);
    });
  }

  /* ========================================================================
     Master Render Cycle & Boot
     ======================================================================== */
  function renderAll() {
    renderSidebar();
    renderWorkspaceHeader();
    renderCaptureZone();
    renderWorkspaceBody();
    renderMobileNav();
    renderDetailDrawer();
    renderSyncButtons();
  }

  function setupPWA() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) installBtn.style.display = 'inline-flex';
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) installBtn.style.display = 'none';
      showToast('ðŸŽ‰ Flow installed! Launch it anytime from your apps.');
    });
  }

  function init() {
    cacheDom();
    const logoBox = document.getElementById('brand-logo-icon');
    if (logoBox) logoBox.innerHTML = icon('logo', 17, 2.2);
    const fabEl = dom.mobileFab;
    if (fabEl) fabEl.innerHTML = `${icon('plus', 19, 2.4)} <span>New Task</span>`;

    bindGlobalEvents();
    setupBottomSheetSwipe();
    setupPWA();
    Store.subscribe(renderAll);
    if (ns.CloudSync) {
      ns.CloudSync.subscribe(renderSyncButtons);
      ns.CloudSync.init();
    }
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.Flow);
