import { TestBed } from '@angular/core/testing';
import { AnalysisService } from './analysis.service';
import { cellKey, computeFingerprint, defaultMark } from './analysis.util';
import type { CharacterMark, PoemWorkspace } from '../models/poem.models';

const ANALYSIS_KEY = 'sologsb-1015-analysis-v2';
const WORKSPACE_KEY = 'sologsb-1015-poetry-workspace-v1';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  expect(predicate()).toBeTrue();
}

function doneCount(service: AnalysisService): number {
  return (service.runState()?.confirmedCounts ?? []).reduce((sum, value) => sum + value, 0);
}

function makeVersion(id: string, lineCount: number): PoemWorkspace['versions'][number] {
  const text = Array.from({ length: lineCount }, (_, index) => `第${index}句五言啊`).join('\n');
  const marks: Record<string, CharacterMark> = {};
  for (let line = 0; line < lineCount; line += 1) {
    marks[cellKey(line, 4)] = { ...defaultMark(), tone: '平', rhyme: 'A' };
  }
  return { id, name: `版本${id}`, source: '测试底本', createdAt: '', text, marks, antithesisPairs: [] };
}

function makeWorkspace(versions: PoemWorkspace['versions']): PoemWorkspace {
  return { title: '排律测试', author: '佚名', templateId: 'wuyan-zeqi', versions, activeVersionId: versions[0].id, updatedAt: '' };
}

describe('AnalysisService', () => {
  beforeEach(() => {
    localStorage.removeItem(ANALYSIS_KEY);
    localStorage.removeItem(WORKSPACE_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [AnalysisService] });
  });

  it('正文变化后排队，批次跑完发布同一整版结果', async () => {
    const service = TestBed.inject(AnalysisService);
    const workspace = makeWorkspace([makeVersion('v1', 4), makeVersion('v2', 4)]);

    service.contentChanged(workspace);
    expect(service.runState()?.phase).toBe('queued');
    expect(service.published()).toBeNull();

    await waitFor(() => service.runState()?.phase === 'complete');

    const state = service.runState();
    expect(state?.phase).toBe('complete');
    expect(service.published()?.fingerprint).toBe(computeFingerprint(workspace));
    expect(service.checkpoint()).toBeNull();
    expect(service.published()?.results[0]).toHaveSize(4);
  });

  it('编辑中的批次立即作废：检查点丢弃，按新指纹重排', async () => {
    const service = TestBed.inject(AnalysisService);
    const workspace = makeWorkspace([makeVersion('v1', 1000), makeVersion('v2', 1000)]);

    service.contentChanged(workspace);
    // 轮询到“首批已提交但全文未完成”的瞬间，模拟正在输入
    await waitFor(() => service.runState()?.phase === 'running' && doneCount(service) > 0);
    expect(service.checkpoint()).not.toBeNull();

    const edited = structuredClone(workspace);
    edited.versions[0].text = `新写的首句内容\n${edited.versions[0].text.split('\n').slice(1).join('\n')}`;
    service.contentChanged(edited);

    // 作废即时生效：旧检查点不再用于恢复，状态回到排队
    expect(service.checkpoint()).toBeNull();
    expect(service.runState()?.phase).toBe('queued');

    await waitFor(() => service.runState()?.phase === 'complete', 15000);
    expect(service.published()?.fingerprint).toBe(computeFingerprint(edited));
    expect(service.published()?.snapshots[0].text.startsWith('新写的首句内容')).toBeTrue();
  });

  it('批次失败后保留上一整版结果与断点，从检查点继续到完成', async () => {
    const service = TestBed.inject(AnalysisService);
    const first = makeWorkspace([makeVersion('v1', 120)]);
    service.contentChanged(first);
    await waitFor(() => service.runState()?.phase === 'complete');
    const firstFingerprint = service.published()!.fingerprint;

    const second = structuredClone(first);
    second.versions[0].text = `改动后的首句啊\n${second.versions[0].text.split('\n').slice(1).join('\n')}`;
    service.failNextBatch = true;
    service.contentChanged(second);
    await waitFor(() => service.runState()?.phase === 'failed');

    expect(service.runState()?.phase).toBe('failed');
    expect(service.published()?.fingerprint).toBe(firstFingerprint); // 回退到上一版完整结果
    expect(service.checkpoint()?.fingerprint).toBe(computeFingerprint(second)); // 断点保留
    expect(service.runState()?.confirmedCounts[0]).toBeGreaterThan(0);

    service.resume();
    await waitFor(() => service.runState()?.phase === 'complete');
    expect(service.published()?.fingerprint).toBe(computeFingerprint(second));
  });

  it('重开页面后从检查点自动继续', async () => {
    const firstService = TestBed.inject(AnalysisService);
    const workspace = makeWorkspace([makeVersion('v1', 120)]);
    firstService.failNextBatch = true;
    firstService.contentChanged(workspace);
    await waitFor(() => firstService.runState()?.phase === 'failed');
    expect(localStorage.getItem(ANALYSIS_KEY)).withContext('断点已写入本地').not.toBeNull();

    // 模拟页面关闭：销毁旧实例，挂起任务全部失效
    TestBed.resetTestingModule();
    await delay(50);

    TestBed.configureTestingModule({ providers: [AnalysisService] });
    const reopened = TestBed.inject(AnalysisService);
    expect(reopened.checkpoint()?.resumed).toBeTrue();
    expect(reopened.runState()?.phase).toBe('running');
    await waitFor(() => reopened.runState()?.phase === 'complete');
    expect(reopened.published()?.fingerprint).toBe(computeFingerprint(workspace));
  });
});
