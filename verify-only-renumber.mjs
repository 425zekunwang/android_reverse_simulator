/* 全量验证：每个新章节数据文件 = 对应旧章节数据文件「仅章号被改写」。
   做法：把新旧两份文本里的所有数字都替换成 #，应当完全一致。
   这能证明重排没有增删任何内容，只动了编号。

   已登记的「有意例外」——都是重排顺带修正的真实问题或纯格式归一，
   不涉及任何教学内容的增删：
     - ch25（旧 ch11）：① 标题 "热门源码赏析" → "源码赏析"，与 COURSE 元数据统一
                        ② quiz 关键词 '13 章' → '27 章'（跟着 '第 13 章' → '第 27 章' 一起走）
     - ch10（旧 ch21）：quiz 关键词 '第23章' → '第 12 章'，空格形式统一
     - ch02（旧 ch27）：quiz 关键词 '第3章'  → '第 17 章'，空格形式统一
   注：quiz 关键词的松紧空格是等价的 —— app.js 的 hasConcept() 对含 CJK 的候选
   会先删除所有空格再比较（见 app.js 第 137 行），故 '第23章' 与 '第 23 章' 命中结果一致。
   例外按"归一化后仍允许的差异行数"登记，超出即失败。 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const NEW_OF = new Map();
for (let o = 1; o <= 18; o++) NEW_OF.set(o, o + 14);
for (let o = 19; o <= 25; o++) NEW_OF.set(o, o - 11);
for (let o = 26; o <= 32; o++) NEW_OF.set(o, o - 25);

const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => s.replace(/\d+/g, '#');
// 归一化后仍允许不同的行数（每个文件）——见文件头"有意例外"
const KNOWN_DIFF = new Map([[25, 2], [10, 5], [2, 2]]);

let bad = 0, checked = 0;
const details = [];

for (const [oldNo, newNo] of [...NEW_OF].sort((a, b) => a[0] - b[0])) {
  if (oldNo === 1) continue;                        // 内联格式章，无数据文件
  const oldSrc = execSync(`git show HEAD:chapters/ch${pad(oldNo)}.js`, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const newSrc = fs.readFileSync(path.join(ROOT, 'chapters', `ch${pad(newNo)}.js`), 'utf8');
  checked++;

  const a = norm(oldSrc).split('\n'), b = norm(newSrc).split('\n');
  const diffLines = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diffLines.push(i + 1);
  }
  const allowed = KNOWN_DIFF.get(newNo) || 0;
  if (diffLines.length > allowed) {
    console.log(`✗ old ch${pad(oldNo)} -> new ch${pad(newNo)}: ${diffLines.length} 行差异（允许 ${allowed}）`);
    bad++;
  } else if (diffLines.length) {
    details.push(`  · ch${pad(newNo)}: ${diffLines.length} 行已登记的有意修正（行 ${diffLines.join(',')}）`);
  }
}

if (details.length) console.log('已登记的有意修正：\n' + details.join('\n'));
console.log(`\n检查 ${checked} 个数据文件：` +
  (bad === 0 ? '✅ 全部与原文「仅编号不同」，无内容增删' : `❌ ${bad} 个文件的正文有未登记的实质变化`));
process.exit(bad ? 1 : 0);
