import { TestBed } from '@angular/core/testing';
import { AnalysisEngineService } from './analysis-engine.service';
import type { AnalysisSnapshot, MeterTemplate, PoemVersion } from '../models/poem.models';

const TEMPLATE: MeterTemplate = {
  id: 't',
  name: '测试模板',
  summary: '四句五字',
  lineCount: 4,
  lineLength: 5,
  pattern: ['仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '中', '平'],
  rhymeLines: [1, 3],
};

function makeVersion(text: string): PoemVersion {
  return {
    id: 'v1',
    name: '测试本',
    source: '测试',
    createdAt: new Date().toISOString(),
    text,
    marks: {},
    antithesisPairs: [],
  };
}

function makeEngine(version: PoemVersion, storageKey: string) {
  const confirmed: Array<[string, AnalysisSnapshot]> = [];
  const engine = TestBed.runInInjectionContext(() => new AnalysisEngineService());
  engine.configurator.linesPerBatch = 2;
  engine.connect({
    storageKey,
    work: (id) => (id === version.id ? { version, template: TEMPLATE } : null),
    onConfirmed: (id, snapshot) => confirmed.push([id, snapshot]),
    tick: () => {},
  });
  return { engine, confirmed: () => confirmed };
}

describe('AnalysisEngineService', () => {
  beforeEach(() => localStorage.clear());

  it('超长内容按批次排队，全部成功后才确认一个完整版本', async () => {
    const version = makeVersion('春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少');
    const { engine, confirmed } = makeEngine(version, 'cp-1');

    engine.request(version.id);
    expect(engine.runState(version.id).phase === 'queued' || engine.runState(version.id).phase === 'running').toBeTrue();
    expect(confirmed().length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const state = engine.runState(version.id);
    expect(state.phase).toBe('completed');
    expect(state.doneLineCount).toBe(4);
    expect(confirmed().length).toBe(1);
    expect(confirmed()[0][1].lines.length).toBe(4);
  });

  it('编辑使在途批次立即作废，不产生确认结果，输入侧不被阻塞', async () => {
    const version = makeVersion('春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少');
    const { engine, confirmed } = makeEngine(version, 'cp-2');

    engine.configurator.yieldMs = 60;
    engine.request(version.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.invalidate(version.id); // 编辑中：立即作废
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(confirmed().length).toBe(0);
    expect(engine.runState(version.id).phase).toBe('idle');
  });

  it('批次失败保留上一版完整结果，检查点保存，重开可从断点继续', async () => {
    const text = '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少';
    const version = makeVersion(text);
    const first = makeEngine(version, 'cp-3');
    first.engine.request(version.id);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(first.engine.runState(version.id).phase).toBe('completed');
    const previous = first.engine.snapshot(version.id)!;
    expect(previous.lines.length).toBe(4);

    // 新一轮分析：第二批次失败。
    first.engine.configurator.failAt = 2;
    version.text = `${text}\n新增一句呀`;
    first.engine.request(version.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.engine.runState(version.id).phase).toBe('failed');
    // 上一版完整结果仍在（未被失败的批次覆盖）
    expect(first.engine.snapshot(version.id)?.revision).toBe(previous.revision);
    expect(first.engine.snapshot(version.id)?.lines.length).toBe(4);
    const checkpoint = first.engine.checkpoint(version.id)!;
    expect(checkpoint.phase).toBe('failed');
    expect(checkpoint.doneLineCount).toBe(2);
    expect(checkpoint.batches.length).toBe(1);

    // 重开：新引擎从 localStorage 恢复检查点，从断点续跑成功。
    const reopened = makeEngine(version, 'cp-3');
    expect(reopened.engine.checkpoint(version.id)?.phase).toBe('failed');
    reopened.engine.configurator.failAt = undefined;
    reopened.engine.resume(version.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reopened.engine.runState(version.id).phase).toBe('completed');
    expect(reopened.engine.snapshot(version.id)!.lines.length).toBe(5);
    expect(reopened.confirmed()[0][1].lines.length).toBe(5);
  });

  it('内容未变时复用已确认版本，不重复排队计算', async () => {
    const version = makeVersion('春眠不觉晓\n处处闻啼鸟');
    const { engine, confirmed } = makeEngine(version, 'cp-4');
    engine.request(version.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    engine.request(version.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(confirmed().length).toBe(1);
    expect(engine.runState(version.id).phase).toBe('completed');
  });
});
