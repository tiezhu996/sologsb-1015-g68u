import type {
  AnalysisCell,
  AnalysisLine,
  AntithesisPair,
  CharacterMark,
  CharDiff,
  DiffRow,
  MeterTemplate,
  PoemIssue,
  PoemVersion,
  PoemWorkspace,
  Tone,
  VersionSnapshot,
} from '../models/poem.models';

export const METER_TEMPLATES: MeterTemplate[] = [
  {
    id: 'wuyan-zeqi',
    name: '五言绝句 · 仄起首句不入韵',
    summary: '四句一组，每句五字；二、四句押韵（排律循环展开）',
    lineCount: 4,
    lineLength: 5,
    pattern: ['仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
  {
    id: 'wuyan-pingqi',
    name: '五言绝句 · 平起首句入韵',
    summary: '四句一组，每句五字；一、二、四句押韵（排律循环展开）',
    lineCount: 4,
    lineLength: 5,
    pattern: ['中', '平', '中', '仄', '平', '仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '仄', '中', '平'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-zeqi',
    name: '七言绝句 · 仄起首句入韵',
    summary: '四句一组，每句七字；一、二、四句押韵（排律循环展开）',
    lineCount: 4,
    lineLength: 7,
    pattern: ['仄', '仄', '中', '平', '中', '仄', '平', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-pingqi',
    name: '七言绝句 · 平起首句不入韵',
    summary: '四句一组，每句七字；二、四句押韵（排律循环展开）',
    lineCount: 4,
    lineLength: 7,
    pattern: ['中', '平', '中', '仄', '仄', '中', '平', '仄', '仄', '中', '平', '平', '仄', '仄', '中', '平', '中', '仄', '中', '平', '仄', '仄', '中', '平', '中', '仄', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
];

export const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t', '—', '「', '」', '『', '』', '（', '）']);

export const TONE_DICTIONARY: Record<string, Tone> = {
  春: '平', 眠: '平', 不: '仄', 觉: '仄', 晓: '仄', 处: '仄', 闻: '平', 啼: '平', 鸟: '仄',
  夜: '仄', 来: '平', 风: '平', 雨: '仄', 声: '平', 花: '平', 落: '仄', 知: '平', 多: '平', 少: '仄',
  国: '仄', 破: '仄', 山: '平', 河: '平', 在: '仄', 城: '平', 深: '平', 木: '仄', 草: '仄', 独: '仄',
  明: '平', 月: '仄', 高: '平', 天: '平', 故: '仄', 乡: '平', 万: '仄', 里: '仄', 江: '平', 船: '平',
};

export function cellKey(line: number, position: number): string {
  return `${line}:${position}`;
}

export function defaultMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
}

/** 去掉标点后的句中文字 */
export function charsOfLine(line: string): string[] {
  return Array.from(line).filter((char) => !PUNCTUATION.has(char));
}

export function splitLines(text: string): string[] {
  return text.split('\n');
}

/** 排律可超过四句，模板以四句为一组循环，韵脚落在偶句 */
export function isRhymeLine(template: MeterTemplate, lineIndex: number): boolean {
  return template.rhymeLines.includes(lineIndex % template.lineCount);
}

function expectedTone(template: MeterTemplate, lineIndex: number, position: number): Tone {
  const cycle = lineIndex % template.lineCount;
  return template.pattern[cycle * template.lineLength + position] ?? '中';
}

function isAcceptableVariant(template: MeterTemplate, position: number): boolean {
  if (template.lineLength === 5) return position === 0 || position === 2;
  return position === 0 || position === 2 || position === 4;
}

/**
 * 单句分析：纯函数。marks 取自批次启动时冻结的版本快照，
 * 正文编辑会话之后怎么改都不会影响这一版结果。
 */
export function analyzeLine(snapshot: VersionSnapshot, template: MeterTemplate, lineIndex: number): AnalysisLine {
  const rawLine = splitLines(snapshot.text)[lineIndex] ?? '';
  const chars = charsOfLine(rawLine);
  const cells: AnalysisCell[] = chars.map((char, position) => {
    // 冻结快照中的批注对象，调用方拿到的是批次确认时的定版内容
    const mark: CharacterMark = { ...(snapshot.marks[cellKey(lineIndex, position)] ?? defaultMark()) };
    const expected = expectedTone(template, lineIndex, position);
    const actual = mark.tone === '?' ? (TONE_DICTIONARY[char] ?? '?') : mark.tone;
    let status: AnalysisCell['status'];
    let message: string;
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
  const rhymeChars = isRhymeLine(template, lineIndex) ? cells.slice(-1).map((cell) => cell.char) : [];
  return {
    index: lineIndex,
    cells,
    rhymeChars,
    errors: cells.filter((cell) => cell.status === 'error').length,
    variants: cells.filter((cell) => cell.status === 'variant').length,
  };
}

export function analyzeVersion(snapshot: VersionSnapshot, template: MeterTemplate): AnalysisLine[] {
  const lineCount = splitLines(snapshot.text).length;
  return Array.from({ length: lineCount }, (_, lineIndex) => analyzeLine(snapshot, template, lineIndex));
}

let issueSeq = 0;
function issueId(): string {
  issueSeq += 1;
  return `issue-${Date.now().toString(36)}-${issueSeq}`;
}

/** 由一整版结果汇总问题；只对已确认的整版结果调用，避免半批次结论外显 */
export function buildVersionIssues(lines: AnalysisLine[], template: MeterTemplate, antithesisPairs: AntithesisPair[]): PoemIssue[] {
  const issues: PoemIssue[] = [];
  lines.forEach((line) => {
    line.cells.filter((cell) => cell.status === 'error').forEach((cell) => {
      issues.push({
        id: issueId(),
        level: 'error',
        title: '出律位置',
        detail: `第 ${line.index + 1} 句“${cell.char}”：${cell.message}`,
        line: line.index,
        position: cell.position,
      });
    });
    if (line.cells.some((cell) => cell.status === 'unknown')) {
      issues.push({ id: issueId(), level: 'warning', title: '存在未标注字', detail: `第 ${line.index + 1} 句仍有平仄未确认。`, line: line.index });
    }
  });

  const rhymeGroups = new Map<string, { char: string; line: number }[]>();
  lines.forEach((line) => {
    if (!isRhymeLine(template, line.index)) return;
    const cell = line.cells.at(-1);
    if (!cell) return;
    if (!cell.mark.rhyme) {
      issues.push({ id: issueId(), level: 'warning', title: '韵脚缺少韵部', detail: `第 ${line.index + 1} 句末字“${cell.char}”尚未指定韵部。`, line: line.index });
      return;
    }
    const group = rhymeGroups.get(cell.mark.rhyme) ?? [];
    group.push({ char: cell.char, line: line.index });
    rhymeGroups.set(cell.mark.rhyme, group);
  });
  rhymeGroups.forEach((entries, rhyme) => {
    const duplicate = entries.find((entry, index) => entries.findIndex((other) => other.char === entry.char) !== index);
    if (duplicate) {
      issues.push({ id: issueId(), level: 'warning', title: '重复用韵', detail: `韵部 ${rhyme} 重复使用末字“${duplicate.char}”（第 ${duplicate.line + 1} 句）。`, line: duplicate.line });
    }
  });

  if (antithesisPairs.length === 0) {
    issues.push({ id: 'antithesis-empty', level: 'info', title: '尚未标记对仗', detail: '可在检视器中把两句建立对仗关系。' });
  }
  if (!issues.some((issue) => issue.level === 'error')) {
    issues.unshift({ id: 'meter-ok', level: 'info', title: '格律检查通过', detail: '当前已确认版本未发现硬性出律，请继续核对可接受变体。' });
  }
  return issues;
}

/** 按句对齐的异文对照，行内保留下标点，跨行以 offset 串成全局字符序号 */
export function buildDiffRows(left: VersionSnapshot, right: VersionSnapshot): DiffRow[] {
  const leftLines = splitLines(left.text);
  const rightLines = splitLines(right.text);
  const size = Math.max(leftLines.length, rightLines.length);
  const rows: DiffRow[] = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < size; lineIndex += 1) {
    const leftChars = Array.from(leftLines[lineIndex] ?? '');
    const rightChars = Array.from(rightLines[lineIndex] ?? '');
    const length = Math.max(leftChars.length, rightChars.length);
    const cells: CharDiff[] = Array.from({ length }, (_, index) => ({
      index: offset + index,
      left: leftChars[index] ?? '',
      right: rightChars[index] ?? '',
      changed: leftChars[index] !== rightChars[index],
    }));
    rows.push({ lineIndex, offset, cells });
    offset += length;
  }
  return rows;
}

/** 冻结工作区中的版本，供后台批次在不打扰编辑会话的前提下运算 */
export function snapshotVersions(workspace: PoemWorkspace): VersionSnapshot[] {
  return workspace.versions.map((version: PoemVersion) => ({
    id: version.id,
    name: version.name,
    source: version.source,
    createdAt: version.createdAt,
    text: version.text,
    marks: structuredClone(version.marks),
    antithesisPairs: structuredClone(version.antithesisPairs),
  }));
}

/**
 * 正文 / 批注 / 模板任一影响分析结论的字段都进入指纹。
 * 指纹相同则不重排批次；批次恢复时也靠它辨认检查点是否仍对应当前正文。
 */
export function computeFingerprint(workspace: PoemWorkspace): string {
  const payload = JSON.stringify({
    t: workspace.templateId,
    v: workspace.versions.map((version) => [
      version.id,
      version.name,
      version.source,
      version.text,
      version.marks,
      version.antithesisPairs,
    ]),
  });
  let hash = 5381;
  for (let i = 0; i < payload.length; i += 1) {
    hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
