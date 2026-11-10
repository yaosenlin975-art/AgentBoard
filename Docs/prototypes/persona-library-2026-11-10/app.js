/*
 * 设置页「智能体人设」管理 · 静态原型交互（PERSONA-LIB-1）
 * 纯前端 mock：不发请求、不依赖构建。数据与状态只存在内存，刷新即还原。
 */
(function () {
  'use strict';

  var TODAY = '2026-11-10';

  // ---- mock 数据：覆盖 builtin / import / user 三种来源 ----
  var SEED = [
    {
      id: 'p-builtin-general',
      name: '通用助手',
      source: 'builtin',
      description: '平台内置的通用协作人设：先澄清目标与边界，再给可执行的下一步。',
      body_md: '你是 AgentBoard 的通用协作助手。\n\n1. 先确认目标、范围与验收标准；\n2. 不确定的事实先查证，不猜；\n3. 输出先结论，再给依据与下一步。',
      package_path: null,
      created_at: '2026-10-28',
    },
    {
      id: 'p-builtin-review',
      name: '严格代码评审',
      source: 'builtin',
      description: '内置评审口径：正确性、边界条件、可复现验证，不放过「看起来对」。',
      body_md: '你是严格的代码评审者。\n\n- 只报能指出文件与行号的问题；\n- 区分「会导致错误」与「风格偏好」；\n- 每条问题给出可复现的验证方式。',
      package_path: null,
      created_at: '2026-10-28',
    },
    {
      id: 'p-import-data',
      name: '数据分析师',
      source: 'import',
      description: '从 WorkBuddy 专家包导入：指标口径、SQL 审阅与可视化建议。',
      body_md: '你是数据分析师。\n\n- 先对齐指标定义与口径；\n- SQL 逐段解释过滤条件；\n- 图表只保留能回答问题的维度。',
      package_path: 'D:\\WorkBuddy\\packages\\data-analyst',
      created_at: '2026-11-08',
    },
    {
      id: 'p-import-fe',
      name: '前端工程师',
      source: 'import',
      description: '从 WorkBuddy 专家包导入：React/Vite 界面实现与既有设计令牌约束。',
      body_md: '你是前端工程师。\n\n- 先读现有组件与设计令牌，不另造风格；\n- 改动保持最小可用；\n- 交互必须能用键盘走完。',
      package_path: 'D:\\WorkBuddy\\packages\\fe-craft',
      created_at: '2026-11-08',
    },
    {
      id: 'p-user-release',
      name: '发布协调员',
      source: 'user',
      description: '收敛发布清单，逐项确认回滚方案后再放行。',
      body_md: '你是发布协调员。\n\n- 每次发布前输出一份可勾选清单；\n- 每项都必须有回滚路径；\n- 未确认项一律视为阻塞。',
      package_path: null,
      created_at: '2026-11-09',
    },
  ];

  var SOURCE_LABEL = { builtin: '内置', import: '导入', user: '自建' };
  var SOURCE_CLASS = { builtin: 'badge-builtin', import: 'badge-import', user: 'badge-user' };

  // ---- DOM ----
  var listEl = document.getElementById('persona-list');
  var emptyEl = document.getElementById('persona-empty');
  var scrimEl = document.getElementById('scrim');
  var drawerEl = document.getElementById('drawer');
  var drawerTitle = document.getElementById('drawer-title');
  var drawerReadonly = document.getElementById('drawer-readonly');
  var drawerSave = document.getElementById('drawer-save');
  var drawerCancel = document.getElementById('drawer-cancel');
  var nameEl = document.getElementById('f-name');
  var descEl = document.getElementById('f-desc');
  var bodyEl = document.getElementById('f-body');
  var errName = document.getElementById('err-name');
  var errBody = document.getElementById('err-body');
  var confirmLayer = document.getElementById('confirm-layer');
  var confirmText = document.getElementById('confirm-text');
  var importLayer = document.getElementById('import-layer');
  var importPath = document.getElementById('f-path');
  var importError = document.getElementById('import-error');
  var toastsEl = document.getElementById('toasts');
  var notesEl = document.getElementById('notes');

  // 智能创建（PERSONA-LIB-1b）
  var smartSection = document.getElementById('smart-create');
  var smartForm = document.getElementById('smart-form');
  var smartGenerating = document.getElementById('smart-generating');
  var smartPrompt = document.getElementById('f-prompt');
  var smartChips = document.getElementById('smart-chips');
  var smartError = document.getElementById('smart-error');
  var smartElapsed = document.getElementById('smart-elapsed');
  var smartBarFill = document.getElementById('smart-bar-fill');
  var btnGenerate = document.getElementById('btn-generate');
  var draftEditor = document.getElementById('draft-editor');
  var draftFields = document.getElementById('draft-fields');
  var bodyManual = document.getElementById('body-manual');
  var roleEl = document.getElementById('f-role');
  var toneEl = document.getElementById('f-tone');
  var boundaryEl = document.getElementById('f-boundary');
  var domainEl = document.getElementById('f-domain');
  var errRole = document.getElementById('err-role');
  var btnRawToggle = document.getElementById('btn-raw-toggle');

  // ---- 状态 ----
  var personas = clone(SEED);
  var drawerState = null; // { mode: 'create' | 'edit', id: string | null }
  var confirmId = null;
  var importResult = 'ok';

  // 智能创建状态机：idle → generating → draft | error
  var smartPhase = 'idle';
  var rawMode = false; // 草稿阶段：分字段编辑 / Markdown 原文
  var failDemo = false; // 控制条开关，仅演示用
  var draftAuto = { name: false, desc: false }; // 名称/描述是否由草稿自动回填
  var genTimer = null;
  var genTicker = null;
  var genStart = 0;
  var GEN_MS = 1200;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- 列表渲染 ----
  function rowHtml(p) {
    var builtin = p.source === 'builtin';
    var meta = [];
    if (p.package_path) meta.push('<code>' + escapeHtml(p.package_path) + '</code>');
    meta.push('创建于 ' + escapeHtml(p.created_at));
    if (builtin) meta.push('内置人设不可改删');

    return (
      '<article class="persona-row" data-id="' + escapeHtml(p.id) + '">' +
        '<div class="persona-main">' +
          '<div class="persona-title-line">' +
            '<span class="persona-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="badge ' + SOURCE_CLASS[p.source] + '">' + SOURCE_LABEL[p.source] + '</span>' +
          '</div>' +
          '<p class="persona-desc">' + escapeHtml(p.description || '（无描述）') + '</p>' +
          '<p class="persona-meta">' + meta.join(' · ') + '</p>' +
        '</div>' +
        '<div class="persona-ops">' +
          '<button type="button" class="ab-btn ab-btn-secondary ab-btn-sm" data-act="edit"' +
            (builtin ? ' disabled title="内置人设只读：服务端 PATCH / DELETE 返回 409"' : '') + '>编辑</button>' +
          '<button type="button" class="ab-btn ab-btn-secondary ab-btn-sm ab-btn-danger" data-act="delete"' +
            (builtin ? ' disabled title="内置人设只读：服务端 PATCH / DELETE 返回 409"' : '') + '>删除</button>' +
          (builtin ? '<span class="lock-note">内置只读</span>' : '') +
        '</div>' +
      '</article>'
    );
  }

  function renderList() {
    listEl.innerHTML = personas.map(rowHtml).join('');
    var isEmpty = personas.length === 0;
    listEl.hidden = isEmpty;
    emptyEl.hidden = !isEmpty;
  }

  // ---- Toast ----
  function toast(html) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.removeChild(toastsEl.firstChild);
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 4200);
  }

  // ---- 智能创建 ----
  function clearGenTimer() {
    if (genTicker) {
      window.clearInterval(genTicker);
      genTicker = null;
    }
    if (genTimer) {
      window.clearTimeout(genTimer);
      genTimer = null;
    }
  }

  function syncFailBtn() {
    var btn = document.getElementById('btn-fail');
    btn.setAttribute('aria-pressed', String(failDemo));
    btn.textContent = failDemo ? '下次生成会失败（已开）' : '下次生成失败';
  }

  function resetSmart() {
    clearGenTimer();
    smartPhase = 'idle';
    rawMode = false;
    draftAuto = { name: false, desc: false };
    smartPrompt.value = '';
    roleEl.value = '';
    toneEl.value = '';
    boundaryEl.value = '';
    domainEl.value = '';
    smartError.textContent = '';
    smartError.hidden = true;
    errRole.hidden = true;
    roleEl.style.borderColor = '';
    smartBarFill.style.width = '0%';
    smartElapsed.textContent = '0.0s';
  }

  function renderSmart() {
    var isCreate = !!drawerState && drawerState.mode === 'create';
    // 草稿态由抽屉里的草稿 banner 接管，收起智能创建框，避免留下一个空壳
    smartSection.hidden = !isCreate || smartPhase === 'draft';
    if (!isCreate) {
      smartForm.hidden = false;
      smartGenerating.hidden = true;
      draftEditor.hidden = true;
      draftFields.hidden = false;
      bodyManual.hidden = false;
      drawerSave.disabled = false;
      return;
    }

    var generating = smartPhase === 'generating';
    var drafting = smartPhase === 'draft';

    smartForm.hidden = generating || drafting;
    smartGenerating.hidden = !generating;
    draftEditor.hidden = !drafting;
    draftFields.hidden = drafting && rawMode;
    bodyManual.hidden = drafting && !rawMode;
    btnRawToggle.textContent = rawMode ? '改回分字段编辑' : '改为 Markdown 编辑';
    btnGenerate.textContent = smartPhase === 'error' ? '重试生成' : '生成草稿';
    smartError.hidden = smartPhase !== 'error';

    // 生成期间锁住整张表单，避免边生成边改
    [nameEl, descEl, bodyEl, smartPrompt].forEach(function (el) { el.disabled = generating; });
    Array.prototype.forEach.call(smartChips.querySelectorAll('button'), function (btn) { btn.disabled = generating; });
    drawerSave.disabled = generating;
  }

  function buildDraft(prompt) {
    var text = prompt.replace(/\s+/g, ' ').trim();
    var shortText = text.length > 40 ? text.slice(0, 40) + '…' : text;
    var draft = {
      name: text.slice(0, 12),
      description: '按一句话需求生成的草稿：' + shortText,
      role: '你是' + text + '。\n先确认目标、范围与验收标准，再按要求给出可执行的结果。',
      tone: '直接、具体。先给结论，再给依据与下一步；不确定的地方明确说出来。',
      boundary: '- 不编造事实、出处或数据，不确定就说不确定\n- 不越过用户给定的范围自行扩写\n- 删除、发布、覆盖等不可逆操作先确认再动手',
      domain: '与上述职责直接相关的任务；超出范围的请求先说明边界，把选择权交回用户。',
    };

    if (/评审|审查|review/i.test(text)) {
      return {
        name: '严格代码评审',
        description: '按正确性优先的口径评审代码，区分「会出错」与「风格偏好」。',
        role: '你是严格的代码评审者。逐处检查正确性、边界条件与可复现性，不放过「看起来对」的写法。',
        tone: '就事论事，不客套；先列会出错的问题，再谈风格。',
        boundary: '- 每条问题必须能指出文件与行号\n- 区分「会导致错误」与「风格偏好」，不把后者说成缺陷\n- 没有证据的怀疑标为「待验证」，不下结论',
        domain: '代码评审、重构风险评估、可复现验证步骤设计。',
      };
    }
    if (/文档|编辑|撰写|笔记|说明/i.test(text)) {
      return {
        name: '技术文档编辑',
        description: '把口语化笔记改写成可直接发布的说明文档。',
        role: '你是严谨的技术文档编辑。把口语化、跳跃的原始笔记整理成结构清晰、可直接发布的说明。',
        tone: '冷静、克制；用短句，不堆形容词。',
        boundary: '- 不改动原意，不替作者补充未提供的结论\n- 术语首次出现给出一句解释\n- 保留原文里的限制与风险提示，不为了通顺删掉',
        domain: '发布说明、使用指南、变更日志与内部知识页的结构化改写。',
      };
    }
    if (/导师|教学|新手|入门|讲解|学习/i.test(text)) {
      return {
        name: '新手导师',
        description: '一次只讲一个概念，配可动手的练习。',
        role: '你是有耐心的新手导师。先确认学习者已经会什么，再决定从哪里讲起。',
        tone: '鼓励但不吹捧；术语出现时立刻用日常语言解释。',
        boundary: '- 一次只引入一个新概念，不一口气铺开\n- 不跳过前置知识，不假设对方「应该懂」\n- 练习必须给出可自行判断对错的检查方式',
        domain: '入门教学、概念拆解、循序渐进的练习设计。',
      };
    }
    if (/数据|SQL|指标|报表|分析/i.test(text)) {
      return {
        name: '数据分析师',
        description: '先对齐指标口径，再给结论与可复核的查询。',
        role: '你是数据分析师。分析前先对齐指标定义、时间口径与数据来源。',
        tone: '精确、可复核；结论后面紧跟数据范围与前提。',
        boundary: '- 不臆造字段与数值，缺数据就说缺\n- 相关不等于因果，表述必须区分\n- 图表只保留能回答当前问题的维度',
        domain: '指标口径、SQL 审阅、可视化选型与结论归纳。',
      };
    }
    return draft;
  }

  function composeBody() {
    var parts = ['## 角色', roleEl.value.trim()];
    var tone = toneEl.value.trim();
    var boundary = boundaryEl.value.trim();
    var domain = domainEl.value.trim();
    if (tone) parts.push('## 语气', tone);
    if (boundary) parts.push('## 边界与禁忌', boundary);
    if (domain) parts.push('## 擅长领域', domain);
    return parts.join('\n\n');
  }

  /** 从 Markdown 原文回读四段；缺某段则返回 null（保留字段里已有的值） */
  function parseSections(md) {
    var keys = { '角色': 'role', '语气': 'tone', '边界与禁忌': 'boundary', '擅长领域': 'domain' };
    var out = { role: null, tone: null, boundary: null, domain: null };
    var current = null;
    var buf = [];
    function flush() {
      if (current) out[current] = buf.join('\n').trim();
    }
    md.split(/\r?\n/).forEach(function (line) {
      var m = /^##\s+(.+?)\s*$/.exec(line);
      if (m) {
        flush();
        current = keys[m[1]] || null;
        buf = [];
      } else if (current) {
        buf.push(line);
      }
    });
    flush();
    return out;
  }

  function updateGenProgress() {
    var ms = Date.now() - genStart;
    smartElapsed.textContent = (Math.min(ms, GEN_MS) / 1000).toFixed(1) + 's';
    smartBarFill.style.width = Math.min(100, (ms / GEN_MS) * 100) + '%';
  }

  function applyDraft(draft) {
    roleEl.value = draft.role;
    toneEl.value = draft.tone;
    boundaryEl.value = draft.boundary;
    domainEl.value = draft.domain;
    if (!nameEl.value.trim()) {
      nameEl.value = draft.name;
      draftAuto.name = true;
    }
    if (!descEl.value.trim()) {
      descEl.value = draft.description;
      draftAuto.desc = true;
    }
    bodyEl.value = composeBody();
    rawMode = false;
    smartPhase = 'draft';
    renderSmart();
    toast('草稿已生成，可逐段修改后保存');
  }

  function startGenerate() {
    if (smartPhase === 'generating') return;
    var text = smartPrompt.value.trim();
    if (!text) {
      smartPhase = 'error';
      smartError.textContent = '先用一句话描述你要的人设，再生成草稿。';
      renderSmart();
      smartPrompt.focus();
      return;
    }

    smartError.hidden = true;
    smartPhase = 'generating';
    renderSmart();

    genStart = Date.now();
    updateGenProgress();
    genTicker = window.setInterval(updateGenProgress, 80);
    genTimer = window.setTimeout(function () {
      var shouldFail = failDemo;
      if (shouldFail) {
        failDemo = false;
        syncFailBtn();
      }
      clearGenTimer();
      if (shouldFail) {
        smartPhase = 'error';
        smartError.textContent = '生成失败：演示开关已打开（真实实现对应 502 / 504 超时）。可重试，也可以直接手填。';
        renderSmart();
        toast('草稿生成失败，可重试或改用手动填写');
        return;
      }
      applyDraft(buildDraft(text));
    }, GEN_MS);
  }

  function cancelGenerate() {
    if (smartPhase !== 'generating') return;
    clearGenTimer();
    smartPhase = 'idle';
    renderSmart();
    toast('已取消生成');
  }

  function discardDraft() {
    if (draftAuto.name) nameEl.value = '';
    if (draftAuto.desc) descEl.value = '';
    roleEl.value = '';
    toneEl.value = '';
    boundaryEl.value = '';
    domainEl.value = '';
    bodyEl.value = '';
    rawMode = false;
    smartPhase = 'idle';
    renderSmart();
    toast('已放弃草稿，回到手动填写');
  }

  function toggleRawMode() {
    if (smartPhase !== 'draft') return;
    if (!rawMode) {
      bodyEl.value = composeBody();
    } else {
      var parsed = parseSections(bodyEl.value);
      if (parsed.role !== null) roleEl.value = parsed.role;
      if (parsed.tone !== null) toneEl.value = parsed.tone;
      if (parsed.boundary !== null) boundaryEl.value = parsed.boundary;
      if (parsed.domain !== null) domainEl.value = parsed.domain;
    }
    rawMode = !rawMode;
    renderSmart();
  }

  // ---- 抽屉 ----
  function setDrawerReadonly(readonly) {
    [nameEl, descEl, bodyEl].forEach(function (el) {
      el.disabled = readonly;
    });
    drawerReadonly.hidden = !readonly;
    drawerSave.hidden = readonly;
    drawerCancel.textContent = readonly ? '关闭' : '取消';
  }

  function clearFieldErrors() {
    errName.hidden = true;
    errBody.hidden = true;
    errRole.hidden = true;
    nameEl.style.borderColor = '';
    bodyEl.style.borderColor = '';
    roleEl.style.borderColor = '';
  }

  function openDrawer(mode, id) {
    drawerState = { mode: mode, id: id || null };
    clearFieldErrors();
    resetSmart();

    var p = mode === 'edit' ? personas.filter(function (x) { return x.id === id; })[0] : null;
    var readonly = !!p && p.source === 'builtin';
    drawerTitle.textContent = mode === 'create'
      ? '新建人设'
      : readonly ? '查看内置人设' : '编辑人设';
    nameEl.value = p ? p.name : '';
    descEl.value = p ? p.description : '';
    bodyEl.value = p ? p.body_md : '';
    setDrawerReadonly(readonly);
    renderSmart();

    scrimEl.classList.add('is-open');
    drawerEl.classList.add('is-open');
    if (!readonly) window.setTimeout(function () { nameEl.focus(); }, 60);
  }

  function closeDrawer() {
    clearGenTimer();
    drawerState = null;
    scrimEl.classList.remove('is-open');
    drawerEl.classList.remove('is-open');
  }

  function saveDrawer() {
    if (!drawerState) return;
    clearFieldErrors();

    var drafting = drawerState.mode === 'create' && smartPhase === 'draft';
    var name = nameEl.value.trim();
    var desc = descEl.value.trim();
    var bodyMd = drafting
      ? (rawMode ? bodyEl.value.trim() : composeBody())
      : bodyEl.value.trim();
    var bad = false;

    if (!name) {
      errName.hidden = false;
      nameEl.style.borderColor = 'var(--ab-del)';
      bad = true;
    }
    if (drafting && !rawMode && !roleEl.value.trim()) {
      errRole.hidden = false;
      roleEl.style.borderColor = 'var(--ab-del)';
      bad = true;
    }
    if (!bodyMd) {
      errBody.hidden = false;
      bodyEl.style.borderColor = 'var(--ab-del)';
      bad = true;
    }
    if (bad) return;

    if (drawerState.mode === 'create') {
      personas.unshift({
        id: 'p-user-' + Date.now(),
        name: name,
        source: 'user',
        description: desc,
        body_md: bodyMd,
        package_path: null,
        created_at: TODAY,
      });
      toast('已新建人设「<strong>' + escapeHtml(name) + '</strong>」');
    } else {
      personas = personas.map(function (p) {
        if (p.id !== drawerState.id) return p;
        return Object.assign({}, p, { name: name, description: desc, body_md: bodyMd });
      });
      toast('已保存人设「<strong>' + escapeHtml(name) + '</strong>」');
    }

    closeDrawer();
    renderList();
  }

  // ---- 删除确认 ----
  function openConfirm(id) {
    var p = personas.filter(function (x) { return x.id === id; })[0];
    if (!p || p.source === 'builtin') return;
    confirmId = id;
    confirmText.textContent = '「' + p.name + '」删除后不可恢复，也不会同步到已经绑定它的会话。';
    scrimEl.classList.add('is-open');
    confirmLayer.classList.add('is-open');
  }

  function closeConfirm() {
    confirmId = null;
    confirmLayer.classList.remove('is-open');
    if (!drawerEl.classList.contains('is-open')) scrimEl.classList.remove('is-open');
  }

  function doDelete() {
    if (!confirmId) return;
    var p = personas.filter(function (x) { return x.id === confirmId; })[0];
    personas = personas.filter(function (x) { return x.id !== confirmId; });
    closeConfirm();
    renderList();
    toast('已删除人设「<strong>' + escapeHtml(p ? p.name : '') + '</strong>」');
  }

  // ---- 导入 ----
  function openImport() {
    importError.hidden = true;
    importError.textContent = '';
    if (!importPath.value) importPath.value = 'D:\\WorkBuddy\\packages\\data-analyst';
    scrimEl.classList.add('is-open');
    importLayer.classList.add('is-open');
  }

  function closeImport() {
    importLayer.classList.remove('is-open');
    if (!drawerEl.classList.contains('is-open') && !confirmLayer.classList.contains('is-open')) {
      scrimEl.classList.remove('is-open');
    }
  }

  function doImport() {
    importError.hidden = true;
    var path = importPath.value.trim();
    if (!path) {
      importError.textContent = '请填写专家包目录（绝对路径优先）。';
      importError.hidden = false;
      return;
    }

    if (importResult === 'conflict') {
      // 服务端 409 原文展示，界面不做二次包装
      importError.textContent = '同名专家包「用研小队」已导入过（团队 3f1c9a2e），不重复导入';
      importError.hidden = false;
      return;
    }

    personas.unshift({
      id: 'p-import-' + Date.now(),
      name: '用户研究员',
      source: 'import',
      description: '从 WorkBuddy 专家包导入：访谈提纲、可用性测试与结论归纳。',
      body_md: '你是用户研究员。\n\n- 访谈先写目标与问题清单；\n- 结论必须有原始观察支撑；\n- 输出按「发现 → 证据 → 建议」组织。',
      package_path: path,
      created_at: TODAY,
    });
    closeImport();
    renderList();
    toast('已导入 <strong>1</strong> 个人设（用户研究员）· 团队模板「用研小队」');
  }

  // ---- 顶部控制条（非产品 UI） ----
  function initChrome() {
    var isDark = false;
    var themeBtn = document.getElementById('btn-theme');
    themeBtn.addEventListener('click', function () {
      isDark = !isDark;
      document.documentElement.classList.toggle('dark', isDark);
      themeBtn.setAttribute('aria-pressed', String(isDark));
      themeBtn.textContent = isDark ? '浅色' : '深色';
    });

    document.getElementById('btn-empty').addEventListener('click', function () {
      personas = [];
      renderList();
      toast('已清空列表（演示空态）');
    });
    document.getElementById('btn-reset').addEventListener('click', function () {
      personas = clone(SEED);
      renderList();
      toast('已重置为初始 mock 数据');
    });
    document.getElementById('btn-notes').addEventListener('click', function () {
      var visible = notesEl.hidden;
      notesEl.hidden = !visible;
      this.setAttribute('aria-pressed', String(visible));
    });
    document.getElementById('btn-fail').addEventListener('click', function () {
      failDemo = !failDemo;
      syncFailBtn();
      toast(failDemo ? '下次生成将演示失败（一次性）' : '已关闭失败演示');
    });

    if (new URLSearchParams(location.search).get('clean') === '1') {
      document.body.classList.add('clean');
    }
  }

  // ---- 事件绑定 ----
  function bind() {
    document.getElementById('btn-create').addEventListener('click', function () { openDrawer('create'); });
    document.getElementById('btn-empty-create').addEventListener('click', function () { openDrawer('create'); });
    document.getElementById('btn-import').addEventListener('click', openImport);
    document.getElementById('btn-empty-import').addEventListener('click', openImport);

    // 列表行内操作（事件委托）
    listEl.addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-act]');
      if (!btn) return;
      var row = btn.closest('.persona-row');
      if (!row) return;
      var id = row.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') openDrawer('edit', id);
      if (btn.getAttribute('data-act') === 'delete') openConfirm(id);
    });

    drawerCloseBind();
    drawerSave.addEventListener('click', saveDrawer);
    drawerCancel.addEventListener('click', closeDrawer);

    // 智能创建三态
    btnGenerate.addEventListener('click', startGenerate);
    document.getElementById('btn-cancel-generate').addEventListener('click', cancelGenerate);
    document.getElementById('btn-regenerate').addEventListener('click', startGenerate);
    document.getElementById('btn-discard').addEventListener('click', discardDraft);
    btnRawToggle.addEventListener('click', toggleRawMode);
    smartChips.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-chip]');
      if (!chip || smartPhase === 'generating') return;
      smartPrompt.value = chip.getAttribute('data-chip');
      if (smartPhase === 'error') {
        smartPhase = 'idle';
        smartError.textContent = '';
      }
      renderSmart();
    });
    smartPrompt.addEventListener('input', function () {
      if (smartPhase !== 'error') return;
      if (smartError.textContent.indexOf('先用一句话') === 0) {
        smartPhase = 'idle';
        renderSmart();
      }
    });

    confirmLayer.addEventListener('click', function (event) {
      if (event.target === confirmLayer) closeConfirm();
    });
    document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
    document.getElementById('confirm-ok').addEventListener('click', doDelete);

    importLayer.addEventListener('click', function (event) {
      if (event.target === importLayer) closeImport();
    });
    document.getElementById('import-cancel').addEventListener('click', closeImport);
    document.getElementById('import-ok').addEventListener('click', doImport);

    var resultButtons = importLayer.querySelectorAll('[data-import-result]');
    Array.prototype.forEach.call(resultButtons, function (btn) {
      btn.addEventListener('click', function () {
        importResult = btn.getAttribute('data-import-result');
        Array.prototype.forEach.call(resultButtons, function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        importError.hidden = true;
      });
    });

    scrimEl.addEventListener('click', function () {
      if (confirmLayer.classList.contains('is-open')) closeConfirm();
      else if (importLayer.classList.contains('is-open')) closeImport();
      else closeDrawer();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (importLayer.classList.contains('is-open')) closeImport();
      else if (confirmLayer.classList.contains('is-open')) closeConfirm();
      else if (drawerEl.classList.contains('is-open')) closeDrawer();
    });
  }

  function drawerCloseBind() {
    document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  }

  initChrome();
  bind();
  renderList();
})();
