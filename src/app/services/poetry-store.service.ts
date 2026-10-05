import { computed, Injectable, signal } from '@angular/core';
import type {
  AnalysisCell,
  AnalysisLine,
  CharacterMark,
  DiffRow,
  LineView,
  MarkTone,
  PoemIssue,
  PoemVersion,
  PoemWorkspace,
  Tone,
} from '../models/poem.models';
import {
  METER_TEMPLATES,
  buildDiffRows,
  buildVersionIssues,
  cellKey,
  charsOfLine,
  computeFingerprint,
  defaultMark,
  isRhymeLine,
  splitLines,
} from './analysis.util';
import { AnalysisService } from './analysis.service';

export { METER_TEMPLATES };

const STORAGE_KEY = 'sologsb-1015-poetry-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function initialWorkspace(): PoemWorkspace {
  const now = new Date().toISOString();
  const spring = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';
  const marks: Record<string, CharacterMark> = {};
  const cells = [
    ['晓', 0, '平', false], ['鸟', 1, '平', false], ['声', 2, '平', false], ['少', 3, '平', false],
  ] as const;
  cells.forEach(([char, line, tone, pause]) => {
    marks[cellKey(line, 4)] = { tone, rhyme: 'A', pauseAfter: pause, basis: '《平水韵》上声十七筱', note: `${char} 为韵脚` };
  });
  marks[cellKey(0, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '句中平声' };
  marks[cellKey(1, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };
  marks[cellKey(2, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };

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

@Injectable({ providedIn: 'root' })
export class PoetryStoreService {
  readonly workspace = signal<PoemWorkspace>(loadWorkspace());
  readonly selectedLine = signal(0);
  readonly selectedPosition = signal(4);
  readonly baselineVersionId = signal<string>('');
  readonly currentDiffIndex = signal(0);
  readonly toast = signal('');
  readonly undoCount = signal(0);
  readonly redoCount = signal(0);

  private undoStack: PoemWorkspace[] = [];
  private redoStack: PoemWorkspace[] = [];

  constructor(private readonly analysisRunner: AnalysisService) {
    // 启动后台批次：与已恢复的检查点指纹一致时会自动复用，否则排队重算
    this.analysisRunner.contentChanged(this.workspace());
  }

  // ---- 编辑会话（与后台分析批次完全分离） ---------------------------------

  readonly activeVersion = computed(() => {
    const state = this.workspace();
    return state.versions.find((version) => version.id === state.activeVersionId) ?? state.versions[0];
  });

  readonly template = computed(() => {
    return METER_TEMPLATES.find((item) => item.id === this.workspace().templateId) ?? METER_TEMPLATES[0];
  });

  readonly lines = computed(() => splitLines(this.activeVersion().text));

  /** 当前编辑会话的指纹，后台批次只认批次启动时冻结的那一版 */
  readonly liveFingerprint = computed(() => computeFingerprint(this.workspace()));

  // ---- 已确认分析版本（唯一允许外显的分析结论来源） -----------------------

  readonly runState = computed(() => this.analysisRunner.runState());
  readonly published = computed(() => this.analysisRunner.published());
  readonly checkpoint = computed(() => this.analysisRunner.checkpoint());

  readonly analysisStale = computed(() => {
    const published = this.published();
    return published ? published.fingerprint !== this.liveFingerprint() : false;
  });

  private readonly activePublishedIndex = computed(() => {
    const published = this.published();
    if (!published) return -1;
    return published.snapshots.findIndex((snapshot) => snapshot.id === this.activeVersion().id);
  });

  /**
   * 字格视图：confirmed=同一已确认版本的结果；stale=上一版旧结论（明确标旧）；
   * pending=尚未算完，只能显示“待分析”占位，绝不拿旧结论顶替。
   */
  readonly lineViews = computed<LineView[]>(() => {
    const liveLines = this.lines();
    const published = this.published();
    const stale = this.analysisStale();
    const index = this.activePublishedIndex();
    const confirmedLines = published && index >= 0 ? published.results[index] : null;

    return liveLines.map((rawLine, lineIndex) => {
      const liveChars = charsOfLine(rawLine);
      const line = confirmedLines?.[lineIndex];
      if (line && !stale) return { index: lineIndex, status: 'confirmed' as const, line, liveChars };
      if (line && stale) return { index: lineIndex, status: 'stale' as const, line, liveChars };
      return { index: lineIndex, status: 'pending' as const, line: null, liveChars };
    });
  });

  /** 检查结果只汇总同一已确认整版；半批次或正文已改动时不展示旧结论 */
  readonly confirmedIssues = computed<PoemIssue[] | null>(() => {
    const published = this.published();
    const index = this.activePublishedIndex();
    if (!published || index < 0 || this.analysisStale()) return null;
    const template = METER_TEMPLATES.find((item) => item.id === published.templateId) ?? METER_TEMPLATES[0];
    return buildVersionIssues(published.results[index], template, published.snapshots[index].antithesisPairs);
  });

  /** 异文对照同样只读取已确认版本快照，切换对照页不触发任何重算 */
  readonly diffRows = computed<DiffRow[] | null>(() => {
    const published = this.published();
    if (!published) return null;
    const leftIndex = published.snapshots.findIndex((snapshot) => snapshot.id === this.baselineVersionId());
    const rightIndex = this.activePublishedIndex();
    if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) return null;
    return buildDiffRows(published.snapshots[leftIndex], published.snapshots[rightIndex]);
  });

  readonly diffComparable = computed(() => this.diffRows() !== null);

  readonly diffBaselineSnapshot = computed(() => {
    const published = this.published();
    if (!published) return null;
    return published.snapshots.find((snapshot) => snapshot.id === this.baselineVersionId()) ?? null;
  });

  readonly diffActiveSnapshot = computed(() => {
    const published = this.published();
    const index = this.activePublishedIndex();
    return published && index >= 0 ? published.snapshots[index] : null;
  });

  readonly differences = computed<number[]>(() => {
    const rows = this.diffRows();
    return rows ? rows.flatMap((row) => row.cells.filter((cell) => cell.changed).map((cell) => cell.index)) : [];
  });

  readonly currentDiffRowIndex = computed(() => {
    const rows = this.diffRows();
    const target = this.effectiveDiffIndex();
    if (!rows) return -1;
    return rows.findIndex((row) => target >= row.offset && target < row.offset + row.cells.length);
  });

  /** 当前定位若已不在结果范围内（如新版本确认），自动落到第一处异文 */
  readonly effectiveDiffIndex = computed(() => {
    const values = this.differences();
    if (!values.length) return 0;
    const target = this.currentDiffIndex();
    return values.includes(target) ? target : values[0];
  });

  // ---- 编辑会话派生（实时，不等分析） ------------------------------------

  readonly liveMarkedRate = computed(() => {
    let marked = 0;
    let total = 0;
    this.lines().forEach((rawLine, lineIndex) => {
      charsOfLine(rawLine).forEach((_char, position) => {
        total += 1;
        const mark = this.activeVersion().marks[cellKey(lineIndex, position)];
        if (mark && mark.tone !== '?') marked += 1;
      });
    });
    return total === 0 ? 0 : Math.round((marked / total) * 100);
  });

  liveChar(line: number, position: number): string {
    return charsOfLine(this.lines()[line] ?? '')[position] ?? '';
  }

  liveMarkAt(line: number, position: number): CharacterMark {
    return this.activeVersion().marks[cellKey(line, position)] ?? defaultMark();
  }

  isRhymeLineByTemplate(lineIndex: number): boolean {
    return isRhymeLine(this.template(), lineIndex);
  }

  /** 选中字的视图：已确认句用整版结果，待分析句用编辑会话实时内容占位 */
  selectedCellView(): (AnalysisCell & { pending?: boolean }) | undefined {
    const line = this.selectedLine();
    const position = this.selectedPosition();
    const view = this.lineViews()[line];
    if (!view) return undefined;
    if (view.status !== 'pending' && view.line) {
      return view.line.cells[position];
    }
    const mark = { ...this.liveMarkAt(line, position) };
    return {
      char: view.liveChars[position] ?? '',
      position,
      expected: '?',
      actual: mark.tone,
      status: 'unknown',
      message: '待分析：该句尚未进入已确认分析版本，输入与批注可继续',
      mark,
      pending: true,
    };
  }

  // ---- 编辑操作 ----------------------------------------------------------

  selectVersion(id: string): void {
    // 仅切换查看目标；已确认版本读取是纯 computed，不会重算整篇
    this.workspace.update((workspace) => ({ ...workspace, activeVersionId: id }));
    // 新版本可能更短，选中位置夹取到其句数与句长范围内
    const views = this.lineViews();
    const line = Math.min(this.selectedLine(), Math.max(0, views.length - 1));
    const maxPosition = Math.max(0, (views[line]?.liveChars.length ?? 1) - 1);
    this.selectedLine.set(line);
    this.selectedPosition.set(Math.min(this.selectedPosition(), maxPosition));
  }

  selectCell(line: number, position: number): void {
    this.selectedLine.set(line);
    this.selectedPosition.set(position);
  }

  setTemplate(id: string): void {
    this.commit((workspace) => {
      workspace.templateId = id;
    });
  }

  updateText(text: string): void {
    this.commit((workspace) => {
      this.versionIn(workspace).text = text;
    });
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
      const id = cellKey(this.selectedLine(), this.selectedPosition());
      version.marks[id] = { ...defaultMark(), ...version.marks[id], ...patch };
    });
  }

  cycleTone(): void {
    const cell = this.selectedCellView();
    const next: Record<Tone, MarkTone | '?'> = { '?': '平', '平': '仄', '仄': '中', '中': '?' };
    this.setMark({ tone: next[cell?.actual ?? '?'] });
  }

  togglePause(): void {
    this.setMark({ pauseAfter: !this.liveMarkAt(this.selectedLine(), this.selectedPosition()).pauseAfter });
  }

  cycleRhyme(): void {
    const current = this.liveMarkAt(this.selectedLine(), this.selectedPosition()).rhyme ?? '';
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
    this.toast.set('已建立独立校勘稿，后台已排队分析新版本');
  }

  duplicateActiveAsBaseline(): void {
    this.baselineVersionId.set(this.activeVersion().id);
  }

  nextDifference(): void {
    const values = this.differences();
    if (!values.length) return;
    const current = values.findIndex((index) => index > this.currentDiffIndex());
    this.currentDiffIndex.set(values[current === -1 ? 0 : current]);
  }

  previousDifference(): void {
    const values = this.differences();
    if (!values.length) return;
    const before = values.filter((index) => index < this.currentDiffIndex());
    this.currentDiffIndex.set(before.length ? before[before.length - 1] : values[values.length - 1]);
  }

  resumeAnalysis(): void {
    this.analysisRunner.resume();
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.workspace()));
    this.workspace.set(previous);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persist();
    // 撤销回旧内容：运行中的批次按新指纹立即作废并重排
    this.analysisRunner.contentChanged(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.workspace()));
    this.workspace.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persist();
    this.analysisRunner.contentChanged(next);
  }

  // ---- 校对稿导出：只写已算完段落，未算完必须写“待分析” ----------------

  exportProofreadCopy(): string {
    const active = this.activeVersion();
    const template = this.template();
    const published = this.published();
    const checkpoint = this.checkpoint();
    const liveLines = this.lines();

    // 优先用对应当前正文指纹的检查点（含失败断点）：已算完段落照实写
    const matchingCheckpoint =
      checkpoint && checkpoint.fingerprint === this.liveFingerprint()
        ? checkpoint.snapshots.findIndex((snapshot) => snapshot.id === active.id) >= 0
          ? checkpoint
          : null
        : null;
    const checkpointIndex = matchingCheckpoint
      ? matchingCheckpoint.snapshots.findIndex((snapshot) => snapshot.id === active.id)
      : -1;

    const publishedIndex = published ? published.snapshots.findIndex((snapshot) => snapshot.id === active.id) : -1;
    const stalePublished = published && publishedIndex >= 0 && published.fingerprint !== this.liveFingerprint();
    const freshPublished = published && publishedIndex >= 0 && published.fingerprint === this.liveFingerprint();

    const body: string[] = [];
    liveLines.forEach((rawLine, lineIndex) => {
      const checkpointLine = matchingCheckpoint ? matchingCheckpoint.results[checkpointIndex]?.[lineIndex] : undefined;
      const publishedLine = freshPublished || stalePublished ? published!.results[publishedIndex][lineIndex] : undefined;

      if (checkpointLine) {
        body.push(this.formatProofLine(lineIndex, checkpointLine));
      } else if (freshPublished && publishedLine) {
        body.push(this.formatProofLine(lineIndex, publishedLine));
      } else if (stalePublished && publishedLine) {
        // 旧结论绝不冒充：明确标注为旧版、待重新分析
        body.push(`第 ${lineIndex + 1} 句：【旧版结论，待重新分析】${this.formatTags(publishedLine)}`);
      } else {
        const liveChars = charsOfLine(rawLine);
        body.push(`第 ${lineIndex + 1} 句：待分析（${liveChars.join('')}）`);
      }
    });

    const header = [
      `# ${this.workspace().title} · 格律校对稿`,
      '',
      `底本：${active.name}`,
      `出处：${active.source}`,
    ];
    const statusNote: string[] = [];
    const state = this.runState();
    if (matchingCheckpoint) {
      const done = matchingCheckpoint.results[checkpointIndex].filter(Boolean).length;
      statusNote.push(`> 分析批次${state?.phase === 'failed' ? '曾失败' : '进行中'}：已确认 ${done}/${liveLines.length} 句，其余段落标注“待分析”。`);
    } else if (stalePublished) {
      statusNote.push('> 正文已有改动，以下整版为上一版结论，新批次确认前不作为本次结果。');
    } else if (!freshPublished) {
      statusNote.push('> 尚无已确认的分析版本，全部段落为“待分析”。');
    } else {
      statusNote.push(`> 分析版本 ${published!.revision.slice(-6)} 已于 ${published!.confirmedAt} 整版确认。`);
    }

    const notes: string[] = [];
    if (freshPublished) {
      const issues = this.confirmedIssues() ?? [];
      notes.push(...issues.map((issue) => `[${issue.level.toUpperCase()}] ${issue.title}：${issue.detail}`));
    } else {
      notes.push('[INFO] 待分析：检查记录需等整版分析确认后生成，旧结论不写入本稿。');
    }

    return [
      ...header,
      ...statusNote,
      '',
      '## 字音标注',
      ...body,
      '',
      '## 检查记录',
      ...notes,
      '',
      '## 对仗关系',
      ...(active.antithesisPairs.length
        ? active.antithesisPairs.map((pair) => `- 第 ${pair.leftLine + 1} 句 ↔ 第 ${pair.rightLine + 1} 句：${pair.note}`)
        : ['- 暂无']),
      '',
      '## 版本来源',
      ...this.workspace().versions.map((version) => `- ${version.name}：${version.source}`),
      '',
      `_模板：${template.name}_`,
    ].join('\n');
  }

  private formatProofLine(lineIndex: number, line: AnalysisLine): string {
    return `第 ${lineIndex + 1} 句：${this.formatTags(line)}`;
  }

  private formatTags(line: AnalysisLine): string {
    return line.cells.map((cell) => `${cell.char}${cell.actual === '?' ? '□' : `(${cell.actual})`}`).join(' ');
  }

  downloadProofreadCopy(): void {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([this.exportProofreadCopy()], { type: 'text/markdown;charset=utf-8' }));
    anchor.download = `${this.workspace().title}-格律校对稿.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  // ---- 内部 --------------------------------------------------------------

  private commit(mutator: (workspace: PoemWorkspace) => void): void {
    this.undoStack.push(clone(this.workspace()));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.workspace());
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.workspace.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(0);
    this.persist();
    // 每次编辑只通知指纹变化；正在跑的批次立即作废，新批次静默排队，输入不等待
    this.analysisRunner.contentChanged(next);
  }

  private versionIn(workspace: PoemWorkspace): PoemVersion {
    return workspace.versions.find((item) => item.id === workspace.activeVersionId) ?? workspace.versions[0];
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.workspace()));
  }
}
