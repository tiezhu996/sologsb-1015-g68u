import { Injectable, signal } from '@angular/core';
import type {
  AnalysisBatch,
  AnalysisCell,
  AnalysisCheckpoint,
  AnalysisLine,
  AnalysisRunState,
  AnalysisSnapshot,
  CharacterMark,
  MeterTemplate,
  PoemIssue,
  PoemVersion,
  Tone,
} from '../models/poem.models';

/**
 * 后台格律分析引擎。
 *
 * 与正文编辑会话严格分离：
 * - 编辑只更新版本内容，绝不触碰分析状态；
 * - 超长文本按行切成批次，经队列串行调度，逐批让出主线程；
 * - 只有全部批次成功后才产出“已确认分析版本”，字格与异文对照共用这一份；
 * - 编辑一旦发生，正在排队/运行的批次立即作废（generation 失效），输入与批注不中断；
 * - 批次失败时保留上一版完整结果，检查点落库，重开后从断点继续。
 */
@Injectable({ providedIn: 'root' })
export class AnalysisEngineService {
  /** 当前对外可见的唯一已确认分析版本（按版本 id 存放）。 */
  private readonly confirmed = new Map<string, AnalysisSnapshot>();

  /** 各版本检查点，持久化于 localStorage，供重开续跑。 */
  private checkpoints = new Map<string, AnalysisCheckpoint>();

  /** 从检查点重建的已确认版本（检查点含全部批次结果，与重开前一致）。 */
  restoreConfirmed(versionId: string, version: PoemVersion, template: MeterTemplate): AnalysisSnapshot | undefined {
    const checkpoint = this.checkpoints.get(versionId);
    if (!checkpoint || checkpoint.phase !== 'completed') return undefined;
    if (checkpoint.revision !== this.revisionOf(version, template.id)) return undefined;
    if (checkpoint.doneLineCount !== checkpoint.totalLineCount) return undefined;
    const snapshot = this.assemble(version, template, checkpoint.revision, checkpoint.batches, checkpoint.totalLineCount);
    this.confirmed.set(versionId, snapshot);
    this.patchState(versionId, {
      phase: 'completed',
      revision: checkpoint.revision,
      doneLineCount: checkpoint.totalLineCount,
      totalLineCount: checkpoint.totalLineCount,
      failedBatchStart: -1,
      error: '',
    });
    return snapshot;
  }

  /** 串行批次队列：超长内容排队处理，不并发冲击主线程。 */
  private queue: QueuedJob[] = [];
  private draining = false;

  /** 每次调度一个版本的分析都会取得新代号；编辑使代号失效，在跑批次即刻作废。 */
  private generations = new Map<string, number>();

  private readonly runStates = new Map<string, ReturnType<typeof signal<AnalysisRunState>>>();

  private storageKey: string;
  private workFn: (versionId: string) => AnalysisWork | null = () => null;
  private onConfirmed: (versionId: string, snapshot: AnalysisSnapshot) => void = () => {};
  private tick: () => void = () => {};

  constructor() {
    this.storageKey = '';
  }

  /** 由 Store 在构造时接线：存储键、取数函数、确认回调、界面刷新回调。 */
  connect(options: {
    storageKey: string;
    work: (versionId: string) => AnalysisWork | null;
    onConfirmed: (versionId: string, snapshot: AnalysisSnapshot) => void;
    tick: () => void;
  }): void {
    this.storageKey = options.storageKey;
    this.workFn = options.work;
    this.onConfirmed = options.onConfirmed;
    this.tick = options.tick;
    this.restore();
  }

  runState(versionId: string): AnalysisRunState {
    return this.stateSignal(versionId)();
  }

  stateSignal(versionId: string) {
    let s = this.runStates.get(versionId);
    if (!s) {
      s = signal<AnalysisRunState>(this.idleState(versionId));
      this.runStates.set(versionId, s);
    }
    return s;
  }

  snapshot(versionId: string): AnalysisSnapshot | undefined {
    return this.confirmed.get(versionId);
  }

  /** 某版本当前检查点（导出/界面判断段落是否已算完时使用）。 */
  checkpoint(versionId: string): AnalysisCheckpoint | undefined {
    return this.checkpoints.get(versionId);
  }

  /**
   * 请求分析一个版本：内容未变则复用确认结果；有新内容则入队，
   * 同一版本在队列中只保留最新一份作业。
   */
  request(versionId: string, opts: { resume?: boolean } = {}): void {
    const work = this.workFn(versionId);
    if (!work || work.version.id !== versionId) return;
    const { version, template } = work;
    const revision = this.revisionOf(version, template.id);
    const totalLineCount = version.text.split('\n').length;
    const existing = this.confirmed.get(versionId);

    if (!opts.resume && existing?.revision === revision && existing.lineFingerprints.length === totalLineCount) {
      this.patchState(versionId, { phase: 'completed', doneLineCount: totalLineCount, totalLineCount, error: '', failedBatchStart: -1 });
      return;
    }

    const checkpoint = this.checkpoints.get(versionId);
    const startLine = opts.resume && checkpoint && checkpoint.revision === revision ? checkpoint.doneLineCount : 0;
    if (!opts.resume || !checkpoint || checkpoint.revision !== revision) {
      this.checkpoints.set(versionId, {
        revision,
        templateId: template.id,
        batches: [],
        doneLineCount: 0,
        totalLineCount,
        phase: 'queued',
        updatedAt: new Date().toISOString(),
      });
      this.persist();
    } else {
      checkpoint.phase = 'queued';
      checkpoint.error = undefined;
      this.saveCheckpoint(checkpoint, versionId);
    }

    // 同版本旧作业移出队列（结果立即作废，只保留最新内容）。
    this.queue = this.queue.filter((job) => job.versionId !== versionId);
    const generation = (this.generations.get(versionId) ?? 0) + 1;
    this.generations.set(versionId, generation);
    this.queue.push({ versionId, revision, template, startLine, generation });

    this.patchState(versionId, {
      phase: 'queued',
      revision,
      totalLineCount,
      doneLineCount: this.checkpoints.get(versionId)?.doneLineCount ?? 0,
      error: '',
      failedBatchStart: -1,
      queuedVersions: this.queue.length - 1,
    });
    this.drain();
  }

  /**
   * 编辑会话发生变更：作废该版本一切在途批次。
   * 已确认结果保持不动（界面继续显示旧版本会误导，因此由 Store 同时清除展示），
   * 但输入与批注不被阻塞。
   */
  invalidate(versionId: string): void {
    this.queue = this.queue.filter((job) => job.versionId !== versionId);
    this.generations.set(versionId, (this.generations.get(versionId) ?? 0) + 1);
    const checkpoint = this.checkpoints.get(versionId);
    if (checkpoint && checkpoint.phase !== 'failed') {
      checkpoint.phase = 'idle';
      this.saveCheckpoint(checkpoint, versionId);
    }
    const runningElsewhere = this.queue.length;
    this.patchState(versionId, {
      phase: 'idle',
      doneLineCount: 0,
      failedBatchStart: -1,
      error: '',
      queuedVersions: runningElsewhere,
    });
  }

  /** 失败后显式重试：从检查点继续。 */
  resume(versionId: string): void {
    this.request(versionId, { resume: true });
  }

  /** 批次粒度与让出间隙：每个批次后把主线程交还给输入与批注。 */
  configurator: { linesPerBatch: number; yieldMs: number; failAt?: number } = {
    linesPerBatch: 40,
    yieldMs: 12,
  };

  // ---------------------------------------------------------------------------
  // 调度
  // ---------------------------------------------------------------------------

  private drain(): void {
    if (this.draining) return;
    const job = this.queue.shift();
    if (!job) return;
    this.draining = true;
    this.runJob(job).finally(() => {
      this.draining = false;
      this.refreshQueueCounts();
      this.tick();
      this.drain();
    });
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const { versionId, revision, template, generation } = job;
    const checkpoint = this.checkpoints.get(versionId);
    const work = this.workFn(versionId);
    // 排队期间内容可能已被编辑：指纹不符则整单作废，直接丢弃。
    if (!work || work.version.id !== versionId || this.revisionOf(work.version, template.id) !== revision || !checkpoint) {
      return;
    }
    const { version } = work;
    const allLines = version.text.split('\n');
    const total = allLines.length;

    this.patchState(versionId, { phase: 'running', totalLineCount: total, revision, failedBatchStart: -1, error: '' });
    checkpoint.phase = 'running';
    this.saveCheckpoint(checkpoint, versionId);

    let cursor = job.startLine;
    while (cursor < total) {
      if (this.isStale(versionId, generation)) return; // 编辑中：批次结果立即作废
      const endLine = Math.min(cursor + this.configurator.linesPerBatch, total);
      try {
        const sliceText = allLines.slice(cursor, endLine);
        const batch = this.analyzeBatch(version, template, sliceText, cursor);
        if (this.configurator.failAt !== undefined && cursor <= this.configurator.failAt && this.configurator.failAt < endLine) {
          throw new Error('模拟批次失败');
        }
        if (this.isStale(versionId, generation)) return;
        checkpoint.batches.push(batch);
        checkpoint.batches.sort((a, b) => a.startLine - b.startLine);
        checkpoint.doneLineCount = endLine;
        checkpoint.totalLineCount = total;
        this.saveCheckpoint(checkpoint, versionId);
        this.patchState(versionId, { phase: 'running', doneLineCount: endLine, totalLineCount: total });
        cursor = endLine;
        if (cursor < total) await this.yieldTo(this.configurator.yieldMs);
      } catch (error) {
        if (this.isStale(versionId, generation)) return;
        // 批次失败：不覆盖已确认结果，上一版完整结果继续可用；记录断点等待续跑。
        checkpoint.phase = 'failed';
        checkpoint.error = error instanceof Error ? error.message : String(error);
        this.saveCheckpoint(checkpoint, versionId);
        this.patchState(versionId, {
          phase: 'failed',
          doneLineCount: checkpoint.doneLineCount,
          totalLineCount: total,
          failedBatchStart: cursor,
          error: checkpoint.error ?? '分析批次失败',
        });
        return;
      }
    }

    if (this.isStale(versionId, generation)) return;
    const snapshot = this.assemble(version, template, revision, checkpoint.batches, total);
    this.confirmed.set(versionId, snapshot);
    checkpoint.phase = 'completed';
    checkpoint.error = undefined;
    this.saveCheckpoint(checkpoint, versionId);
    this.onConfirmed(versionId, snapshot);
    this.patchState(versionId, { phase: 'completed', doneLineCount: total, totalLineCount: total, failedBatchStart: -1, error: '' });
  }

  private isStale(versionId: string, generation: number): boolean {
    return this.generations.get(versionId) !== generation;
  }

  private assemble(
    version: PoemVersion,
    template: MeterTemplate,
    revision: string,
    batches: AnalysisBatch[],
    totalLineCount: number,
  ): AnalysisSnapshot {
    const lines = batches.flatMap((batch) => batch.lines);
    const issues = AnalysisEngineService.buildIssues(lines, version, template);
    return {
      revision,
      lineFingerprints: lines.map((line) => `${line.index}:${line.cells.map((cell) => cell.char).join('')}`),
      templateId: template.id,
      analyzedAt: new Date().toISOString(),
      text: version.text,
      lines,
      issues,
    };
  }

  // ---------------------------------------------------------------------------
  // 纯分析逻辑（从原 computed 中搬出，供批处理与单测共用）
  // ---------------------------------------------------------------------------

  analyzeBatch(version: PoemVersion, template: MeterTemplate, rawLines: string[], offset: number): AnalysisBatch {
    const lines: AnalysisLine[] = rawLines.map((raw, relative) => {
      const lineIndex = offset + relative;
      const chars = Array.from(raw).filter((char) => !PUNCTUATION.has(char));
      const cells: AnalysisCell[] = chars.map((char, position) => {
        const mark = version.marks[`${lineIndex}:${position}`] ?? defaultMark();
        const expected = template.pattern[lineIndex * template.lineLength + position] ?? '中';
        const actual = mark.tone === '?' ? (TONE_DICTIONARY[char] ?? '?') : mark.tone;
        let status: AnalysisCell['status'] = 'neutral';
        let message = '标点或不计律位置';
        if (actual === '?') {
          status = 'unknown';
          message = '尚未标注平仄';
        } else if (expected === '中') {
          status = 'correct';
          message = '可平可仄';
        } else if (actual === expected) {
          status = 'correct';
          message = '合律';
        } else if (isAcceptableVariant(template, position)) {
          status = 'variant';
          message = '一三五位置的可接受变体';
        } else {
          status = 'error';
          message = `此处应为${expected}声`;
        }
        return { char, position, expected, actual, status, message, mark };
      });
      const rhymeChars = template.rhymeLines.includes(lineIndex) ? cells.slice(-1).map((cell) => cell.char) : [];
      return {
        index: lineIndex,
        cells,
        rhymeChars,
        errors: cells.filter((cell) => cell.status === 'error').length,
        variants: cells.filter((cell) => cell.status === 'variant').length,
      };
    });
    return { startLine: offset, endLine: offset + rawLines.length, lines };
  }

  static buildIssues(lines: AnalysisLine[], version: PoemVersion, template: MeterTemplate): PoemIssue[] {
    const issues: PoemIssue[] = [];
    lines.forEach((line) => {
      line.cells.filter((cell) => cell.status === 'error').forEach((cell) => {
        issues.push({
          id: `issue-${line.index}-${cell.position}`,
          level: 'error',
          title: '出律位置',
          detail: `第 ${line.index + 1} 句“${cell.char}”：${cell.message}`,
          line: line.index,
          position: cell.position,
        });
      });
      if (line.cells.some((cell) => cell.status === 'unknown')) {
        issues.push({
          id: `issue-unknown-${line.index}`,
          level: 'warning',
          title: '存在未标注字',
          detail: `第 ${line.index + 1} 句仍有平仄未确认。`,
          line: line.index,
        });
      }
    });
    const rhymeCells = template.rhymeLines.map((line) => lines.find((item) => item.index === line)?.cells.at(-1)).filter(Boolean);
    const rhymeGroups = new Map<string, string[]>();
    rhymeCells.forEach((cell) => {
      if (!cell) return;
      if (!cell.mark.rhyme) {
        issues.push({
          id: `issue-rhyme-empty-${cell.position}`,
          level: 'warning',
          title: '韵脚缺少韵部',
          detail: `韵脚字“${cell.char}”尚未指定韵部。`,
        });
        return;
      }
      rhymeGroups.set(cell.mark.rhyme, [...(rhymeGroups.get(cell.mark.rhyme) ?? []), cell.char]);
    });
    rhymeGroups.forEach((chars, rhyme) => {
      const duplicate = chars.find((char, index) => chars.indexOf(char) !== index);
      if (duplicate) {
        issues.push({ id: `issue-rhyme-dup-${rhyme}`, level: 'warning', title: '重复用韵', detail: `韵部 ${rhyme} 重复使用末字“${duplicate}”。` });
      }
    });
    if (!issues.some((issue) => issue.level === 'error')) {
      issues.unshift({ id: 'meter-ok', level: 'info', title: '格律检查通过', detail: '当前未发现硬性出律，请继续核对可接受变体。' });
    }
    return issues;
  }

  // ---------------------------------------------------------------------------
  // 检查点持久化（重开从断点继续）
  // ---------------------------------------------------------------------------

  private restore(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, AnalysisCheckpoint>;
      Object.entries(parsed).forEach(([id, checkpoint]) => this.checkpoints.set(id, checkpoint));
    } catch {
      /* 检查点损坏不影响编辑会话 */
    }
  }

  private saveCheckpoint(checkpoint: AnalysisCheckpoint, versionId: string): void {
    this.checkpoints.set(versionId, checkpoint);
    this.persist();
  }

  private persist(): void {
    try {
      const obj: Record<string, AnalysisCheckpoint> = {};
      this.checkpoints.forEach((value, key) => (obj[key] = value));
      localStorage.setItem(this.storageKey, JSON.stringify(obj));
    } catch {
      /* 存储已满时宁可丢检查点，也不阻塞编辑 */
    }
  }

  // ---------------------------------------------------------------------------

  revisionOf(version: PoemVersion, templateId: string): string {
    return `${templateId}::${version.text}::${JSON.stringify(version.marks)}`;
  }

  private yieldTo(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private idleState(versionId: string): AnalysisRunState {
    const checkpoint = this.checkpoints.get(versionId);
    if (checkpoint?.phase === 'failed') {
      return {
        phase: 'failed',
        revision: checkpoint.revision,
        totalLineCount: checkpoint.totalLineCount,
        doneLineCount: checkpoint.doneLineCount,
        failedBatchStart: checkpoint.doneLineCount,
        error: checkpoint.error ?? '分析批次失败',
        queuedVersions: 0,
      };
    }
    return { phase: 'idle', revision: '', totalLineCount: 0, doneLineCount: 0, failedBatchStart: -1, error: '', queuedVersions: 0 };
  }

  private patchState(versionId: string, patch: Partial<AnalysisRunState>): void {
    const state = this.stateSignal(versionId);
    state.set({ ...state(), ...patch });
  }

  private refreshQueueCounts(): void {
    this.runStates.forEach((signal, versionId) => {
      const state = signal();
      if (state.phase === 'queued') {
        signal.set({ ...state, queuedVersions: Math.max(0, this.queue.findIndex((job) => job.versionId === versionId)) });
      }
    });
  }
}

interface QueuedJob {
  versionId: string;
  revision: string;
  template: MeterTemplate;
  startLine: number;
  generation: number;
}

export interface AnalysisWork {
  version: PoemVersion;
  template: MeterTemplate;
}

const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t']);
const TONE_DICTIONARY: Record<string, Tone> = {
  春: '平', 眠: '平', 不: '仄', 觉: '仄', 晓: '仄', 处: '仄', 闻: '平', 啼: '平', 鸟: '仄',
  夜: '仄', 来: '平', 风: '平', 雨: '仄', 声: '平', 花: '平', 落: '仄', 知: '平', 多: '平', 少: '仄',
  国: '仄', 破: '仄', 山: '平', 河: '平', 在: '仄', 城: '平', 深: '平', 木: '仄', 草: '仄', 独: '仄',
  明: '平', 月: '仄', 高: '平', 天: '平', 故: '仄', 乡: '平', 万: '仄', 里: '仄', 江: '平', 船: '平',
};

function defaultMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
}

function isAcceptableVariant(template: MeterTemplate, position: number): boolean {
  if (template.lineLength === 5) return position === 0 || position === 2;
  return position === 0 || position === 2 || position === 4;
}
