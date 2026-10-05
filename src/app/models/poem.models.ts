export type Tone = '平' | '仄' | '中' | '?';
export type MarkTone = '平' | '仄' | '中';

export interface CharacterMark {
  tone: MarkTone | '?';
  rhyme: string;
  pauseAfter: boolean;
  basis: string;
  note: string;
}

export interface PoemVersion {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  marks: Record<string, CharacterMark>;
  antithesisPairs: AntithesisPair[];
}

export interface AntithesisPair {
  id: string;
  leftLine: number;
  rightLine: number;
  note: string;
}

export interface PoemWorkspace {
  title: string;
  author: string;
  templateId: string;
  versions: PoemVersion[];
  activeVersionId: string;
  updatedAt: string;
}

export interface MeterTemplate {
  id: string;
  name: string;
  summary: string;
  lineCount: number;
  lineLength: number;
  pattern: Tone[];
  rhymeLines: number[];
}

/** 单格状态：analyzed 系列来自已确认分析版本，pending 表示该段落尚未分析。 */
export type CellStatus = 'correct' | 'variant' | 'error' | 'unknown' | 'neutral' | 'pending';

export interface AnalysisCell {
  char: string;
  position: number;
  expected: Tone;
  actual: Tone;
  status: CellStatus;
  message: string;
  mark: CharacterMark;
}

export interface AnalysisLine {
  index: number;
  cells: AnalysisCell[];
  rhymeChars: string[];
  errors: number;
  variants: number;
}

export interface PoemIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  line?: number;
  position?: number;
}

/** 异文逐字格：整行同属一次已确认版本，未确认一侧留空。 */
export interface DiffCell {
  left: string;
  right: string;
  changed: boolean;
}

export interface DiffLine {
  line: number;
  left: string;
  right: string;
  changed: boolean;
  cells: DiffCell[];
}

/**
 * 分析版本（不可变快照）。
 * 字格与异文对照都只读取同一个已确认版本，绝不在编辑过程中混入中间结果。
 */
export interface AnalysisSnapshot {
  /** 被分析版本的内容指纹（正文 + 标记 + 模板）。 */
  revision: string;
  /** 逐行内容指纹，导出校对稿时据此判定段落是否属于本次确认结果。 */
  lineFingerprints: string[];
  templateId: string;
  analyzedAt: string;
  text: string;
  lines: AnalysisLine[];
  issues: PoemIssue[];
}

/** 后台分析批次的运行状态，与正文编辑会话完全隔离。 */
export type AnalysisPhase = 'idle' | 'queued' | 'running' | 'completed' | 'failed';

/** 一个版本对应一份检查点：已完成的批次结果可在重开或失败后续跑。 */
export interface AnalysisCheckpoint {
  revision: string;
  templateId: string;
  /** 已完成批次（按起始行索引排序）。 */
  batches: AnalysisBatch[];
  /** 已完成的最大行索引（不含）。 */
  doneLineCount: number;
  totalLineCount: number;
  phase: AnalysisPhase;
  error?: string;
  updatedAt: string;
}

export interface AnalysisBatch {
  startLine: number;
  endLine: number;
  lines: AnalysisLine[];
}

/** 暴露给界面的批次运行视图。 */
export interface AnalysisRunState {
  phase: AnalysisPhase;
  revision: string;
  totalLineCount: number;
  doneLineCount: number;
  failedBatchStart: number;
  error: string;
  /** 队列中排在当前版本之后的版本数。 */
  queuedVersions: number;
}
