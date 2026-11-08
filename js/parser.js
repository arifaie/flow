'use strict';

window.Flow = window.Flow || {};

(function (ns) {
  /**
   * Smart Quick-Capture Natural Language Parser
   * Extracts and strips:
   *  - #tagname        -> task.tags
   *  - today or ☀️     -> task.isInMyDay = true
   *  - tomorrow        -> task.dueDate = tomorrow ISO
   *  - @ListName       -> task.listId (supports quoted, full multi-word, or shorthand match)
   */
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseQuickCapture(rawInput, options = {}) {
    const {
      lists = [],
      defaultListId = 'inbox',
      defaultIsInMyDay = false,
      defaultTag = null
    } = options;

    const original = String(rawInput || '').trim();
    if (!original) {
      return {
        title: '',
        tags: defaultTag ? [defaultTag] : [],
        isInMyDay: Boolean(defaultIsInMyDay),
        dueDate: null,
        listId: defaultListId,
        matchedList: null,
        tokens: []
      };
    }

    let working = ` ${original} `;
    const tagsSet = new Set(defaultTag ? [defaultTag.toLowerCase()] : []);
    let isInMyDay = Boolean(defaultIsInMyDay);
    let dueDate = null;
    let listId = defaultListId;
    let matchedList = null;
    const tokens = [];

    const allLists = [ns.INBOX_LIST, ...lists];

    // 1. Quoted @ListName e.g. @"Flow v2.0 Launch"
    working = working.replace(/(^|\s)@"([^"]+)"(?=\s|$)/gi, (full, lead, query) => {
      const q = query.trim().toLowerCase();
      const found =
        allLists.find((l) => l.name.toLowerCase() === q) ||
        allLists.find((l) => l.name.toLowerCase().startsWith(q)) ||
        allLists.find((l) => l.name.toLowerCase().includes(q));
      if (found) {
        listId = found.id;
        matchedList = found;
        tokens.push({ type: 'list', label: `@${found.name}` });
        return lead;
      }
      return full;
    });

    // 2. Exact multi-word @ListName (longest name first)
    if (!matchedList) {
      const sortedByLen = [...allLists].sort((a, b) => b.name.length - a.name.length);
      for (const candidate of sortedByLen) {
        const pattern = new RegExp(`(^|\\s)@${escapeRegex(candidate.name)}(?=\\s|$)`, 'i');
        if (pattern.test(working)) {
          working = working.replace(pattern, '$1');
          listId = candidate.id;
          matchedList = candidate;
          tokens.push({ type: 'list', label: `@${candidate.name}` });
          break;
        }
      }
    }

    // 3. Shorthand single-word @ListToken (never matches mid-word emails like name@domain.com)
    if (!matchedList) {
      working = working.replace(/(^|\s)@([A-Za-z0-9_-]+)(?=\s|$)/g, (full, lead, token) => {
        const q = token.toLowerCase();
        const slugMatch = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const found =
          allLists.find((l) => l.name.toLowerCase() === q) ||
          allLists.find((l) => slugMatch(l.name) === q) ||
          allLists.find((l) => l.name.toLowerCase().startsWith(q)) ||
          allLists.find((l) =>
            l.name
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.replace(/[^a-z0-9]/g, '').startsWith(q))
          );
        if (found) {
          listId = found.id;
          matchedList = found;
          tokens.push({ type: 'list', label: `@${found.name}` });
          return lead;
        }
        return full;
      });
    }

    // 4. #tagname extraction (preceded by start or whitespace so URLs stay intact)
    working = working.replace(/(^|\s)#([A-Za-z0-9_-]+)(?=\s|$)/g, (full, lead, tagRaw) => {
      const cleanTag = tagRaw.toLowerCase();
      if (cleanTag) {
        tagsSet.add(cleanTag);
        tokens.push({ type: 'tag', label: `#${cleanTag}` });
      }
      return lead;
    });

    // 5. Sun emoji ☀️ or ☀ anywhere, or standalone word "today"
    if (/☀️|☀/u.test(working)) {
      isInMyDay = true;
      working = working.replace(/☀️|☀/gu, ' ');
      tokens.push({ type: 'today', label: '☀️ My Day' });
    }

    if (/(^|\s)today(?=\s|$)/i.test(working)) {
      isInMyDay = true;
      working = working.replace(/(^|\s)today(?=\s|$)/gi, ' ');
      if (!tokens.some((t) => t.type === 'today')) {
        tokens.push({ type: 'today', label: '☀️ My Day' });
      }
    }

    // 6. Standalone word "tomorrow" -> sets dueDate to tomorrow's ISO date
    if (/(^|\s)tomorrow(?=\s|$)/i.test(working)) {
      dueDate = ns.getOffsetDateISO(1);
      working = working.replace(/(^|\s)tomorrow(?=\s|$)/gi, ' ');
      tokens.push({ type: 'dueDate', label: 'Tomorrow' });
    }

    // Clean up extra spaces; fallback to original text if user only typed metadata words
    let cleanTitle = working.replace(/\s+/g, ' ').trim();
    if (!cleanTitle) {
      cleanTitle = original.replace(/\s+/g, ' ').trim();
    }

    return {
      title: cleanTitle,
      tags: Array.from(tagsSet),
      isInMyDay,
      dueDate,
      listId,
      matchedList,
      tokens
    };
  }

  ns.parseQuickCapture = parseQuickCapture;
})(window.Flow);
