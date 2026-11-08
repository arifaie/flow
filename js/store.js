'use strict';

window.Flow = window.Flow || {};

(function (ns) {
  const STORAGE_KEY = 'flow_workspace_v1';

  /* Clean Repository Adapter (swappable for REST / IndexedDB / Supabase later) */
  const StorageRepository = {
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (err) {
        console.warn('Flow storage read fallback:', err);
        return null;
      }
    },
    save(data) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (err) {
        console.warn('Flow storage write warning:', err);
      }
    },
    clear() {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}
    }
  };

  function sanitizeLoadedState(raw) {
    if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.lists)) {
      return ns.createSeedData();
    }

    const folders = Array.isArray(raw.folders) ? raw.folders : [];
    const lists = raw.lists;
    const customPresets = Array.isArray(raw.customPresets) ? raw.customPresets : [];

    const getList = (listId) => {
      if (!listId || listId === 'inbox') return ns.INBOX_LIST;
      return lists.find((l) => l.id === listId) || ns.INBOX_LIST;
    };

    const tasks = raw.tasks
      .filter((t) => t && typeof t.title === 'string' && t.title.trim().length > 0)
      .map((t) => {
        const list = getList(t.listId);
        const listId = list.id;
        const validStage = list.stages.find((s) => s.id === t.stageId);
        const fallbackCategory = t.isCompleted ? 'done' : 'open';
        const fallbackStage =
          list.stages.find((s) => s.category === fallbackCategory) || list.stages[0];
        const stage = validStage || fallbackStage;

        return {
          id: t.id || ns.uid('tsk'),
          title: t.title.trim(),
          isCompleted: stage ? stage.category === 'done' : Boolean(t.isCompleted),
          isInMyDay: Boolean(t.isInMyDay),
          dueDate: ns.normalizeDateISO(t.dueDate),
          listId,
          stageId: stage ? stage.id : 'inbox_open',
          tags: Array.isArray(t.tags) ? [...new Set(t.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean))] : [],
          subtasks: Array.isArray(t.subtasks)
            ? t.subtasks.map((s) => ({
                id: s.id || ns.uid('sub'),
                title: String(s.title || '').trim(),
                isCompleted: Boolean(s.isCompleted)
              })).filter((s) => s.title.length > 0)
            : [],
          blockedByTaskId: t.blockedByTaskId || null,
          notes: typeof t.notes === 'string' ? t.notes : '',
          createdAt: Number(t.createdAt) || Date.now()
        };
      });

    return {
      version: 1,
      updatedAt: Number(raw.updatedAt) || 0,
      hasUserEdits: Boolean(raw.hasUserEdits),
      folders,
      lists,
      tasks,
      customPresets,
      ui: Object.assign(
        {
          activeView: { type: 'today', id: 'today' },
          selectedTaskId: null,
          sidebarCollapsed: false,
          folderViewMode: 'kanban',
          expandedCardSubtasks: [],
          showCompletedInLists: true
        },
        raw.ui || {}
      )
    };
  }

  let state = sanitizeLoadedState(StorageRepository.load());
  StorageRepository.save(state);

  const listeners = new Set();
  const dataListeners = new Set();

  function emit(options = {}) {
    const { touchUpdatedAt = true } = options;
    if (touchUpdatedAt) {
      state.updatedAt = Date.now();
      state.hasUserEdits = true;
    }
    StorageRepository.save(state);
    listeners.forEach((fn) => fn(state));
    if (touchUpdatedAt) {
      dataListeners.forEach((fn) => fn(state));
    }
  }

  function getExportablePayload() {
    return {
      version: 1,
      updatedAt: state.updatedAt || Date.now(),
      hasUserEdits: true,
      folders: state.folders,
      lists: state.lists,
      tasks: state.tasks,
      customPresets: state.customPresets
    };
  }

  function replaceStateFromCloud(remoteRaw) {
    if (!remoteRaw) return false;
    const prevUi = Object.assign({}, state.ui);
    const hydrated = sanitizeLoadedState(remoteRaw);
    hydrated.updatedAt = Number(remoteRaw.updatedAt) || Date.now();
    hydrated.hasUserEdits = true;
    hydrated.ui = Object.assign(hydrated.ui, prevUi);
    if (hydrated.ui.selectedTaskId && !hydrated.tasks.some((t) => t.id === hydrated.ui.selectedTaskId)) {
      hydrated.ui.selectedTaskId = null;
    }
    state = hydrated;
    StorageRepository.save(state);
    listeners.forEach((fn) => fn(state));
    return true;
  }

  /* ------------------------------------------------------------------------
     Selectors & Backbone Helpers
     ------------------------------------------------------------------------ */
  function getListById(listId) {
    if (!listId || listId === 'inbox') return ns.INBOX_LIST;
    return state.lists.find((l) => l.id === listId) || ns.INBOX_LIST;
  }

  function getStageForTask(task) {
    const list = getListById(task.listId);
    return (
      list.stages.find((s) => s.id === task.stageId) ||
      list.stages.find((s) => s.category === (task.isCompleted ? 'done' : 'open')) ||
      list.stages[0]
    );
  }

  function getFirstStageByCategory(listId, category) {
    const list = getListById(listId);
    return (
      list.stages.find((s) => s.category === category) ||
      (category === 'active' ? list.stages.find((s) => s.category === 'open') : null) ||
      list.stages[0]
    );
  }

  function getTaskById(taskId) {
    if (!taskId) return null;
    return state.tasks.find((t) => t.id === taskId) || null;
  }

  /**
   * Returns the blocking task ONLY if it exists and is NOT completed.
   * The instant the blocking task is completed, this returns null automatically!
   */
  function getActiveBlocker(taskOrId) {
    const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
    if (!task || !task.blockedByTaskId) return null;
    if (task.blockedByTaskId === task.id) return null;
    const blocker = getTaskById(task.blockedByTaskId);
    if (!blocker || blocker.isCompleted) return null;
    return blocker;
  }

  function getAllTagsWithCounts() {
    const counts = new Map();
    for (const task of state.tasks) {
      for (const tag of task.tags) {
        if (!counts.has(tag)) counts.set(tag, { total: 0, open: 0 });
        const entry = counts.get(tag);
        entry.total += 1;
        if (!task.isCompleted) entry.open += 1;
      }
    }
    return Array.from(counts.entries())
      .map(([tag, info]) => ({ tag, total: info.total, open: info.open }))
      .sort((a, b) => b.open - a.open || a.tag.localeCompare(b.tag));
  }

  function getTodayTasks() {
    const today = ns.getTodayISO();
    return state.tasks.filter((t) => t.isInMyDay || t.dueDate === today);
  }

  /* ------------------------------------------------------------------------
     Task Mutations & 3-State Backbone Rules
     ------------------------------------------------------------------------ */
  function createTask(payload) {
    const title = String(payload.title || '').trim();
    if (!title) return null;

    const list = getListById(payload.listId || 'inbox');
    let stage = null;
    if (payload.stageId) {
      stage = list.stages.find((s) => s.id === payload.stageId);
    }
    if (!stage) {
      stage = getFirstStageByCategory(list.id, payload.isCompleted ? 'done' : 'open');
    }

    const isCompleted = stage.category === 'done';

    const newTask = {
      id: ns.uid('tsk'),
      title,
      isCompleted,
      isInMyDay: Boolean(payload.isInMyDay),
      dueDate: ns.normalizeDateISO(payload.dueDate),
      listId: list.id,
      stageId: stage.id,
      tags: Array.isArray(payload.tags)
        ? [...new Set(payload.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))]
        : [],
      subtasks: Array.isArray(payload.subtasks) ? payload.subtasks : [],
      blockedByTaskId: payload.blockedByTaskId || null,
      notes: payload.notes ? String(payload.notes) : '',
      createdAt: Date.now()
    };

    state.tasks.unshift(newTask);
    emit();
    return newTask;
  }

  function restoreDeletedTask(taskSnapshot) {
    if (!taskSnapshot) return;
    const list = getListById(taskSnapshot.listId);
    const validStage = list.stages.find((s) => s.id === taskSnapshot.stageId) ||
      getFirstStageByCategory(list.id, taskSnapshot.isCompleted ? 'done' : 'open');
    state.tasks.unshift({
      ...taskSnapshot,
      listId: list.id,
      stageId: validStage.id
    });
    emit();
  }

  function deleteTask(taskId) {
    const idx = state.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;
    const [removed] = state.tasks.splice(idx, 1);

    // Clean up any tasks that pointed to this task as blocker
    state.tasks.forEach((t) => {
      if (t.blockedByTaskId === taskId) {
        t.blockedByTaskId = null;
      }
    });

    if (state.ui.selectedTaskId === taskId) {
      state.ui.selectedTaskId = null;
    }
    emit();
    return removed;
  }

  /**
   * Rule 2 & Rule 3:
   * - Checking a task from ANY view moves it to its parent List's `done` stage.
   * - Unchecking a completed task moves it back to its List's first `open` stage.
   * - Blocked tasks cannot be checked off until their blocker is completed.
   */
  function toggleTaskCompleted(taskId) {
    const task = getTaskById(taskId);
    if (!task) return { ok: false };

    if (!task.isCompleted) {
      const blocker = getActiveBlocker(task);
      if (blocker) {
        return { ok: false, reason: 'blocked', blocker, task };
      }
      task.isCompleted = true;
      const currentStage = getStageForTask(task);
      if (!currentStage || currentStage.category !== 'done') {
        const doneStage = getFirstStageByCategory(task.listId, 'done');
        if (doneStage) task.stageId = doneStage.id;
      }
      emit();
      return { ok: true, completed: true, task };
    } else {
      task.isCompleted = false;
      const openStage = getFirstStageByCategory(task.listId, 'open');
      if (openStage) task.stageId = openStage.id;
      emit();
      return { ok: true, completed: false, task };
    }
  }

  /**
   * Rule 1:
   * - Dragging/moving a card into ANY stage mapped to `done` sets `task.isCompleted = true`.
   * - Moving into `open` or `active` sets `task.isCompleted = false`.
   * - Blocked tasks cannot be dropped into `done`.
   */
  function moveTaskToStage(taskId, targetStageId, beforeTaskId = null) {
    const task = getTaskById(taskId);
    if (!task) return { ok: false };

    const list = getListById(task.listId);
    const targetStage = list.stages.find((s) => s.id === targetStageId);
    if (!targetStage) return { ok: false };

    if (targetStage.category === 'done') {
      const blocker = getActiveBlocker(task);
      if (blocker) {
        return { ok: false, reason: 'blocked', blocker, task };
      }
      task.isCompleted = true;
    } else {
      task.isCompleted = false;
    }

    task.stageId = targetStage.id;

    // Reorder within task list if positioned relative to another card
    if (beforeTaskId && beforeTaskId !== taskId) {
      const fromIdx = state.tasks.findIndex((t) => t.id === taskId);
      if (fromIdx !== -1) {
        const [item] = state.tasks.splice(fromIdx, 1);
        const toIdx = state.tasks.findIndex((t) => t.id === beforeTaskId);
        if (toIdx !== -1) {
          state.tasks.splice(toIdx, 0, item);
        } else {
          state.tasks.push(item);
        }
      }
    }

    emit();
    return { ok: true, task, stage: targetStage };
  }

  /**
   * Folder Roll-Up View Drag/Drop across Master Backbone Columns (open -> active -> done)
   */
  function moveTaskToBackboneCategory(taskId, category, beforeTaskId = null) {
    const task = getTaskById(taskId);
    if (!task) return { ok: false };

    if (category === 'done') {
      const blocker = getActiveBlocker(task);
      if (blocker) {
        return { ok: false, reason: 'blocked', blocker, task };
      }
    }

    const list = getListById(task.listId);
    const targetStage =
      list.stages.find((s) => s.category === category) ||
      getFirstStageByCategory(list.id, category);

    if (!targetStage) return { ok: false };
    if (category === 'active' && targetStage.category !== 'active') {
      return { ok: false, reason: 'no_active_stage', list };
    }

    return moveTaskToStage(taskId, targetStage.id, beforeTaskId);
  }

  /**
   * Seamless cross-pipeline move (Inbox -> Project List, or Project A -> Project B)
   */
  function moveTaskToList(taskId, targetListId, explicitStageId = null) {
    const task = getTaskById(taskId);
    if (!task) return { ok: false };

    const targetList = getListById(targetListId);
    const prevStage = getStageForTask(task);
    const desiredCategory = task.isCompleted
      ? 'done'
      : prevStage
      ? prevStage.category
      : 'open';

    let targetStage = explicitStageId
      ? targetList.stages.find((s) => s.id === explicitStageId)
      : null;

    if (!targetStage) {
      targetStage = getFirstStageByCategory(targetList.id, desiredCategory);
    }

    if (targetStage.category === 'done') {
      const blocker = getActiveBlocker(task);
      if (blocker) {
        targetStage = getFirstStageByCategory(targetList.id, 'open');
      }
    }

    task.listId = targetList.id;
    task.stageId = targetStage.id;
    task.isCompleted = targetStage.category === 'done';
    emit();
    return { ok: true, task, list: targetList, stage: targetStage };
  }

  function toggleMyDay(taskId, forceValue = undefined) {
    const task = getTaskById(taskId);
    if (!task) return;
    task.isInMyDay = typeof forceValue === 'boolean' ? forceValue : !task.isInMyDay;
    emit();
    return task.isInMyDay;
  }

  function updateTaskFields(taskId, patch) {
    const task = getTaskById(taskId);
    if (!task) return null;

    if (typeof patch.title === 'string') {
      const trimmed = patch.title.trim();
      if (trimmed) task.title = trimmed;
    }
    if ('dueDate' in patch) {
      task.dueDate = ns.normalizeDateISO(patch.dueDate);
    }
    if ('notes' in patch) {
      task.notes = String(patch.notes || '');
    }
    if ('blockedByTaskId' in patch) {
      const candidateId = patch.blockedByTaskId || null;
      task.blockedByTaskId = candidateId && candidateId !== task.id ? candidateId : null;
    }
    if (Array.isArray(patch.tags)) {
      task.tags = [...new Set(patch.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))];
    }
    emit();
    return task;
  }

  function addTagToTask(taskId, rawTag) {
    const task = getTaskById(taskId);
    if (!task) return;
    const clean = String(rawTag || '').replace(/^#+/, '').toLowerCase().trim();
    if (!clean) return;
    if (!task.tags.includes(clean)) {
      task.tags.push(clean);
      emit();
    }
  }

  function removeTagFromTask(taskId, tag) {
    const task = getTaskById(taskId);
    if (!task) return;
    task.tags = task.tags.filter((t) => t !== tag);
    emit();
  }

  /* ------------------------------------------------------------------------
     Subtasks CRUD & Inline Card Expand State
     ------------------------------------------------------------------------ */
  function addSubtask(taskId, title) {
    const task = getTaskById(taskId);
    const clean = String(title || '').trim();
    if (!task || !clean) return null;
    const sub = { id: ns.uid('sub'), title: clean, isCompleted: false };
    task.subtasks.push(sub);
    emit();
    return sub;
  }

  function toggleSubtask(taskId, subtaskId) {
    const task = getTaskById(taskId);
    if (!task) return;
    const sub = task.subtasks.find((s) => s.id === subtaskId);
    if (!sub) return;
    sub.isCompleted = !sub.isCompleted;
    emit();
  }

  function updateSubtaskTitle(taskId, subtaskId, title) {
    const task = getTaskById(taskId);
    if (!task) return;
    const sub = task.subtasks.find((s) => s.id === subtaskId);
    if (!sub) return;
    const clean = String(title || '').trim();
    if (!clean) {
      task.subtasks = task.subtasks.filter((s) => s.id !== subtaskId);
    } else {
      sub.title = clean;
    }
    emit();
  }

  function deleteSubtask(taskId, subtaskId) {
    const task = getTaskById(taskId);
    if (!task) return;
    task.subtasks = task.subtasks.filter((s) => s.id !== subtaskId);
    emit();
  }

  function toggleCardSubtasksExpanded(taskId) {
    const set = new Set(state.ui.expandedCardSubtasks || []);
    if (set.has(taskId)) set.delete(taskId);
    else set.add(taskId);
    state.ui.expandedCardSubtasks = Array.from(set);
    emit();
  }

  /* ------------------------------------------------------------------------
     Lists, Folders, Custom Stages & Presets
     ------------------------------------------------------------------------ */
  function createFolder(name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const folder = {
      id: ns.uid('fld'),
      name: clean,
      icon: 'folder',
      isExpanded: true
    };
    state.folders.push(folder);
    emit();
    return folder;
  }

  function renameFolder(folderId, newName) {
    const folder = state.folders.find((f) => f.id === folderId);
    const clean = String(newName || '').trim();
    if (!folder || !clean) return;
    folder.name = clean;
    emit();
  }

  function deleteFolder(folderId) {
    // Keep child lists safely at root level when deleting a folder container
    state.lists.forEach((l) => {
      if (l.folderId === folderId) l.folderId = null;
    });
    state.folders = state.folders.filter((f) => f.id !== folderId);
    if (state.ui.activeView.type === 'folder' && state.ui.activeView.id === folderId) {
      state.ui.activeView = { type: 'today', id: 'today' };
    }
    emit();
  }

  function toggleFolderExpanded(folderId) {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return;
    folder.isExpanded = !folder.isExpanded;
    emit();
  }

  function getAllPresets() {
    return [...ns.BUILT_IN_PRESETS, ...(state.customPresets || [])];
  }

  function createList({ name, folderId = null, presetId = 'preset_standard', color = null }) {
    const clean = String(name || '').trim();
    if (!clean) return null;

    const presets = getAllPresets();
    const chosenPreset = presets.find((p) => p.id === presetId) || ns.BUILT_IN_PRESETS[0];
    const colorChoice =
      color || ns.LIST_COLORS[state.lists.length % ns.LIST_COLORS.length];

    const newList = {
      id: ns.uid('lst'),
      name: clean,
      folderId: folderId || null,
      color: colorChoice,
      defaultView: 'kanban',
      stages: ns.instantiateStages(chosenPreset.stages)
    };

    state.lists.push(newList);
    if (folderId) {
      const parentFolder = state.folders.find((f) => f.id === folderId);
      if (parentFolder) parentFolder.isExpanded = true;
    }
    state.ui.activeView = { type: 'list', id: newList.id };
    emit();
    return newList;
  }

  function renameList(listId, newName) {
    const list = state.lists.find((l) => l.id === listId);
    const clean = String(newName || '').trim();
    if (!list || !clean) return;
    list.name = clean;
    emit();
  }

  function deleteList(listId) {
    const idx = state.lists.findIndex((l) => l.id === listId);
    if (idx === -1) return;
    // Move tasks from deleted list to Inbox rather than silently losing work, or remove if user wishes; moving to Inbox is zero-data-loss!
    state.tasks.forEach((t) => {
      if (t.listId === listId) {
        t.listId = 'inbox';
        t.stageId = t.isCompleted ? 'inbox_done' : 'inbox_open';
      }
    });
    state.lists.splice(idx, 1);
    if (state.ui.activeView.type === 'list' && state.ui.activeView.id === listId) {
      state.ui.activeView = { type: 'inbox', id: 'inbox' };
    }
    emit();
  }

  function setListViewMode(listId, mode) {
    if (listId === '__folder__') {
      state.ui.folderViewMode = mode;
      emit();
      return;
    }
    const list = state.lists.find((l) => l.id === listId);
    if (!list) return;
    list.defaultView = mode;
    emit();
  }

  function saveListStagesAsPreset(listId, presetName) {
    const list = state.lists.find((l) => l.id === listId);
    const clean = String(presetName || '').trim();
    if (!list || !clean) return null;

    const customPreset = {
      id: ns.uid('preset_custom'),
      name: clean,
      description: `Custom ${list.stages.length}-stage pipeline saved from ${list.name}`,
      isBuiltIn: false,
      stages: list.stages.map((s) => ({ name: s.name, category: s.category }))
    };

    state.customPresets.push(customPreset);
    emit();
    return customPreset;
  }

  function deleteCustomPreset(presetId) {
    state.customPresets = state.customPresets.filter((p) => p.id !== presetId);
    emit();
  }

  /* Custom Stage CRUD per List */
  function addStage(listId, name, category = 'active') {
    const list = state.lists.find((l) => l.id === listId);
    const clean = String(name || '').trim();
    if (!list || !clean) return null;
    const validCat = ['open', 'active', 'done'].includes(category) ? category : 'active';
    const newStage = { id: ns.uid('stg'), name: clean, category: validCat };

    // Insert neatly right after the last stage of the same category (or before first 'done' if open/active)
    if (validCat === 'done') {
      list.stages.push(newStage);
    } else {
      const firstDoneIdx = list.stages.findIndex((s) => s.category === 'done');
      if (firstDoneIdx !== -1) {
        list.stages.splice(firstDoneIdx, 0, newStage);
      } else {
        list.stages.push(newStage);
      }
    }

    emit();
    return newStage;
  }

  function renameStage(listId, stageId, newName) {
    const list = state.lists.find((l) => l.id === listId);
    const clean = String(newName || '').trim();
    if (!list || !clean) return false;
    const stage = list.stages.find((s) => s.id === stageId);
    if (!stage) return false;
    stage.name = clean;
    emit();
    return true;
  }

  function reorderStage(listId, stageId, direction) {
    const list = state.lists.find((l) => l.id === listId);
    if (!list) return false;
    const idx = list.stages.findIndex((s) => s.id === stageId);
    if (idx === -1) return false;
    const targetIdx = direction === 'left' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= list.stages.length) return false;
    const [moved] = list.stages.splice(idx, 1);
    list.stages.splice(targetIdx, 0, moved);
    emit();
    return true;
  }

  function changeStageCategory(listId, stageId, newCategory) {
    const list = state.lists.find((l) => l.id === listId);
    if (!list || !['open', 'active', 'done'].includes(newCategory)) return { ok: false };
    const stage = list.stages.find((s) => s.id === stageId);
    if (!stage || stage.category === newCategory) return { ok: true };

    // Ensure at least one 'open' and one 'done' stage always remain
    const remainingOpen = list.stages.filter((s) => s.id !== stageId && s.category === 'open').length;
    const remainingDone = list.stages.filter((s) => s.id !== stageId && s.category === 'done').length;
    if (stage.category === 'open' && newCategory !== 'open' && remainingOpen === 0) {
      return { ok: false, reason: 'min_open' };
    }
    if (stage.category === 'done' && newCategory !== 'done' && remainingDone === 0) {
      return { ok: false, reason: 'min_done' };
    }

    stage.category = newCategory;
    const fallbackOpen = list.stages.find((s) => s.category === 'open') || list.stages[0];

    state.tasks.forEach((t) => {
      if (t.listId === listId && t.stageId === stageId) {
        if (newCategory === 'done') {
          if (getActiveBlocker(t)) {
            t.stageId = fallbackOpen.id;
            t.isCompleted = false;
          } else {
            t.isCompleted = true;
          }
        } else {
          t.isCompleted = false;
        }
      }
    });

    emit();
    return { ok: true };
  }

  function deleteStage(listId, stageId) {
    const list = state.lists.find((l) => l.id === listId);
    if (!list) return { ok: false };
    const stage = list.stages.find((s) => s.id === stageId);
    if (!stage) return { ok: false };

    const remainingOpen = list.stages.filter((s) => s.id !== stageId && s.category === 'open').length;
    const remainingDone = list.stages.filter((s) => s.id !== stageId && s.category === 'done').length;
    if (stage.category === 'open' && remainingOpen === 0) {
      return { ok: false, reason: 'min_open' };
    }
    if (stage.category === 'done' && remainingDone === 0) {
      return { ok: false, reason: 'min_done' };
    }

    list.stages = list.stages.filter((s) => s.id !== stageId);
    const fallbackStage =
      list.stages.find((s) => s.category === stage.category) ||
      list.stages.find((s) => s.category === 'open') ||
      list.stages[0];

    let movedCount = 0;
    state.tasks.forEach((t) => {
      if (t.listId === listId && t.stageId === stageId) {
        t.stageId = fallbackStage.id;
        t.isCompleted = fallbackStage.category === 'done';
        movedCount += 1;
      }
    });

    emit();
    return { ok: true, movedCount, fallbackStage };
  }

  /* ------------------------------------------------------------------------
     UI Navigation & State Actions
     ------------------------------------------------------------------------ */
  function setActiveView(type, id = type) {
    state.ui.activeView = { type, id };
    emit({ touchUpdatedAt: false });
  }

  function selectTask(taskId) {
    state.ui.selectedTaskId = taskId || null;
    emit({ touchUpdatedAt: false });
  }

  function toggleSidebarCollapsed() {
    state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
    emit({ touchUpdatedAt: false });
  }

  function toggleShowCompletedInLists() {
    state.ui.showCompletedInLists = !state.ui.showCompletedInLists;
    emit({ touchUpdatedAt: false });
  }

  function resetDemoData() {
    StorageRepository.clear();
    state = ns.createSeedData();
    emit();
  }

  ns.Store = {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onDataMutated: (fn) => {
      dataListeners.add(fn);
      return () => dataListeners.delete(fn);
    },
    getExportablePayload,
    replaceStateFromCloud,
    getListById,
    getStageForTask,
    getFirstStageByCategory,
    getTaskById,
    getActiveBlocker,
    getAllTagsWithCounts,
    getTodayTasks,
    getAllPresets,
    createTask,
    restoreDeletedTask,
    deleteTask,
    toggleTaskCompleted,
    moveTaskToStage,
    moveTaskToBackboneCategory,
    moveTaskToList,
    toggleMyDay,
    updateTaskFields,
    addTagToTask,
    removeTagFromTask,
    addSubtask,
    toggleSubtask,
    updateSubtaskTitle,
    deleteSubtask,
    toggleCardSubtasksExpanded,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolderExpanded,
    createList,
    renameList,
    deleteList,
    setListViewMode,
    saveListStagesAsPreset,
    deleteCustomPreset,
    addStage,
    renameStage,
    reorderStage,
    changeStageCategory,
    deleteStage,
    setActiveView,
    selectTask,
    toggleSidebarCollapsed,
    toggleShowCompletedInLists,
    resetDemoData
  };
})(window.Flow);
