/**
 * 方向 B · 卡片信息分层「工作台」视图。
 * 左栏平台索引（六平台常驻）→ 右侧单平台工作区（账号卡片三级披露）。
 */
(function () {
  var E = window.Engine;
  var H = E.helpers;
  var A = E.actions;
  var S = E.state;
  var root = document.getElementById('view');
  var lastAnim = '';
  var firstPaint = true;

  function enterClass(prefix) {
    if (!S.animKey || S.animKey === lastAnim) return '';
    return S.animKey.indexOf(prefix + ':') === 0 ? ' is-enter' : '';
  }

  function pct(used, total) {
    if (!total) return 0;
    return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  }

  function checkinLabel(appId) {
    var platform = H.platformOf(appId);
    if (!platform.capability.checkin) return '签到不可用';
    var s = H.summaryOf(appId);
    if (s.total === 0) return '无参与账号';
    return s.done + '/' + s.total + (s.unknown > 0 ? ' ?' : '');
  }

  function checkinTone(appId) {
    var platform = H.platformOf(appId);
    if (!platform.capability.checkin) return 'idle';
    var s = H.summaryOf(appId);
    if (s.total === 0) return 'idle';
    if (s.done === s.total) return 'ok';
    if (s.done > 0) return 'warn';
    return 'idle';
  }

  function railMetric(platform) {
    if (platform.category === 'quota') {
      if (platform.quota.kind === 'balance') return '<span class="mono">¥' + platform.quota.balance.toFixed(2) + '</span>';
      var first = platform.quota.windows[0];
      return '<span class="mono">' + first.kind + ' · ' + pct(first.used, first.total) + '%</span>';
    }
    var tone = checkinTone(platform.id);
    return '<span class="rail-check" data-tone="' + tone + '">' + checkinLabel(platform.id) + '</span>';
  }

  function railItem(platform) {
    var active = S.selected === platform.id;
    var windows = platform.category === 'quota' && platform.quota.kind === 'windows' ? platform.quota.windows : null;
    var bar = windows
      ? '<span class="rail-bar"><i class="' + (windows[0].limited ? 'is-limited' : '') +
        '" style="width:' + pct(windows[0].used, windows[0].total) + '%"></i></span>'
      : '';
    return '<button class="rail-item' + (active ? ' is-active' : '') + '" data-act="select" data-id="' + platform.id + '">' +
      '<span class="rail-glyph" data-app="' + platform.id + '">' + platform.glyph + '</span>' +
      '<span class="rail-text">' +
        '<span class="rail-name">' + platform.name + '</span>' +
        '<span class="rail-metric">' + railMetric(platform) + '</span>' +
        bar +
      '</span>' +
      (active ? '<span class="rail-active-mark" aria-hidden="true"></span>' : '') +
    '</button>';
  }

  function quotaDetail(platform) {
    var q = platform.quota;
    if (q.kind === 'balance') {
      return '<section class="q-panel">' +
        '<p class="q-eyebrow">账户余额</p>' +
        '<p class="q-big mono">¥' + q.balance.toFixed(2) + '</p>' +
        '<p class="q-sub">余额 · 更新于 ' + q.fetchedAt + ' · 服务端 60s 缓存</p>' +
      '</section>' +
      '<p class="pane-note">该来源只提供额度，不托管账号，也不参与签到。账密与调用凭证不在本界面展示。</p>';
    }
    if (q.kind === 'credit') {
      return '<section class="q-panel is-placeholder">' +
        '<p class="q-eyebrow">积分</p>' +
        '<div class="q-placeholder"><span>积分 · 未接入</span></div>' +
        '<p class="q-sub">本轮仅占位，读取接口未接入；结构已预留，接入后原位置直接替换为数值与进度。</p>' +
      '</section>';
    }
    return '<section class="q-panel">' +
      '<p class="q-eyebrow">时间窗口限额</p>' +
      '<div class="q-rows">' + q.windows.map(function (w) {
        var width = pct(w.used, w.total);
        return '<div class="q-row">' +
          '<span class="q-label">' + w.label + '</span>' +
          '<span class="q-bar"><i class="' + (w.limited ? 'is-limited' : '') + '" style="width:' + width + '%"></i></span>' +
          '<span class="q-num mono ' + (w.limited ? 'is-limited' : '') + '">' +
            (w.limited ? '已限额' : w.used + ' / ' + w.total) + '</span>' +
          '<span class="q-reset">' + w.reset + '</span>' +
        '</div>';
      }).join('') + '</div>' +
      '<p class="q-sub">更新于 ' + q.fetchedAt + ' · 服务端 60s 缓存 · 进度条为已用占比</p>' +
    '</section>' +
    '<p class="pane-note">该来源只提供额度，不托管账号，也不参与签到。</p>';
  }

  function lastLine(account) {
    var last = account.lastCheckin;
    if (last && last.status === 'authorized') {
      return '<span class="last authorized">授权中 · 不计入今日完成</span>';
    }
    if (!last || !last.day) {
      return '<span class="last empty">未签到</span>';
    }
    if (last.status === 'unknown') {
      return '<span class="last unknown">' + last.at + ' 结果未知 <b>?</b></span>';
    }
    return '<span class="last">' + last.at + ' ' + (E.labels.status[last.status] || last.status) + '</span>';
  }

  function accountCard(account) {
    var isCurrent = account.isCurrent === true;
    var switching = S.switching === account.id;
    var participates = H.participates(account);
    var busy = S.busy[account.appId];

    var chips =
      (isCurrent ? '<span class="b-chip b-chip-ok">客户端当前</span>' : '') +
      (account.enabled === false ? '<span class="b-chip b-chip-muted">已停用</span>' : '') +
      (!participates && account.enabled !== false ? '<span class="b-chip b-chip-muted" title="不参与一键签到">不参与签到</span>' : '');

    var actions = switching
      ? '<span class="b-switching"><span class="spin"></span>正在切换…</span>'
      : '<button class="b-btn b-btn-primary b-btn-sm" data-act="switch" data-id="' + account.id + '"' +
          (isCurrent ? ' disabled title="该账号已是客户端当前登录账号"' : '') + '>切换</button>' +
        '<button class="b-btn b-btn-sm" data-act="checkin-one" data-id="' + account.id + '"' +
          (!participates || busy ? ' disabled' : '') + '>签到</button>' +
        '<button class="b-btn-icon" data-act="delete" data-id="' + account.id + '" aria-label="删除 ' + account.name + '" title="删除记录">' +
          window.icon('trash-2', 14) + '</button>';

    var confirm = S.pendingDelete === account.id
      ? '<div class="acard-confirm' + enterClass('delete:' + account.id) + '" role="group" aria-label="确认删除账号记录">' +
          '<p class="acard-confirm-text">删除「' + account.name + '」的本地记录？只清 AgentBoard 元数据与 DPAPI 快照，不会退出客户端登录。' +
          (isCurrent ? '<b>该账号是当前客户端登录账号。</b>' : '') + '</p>' +
          '<div class="acard-confirm-actions">' +
            '<button class="b-btn b-btn-danger b-btn-sm" data-act="delete-yes" data-id="' + account.id + '">确认删除</button>' +
            '<button class="b-btn b-btn-sm" data-act="delete-no" data-id="' + account.id + '">取消</button>' +
            '<span class="countdown" aria-hidden="true"></span>' +
          '</div>' +
        '</div>'
      : '';

    var switchConfirm = S.switchConfirm === account.id
      ? '<div class="acard-confirm is-switch' + enterClass('switch:' + account.id) + '" role="group" aria-label="确认切换账号">' +
          '<p class="acard-confirm-text">切换到「' + account.name + '」作为桌面客户端登录账号？切换会重启目标客户端，进行中的会话可能中断。</p>' +
          '<div class="acard-confirm-actions">' +
            '<button class="b-btn b-btn-primary b-btn-sm" data-act="switch-yes" data-id="' + account.id + '">确认切换</button>' +
            '<button class="b-btn b-btn-sm" data-act="switch-no" data-id="' + account.id + '">取消</button>' +
          '</div>' +
        '</div>'
      : '';

    var error = S.deleteError && S.deleteError.accountId === account.id
      ? '<div class="acard-error' + enterClass('err:' + account.id) + '" role="alert">' +
          '<span>' + window.icon('alert-circle', 14) + H.deleteFailLabel(S.deleteError.code) + '</span>' +
          '<details><summary>技术码</summary><code class="mono">' + S.deleteError.code + '</code></details>' +
          '<button class="b-btn-icon" data-act="dismiss-error" aria-label="关闭提示">' + window.icon('x', 13) + '</button>' +
        '</div>'
      : '';

    var tech = S.techOpen[account.id]
      ? '<div class="acard-tech mono' + enterClass('tech:' + account.id) + '">标识 ' + account.hint + ' · 区域 ' + account.region +
        ' · 实例 8f2c91a4… · 快照 v3 · 来源 capture</div>'
      : '';

    return '<article class="acard' + (account.enabled === false ? ' is-off' : '') + '">' +
      '<div class="acard-top">' +
        '<span class="avatar" data-app="' + account.appId + '">' + account.name.slice(0, 1) + '</span>' +
        '<div class="ident">' +
          '<div class="ident-line"><span class="ident-name">' + account.name + '</span>' + chips + '</div>' +
          '<div class="ident-sub">' +
            '<span class="mono hint">' + account.hint + '</span>' +
            '<span class="sep">·</span>' + lastLine(account) +
          '</div>' +
        '</div>' +
        '<div class="acard-do">' + actions + '</div>' +
      '</div>' +
      '<div class="acard-foot">' +
        '<button class="tech-toggle" data-act="tech" data-id="' + account.id + '">' +
          window.icon('info', 12) + '<span>技术信息</span>' +
        '</button>' +
        (participates ? '<span class="foot-note">参与一键签到</span>' : '') +
      '</div>' +
      tech + switchConfirm + confirm + error +
    '</article>';
  }

  function runPanel(appId) {
    var batch = H.batchOf(appId);
    if (!batch) return '';
    if (S.batchHidden[appId]) {
      return '<button class="run-restore" data-act="show-batch" data-id="' + appId + '">' +
        window.icon('refresh-cw', 13) + '签到批次 ' + batch.id.slice(0, 7) + ' · 查看结果</button>';
    }
    var active = batch.status === 'running';
    var done = batch.items.filter(function (i) {
      return i.state === 'succeeded' || i.state === 'already_done';
    }).length;
    var progress = Math.round((done / batch.items.length) * 100);
    var statusLabel = active ? '进行中' :
      batch.status === 'succeeded' ? '全部完成' : batch.status === 'failed' ? '失败' : '部分完成';

    var items = batch.items.map(function (item) {
      var account = H.accountOf(item.accountId);
      var label = item.state === 'queued' ? '排队中' :
        item.state === 'running' ? '已发出请求' : (E.labels.status[item.state] || item.state);
      return '<li class="run-li" data-state="' + item.state + '">' +
        '<span class="state-dot"></span>' +
        '<span class="run-name">' + (account ? account.name : item.accountId) + '</span>' +
        '<span class="run-state">' + label + '</span>' +
      '</li>';
    }).join('');

    return '<section class="b-run' + (active ? ' is-live' : '') + enterClass('batch:' + appId) + '">' +
      '<header class="b-run-head">' +
        '<span class="live-dot"></span>' +
        '<span class="b-run-title">签到批次</span>' +
        '<span class="b-chip ' + (active ? 'b-chip-warn' : 'b-chip-muted') + '">' + statusLabel + '</span>' +
        '<span class="mono b-run-id">' + batch.id.slice(0, 8) + '</span>' +
        '<span class="b-run-count mono">' + done + '/' + batch.items.length + '</span>' +
        '<button class="b-link" data-act="hide-batch" data-id="' + appId + '">收起</button>' +
      '</header>' +
      '<span class="b-run-bar"><i style="width:' + progress + '%"></i></span>' +
      '<ul class="b-run-items">' + items + '</ul>' +
      (active ? '' : '<p class="b-run-note">成功与今日已完成计入完成；结果未知标 ? 不计入；失败落回未签到；授权中不算完成。</p>') +
    '</section>';
  }

  function paneContent() {
    var platform = H.platformOf(S.selected);
    if (!platform) return '';

    if (platform.category === 'quota') {
      return '<div class="pane-head">' +
        '<div>' +
          '<h2 class="pane-title">' + platform.name + '</h2>' +
          '<p class="pane-sub">额度来源 · 更新于 ' + (platform.quota.fetchedAt || MOCK_UPDATE()) + '</p>' +
        '</div>' +
        '<button class="b-btn b-btn-sm" data-act="refresh-quota">' + window.icon('refresh-cw', 13) + '刷新</button>' +
      '</div>' +
      '<div class="pane-body">' + quotaDetail(platform) + '</div>';
    }

    var accounts = H.accountsOf(platform.id);
    var participating = accounts.filter(H.participates).length;
    return '<div class="pane-head">' +
      '<div>' +
        '<h2 class="pane-title">' + platform.name + '</h2>' +
        '<p class="pane-sub">' + accounts.length + ' 个账号 · ' + participating + ' 个参与签到 · 积分未接入</p>' +
      '</div>' +
      '<div class="pane-actions">' +
        '<button class="b-btn b-btn-sm" data-act="capture" data-id="' + platform.id + '">捕获当前账号</button>' +
        '<button class="b-btn b-btn-primary b-btn-sm" data-act="checkin" data-id="' + platform.id + '"' +
          (S.busy[platform.id] ? ' disabled' : '') + '>' +
          (S.busy[platform.id] ? '发起中…' : '本平台签到') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="pane-body">' +
      runPanel(platform.id) +
      (accounts.length === 0
        ? '<div class="pane-empty">尚无账号。点「读取本机账号」或「捕获当前账号」后列出。</div>'
        : '<div class="acards">' + accounts.map(accountCard).join('') + '</div>') +
      '<p class="pane-note">签到状态来自本地记录，不是平台官方当日状态；删除只清本地记录，不退出客户端登录。</p>' +
    '</div>';
  }

  function MOCK_UPDATE() { return '09:42'; }

  function skeleton() {
    return '<div class="pane-body">' +
      '<div class="acards">' +
      '<div class="acard is-skeleton"><span class="sk sk-avatar"></span><span class="sk sk-line"></span><span class="sk sk-btn"></span></div>' +
      '<div class="acard is-skeleton"><span class="sk sk-avatar"></span><span class="sk sk-line"></span><span class="sk sk-btn"></span></div>' +
      '<div class="acard is-skeleton"><span class="sk sk-avatar"></span><span class="sk sk-line"></span><span class="sk sk-btn"></span></div>' +
      '</div></div>';
  }

  function render() {
    if (!S.modalOpen) {
      root.innerHTML = '<div class="stage"><div class="closed">' +
        '<p>账号管理已关闭</p>' +
        '<button class="b-btn b-btn-primary" data-act="reopen">重新打开</button>' +
        '</div></div>';
      return;
    }

    var today = H.todaySummary();
    var rail = S.loading ? '<div class="rail-skeleton"></div>' :
      S.platforms.map(railItem).join('');
    var pane = S.loading ? skeleton() : paneContent();

    root.innerHTML =
      '<div class="stage">' +
        '<div class="stage-grid" aria-hidden="true"></div>' +
        '<section class="shell' + (firstPaint ? ' is-fresh' : '') + '" role="dialog" aria-modal="true" aria-labelledby="b-title">' +
          '<header class="b-head">' +
            '<div class="b-brand">' +
              '<span class="b-mark">' + window.icon('users', 16) + '</span>' +
              '<div>' +
                '<h1 id="b-title">账号管理</h1>' +
                '<p>' + (S.loading ? '读取中…' : S.accounts.length + ' 个托管账号 · 6 个平台 · 今日 ' + today.done + '/' + today.total + ' 完成') + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="b-tools">' +
              '<button class="b-btn b-btn-sm" data-act="import">' + window.icon('download-cloud', 13) + '读取本机账号</button>' +
              '<button class="b-btn b-btn-primary b-btn-sm" data-act="checkin-all">' + window.icon('square-check', 13) + '一键签到</button>' +
              '<button class="b-btn-icon" data-act="close" aria-label="关闭账号管理">' + window.icon('x', 15) + '</button>' +
            '</div>' +
          '</header>' +
          '<div class="b-body">' +
            '<aside class="rail">' +
              '<div class="rail-head"><span>平台</span><span class="mono">' + (S.loading ? '–' : S.platforms.length) + '</span></div>' +
              rail +
            '</aside>' +
            '<main class="pane">' + pane + '</main>' +
          '</div>' +
        '</section>' +
        (S.toast ? '<div class="b-toast' + enterClass('toast') + '" role="status">' + S.toast.text + '</div>' : '') +
      '</div>';

    lastAnim = S.animKey;
    firstPaint = false;

    var activeRail = root.querySelector('.rail-item.is-active');
    if (activeRail && !S.loading) {
      // 选中平台滚入左栏可视区（用视口矩形比较，避免 offsetParent 差异）
      var railEl = root.querySelector('.rail');
      var rect = activeRail.getBoundingClientRect();
      var railRect = railEl.getBoundingClientRect();
      if (rect.top < railRect.top) {
        railEl.scrollTop -= railRect.top - rect.top + 8;
      } else if (rect.bottom > railRect.bottom) {
        railEl.scrollTop += rect.bottom - railRect.bottom + 8;
      }
    }
  }

  root.addEventListener('click', function (event) {
    var el = event.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');

    switch (act) {
      case 'select': A.selectApp(id); break;
      case 'checkin': A.startCheckin(id); break;
      case 'checkin-one': A.checkinOne(id); break;
      case 'checkin-all': A.startAll(); break;
      case 'switch': A.beginSwitch(id); break;
      case 'switch-yes': A.confirmSwitch(id); break;
      case 'switch-no': A.cancelSwitch(); break;
      case 'delete': A.beginDelete(id); break;
      case 'delete-yes': A.confirmDelete(id); break;
      case 'delete-no': A.cancelDelete(); break;
      case 'tech': A.toggleTech(id); break;
      case 'capture': A.capture(id); break;
      case 'import': A.importLocal(); break;
      case 'hide-batch': A.hideBatch(id); break;
      case 'show-batch': A.showBatch(id); break;
      case 'dismiss-error': A.dismissDeleteError(); break;
      case 'refresh-quota': A.refreshQuota(); break;
      case 'close': A.closeModal(); break;
      case 'reopen': A.reopenModal(); break;
      default: break;
    }

    var selector = '[data-act="' + act + '"]' + (id ? '[data-id="' + id + '"]' : '');
    var restored = root.querySelector(selector);
    if (restored && typeof restored.focus === 'function') restored.focus();
  });

  E.subscribe(render);
  render();
  A.init();
})();
