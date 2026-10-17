# 新章节写作规范

> 本文件是「安卓高级研修班交互式模拟器」新增章节的**唯一写作契约**。
> 写作前必须逐字读完，写完后必须让 `node validate-chapters.mjs <章号>` 零错误、零警告。
>
> **注意：章节号已按学习顺序重排**（入门 → 基础补遗 → 进阶）。
> 新增章节请接在末尾（当前为第 33 章起），**并保持 `COURSE.chapters[].no`、
> 外壳 HTML 的 `data-chapter`、`chapters/chNN.js` 文件名、数据里的 `no` 与小节号 `h` 四者一致**。

---

## 0. 你在写什么

这不是讲义，是一台**可以动手操作的机器**。每一章的读者是**有 Java/Android 基础、但没系统做过逆向**的工程师。
他们不缺"知识点列表"，缺的是**判断力**：遇到一个现象，该往哪一层找答案。

所以每一节都要回答同一个隐性问题：**「为什么是这样，而不是那样？」**

---

## 1. 必读文件（按顺序，不要跳）

| 文件 | 你要从中学会什么 |
|---|---|
| `assets/chapter.js` | 数据 → 页面的渲染规则；`T` 助手、`S/CLS/SET` 助手 |
| `assets/app.js` **第 306–1567 行**（搜 `function CodeStepper(` 起，到 `function Case(` 收尾） | 9 个组件的**精确配置字段**（Lab / Stage / Decision / Quiz / Case / Term / Stepper / Teacher / Deck） |
| `chapters/ch02.js` | 标杆范例：一节一节看它怎么起标题、怎么给类比、怎么收尾 |
| `chapters/ch04.js` | 标杆范例：技术密度最高的一章，看它怎么讲 ART 源码 |
| `assets/labs.js` | `window.CRYPTO` 全部可用的真实算法实现 |
| `assets/labx.js` | `window.LABX` 全部可用的解析工具 |
| `validate-chapters.mjs` | 你的自检工具，也是质量下限的**唯一权威来源** |

**风格上只认一件事：读起来必须像同一个作者写的。** 不要用"首先/其次/最后"的八股，不要写"综上所述"。
现有章节的语调是：**直接给判断，再给理由，必要时承认不确定**。

---

## 2. 数据文件格式

文件路径：`chapters/chNN.js`（NN 为两位章号，如 `chapters/ch20.js`）。
外壳 HTML 与进度统计**已由基础设施生成，你不需要动**。

```js
/* 第 20 章数据 —— 标题 */
window.CHAPTER = {
  no: 20,
  title: 'JNI / NDK 开发详解',
  lede: '……两三句话点出本章要解决的真问题，可用 <strong> 加粗关键判断……',
  meta: [
    '核心问题：<b>……</b>',
    '关键机制：<b>……</b>',
    '对手：<b>……</b>'
  ],

  sections: [
    {
      h: '20.1', title: '小节标题',
      intuition: { tag: '直觉模型 · XXX', body: '<p>生活类比</p>' },
      html: '<p>正文</p>' + T.note(…) + T.tbl(…) + …,
      stepper:  { title: '', lines: [{ code: '', note: '', state: {}, mem: '' }] },
      stage:    { title: '', render: '<div id="x"></div>', reset: ctx => {}, steps: [{ run: () => {}, note: '' }] },
      term:     { title: '', lines: [{ t: 'p', s: '', note: '' }] },
      decision: { start: 'n0', nodes: {
                    n0: { scenario: '', q: '', choices: [{ t: '', next: 'n1' }] },
                    n1: { terminal: true, verdict: 'good', verdictTitle: '', result: '' }
                 } },
      quiz:     { id: 'q20-1', chapter: 20, answer: 0, stem: '', options: [{ t: '', why: '' }], explain: '' },
      lab:      { /* 见下 */ },
      case:     { /* 见下 */ },
      after:    T.note('ok', '✅ 这一节的收获', '<p>…</p>')
    }
  ],

  glossary: [{ t: '术语', d: '解释' }],
  teacher: { id: 't20', chapter: 20, name: '……', sub: '……', intro: '……', questions: [ /* 见下 */ ] }
};
```

**一节里的字段顺序固定为**：`h` → `title` → `intuition` → `html` → 组件（`lab` / `case` / `stepper` / `stage` / `term` / `decision` / `quiz`）→ `after`。

### 2.1 可用的 `T` 助手（全局，数据文件里直接调）

```
T.note(kind, title, body)      kind: 'key' | 'ok' | 'warn' | 'bad' | '' （'bad' 表示危险/陷阱）
T.card(title, body[, extraStyle])
T.acc(title, body[, open])     折叠块
T.grid2 / T.grid3 用 T.grid(2, [item…])；item 是 HTML 字符串，非 <div class="card"> 开头的会被自动包成卡片
T.intuition(tag, body)
T.tbl(headArray, rowsArrayOfArray)
T.term(word, def)              正文里悬停出释义
T.pill(kind, text)             kind: '' | 'ok' | 'acc' | 'warn' | 'bad' | 'cool'
T.code(src)                    → <pre data-hl>
T.step(label, title, body)
```

### 2.2 动画里可用的全局助手

```js
S('元素id', 'css类名')   // 设置 className，自动保留 'blk' 基类 —— 用于方块状态
CLS('元素id', '类名')    // 直接设置 className
SET('元素id', 'html')    // 设置 innerHTML
```
`stage.steps[].run` 会被调用（无参也可以），`stage.reset` 用来把画面恢复成起点。
**`render` 里的每个 id 必须真实存在于 HTML 里，`run` 里引用的 id 必须与 `render` 一致。**

### 2.3 Lab（动手实验）—— 本章的"重心"，必须真的能算出结果

```js
lab: {
  title: '实验：……',
  goal: '目标：……',                    // 右上角小标签
  intro: '<p>要读者做什么</p>',
  inputs: [{ key: 'hex', label: '……', hint: '……', type: 'textarea', rows: 5, value: '预填值', ph: '占位' }],
  runLabel: '🔍 运行',
  autorun: true,                        // 有 value 时自动跑一次
  run: v => { /* 返回 HTML 字符串 */ },
  expected: v => ({ ok: bool, detail: 'HTML' }),   // 有它才会出现"检查我的答案"按钮
  showAnswer: '纯文本或 HTML 的正确答案',
  hint: '提示 HTML',
  after: T.note('ok', …)
}
```

**硬要求：`run` 与 `expected` 必须调用 `window.CRYPTO` / `window.LABX` 做真实计算，不许写死结果字符串。**
现有章节的实验全都能算出真实数字——这是本项目相对普通教程的核心差异，不能退化。

`inputs` 的 `value` 对**所有类型**都生效（`text` 与 `textarea` 都会预填，`autorun` 会带着这个值跑）。
`textarea` 用 `rows` 控制高度，适合放多行十六进制、日志片段、代码。

如果本章主题是"协议/流程/判定"这类算不出数的，也要让读者**填判定结论**并用 `window.AKKC_hasConcept()` 做语义判分：

```js
expected: v => {
  const ok = window.AKKC_hasConcept(v.verdict, ['关键词1', '关键词2', '中文子串']);
  return { ok, detail: ok ? '✅ …' : '❌ …' };
}
```

#### 判分纪律 —— 别让读者"不做题就通过"（`validate-labs.mjs` 强制检查）

写 `expected` 最容易犯的错不是"判错了"，而是**判漏了、判松了**：一个结构完全合法的 `expected`，
照样可以让读者不做题就通过。规矩如下：

**1. 题面问的每一问都必须被判分。**
`intro` 里写了"①……②……③……"，`expected` 就必须真的读 `v.①` / `v.②` / `v.③`。
只判其中一问、别的留着不判，等于那一问不存在——把判了的那问填对、剩下的空着也能过关。
（`validate-labs.mjs` 的做法：从 `expected` 的函数源码里找每个输入框的 key，找不到就报"漏判字段"。）

**2. 判据要按定义判，不要按"能被退化输入满足的后果"判。**
反例：判断 RSA 私钥 `d` 对不对，用"解密回来等于明文"当判据——`m = 0` 时任何 `d` 都能过。
正确做法是直接判定义：`e·d ≡ 1 (mod φ(n))`。

**3. 答案不许"自己漏出来"。**
- ❌ `inputs[].value` 预填的就是答案（点一下检查就过）
- ❌ `ph`（placeholder）里写着答案的字面量（它就是输入框里可见的文字）
- ❌ 失败详情里报出正确答案，或者报出"错在第几项"
- ✅ 「🔓 看正确答案」（`showAnswer`）、💡提示、`run` 的输出表**不算泄漏**——它们是**读者主动点出来**的，
  按钮有标注、输出写着"看懂不算会"。作者的责任是别让它们连后面的题一起送掉。
- 失败详情的正确写法：说**判据**、说**去哪儿看**（"点🔍运行看那张对照表"），别说答案、也别点名哪一项错。

**4. 题面里给的东西（前提字段）不必判。**
那份要你分析的 smali / 密文 / 日志，读者可以改着玩，判分器不必读它。
`validate-labs.mjs` 用"配置里有没有预填值"把"题面给你的"和"要你自己产出的"分开，只对后者判失败。

**5. 同一个数字只能有一个来源。**
`run` 和 `expected` 里都出现的常量（比如快照的 9 条破绽清单），要提到文件级只写一份。
两边各写一份，改了这边忘了那边，就会出现"运行结果和判分标准不一致"。

**6. 观察型实验不要挂假判分器。**
如果这一节只让读者"看两张表的差异"、根本不存在可判的答案，就**不要**写 `expected`——
挂一个"输入非空即通过"的判分器，只会让读者以为自己过关了。这类实验点 运行 就够了。

写完新实验（或改过判分器）之后必须跑：

```bash
node validate-labs.mjs <章号>     # 要零失败
```

修过的每个洞都要在 `validate-labs.mjs` 的 `PINS` 里留一条**钉死的回归断言**：
手法必须继续失败，**正确答案必须继续通过**——后半句是防"修过头"，比前半句更重要。

### 2.4 Case（实战案例）—— **只用真实、可访问的来源**

```js
case: {
  source: 'kanxue',        // kanxue | pojie | bilibili | github
  title: '原帖标题（照抄）',
  date: '2025-12-01',  author: '原作者ID',  target: '目标 App / 工具 / 版本',
  background: '<p>…</p>',
  points: ['技术要点', …],
  method: ['作者的方法论，按顺序', …],
  result: '<p>…</p>',
  terms: ['涉及知识点'],
  limits: '<p>作者自述的局限与未完成</p>',
  analysis: '<p><b>用本课方法论拆解</b>：这一节是案例的价值所在，要明确指出"案例的哪一步印证了本章的哪条原则"</p>',
  link: 'https://…',
  linkNote: '可选补充'
}
```

**纪律（违反即整段删掉，宁缺毋滥）：**
- URL 必须是**真实访问过、能取到正文**的页面。
- **严禁编造 URL、作者、标题、日期。** 编造一个看起来像 kanxue 的链接，比没有案例糟糕得多。
- 如果确实找不到可验证的案例：**不要写 `case` 字段**，改为在 `html` 里写一个 `T.note('warn', …)` 说明"本章未收录可验证的公开案例"，并在交付报告里说明原因。
- 作者自述的局限照录，不代其下结论、不美化。

#### 怎么验证案例链接（上一批踩过的坑，直接照这个来）

**用 Node 的 `fetch`，不要用 PowerShell 的 `Invoke-WebRequest` 或 `curl`**——本机的这两个走不通 TLS（返回 000 / SSL 错误），会白白浪费你半小时。

```js
// 存成 .check.mjs 跑一次，然后删掉
const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120" } });
const html = await r.text();
// 看雪正文在这个 textarea 里，不在可见 DOM 中——很多工具只能抓到"登录后可查看完整内容"那层壳
const ta = [...html.matchAll(/js-message-markdown[^>]*>([\s\S]*?)<\/textarea>/g)].map(m => m[1]).join("");
console.log(r.status, html.length, "正文长度:", ta.length);
```

已验证的事实，可以直接采信：

| 事实 | 含义 |
|---|---|
| **看雪的验证墙是按帖命中的，不是全站行为** | 同一批链接里，有的 `textarea` 有完整正文，有的就只有"登录后可查看完整内容"。**必须逐帖验证，不能凭站点印象下结论。** |
| 看雪 `thread-NNNNN-1.htm` 路由稳定可用 | 优先用这个 |
| 看雪 `article-NNNNN.htm` 路由**不稳定** | 实测会出现 404（22 字节）。**不要用它做案例链接。** |
| GitHub 仓库页与 `raw.githubusercontent.com/.../README.md` 稳定可用 | **拿不准时优先选 GitHub 来源**，可验证性最好 |
| `52pojie.cn` 多数帖子返回 200 但正文为空 | 基本不可用 |
| MCP 的 `web_fetch` 抽取较浅，可能只拿到附件列表之类的片段 | 它可用来交叉确认页面存在，但**判断正文是否可读要以 Node fetch 的 textarea 长度为准** |

如果目标只是"证明这个页面存在"，`mcp__open-websearch__web_fetch` 更快；
如果要**证明正文可读**，必须用上面那段 Node 代码看 `textarea` 长度（几百字节以上才算正文）。

### 2.5 Teacher（严师追问）—— 本项目的核心创新

```js
teacher: {
  id: 't20', chapter: 20,
  name: '……（可拟人化，如"JNI 老法师"）',
  sub: '不把关键概念说全，我不会放你走',
  intro: '<p>开场白</p>',
  questions: [{
    id: 'c20q1', depth: 1, threshold: 0.7,
    q: '问题（可含 HTML）',
    concepts: [
      { label: '要点名（正向表述，会展示给读者）',
        hint: '没说到时的提示',
        any: ['匹配词1', '匹配词2', '中文子串'] }   // 语义匹配候选，越多越好
    ],
    hints:  ['第一轮给的具体提示', '第二轮更具体的提示'],
    probes: ['第一轮追问', '第二轮追问'],
    model:  '<b>参考答案</b>，要有完整推理链，不只是结论',
    after:  '可选：通过后追加的一段'
  }]
}
```

**匹配词写作要点**（直接决定判分是否公平）：
- 每个 `any` 里至少放 **3–6 个**候选，覆盖**同义表达**：中文术语、英文术语、口语说法。
- 英文词按**词边界**匹配，中文按**子串**匹配。
- 不要把 `any` 写成只有一个很长的整句——那永远匹配不上，会把读者判死。
- `concepts` 至少 4 条，`depth` 用 1/2/3 递进，`threshold` 取 0.7 左右。
- 至少要有 **2 道深度 3 的综合题**，逼读者把整章串起来。

---

## 3. 内容质量下限（`validate-chapters.mjs` 会强制检查）

| 项 | 下限 | 说明 |
|---|---|---|
| 小节数 | ≥ 12 | 每节都要有自己的存在理由，不要为凑数拆节 |
| `intuition` | ≥ 2 | 用在最需要建立直觉的地方 |
| `stepper` | ≥ 1 | |
| `stage` | ≥ 2 | 动画舞台是"让看不见的东西可见" |
| `decision` | ≥ 3 | 真实情境下的权衡，**错误选项要写清踩什么坑** |
| `quiz` | ≥ 4 | 每个选项的 `why` 都要写，包括正确选项 |
| `lab` | ≥ 1 | 见 2.3，必须真实计算 |
| `case` | ≥ 1 | 见 2.4，**必须可验证**；找不到就改用 warn note 并报告 |
| 严师追问 | ≥ 5 | 见 2.5 |
| `glossary` | ≥ 8 | 本章专业名词 |

**关于文件体积：目标区间是 150–320 KB，不要为了压到 150 KB 以下而删内容。**

这一条特别说明一下，因为它是上一批章节里最容易引起误判的地方：
- 现有 30+ 章的实际分布是 **200–300 KB**（老章 80–180 KB，是早期更短的写法）。
- 体积大不是问题——本站纯静态、无构建、无打包，页面直接 `file://` 打开，两百多 KB 的 JS 解析是毫秒级。
- **真正的下限是"内容是否够厚"，不是字节数。** 一章如果只有 120 KB，通常说明它缺了大纲里的主题，
  而不是说明它"精炼"。
- 唯一需要担心的是**凑字数**（同一个意思翻来覆去说）。判断标准很简单：
  **删掉这一段，读者会少知道什么？** 答不上来就删掉它，答得上来就留着，别管文件多大。

**决策演练的写法（最容易被写水的地方）：**
每个错误选项都要有 `why`，且必须说清**这条路会在什么具体情况下失败**，而不是"这样不对"。
终节点用 `verdict: 'good'` 或 `'bad'`，`result` 里要有**认知根源**层面的分析——
比如"你把'技术上能做到'当成了'现在就该做'"。这是现有章节的水平线。

---

## 4. 事实纪律

1. **不确定就标注。** 用 `<span class="pill warn">待核实</span>`，并说明不确定的是什么（版本号？文件名？字段偏移？）。
   全站已有 100+ 处这样的标注，**这是风格的一部分，不是缺陷**。
2. **不编造**：API 名、寄存器名、函数名、文件路径、版本号、字段偏移、命令参数。
   记不准就写得更抽象（"该函数符号随版本变化"），或直接标待核实。
3. **区分三类断言**：① 标准/规范规定的（可以断言）；② 某版本实测的（要说明版本）；
   ③ 社区流传的（要标明来源与不确定性）。
4. 涉及**攻击性技术**（脱壳、注入、绕过检测）时，保持现有章节的口径：
   面向**合法授权的安全研究、自身产品加固、教学**；不写"如何攻击某个具体线上产品"的操作步骤。
5. 代码示例若不能保证逐字可运行，就注明"示意"，不要把伪代码写成看起来能跑的样子。

---

## 5. 交付与自检流程

```bash
# 1) 先跑一次（此时会报"文件不存在"，用来看清路径对不对）
node validate-chapters.mjs <章号>
# 2) 写完存盘
# 3) 自检（必须零错误、零警告）
node validate-chapters.mjs <章号>
# 4) 判分自检（写了 lab 的章必跑：能不能"不做题就通过"）
node validate-labs.mjs <章号>
```

- 修到 `✅ 结构校验全部通过` 且**没有该章的 ⚠️ 提醒**为止；
  再跑 `node validate-labs.mjs <章号>` 到**零失败**（有 lab 的章必跑）。
- **校验器会真的执行你的代码，不只是读结构**，所以下面这些不要试图糊弄：
  - 用 `inputs[].value` 调一遍 `lab.run` / `lab.expected`（抛异常、返回非字符串、返回空串都会被报出来）
  - 调一遍 `stage.reset` 与每个 `stage.steps[].run`
  - 把整章交给 `renderChapter` + `mountAll`，**9 个组件的构造函数全部执行**（配置字段写错会在这里炸）
  - **动画 id 对账**：从 `render` 抽 id，从 `reset`/`run` 的函数源码抽被引用的 id，两边比对。
    形如 `S('row-' + i, …)` 的动态 id 会退一步核对「前缀是否出现在 render 里」。
  - **CSS 类名存在性**：你写的每个 `class="…"` 都必须在 `assets/style.css` 里有定义，否则会"没有样式"。
- 其他会查的：重复键、小节编号跳号、decision 断链/不可达节点、quiz answer 越界、
  lab input key 重复、teacher concepts 缺 `any`、case 缺 link、内联脚本语法。
  **不要试图绕过它，它是你的朋友。**
- 交付时报告：章号、文件路径、小节数、各组件数量、是否收录案例（含 URL 与**你是怎么验证的**）、
  以及**你标了哪些「待核实」**。

---

## 6. 禁止事项

- ❌ 修改 `assets/` 下任何文件（基础设施已就绪，改它会连带影响现有 25 章）
  —— **默认规则，不放松**；实战区相关的放开范围见 6.1（原 `feat/practice-simulator` 分支，2026-10-17 已合入 `main`）
- ❌ 修改现有 `chapters/ch01.js`–`ch25.js`
  —— **默认规则，不放松**；迁移期按章放开的范围见 6.1
- ❌ 修改 `index.html` / `README.md` / `slides.html` / `toolbox.html`（由主控统一更新）
- ❌ 使用 `require` / `import` / `fetch` / 任何外部依赖 —— 数据文件必须是纯 `window.CHAPTER = {…}` 赋值
  （例外：为了**验证案例链接**可以临时写 `.mjs` 脚本，但必须跑完即删，不要留在仓库里）
- ❌ 在数据文件里写 DOM 操作代码（除了 `stage` 的 `run`/`reset` 里允许调用 `S/CLS/SET`）
- ❌ 用 `async` / `await` / Promise
- ❌ 编造案例链接
- ❌ 留下临时文件（自检脚本、`.json` 中间产物等）——交付前清干净

### 6.1 实战区的放开范围（原 `feat/practice-simulator` 分支）

实战模式（工单模式）需要仿真引擎、交接卡与独立实战区，`assets/`、`chapters/` 都要动到。
这组例外**原先只开在 `feat/practice-simulator` 分支上**（2026-10-16）；
**2026-10-17 该分支已合入 `main`**，所以下表从"分支例外"改为**常设规则**——
面对实战区相关的落点按表执行，其余一律照旧。
**默认规则不松**：新章节仍然不许改 `assets/` 下已有文件、不许改别的章节文件。

| 对象 | 允许的程度 |
|---|---|
| **新增** `assets/sim/*`、`assets/practice.js`、`assets/practice.css`、`practice.html`、`validate-missions.mjs`、`validate-labs.mjs`、`audit-lab-details.mjs` | 只许**新增**（`assets/` 既有文件的可动范围见下面两行） |
| `assets/app.js` | 只许**增量扩展**：在 `Lab` 组件与 `mountTopbar` 内加分支；**不许重写既有组件** |
| `assets/style.css` | 只许**追加新规则块**；**不许改动既有规则** |
| `chapters/chNN.js` | 迁移期按章放开：一次只改正在迁移的那一章、不许动别的章节；**每章迁移必须单独提交**，且迁移后 `validate-chapters.mjs` 仍须零错误；迁移前该章必须判分过关（`PRACTICE-SPEC.md` §7.3 的硬前置） |

**边界精神：只许新增与增量扩展，不许重写、不许顺手改。** 依据：`PRACTICE-SPEC.md` §11.2，修订经过见文末「修订记录」。

---

## 7. 修订记录

| 日期 | 修订 | 说明 |
|---|---|---|
| 2026-10-17 | 实战区合入 `main`：§6.1 由"分支例外"改为**常设规则**（放开范围不变）；§6 两条禁令的注脚去掉"（main 分支）"限定 | 分支 `feat/practice-simulator` 的提交一并合入；**默认禁令本身没有放松** |
| 2026-10-17 | §6.1「新增」清单补登 `validate-labs.mjs`、`audit-lab-details.mjs` | 判分自检与失败详情审计工具，见 §2.3 与文末批次记录 |
| 2026-10-16 | 为实战模式分支（`feat/practice-simulator`）放开两条禁令（`assets/`、`chapters/chNN.js`） | 默认（main）仍一律禁止；放开范围见 6.1 |
| 2026-10-16 | 更正 §1「必读文件」里 `assets/app.js` 的行号区间：**236–1160 → 306–1567** | 见下方说明。这是**既有错误**，不是本次改动引入的漂移 |
| 2026-10-16 | 新增 §2.3「判分纪律」小节，§5 自检流程加第 4 步（`node validate-labs.mjs`） | 把"不做题就通过"的堵法写成规矩；配套工具与 12 章的修复见文末清单 |

**关于 §1 那处行号的更正**：原文指向 `assets/app.js` 第 236–1160 行，但 9 个组件实际从
`function CodeStepper`（第 306 行）排到 `function Case` 收尾（第 1567 行）。
按原区间去读，会**整个漏掉 `Lab`（动手实验）和 `Case`（实战案例）** —— 而这两个恰恰是章节作者最常打交道的组件。
改成行号 + 函数名双锚点：行号方便跳，函数名保证下次漂移时还能自己找回来。

**2026-10-16 · 本次已发生的实际改动清单**（均符合 6.1）：

- **新增**：`assets/sim/simelf.js`、`assets/sim/simnative.js`、`assets/sim/simdevice.js`、`assets/sim/forge.js`、`assets/sim/missions.js`、`assets/practice.js`、`assets/practice.css`、`practice.html`、`validate-missions.mjs`
- **`assets/app.js` 两处增量**：`Lab` 组件在 `cfg.mission` 存在时渲染「交接卡」；`mountTopbar` 增加「🎯 实战区」入口
- **`assets/style.css`**：追加一个 `.handoff` 样式块（纯新增）
- **`chapters/ch22.js`**：实验一增加 `mission` 数据字段
- **`PRACTICE-SPEC.md` §11.1**：记录了 M1 的交付与偏差

**2026-10-16 · 判分漏洞修复批次**（在 `feat/practice-simulator` 上，先修漏洞再回实战区）：

触发点是回头审计实战区的教学设计时发现：**章节里的 `lab` 判分器有一批"可以不做题就通过"的口子**。
这类漏洞不修，"实战区"就失去意义（章节里的自测都已经能白嫖了）。因此新增判分自检工具，
把每一处漏洞按同一套规则堵掉：

- **新增** `validate-labs.mjs`：机械扫描（空提交 / 预填即过 / 廉价猜测 / placeholder 泄漏）+
  漏判字段静态检查 + `PINS` 钉死回归断言 + 覆盖自检。当前 **52 个实验 / 50 个带判分器 / 0 个白嫖口子 / 68 条断言全过**。
- **修复 12 章的数据文件**，按漏洞类型分类：
  - 预填值本身就是答案：ch19（改成"不带进位"的示范对）、ch29（② 那空着）
  - 判据可被退化输入满足：ch06（`m=0` 时任何 `d` 都"解密成功"→ 改判模逆定义）
  - 失败详情里报答案：ch02 / ch16 / ch25（三处都改成"说判据、说去哪儿看"）
  - 题面问的一问没判：ch17 ③ / ch21 `verdict` / ch25 ② / ch27 ③ / ch29 `worst` / ch31 ② / ch32 ③
  - 观察型实验挂假判分器：ch22（删掉 `expected`，只保留 运行）
  - `placeholder` 写着答案：ch25（"例如 B、C" → "填数字"式的空占位）
- 规则本身写进了 §2.3「判分纪律」，防止后续新增章节再犯。

**2026-10-16 · 失败详情专项清扫**（同上批次：把"失败详情里报答案"这一条执行到底）：

- 用 `dump-details.mjs` 把 50 个判分器在"全空 / 原样预填 / 每个作答字段填 X"三种提交下的**失败详情**
  全部导出，逐条人工审计 —— **35 个 lab 的失败详情里印着答案**：算完的答案值、答案清单、
  逐项判定，甚至"正确答案是……"这种句子。
- 共 **69 处替换**（patch6），全部只动"判分之后展示的文案"：保留判据、公式与前提值，
  去掉算完的结果；维持「🔍运行 / 💡提示 / 🔓看正确答案」这三个**已标注**的揭示通道作为出口。
- 审查要点：`run` 的输出表也算"学生主动点出来的"（要动手、有标注），所以失败详情可以把人
  指过去（"点运行看那张对照表"），但不能替他把表读出来。
- 回归防护：`validate-labs.mjs` 新增 `kind: 'noLeakAny'` 断言（三种提交的失败详情都不许出现
  答案痕迹），35 个 lab 全部钉住；当前 **68 条断言全过**。
- 等价性证明：清扫没有动任何 `ok` 表达式。用 `verdictdiff.mjs` 把 21 个改动章在 `HEAD` 与工作区
  之间按 **3310 种提交**逐一比对判定结果 —— **0 处变化**：白嫖的仍然不通过，正确答案仍然通过。
- 唯一没钉住的一处：ch07 §7.13 漏的是"表格里每行的规则判定列"（结构而非字面量），
  机械断言钉不住；改动证据留在 `leakdiff.mjs` 的输出里。
- **新增**审计工具 `audit-lab-details.mjs`（本批用的导出脚本已入库）：对全部判分器导出三种提交的
  失败详情，是第 1 步人工审计的可重复入口；后续新增章节照跑一遍即可。输出文件不提交。
