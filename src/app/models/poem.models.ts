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

export interface AnalysisCell {
  char: string;
  position: number;
  expected: Tone;
  actual: Tone;
  status: 'correct' | 'variant' | 'error' | 'unknown' | 'neutral';
  message: string;
  /** 指向批次启动时版本快照中的批注对象，保证整版结果不可变 */
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

export interface CharDiff {
  index: number;
  left: string;
  right: string;
  changed: boolean;
}

/** 后台分析批次所处阶段：空闲 / 排队 / 运算 / 已确认整版 / 失败回退 */
export type AnalysisPhase = 'idle' | 'queued' | 'running' | 'complete' | 'failed';

/** 批次启动时冻结的版本快照，正文编辑会话与后台分析从此互不影响 */
export interface VersionSnapshot {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  marks: Record<string, CharacterMark>;
  antithesisPairs: AntithesisPair[];
}

/** 一整版已确认的分析结果，字格、异文对照、校对稿只引用它 */
export interface PublishedAnalysis {
  revision: string;
  fingerprint: string;
  templateId: string;
  confirmedAt: string;
  /** 与快照同序的逐版本逐句结果（句位稀疏，检查点阶段只在已算完处有值） */
  snapshots: VersionSnapshot[];
  results: AnalysisLine[][];
}

export interface AnalysisRunState {
  revision: string;
  phase: AnalysisPhase;
  /** 每个版本快照已算完的句数 */
  confirmedCounts: number[];
  /** 每个版本快照的总句数 */
  totalCounts: number[];
  resumed: boolean;
  queuedAt: number;
  startedAt: number;
  lastError?: string;
}

/** 字格中某一句的展示状态：已确认 / 待分析 / 失败后回退的旧版 */
export type LineViewStatus = 'confirmed' | 'pending' | 'stale';

export interface LineView {
  index: number;
  status: LineViewStatus;
  line: AnalysisLine | null;
  /** 待分析时仍需从编辑会话取本句字符，保证输入与批注不被阻断 */
  liveChars: string[];
}

export interface DiffRow {
  lineIndex: number;
  /** 该句在扁平字符序列中的起始下标 */
  offset: number;
  cells: CharDiff[];
}
