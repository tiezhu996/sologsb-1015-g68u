import { computed, DestroyRef, inject, Injectable, NgZone, signal } from '@angular/core';
import type {
  AnalysisLine,
  AnalysisRunState,
  AnalysisSnapshot,
  AntithesisPair,
  CharacterMark,
  DiffCell,
  DiffLine,
  MarkTone,
  MeterTemplate,
  PoemIssue,
  PoemVersion,
  PoemWorkspace,
  Tone,
} from '../models/poem.models';
import { AnalysisEngineService } from './analysis-engine.service';

export const METER_TEMPLATES: MeterTemplate[] = [
  {
    id: 'wuyan-zeqi',
    name: '五言绝句 · 仄起首句不入韵',
    summary: '四句，每句五字；二、四句押韵',
    lineCount: 4,
    lineLength: 5,
    pattern: ['仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
  {
    id: 'wuyan-pingqi',
    name: '五言绝句 · 平起首句入韵',
    summary: '四句，每句五字；一、二、四句押韵',
    lineCount: 4,
    lineLength: 5,
    pattern: ['中', '平', '中', '仄', '平', '仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '仄', '中', '平'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-zeqi',
    name: '七言绝句 · 仄起首句入韵',
    summary: '四句，每句七字；一、二、四句押韵',
    lineCount: 4,
    lineLength: 7,
    pattern: ['仄', '仄', '中', '平', '中', '仄', '平', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-pingqi',
    name: '七言绝句 · 平起首句不入韵',
    summary: '四句，每句七字；二、四句押韵',
    lineCount: 4,
    lineLength: 7,
    pattern: ['中', '平', '中', '仄', '仄', '中', '平', '仄', '仄', '中', '平', '平', '仄', '仄', '中', '平', '中', '仄', '中', '平', '仄', '仄', '中', '平', '中', '仄', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
];

const STORAGE_KEY = 'sologsb-1015-poetry-workspace-v1';
const CHECKPOINT_KEY = 'sologsb-1015-analysis-checkpoints-v1';
const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t']);

/** 正文变更后排队前的静默窗口，保证逐字输入不被分析打断。 */
const ANALYZE_DEBOUNCE_MS = 500;
/** 本地落库做节流，避免每次击键都全量 JSON.stringify。 */
const PERSIST_DEBOUNCE_MS = 400;
/** 连续文本输入合并为一次撤销记录的窗口。 */
const TEXT_UNDO_COALESCE_MS = 900;

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function keyOf(line: number, position: number): string {
  return `${line}:${position}`;
}

function defaultMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
}

function initialWorkspace(): PoemWorkspace {
  const now = new Date().toISOString();
  const spring = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';
  const marks: Record<string, CharacterMark> = {};
  const cells = [
    ['晓', 0, '平', false], ['鸟', 1, '平', false], ['声', 2, '平', false], ['少', 3, '平', false],
  ] as const;
  cells.forEach(([char, line, tone, pause]) => {
    marks[keyOf(line, 4)] = { tone, rhyme: 'A', pauseAfter: pause, basis: '《平水韵》上声十七筱', note: `${char} 为韵脚` };
  });
  marks[keyOf(0, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '句中平声' };
  marks[keyOf(1, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };
  marks[keyOf(2, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };

  const topVersion: PoemVersion = {
    id: 'version-main',
    name: '通行本 · 孟浩然集',
    source: '《孟浩然诗集笺注》',
    createdAt: now,
    text: spring,
    marks,
    antithesisPairs: [],
  };
  const variant: PoemVersion = {
    id: 'version-song',
    name: '宋刻本异文',
    source: '宋蜀刻本',
    createdAt: now,
    text: '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。',
    marks: clone(marks),
    antithesisPairs: [],
  };
  return {
    title: '春晓',
    author: '孟浩然',
    templateId: 'wuyan-zeqi',
    versions: [topVersion, variant],
    activeVersionId: topVersion.id,
    updatedAt: now,
  };
}

function loadWorkspace(): PoemWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialWorkspace();
    const parsed = JSON.parse(raw) as PoemWorkspace;
    return parsed.versions?.length ? parsed : initialWorkspace();
  } catch {
    return initialWorkspace();
  }
}

/** 供界面渲染的一行：confirmed 来自已确认分析版本，pending 表示该行尚未分析。 */
export interface ViewLine {
  index: number;
  confirmed: boolean;
  source: AnalysisLine;
}

@Injectable({ providedIn: 'root' })
export class PoetryStoreService {
  private readonly engine = inject(AnalysisEngineService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  /** —— 正文编辑会话：只承载用户正在编辑的内容，与分析状态完全隔离。 —— */
  readonly workspace = signal<PoemWorkspace>(loadWorkspace());
  readonly selectedLine = signal(0);
  readonly selectedPosition = signal(4);
  readonly baselineVersionId = signal<string>('');
  readonly currentDiffLine = signal(0);
  readonly toast = signal('');
  readonly undoCount = signal(0);
  readonly redoCount = signal(0);

  /** 自增版本号：编辑会话每次提交都推进，驱动编辑视图刷新，但不触碰分析结果。 */
  private readonly editEpoch = signal(0);

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private lastTextEditAt = 0;
  private textCoalesceSeq = 0;

  private analyzeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.engine.connect({
      storageKey: CHECKPOINT_KEY,
      work: (versionId) => {
        const state = this.workspace();
        const version = state.versions.find((item) => item.id === versionId) ?? state.versions[0];
        const template = METER_TEMPLATES.find((item) => item.id === state.templateId) ?? METER_TEMPLATES[0];
        return version ? { version, template } : null;
      },
      onConfirmed: (versionId) => {
        if (versionId === this.workspace().activeVersionId) this.editEpoch.update((n) => n + 1);
      },
      tick: () => this.editEpoch.update((n) => n + 1),
    });

    // 重开：完成态检查点直接重建为已确认版本；失败态从检查点续跑。
    const state = this.workspace();
    state.versions.forEach((version) => {
      const template = METER_TEMPLATES.find((item) => item.id === state.templateId) ?? METER_TEMPLATES[0];
      this.engine.restoreConfirmed(version.id, version, template);
    });
    this.queueFailedResumes();
    this.scheduleAnalysis(this.workspace().activeVersionId);

    const flush = () => this.persistNow();
    window.addEventListener('beforeunload', flush);
    this.destroyRef.onDestroy(() => window.removeEventListener('beforeunload', flush));
  }

  // ---------------------------------------------------------------------------
  // 编辑会话派生数据（纯文本视图，便宜，不做整篇格律计算）
  // ---------------------------------------------------------------------------

  readonly activeVersion = computed(() => {
    this.editEpoch();
    const state = this.workspace();
    return state.versions.find((version) => version.id === state.activeVersionId) ?? state.versions[0];
  });

  readonly template = computed(() => {
    this.editEpoch();
    return METER_TEMPLATES.find((item) => item.id === this.workspace().templateId) ?? METER_TEMPLATES[0];
  });

  readonly lines = computed(() => {
    this.editEpoch();
    return this.activeVersion().text.split('\n');
  });

  /** 当前版本分析批次状态（排队/运行/失败/完成），与输入框无关。 */
  readonly analysisRun = computed<AnalysisRunState>(() => {
    this.editEpoch();
    return this.engine.runState(this.activeVersion().id);
  });

  // ---------------------------------------------------------------------------
  // 已确认分析版本的唯一出口：字格、问题清单、校对稿全部读这里
  // ---------------------------------------------------------------------------

  private readonly confirmedSnapshot = computed<AnalysisSnapshot | undefined>(() => {
    this.editEpoch();
    const version = this.activeVersion();
    const snapshot = this.engine.snapshot(version.id);
    if (!snapshot || snapshot.templateId !== this.workspace().templateId) return undefined;
    return snapshot;
  });

  /** 已确认结果中，与当前正文逐行对得上的行；其余一律视为待分析，绝不拿旧结论冒充。 */
  readonly viewLines = computed<ViewLine[]>(() => {
    this.editEpoch();
    const snapshot = this.confirmedSnapshot();
    const rawLines = this.activeVersion().text.split('\n');
    const marks = this.activeVersion().marks;
    const template = this.template();
    const byIndex = new Map(snapshot?.lines.map((line) => [line.index, line]) ?? []);
    return rawLines.map((raw, index) => {
      const analyzed = byIndex.get(index);
      const chars = Array.from(raw).filter((char) => !PUNCTUATION.has(char));
      const fingerprint = this.lineFingerprint(chars, marks, index, template.id);
      if (analyzed && this.fingerprintOf(analyzed, index, template.id) === fingerprint) {
        return { index, confirmed: true, source: analyzed };
      }
      return { index, confirmed: false, source: this.pendingLine(chars, index) };
    });
  });

  /** 仅包含已确认且与正文一致的行；未算完的行不出任何结论。 */
  readonly analysis = computed<AnalysisLine[]>(() => this.viewLines().filter((line) => line.confirmed).map((line) => line.source));

  readonly issues = computed<PoemIssue[]>(() => {
    this.editEpoch();
    const snapshot = this.confirmedSnapshot();
    const pendingCount = this.viewLines().filter((line) => !line.confirmed).length;
    if (!snapshot) {
      return [
        { id: 'analysis-pending-all', level: 'info', title: '待分析', detail: '正文尚未完成后台分析，暂无格律结论。' },
        ...this.antithesisIssues(),
      ];
    }
    const issues = snapshot.issues.filter((issue) => issue.line === undefined || this.viewLines()[issue.line]?.confirmed);
    if (pendingCount > 0) {
      issues.unshift({
        id: 'analysis-pending',
        level: 'warning',
        title: '部分段落待分析',
        detail: `还有 ${pendingCount} 句未纳入当前已确认分析版本，以下结论仅覆盖已算完段落。`,
      });
    }
    issues.push(...this.antithesisIssues());
    return issues;
  });

  private antithesisIssues(): PoemIssue[] {
    if (this.activeVersion().antithesisPairs.length > 0) return [];
    return [{ id: 'antithesis-empty', level: 'info', title: '尚未标记对仗', detail: '可在检视器中把两句建立对仗关系。' }];
  }

  readonly confirmedLineCount = computed(() => this.viewLines().filter((line) => line.confirmed).length);

  /** 当前选中字格：已确认行展示分析结论，待分析行展示占位，输入与批注照常可用。 */
  selectedCell() {
    const view = this.viewLines()[this.selectedLine()];
    return view?.source.cells[this.selectedPosition()];
  }

  // ---------------------------------------------------------------------------
  // 异文对照：两侧都必须来自各自的已确认分析版本，否则不显示旧结论
  // ---------------------------------------------------------------------------

  readonly baselineVersion = computed(() => {
    this.editEpoch();
    return this.workspace().versions.find((version) => version.id === this.baselineVersionId());
  });

  private snapshotOf(versionId: string): AnalysisSnapshot | undefined {
    const snapshot = this.engine.snapshot(versionId);
    return snapshot && snapshot.templateId === this.workspace().templateId ? snapshot : undefined;
  }

  readonly diffReady = computed<boolean>(() => {
    this.editEpoch();
    const baseline = this.baselineVersion();
    if (!baseline) return false;
    const active = this.activeVersion();
    if (baseline.id === active.id) return false;
    const left = this.snapshotOf(baseline.id);
    const right = this.snapshotOf(active.id);
    return !!left && !!right && left.text === baseline.text && right.text === active.text;
  });

  readonly diffLines = computed<DiffLine[]>(() => {
    this.editEpoch();
    const baseline = this.baselineVersion();
    const active = this.activeVersion();
    if (!baseline || baseline.id === active.id) return [];
    const leftSnapshot = this.snapshotOf(baseline.id);
    const rightSnapshot = this.snapshotOf(active.id);
    if (!leftSnapshot || !rightSnapshot || leftSnapshot.text !== baseline.text || rightSnapshot.text !== active.text) return [];
    const leftRaw = leftSnapshot.text.split('\n');
    const rightRaw = rightSnapshot.text.split('\n');
    const size = Math.max(leftRaw.length, rightRaw.length);
    return Array.from({ length: size }, (_, line) => {
      const lChars = Array.from(leftRaw[line] ?? '').filter((char) => !PUNCTUATION.has(char));
      const rChars = Array.from(rightRaw[line] ?? '').filter((char) => !PUNCTUATION.has(char));
      const width = Math.max(lChars.length, rChars.length);
      const cells: DiffCell[] = Array.from({ length: width }, (_, position) => ({
        left: lChars[position] ?? '',
        right: rChars[position] ?? '',
        changed: (lChars[position] ?? '') !== (rChars[position] ?? ''),
      }));
      return { line, left: leftRaw[line] ?? '', right: rightRaw[line] ?? '', changed: cells.some((cell) => cell.changed), cells };
    });
  });

  readonly differenceLines = computed(() => this.diffLines().filter((line) => line.changed).map((line) => line.line));

  // ---------------------------------------------------------------------------
  // 编辑动作
  // ---------------------------------------------------------------------------

  selectVersion(id: string): void {
    if (id === this.workspace().activeVersionId) return;
    this.workspace.update((workspace) => ({ ...workspace, activeVersionId: id }));
    this.selectedLine.set(0);
    this.selectedPosition.set(0);
    this.currentDiffLine.set(0);
    this.editEpoch.update((n) => n + 1);
    this.ensureAnalysis();
  }

  selectCell(line: number, position: number): void {
    this.selectedLine.set(line);
    this.selectedPosition.set(position);
  }

  setTemplate(id: string): void {
    this.commit(
      (workspace) => {
        workspace.templateId = id;
      },
      { coalesceKey: null },
    );
    this.ensureAnalysis();
  }

  updateText(text: string): void {
    const now = Date.now();
    const withinWindow = now - this.lastTextEditAt < TEXT_UNDO_COALESCE_MS;
    // 同一连续输入段共用一个随段落递增的合并键，第一键与后续键都参与合并。
    if (!withinWindow) this.textCoalesceSeq += 1;
    this.lastTextEditAt = now;
    this.commit(
      (workspace) => {
        this.versionIn(workspace).text = text;
      },
      { coalesceKey: `text-${this.textCoalesceSeq}` },
    );
    this.invalidateActiveAnalysis();
  }

  updateTitle(title: string): void {
    this.commit((workspace) => {
      workspace.title = title;
    });
  }

  updateVersionSource(source: string): void {
    this.commit((workspace) => {
      this.versionIn(workspace).source = source;
    });
  }

  setMark(patch: Partial<CharacterMark>): void {
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      const id = keyOf(this.selectedLine(), this.selectedPosition());
      version.marks[id] = { ...defaultMark(), ...version.marks[id], ...patch };
    });
    this.invalidateActiveAnalysis();
  }

  cycleTone(): void {
    const cell = this.selectedCell();
    const next: Record<Tone, MarkTone | '?'> = { '?': '平', '平': '仄', '仄': '中', '中': '?' };
    this.setMark({ tone: next[cell?.actual ?? '?'] });
  }

  togglePause(): void {
    const cell = this.selectedCell();
    this.setMark({ pauseAfter: !(cell?.mark.pauseAfter ?? false) });
  }

  cycleRhyme(): void {
    const cell = this.selectedCell();
    const current = cell?.mark.rhyme ?? '';
    const next = current === '' ? 'A' : current === 'A' ? 'B' : current === 'B' ? 'C' : '';
    this.setMark({ rhyme: next });
  }

  addAntithesis(): void {
    const line = this.selectedLine();
    const other = line === 0 ? 1 : line - 1;
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      if (version.antithesisPairs.some((pair) => pair.leftLine === line && pair.rightLine === other)) return;
      version.antithesisPairs.push({ id: uid('pair'), leftLine: Math.min(line, other), rightLine: Math.max(line, other), note: '结构相对，词性相应。' });
    });
  }

  removeAntithesis(id: string): void {
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      version.antithesisPairs = version.antithesisPairs.filter((pair) => pair.id !== id);
    });
  }

  updateAntithesis(id: string, note: string): void {
    this.commit((workspace) => {
      const pair = this.versionIn(workspace).antithesisPairs.find((item) => item.id === id);
      if (pair) pair.note = note;
    });
  }

  snapshot(): void {
    const active = clone(this.activeVersion());
    active.id = uid('version');
    active.name = `校勘稿 ${this.workspace().versions.length}`;
    active.createdAt = new Date().toISOString();
    this.commit((workspace) => {
      workspace.versions.unshift(active);
      workspace.activeVersionId = active.id;
    });
    this.toast.set('已建立独立校勘稿');
    this.ensureAnalysis();
  }

  duplicateActiveAsBaseline(): void {
    this.baselineVersionId.set(this.activeVersion().id);
  }

  nextDifference(): void {
    const values = this.differenceLines();
    if (!values.length) return;
    const current = values.findIndex((index) => index > this.currentDiffLine());
    this.currentDiffLine.set(values[current === -1 ? 0 : current]);
  }

  previousDifference(): void {
    const values = this.differenceLines();
    if (!values.length) return;
    const reverse = [...values].reverse();
    const current = reverse.findIndex((index) => index < this.currentDiffLine());
    this.currentDiffLine.set(reverse[current === -1 ? 0 : current]);
  }

  retryAnalysis(): void {
    this.engine.resume(this.activeVersion().id);
  }

  runAnalysisNow(): void {
    const timer = this.analyzeTimers.get(this.activeVersion().id);
    if (timer) clearTimeout(timer);
    this.engine.request(this.activeVersion().id);
  }

  ensureVersionAnalyzed(versionId: string): void {
    if (versionId === this.activeVersion().id) {
      this.ensureAnalysis(versionId);
      return;
    }
    // 底本等非当前版本：无已确认结果时排队后台分析，不打断正在编辑的会话。
    if (!this.engine.snapshot(versionId)) this.engine.request(versionId);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.historyEntry());
    this.workspace.set(previous.workspace);
    this.syncHistoryCounts();
    this.persist();
    this.invalidateActiveAnalysis();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.historyEntry());
    this.workspace.set(next.workspace);
    this.syncHistoryCounts();
    this.persist();
    this.invalidateActiveAnalysis();
  }

  // ---------------------------------------------------------------------------
  // 导出校对稿：逐段标注“已算完 / 待分析”，未算完不附任何旧结论
  // ---------------------------------------------------------------------------

  exportProofreadCopy(): string {
    const active = this.activeVersion();
    const viewLines = this.viewLines();
    const lines = viewLines.map((view) => {
      if (!view.confirmed) {
        return `第 ${view.index + 1} 句：待分析（正文：${this.lines()[view.index]}）`;
      }
      const tags = view.source.cells
        .map((cell) => `${cell.char}${cell.actual === '?' ? '□' : `(${cell.actual})`}`)
        .join(' ');
      return `第 ${view.index + 1} 句〔已算完〕：${tags}`;
    });
    const snapshot = this.confirmedSnapshot();
    const notes = this.issues().map((issue) => `[${issue.level.toUpperCase()}] ${issue.title}：${issue.detail}`);
    return [
      `# ${this.workspace().title} · 格律校对稿`,
      '',
      `底本：${active.name}`,
      `出处：${active.source}`,
      `分析版本：${snapshot ? new Date(snapshot.analyzedAt).toLocaleString() : '尚无已确认分析版本'}`,
      `覆盖范围：${this.confirmedLineCount()} / ${viewLines.length} 句已算完，其余标注“待分析”`,
      '',
      '## 字音标注',
      ...lines,
      '',
      '## 检查记录',
      ...notes,
    ].join('\n');
  }

  downloadProofreadCopy(): void {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([this.exportProofreadCopy()], { type: 'text/markdown;charset=utf-8' }));
    anchor.download = `${this.workspace().title}-格律校对稿.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  // ---------------------------------------------------------------------------
  // 内部：编辑/分析分离的关键
  // ---------------------------------------------------------------------------

  /**
   * 编辑使当前版本在途批次立即作废：输入和批注继续可用，
   * 已确认版本在引擎中保留（失败回滚靠它），但视图按行指纹自行遮蔽过时结论。
   */
  private invalidateActiveAnalysis(): void {
    const versionId = this.activeVersion().id;
    this.engine.invalidate(versionId);
    this.editEpoch.update((n) => n + 1);
    this.scheduleAnalysis(versionId);
  }

  private ensureAnalysis(versionId?: string): void {
    this.editEpoch.update((n) => n + 1);
    this.scheduleAnalysis(versionId ?? this.workspace().activeVersionId);
  }

  /** 后台计时与批次调度全部留在 Angular 区域外，只靠 signal 通知界面。 */
  private scheduleAnalysis(versionId: string): void {
    if (this.analyzeTimers.get(versionId)) clearTimeout(this.analyzeTimers.get(versionId));
    this.zone.runOutsideAngular(() => {
      const timer = setTimeout(() => this.engine.request(versionId), ANALYZE_DEBOUNCE_MS);
      this.analyzeTimers.set(versionId, timer);
    });
  }

  private queueFailedResumes(): void {
    this.workspace().versions.forEach((version) => {
      if (this.engine.runState(version.id).phase === 'failed') this.engine.resume(version.id);
    });
  }

  private pendingLine(chars: string[], lineIndex: number): AnalysisLine {
    const cells = chars.map((char, position) => ({
      char,
      position,
      expected: '中' as Tone,
      actual: '?' as Tone,
      status: 'pending' as const,
      message: '此段尚未分析完成，暂无格律结论',
      mark: this.activeVersion().marks[keyOf(lineIndex, position)] ?? defaultMark(),
    }));
    return { index: lineIndex, cells, rhymeChars: [], errors: 0, variants: 0 };
  }

  private lineFingerprint(chars: string[], marks: Record<string, CharacterMark>, line: number, templateId: string): string {
    const markPart = chars.map((_, position) => JSON.stringify(marks[keyOf(line, position)] ?? defaultMark())).join('|');
    return `${templateId}|${chars.join('')}|${markPart}`;
  }

  private fingerprintOf(line: AnalysisLine, index: number, templateId: string): string {
    const chars = line.cells.map((cell) => cell.char);
    const marks = Object.fromEntries(line.cells.map((cell) => [keyOf(index, cell.position), cell.mark]));
    return this.lineFingerprint(chars, marks, index, templateId);
  }

  private historyEntry(): HistoryEntry {
    return { workspace: clone(this.workspace()), coalesceKey: null };
  }

  private commit(mutator: (workspace: PoemWorkspace) => void, options: { coalesceKey?: string | null } = {}): void {
    const coalesce = options.coalesceKey !== undefined && options.coalesceKey !== null;
    const top = this.undoStack[this.undoStack.length - 1];
    if (!(coalesce && top?.coalesceKey === options.coalesceKey)) {
      // 保留本次提交前的完整快照；同一合并段只入栈一次，撤销时回到输入起点。
      this.undoStack.push({ workspace: clone(this.workspace()), coalesceKey: options.coalesceKey ?? null });
      if (this.undoStack.length > 80) this.undoStack.shift();
    }
    this.redoStack = [];
    const next = clone(this.workspace());
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.workspace.set(next);
    this.syncHistoryCounts();
    this.schedulePersist();
  }

  private syncHistoryCounts(): void {
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.zone.runOutsideAngular(() => {
      this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS);
    });
  }

  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.workspace()));
    } catch {
      /* 存储失败不阻塞编辑 */
    }
  }

  private persist(): void {
    this.persistNow();
  }

  private versionIn(workspace: PoemWorkspace): PoemVersion {
    return workspace.versions.find((item) => item.id === workspace.activeVersionId) ?? workspace.versions[0];
  }
}

interface HistoryEntry {
  workspace: PoemWorkspace;
  coalesceKey: string | null;
}
