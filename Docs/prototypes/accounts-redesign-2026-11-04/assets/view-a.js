/**
 * 方向 A · 极致极简「台账」视图。
 * 一屏六行，无卡片、无外框、只用发丝线与留白分层；
 * 账号操作默认隐形，靠 hover / 键盘聚焦浮现（触屏设备常显）。
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

  function checkinSignal(appId) {
    var platform = H.platformOf(appId);
    var summary = H.summaryOf(appId);
    if (!platform.capability.checkin) {
      return '<span class="sig sig-idle"><i></i>签到不可用</span>';
    }
    if (summary.total === 0) {
      return '<span class="sig sig-idle"><i></i>暂无参与账号</span>';
    }
    var tone = summary.done === summary.total ? 'sig-done' : summary.done > 0 ? 'sig-partial' : 'sig-idle';
    var mark = summary.unknown > 0
      ? '<sup title="' + summary.unknown + ' 个结果未知，未计入完成">?</sup>'
      : '';
    return '<span class="sig ' + tone + '"><i></i><span class="mono">' + summary.done + '/' + summary.total + '</span>' + mark + '</span>';
  }

  function quotaCell(quota) {
    if (quota.kind === 'credit') {
      return '<span class="q-credit">积分 · 未接入</span>';
    }
    if (quota.kind === 'balance') {
      return '<span class="q-amount mono">¥' + quota.balance.toFixed(2) + '</span><span class="q-unit">余额</span>';
    }
    return '<span class="q-wins">' + quota.windows.map(function (w) {
      var width = pct(w.used, w.total);
      var label = w.limited ? '已限额' : w.used + '/' + w.total;
      return '<span class="q-win" title="' + w.label + ' · ' + w.reset + '">' +
        '<em>' + w.kind + '</em>' +
        '<span class="bar"><i class="' + (w.limited ? 'is-limited' : '') + '" style="width:' + width + '%"></i></span>' +
        '<span class="mono ' + (w.limited ? 'is-limited' : '') + '">' + label + '</span>' +
        '</span>';
    }).join('') + '</span>';
  }

  function lastCheckinText(account) {
    var last = account.lastCheckin;
    if (last && last.status === 'authorized') {
      return '<span class="a-last-authorized">授权中 · 不计完成</span>';
    }
    if (!last || !last.day) {
      return '<span class="a-last-empty">未签到</span>';
    }
    if (last.status === 'unknown') {
      return '<span class="a-last-unknown">' + last.at + ' 结果未知 <b>?</b></span>';
    }
    return '<span>' + last.at + ' ' + (E.labels.status[last.status] || last.status) + '</span>';
  }

  function accountRow(account) {
    var isCurrent = account.isCurrent === true;
    var switching = S.switching === account.id;
    var busy = S.busy[account.appId];
    var participates = H.participates(account);
    var actions = switching
      ? '<span class="a-switching">正在切换…</span>'
      : '<button class="a-act" data-act="switch" data-id="' + account.id + '"' +
          (isCurrent ? ' disabled title="该账号已是客户端当前登录账号"' : '') + '>切换</button>' +
        '<button class="a-act" data-act="checkin-one" data-id="' + account.id + '"' +
          (!participates || busy ? ' disabled' : '') + '>签到</button>' +
        '<button class="a-act a-act-danger" data-act="delete" data-id="' + account.id + '">删除</button>' +
        '<button class="a-act a-act-quiet" data-act="tech" data-id="' + account.id + '">技术</button>';

    var tech = S.techOpen[account.id]
      ? '<div class="a-tech mono' + enterClass('tech:' + account.id) + '">标识 ' + account.hint + ' · 区域 ' + account.region +
        ' · 实例 8f2c91a4… · 快照 v3 · 来源 capture</div>'
      : '';

    var switchConfirm = S.switchConfirm === account.id
      ? '<div class="a-confirm is-switch' + enterClass('switch:' + account.id) + '" role="group" aria-label="确认切换账号">' +
          '<div class="a-confirm-text">切换到「' + account.name + '」作为桌面客户端登录账号？切换会重启目标客户端，进行中的会话可能中断。</div>' +
          '<div class="a-confirm-actions">' +
            '<button class="a-confirm-yes" data-act="switch-yes" data-id="' + account.id + '">确认切换</button>' +
            '<button class="a-act a-act-quiet" data-act="switch-no" data-id="' + account.id + '">取消</button>' +
          '</div>' +
        '</div>'
      : '';

    var confirm = S.pendingDelete === account.id
      ? '<div class="a-confirm' + enterClass('delete:' + account.id) + '" role="group" aria-label="确认删除账号记录">' +
          '<div class="a-confirm-text">删除「' + account.name + '」的本地记录？只清 AgentBoard 元数据与 DPAPI 快照，不会退出客户端登录。' +
          (isCurrent ? '<b>该账号是当前客户端登录账号。</b>' : '') + '</div>' +
          '<div class="a-confirm-actions">' +
            '<button class="a-confirm-yes" data-act="delete-yes" data-id="' + account.id + '">确认删除</button>' +
            '<button class="a-act a-act-quiet" data-act="delete-no" data-id="' + account.id + '">取消</button>' +
            '<span class="a-confirm-timer" aria-hidden="true"></span>' +
          '</div>' +
        '</div>'
      : '';

    var error = S.deleteError && S.deleteError.accountId === account.id
      ? '<div class="a-error' + enterClass('err:' + account.id) + '" role="alert">' +
          '<span>' + H.deleteFailLabel(S.deleteError.code) + '</span>' +
          '<details><summary>技术码</summary><code class="mono">' + S.deleteError.code + '</code></details>' +
          '<button class="a-act a-act-quiet" data-act="dismiss-error">知道了</button>' +
        '</div>'
      : '';

    return '<div class="arow' + (account.enabled === false ? ' is-off' : '') + '">' +
      '<div class="a-id">' +
        '<span class="a-name">' + account.name + '</span>' +
        '<span class="a-hint mono">' + account.hint + '</span>' +
        (isCurrent ? '<span class="a-flag">客户端当前</span>' : '') +
        (account.enabled === false ? '<span class="a-flag is-muted">已停用</span>' : '') +
        (!participates && account.enabled !== false ? '<span class="a-flag is-quiet" title="不参与一键签到">不参与签到</span>' : '') +
      '</div>' +
      '<div class="a-last">' + lastCheckinText(account) + '</div>' +
      '<div class="a-do">' + actions + '</div>' +
      tech + switchConfirm + confirm + error +
    '</div>';
  }

  function batchPanel(appId) {
    var batch = H.batchOf(appId);
    if (!batch) return '';
    if (S.batchHidden[appId]) {
      return '<button class="run-restore" data-act="show-batch" data-id="' + appId + '">批次 ' +
        batch.id.slice(0, 7) + ' · 查看结果</button>';
    }
    var active = batch.status === 'running';
    var doneCount = batch.items.filter(function (i) {
      return i.state === 'succeeded' || i.state === 'already_done';
    }).length;
    var stateLabel = active ? '进行中' : batch.status === 'succeeded' ? '全部完成' : batch.status === 'failed' ? '失败' : '部分完成';
    var items = batch.items.map(function (item) {
      var account = H.accountOf(item.accountId);
      var label = item.state === 'queued' ? '排队中' : item.state === 'running' ? '已发出请求' :
        (E.labels.status[item.state] || item.state);
      return '<li class="run-item" data-state="' + item.state + '">' +
        '<span class="rdot"></span>' +
        '<span class="rname">' + (account ? account.name : item.accountId) + '</span>' +
        '<span class="rstate">' + label + '</span>' +
        (item.state === 'unknown' ? '<span class="rq">?</span>' : '') +
      '</li>';
    }).join('');

    return '<div class="run' + (active ? ' is-live' : '') + enterClass('batch:' + appId) + '">' +
      '<div class="run-head">' +
        '<span class="run-dot"></span>' +
        '<span class="run-title">签到批次</span>' +
        '<span class="run-state">' + stateLabel + '</span>' +
        '<span class="mono run-id">' + batch.id.slice(0, 8) + '</span>' +
        '<span class="run-count mono">' + doneCount + '/' + batch.items.length + '</span>' +
        '<button class="run-collapse" data-act="hide-batch" data-id="' + appId + '">收起</button>' +
      '</div>' +
      '<ul class="run-items">' + items + '</ul>' +
      (active ? '' : '<p class="run-note">完成口径：成功与今日已完成计入；结果未知的账号标 ? 不计入；失败落回未签到。</p>') +
    '</div>';
  }

  function platformRow(platform) {
    if (platform.category === 'quota') {
      return '<div class="prow is-quota">' +
        '<div class="prow-line">' +
          '<span class="p-main is-static">' +
            '<span class="glyph">' + platform.glyph + '</span>' +
            '<span class="pname">' + platform.name + '</span>' +
          '</span>' +
          '<div class="p-quota">' + quotaCell(platform.quota) + '</div>' +
          '<div class="p-status"></div>' +
          '<div class="p-act"></div>' +
        '</div>' +
      '</div>';
    }

    var open = S.open[platform.id] === true;
    var accounts = H.accountsOf(platform.id);
    var busy = S.busy[platform.id];
    var body = open
      ? '<div class="pbody' + enterClass('app:' + platform.id) + '">' +
          '<div class="pbody-head">' +
            '<span class="pbody-count">' + accounts.length + ' 个账号 · ' +
              accounts.filter(H.participates).length + ' 个参与签到</span>' +
            '<button class="pbody-link" data-act="capture" data-id="' + platform.id + '">捕获当前账号</button>' +
          '</div>' +
          (accounts.length === 0
            ? '<p class="pempty">尚无账号。点「读取本机账号」或「捕获当前账号」后列出。</p>'
            : '<div class="arows">' + accounts.map(accountRow).join('') + '</div>') +
          batchPanel(platform.id) +
        '</div>'
      : '';

    return '<div class="prow' + (open ? ' is-open' : '') + '" data-app="' + platform.id + '">' +
      '<div class="prow-line">' +
        '<button class="p-main" data-act="toggle-app" data-id="' + platform.id + '" aria-expanded="' + open + '">' +
          '<span class="caret">' + window.icon('chevron-right', 14) + '</span>' +
          '<span class="glyph">' + platform.glyph + '</span>' +
          '<span class="pname">' + platform.name + '</span>' +
        '</button>' +
        '<div class="p-quota">' + quotaCell(platform.quota) + '</div>' +
        '<div class="p-status">' + checkinSignal(platform.id) + '</div>' +
        '<div class="p-act">' +
          '<button class="p-checkin" data-act="checkin" data-id="' + platform.id + '"' +
            (busy ? ' disabled' : '') + '>' + (busy ? '发起中…' : '签到') + '</button>' +
        '</div>' +
      '</div>' +
      body +
    '</div>';
  }

  function skeleton() {
    var rows = '';
    for (var i = 0; i < 6; i += 1) {
      rows += '<div class="prow is-skeleton"><div class="prow-line">' +
        '<span class="sk sk-name"></span><span class="sk sk-quota"></span><span class="sk sk-chip"></span>' +
        '</div></div>';
    }
    return '<div class="ledger">' + rows + '</div>';
  }

  function render() {
    if (!S.modalOpen) {
      root.innerHTML = '<div class="stage"><div class="closed">' +
        '<p>账号管理已关闭</p>' +
        '<button class="btn btn-solid" data-act="reopen">重新打开</button>' +
        '</div></div>';
      return;
    }

    var today = H.todaySummary();
    var todayPct = today.total ? Math.round((today.done / today.total) * 100) : 0;
    var rows = S.loading ? skeleton() : S.platforms.map(platformRow).join('');
    var accountsCount = S.accounts.length;

    root.innerHTML =
      '<div class="stage">' +
        '<div class="stage-wash" aria-hidden="true"></div>' +
        '<section class="modal' + (firstPaint ? ' is-fresh' : '') + '" role="dialog" aria-modal="true" aria-labelledby="a-title">' +
          '<div class="topline" aria-hidden="true"></div>' +
          '<header class="mast">' +
            '<div class="mast-id">' +
              '<p class="kicker">账户与额度台账</p>' +
              '<h1 id="a-title">账号管理</h1>' +
              '<p class="mast-sub">' + (S.loading ? '读取中…' : accountsCount + ' 个托管账号 · 6 个平台 · 本地记录') + '</p>' +
            '</div>' +
            '<div class="mast-tools">' +
              '<div class="today" title="今日已完成 / 参与签到账号（本地记录）">' +
                '<span class="today-label">今日</span>' +
                '<span class="today-num mono"><b>' + today.done + '</b><span>/' + today.total + '</span></span>' +
                '<span class="today-bar"><i style="width:' + todayPct + '%"></i></span>' +
              '</div>' +
              '<button class="btn btn-solid" data-act="checkin-all">一键签到</button>' +
              '<button class="btn btn-text" data-act="import">读取本机账号</button>' +
              '<button class="xbtn" data-act="close" aria-label="关闭账号管理">' + window.icon('x', 16) + '</button>' +
            '</div>' +
          '</header>' +
          '<div class="ledger">' +
            '<div class="ledger-head"><span>平台</span><span>额度</span><span class="is-center">今日</span><span></span></div>' +
            rows +
          '</div>' +
          '<footer class="foot">仅展示脱敏元数据；快照、凭据与 token 不出现在界面 · 原型数据为模拟</footer>' +
        '</section>' +
        (S.toast ? '<div class="toast' + enterClass('toast') + '" role="status">' + S.toast.text + '</div>' : '') +
      '</div>';

    lastAnim = S.animKey;
    firstPaint = false;
  }

  /* 事件委托：统一从 data-act 分发；重渲染后保留焦点 */
  root.addEventListener('click', function (event) {
    var el = event.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');

    switch (act) {
      case 'toggle-app': A.toggleApp(id); break;
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
      case 'close': A.closeModal(); break;
      case 'reopen': A.reopenModal(); break;
      default: break;
    }

    // 重渲染后把焦点还给同一动作的按钮（行被删除时自然找不到）
    var selector = '[data-act="' + act + '"]' + (id ? '[data-id="' + id + '"]' : '');
    var restored = root.querySelector(selector);
    if (restored && typeof restored.focus === 'function') restored.focus();
  });

  E.subscribe(render);
  render();
  A.init();
})();
