'use strict';

window.Flow = window.Flow || {};

(function (ns) {
  function uid(prefix = 'id') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
    }
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  }

  /* Local calendar YYYY-MM-DD helpers (immune to UTC midnight shift) */
  function toLocalISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getTodayISO() {
    return toLocalISO(new Date());
  }

  function getOffsetDateISO(offsetDays) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return toLocalISO(d);
  }

  function normalizeDateISO(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return toLocalISO(parsed);
  }

  function formatDueDateBadge(isoStr) {
    const norm = normalizeDateISO(isoStr);
    if (!norm) return null;
    const today = getTodayISO();
    const tomorrow = getOffsetDateISO(1);
    const yesterday = getOffsetDateISO(-1);

    if (norm === today) return { label: 'Today', status: 'today' };
    if (norm === tomorrow) return { label: 'Tomorrow', status: 'upcoming' };
    if (norm === yesterday) return { label: 'Yesterday', status: 'overdue' };

    const [y, m, d] = norm.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const nowYear = new Date().getFullYear();
    const opts = y === nowYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    const label = dateObj.toLocaleDateString('en-US', opts);
    return {
      label,
      status: norm < today ? 'overdue' : 'upcoming'
    };
  }

  function formatFullTodayHeading() {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  }

  /* ------------------------------------------------------------------------
     Built-in 1-Click Pipeline Presets (Section 2.C)
     Every custom stage maps to 'open' | 'active' | 'done'
     ------------------------------------------------------------------------ */
  const BUILT_IN_PRESETS = [
    {
      id: 'preset_standard',
      name: 'Standard Task Board',
      description: 'Classic zero-friction workflow for projects and sprints.',
      isBuiltIn: true,
      stages: [
        { name: 'To Do', category: 'open' },
        { name: 'In Progress', category: 'active' },
        { name: 'Done', category: 'done' }
      ]
    },
    {
      id: 'preset_crm',
      name: 'Partnership / CRM Pipeline',
      description: 'Track outreach, deals, and partnerships from target to live.',
      isBuiltIn: true,
      stages: [
        { name: 'Target', category: 'open' },
        { name: 'Outreach', category: 'open' },
        { name: 'Negotiating', category: 'active' },
        { name: 'Contracting', category: 'active' },
        { name: 'Signed / Live', category: 'done' }
      ]
    },
    {
      id: 'preset_creative',
      name: 'Creative / Production',
      description: 'End-to-end creative studio flow with client review gates.',
      isBuiltIn: true,
      stages: [
        { name: 'Briefing', category: 'open' },
        { name: 'Designing', category: 'active' },
        { name: 'Client Review', category: 'active' },
        { name: 'Delivered', category: 'done' }
      ]
    }
  ];

  const LIST_COLORS = [
    '#2563EB', // Cobalt
    '#7C3AED', // Violet
    '#0D9488', // Teal
    '#EA580C', // Warm Orange
    '#DB2777', // Rose
    '#0284C7', // Sky
    '#4F46E5'  // Indigo
  ];

  /* Virtual Inbox List Backbone so Rules 1-3 apply uniformly everywhere */
  const INBOX_LIST = {
    id: 'inbox',
    name: 'Inbox',
    folderId: null,
    color: '#2563EB',
    isSystem: true,
    stages: [
      { id: 'inbox_open', name: 'Open', category: 'open' },
      { id: 'inbox_done', name: 'Done', category: 'done' }
    ]
  };

  function instantiateStages(stageTemplates) {
    return stageTemplates.map((st) => ({
      id: uid('stg'),
      name: st.name,
      category: st.category
    }));
  }

  /* Clean Empty Initial Workspace (Zero Sample Data) */
  function createSeedData() {
    return {
      version: 2,
      updatedAt: 0,
      hasUserEdits: false,
      folders: [],
      lists: [],
      tasks: [],
      customPresets: [],
      ui: {
        activeView: { type: 'today', id: 'today' },
        selectedTaskId: null,
        sidebarCollapsed: false,
        folderViewMode: 'kanban',
        expandedCardSubtasks: [],
        showCompletedInLists: true
      }
    };
  }

  ns.uid = uid;
  ns.getTodayISO = getTodayISO;
  ns.getOffsetDateISO = getOffsetDateISO;
  ns.normalizeDateISO = normalizeDateISO;
  ns.formatDueDateBadge = formatDueDateBadge;
  ns.formatFullTodayHeading = formatFullTodayHeading;
  ns.BUILT_IN_PRESETS = BUILT_IN_PRESETS;
  ns.LIST_COLORS = LIST_COLORS;
  ns.INBOX_LIST = INBOX_LIST;
  ns.instantiateStages = instantiateStages;
  ns.createSeedData = createSeedData;
})(window.Flow);