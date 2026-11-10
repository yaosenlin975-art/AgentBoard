/* 看板顶栏重绘原型 · 交互（纯静态，无依赖） */
(function () {
  'use strict';

  var shell = document.getElementById('app-shell');
  var stage = document.getElementById('stage');
  var memo = document.getElementById('memo');
  var filterBtn = document.getElementById('btn-filters');
  var filterPanel = document.getElementById('filter-panel');
  var closeFilterBtn = document.getElementById('btn-close-filters');

  var params = new URLSearchParams(location.search);

  var state = {
    direction: params.get('d') === 'b' ? 'b' : 'a',
    sidebar: params.get('sb') === 'collapsed' ? 'collapsed' : 'expanded',
    narrow: params.get('narrow') === '1',
    dark: params.get('theme') === 'dark',
    reduce: params.get('reduce') === '1',
    filtersOpen: false
  };

  if (params.get('clean') === '1') document.body.classList.add('clean');

  function apply() {
    shell.dataset.direction = state.direction;
    shell.dataset.sidebar = state.sidebar;
    shell.dataset.narrow = state.narrow ? '1' : '0';
    shell.dataset.reduce = state.reduce ? '1' : '0';
    document.documentElement.classList.toggle('dark', state.dark);
    stage.classList.toggle('is-narrow', state.narrow);

    document.querySelectorAll('.proto-btn[data-direction]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.direction === state.direction));
    });
    document.querySelectorAll('.proto-btn[data-sidebar]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.sidebar === state.sidebar));
    });
    document.getElementById('btn-narrow').setAttribute('aria-pressed', String(state.narrow));
    document.getElementById('btn-theme').setAttribute('aria-pressed', String(state.dark));
    document.getElementById('btn-reduce').setAttribute('aria-pressed', String(state.reduce));

    memo.textContent = '方向 ' + state.direction.toUpperCase() +
      ' · 顶栏 ' + (state.direction === 'a' ? '46px' : '40px') +
      ' · 侧栏 ' + (state.sidebar === 'expanded' ? '176px' : '56px') +
      (state.narrow ? ' · 窄屏 900' : '');

    applyFilterCount();
  }

  function activeChips() {
    return document.querySelectorAll('.tb-b .chip.is-on').length;
  }

  function applyFilterCount() {
    var n = activeChips();
    var badge = filterBtn.querySelector('.tb-filter-count');
    badge.textContent = String(n);
    badge.style.display = n > 0 ? '' : 'none';
  }

  function setFilters(open) {
    state.filtersOpen = open;
    filterPanel.hidden = !open;
    filterBtn.setAttribute('aria-expanded', String(open));
  }

  /* 控制条 */
  document.querySelectorAll('.proto-btn[data-direction]').forEach(function (b) {
    b.addEventListener('click', function () { state.direction = b.dataset.direction; setFilters(false); apply(); });
  });
  document.querySelectorAll('.proto-btn[data-sidebar]').forEach(function (b) {
    b.addEventListener('click', function () { state.sidebar = b.dataset.sidebar; apply(); });
  });
  document.getElementById('btn-narrow').addEventListener('click', function () { state.narrow = !state.narrow; apply(); });
  document.getElementById('btn-theme').addEventListener('click', function () { state.dark = !state.dark; apply(); });
  document.getElementById('btn-reduce').addEventListener('click', function () { state.reduce = !state.reduce; apply(); });

  /* 侧栏折叠按钮（产品行为） */
  document.querySelector('.sb-toggle').addEventListener('click', function () {
    state.sidebar = state.sidebar === 'expanded' ? 'collapsed' : 'expanded';
    apply();
  });

  /* 方向 B 浮层 */
  filterBtn.addEventListener('click', function () { setFilters(!state.filtersOpen); });
  closeFilterBtn.addEventListener('click', function () { setFilters(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.filtersOpen) { setFilters(false); filterBtn.focus(); }
  });
  document.addEventListener('click', function (e) {
    if (!state.filtersOpen) return;
    if (filterPanel.contains(e.target) || filterBtn.contains(e.target)) return;
    setFilters(false);
  });

  /* chips 多选（A 条内 / B 浮层内共用同一份选中态） */
  document.querySelectorAll('.chip').forEach(function (chip) {
    if (chip.classList.contains('chip-more')) return;
    chip.removeAttribute('aria-pressed');
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-pressed', String(chip.classList.contains('is-on')));
    chip.addEventListener('click', function () {
      chip.classList.toggle('is-on');
      var on = chip.classList.contains('is-on');
      chip.setAttribute('aria-pressed', String(on));
      var text = chip.firstChild ? chip.firstChild.textContent : '';
      document.querySelectorAll('.chip').forEach(function (other) {
        if (other === chip || other.classList.contains('chip-more')) return;
        var t = other.firstChild ? other.firstChild.textContent : '';
        if (t === text) {
          other.classList.toggle('is-on', on);
          other.setAttribute('aria-pressed', String(on));
        }
      });
      applyFilterCount();
    });
  });

  /* 清除筛选（B 浮层） */
  document.querySelectorAll('.tb-link').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tb-b .chip.is-on').forEach(function (c) {
        c.classList.remove('is-on');
        c.setAttribute('aria-pressed', 'false');
      });
      applyFilterCount();
    });
  });

  /* 选择态 */
  document.querySelectorAll('.tb-actions .tb-btn:not(.tb-btn--filter)').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? '取消选择' : '选择';
    });
  });

  apply();
})();
