// test/smoke.mjs —— 不需要 DSH 运行时。验证：能被 import、导出结构正确、15 个工具名齐全、必需文件存在。
// 跑法：node test/smoke.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const mod = await import(pathToFileURL(join(root, 'index.js')).href);
check('模块可 import', true);
check('导出 name 是字符串', typeof mod.name === 'string', mod.name);
check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'));
check('导出 apply 是函数', typeof mod.apply === 'function');

const src = readFileSync(join(root, 'index.js'), 'utf8');
const EXPECT = ['web_launch','web_status','web_tabs','web_navigate','web_snapshot','web_act',
                'web_key','web_scroll','web_shot','web_eval','web_wait',
                'web_upload','web_click','web_drag'];
const missing = EXPECT.filter(n => !src.includes(`'${n}'`) && !src.includes(`"${n}"`));
check('14 个 web_* 工具名齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(', ') : '14/14');

for (const f of ['package.json','README.md','LICENSE','icon.svg','cordis.patch.yml','locale/en.json','locale/zh.json']) {
  let ok = true;
  try { readFileSync(join(root, f)); } catch { ok = false; }
  check(`文件存在：${f}`, ok);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
check('package.json 有 license', pkg.license === 'MIT', pkg.license || '(无)');
check('package.json 有 repository', !!pkg.repository, pkg.repository ? (pkg.repository.url || String(pkg.repository)) : '(无)');

console.log('');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
