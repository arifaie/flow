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

  /* ------------------------------------------------------------------------
     Rich, Realistic Initial Seed Dataset
     ------------------------------------------------------------------------ */
  function createSeedData() {
    const now = Date.now();
    const today = getTodayISO();
    const tomorrow = getOffsetDateISO(1);
    const inTwoDays = getOffsetDateISO(2);
    const inFourDays = getOffsetDateISO(4);

    const folders = [
      {
        id: 'fld_product',
        name: 'Product & Design',
        icon: 'folder',
        isExpanded: true
      },
      {
        id: 'fld_growth',
        name: 'Growth & Partnerships',
        icon: 'folder',
        isExpanded: true
      }
    ];

    const lists = [
      {
        id: 'lst_launch',
        name: 'Flow v2.0 Launch',
        folderId: 'fld_product',
        color: '#2563EB',
        defaultView: 'kanban',
        stages: [
          { id: 'stg_launch_todo', name: 'To Do', category: 'open' },
          { id: 'stg_launch_prog', name: 'In Progress', category: 'active' },
          { id: 'stg_launch_done', name: 'Done', category: 'done' }
        ]
      },
      {
        id: 'lst_creative',
        name: 'Brand Refresh Studio',
        folderId: 'fld_product',
        color: '#7C3AED',
        defaultView: 'kanban',
        stages: [
          { id: 'stg_cr_brief', name: 'Briefing', category: 'open' },
          { id: 'stg_cr_design', name: 'Designing', category: 'active' },
          { id: 'stg_cr_review', name: 'Client Review', category: 'active' },
          { id: 'stg_cr_deliv', name: 'Delivered', category: 'done' }
        ]
      },
      {
        id: 'lst_partners',
        name: 'Strategic Partnerships',
        folderId: 'fld_growth',
        color: '#0D9488',
        defaultView: 'kanban',
        stages: [
          { id: 'stg_pt_target', name: 'Target', category: 'open' },
          { id: 'stg_pt_outreach', name: 'Outreach', category: 'open' },
          { id: 'stg_pt_neg', name: 'Negotiating', category: 'active' },
          { id: 'stg_pt_contract', name: 'Contracting', category: 'active' },
          { id: 'stg_pt_signed', name: 'Signed / Live', category: 'done' }
        ]
      },
      {
        id: 'lst_ops',
        name: 'Personal & Ops',
        folderId: null,
        color: '#EA580C',
        defaultView: 'list',
        stages: [
          { id: 'stg_ops_todo', name: 'To Do', category: 'open' },
          { id: 'stg_ops_prog', name: 'In Progress', category: 'active' },
          { id: 'stg_ops_done', name: 'Done', category: 'done' }
        ]
      }
    ];

    const tasks = [
      /* --- Inbox Tasks --- */
      {
        id: 'tsk_inbox_1',
        title: 'Send keynote speaker bio & high-res headshot to conference team',
        isCompleted: false,
        isInMyDay: true,
        dueDate: null,
        listId: 'inbox',
        stageId: 'inbox_open',
        tags: ['urgent', 'events'],
        subtasks: [
          { id: 'sub_i1', title: 'Export 4K monochrome portrait', isCompleted: true },
          { id: 'sub_i2', title: 'Trim bio to 90 words', isCompleted: false }
        ],
        blockedByTaskId: null,
        notes: 'Organizer requested assets before Friday print deadline.',
        createdAt: now - 3600000 * 6
      },
      {
        id: 'tsk_inbox_2',
        title: 'Review Q4 cloud hosting & CDN invoice',
        isCompleted: false,
        isInMyDay: false,
        dueDate: tomorrow,
        listId: 'inbox',
        stageId: 'inbox_open',
        tags: ['finance'],
        subtasks: [],
        blockedByTaskId: null,
        notes: 'Compare bandwidth egress against October baseline.',
        createdAt: now - 3600000 * 4
      },
      {
        id: 'tsk_inbox_3',
        title: 'Bookmark tactile micro-interaction references for mobile sheets',
        isCompleted: false,
        isInMyDay: false,
        dueDate: null,
        listId: 'inbox',
        stageId: 'inbox_open',
        tags: ['visuals', 'inspiration'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 3600000 * 2
      },

      /* --- Flow v2.0 Launch (Standard Task Board) --- */
      {
        id: 'tsk_launch_backbone',
        title: 'Audit 3-state pipeline backbone & mobile gesture polish',
        isCompleted: false,
        isInMyDay: true,
        dueDate: today,
        listId: 'lst_launch',
        stageId: 'stg_launch_prog',
        tags: ['core', 'frontend'],
        subtasks: [
          { id: 'sub_l1', title: 'Sync Done column drop with isCompleted', isCompleted: true },
          { id: 'sub_l2', title: 'Test 85vw horizontal scroll-snap on mobile', isCompleted: true },
          { id: 'sub_l3', title: 'Verify Folder Roll-Up contextual pills', isCompleted: false }
        ],
        blockedByTaskId: null,
        notes: 'Every custom stage maps cleanly to open, active, or done.',
        createdAt: now - 86400000 * 2
      },
      {
        id: 'tsk_launch_changelog',
        title: 'Publish public v2.0 changelog & Product Hunt announcement',
        isCompleted: false,
        isInMyDay: false,
        dueDate: inTwoDays,
        listId: 'lst_launch',
        stageId: 'stg_launch_todo',
        tags: ['launch', 'urgent'],
        subtasks: [
          { id: 'sub_c1', title: 'Draft release highlights', isCompleted: true },
          { id: 'sub_c2', title: 'Schedule social threads', isCompleted: false }
        ],
        blockedByTaskId: 'tsk_launch_backbone',
        notes: 'Blocked until final mobile gesture & pipeline QA completes.',
        createdAt: now - 86400000 * 1.5
      },
      {
        id: 'tsk_launch_video',
        title: 'Record 60-second zero-friction demo reel',
        isCompleted: false,
        isInMyDay: false,
        dueDate: inFourDays,
        listId: 'lst_launch',
        stageId: 'stg_launch_todo',
        tags: ['visuals', 'launch'],
        subtasks: [
          { id: 'sub_v1', title: 'Capture natural language quick-add flow', isCompleted: false },
          { id: 'sub_v2', title: 'Add subtle sound design', isCompleted: false }
        ],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 86400000
      },
      {
        id: 'tsk_launch_tokens',
        title: 'Finalize Material Minimal tonal surface & border tokens',
        isCompleted: true,
        isInMyDay: false,
        dueDate: today,
        listId: 'lst_launch',
        stageId: 'stg_launch_done',
        tags: ['design'],
        subtasks: [
          { id: 'sub_t1', title: 'Define #F8FAFC canvas & #FFFFFF cards', isCompleted: true },
          { id: 'sub_t2', title: 'Set 12px / 8px / 9999px radius scale', isCompleted: true }
        ],
        blockedByTaskId: null,
        notes: 'Approved across Desktop, Tablet, and Mobile viewports.',
        createdAt: now - 86400000 * 4
      },

      /* --- Brand Refresh Studio (Creative / Production) --- */
      {
        id: 'tsk_cr_hero',
        title: 'Hero key art & interactive card elevation prototypes',
        isCompleted: false,
        isInMyDay: true,
        dueDate: today,
        listId: 'lst_creative',
        stageId: 'stg_cr_review',
        tags: ['visuals', 'review'],
        subtasks: [
          { id: 'sub_h1', title: 'Export SVG vector compositions', isCompleted: true },
          { id: 'sub_h2', title: 'Share Figma prototype link with stakeholders', isCompleted: true }
        ],
        blockedByTaskId: null,
        notes: 'Awaiting final thumbs-up from design lead today.',
        createdAt: now - 86400000 * 3
      },
      {
        id: 'tsk_cr_social',
        title: 'Design OpenGraph & social preview templates',
        isCompleted: false,
        isInMyDay: false,
        dueDate: tomorrow,
        listId: 'lst_creative',
        stageId: 'stg_cr_design',
        tags: ['visuals'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 86400000 * 2
      },
      {
        id: 'tsk_cr_guidelines',
        title: 'Package brand press kit ZIP for media partners',
        isCompleted: false,
        isInMyDay: false,
        dueDate: inFourDays,
        listId: 'lst_creative',
        stageId: 'stg_cr_brief',
        tags: ['press', 'visuals'],
        subtasks: [],
        blockedByTaskId: 'tsk_cr_hero',
        notes: 'Needs approved hero key art before packaging.',
        createdAt: now - 86400000
      },
      {
        id: 'tsk_cr_palette',
        title: 'Establish Inter typography scale & icon stroke grid',
        isCompleted: true,
        isInMyDay: false,
        dueDate: null,
        listId: 'lst_creative',
        stageId: 'stg_cr_deliv',
        tags: ['design'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 86400000 * 5
      },

      /* --- Strategic Partnerships (CRM Pipeline) --- */
      {
        id: 'tsk_pt_vercel',
        title: 'Vercel startup bundle co-marketing agreement',
        isCompleted: false,
        isInMyDay: false,
        dueDate: today,
        listId: 'lst_partners',
        stageId: 'stg_pt_contract',
        tags: ['partner', 'urgent'],
        subtasks: [
          { id: 'sub_p1', title: 'Approve partner landing copy', isCompleted: true },
          { id: 'sub_p2', title: 'Countersign addendum PDF', isCompleted: false }
        ],
        blockedByTaskId: null,
        notes: 'Due today — automatically surfaces in Today view!',
        createdAt: now - 86400000 * 3
      },
      {
        id: 'tsk_pt_raycast',
        title: 'Raycast Quick-Capture extension spotlight',
        isCompleted: false,
        isInMyDay: false,
        dueDate: inTwoDays,
        listId: 'lst_partners',
        stageId: 'stg_pt_neg',
        tags: ['partner'],
        subtasks: [],
        blockedByTaskId: null,
        notes: 'Discussing newsletter slot for mid-November.',
        createdAt: now - 86400000 * 2
      },
      {
        id: 'tsk_pt_creators',
        title: 'Send early-access invite to 5 productivity YouTube creators',
        isCompleted: false,
        isInMyDay: true,
        dueDate: null,
        listId: 'lst_partners',
        stageId: 'stg_pt_outreach',
        tags: ['outreach'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 86400000
      },
      {
        id: 'tsk_pt_target',
        title: 'Compile Q1 design-community sponsorship shortlist',
        isCompleted: false,
        isInMyDay: false,
        dueDate: null,
        listId: 'lst_partners',
        stageId: 'stg_pt_target',
        tags: ['research'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 43200000
      },
      {
        id: 'tsk_pt_figma',
        title: 'Figma Community UI kit cross-promotion',
        isCompleted: true,
        isInMyDay: false,
        dueDate: null,
        listId: 'lst_partners',
        stageId: 'stg_pt_signed',
        tags: ['partner'],
        subtasks: [],
        blockedByTaskId: null,
        notes: 'Live and driving steady organic signups.',
        createdAt: now - 86400000 * 6
      },

      /* --- Personal & Ops --- */
      {
        id: 'tsk_ops_1',
        title: 'Order minimalist aluminum laptop stand for home studio',
        isCompleted: false,
        isInMyDay: false,
        dueDate: inFourDays,
        listId: 'lst_ops',
        stageId: 'stg_ops_prog',
        tags: ['workspace'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 86400000
      },
      {
        id: 'tsk_ops_2',
        title: 'Schedule annual dental checkup',
        isCompleted: false,
        isInMyDay: false,
        dueDate: null,
        listId: 'lst_ops',
        stageId: 'stg_ops_todo',
        tags: ['personal'],
        subtasks: [],
        blockedByTaskId: null,
        notes: '',
        createdAt: now - 28000000
      }
    ];

    return {
      version: 1,
      folders,
      lists,
      tasks,
      customPresets: [],
      ui: {
        activeView: { type: 'today', id: 'today' },
        selectedTaskId: null,
        sidebarCollapsed: false,
        folderViewMode: 'kanban',
        expandedCardSubtasks: ['tsk_launch_backbone'],
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
