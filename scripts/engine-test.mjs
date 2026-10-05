/* Node 直跑的引擎逻辑测试（环境无 arm64 Chrome，Karma spec 保留给 CI）：
 * node scripts/engine-test.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMPLATE = {
  id: 't',
  name: '测试模板',
  summary: '四句五字',
  lineCount: 4,
  lineLength: 5,
  pattern: ['仄','仄','中','平','仄','中','平','中','仄','仄','中','平','中','仄','中','平','中','仄','中','平'],
  rhymeLines: [1, 3],
};

function makeVersion(text) {
  return { id: 'v1', name: '测试本', source: '测试', createdAt: new Date().toISOString(), text, marks: {}, antithesisPairs: [] };
}

async function loadEngine() {
  const result = await build({
    entryPoints: ['src/app/services/analysis-engine.service.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    tsconfig: 'tsconfig.app.json',
  });
  const dir = mkdtempSync(join(tmpdir(), 'engine-'));
  const file = join(dir, 'engine.mjs');
  writeFileSync(file, result.outputFiles[0].text);
  return (await import(file)).AnalysisEngineService;
}

// @angular/core 的 signal/injectable 最小桩
globalThis.ngStubs = undefined;

function makeEngine(Engine, version, storageKey) {
  const confirmed = [];
  const engine = new Engine();
  engine.configurator.linesPerBatch = 2;
  engine.connect({
    storageKey,
    work: (id) => (id === version.id ? { version, template: TEMPLATE } : null),
    onConfirmed: (id, snapshot) => confirmed.push([id, snapshot]),
    tick: () => {},
  });
  return { engine, confirmed: () => confirmed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function test(name, fn) {
  localStorage.clear();
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

// localStorage 桩
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const Engine = await loadEngine();

await test('超长内容按批次排队，全部成功后才确认一个完整版本', async () => {
  const version = makeVersion('春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少');
  const { engine, confirmed } = makeEngine(Engine, version, 'cp-1');
  engine.request(version.id);
  assert.ok(['queued', 'running'].includes(engine.runState(version.id).phase));
  assert.equal(confirmed().length, 0);
  await sleep(150);
  assert.equal(engine.runState(version.id).phase, 'completed');
  assert.equal(engine.runState(version.id).doneLineCount, 4);
  assert.equal(confirmed().length, 1);
  assert.equal(confirmed()[0][1].lines.length, 4);
});

await test('编辑使在途批次立即作废，不产生确认结果', async () => {
  const version = makeVersion('春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少');
  const { engine, confirmed } = makeEngine(Engine, version, 'cp-2');
  engine.configurator.yieldMs = 60;
  engine.request(version.id);
  await sleep(5);
  engine.invalidate(version.id);
  await sleep(220);
  assert.equal(confirmed().length, 0);
  assert.equal(engine.runState(version.id).phase, 'idle');
});

await test('批次失败保留上一版完整结果，重开从检查点继续', async () => {
  const text = '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少';
  const version = makeVersion(text);
  const first = makeEngine(Engine, version, 'cp-3');
  first.engine.request(version.id);
  await sleep(150);
  assert.equal(first.engine.runState(version.id).phase, 'completed');
  const prevRevision = first.engine.snapshot(version.id).revision;
  assert.equal(first.engine.snapshot(version.id).lines.length, 4);

  first.engine.configurator.failAt = 2;
  version.text = `${text}\n新增一句呀`;
  first.engine.request(version.id);
  await sleep(220);
  assert.equal(first.engine.runState(version.id).phase, 'failed');
  assert.equal(first.engine.snapshot(version.id).revision, prevRevision);
  assert.equal(first.engine.snapshot(version.id).lines.length, 4);
  const cp = first.engine.checkpoint(version.id);
  assert.equal(cp.phase, 'failed');
  assert.equal(cp.doneLineCount, 2);
  assert.equal(cp.batches.length, 1);

  const reopened = makeEngine(Engine, version, 'cp-3');
  assert.equal(reopened.engine.checkpoint(version.id).phase, 'failed');
  reopened.engine.configurator.failAt = undefined;
  reopened.engine.resume(version.id);
  await sleep(220);
  assert.equal(reopened.engine.runState(version.id).phase, 'completed');
  assert.equal(reopened.engine.snapshot(version.id).lines.length, 5);
  assert.equal(reopened.confirmed()[0][1].lines.length, 5);
});

await test('内容未变时复用已确认版本，不重复排队', async () => {
  const version = makeVersion('春眠不觉晓\n处处闻啼鸟');
  const { engine, confirmed } = makeEngine(Engine, version, 'cp-4');
  engine.request(version.id);
  await sleep(100);
  engine.request(version.id);
  await sleep(30);
  assert.equal(confirmed().length, 1);
  assert.equal(engine.runState(version.id).phase, 'completed');
});

await test('排队期间内容再变，旧作业指纹不符直接丢弃', async () => {
  const version = makeVersion('春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少');
  const { engine, confirmed } = makeEngine(Engine, version, 'cp-5');
  engine.request(version.id);
  engine.invalidate(version.id);
  version.text = '全新的文本呀\n第二句内容\n第三句也在\n第四句收尾';
  engine.request(version.id);
  await sleep(200);
  assert.equal(engine.runState(version.id).phase, 'completed');
  assert.equal(confirmed()[0][1].lines[0].cells.map((c) => c.char).join(''), '全新的文本呀');
});

console.log(`\n${passed} 个引擎测试全部通过`);
