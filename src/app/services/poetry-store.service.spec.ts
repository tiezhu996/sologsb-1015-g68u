import { TestBed } from '@angular/core/testing';
import { AnalysisService } from './analysis.service';
import { PoetryStoreService } from './poetry-store.service';
import { cellKey } from './analysis.util';

const WORKSPACE_KEY = 'sologsb-1015-poetry-workspace-v1';
const ANALYSIS_KEY = 'sologsb-1015-analysis-v2';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  expect(predicate()).toBeTrue();
}

describe('PoetryStoreService 编辑会话与后台批次分离', () => {
  beforeEach(() => {
    localStorage.removeItem(ANALYSIS_KEY);
    localStorage.removeItem(WORKSPACE_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [AnalysisService, PoetryStoreService] });
  });

  function createStore(seed?: string): PoetryStoreService {
    if (seed) localStorage.setItem(WORKSPACE_KEY, JSON.stringify(seedWorkspace(seed)));
    return TestBed.inject(PoetryStoreService);
  }

  function seedWorkspace(text: string) {
    return {
      title: '长排律',
      author: '佚名',
      templateId: 'wuyan-zeqi',
      activeVersionId: 'v1',
      updatedAt: '',
      versions: [
        { id: 'v1', name: '工作本', source: '底本', createdAt: '', text, marks: {}, antithesisPairs: [] },
      ],
    };
  }

  it('确认前字格全部是待分析，且输入/批注立即可用', async () => {
    const store = createStore(Array.from({ length: 200 }, (_, i) => `第${i}句测试五言`).join('\n'));
    expect(store.lineViews().every((view) => view.status === 'pending')).toBeTrue();

    // 批注与输入立即写入编辑会话，不等后台批次
    store.selectCell(10, 2);
    store.setMark({ tone: '仄', note: '输入不卡顿' });
    expect(store.activeVersion().marks[cellKey(10, 2)]?.note).toBe('输入不卡顿');
    expect(store.selectedCellView()?.mark.tone).toBe('仄');
  });

  it('整版确认后字格显示 confirmed，异文页只读同一确认版本', async () => {
    const text = Array.from({ length: 10 }, (_, i) => `甲${i}句测试五言`).join('\n');
    const store = createStore(text);
    // 建立一个异文版本（新的工作稿），此时最新批次同时包含两个版本
    store.snapshot();
    store.updateText(Array.from({ length: 10 }, (_, i) => `乙${i}句测试五言`).join('\n'));
    // 当前版本是新稿（乙），底本选被保留的旧版本（甲，位于 versions[1]）
    const baselineId = store.workspace().versions[1].id;
    store.duplicateActiveAsBaseline(); // 先置为当前
    store.baselineVersionId.set(baselineId);

    await waitFor(() => store.runState()?.phase === 'complete');
    expect(store.analysisStale()).toBeFalse();
    expect(store.lineViews().every((view) => view.status === 'confirmed')).toBeTrue();
    const rows = store.diffRows();
    expect(rows).not.toBeNull();
    expect(store.differences().length).toBeGreaterThan(0);
    // 切换查看版本不产生新批次
    const newId = store.workspace().versions[0].id;
    store.selectVersion(baselineId);
    expect(store.runState()?.phase).toBe('complete'); // 无新批次
    expect(store.diffComparable()).toBeFalse(); // 底本与当前为同一版本时不可对照
    store.selectVersion(newId);
    expect(store.diffComparable()).toBeTrue(); // 切回后仍读同一确认版本
  });

  it('编辑后旧结果标 stale，未完成段落写待分析，不能冒充', async () => {
    const store = createStore(Array.from({ length: 60 }, (_, i) => `旧${i}句测试五言`).join('\n'));
    await waitFor(() => store.runState()?.phase === 'complete');

    store.updateText(Array.from({ length: 80 }, (_, i) => `新${i}句测试五言`).join('\n'));
    // 旧指纹的结果全部标旧，新增段落待分析
    expect(store.lineViews()[0].status).toBe('stale');
    expect(store.lineViews()[70].status).toBe('pending');
    expect(store.confirmedIssues()).toBeNull(); // 检查记录不展示旧版结论

    const copy = store.exportProofreadCopy();
    expect(copy).toContain('旧版结论，待重新分析');
    expect(copy).toContain('待分析');
  });

  it('失败后校对稿只写检查点中已算完段落', async () => {
    const runner = TestBed.inject(AnalysisService);
    runner.failNextBatch = true;
    const store = TestBed.inject(PoetryStoreService);
    store.updateText(Array.from({ length: 120 }, (_, i) => `长${i}句测试五言`).join('\n'));
    await waitFor(() => store.runState()?.phase === 'failed');

    const copy = store.exportProofreadCopy();
    expect(copy).toContain('待分析');
    const doneLines = runner.checkpoint()?.results[0].filter(Boolean).length ?? 0;
    expect(doneLines).toBeGreaterThan(0);
    expect(copy).toContain(`已确认 ${doneLines}/120 句`);

    store.resumeAnalysis();
    await waitFor(() => store.runState()?.phase === 'complete');
  });

  it('切换版本只是查看切换，不触发重算（指纹不变）', async () => {
    const store = createStore('甲句测试五言\n乙句测试五言');
    store.snapshot();
    await waitFor(() => store.runState()?.phase === 'complete');
    const revision = store.runState()?.revision;

    const previous = store.workspace().versions[1];
    store.selectVersion(previous.id);
    await delay(450);
    // 版本切换不改动工作区内容，不产生新批次
    expect(store.runState()?.phase).toBe('complete');
    expect(store.runState()?.revision).toBe(revision);
  });
});
