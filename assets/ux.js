/* ==========================================================================
   ux.js —— 浏览体验增强层
   --------------------------------------------------------------------------
   解决两个核心痛点：
     ① 「单页太长、容易丢失进度」→ 分节阅读系统（逐节模式 + 常驻位置条 + 续读）
     ② 「浏览体验不好」→ 目录 / 专注模式 / 代码复制 / 阅读位置 / 移动导航

   分节系统设计要点：
     • 每章平均 19 节（最多 31 节）、单页 16000–25000px，必须切成可翻的单元
     • 默认「逐节模式」：只展开当前一节，读完点「下一节」→ 自动收起、展开下一节
     • 常驻位置条始终显示「第 X/N 节」，任何时候都不会不知道自己在哪
     • 「展开全部」一键回到整页长滚动（偏好持久化）
     • 深链 / 打印 / Ctrl+F 都会自动展开，避免内容"搜不到"

   本文件依赖 app.js 的 boot 已完成（组件已装配），故在最后加载。
   无依赖，可独立运行（cases.html 等不加载 app.js 的页面同样可用）。
   ========================================================================== */
(function (global) {
  'use strict';

  const doc = document;
  const $  = (s, r) => (r || doc).querySelector(s);
  const $$ = (s, r) => Array.from((r || doc).querySelectorAll(s));

  const reduceMotion = global.matchMedia &&
    global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ 存储 */
  const KEY = 'akkc-ux-v1';
  let mem = null;
  const ux = {
    read() {
      if (mem) return mem;
      try { return JSON.parse(global.localStorage.getItem(KEY)) || {}; }
      catch (e) { mem = {}; return mem; }
    },
    write(d) {
      if (mem) { mem = d; return; }
      try { global.localStorage.setItem(KEY, JSON.stringify(d)); }
      catch (e) { mem = d; }
    },
    get(k, dflt) { const d = this.read(); return d[k] === undefined ? dflt : d[k]; },
    set(k, v) { const d = this.read(); d[k] = v; this.write(d); }
  };

  const chapterNo = doc.body.dataset.chapter
    ? parseInt(doc.body.dataset.chapter, 10) : null;
  const pageKey = chapterNo ? ('ch' + chapterNo) : (location.pathname.split('/').pop() || 'index');
  const isChapter = !!chapterNo;

  /* ==========================================================================
     0. 通用小工具
     ========================================================================== */
  function copyText(text, cb) {
    const done = ok => { try { cb(ok); } catch (e) {} };
    const fb = () => {
      try {
        const ta = doc.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        doc.body.appendChild(ta); ta.select();
        const ok = doc.execCommand('copy');
        ta.remove(); return ok;
      } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(fb()));
    } else done(fb());
  }

  function scrollToEl(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  /* ==========================================================================
     1. 键盘跳转链接
     ========================================================================== */
  function mountSkipLink() {
    if ($('.skip-link')) return;
    const wrap = $('.wrap');
    if (!wrap) return;
    if (!wrap.id) wrap.id = 'main-content';
    const a = doc.createElement('a');
    a.className = 'skip-link';
    a.href = '#' + wrap.id;
    a.textContent = '跳到主内容';
    doc.body.insertBefore(a, doc.body.firstChild);
  }

  /* ==========================================================================
     2. 移动端顶栏折叠
     ========================================================================== */
  function mountBurger() {
    const bar = $('.topbar');
    if (!bar || $('.tb-burger', bar)) return;
    const links = $('.nav-links', bar);
    if (!links) return;

    const btn = doc.createElement('button');
    btn.className = 'tb-burger';
    btn.type = 'button';
    btn.setAttribute('aria-label', '展开或收起导航菜单');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '☰';
    links.parentNode.insertBefore(btn, links);

    btn.onclick = () => {
      const open = bar.classList.toggle('nav-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '✕' : '☰';
    };
    links.addEventListener('click', e => {
      if (e.target.closest('a')) {
        bar.classList.remove('nav-open');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '☰';
      }
    });
  }

  /* ==========================================================================
     3. 专注阅读模式
     ========================================================================== */
  function mountFocusToggle() {
    const bar = $('.topbar');
    if (!bar || $('#btnFocus')) return;
    const links = $('.nav-links', bar);
    if (!links) return;

    const btn = doc.createElement('button');
    btn.className = 'tb-link';
    btn.id = 'btnFocus';
    btn.type = 'button';
    btn.title = '专注模式：隐藏导航与装饰，收窄正文（快捷键 F）';
    const sync = on => {
      doc.body.classList.toggle('focus-mode', on);
      btn.textContent = on ? '📖 退出专注' : '📖 专注';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      measureBars();
    };
    btn.onclick = () => {
      const on = !doc.body.classList.contains('focus-mode');
      sync(on); ux.set('focus', on);
    };
    links.appendChild(btn);
    sync(!!ux.get('focus', false));

    doc.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); btn.click();
      }
    });
  }

  /* ==========================================================================
     4. 代码块：一键复制 + 长代码折叠
     ========================================================================== */
  function mountCodeTools() {
    $$('pre').forEach(pre => {
      if (pre.closest('.stepper-code')) return;
      if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;

      const box = doc.createElement('div');
      box.className = 'code-wrap';
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);

      const btn = doc.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.textContent = '⧉ 复制';
      btn.onclick = () => copyText(pre.innerText, ok => {
        btn.textContent = ok ? '✓ 已复制' : '✗ 复制失败';
        btn.classList.toggle('done', ok);
        setTimeout(() => { btn.textContent = '⧉ 复制'; btn.classList.remove('done'); }, 1600);
      });
      box.appendChild(btn);

      if (pre.scrollHeight > 560) {
        box.classList.add('collapsible');
        const ex = doc.createElement('button');
        ex.className = 'code-expand';
        ex.type = 'button';
        ex.textContent = '▾ 展开全部代码';
        ex.onclick = () => {
          const expanded = box.classList.toggle('expanded');
          ex.textContent = expanded ? '▴ 收起' : '▾ 展开全部代码';
        };
        box.appendChild(ex);
      }
    });
  }

  /* ==========================================================================
     5. 分节阅读系统（核心）
     ========================================================================== */
  const COMPONENT_SEL = '.stepper, .lab, .quiz, .decision, .teacher, .stage, .deck';
  let sections = [];      // [{id, num, title, sec, head, body, comps}]
  let curIdx = 0;         // 当前展开节的索引
  let readSet = new Set();
  let mode = 'step';      // 'step' 逐节 | 'full' 整页
  let tocItems = [];

  /* ---- 5.1 采集标题 ---- */
  function collectHeadings() {
    const scope = $('#main-content') || $('.wrap') || doc.body;
    const hs = $$('h2, h3', scope).filter(h => {
      // 排除组件内部的标题与首页课程卡（首页已自带地图，不必重复列进目录）
      if (h.closest('.stepper, .stage, .lab, .quiz, .decision, .teacher, ' +
                   '.case, .deck, .sec-bar, .ccard, .resume-card, .glossary')) return false;
      return (h.textContent || '').trim().length > 0;
    });
    // 没有 id 的标题必须补一个，否则目录锚点会退化成 href="#"（真实踩过的坑）
    hs.forEach((h, i) => {
      if (!h.id) h.id = 'h-' + pageKey + '-' + i;
      h.dataset.tocReady = '1';
      h.style.scrollMarginTop = 'calc(var(--tb-h, 52px) + var(--sb-h, 0px) + 14px)';
    });
    return hs;
  }

  function headingLabel(h) {
    const numEl = $('.h2-num', h);
    const num = numEl ? numEl.textContent.trim() : '';
    const clone = h.cloneNode(true);
    const cn = $('.h2-num', clone); if (cn) cn.remove();
    const txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return { num, txt };
  }

  /* ---- 5.2 把 h2 之间的内容包成可折叠的 .sec ---- */
  function buildSections(heads) {
    const h2s = heads.filter(h => h.tagName === 'H2');
    if (h2s.length < 5) return [];      // 结构太短，不值得分节

    h2s.forEach(h => {
      const { num, txt } = headingLabel(h);

      const sec = doc.createElement('section');
      sec.className = 'sec';
      sec.dataset.sec = h.id;
      h.parentNode.insertBefore(sec, h);

      const head = doc.createElement('div');
      head.className = 'sec-head';
      sec.appendChild(head);
      head.appendChild(h);                       // h2 成为节标题行

      const body = doc.createElement('div');
      body.className = 'sec-body';
      sec.appendChild(body);

      // 收集本节内容：h2 之后、下一个 h2 之前（且不含页脚导航区）
      let n = sec.nextElementSibling;
      while (n) {
        if (n.tagName === 'H2') break;
        if (n.id === 'completeBox' || n.id === 'chapnav') break;
        const next = n.nextElementSibling;
        body.appendChild(n);
        n = next;
      }

      // 标题行右侧：状态徽章 + 折叠箭头
      const comps = Array.from(body.querySelectorAll(COMPONENT_SEL));
      const state = doc.createElement('span');
      state.className = 'sec-state';
      state.innerHTML = '<span class="ss-dot"></span><span class="ss-text">未读</span>' +
        (comps.length
          ? '<span class="ss-dots">' + comps.map(() => '<i></i>').join('') + '</span>' : '');
      const chev = doc.createElement('button');
      chev.className = 'sec-chev';
      chev.type = 'button';
      chev.setAttribute('aria-label', '展开或收起本节');
      chev.textContent = '▾';
      h.appendChild(state);
      h.appendChild(chev);

      // 节尾：推进到下一节
      const tail = doc.createElement('div');
      tail.className = 'sec-tail';
      tail.innerHTML =
        '<button class="btn primary sec-next" type="button">读完本节，下一节 →</button>' +
        '<button class="btn ghost sec-mark" type="button">标记已读</button>' +
        '<span class="sec-count"></span>';
      body.appendChild(tail);

      sections.push({ id: h.id, num, title: txt, sec, head, body, comps, h2: h });

      // 注意：必须在这里捕获本节索引。若写成 sections.length - 1，
      // 会在「点击时」求值，永远指向最后一节（真实踩过的坑）。
      const myIndex = sections.length - 1;

      // 点击标题行 = 折叠/展开
      head.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        toggleSection(myIndex, true);
      });
      chev.addEventListener('click', e => { e.stopPropagation(); toggleSection(myIndex, true); });
      tail.querySelector('.sec-next').onclick = () => goNext(myIndex);
      tail.querySelector('.sec-mark').onclick = () => {
        const id = sections[myIndex].id;
        if (readSet.has(id)) readSet.delete(id); else readSet.add(id);
        paint();
      };
    });

    return sections;
  }

  /* ---- 5.3 折叠 / 展开 ---- */
  function setOpen(i, opts) {
    opts = opts || {};
    curIdx = Math.max(0, Math.min(sections.length - 1, i));

    sections.forEach((s, k) => {
      const collapsed = (mode === 'step') && k !== curIdx;
      s.sec.classList.toggle('collapsed', collapsed);
      s.sec.classList.toggle('open', k === curIdx && !collapsed);
    });
    paint();

    if (opts.scroll) scrollToEl(sections[curIdx].head);
    if (opts.markPrevRead && curIdx > 0) {
      readSet.add(sections[curIdx - 1].id);
      paint();
    }
    if (mode === 'step') {
      ux.set('openSec:' + pageKey, sections[curIdx].id);
      rememberLastRead();
    }
  }

  function toggleSection(i, scroll) {
    if (mode === 'full') {
      // 整页模式下点标题 = 单独收起/展开这一节
      const s = sections[i];
      const collapsed = s.sec.classList.toggle('collapsed');
      s.sec.classList.toggle('open', !collapsed);
      paint();
      return;
    }
    if (i === curIdx && !sections[i].sec.classList.contains('collapsed')) {
      // 再点一次当前节 → 收起
      sections[i].sec.classList.add('collapsed');
      sections[i].sec.classList.remove('open');
      paint();
      return;
    }
    setOpen(i, { scroll: scroll });
  }

  function goNext(i) {
    readSet.add(sections[i].id);
    if (i >= sections.length - 1) {
      paint();
      toastMsg('🎉 本章 ' + sections.length + ' 节已全部走完', 3200);
      return;
    }
    setOpen(i + 1, { scroll: true });
  }

  function expandAll() {
    mode = 'full';
    ux.set('mode', 'full');
    sections.forEach(s => { s.sec.classList.remove('collapsed'); s.sec.classList.remove('open'); });
    paint(); measureBars();
    toastMsg('已展开全部小节（整页模式）。点「切回逐节」可恢复。', 2600);
  }
  function stepMode() {
    mode = 'step';
    ux.set('mode', 'step');
    setOpen(curIdx, { scroll: true });
    measureBars();
  }

  /* ---- 5.4 状态绘制 ---- */
  function paint() {
    sections.forEach((s, k) => {
      const st = s.head.querySelector('.sec-state');
      const txt = st.querySelector('.ss-text');
      const isRead = readSet.has(s.id);
      s.sec.classList.toggle('read', isRead);
      const isOpen = k === curIdx && !s.sec.classList.contains('collapsed');
      const label = isOpen ? '在读' : (isRead ? '已读' : '未读');
      if (txt) txt.textContent = label;
      const dots = st.querySelectorAll('.ss-dots i');
      dots.forEach((d, j) => {
        const comp = s.comps[j];
        d.classList.toggle('done', !!(comp && comp.dataset.akkcDone === '1'));
      });
      // 节尾计数
      const cnt = s.body.querySelector('.sec-count');
      if (cnt) cnt.textContent = '第 ' + (k + 1) + ' / ' + sections.length + ' 节' +
        (s.comps.length ? ' · 本节 ' + s.comps.length + ' 个交互组件' : '');
      const mark = s.body.querySelector('.sec-mark');
      if (mark) mark.textContent = isRead ? '✓ 已读（点击取消）' : '标记已读';
      const nx = s.body.querySelector('.sec-next');
      if (nx) nx.textContent = (k >= sections.length - 1) ? '完成本章 ✓' : '读完本节，下一节 →';
    });
    paintBar();
    paintTOC();
  }

  /* ==========================================================================
     6. 常驻位置条
     ========================================================================== */
  let bar = null;
  function mountSecBar() {
    if (!sections.length) return;
    const topbar = $('.topbar');
    bar = doc.createElement('div');
    bar.className = 'sec-bar';
    bar.innerHTML =
      '<span class="sb-num">—</span>' +
      '<span class="sb-name"></span>' +
      '<span class="sb-count"></span>' +
      '<span class="sb-prog"><i></i></span>' +
      '<button class="sb-act sb-prev" type="button" title="上一节">◀</button>' +
      '<button class="sb-act sb-next" type="button" title="下一节">下一节 ▶</button>' +
      '<button class="sb-act sb-all" type="button" title="展开全部 / 切回逐节">' +
        '<span class="sba-t">展开全部</span><span class="sba-i">⤢</span></button>';
    // 紧跟顶栏，形成"双层吸顶"
    if (topbar && topbar.nextSibling) doc.body.insertBefore(bar, topbar.nextSibling);
    else if (topbar) doc.body.appendChild(bar);
    else doc.body.insertBefore(bar, doc.body.firstChild);

    bar.querySelector('.sb-prev').onclick = () => setOpen(curIdx - 1, { scroll: true });
    bar.querySelector('.sb-next').onclick = () => goNext(curIdx);
    bar.querySelector('.sb-all').onclick = () => {
      if (mode === 'step') expandAll(); else stepMode();
    };
    measureBars();
  }

  function paintBar() {
    if (!bar || !sections.length) return;
    const s = sections[curIdx] || sections[0];
    bar.querySelector('.sb-num').textContent = s.num || ('#' + (curIdx + 1));
    bar.querySelector('.sb-name').textContent = s.title;
    const readN = sections.filter(x => readSet.has(x.id)).length;
    bar.querySelector('.sb-count').innerHTML =
      '第 <b>' + (curIdx + 1) + '</b>/' + sections.length + ' 节 · 已读 <b>' + readN + '</b>';
    bar.querySelector('.sb-prog i').style.width =
      Math.round(readN / sections.length * 100) + '%';
    bar.querySelector('.sb-prev').disabled = curIdx <= 0;
    bar.querySelector('.sb-next').disabled = curIdx >= sections.length - 1;
    const all = bar.querySelector('.sb-all');
    all.querySelector('.sba-t').textContent = mode === 'step' ? '展开全部' : '切回逐节';
    bar.classList.toggle('mode-full', mode === 'full');
  }

  /* 让吸顶高度进入 CSS 变量，保证锚点跳转不被顶栏遮住 */
  function measureBars() {
    const tb = $('.topbar');
    const root = doc.documentElement;
    if (tb) root.style.setProperty('--tb-h', Math.round(tb.getBoundingClientRect().height) + 'px');
    if (bar) root.style.setProperty('--sb-h', Math.round(bar.getBoundingClientRect().height) + 'px');
    root.style.scrollPaddingTop =
      'calc(var(--tb-h, 52px) + var(--sb-h, 0px) + 14px)';
  }

  /* ==========================================================================
     7. 侧边目录（与分节系统联动）
     ========================================================================== */
  function buildTOC(heads) {
    if (heads.length < 3) return;

    const toc = doc.createElement('aside');
    toc.className = 'toc';
    toc.setAttribute('aria-label', '本章目录');
    toc.innerHTML =
      '<div class="toc-head">' +
        '<span class="toc-title">' + (isChapter ? ('第 ' + chapterNo + ' 章 · 目录') : '本页目录') + '</span>' +
        '<span class="toc-x" role="button" tabindex="0" aria-label="关闭目录">✕</span>' +
      '</div>' +
      '<div class="toc-read"><i></i></div>' +
      '<nav class="toc-list"></nav>';
    doc.body.appendChild(toc);

    const list = $('.toc-list', toc);
    const readBar = $('.toc-read i', toc);
    tocItems = [];

    heads.forEach(h => {
      const { num, txt } = headingLabel(h);
      const a = doc.createElement('a');
      a.className = 'toc-item' + (h.tagName === 'H3' ? ' lv3' : '');
      a.href = '#' + h.id;
      a.dataset.target = h.id;
      a.innerHTML =
        '<span class="toc-num">' + (num || (h.tagName === 'H3' ? '·' : '')) + '</span>' +
        '<span class="toc-txt">' + txt + '</span>' +
        '<span class="toc-dots"></span>';

      a.onclick = ev => {
        ev.preventDefault();
        const idx = sections.findIndex(s => s.id === h.id);
        if (idx >= 0) {
          setOpen(idx, { scroll: true });
        } else {
          // h3：先展开它所属的那一节，再滚过去
          const owner = sections.findIndex(s => s.body.contains(h));
          if (owner >= 0) {
            setOpen(owner, {});
            setTimeout(() => scrollToEl(h), 30);
          } else scrollToEl(h);
        }
        history.replaceState(null, '', '#' + h.id);
        if (global.innerWidth < 1800) closeTOC();
      };
      list.appendChild(a);
      tocItems.push({ el: a, head: h });
    });

    const toggle = doc.createElement('button');
    toggle.className = 'toc-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '打开本章目录');
    toggle.innerHTML = '☰ 目录';
    toggle.onclick = () => openTOC();
    doc.body.appendChild(toggle);

    const mask = doc.createElement('div');
    mask.className = 'toc-mask';
    mask.onclick = () => closeTOC();
    doc.body.appendChild(mask);

    $('.toc-x', toc).onclick = () => closeTOC();

    if (global.innerWidth >= 1800) doc.body.classList.add('toc-pinned');

    let ticking = false;
    global.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      global.requestAnimationFrame(() => { spy(); ticking = false; });
    }, { passive: true });
    global.addEventListener('resize', () => {
      doc.body.classList.toggle('toc-pinned',
        global.innerWidth >= 1800 && !doc.body.classList.contains('toc-open'));
      measureBars();
    });

    function spy() {
      // 逐节模式：当前节由状态决定；整页模式：按滚动位置判定
      let cur = curIdx;
      if (mode === 'full' || !sections.length) {
        const y = global.scrollY + 130;
        cur = 0;
        tocItems.forEach((it, i) => {
          const top = it.head.getBoundingClientRect().top + global.scrollY;
          if (top <= y) cur = i;
        });
      }
      tocItems.forEach((it, i) => {
        const on = (mode === 'full' || !sections.length)
          ? i === cur
          : it.head.id === (sections[curIdx] && sections[curIdx].id);
        it.el.classList.toggle('on', on);
        const idx = sections.findIndex(s => s.id === it.head.id);
        it.el.classList.toggle('is-read', idx >= 0 && readSet.has(it.head.id));
        const dots = it.el.querySelector('.toc-dots');
        if (idx >= 0 && dots) {
          dots.innerHTML = sections[idx].comps
            .map(c => '<i class="' + (c.dataset.akkcDone === '1' ? 'done' : '') + '"></i>').join('');
        }
      });
      const hgt = doc.documentElement.scrollHeight - global.innerHeight;
      readBar.style.width = (hgt > 0 ? Math.min(100, (global.scrollY / hgt) * 100) : 0) + '%';
    }
    global.__akkcSpy = spy;
    spy();
  }

  function paintTOC() {
    if (!tocItems.length) return;
    tocItems.forEach(it => {
      const idx = sections.findIndex(s => s.id === it.head.id);
      it.el.classList.toggle('is-read', idx >= 0 && readSet.has(it.head.id));
      it.el.classList.toggle('on',
        mode === 'step' && sections[curIdx] && it.head.id === sections[curIdx].id);
      const dots = it.el.querySelector('.toc-dots');
      if (idx >= 0 && dots) {
        dots.innerHTML = sections[idx].comps
          .map(c => '<i class="' + (c.dataset.akkcDone === '1' ? 'done' : '') + '"></i>').join('');
      }
    });
  }

  function openTOC() {
    const t = $('.toc'); if (!t) return;
    t.classList.add('open');
    doc.body.classList.add('toc-open');
    const last = tocItems.find(x => x.el.classList.contains('on'));
    if (last) last.el.scrollIntoView({ block: 'nearest' });
  }
  function closeTOC() {
    const t = $('.toc'); if (t) t.classList.remove('open');
    doc.body.classList.remove('toc-open');
  }
  global.AKKC_openTOC = openTOC;

  /* ==========================================================================
     8. 阅读位置 / 续读
     ========================================================================== */
  function rememberLastRead() {
    if (!isChapter) return;
    const s = sections[curIdx];
    if (!s) return;
    ux.set('lastRead', {
      ch: chapterNo,
      file: location.pathname.split('/').pop(),
      secId: s.id,
      secNum: s.num,
      secTitle: s.title,
      idx: curIdx + 1,
      total: sections.length,
      at: Date.now()
    });
  }

  function mountResume() {
    if (!isChapter) return;
    const posKey = 'pos:' + pageKey;
    const saved = ux.get(posKey, null);
    const savedSec = ux.get('openSec:' + pageKey, null);

    // 位置恢复：优先按"上次所在小节"，其次按像素位置
    if (!location.hash) {
      const idx = savedSec ? sections.findIndex(s => s.id === savedSec) : -1;
      setTimeout(() => {
        if (mode === 'step' && idx > 0) {
          setOpen(idx, { scroll: false });
          scrollToEl(sections[idx].head);
          toast('已回到上次位置：第 ' + (idx + 1) + '/' + sections.length + ' 节 · ' + sections[idx].title);
        } else if (saved && saved.y > 500 && mode === 'full') {
          global.scrollTo({ top: saved.y });
          toast('已回到上次位置' + (saved.label ? '：' + saved.label : ''));
        }
      }, 90);
    }

    let t = null;
    global.addEventListener('scroll', () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        if (global.scrollY < 200) return;
        ux.set(posKey, { y: global.scrollY, label: sections[curIdx] ? sections[curIdx].title : '', at: Date.now() });
      }, 700);
    }, { passive: true });
  }

  function toast(msg) {
    const el = doc.createElement('div');
    el.className = 'resume-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + msg + '</span>' +
      '<button type="button" data-rt="top">回到顶部</button>' +
      '<span class="rt-x" role="button" tabindex="0" aria-label="关闭">✕</span>';
    doc.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    const hide = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 320); };
    $('[data-rt="top"]', el).onclick = () => {
      global.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      hide();
    };
    $('.rt-x', el).onclick = hide;
    setTimeout(hide, 7000);
  }
  function toastMsg(msg, ms) {
    const el = doc.createElement('div');
    el.className = 'resume-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + msg + '</span>';
    doc.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 320); }, ms || 2600);
  }
  global.AKKC_toast = toastMsg;

  /* 首页「继续阅读」卡片 */
  function mountContinueCard() {
    if (!/^index(\.html)?$/.test(pageKey)) return;
    const last = ux.get('lastRead', null);
    if (!last || !last.file) return;
    const hero = $('.chapter-hero');
    if (!hero) return;
    const card = doc.createElement('div');
    card.className = 'resume-card';
    const ago = Math.round((Date.now() - (last.at || 0)) / 60000);
    const agoTxt = ago < 1 ? '刚刚' : (ago < 60 ? ago + ' 分钟前'
      : (ago < 1440 ? Math.round(ago / 60) + ' 小时前' : Math.round(ago / 1440) + ' 天前'));
    card.innerHTML =
      '<span class="rc-icon">📖</span>' +
      '<div class="rc-body">' +
        '<div class="rc-label">继续阅读 · ' + agoTxt + '</div>' +
        '<div class="rc-title">第 ' + last.ch + ' 章 · ' + (last.secTitle || '') + '</div>' +
        '<div class="rc-meta">上次读到 <b>第 ' + (last.idx || 1) + '/' + (last.total || '?') + ' 节</b>' +
          (last.secNum ? ' （' + last.secNum + '）' : '') + '</div>' +
      '</div>' +
      '<a class="rc-go" href="' + last.file + '#' + (last.secId || '') + '">▶ 接着读</a>';
    hero.parentNode.insertBefore(card, hero.nextSibling);
  }

  /* ==========================================================================
     9. 组件完成度 → 自动标记本节已读
     ========================================================================== */
  function mountDoneTracking() {
    doc.addEventListener('akkc:done', e => {
      const el = e.target;
      el.dataset.akkcDone = '1';
      const idx = sections.findIndex(s => s.comps.indexOf(el) >= 0);
      if (idx < 0) { paint(); return; }
      const s = sections[idx];
      // 本节所有交互组件都完成 → 自动标记已读
      if (s.comps.length && s.comps.every(c => c.dataset.akkcDone === '1')) {
        readSet.add(s.id);
      }
      paint();
    });
  }

  /* ==========================================================================
     10. 术语点击卡片
     ========================================================================== */
  function mountTermCards() {
    let card = null;
    const close = () => { if (card) { card.remove(); card = null; } };

    doc.addEventListener('click', e => {
      const term = e.target.closest('.term');
      if (!term) { close(); return; }
      e.preventDefault();
      const wasOpen = card && card.dataset.for === term.dataset.def;
      close();
      if (wasOpen) return;

      card = doc.createElement('div');
      card.className = 'term-card';
      card.dataset.for = term.dataset.def || '';
      const gl = $('#glossary') || $$('h2').find(h => /名词表/.test(h.textContent));
      card.innerHTML =
        '<div class="tc-h">术语</div>' +
        '<div>' + (term.dataset.def || term.textContent) + '</div>' +
        (gl ? '<a class="tc-link" href="#' + gl.id + '">↓ 跳到本章名词表</a>' : '');
      doc.body.appendChild(card);

      const r = term.getBoundingClientRect();
      const cw = card.offsetWidth, chh = card.offsetHeight;
      let left = r.left + global.scrollX;
      let top = r.bottom + global.scrollY + 8;
      if (left + cw > global.innerWidth - 16) left = global.innerWidth - cw - 16;
      if (left < 8) left = 8;
      if (r.bottom + chh + 16 > global.innerHeight) top = r.top + global.scrollY - chh - 8;
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    });

    doc.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    global.addEventListener('scroll', close, { passive: true });
  }

  /* ==========================================================================
     11. 全局键盘与深链
     ========================================================================== */
  function mountKeys() {
    doc.addEventListener('keydown', e => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') closeTOC();
      if (typing) return;
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const toc = $('.toc');
        if (toc) toc.classList.contains('open') ? closeTOC() : openTOC();
      }
      // 分节导航：[ 上一节 ] 下一节
      if (sections.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === ']' || e.key === 'ArrowDown' && e.shiftKey) {
          e.preventDefault(); goNext(curIdx);
        }
        if (e.key === '[' || e.key === 'ArrowUp' && e.shiftKey) {
          e.preventDefault(); setOpen(curIdx - 1, { scroll: true });
        }
      }
      // Ctrl/Cmd+F：折叠状态下浏览器搜不到隐藏内容 → 自动展开并说明
      if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && mode === 'step' && sections.length) {
        expandAll();
        toastMsg('已展开全部小节，浏览器查找现在能搜到整章内容。', 4000);
      }
    });

    // 页面内锚点：自动展开目标节
    doc.addEventListener('click', e => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute('href').slice(1);
      if (!id) return;
      const idx = sections.findIndex(s => s.id === id);
      if (idx < 0) return;
      e.preventDefault();
      setOpen(idx, { scroll: true });
      history.replaceState(null, '', '#' + id);
    });
  }

  function applyHash() {
    if (!location.hash || !sections.length) return;
    const id = location.hash.slice(1);
    let idx = sections.findIndex(s => s.id === id);
    if (idx < 0) {
      // 可能是节内的 h3 / 组件锚点
      const el = doc.getElementById(id);
      if (el) idx = sections.findIndex(s => s.body.contains(el));
    }
    if (idx >= 0) {
      setOpen(idx, {});
      setTimeout(() => {
        const el = doc.getElementById(id);
        scrollToEl(el || sections[idx].head);
      }, 60);
    }
  }

  /* 同页仅变 hash 时浏览器不会重新加载（点锚点、前进/后退、外部链接），
     必须监听 hashchange，否则折叠状态下目标节不会展开。 */
  function mountHashChange() {
    global.addEventListener('hashchange', () => {
      if (!sections.length) return;
      const id = location.hash.slice(1);
      if (!id) return;
      const s = sections[curIdx];
      if (s && s.id === id && !s.sec.classList.contains('collapsed')) return;
      applyHash();
    });
  }

  /* ==========================================================================
     启动
     ========================================================================== */
  function init() {
    mountSkipLink();
    mountBurger();
    mountFocusToggle();
    mountCodeTools();

    const gl = $$('h2').find(h => /名词表/.test(h.textContent || ''));
    if (gl && !gl.id) gl.id = 'glossary';

    const heads = collectHeadings();
    buildSections(heads);
    buildTOC(heads);

    if (sections.length) {
      // 恢复模式偏好：章节页默认逐节，其他长页面默认整页
      const defMode = isChapter ? 'step' : 'full';
      mode = ux.get('mode', defMode);
      const savedRead = ux.get('read:' + pageKey, []);
      readSet = new Set(Array.isArray(savedRead) ? savedRead : []);

      mountSecBar();
      applyHash();

      if (!location.hash) {
        const savedSec = ux.get('openSec:' + pageKey, null);
        const idx = savedSec ? sections.findIndex(s => s.id === savedSec) : -1;
        curIdx = idx >= 0 ? idx : 0;
      }
      setOpen(curIdx, { });
      measureBars();
      setTimeout(measureBars, 300);
    }

    mountResume();
    mountDoneTracking();
    mountTermCards();
    mountKeys();
    mountHashChange();
    mountContinueCard();

    // 记录已读集合
    global.addEventListener('beforeunload', () => {
      ux.set('read:' + pageKey, Array.from(readSet));
    });
    setInterval(() => { if (sections.length) ux.set('read:' + pageKey, Array.from(readSet)); }, 15000);

    global.AKKC_expandAll = expandAll;
    global.AKKC_stepMode = stepMode;
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  global.AKKC_UX = ux;
  global.AKKC_sections = () => sections;
})(window);
