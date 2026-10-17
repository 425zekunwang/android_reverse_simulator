# 实战区实施计划（Practice Implementation Plan）

> **这份文档的定位**：`PRACTICE-SPEC.md` 回答"为什么这么做"，本文回答"照着敲哪些代码"。
> 每条任务都写成 **文件 · 接口 · 行为 · 验收命令 · 提交边界** 五段。
> 读本文的人**不需要再做功能设计** —— 设计已在此定案（含 §13 原先未决的 7 条）。
>
> **状态**：M1 / M2 / M3 已交付，`main` 已含引擎 + 实战区 + 一关（M22-1）。
> 本文覆盖 **M3.1（首批 4 关）+ M1b / M4 / M5 的接续**。
>
> **维护纪律**：实现过程中若本文与代码冲突，以"代码 + 校验器"为准，并回来改本文 ——
> 本文不允许出现一句"看着合理但没被任何校验器或实测支撑"的断言（`CHAPTER-SPEC.md` §4）。

---

## 0. 术语、约定与全局纪律

### 0.1 名词

| 名词 | 含义 |
|---|---|
| **工单 / mission** | 一关。定义体在 `assets/sim/missions.js`，正门（交接卡）在 `chapters/chNN.js` 的 `lab.mission` |
| **交接卡** | 章节里那个 `<a class="handoff">`，指向 `practice.html#<id>` |
| **靶场 / artifact** | `FORGE.build(spec, seed)` 的产物：设备规格 + 映像字节 + 世界线 + `truth` |
| **判定 / objective** | 怎么判对，四种 `kind`：`value` / `state` / `differential` / `witness` |
| **参考解法 / reference** | 官方解法：`walkthrough`（终端命令）+ `route`（工作台操作表）+ `solve(art)`（纯静态、只读公开数据） |
| **作者基线** | `SIMSCORE.replay(mission)` 把 `route` 真跑一遍得到的三轴，**不是手写数字** |

### 0.2 硬纪律（每次提交前必须满足）

1. **六个校验器全部 exit 0**：
   `validate-chapters.mjs` / `validate-labs.mjs` / `validate-missions.mjs` / `validate-ui.mjs` /
   `check-integrity.mjs` / `build-cases.mjs --check`。
2. **每个"数字"都要能被复核** —— 产物里的数只能由真算得出，且能从另一条独立路径复算。
3. **`truth` 不进 DOM**。全篇 `truth` 的访问点只有 §5.1 登记的那 3 处（`PRACTICE-SPEC.md` §5.1 第 2 条）。
4. **提交切分**：`chapters/chNN.js` 的迁移**一次只改一章、每章单独提交**
   （`CHAPTER-SPEC.md` §6.1）。引擎改造（`assets/sim/*`、`practice.js`、`validate-*.mjs`）与章节迁移**分开提交**。
5. **无构建、零依赖、`file://` 直开**（`PRACTICE-SPEC.md` §12）。

### 0.3 §13 未决项的裁定（实现必须有个答案，这里就是答案）

| 原问题 | 裁定 | 落点 |
|---|---|---|
| §13-1 世界包装做多厚 | **只做"工单 ← 邮件"这一层**：工单标题 + 验收标准 + brief 列表。不加虚构同事/老板点评 | §2 各关 `brief` / `acceptance` |
| §13-2 是否允许一条以上的解法路径 | **允许**，且**不做路径分档**。三轴只按"你实际动了多少"计，路线快慢由玩家自己比 | §5.7 + `SIMSCORE`（不改） |
| §13-3 进度是否合并显示 | **先不合并**：实战区进度存在 `akkc-progress-v1.missions`，章节进度仍在原处。首页地图不动 | 本文 §6.3（挂到 M4） |
| §13-4 交接卡显示多少信息 | **不显示历史三轴**。交接卡只显示 id / title / 一句话差异 | §4 迁移配方 |
| §13-5 白名单算子求值器放哪 | **新建 `assets/sim/simops.js`**（只做白名单算子求值，谁都能加载）。理由：M19-1 与 M1b 的 SimVM 是两件事，不并进 `simnative.js`（那个已经在管 ELF 映像，职责不同） | §1.3 |
| §13-6 校验器进日常流程 | **保持手动**（提交前跑）。不加 CI —— 本仓没有 CI，加一个等于引入一个新依赖面 | 本文 §6.1 |
| §13-7 步数 vs 脚本行数 | 首批 4 关**没有脚本类关卡**，第三轴保持 `步数`。`脚本行数` 继续挂起到 M5 | 本文 §7.3 |

### 0.4 交付顺序（严格按此，不许并行跨里程碑）

```
P0  公共引擎改造（§1）           ← 一切的前置，先单独提交
P1  M19-1（witness）             ← 验证新判定种类
P2  M14-1（differential）
P3  M13-1（value）
P4  M17-1（value；含 ch17 展示 bug 修复，单独一个提交在前）
P5  M1b（simvm.js）→ M4（长期队列）→ M5（脚本类）
```

---

## 1. 公共引擎改造（P0）

> 目标：把引擎里"只对 M22-1 成立"的假设收敛成"对四类判定都成立"的契约。
> **这一节的每一小项都不改章节文件**（章节迁移在 §4 / §2 里各自单独提交）。

### 1.1 判定契约统一（`objective` / `reference`）

**问题**：现在 `SIMSCORE`（`assets/sim/simscore.js:217–218`）与 `validate-missions.mjs`（④⑤⑥⑧）、
`validate-ui.mjs`（`solve(art).words`）都假定作者答案是 `solve(art).words`（一个 4 元数组）。
`witness` 的作者答案是**一对输入**，`value` 是**一个字符串**，形状不同。

**新契约**（写进 `PRACTICE-SPEC.md` §5.7 与 §6）：

```js
objective = {
  kind: 'value' | 'state' | 'differential' | 'witness',
  prompt: string,
  fields: string[],                       // 表单字段名，数组顺序 = 界面顺序
  parse(form) -> candidate | null,        // 表单(object of string) → 判定用的候选；非法返回 null
  format(candidate) -> form,              // parse 的逆；作者答案要能变回"玩家会敲的样子"
  run(candidate, art) -> { ok, detail }   // 真判定
}

reference = {
  walkthrough: string[],                  // 终端里会敲的命令（校验器逐条真执行）
  route: [{ op, ... , label }],           // 工作台操作表（词汇表见 SIMSCORE.ROUTE_OPS）
  solve(art) -> { answer, ...extras }     // answer 与 parse 的输出同构；只读公开数据
}
```

**改动清单**：

1. `assets/sim/missions.js` 的 M22-1：
   - `reference.solve` 返回值把 `words` **改名为 `answer`**（保留其余字段 `rodataOff` / `matchedStandardWords` 不变）。
   - `objective` 三个函数**不变**（已经符合新契约）。
2. `assets/sim/simscore.js` 的 `submit` op（第 217 行）：`reference.solve(ctx.art)` 的 `.words` → `.answer`。
3. `validate-missions.mjs`：
   - ④ 的 `sol.words` → `sol.answer`；`ok(Array.isArray(sol.answer) ...)` 改成按 `mission.objective.kind` 分支（见 §1.6）。
   - ⑤ `art.truth.ivWords.slice()` 那段**改成调用 `mission.__pinCases`（见 §1.6）**，不再直接读 `truth.ivWords`。
   - ⑥ 用 `a.truth.ivWords` 判定"答案随 seed 变" → 改成用 `solve(a).answer` 的规范化字符串。
   - ⑧②b 的 `mission.reference.solve(art).words` → `.answer`。
4. `validate-ui.mjs`：
   - `mission.reference.solve(wb.art).words`（第 175、386 行）→ `.answer`。
   - `obj.format(...)` 的入参统一为 `.answer`。

**验收**：`node validate-missions.mjs m22-1` 与 `node validate-ui.mjs` 仍 exit 0 且输出与改前逐字一致
（`git stash` 前后对拍一次输出文本）。

**提交**：`refactor(sim): 判定契约统一到 reference.solve().answer —— 让四种判定共用同一条作者答案通路`

---

### 1.2 通用 `value` 判定（`assets/sim/simobj.js`，新文件）

**为什么单独一个文件**：`value` 是三种关卡（M13-1 / M17-1，以及 M4 的多数关卡）共用的判定原语；
写在每关的 `run` 里会得到 3 份等价实现 —— 正是 `PRACTICE-SPEC.md` §5.8 反对的"第二份实现"。

**接口**：

```js
/* assets/sim/simobj.js —— 判定原语（无 DOM，挂 window.SIMOBJ） */
window.SIMOBJ = {
  /* 规范化十六进制：去 0x / 去空白 / 小写。用于"同一个值的不同写法应等价" */
  normHex(s),
  /* 规范化十进制整数（返回 number 或 null） */
  normInt(s),
  /* 通用值判定工厂。返回 { parse, format, run } 三个函数，直接挂进 objective。 */
  valueObjective(opts) -> { parse, format, run }
}
```

`opts` 字段（**全部必填，除注明外**）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `fields` | `string[]` | 表单字段名（`value` 型通常 1 个） |
| `norm` | `s => string \| null` | 单个字段的规范化函数；返回 `null` = 格式非法 |
| `expected` | `art => string[]` | **真值**（从 `art.public` 算，**不许读 `art.truth`**）；与 `fields` 等长 |
| `hintWrong` | `string` | 错时的详情模板（**只指方向，不报值**；见 §3.3 泄漏纪律） |

**行为**：

- `parse(form)`：对 `fields` 逐个 `norm`；任一为 `null` → 返回 `null`；否则返回规范化后的 `string[]`。
- `format(candidate)`：返回 `{ [field]: candidate[i] }`。
- `run(candidate, art)`：
  - `candidate === null` → `{ ok:false, detail:'<fields 名> 都要填，且格式要合法' }`；
  - 逐字段与 `expected(art)` 比（**按规范化后的字符串比**，`value` 型不做数值容差）；
  - 全对 → `{ ok:true, detail:'✅ 与独立复算一致' }`；
  - 否则 → `{ ok:false, detail: hintWrong }` —— **不许把 `expected(art)` 的值写进 detail**。

**验收（单元级）**：在 `validate-missions.mjs` 加一组自检（见 §1.6 的 ⑩）：
`valueObjective` 的 `parse(format(x)) === x`、空表单被 `parse` 拒、`run` 对错各一次且错时 detail 不含真值。

**提交**：`feat(sim): 抽 SIMOBJ —— value 判定原语只留一份实现`

---

### 1.3 `witness` 判定 + `assets/sim/simops.js`（新文件）

**为什么**：`witness` 要把两段指令序列**真跑一遍**再比输出（`PRACTICE-SPEC.md` §5.7 ④）。
序列是**数据**（不许内联 JS），执行载体是白名单算子的**语义表**。这跟 `simnative.js` 管的
"ELF 映像读/改/调"是两件事，所以单独一个模块。

**数据格式（`.text` 里"程序"的编码）** —— 新算子表条目的常量区指向一段**后缀程序**：

```
程序 blob 布局（小端）：
  offset 0 : 'SMP0'        4 字节 magic
  offset 4 : u32 count
  offset 8 : count × { u8 opcode; u8 a; u8 b }     // 3 字节/条
    opcode : 白名单算子号
    a / b  : 操作数。0 = 取输入 x（第一个入参），1 = 取输入 y，≥2 = 立即数 (a-2) 的小端 u32 值
             —— 立即数另占 4 字节，紧随该条之后，且 a/b 里记为 0xFF 表示"读取后随的立即数"
```

> 简化裁定：**M19-1 只需要二元位运算**。因此第一批算子集固定为
> `{ 0:'add', 1:'xor', 2:'and', 3:'or', 4:'not', 5:'shl', 6:'shr', 7:'ushr' } `，
> 且程序是**严格的二元表达式树的前序遍历**（先算左、再算右、最后合并）——
> 不要引入栈机，栈机会让"程序"难以被静态断言。

**接口**：

```js
/* assets/sim/simops.js —— 白名单位运算算子的语义表 + 求值器（无 DOM，挂 window.SIMOPS） */
window.SIMOPS = {
  OPS: { add, xor, and, or, not, shl, shr, ushr },   // 每个是 (a,b) -> u32
  OPCODE: { add:0, xor:1, and:2, or:3, not:4, shl:5, shr:6, ushr:7 },
  /* 编码：把 AST 编成 blob（生成器用） */
  encode(ast) -> Uint8Array,
  /* 解码：blob → AST（校验器与工具用） */
  decode(bytes) -> ast,
  /* 求值：AST × {x, y} → u32 */
  eval(ast, vars) -> number,
  /* 列出用到的算子名（校验器用来核对白名单） */
  opsIn(ast) -> string[]
}
```

AST 形状：`{ op:'xor', l: <node>, r: <node> }`，叶子 `{ var:'x' }` / `{ var:'y' }` / `{ imm: 0x… }`。

**`witness` 的 objective 形状**（模板，M19-1 实例见 §2.1）：

```js
objective: {
  kind: 'witness',
  prompt: '…',
  fields: ['x', 'y'],
  parse: form => { /* 两个 32 位十六进制 → [x, y]，非法返回 null */ },
  format: pair => ({ x: hex32(pair[0]), y: hex32(pair[1]) }),
  run: (pair, art) => {
    if (!pair) return { ok:false, detail:'x、y 都要填 32 位十六进制' };
    const a = SIMOPS.eval(art.public.code.orig,    { x: pair[0], y: pair[1] });
    const b = SIMOPS.eval(art.public.code.patched, { x: pair[0], y: pair[1] });
    if (a === b) return { ok:false, detail:'这对输入在两条路径上输出相同 —— 它证明不了不等价' };
    return { ok:true, detail:'输出确实分歧 —— 这就是不等价的证据' };
  }
}
```

**注意**：`witness` 的"答案"是一片区域（任何触发分歧的输入都算过），**不属于泄漏**。
`PRACTICE-SPEC.md` §5.7 已把这条性质写进 `WIDE_OK` 的解释；新写 `validate-labs.mjs` 的 `WIDE_OK`
登记条目时沿用同一句理由。

**验收**：`SIMOPS.decode(SIMOPS.encode(ast))` 与原 AST 同构；对 M19-1 的两段程序，
存在一组 `(x,y)` 使输出分歧（由 §2.1 的参考解法证明）。

**提交**：`feat(sim): 白名单位运算算子表 + witness 求值器（simops.js）`

---

### 1.4 FORGE 扩展

三处，**都加在 `assets/sim/forge.js`，都是"新增分支"，不改既有分支的行为**：

#### 1.4.1 多算子 `.text`（M19-1 需要两个算子条目）

现在 `build()` 写死 `SIMNATIVE.writeTable(1)` + `writeEntry(table, 0, spec.so.op, …)`（第 112–113 行）。
改成读 `spec.so.ops`（数组）：

```js
// spec.so.ops = [{ name:'sub_carry', constKind:'program'|'bytes', … }]
// 向后兼容：没有 spec.so.ops 时，退化成今天的单条目行为（M22-1 不写就不用改）
const ops = spec.so.ops || [{ name: spec.so.op, constSize: constant.length, rodataOff }];
```

`writeTable(ops.length)` + 逐条 `writeEntry`。**M22-1 的行为必须逐字节不变** ——
验收：改前 `--dump` 落盘的 `m22-1-libtarget.so` 与改后 `cmp` 相同。

#### 1.4.2 新派生器 `code-vs-code`（M19-1）

```js
// DERIVERS['code-vs-code'](rng, opts) -> { constant, truth }
// opts = { orig: ast, patched: ast }
// 产出：constant = 两段程序的 blob（拼在一个 .rodata 里，用 ops 的 rodataOff 区分）
//      truth = { origOps: ast, patchedOps: ast }
```

#### 1.4.3 新派生器 `wb-table`（M14-1）

```js
// DERIVERS['wb-table'](rng, opts) -> { constant, truth }
// 产出：k0 = rng.int(256), k1 = rng.int(256)（并保证 k0 !== 0 或 k1 !== 0）
//      constant = 256 字节的表 T[x] = S[x ^ k0] ^ k1（S = CRYPTO.AES.sbox）
//      truth = { k0, k1, table: constant }
```

#### 1.4.4 新派生器 `log-aes`（M13-1）

```js
// DERIVERS['log-aes'](rng, opts) -> { constant, truth }
// 产出：key（32 字节）、iv（16 字节）、pt（8 字节）、algo、以及"被截断的 out 日志行"
//      constant = 日志行的字节（放进 .rodata 或直接当 public 字符串）
//      truth = { ct: <完整密文 hex>, key, iv, pt }
```

**冻结样本**：M13-1 / M17-1 的 `mission.seed` **写死为一个常量**（不随玩家变），
且该样本**必须与章节 lab 里那个静态样本不同**（见 §3.2 泄漏纪律）。

**提交**：`feat(sim): FORGE 支持多算子 .text 与三个新派生器（程序/白盒表/日志）`

---

### 1.5 `assets/practice.js` 去 M22-1 硬编码

现在这几处写死 M22-1：

| 位置 | 现在 | 改成 |
|---|---|---|
| `render()` 的 caveat 文案（第 116 行） | "…但 **libtarget.so** 是结构合法的真 ELF…" | 用 `mission.caveat` 字段；缺省时退回一句通用的"本设备是模拟器" |
| 终端 chips（第 165 行） | 写死 `logcat -s vault-native` | 用 `mission.chips`（`string[]`，缺省 `['help','uname -a','pm list packages','am start …']`） |
| `onSolved()`（第 562–567 行） | 写死 `art.truth.ivWords` / `mutatedIndex` / `constOffset` | 读 `mission.debrief(art)`，返回 `{ notes: string[] }`（**只有通关后渲染**） |
| 提交面板的 placeholder（第 127 行） | 写死 `例如 67452301` | 用 `objective.fields` + `mission.fieldPlaceholder || {}` |

`mission.debrief` 由关卡提供（M22-1 增加该字段，把现在那三段文字搬进去）。
`debrief` 是**通关后的复盘**，是 `truth` 的合法 DOM 出口（`PRACTICE-SPEC.md` §5.1 第 2 条登记的第 4 处出口
—— 实现时把 §5.1 那句"全篇访问点只有 3 处"更新为"4 处：3 处 + `debrief`"）。

**验收**：`node validate-ui.mjs` exit 0；浏览器里 M22-1 的通关复盘与改前逐字一致。

**提交**：`refactor(practice): 工作台文案与复盘由关卡数据提供，不再写死 M22-1`

---

### 1.6 `validate-missions.mjs` 泛化

**问题**：①②③④⑤⑥ 全部假定"ELF + md5-iv"。现在要做四类关卡，必须按判定种类 / 产物种类分支。

**改法**：给 `mission` 加一个 `artKind` 字段（枚举 `'native'` / `'code'` / `'log'`），
校验器按它决定跑哪组断言：

```js
const ART_CHECKS = {
  native: [checkDeterminism, checkElf, checkDeviceE2E, checkReferenceSolve, checkWrongRejected, checkSeed],
  code:   [checkDeterminism, checkCodeBlob, checkWitnessReachable, checkReferenceSolve, checkWrongRejected, checkSeed],
  log:    [checkDeterminism, checkLogTruth, checkReferenceSolve, checkWrongRejected, checkSeed],
};
```

**逐组要改的地方**：

| 组 | 现在 | 改法 |
|---|---|---|
| ① 确定性 | 比 `images[soPath]` | 比 `JSON.stringify(public)` + 全部 `images` 的字节（`native`）；`code`/`log` 比 `public` 的规范化 JSON |
| ② | `assertElf` | 只在 `artKind==='native'` 跑；`code` 换成 `assertCodeProgram`（magic `SMP0`、算子全在白名单、`decode` 能解出 AST、两段程序对同一输入不恒等）；`log` 换成 `assertLogTruth`（日志能 `JSON.parse`、`truth.ct` 等于用 `key`/`iv`/`pt` 独立复算的结果） |
| ③ | 设备端到端 | 只在有 `spec.app` 时跑；M19-1/M14-1/M13-1 是否给了设备由各关决定（见 §2） |
| ④ 参考解法 | `sol.words.length===4` | 改成 `ok(solve(art).answer !== undefined)` + `objective.run(solve(art).answer, art).ok` |
| ⑤ 反例 | 手编 `truth.ivWords` 改 1 位 | 改成**读 `mission.pins`**（见下）—— 每关自己给"必须被拒的提交"样例 |
| ⑥ 跨 seed | 用 `a.truth.ivWords` | 用 `solve(a).answer` 的规范化串比；"答案互不通用"改成"用 seed A 的答案在 seed B 上 `run` 不通过" |

**新增：每关自带 `pins`**（写进 `mission`，校验器直接消费）：

```js
pins: {
  // 必须被拒的提交（表单形状，走完整 parse→run 通路）
  reject: [ { w0:'00000000', w1:'00000000', w2:'00000000', w3:'00000000' } ],
  // 必须被接受的提交（走 parse→run）；省略则用 reference.solve
  accept: [ /* … */ ],
  // 失败详情的额外禁令（字符串数组：detail 里出现任一即判失败）
  forbidInDetail: ['答案清单', '逐项判定']
}
```

**新增 ⑩ 组：判定原语自检**（`SIMOBJ` / `SIMOPS` 的单元级对拍，见 §1.2 / §1.3 的验收）。

**验收**：`node validate-missions.mjs` exit 0；且新增的 `code` / `log` 分支在 M19-1 / M13-1 落地时被真跑到。

**提交**：`feat(validate): 关卡校验器按判定种类与产物种类分支，补 ⑩ 判定原语自检`

---

### 1.7 `validate-ui.mjs` 适配

`validate-ui.mjs` 的 ⑨ 组已经"真的加载 `practice.js` + 假 DOM + 走路线对账"，只需两处：

1. 沙箱加载列表（第 101 行附近）**加上** `assets/sim/simobj.js` 与 `assets/sim/simops.js`
   （顺序：`SIMELF` → `SIMNATIVE` → `SIMDEVICE` → `FORGE` → `SIMOPS` → `MISSIONS` → `SIMSCORE` → `SIMOBJ`）。
2. 反例构造（第 386 行）的 `mission.reference.solve(art).words` → `.answer`。

**验收**：`node validate-ui.mjs` exit 0，逐关打印"屏幕上的数 = 引擎重放的数"。

**提交**：与 §1.6 合并为同一个提交（校验器改造一并走）。

---

### 1.8 章节迁移配方（`assets/app.js` + `chapters/chNN.js`）

**已实现**：`Lab` 在 `cfg.mission` 存在时**在前面插一张交接卡**，然后**照常渲染整个 lab**
（`assets/app.js:1242–1258`）。**冻结为正式行为**，不改成"只显示卡片"。

**理由**（写进 `PRACTICE-SPEC.md` §7.3，替换"expected 退化为语法糖"那句含糊表述）：
章节 lab 的职责是**建立能力**（讲方法、给一个静态样本），实战区的职责是**收回前提**（样本自己挖、答案对拍）。
两者**样本不同**（章节是静态写死的，实战区是 FORGE 按 seed 现场生成的），所以章节 lab 通过**不构成白嫖**。
"退化为语法糖"的原意就是这一点，原文表述会引起误解，一并改掉。

**迁移 chNN.js 的操作（机械照做）**：

1. 找到目标 lab 的 `lab: {` 块。
2. 在 `title:` 之后插入：
   ```js
   mission: {
     id: 'm19-1',
     title: '两段“自称等价”的指令替换实际不等价 —— 交出一对反例',   // 必须与 missions.js 的 title 逐字相同
     line: '这里由正文把两段指令（和“它们等价”这个断言）直接喂给你。实战区把前提收走了——你得自己在设备上把两段程序挖出来，并构造对输入证明它们不等价。'
   },
   ```
3. **不动** `intro` / `inputs` / `run` / `expected` / `showAnswer` / `hint` / `after` ——
   除非该关的 §2 条目明确要求改（M17-1 要改，见 §2.4）。
4. `node validate-missions.mjs`：⑦ 组会核对 `id` 存在、`title` 不漂移、无孤儿工单。

**新增一条 ⑦ 组断言**（防止"迁移了但样本是同一个"）：

- 每关在 `mission` 上声明 `sampleIsDistinctFromChapter: true`，
  并在 `pins` 里给一个**章节 lab 的答案**（`chapterLabAnswer`）。
  校验器断言：`objective.run(parse(chapterLabAnswer), art).ok === false`
  —— 即**章节里那个答案，在实战区的靶场上必须通不过**。
  这样"章节 lab 通过 = 实战区通过"这条白嫖路径被机械堵死。

**验收**：M22-1 补上 `sampleIsDistinctFromChapter` 与 `chapterLabAnswer` 后仍 exit 0
（M22-1 的章节答案是 `a12b8f3e efcdab89 98badcfe 10325476`，实战区靶场是另一组字 → 天然通不过）。

**提交**：`feat(sim): 冻结交接卡迁移配方 —— 章节答案在实战区靶场上必须通不过`

---

## 2. 逐关实现（P1–P4）

> 每关都按 **P0 已完成** 写。每关 = 一个 `missions.js` 条目 + 一次 `chNN.js` 迁移提交 + `pins` 更新。

### 2.1 M19-1 · ch19 §19.5L —— `witness`（P1，先做）

**来源实验**：`chapters/ch19.js:536` 的 lab（四个候选式，其中 `(a^b)+(a&b)` 是假的）。
**它现在怎么判**：玩家填 `a`、`b`，`expected` 检查 `((a^b)+(a&b)) !== ((a+b)>>>0)`（即"找到了反例"）。
这本质就是 `witness` —— 实战区要做的是**把"两段程序"从"正文里写死的四个式子"换成"设备里挖出来的两段程序"**。

**mission 条目（`assets/sim/missions.js`，新增，形状照抄 M22-1）**：

```js
const M19_1 = {
  id: 'm19-1',
  chapter: 19,
  seed: 1905,                       // 固定：本关的"程序"不随玩家变，便于 PINS
  artKind: 'code',                  // 无设备，产物是两段白名单程序
  sampleIsDistinctFromChapter: true,
  title: '两段“自称等价”的指令替换实际不等价 —— 交出一对反例',
  tools: ['image', 'hook'],         // 需要"看程序"的能力
  brief: [
    '目标设备：Pixel 6 / Android 12 / arm64-v8a',
    '涉事应用：com.example.tanks（加固后的目标）',
    'libtarget.so 里有两个函数，加固器声称它们功能等价（一个是被替换后的形态，一个是原形态）。',
    '这两个函数各自是一段按位算子的组合 —— 顺序与算子都写在 .text 的算子表里。',
    '你的任务：各喂一组 32 位输入，证明这两个函数的行为并不等价。'
  ],
  acceptance: '提交一对 32 位输入（各 8 位十六进制）。系统会把这组输入在两条程序上真各跑一遍 —— 只有输出确实不同才算过。',
  hint: '两个函数各自只用到"异或 / 与 / 或 / 移位 / 加"。别用太干净的数（比如两个数没有共同为 1 的位）—— 那种输入下两条路径往往碰巧一致。',
  spec: {
    id: 'm19-1',
    device: { model: 'Pixel 6', sdk: 31, abi: 'arm64-v8a' },
    so: {
      path: '/data/app/com.example.tanks/lib/arm64/libtarget.so',
      ops: [
        { name: 'sub_carry',   program: /* AST，见下 */ },
        { name: 'sub_nocarry', program: /* AST，见下 */ }
      ]
    },
    props: { 'ro.product.brand': 'sim' },
    bootTrace: ['init: 模拟设备启动（SimDevice）', 'Zygote: 预加载完成', 'SystemServer: 就绪']
  },
  objective: {
    kind: 'witness',
    prompt: '提交一对 32 位输入（十六进制，每个 1–8 位）',
    fields: ['x', 'y'],
    parse: /* 同 §1.3 模板 */,
    format: /* 同 §1.3 模板 */,
    run: /* 同 §1.3 模板，读 art.public.code.{orig,patched} */
  },
  reference: {
    walkthrough: [
      'uname -a',
      'ls /data/app/com.example.tanks/lib/arm64',
      'file /data/app/com.example.tanks/lib/arm64/libtarget.so'
    ],
    route: [
      { op: 'image.elf',    label: '映像 · 看算子表与符号' },
      { op: 'image.hexdump', addr: 0x1000, len: 128, label: '映像 · 转储 .rodata（两段程序的字节）' },
      { op: 'note',         label: '在脑子里把两段程序对拍，构造一组会产生进位的输入' },
      { op: 'submit',       label: '提交一对输入' }
    ],
    solve: art => {
      // 纯静态：解析两段程序，穷举/构造一组使输出分歧的输入。只读 art.public，不碰 truth。
      const { orig, patched } = art.public.code;
      for (let x = 0; x < 256; x++) {
        for (let y = 0; y < 256; y++) {
          if (SIMOPS.eval(orig, { x, y }) !== SIMOPS.eval(patched, { x, y })) {
            return { answer: [x, y], /* extras */ };
          }
        }
      }
      throw new Error('参考解法：这两段程序在任何输入上都等价 —— 关卡设计错了');
    }
  },
  pins: {
    reject: [
      { x: '0000000c', y: '00000003' }    // 章节 lab 的预填值（不带进位）—— 必须通不过
    ],
    accept: [],                            // 用 reference.solve
    forbidInDetail: ['0x', '答案']
  }
};
```

**两段程序（AST，定死，写进 `spec.so.ops[].program`）**：

```js
// 原形态：a + b 的"带进位权重"展开
const ORIG = { op:'add', l:{ op:'xor', l:{var:'x'}, r:{var:'y'} },
                        r:{ op:'shl', l:{ op:'and', l:{var:'x'}, r:{var:'y'} }, r:{ imm:1 } } };
// 被替换后的形态：漏掉进位的 ×2
const PATCHED = { op:'add', l:{ op:'xor', l:{var:'x'}, r:{var:'y'} },
                           r:{ op:'and', l:{var:'x'}, r:{var:'y'} } };
```

> 为什么要 `shl 1` 而不是 `mul 2`：第一批算子只有位运算（§1.3），`shl 1` 与 `*2` 在 u32 上等价，
> 但只需要一个算子 —— 少一个算子就少一份要验的语义。

**FORGE 需要产出的 `public`**：

```js
art.public.code = {
  orig:    <AST>,           // 从 .rodata 的 blob 解码而来（也就是玩家能自己挖到的东西）
  patched: <AST>,
  sym: { orig: 'sub_carry', patched: 'sub_nocarry' }
};
```

**工作台要能"看"这两段程序**：`image.elf` 已能列符号表；`image.hexdump` 能转储 blob。
**再加一个只读视图**（不记步、不改判定）：`practice.js` 的映像面板在 `art.public.code` 存在时，
把 `SIMOPS.decode` 的结果渲染成文本（形如 `sub_nocarry(x, y) = (x ^ y) + (x & y)`）——
**这个渲染必须来自 `SIMOPS.decode`，不许另写一个 pretty-printer**（否则又是一份实现）。

**章节改动**：按 §1.8 配方，给 `chapters/ch19.js:540` 的 lab 加 `mission` 卡。
**章节 lab 不动**：它的答案是"一对带进位的数"，而本关的两段程序与章节的四个式子**不是同一批**，
所以章节通过 ≠ 实战区通过。`pins.reject` 与 §1.8 的新断言会机械证明这一点。

**引擎依赖**：§1.3（simops）+ §1.4.1 / §1.4.2（多算子表 + `code-vs-code`）。
**验收**：
- `node validate-missions.mjs m19-1` exit 0（② 走 `assertCodeProgram`，⑤ 用 `pins.reject`）
- `node validate-ui.mjs` exit 0（`artKind:'code'` 时工作台不渲染 device/terminal 面板 —— 见下）
- 浏览器手玩：挖到两段程序 → 提交 `(0x0C, 0x03)` 被拒 → 提交一组带进位的通过

**注意**：`tools: ['image','hook']` 下 `practice.js` 的 `render()` 不会渲染 device/shell 面板
（`has()` 决定），但 `wire()` 里 `root.querySelector('#pr-term')` 会拿到 `null` ——
`mkConsole(null)` 会崩。**必须先修这个**：`mkConsole` 接受 `null` 时返回一个 no-op console。

**提交**（两个）：
1. `fix(practice): mkConsole 容忍未渲染的面板节点`
2. `feat(sim): M19-1 —— 用 witness 判定证明两段程序不等价（ch19 §19.5L 迁移）`

---

### 2.2 M14-1 · ch14 §14.7 —— `differential`（P2）

**来源实验**：`chapters/ch14.js:767` 的 lab（五张表的统计量对比）。
**本关做的不是那个实验**：本关让玩家**把一张真白盒表还原成可执行的算法**（`.rodata` 里 256 字节的
`T[x] = S[x ^ k0] ^ k1`，还原 `(k0,k1)` 并证明行为一致）。交接卡挂在 §14.7（该章唯一带表的动手实验）。

**mission 条目要点**：

```js
const M14_1 = {
  id: 'm14-1', chapter: 14, seed: 1407, artKind: 'native',
  sampleIsDistinctFromChapter: true,
  title: '从 libtarget.so 还原白盒表背后的构造',
  tools: ['device', 'shell', 'image', 'hook'],
  brief: [
    '目标设备：Pixel 6 / Android 12 / arm64-v8a',
    '涉事应用：com.example.wallet',
    'libtarget.so 里有一张 256 字节的表，是"把 AES 的 S 盒按某个密钥复合、再异或"得到的。',
    '这张表就是白盒实现用来替换 S 盒的那张。',
    '你的任务：还原出它的构造参数（两个字节），使你的构造与这张表逐项一致。'
  ],
  acceptance: '提交两个字节（k0、k1，各 2 位十六进制）。系统会用你的参数把 S 盒复合一遍，与目标表逐项对拍 —— 256 项全一致才算过。',
  hint: '标准 AES 的 S 盒在 <code>window.CRYPTO.AES.sbox</code> 里是现成的（可以拿来当参照）。先想想：如果 k1 = 0，这张表会是什么样子？',
  spec: {
    id: 'm14-1',
    device: { /* 同 M22-1 */ },
    so: { path: '/data/app/com.example.wallet/lib/arm64/libtarget.so',
          op: 'wb-sbox', derive: 'wb-table' },
    app: { pkg: 'com.example.wallet', label: '钱包', input: 'wallet-pass',
           logTag: 'wallet-native', logFmt: 'sbox_probe() -> {out}' },
    /* … */
  },
  objective: {
    kind: 'differential',
    prompt: '提交还原出的两个构造参数（各 2 位十六进制）',
    fields: ['k0', 'k1'],
    parse: form => /* 两个 u8 */ ,
    format: pair => ({ k0: hex2(pair[0]), k1: hex2(pair[1]) }),
    run: (pair, art) => {
      if (!pair) return { ok:false, detail:'k0、k1 都要填 2 位十六进制' };
      const S = C.AES.sbox, T = art.public.table;         // 目标表是公开的（玩家自己挖得到）
      const N = 256;
      for (let x = 0; x < N; x++) {
        const got = (S[(x ^ pair[0]) & 0xff] ^ pair[1]) & 0xff;
        if (got !== T[x]) return { ok:false, detail:'第 ' + x + '/' + N + ' 项对不上 —— 你的构造与目标表不一致' };
      }
      return { ok:true, detail: N + ' 项全部一致 —— 你的构造与目标表行为等价' };
    }
  },
  /* reference / pins 同 §0 的写法 */
};
```

**关键点**：

- **`wb-sbox` 算子**要加进 `SIM_NATIVE_OPS`（`assets/sim/simnative.js:63`）：
  ```js
  'wb-sbox': { constSize: 256, desc: '白盒 S 盒（表由常量区给出）',
               run: (K, input) => { /* 对 input 逐字节查表，返回 hex */ } }
  ```
  这是"加一条算子 = 加一行 + 在 `PRACTICE-SPEC.md` §5.3 登记"的正例。
- **`art.public.table`**：目标表必须公开（它就在 `.rodata` 里，玩家 `hexdump` 就能读到）。
  在 `FORGE.build` 的 `public` 里加 `table: <Uint8Array>`（只在 `derive==='wb-table'` 时）。
- **`differential` 的 `vectors`**：本关不用随机向量，用**穷举 256 项**（表是有限域）。
  文案里必须写"256 项"，与循环共用同一个 `const N = 256`（`PRACTICE-SPEC.md` §5.7 的 `VECTORS` 单点原则）。
- **`solve`**：从 `art.public.table` 反推 —— 对 `k1` 的 256 种取值，令 `k0` 满足
  `k0 = x ^ invS[(T[x] ^ k1)]` 对全部 x 一致即可（`invS` = S 的逆表，现场由 `C.AES.sbox` 求逆得到）。
  必须**只读 `public`**。

**章节改动**：`chapters/ch14.js:767` 的 lab 加 `mission` 卡（§1.8 配方），lab 本身不动。
**验收**：`validate-missions.mjs m14-1`（② `assertElf` 照跑）+ `validate-ui.mjs` + 浏览器手玩。

**提交**：`feat(sim): M14-1 —— 白盒表构造还原（differential，ch14 §14.7 迁移）`

---

### 2.3 M13-1 · ch13 §13.10L —— `value`（P3）

**来源实验**：`chapters/ch13.js:1436` 的 lab（自吐日志 → 复算被截断的密文）。
**本关**：日志由 FORGE 生成（真 AES 算出的），其中一条被打断；玩家提交**完整密文**（`value`）。

**mission 条目要点**：

```js
const M13_1 = {
  id: 'm13-1', chapter: 13, seed: 1310, artKind: 'log',
  sampleIsDistinctFromChapter: true,
  title: '从自吐日志里复算出被截断的密文',
  tools: ['device', 'shell', 'image'],
  brief: [
    '目标设备：Pixel 6 / Android 12 / arm64-v8a',
    '涉事应用：com.example.bank',
    '这台设备上的监控模块把 App 的密码学调用逐条记进了一处日志，日志在设备里。',
    '其中一条 doFinal 的输出被日志长度上限截断了 —— 只能看到前 8 位十六进制。',
    '你的任务：把这条被截断的完整密文算出来。'
  ],
  acceptance: '提交完整的密文（十六进制）。系统会用日志里给的 key / in 独立复算一遍再比 —— 只有完全一致才算过。',
  hint: '日志里同时留着 <code>key</code> 与 <code>in</code>。AES 的变体由密钥长度决定（16 / 24 / 32 字节各对应哪个变体？）；有没有 <code>iv</code> 字段，决定了链式还是 ECB。',
  spec: {
    id: 'm13-1',
    device: { /* 同 M22-1 */ },
    so: { path: '/data/app/com.example.bank/lib/arm64/libmon.so', op: 'log-wrap', derive: 'log-aes' },
    app: { pkg: 'com.example.bank', label: '银行', input: 'pin=1234',
           logTag: 'monitor', logFmt: 'cipher={out}' },
    /* … */
  },
  objective: SIMOBJ.valueObjective({
    fields: ['ct'],
    norm: SIMOBJ.normHex,
    expected: art => [art.public.ctHex],
    hintWrong: '密文对不上。先读 algo 得到算法与模式，再读 keyLen 定变体，读有没有 iv 定模式，' +
               '然后用 key + in 自己复算一遍（提示：PKCS5 填充会把不足一组的明文补满一组）。'
  }),
  reference: {
    walkthrough: ['uname -a', 'cat /data/local/tmp/mon.log', 'logcat -s monitor'],
    route: [
      { op: 'shell', cmd: 'cat /data/local/tmp/mon.log', label: '终端读日志' },
      { op: 'note',  label: '从 algo / keyLen / iv 字段定参数，用 key + in 复算' },
      { op: 'submit', label: '提交完整密文' }
    ],
    solve: art => ({ answer: [art.public.ctHex] })   // 只读 public
  },
  pins: {
    reject: [{ ct: '' }, { ct: '00' }, { ct: <章节 lab 的答案 e605e27d…> }],
    accept: [],
    forbidInDetail: ['e605e27d', '密文是']
  }
};
```

**要点**：

- **`art.public.ctHex` 必须是公开的**吗？**不是** —— 它是答案。`solve` 只用**公开**数据（日志字段）
  *算出*它，而不是读它。所以 `public` 里给 `{ logLines, key, iv, pt, algo }`（日志本身就是公开材料），
  **不给 `ctHex`**；`ctHex` 放 `truth`。
  → 相应地 `objective.expected(art)` **必须能从 `public` 自己算**：改成
  ```js
  expected: art => [recompute(art.public)]   // recompute 用 CRYPTO 真算，与 truth 独立
  ```
  这条正好是"两条独立路径"的价值：`truth.ct` 由生成器算，`expected` 由 `run` 侧用 `CRYPTO` 再算一遍，
  两者必须对上（校验器 ② 组 `assertLogTruth` 断言这一点）。
- **日志落在设备上**：`FORGE.build` 把日志行写进 `world.files['/data/local/tmp/mon.log']`，
  并让 `setup` 也往 `logcat` 里写一份（`monitor` tag）。玩家用 `cat` 或 `logcat -s monitor` 读。
- **`log-wrap` 算子**：白名单里新增一条（把日志字符串按给定长度截断），登记进 §5.3。
- **`SIMOBJ.valueObjective`** 见 §1.2。

**章节改动**：`chapters/ch13.js:1445` 的 lab 加 `mission` 卡，lab 本身不动（章节用静态样本 `e605…`，
实战区用 FORGE 生成的另一套 key/pt → 答案不同）。
**`pins.reject` 里放章节答案**：机械证明"章节抄答案过不了实战区"（§1.8 新断言）。

**验收**：`validate-missions.mjs m13-1`（② 走 `assertLogTruth`）+ `validate-ui.mjs` + 浏览器手玩。

**提交**：`feat(sim): M13-1 —— 从自吐日志复算被截断密文（value，ch13 §13.10L 迁移）`

---

### 2.4 M17-1 · ch17 §17.2L —— `value`（P4；**先修展示 bug**）

**来源实验**：`chapters/ch17.js:210` 的 lab（ARM32 / AArch64 地址换算）。

#### 2.4.1 先修展示 bug（**单独一个提交，在迁移之前**）

**bug 是什么**（`assets/labx.js:113` 的 `thumbDecode` 与 `chapters/ch17.js:231–254` 的配合）：

- `thumbDecode(input, 'arm32')` 把入参当**IDA 偏移**，返回 `{ off: v, value: v, fridaAddr: v + 1 }`。
- 但章节 lab 的题面要求玩家填**Frida 实参**，`expected` 又要求 `a.value === 0x1A4D`（即 Frida 实参）。
- 于是玩家填 `0x1A4D` 时：表格里"IDA 偏移"显示 `0x1A4D`（应是 `0x1A4C`）、
  "Frida 实参"显示 `0x1A4E`（应是 `0x1A4D`）—— **同一张表里两列都错一位，且与判分器口径不一致。**

**修法（只改 `chapters/ch17.js`，不碰共享的 `labx.js`）**：
把 lab 的入参语义统一为 **IDA 偏移**：

- `intro` 明确"填你从 IDA 看到的那个偏移（`0x1A4C` 这种偶数对齐值）"；
- `run`：用 `thumbDecode` 的返回值同时显示两列（IDA 偏移 = `off`，Frida 实参 = `fridaAddr`），
  并显示"你填的"= 原始输入；
- `expected`：判定标准从 `a.value === 0x1A4D` 改成 `a.off === 0x1A4C`（ARM32）。
- `showAnswer` / `hint` 里凡引用"填 `0x1A4D`"的地方同步改成"填 IDA 偏移 `0x1A4C`，得到 Frida 实参 `0x1A4D`"。

**验收**：浏览器手玩：填 `0x1A4C` → 表格显示 IDA `0x1A4C` / Frida `0x1A4D`，判分通过；填 `0x1A4D` → 不通过
（并给出"这个数已经是 Frida 实参了，文件里当然没有这个入口"的提示）。
`node validate-labs.mjs 17` 的 PINS 若因这次改动而需要更新，按"手法必须继续失败 / 正确答案必须继续通过"重钉。

**提交**：`fix(ch17): 地址换算实验的展示与判分口径统一到“IDA 偏移”，不再各错一位`

#### 2.4.2 迁移（第二个提交）

```js
const M17_1 = {
  id: 'm17-1', chapter: 17, seed: 1712, artKind: 'log',   // 产物=一份冻结样本（见下）
  sampleIsDistinctFromChapter: true,
  title: '从冻结样本算出该传给 Frida 的地址',
  tools: ['device', 'shell'],
  brief: [
    '目标设备：Pixel 6 / Android 12 / arm64-v8a',
    '涉事应用：com.example.game',
    '分析报告给了两个架构下同一个函数的 .text 段内偏移（一份冻结样本，在设备里）。',
    '报告不给结论 —— 你得自己算出该填进 base.add(...) 的那个数。',
    '你的任务：分别给出 ARM32 与 AArch64 下该填的偏移。'
  ],
  acceptance: '提交两个偏移（十六进制）。系统按 Thumb 规则与 AArch64 定长规则各自核一遍 —— 两个都对才算过。',
  hint: 'ARM32 有 ARM / Thumb 两套指令集，取指时靠地址的最低位区分；AArch64 没有这套机制。',
  spec: {
    id: 'm17-1',
    device: { abi: 'arm64-v8a', sdk: 31, model: 'Pixel 6' },
    so: { path: '/data/local/tmp/report.txt', op: 'raw', derive: 'raw',
          bytes: /* 冻结样本的字节（一串 ASCII，写明 IDA 偏移 0x2B70） */ }
  },
  objective: SIMOBJ.valueObjective({
    fields: ['arm', 'a64'],
    norm: s => /^(0x)?[0-9a-fA-F]{1,8}$/.test(s.trim()) ? '0x' + parseInt(s, 16).toString(16).toUpperCase() : null,
    expected: art => ['0x2B71', '0x2B70'],     // ← 冻结样本 0x2B70 推导而来；不是章节里的 0x1A4C
    hintWrong: 'ARM32 那个数要想清楚“最低位”的用处；AArch64 没有指令集切换，偏移原样用。'
  }),
  reference: {
    walkthrough: ['cat /data/local/tmp/report.txt'],
    route: [
      { op: 'shell', cmd: 'cat /data/local/tmp/report.txt', label: '终端读分析报告' },
      { op: 'note',  label: '按两种架构的取指规则各算一个偏移' },
      { op: 'submit', label: '提交两个偏移' }
    ],
    solve: art => ({ answer: /* 从 art.public.report 解析偏移后按规则算 */ })
  },
  pins: {
    reject: [{ arm: '0x1A4D', a64: '0x1A4C' }],   // 章节 lab 的答案 —— 必须通不过
    accept: [],
    forbidInDetail: ['2B71', '2B70']
  }
};
```

**要点**：

- **冻结样本**：`derive:'raw'`（已有派生器）+ 写死的字节。**样本偏移选 `0x2B70`**，
  与章节的 `0x1A4C` **不同** → 章节答案在实战区通不过（`pins.reject` 证明）。
- **不用设备**：`tools:['device','shell']` 只用到终端读一个文件 → 为了少一类产物，
  `artKind` 保持 `'log'`（就是"一份文本产物"），`assertLogTruth` 只断言"文件读得出来、且与 `public` 一致"。
- **"为什么"那一问（章节 lab 的 ③）不进实战区** —— 关键词判定不属于四种 objective 中的任何一种，
  强行搬过来会得到"填关键词"的白嫖口子。章节 lab 保留 ③（它本来就是章节的能力建设）。

**章节改动**：`chapters/ch17.js:218` 的 lab 加 `mission` 卡。
**验收**：`validate-missions.mjs m17-1` + `validate-ui.mjs` + 浏览器手玩。

**提交**：`feat(sim): M17-1 —— 冻结样本的地址换算（value，ch17 §17.2L 迁移）`

---

## 3. 跨关卡的通用改动（随 P1–P4 一起做）

### 3.1 `practice.html` / 沙箱加载列表

新增 `assets/sim/simops.js` 与 `assets/sim/simobj.js`，**必须三处同步**：

1. `practice.html` 的 `<script>` 列表（顺序见 §1.7）；
2. `validate-missions.mjs` 的 `makeSandbox()`（第 49–55 行）；
3. `validate-ui.mjs` 的 `load()`（第 101 行附近）。

漏一处的症状：Node 侧全绿、浏览器里 `SIMOPS is not defined`。
**加一条防回归**：`validate-chapters.mjs` 已有"脚本存在性"检查的前提下，
在 `validate-missions.mjs` 的 ⑩ 组断言 `sb.SIMOPS && sb.SIMOBJ` 存在。

### 3.2 泄漏纪律（`value` / `differential` 关的 `detail` 不许报值）

沿用 `validate-labs.mjs` 的 `noLeakAny` 思路，在 `validate-missions.mjs` 里对**每关**做：

- 对 `pins.reject` 的每个样例跑一遍 `objective.run`，**断言返回的 `detail` 里不含**
  `pins.forbidInDetail` 里的任何子串，也不含 `objective.expected(art)` 的任何一个值。

### 3.3 失败详情能写什么、不能写什么（照抄章节侧已定的口径）

- **能写**：判据 / 定义、方法与公式、把玩家指到"运行 / 提示 / 看答案"、复读玩家提交的值、前提值。
- **不能写**：答案值、答案清单、答案序列、逐项判定表。
- 章节侧同一口径见 `CHAPTER-SPEC.md` §2.3 与 `validate-labs.mjs` 的 `noLeakAny`。

### 3.4 `README.md` / `CHAPTER-SPEC.md` / `PRACTICE-SPEC.md` 的同步

- `README.md`：工具清单（若新增脚本）、**实战区小节里的工单数**（1 → 5）、已知限制第 9 条。
- `CHAPTER-SPEC.md` §6.1：把新文件（`assets/sim/simops.js`、`assets/sim/simobj.js`）加进"只许新增"清单。
- `PRACTICE-SPEC.md`：
  - §5.3 算子白名单表**加 4 条**（`wb-sbox` / `log-wrap` / 位运算算子组 / 程序 blob 格式）；
  - §5.7 的 `witness` 段改成"程序 blob + `SIMOPS.eval`"的确切说法；
  - §6 数据契约：**明确"定义在 `missions.js`、卡片在 `chapters/chNN.js`"**（§6 原文把整份定义写进 `lab.mission`，与已实现的 M22-1 不一致，改掉）；
  - §7.2 的 4 关行更新为"已交付"；
  - §7.3 用 §1.8 的理由替换"expected 退化为语法糖"那句；
  - §11 里程碑把 M3.1 标 ✅（逐关标）。

---

## 4. 长期队列（P5 起，本次不做，只登记）

### 4.1 M1b · `assets/sim/simvm.js`（DEX 子集解释器）

- 消费者：M4 的 ch02 / ch03 / ch16 / ch21。
- 契约已在 `PRACTICE-SPEC.md` §5.2（约 20 条指令、数据驱动 `OPS`、每关声明 `dex.opcodes`）。
- **不做**的原因不变：没有第一个真消费者时先写会得到无法验证的推测代码。
- 接续时的前置：先在 `validate-missions.mjs` 里加一组"字节码反汇编 ↔ 执行结果一致"的对拍，再写解释器。

### 4.2 M4 · 长期队列（原 18 关清单剩下的 13 关）

- 每关仍要过 §7.1 的两条门槛（判分先过关 + 引擎就绪）。
- 已知需要 SimVM 的：ch02（寄存器布局 / 读 Smali）、ch03（ELF 头解析器）、ch16（dex 头）、ch21（导入表分类）。
- 每关的落地流程与 §2 完全相同（读来源 lab → 定 artKind → 定 objective → 写 solve → 迁移卡片 → 验收）。

### 4.3 M5 · 脚本类关卡

- 到那时才需要在 §0.3 第 7 条的三个方案里选一个（第三轴换脚本行数 / 双轴 / 坚持步数）。
- 触发条件：出现**产出是一段 Frida 脚本**的关卡（原清单里的 ch11 Hook 点升级）。

---

## 5. 已交付部分的对照（供改代码时避免误伤）

| 已交付 | 位置 | 本次改不改 |
|---|---|---|
| 引擎：simelf / simnative / simdevice / forge / simscore | `assets/sim/*` | 改（§1.1 / §1.3 / §1.4） |
| 关卡定义 M22-1 | `assets/sim/missions.js` | 改（`words`→`answer`、加 `debrief`/`pins`/`artKind`/`sampleIsDistinctFromChapter`） |
| 工作台 + 收件箱 | `assets/practice.js` | 改（§1.5 去硬编码、§2.1 修 `mkConsole`、加程序视图） |
| 交接卡渲染 | `assets/app.js:1242` | **不改** |
| 交接卡样式 | `assets/style.css` 的 `.handoff` | **不改** |
| 关卡校验器 | `validate-missions.mjs` | 改（§1.6） |
| 界面对账 | `validate-ui.mjs` | 改（§1.7） |
| 判分自检 / 详情审计 | `validate-labs.mjs` / `audit-lab-details.mjs` | 只在 PINS 需要时改 |

**M22-1 的回归基准**（每次改引擎后必须仍然成立）：

```
node validate-missions.mjs m22-1 --dump E:\Temp\opencode\m22dump
# → ①②③④⑤⑥⑦⑧ 全绿；m22dump\m22-1-libtarget.so 与改前逐字节相同
```

---

## 6. 验收总表（每个里程碑收尾时跑一遍）

```
node validate-chapters.mjs        # 32 章结构
node validate-labs.mjs            # 52 实验判分自检 + PINS
node validate-missions.mjs        # 全部工单：确定性/ELF/设备/参考解法/反例/跨 seed/交接卡/基线
node validate-ui.mjs              # 工作台界面账本与引擎重放对账
node check-integrity.mjs          # 章号/标题/文件名
node build-cases.mjs --check      # cases.html 不过期
```

全部 exit 0，且 `validate-missions.mjs` 的交接卡覆盖率行显示 `5/5 个工单有章节入口`。

---

## 7. 附：一句话交接给实现者

> **先做 §1（都不碰章节文件，可一次性提交），再做 M19-1；**
> **每关 = 一个 `missions.js` 条目 + 一次 `chNN.js` 迁移提交；**
> **任何时候发现"某个数不是真算出来的 / 某个答案自己漏出来了"，停下来先修它 —— 这就是"先修复、再糖化"。**
