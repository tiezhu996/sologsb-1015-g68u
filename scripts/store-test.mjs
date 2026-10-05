/* Store 逻辑测试：编辑会话 / 已确认版本 / 行指纹遮蔽 / 导出 / 异文门控。
 * node scripts/store-test.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

// --- 用 esbuild plugin 把 @angular/core 替换为最小桩 ---
// 用 esbuild plugin 替换 @angular/core
const angularCorePlugin = {
  name: 'angular-core-stub',
  setup(b) {
    const signals = new Map();
    b.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: '@angular/core', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        export function inject(token) {
          const name = token && (token.__name || token.name);
          const p = globalThis.__NG_PROVIDERS__ && globalThis.__NG_PROVIDERS__.get(name);
          if (!p) throw new Error('no provider: ' + name);
          return p;
        }
        const COMPUTEDS = new Set();
        export function signal(initial) {
          let value = initial;
          const fn = () => value;
          fn.set = (v) => { value = typeof v === 'function' ? v(value) : v; COMPUTEDS.forEach((c) => c.dirty = true); };
          fn.update = (u) => fn.set(u(value));
          fn.asReadonly = () => fn;
          return fn;
        }
        export function computed(producer) {
          const c = { dirty: true, value: undefined };
          COMPUTEDS.add(c);
          const fn = () => { if (c.dirty) { c.value = producer(); c.dirty = false; } return c.value; };
          return fn;
        }
        export function Injectable() { return (t) => t; }
        export class NgZone { runOutsideAngular(fn) { return fn(); } }
        export class DestroyRef { onDestroy() {} }
      `,
      loader: 'js',
    }));
  },
};

async function load() {
  const entryDir = mkdtempSync(join(tmpdir(), 'entry-'));
  const entry = join(entryDir, 'entry.ts');
  writeFileSync(
    entry,
    `export { PoetryStoreService, METER_TEMPLATES } from ${JSON.stringify(join(process.cwd(), 'src/app/services/poetry-store.service.ts'))};
     export { AnalysisEngineService } from ${JSON.stringify(join(process.cwd(), 'src/app/services/analysis-engine.service.ts'))};`,
  );
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    tsconfig: 'tsconfig.app.json',
    plugins: [angularCorePlugin],
  });
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'store.mjs');
  writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

// 缩短防抖，直接驱动引擎
const { PoetryStoreService, AnalysisEngineService } = await load();
// NgZone / DestroyRef 的类定义在桩模块内部，store 注入只按构造名取用。

function createStore() {
  localStorage.clear();
  // 预置一个最小工作区（与应用初始数据结构一致）
  const ws = {
    title: '测试',
    author: '佚名',
    templateId: 'wuyan-zeqi',
    updatedAt: new Date().toISOString(),
    activeVersionId: 'a',
    versions: [
      { id: 'a', name: '甲本', source: '源A', createdAt: '', text: '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少', marks: {}, antithesisPairs: [] },
      { id: 'b', name: '乙本', source: '源B', createdAt: '', text: '春眠不觉晓\n处处闻啼鸣\n夜来风雨声\n花落知多少', marks: {}, antithesisPairs: [] },
    ],
  };
  localStorage.setItem('sologsb-1015-poetry-workspace-v1', JSON.stringify(ws));
  const engine = new AnalysisEngineService();
  globalThis.__NG_PROVIDERS__ = new Map([
    ['AnalysisEngineService', engine],
    ['NgZone', { runOutsideAngular: (fn) => fn() }],
    ['DestroyRef', { onDestroy: () => {} }],
  ]);
  return new PoetryStoreService();
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

// 初次进入：分析未确认前，所有行都是“待分析”，没有旧结论
await test('分析确认前字格全部待分析，issues 不给格律结论', async () => {
  const store = createStore();
  const view = store.viewLines();
  assert.equal(view.length, 4);
  assert.ok(view.every((l) => !l.confirmed));
  assert.ok(view.every((l) => l.source.cells.every((c) => c.status === 'pending')));
  assert.ok(store.issues().some((i) => i.title === '待分析'));
  assert.equal(store.issues().filter((i) => i.level === 'error').length, 0);
});

await test('批次全部确认后，字格与问题清单只显示同一已确认版本', async () => {
  const store = createStore();
  await sleep(700);
  const view = store.viewLines();
  assert.ok(view.every((l) => l.confirmed));
  // analysis() 与 viewLines 同源
  assert.equal(store.analysis().length, 4);
  assert.ok(store.issues().length > 0);
});

await test('编辑一行后该行立即变待分析，其余行不冒充新结论', async () => {
  const store = createStore();
  await sleep(700);
  assert.ok(store.viewLines().every((l) => l.confirmed));
  store.updateText('春眠不觉晓\n处处闻啼XX\n夜来风雨声\n花落知多少');
  // 编辑使在途作废：第 2 句指纹不匹配 → 待分析
  const view = store.viewLines();
  assert.equal(view[1].confirmed, false);
  assert.equal(view[0].confirmed, true);
  assert.equal(view[1].source.cells[0].status, 'pending');
  // 未确认前 analysis() 不含该句
  assert.equal(store.analysis().find((l) => l.index === 1), undefined);
  await sleep(700);
  assert.ok(store.viewLines().every((l) => l.confirmed));
});

await test('导出校对稿：未算完写待分析，已算完段标已算完', async () => {
  const store = createStore();
  await sleep(700);
  store.updateText('春眠不觉晓\n处处闻啼XX\n夜来风雨声\n花落知多少');
  const md = store.exportProofreadCopy();
  assert.match(md, /第 2 句：待分析/);
  assert.match(md, /第 1 句〔已算完〕/);
  assert.match(md, /覆盖范围：3 \/ 4 句已算完/);
});

await test('异文对照：任一版本未确认则不显示；两侧确认后才按行比较', async () => {
  const store = createStore();
  store.selectVersion('b');
  await sleep(700);
  store.selectVersion('a');
  await sleep(700);
  store.baselineVersionId.set('b');
  assert.equal(store.diffReady(), true);
  const rows = store.diffLines();
  assert.equal(rows.length, 4);
  assert.equal(rows[1].changed, true);
  assert.equal(rows[0].changed, false);

  // 编辑当前版本 → 立即失去对照资格，绝不显示旧 diff
  store.updateText('春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多X');
  assert.equal(store.diffReady(), false);
  assert.equal(store.diffLines().length, 0);
});

await test('连续输入合并撤销点，且输入期间不阻塞（同步可连续提交）', () => {
  const store = createStore();
  // 等待初始分析防抖结束，避免定时器干扰计数
  const before = store.undoCount();
  store.updateText('A');
  store.updateText('AB');
  store.updateText('ABC');
  assert.equal(store.undoCount() - before, 1);
  store.undo();
  assert.equal(store.activeVersion().text, '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少');
});

console.log(`\n${passed} 个 Store 测试全部通过`);
