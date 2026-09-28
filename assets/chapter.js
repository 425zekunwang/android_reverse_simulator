/* ==========================================================================
   章节渲染器 —— 把「数据」渲染成完整章节页
   数据驱动：每章只需一个数据文件（window.CHAPTER = {...}），
   页面骨架、组件装配、导航、进度全部由本文件生成。
   ========================================================================== */
(function (global) {
  'use strict';

  const { esc, COURSE } = global.AKKC;

  /* ---------------------------------------------------------- 内置小工具 */
  // 允许数据里用简写：note(), card(), tbl(), acc(), grid(), intuition()
  const T = {
    note: (kind, title, body) =>
      `<div class="note${kind ? ' ' + kind : ''}">` +
      (title ? `<div class="note-h">${title}</div>` : '') + body + `</div>`,
    card: (title, body, extra) =>
      `<div class="card"${extra ? ' style="' + extra + '"' : ''}>` +
      (title ? `<div class="card-title">${title}</div>` : '') + body + `</div>`,
    acc: (title, body, open) =>
      `<details class="acc"${open ? ' open' : ''}><summary>${title}</summary>` +
      `<div class="acc-body">${body}</div></details>`,
    grid: (cols, items) =>
      `<div class="grid${cols}">` + items.map(x =>
        typeof x === 'string' && x.startsWith('<div class="card')
          ? x : T.card(null, x)).join('') + `</div>`,
    intuition: (tag, body) =>
      `<div class="intuition"><span class="tag">${tag}</span>${body}</div>`,
    tbl: (head, rows) =>
      `<div class="tbl-wrap"><table class="tbl"><thead><tr>` +
      head.map(h => `<th>${h}</th>`).join('') + `</tr></thead><tbody>` +
      rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') +
      `</tbody></table></div>`,
    term: (word, def) => `<span class="term" data-def="${esc(def)}">${word}</span>`,
    pill: (kind, text) => `<span class="pill${kind ? ' ' + kind : ''}">${text}</span>`,
    code: (src) => `<pre data-hl><code>${src}</code></pre>`,
    step: (label, title, body) =>
      `<div class="card tight"><div class="card-title">${label} · ${title}</div>${body}</div>`
  };
  global.AKKC_T = T;
  global.T = T;   // 数据文件（chapters/chNN.js）直接使用 T.note(...) 等简写

  // 动画常用助手：设置元素 className（保留 blk 基类）
  global.S = function (id, cls) {
    const el = document.getElementById(id);
    if (el) el.className = 'blk ' + (cls || '');
  };
  // 通用：直接设 className
  global.CLS = function (id, cls) {
    const el = document.getElementById(id);
    if (el) el.className = cls || '';
  };
  // 设置文本/HTML
  global.SET = function (id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  /* ---------------------------------------------------------- 渲染主函数 */
  function renderChapter(ch) {
    const wrap = document.getElementById('chapter-root') || document.body;
    const total = COURSE.chapters.length;

    /* ---- 页头 ---- */
    let html =
      `<div class="chapter-hero">` +
        `<span class="ch-no">CHAPTER ${String(ch.no).padStart(2, '0')}</span>` +
        `<h1>${ch.title}</h1>` +
        `<p class="lede">${ch.lede}</p>` +
        (ch.meta && ch.meta.length
          ? `<div class="hero-meta">` + ch.meta.map(m => `<span>${m}</span>`).join('') + `</div>`
          : '') +
      `</div>`;

    /* ---- 正文章节 ---- */
    (ch.sections || []).forEach((s, si) => {
      // 只有真的给了标题才输出 h2；没标题的 section 用来续挂组件，不产生空标题
      if (s.title) {
        const hnum = s.h || (ch.no + '.' + (si + 1));
        // 带锚点 id，便于 cases.html 等外部页面深链到具体小节
        html += `<h2 id="sec-${hnum}"><span class="h2-num">${hnum}</span>${s.title}</h2>`;
      }
      if (s.html) html += s.html;

      // 组件占位（渲染后由 AKKC.boot 装配，或此处立即装配）
      const slots = [];
      const slot = (kind, cfg, cls) => {
        const id = `slot-${si}-${slots.length}`;
        slots.push({ id, kind, cfg });
        return `<div id="${id}"${cls ? ' class="' + cls + '"' : ''}></div>`;
      };

      if (s.intuition) html += T.intuition(s.intuition.tag, s.intuition.body);
      if (s.deck)      html += slot('deck', s.deck);
      if (s.lab)       html += slot('lab', s.lab);
      if (s.case)      html += slot('case', s.case);
      if (s.stepper)   html += slot('stepper', s.stepper);
      if (s.stage)     html += slot('stage', s.stage);
      if (s.term)      html += slot('term', s.term);
      if (s.decision)  html += slot('decision', s.decision);
      if (s.quiz)      html += slot('quiz', s.quiz);
      if (s.after)     html += s.after;

      // 收集待装配
      pending.push(...slots);
    });

    /* ---- 名词表 ---- */
    if (ch.glossary && ch.glossary.length) {
      html += `<h2><span class="h2-num">${ch.no}.G</span>本章名词表</h2><div class="glossary">` +
        ch.glossary.map(g => `<div class="g-item"><dt>${g.t}</dt><dd>${g.d}</dd></div>`).join('') +
        `</div>`;
    }

    /* ---- 严师 ---- */
    if (ch.teacher) {
      html += `<h2><span class="h2-num">${ch.no}.T</span>🧑‍🏫 严师时间：不答完不准走</h2>` +
        `<p>下面这位老师不会给你标准答案。他会一题一题逼问你，直到你把关键概念<strong>用自己的话说全</strong>。
        答不上来可以要提示，但提示不算过关。</p>` +
        `<div id="slot-teacher"></div>`;
      pending.push({ id: 'slot-teacher', kind: 'teacher', cfg: ch.teacher });
    }

    /* ---- 完成 + 导航 ---- */
    html += `<div id="completeBox" style="margin-top:40px"></div><div id="chapnav"></div>`;

    wrap.innerHTML = html;
  }

  const pending = [];

  /* ---------------------------------------------------------- 装配组件 */
  function mountAll() {
    const { CodeStepper, SocraticTeacher, Quiz, Decision, Term, Stage, Deck, Lab, Case } = global.AKKC;
    pending.forEach(p => {
      const el = document.getElementById(p.id);
      if (!el) return;
      switch (p.kind) {
        case 'stepper':  new CodeStepper(el, p.cfg); break;
        case 'stage':    new Stage(el, p.cfg); break;
        case 'term':     new Term(el, p.cfg); break;
        case 'decision': new Decision(el, p.cfg); break;
        case 'quiz':     new Quiz(el, p.cfg); break;
        case 'deck':     new Deck(el, p.cfg); break;
        case 'lab':      new Lab(el, p.cfg); break;
        case 'case':     new Case(el, p.cfg); break;
        case 'teacher':  new SocraticTeacher(el, p.cfg); break;
      }
    });
  }

  /* ---------------------------------------------------------- 启动 */
  global.AKKC_renderChapter = renderChapter;
  global.AKKC_mountAll = mountAll;

  function boot() {
    if (global.CHAPTER) {
      renderChapter(global.CHAPTER);
      // 渲染完再装配组件（app.js 的 boot 已经跑过，这里手动装配）
      mountAll();
      if (global.AKKC_INIT_EXTRA) global.AKKC_INIT_EXTRA();
    }
  }

  // app.js 先 boot（mountTopbar 等），本文件随后 boot
  // 注意：不自动 boot。由 app.js 的 boot() 在渲染完章节后再装配导航，
  // 否则 #completeBox / #chapnav 在渲染前不存在。见 app.js boot()。
})(window);
