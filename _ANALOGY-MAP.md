# Android 逆向 ↔ Web/JS 逆向 概念映射表

> **目的**: 写给所有改写 agent 的统一参考。每个 agent 在每一章里加 "Web 视角" 注释时,
> 严格按这张表的措辞,避免风格漂移。

## 写法约定
- 段落里用 `<span class="pill">JS 视角</span>` 标头引出
- 一段不超过 3-4 行,要"看一句就懂",不展开教学
- 同一章内多次出现同一概念时,首次展开,之后简写
- 不要把"Web 比 Android 简单"或反之,平铺直叙两类技术的真实差异

---

## 1. 静态分析层 (静态看代码)

| 安卓概念 | JS 逆向对位 | 一句话类比 |
|---|---|---|
| **APK (zip 格式的应用包)** | 整个网站 (HTML+JS+CSS+资源) | 都是一个"自包含的发布包",解压就能看 |
| **classes.dex / odex / vdex** | main.js / app.js (打包后的 bundle) | 都是"线上跑的代码"——人写的不是它,人读它要展开 |
| **Smali (dex 的可读汇编)** | Webpack/babel 编译后的可读 JS (source map 关闭时) | "丢失源码后的最低可读形式",一行 JS 一行 Smali 对得上 |
| **Java 源码 (反编译出来)** | 第三方 .js 反混淆/格式化后的代码 | 都是"猜出来的",不是原版,变量名/结构常被混淆 |
| **Native 层 / .so (ARM 字节码)** | WASM 模块 (.wasm) | 都是"高级语言外的第二条指令世界",都需要专门的逆向工具 |
| **APK 文件结构 (res/、lib/、assets/、AndroidManifest.xml)** | 站点目录结构 (assets/、static/、api/) | 都是"文件树决定结构",文件头/目录约定是阅读的第一步 |
| **AndroidManifest.xml (二进制 XML)** | 路由表 / 入口 HTML 的 head | "声明这个应用怎么被外部触发"——App 怎么被打开 vs 站点怎么被访问 |
| **资源 ID (R.id.xxx) 整数映射** | Webpack module id 数字 | 都是"打包后名字变数字,改时按数字找" |
| **签名 (META-INF/CERT.RSA)** | 站点 CSP/SRI (Subresource Integrity) | 都是"防篡改的指纹"——改了内容签名就对不上 |
| **APK 签名 v1/v2/v3/v4** | CSP/SRI 多个版本共存 | 都是"老的方案被覆盖但还在",需要按 Android 版本理解 |
| **资源混淆 (AndResGuard)** | JS 变量名混淆 (o/0x 替换) | 都是"让静态阅读变难" |
| **字符串加密 (dex 里) (DexGuard)** | 字符串数组 + RC4/AES 解密 (OB 混淆) | 都是"代码里不直接写字面量" |

## 2. 运行时层 (代码怎么跑)

| 安卓概念 | JS 逆向对位 | 一句话类比 |
|---|---|---|
| **四大组件 (Activity/Service/BroadcastReceiver/ContentProvider)** | 路由 + Controller + 事件总线 + 数据源 | 都是"被外部请求触发的入口"——每条入口都是一个攻击面 |
| **生命周期 (onCreate/onResume/onPause/onDestroy)** | 路由钩子 (beforeEnter/activated/deactivated/unmounted) | 都是"被框架调度的代码",不是自己跑 |
| **Handler / Looper / MessageQueue** | 事件循环 (Event Loop) + 任务队列 (Task/Microtask) | 完全同构:主线程"等消息 → 分发 → 回调" |
| **主线程 (UI 线程) ANR** | 渲染卡顿 (Long Task > 50ms) | 都是"占住事件循环,系统看不下去了" |
| **Zygote fork (App 进程的诞生方式)** | iframe 创建 (子 frame 继承父 window) | "子进程/子 frame 不是从零开始,而是从父复制一份" |
| **JIT / AOT (ART 编译)** | V8 解释器 → TurboFan 优化编译 | "字节码先解释跑,热代码编译成机器码"——逻辑完全一样 |
| **类加载器 (ClassLoader / DexClassLoader)** | 动态 import / require / dynamic import() | 都是"运行时按需加载新模块" |
| **JNI / JNIEnv / native 方法注册** | N-API / FFI (Node.js addon) | 都是"高级语言和 native (C/C++/Rust) 的桥" |
| **Binder IPC** | postMessage / Web Worker 通信 | 都是"跨进程/跨线程的 RPC" |
| **Application.onCreate** | main.js 顶层执行 | "App 一启动就跑一次的初始化"——所有全局 hook 的好地方 |
| **attachBaseContext** | 在 iframe 加载前注入 (init script) | "比所有页面代码都早的钩子"——加固最爱 |
| **ContentProvider.onCreate (早于 Application.onCreate)** | Service Worker 的 install 事件 (早于 fetch) | "系统级别的最早入口"——比主应用还早 |

## 3. 动态调试层 (运行时观察/修改)

| 安卓概念 | JS 逆向对位 | 一句话类比 |
|---|---|---|
| **Frida (注入 + RPC + hook)** | 浏览器 DevTools + Remote Debugging / 油猴脚本 | 都是"把代码拖出来跑/改/看",Frida 比 DevTools 更狠是能改 native |
| **Frida Hook (Java.use / Interceptor.attach)** | DevTools breakpoint / 油猴 hook / Proxy 拦截 | 完全同质,只是 Frida 能改 native |
| **Xposed / LSPosed (Zygote 注入)** | 浏览器扩展 (注入到所有页面) | "在所有 App 创建前注入"——影响的是进程诞生方式 |
| **Frida Spawn (gating 重启)** | --js-flags="--nojit" / 启动前注入 | "程序还没开始跑就插桩" |
| **adb (Android Debug Bridge)** | Chrome DevTools Protocol (CDP) | 都是"控制目标进程的桥" |
| **logcat** | console.log (但 logcat 是整个系统共享的) | 区别:JS 只能看到自己网页的 console, logcat 能看到系统所有 App |
| **Frida Stalker (指令级 trace)** | V8 --print-opt-code / --trace-opt | 都是"看 JIT 编译的中间产物" |
| **Frida Memory.scan()** | 浏览器 Memory snapshot / heap dump | "在内存里搜特征字符串/值" |
| **Frida dump DEX (内存转储)** | 浏览器 export 整个 bundle (.js) | 都是"运行时把代码从内存里掏出来"——这是脱壳的本质 |
| **frida-trace** | Chrome Performance trace /火焰图 | "哪些函数被调用了多少次" |
| **Hook Native (Interceptor.attach on so)** | WASM hook / Emscripten 调 C 函数的拦截 | 都是"native 层的 hook"——比 JS 层难一档 |
| **反 Frida 检测 (端口 27042 / /proc/self/maps)** | 反调试 (DevTools 检测 / debugger trap) | "你的工具会被目标发现"——两边都有猫鼠游戏 |

## 4. 反编译 / 反混淆

| 安卓概念 | JS 逆向对位 | 一句话类比 |
|---|---|---|
| **jadx (dex → Java)** | webcrack / unwebpack / sourcemap 还原 | 都是"字节码→源码"的工具,质量看混淆程度 |
| **JEB (商用反编译器)** | IDA Pro / Binary Ninja (商用) | 都是"收费的、更聪明的反编译" |
| **apktool (dex ↔ smali 双向)** | swc 编译 / deobfuscator (双向) | 都是"既能拆也能装"——但 apktool 是行业标准,swc 不行 |
| **Ghidra / IDA (so 反编译)** | wasm-decompile / wasm2wat | 都是"native 字节码的逆向工具" |
| **控制流平坦化 (OLLVM)** | JS 控制流平坦化 (OB 的 dispatcher) | "if-else 链被改成 while-switch 调度"——完全一样的反模式 |
| **OLLVM 字符串加密** | 字符串数组 + index | 完全一样 |
| **OLLVM 虚假控制流 (fake branch)** | 永不执行的 if 分支 | 都是"塞垃圾让反编译难看" |
| **VMP (虚拟指令保护)** | JSVMP (瑞数/顶象/极验 的 vmp) | 概念上完全同构:把字节码转成自定义虚拟机的指令 |
| **VMP 解释器 (dispatcher loop)** | JSVMP 的 eval-loop / switch-case | 都是"用一套指令模拟另一套指令" |
| **OLLVM 三兄弟 (bcf/fla/sub)** | JS 三大混淆 (字符串/控制流/变量名) | 类别一一对应 |

## 5. 脱壳

| 安卓概念 | JS 逆向对位 | 一句话类比 |
|---|---|---|
| **壳 (Packer)** | JS 加密 (eval 加密 / p.aencode / sojson) | 都是"代码外面再套一层,运行时才解开" |
| **第一代壳: 整体 dex 加密** | 整体 JS 加密 (整个文件 base64 + 自执行解密) | "原代码完全不可见,只有解密后才是真的" |
| **第二代壳: 函数粒度抽取** | 函数粒度加密 (部分函数加密,运行时填充) | "原代码部分可见,部分被抽走" |
| **第三代壳: VMP + dex2c** | 整段 JS 编译成 WASM | "原代码变成完全不同的指令系统" |
| **FART / 主动调用** | hook 触发加密函数 | "逼加密函数自己跑一遍,把解密的代码 dump 出来" |
| **内存 dump (DexClassLoader 加载后)** | 浏览器 export 全部已加载模块 | "代码要执行就要在内存里完整存在"——抓住这刻 dump |
| **修复 (修复 dump 出来的 dex 的方法数等)** | 修复导出 JS 的依赖/原型链 | "dump 出来的不完整,要修复才能用" |
| **xposed 脱壳 (Zygote 注入,在加载时 dump)** | Service Worker install 阶段拦截 | "在加载最早期抓" |
| **脱壳点: ClassLinker / DexFile::Open** | V8 module resolve 阶段 | 都是"字节码被加载的那一瞬" |

## 6. 协议 / 网络

| 安卓概念 | JS 逆向对位 | 一句话类比 |
|---|---|---|
| **抓包 (Charles / Burp / mitmproxy)** | Reqable / Charles / Fiddler | 完全一样,都是"中间人看 HTTPS" |
| **SSL Pinning (证书绑定)** | 浏览器/Node 也有证书校验 | "App 不信系统的证书,信自己的"——绕过的思路两边一样 |
| **双向证书 (client cert)** | mTLS (双向 HTTPS) | 都是"客户端也要证书" |
| **JustTrustMe / JustTrustMePro (绕过 SSL pinning)** | Node --ignore-certificate-errors / 浏览器证书替换 | "把系统证书塞回去让 App 信" |
| **VPN 代理 (应用层 VPN)** | 浏览器 DevTools / 油猴 | 都能做流量观察 |
| **Frida Hook 网络层 (okhttp3.Interceptor)** | XHR/fetch hook | 都是"在请求发出前/收到后改" |
| **协议算法 (sign / token 生成)** | 协议算法 (sign / token / x-s) | 完全一样,这是所有协议还原的核心 |

## 7. 工具 / 命令

| 安卓命令 | JS 工具 | 类比说明 |
|---|---|---|
| `adb shell pm list packages` | Chrome DevTools "Application" 标签 | 列出所有"应用" |
| `adb shell dumpsys` | DevTools "Network" / "Application" 各种面板 | 看运行时状态 |
| `adb pull /data/app/xxx/base.apk` | DevTools "Sources" 标签右键 Save As | 把代码导出到本地 |
| `adb logcat -s MyTag` | `console.log` filter | 按 tag 过滤日志 |
| `am start -n com.app/.MainActivity` | 点击页面按钮 | 主动触发一个入口 |
| `pm install / uninstall` | 浏览器刷新 / 关页签 | 装/卸应用 |
| `getprop ro.build.fingerprint` | navigator.userAgent | 设备指纹 |
| `setprop` / `magisk` | navigator.__defineGetter__ | 修改环境值 |
| `objdump / readelf` | 浏览器 binary viewer (wasm 字节) | 看 native 字节码 |
| `strace / ltrace` | Chrome DevTools "Profiler" | 系统调用 trace |
| `gdb / gdbserver` | Chrome DevTools Debugger | 调试器 |
| `nm / objdump -t` | wasm-decompile 符号 | 导出符号表 |
| `apksigner verify` | 校验 hash/SHA256 | 验证完整性 |

## 8. 反检测 / 风控对抗

| 安卓概念 | JS 逆向对位 | 类比说明 |
|---|---|---|
| **检测 root (su 文件/magisk)** | 检测 navigator.webdriver | "环境被改造过的指纹" |
| **检测 Frida (端口/proc/self/maps)** | 检测 DevTools 开了 | "调试器开着呢,我拒绝" |
| **检测 hook (方法签名/inline hook)** | 检测 Proxy / toString 被改 | "我的代码被动过" |
| **检测模拟器 (qemu/pipe)** | 检测 WebGL 渲染器 / 屏幕尺寸异常 | "设备特征不符合真人" |
| **Frida 主动隐藏 (改名/端口改)** | --remote-debugging-port=0 (隐蔽) | "我自己藏起来" |
| **环境伪造 (Xposed 改返回值)** | 改 navigator.userAgent 等 | "返回假的特征" |
| **OLLVM 抗反编译** | JS 抗格式化混淆 | "反编译出来也是垃圾" |
| **反 eBPF 追踪** | 反 Chrome DevTools trace | "你别看我的执行" |
| **SafetyNet / Play Integrity** | Cloudflare Turnstile / Akamai Bot Manager | "权威第三方说我是不是好人" |
| **VMP + 反调试 + 反 hook 三件套** | OB 4 代/5 代 + 反调试 + 环境校验 | 都是"行业顶配" |

## 9. 案例 / 实战类比

| 安卓 | Web/JS |
|---|---|
| 360 加固 / 腾讯乐固 / 梆梆 / 爱加密 / 网易易盾 | 瑞数 (Ruishu) / 顶象 / 极验 4 代 / 同花顺 / 数美 / Akamai Bot Manager |
| Frida 主动调用脱壳 | 浏览器 F12 trigger lazy function |
| 逆向某加固的"入口" | 找某站 sign 的"入口函数" |
| FART 脱壳 dump | Web 端 hook 后 console.log 整个 module |
| 还原 dex 的加密算法 | 还原 .js 的 sign 函数 |
| OLLVM 还原 | OB/JSVMP 反混淆 |
| 算法还原 (RSA/AES in dex) | 算法还原 (sign 里的 SM3/HMAC) |

## 10. 章节目录级映射 (在 32 章里要"插入"的视角)

| 章 | 安卓主题 | 适合插入的 JS 视角 |
|---|---|---|
| 1 | 安卓应用基础模型 | 事件循环 / iframe / postMessage / iframe 沙箱 / Service Worker |
| 2 | Smali 与重打包 | 编译后 JS 改一行 / 重新签名 SRI / webpack 重打包 |
| 3 | APK/DEX/ELF 文件格式 | bundle / source map / WASM 字节码格式 |
| 4 | 应用安全风险 | 浏览器 XSS/CSRF 风险 → 类比移动端风险面 |
| 5 | 环境配置与定位 | DevTools 装好 / 断点怎么下 / Network 怎么过滤 |
| 6 | RSA 加密 | Web 端 RSA 签名 / PKCS1 填充 |
| 7 | AI 辅助 | 浏览器中调用 LLM 解混淆 / 让 AI 帮你读混淆代码 |
| 8 | 加固全景 | JS 加密生态 (sojson/OB/JSVMP) 全景 |
| 9 | JNI/NDK | WASM / N-API / FFI |
| 10 | Frida 自动化 | Puppeteer / Playwright 自动化 |
| 11 | Xposed/LSPosed | 油猴 / 浏览器扩展 (注入到所有页) |
| 12 | 抓包与协议 | Reqable / Charles 抓包 / WebSocket 抓包 |
| 13 | 自吐沙箱 | 蜜罐 / 模拟浏览器环境 |
| 14 | 白盒密码 | WASM 实现的密码学 / 编译到 native 的 key 提取 |
| 15 | Frida 基础 | DevTools / 油猴基础 |
| 16 | FART 脱壳 | hook 触发懒加载函数导出 |
| 17 | ARM/C++ | WASM 反编译 / wasm2wat |
| 18 | ART 沙箱 | V8 sandbox / node vm |
| 19 | OLLVM | JS 控制流平坦化 / OB 三件套 |
| 20 | VMP | JSVMP 原理 |
| 21 | unidbg | node + jsdom 跑算法 / iv8-web-reverse |
| 22 | 算法还原 (1) | 找 sign 入口 / 抠字面量 |
| 23 | 算法还原 (2) | 还原 HMAC/SM3 / 抠算法 |
| 24 | FART 进阶 | 高级 dump 技巧 |
| 25 | eBPF | Chrome DevTools trace / V8 --trace |
| 26 | FART 10 | 主动调用批量 |
| 27 | 反检测对抗 | 反 webdriver / 指纹对抗 |
| 28 | iOS 逆向 | 小程序逆向 / H5 逆向 |
| 29 | 云端对抗 | 云函数 / serverless 反爬 |
| 30 | 模拟器 | 浏览器自动化伪装 |
| 31 | 容器化 | Docker / WSL2 跑算法 |
| 32 | 容器化整合 | 完整工具链 |

---

## 写法模板 (所有 agent 复制粘贴这个)

### 模板 A: 在 `intuition` 里加 (建立坐标系)

```js
intuition: {
  tag: '直觉模型 · XXX',  // 保留原 tag
  body: '...原内容...' +
        T.note('key', '🌐 Web/JS 逆向视角',
          '<p><span class="pill">JS 视角</span> 把这个概念类比到 JS 逆向世界,就是 XXX。<br>' +
          '<b>对应物</b>: ...<br>' +
          '<b>关键差异</b>: ...<br>' +
          '<b>读到这里你应该想起</b>: ...</p>')
}
```

### 模板 B: 在 `html` 段落里加 (随文批注)

```js
html:
  '...原内容...' +
  T.note('cool', '🌐 JS 视角批注',
    '<p><span class="pill">JS 类比</span> 一句话概括:<b>xxx ≈ xxx</b>。<br>' +
    '具体差异:...<br>' +
    'Web 逆向里常见的位置:... (1-2 句)</p>') +
  '...继续原内容...'
```

### 模板 C: 在 `glossary` (章末词汇表) 里加 (词汇映射)

> **⚠️ 修正（2026-10-13 实测）：不要往 `term` 块里加对位行。**
> `term.lines[].t` 会被当成 CSS class 名，校验器只允许 `p / o / e / w / d` 六个值，
> 写 `t:'↔ Web 对位'` 会直接报错。
> **正确做法：词汇映射加到章末的 `glossary` 数组**——它的格式是 `{ t, d }`，`t` 不受限，
> 语义也更对（术语表本来就是放"术语 ↔ 释义"的地方）。

```js
glossary: [
  { t: 'dex', d: '……原有词条……' },
  { t: '↔ Web 对位 · classes.dex = 打包后的 main.js', d: 'JS/浏览器里的对位概念 + 关键差异（照第 1–9 节的措辞）' }
]
```

如果一章确实想在内文里给某个概念做悬停释义，用 `T.term(word, def)`（正文行内），
它生成的是 `<span class="term">`，不受 `term` 块的 `t` 白名单限制。

### 模板 D: 在 `decision` 节点加 (真实情境里的类比)

```js
decision: {
  nodes: {
    n0: {
      scenario: '你看到某安卓 App 反编译后是 [某特征]',
      q: '...',
      choices: [
        { t: '走 Web 逆向思路: ...', next: 'n1' },  // 标出 web 思路
        ...
      ]
    }
  }
}
```

### 模板 E: 在 `teacher` (严师追问) 加 1 道"映射"题

```js
teacher.questions.push({
  id: 'cXXqN', depth: 2, threshold: 0.7,
  q: '用 Web/JS 逆向里你熟悉的概念,解释 [本章安卓概念]。说出至少两个对位物和它们的差异。',
  concepts: [
    { label: '说出至少一个对位概念', hint: '想想 [提示]', any: ['关键词1', '关键词2', '中文子串'] },
    { label: '说出关键差异', hint: '...', any: ['差异1', '差异2'] }
  ],
  hints: ['想想 [概念] 在 JS 里是什么', '安卓的 X 对应 JS 的 Y'],
  probes: ['安卓和 JS 的 [方面] 各有什么不同?'],
  model: '<b>参考答案</b>: ...'
});
```

---

## 重要纪律

1. **不要删除原有内容** —— 只增加,不删减。`validate-chapters.mjs` 强制小节数 ≥ 12。
2. **不修改 `assets/` 下任何文件** —— 基础设施不能动。
3. **不修改现有 `chapters/ch01.js`–`ch25.js` 的核心结构** —— 但可以**追加内容**(在 html 末尾追加、intuition 块里追加)。注意:验证器会跑你新加的 `lab.run` / `stage.reset`,所以**不要加新的 `lab/stage` 字段**,只改 `intuition` / `html` / `term` / `decision.options` / `teacher.questions`。
4. **类比要真实** —— 不要说"差不多"或"等价",要说明**关键差异**。比如 Binder vs postMessage 表面像但前者是同步 RPC 后者是异步 message。
5. **Web 视角用 `<span class="pill">JS 视角</span>` 标头** —— 风格统一,方便以后批量替换。
6. **每章至少 3 处类比** (intuition / html / glossary 各一处),多的不限。
   (注意:词汇映射放 `glossary`,不要放 `term` 块——原因见模板 C。)
7. **teacher.questions 可以追加** —— 不破坏原有 questions 数组,只 push 新的。
8. **不要新增 `case` 字段** —— 案例链接必须可验证,不能编造。
9. **每个 agent 完成后用 `node validate-chapters.mjs <章号>` 自检** —— 0 错 0 警。
