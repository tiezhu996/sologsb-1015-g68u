import { Injectable, OnDestroy, signal } from '@angular/core';
import type {
  AnalysisCell,
  AnalysisLine,
  AnalysisRunState,
  CharacterMark,
  MeterTemplate,
  PoemWorkspace,
  PublishedAnalysis,
  VersionSnapshot,
} from '../models/poem.models';
import {
  METER_TEMPLATES,
  analyzeLine,
  cellKey,
  computeFingerprint,
  defaultMark,
  snapshotVersions,
} from './analysis.util';

const ANALYSIS_STORAGE_KEY = 'sologsb-1015-analysis-v2';
/** 超长正文按句切批，每批处理的句数 */
const BATCH_LINES = 36;
/** 停止输入多久后才启动新批次，保证编辑会话不会被即时重算拖住 */
const QUIET_MS = 350;

interface BatchJob {
  versionIndex: number;
  lineIndex: number;
}

/** 检查点：批次中途的断点，重开页面后从这里继续 */
interface Checkpoint {
  revision: string;
  fingerprint: string;
  templateId: string;
  queuedAt: number;
  startedAt: number;
  resumed: boolean;
  snapshots: VersionSnapshot[];
  /** 稀疏数组：已完成的句位上才有 AnalysisLine */
  results: AnalysisLine[][];
}

interface PersistedShape {
  published: (PublishedAnalysis & { snapshotRef?: string }) | null;
  checkpoint: (Omit<Checkpoint, 'snapshots'> & { snapshotRef?: string }) | null;
  snapshots: Record<string, VersionSnapshot[]>;
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const yieldFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const lineCountOf = (snapshot: VersionSnapshot) => snapshot.text.split('\n').length;

@Injectable({ providedIn: 'root' })
export class AnalysisService implements OnDestroy {
  /** 当前批次状态（排队 / 运算 / 已确认 / 失败回退） */
  readonly runState = signal<AnalysisRunState | null>(null);
  /** 最近一整版已确认结果；字格、异文、校对稿只允许引用它或检查点中已算完的段落 */
  readonly published = signal<PublishedAnalysis | null>(null);
  /** 正在运算的检查点，仅用于进度与校对稿“已算完段落”，字格不展示半成品 */
  readonly checkpoint = signal<Checkpoint | null>(null);

  /** 测试钩子：成功提交一个批次后，下一个批次开始时抛错，用于验证失败回退与检查点恢复 */
  failNextBatch = false;

  private currentToken = 0;
  private jobs: BatchJob[] = [];
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;

  constructor() {
    this.restore();
  }

  ngOnDestroy(): void {
    // 服务销毁（如测试上下文结束）后，排队定时器与在跑批次都不得再写状态或本地存储
    this.currentToken += 1;
    this.jobs.length = 0;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /**
   * 正文编辑会话每次提交后调用。
   * - 指纹相同：不重排；
   * - 指纹变化：正在运行 / 排队的批次立即作废（检查点同步丢弃），新批次静默期后启动；
   * - 输入与批注不被阻断，本方法本身只做轻量指纹计算。
   */
  contentChanged(workspace: PoemWorkspace): void {
    const fingerprint = computeFingerprint(workspace);
    if (this.published()?.fingerprint === fingerprint) {
      this.ensureCompleteState(fingerprint);
      return;
    }
    const checkpoint = this.checkpoint();
    const phase = this.runState()?.phase;
    // 同一版内容的排队 / 运算 / 失败（等待手动从检查点继续）不重复排队
    if (checkpoint?.fingerprint === fingerprint && phase !== undefined && phase !== 'complete' && phase !== 'idle') {
      return;
    }

    // 编辑中的批次结果立即作废
    this.currentToken += 1;
    this.jobs.length = 0;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (checkpoint) {
      this.checkpoint.set(null);
      this.persist();
    }

    const revision = uid('rev');
    const totalCounts = workspace.versions.map((version) => version.text.split('\n').length);
    this.runState.set({
      revision,
      phase: 'queued',
      confirmedCounts: totalCounts.map(() => 0),
      totalCounts,
      resumed: false,
      queuedAt: Date.now(),
      startedAt: 0,
    });

    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.startFresh(workspace, fingerprint, revision);
    }, QUIET_MS);
  }

  /** 失败或重开后，从检查点继续未完成的批次 */
  resume(): void {
    const checkpoint = this.checkpoint();
    const state = this.runState();
    if (!checkpoint || !state) return;
    if (state.phase === 'running') return;

    this.currentToken += 1;
    const token = this.currentToken;
    checkpoint.resumed = true;
    checkpoint.startedAt = Date.now();
    this.enqueueRemaining(checkpoint);
    this.refreshState(checkpoint, 'running');
    void this.drain(checkpoint, token);
  }

  overallPercent(state: AnalysisRunState | null): number {
    if (!state) return 0;
    const done = state.confirmedCounts.reduce((sum, value) => sum + value, 0);
    const total = state.totalCounts.reduce((sum, value) => sum + value, 0);
    return total === 0 ? 0 : Math.round((done / total) * 100);
  }

  // ---- 批次调度 ----------------------------------------------------------

  private startFresh(workspace: PoemWorkspace, fingerprint: string, revision: string): void {
    const token = this.currentToken;
    const queuedAt = this.runState()?.queuedAt ?? Date.now();
    const checkpoint: Checkpoint = {
      revision,
      fingerprint,
      templateId: workspace.templateId,
      queuedAt,
      startedAt: Date.now(),
      resumed: false,
      snapshots: snapshotVersions(workspace),
      results: workspace.versions.map(() => []),
    };
    this.checkpoint.set(checkpoint);
    this.enqueueRemaining(checkpoint);
    this.refreshState(checkpoint, 'running');
    this.persist();
    void this.drain(checkpoint, token);
  }

  private enqueueRemaining(checkpoint: Checkpoint): void {
    this.jobs.length = 0;
    checkpoint.snapshots.forEach((snapshot, versionIndex) => {
      const total = lineCountOf(snapshot);
      for (let lineIndex = 0; lineIndex < total; lineIndex += 1) {
        if (!checkpoint.results[versionIndex]?.[lineIndex]) {
          this.jobs.push({ versionIndex, lineIndex });
        }
      }
    });
  }

  private async drain(checkpoint: Checkpoint, token: number): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const template = METER_TEMPLATES.find((item) => item.id === checkpoint.templateId) ?? METER_TEMPLATES[0];
    let completedBatches = 0;
    try {
      while (this.currentToken === token) {
        const batch = this.jobs.splice(0, BATCH_LINES);
        if (batch.length === 0) break;
        // 把批次让到事件循环之后，编辑输入优先
        await yieldFrame();
        if (this.currentToken !== token) return;

        // 至少成功提交一批后再模拟失败，保证检查点里留有已算完段落
        if (this.failNextBatch && completedBatches > 0) {
          this.failNextBatch = false;
          throw new Error(`第 ${this.doneCount(checkpoint) + 1} 句所在批次处理失败`);
        }

        for (const job of batch) {
          checkpoint.results[job.versionIndex][job.lineIndex] = analyzeLine(
            checkpoint.snapshots[job.versionIndex],
            template,
            job.lineIndex,
          );
        }
        this.refreshState(checkpoint, 'running');
        this.persist();
        completedBatches += 1;
        await yieldFrame();
      }

      if (this.currentToken !== token) return;
      const allDone = checkpoint.snapshots.every(
        (snapshot, versionIndex) => checkpoint.results[versionIndex].filter(Boolean).length === lineCountOf(snapshot),
      );
      if (allDone) this.publish(checkpoint);
    } catch (error) {
      if (this.currentToken !== token) return;
      // 失败：保留检查点，已确认的上一整版结果继续可读，等待从检查点继续
      this.jobs.length = 0;
      const message = error instanceof Error ? error.message : '后台分析批次失败';
      this.runState.update((state) => (state ? { ...state, phase: 'failed', lastError: message } : state));
    } finally {
      this.draining = false;
    }
  }

  private publish(checkpoint: Checkpoint): void {
    const published: PublishedAnalysis = {
      revision: checkpoint.revision,
      fingerprint: checkpoint.fingerprint,
      templateId: checkpoint.templateId,
      confirmedAt: new Date().toISOString(),
      snapshots: checkpoint.snapshots,
      results: checkpoint.results,
    };
    this.published.set(published);
    this.checkpoint.set(null);
    this.runState.set({
      revision: checkpoint.revision,
      phase: 'complete',
      confirmedCounts: checkpoint.snapshots.map((snapshot) => lineCountOf(snapshot)),
      totalCounts: checkpoint.snapshots.map((snapshot) => lineCountOf(snapshot)),
      resumed: checkpoint.resumed,
      queuedAt: checkpoint.queuedAt,
      startedAt: checkpoint.startedAt,
    });
    this.persist();
  }

  private refreshState(checkpoint: Checkpoint, phase: AnalysisRunState['phase']): void {
    this.runState.set({
      revision: checkpoint.revision,
      phase,
      confirmedCounts: checkpoint.results.map((lines) => lines.filter(Boolean).length),
      totalCounts: checkpoint.snapshots.map((snapshot) => lineCountOf(snapshot)),
      resumed: checkpoint.resumed,
      queuedAt: checkpoint.queuedAt,
      startedAt: checkpoint.startedAt,
    });
  }

  private ensureCompleteState(fingerprint: string): void {
    const published = this.published();
    const state = this.runState();
    if (published && (!state || state.phase !== 'complete' || state.revision !== published.revision)) {
      this.currentToken += 1;
      if (this.startTimer) clearTimeout(this.startTimer);
      if (this.checkpoint()) {
        this.checkpoint.set(null);
        this.persist();
      }
      this.runState.set({
        revision: published.revision,
        phase: 'complete',
        confirmedCounts: published.snapshots.map((snapshot) => lineCountOf(snapshot)),
        totalCounts: published.snapshots.map((snapshot) => lineCountOf(snapshot)),
        resumed: false,
        queuedAt: 0,
        startedAt: 0,
      });
    }
  }

  private doneCount(checkpoint: Checkpoint): number {
    return checkpoint.results.reduce((sum, lines) => sum + lines.filter(Boolean).length, 0);
  }

  // ---- 检查点持久化 ------------------------------------------------------

  private persist(): void {
    try {
      const published = this.published();
      const checkpoint = this.checkpoint();
      const snapshotPool: Record<string, VersionSnapshot[]> = {};
      if (published) snapshotPool[published.fingerprint] = published.snapshots;
      if (checkpoint) snapshotPool[checkpoint.fingerprint] = checkpoint.snapshots;

      const payload: PersistedShape = {
        published: published
          ? { ...published, snapshots: [], snapshotRef: published.fingerprint }
          : null,
        checkpoint: checkpoint
          ? {
              revision: checkpoint.revision,
              fingerprint: checkpoint.fingerprint,
              templateId: checkpoint.templateId,
              queuedAt: checkpoint.queuedAt,
              startedAt: checkpoint.startedAt,
              resumed: checkpoint.resumed,
              results: this.stripMarks(checkpoint.results),
              snapshotRef: checkpoint.fingerprint,
            }
          : null,
        snapshots: snapshotPool,
      };
      localStorage.setItem(ANALYSIS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // 持久化失败（如配额不足）不影响编辑会话，也不算批次失败
    }
  }

  private restore(): void {
    let payload: PersistedShape | null = null;
    try {
      const raw = localStorage.getItem(ANALYSIS_STORAGE_KEY);
      if (raw) payload = JSON.parse(raw) as PersistedShape;
    } catch {
      payload = null;
    }
    if (!payload) return;

    let published: PublishedAnalysis | null = null;
    if (payload.published && payload.published.snapshotRef && payload.snapshots[payload.published.snapshotRef]) {
      const snapshots = payload.snapshots[payload.published.snapshotRef];
      const results = this.hydrateMarks(payload.published.results, snapshots);
      const { snapshotRef: _ref, ...publishedFields } = payload.published;
      published = { ...publishedFields, snapshots, results };
      this.published.set(published);
    }

    if (payload.checkpoint && payload.checkpoint.snapshotRef && payload.snapshots[payload.checkpoint.snapshotRef]) {
      const snapshots = payload.snapshots[payload.checkpoint.snapshotRef];
      const checkpoint: Checkpoint = {
        revision: payload.checkpoint.revision,
        fingerprint: payload.checkpoint.fingerprint,
        templateId: payload.checkpoint.templateId,
        queuedAt: payload.checkpoint.queuedAt,
        startedAt: payload.checkpoint.startedAt,
        resumed: true,
        snapshots,
        results: this.hydrateMarks(payload.checkpoint.results, snapshots),
      };
      this.checkpoint.set(checkpoint);
      // 重开即从检查点继续
      this.currentToken += 1;
      const token = this.currentToken;
      this.enqueueRemaining(checkpoint);
      this.refreshState(checkpoint, 'running');
      setTimeout(() => void this.drain(checkpoint, token), 0);
    } else if (published) {
      this.runState.set({
        revision: published.revision,
        phase: 'complete',
        confirmedCounts: published.snapshots.map((snapshot) => lineCountOf(snapshot)),
        totalCounts: published.snapshots.map((snapshot) => lineCountOf(snapshot)),
        resumed: false,
        queuedAt: 0,
        startedAt: 0,
      });
    }
  }

  /** 持久化时剥离逐格复制的批注，批注以快照版本为唯一来源，避免存储成倍膨胀 */
  private stripMarks(results: AnalysisLine[][]): AnalysisLine[][] {
    return results.map((versionLines) =>
      versionLines.reduce<AnalysisLine[]>((acc, line: AnalysisLine | undefined) => {
        if (line) {
          acc[line.index] = {
            ...line,
            cells: line.cells.map((cell) => {
              const { mark: _mark, ...rest } = cell;
              return rest as AnalysisCell;
            }),
          };
        }
        return acc;
      }, []),
    );
  }

  private hydrateMarks(results: AnalysisLine[][], snapshots: VersionSnapshot[]): AnalysisLine[][] {
    return results.map((versionLines, versionIndex) =>
      (versionLines ?? [])
        .filter(Boolean)
        .reduce<AnalysisLine[]>((acc, line) => {
          const marks = snapshots[versionIndex]?.marks ?? {};
          acc[line.index] = {
            ...line,
            cells: line.cells.map((cell) => {
              const mark: CharacterMark = { ...(marks[cellKey(line.index, cell.position)] ?? defaultMark()) };
              return { ...cell, mark };
            }),
          };
          return acc;
        }, []),
    );
  }
}
