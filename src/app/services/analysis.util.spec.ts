import {
  analyzeLine,
  buildDiffRows,
  buildVersionIssues,
  cellKey,
  charsOfLine,
  computeFingerprint,
  defaultMark,
  isRhymeLine,
  snapshotVersions,
  METER_TEMPLATES,
} from './analysis.util';
import type { PoemWorkspace, VersionSnapshot } from '../models/poem.models';

function makeWorkspace(text: string, marks: Record<string, { tone?: '平' | '仄' | '中' | '?' }> = {}): PoemWorkspace {
  return {
    title: '测试',
    author: '佚名',
    templateId: 'wuyan-zeqi',
    activeVersionId: 'v1',
    updatedAt: '',
    versions: [
      {
        id: 'v1',
        name: '版本一',
        source: '测试来源',
        createdAt: '',
        text,
        marks: Object.fromEntries(
          Object.entries(marks).map(([k, patch]) => [k, { ...defaultMark(), ...patch }]),
        ),
        antithesisPairs: [],
      },
    ],
  };
}

describe('analysis.util', () => {
  const template = METER_TEMPLATES[0];

  it('charsOfLine 去掉标点只留汉字', () => {
    expect(charsOfLine('春眠不觉晓，')).toEqual(['春', '眠', '不', '觉', '晓']);
  });

  it('排律超过四句时模板按四句循环、韵脚在偶句', () => {
    expect(isRhymeLine(template, 1)).toBeTrue();
    expect(isRhymeLine(template, 5)).toBeTrue();
    expect(isRhymeLine(template, 4)).toBeFalse();
  });

  it('analyzeLine 对未标且字典外的字判 unknown', () => {
    const workspace = makeWorkspace('龴龵龶龷龸。');
    const snapshot: VersionSnapshot = snapshotVersions(workspace)[0];
    const line = analyzeLine(snapshot, template, 0);
    expect(line.cells[2].status).toBe('unknown');
  });

  it('analyzeLine 一三五位置与模板不合判可接受变体，二四六位置不合判出律', () => {
    // 模板 wuyan-zeqi 首句：仄仄中平仄
    const workspace = makeWorkspace('龴龵龶龷龸。', {
      [cellKey(0, 0)]: { tone: '平' }, // 第一字（一位置）模板仄，标平 → 可接受变体
      [cellKey(0, 1)]: { tone: '平' }, // 第二字（二位置）模板仄，标平 → 出律
    });
    const snapshot: VersionSnapshot = snapshotVersions(workspace)[0];
    const line = analyzeLine(snapshot, template, 0);
    expect(line.cells[0].status).toBe('variant');
    expect(line.cells[1].status).toBe('error');
  });

  it('重复用韵会产生 warning，无出律且全部已标时首条为通过信息', () => {
    // 模板 wuyan-zeqi: 仄仄中平仄 / 中平中仄仄 / 中平中仄仄 / 中平中仄平
    // 每字都按模板标好声调，仅在韵脚（二、四句）重复使用同一韵部同字
    const tonesByLine: ('平' | '仄' | '中')[][] = [
      ['仄', '仄', '中', '平', '仄'],
      ['中', '平', '中', '仄', '仄'],
      ['中', '平', '中', '仄', '仄'],
      ['中', '平', '中', '仄', '平'],
    ];
    const text = '甲乙丙丁戊，\n己庚辛壬癸。\n子丑寅卯辰，\n巳午未申癸。'; // 二、四两句末字均为“癸”
    const marks = {} as Record<string, { tone: '平' | '仄' | '中'; rhyme: string }>;
    tonesByLine.forEach((tones, line) => {
      tones.forEach((tone, position) => {
        marks[cellKey(line, position)] = { tone, rhyme: '' };
      });
    });
    marks[cellKey(1, 4)] = { tone: '仄', rhyme: 'A' };
    marks[cellKey(3, 4)] = { tone: '平', rhyme: 'A' };
    const snapshot: VersionSnapshot = snapshotVersions(makeWorkspace(text, marks))[0];
    const lines = snapshot.text.split('\n').map((_, index) => analyzeLine(snapshot, template, index));
    const issues = buildVersionIssues(lines, template, []);
    expect(issues.some((issue) => issue.title === '重复用韵')).toBeTrue();
    expect(issues[0].title).toBe('格律检查通过');
  });

  it('buildDiffRows 按句对齐并给出全局 offset', () => {
    const left: VersionSnapshot = {
      id: 'a', name: 'a', source: '', createdAt: '', text: '春眠不觉晓\n处处闻啼鸟',
      marks: {}, antithesisPairs: [],
    };
    const right: VersionSnapshot = {
      id: 'b', name: 'b', source: '', createdAt: '', text: '春眠不觉晓\n处处闻鸣鸟',
      marks: {}, antithesisPairs: [],
    };
    const rows = buildDiffRows(left, right);
    expect(rows.length).toBe(2);
    expect(rows[1].offset).toBe(5);
    // “处处闻啼鸟”：处(0)处(1)闻(2)啼(3)鸟(4)，“啼”在下标 3，右文改为“鸣”
    expect(rows[1].cells[3].left).toBe('啼');
    expect(rows[1].cells[3].right).toBe('鸣');
    expect(rows[1].cells[3].changed).toBeTrue();
    expect(rows[0].cells.every((cell) => !cell.changed)).toBeTrue();
  });

  it('指纹在正文或批注变化时改变，无关字段变化时保持稳定', () => {
    const workspace = makeWorkspace('春眠不觉晓');
    const f1 = computeFingerprint(workspace);
    const changed = { ...workspace, title: '新标题' };
    expect(computeFingerprint(changed)).toBe(f1);
    const textChanged = { ...workspace, versions: [{ ...workspace.versions[0], text: '春眠不觉晚' }] };
    expect(computeFingerprint(textChanged)).not.toBe(f1);
  });

  it('快照是深冻结：之后修改工作区不影响已算结果', () => {
    const workspace = makeWorkspace('春眠不觉晓');
    const snapshot: VersionSnapshot = snapshotVersions(workspace)[0];
    workspace.versions[0].text = 'XXXXXXXXX';
    workspace.versions[0].marks[cellKey(0, 0)] = { ...defaultMark(), tone: '仄' };
    const line = analyzeLine(snapshot, template, 0);
    expect(line.cells.map((cell) => cell.char).join('')).toBe('春眠不觉晓');
    expect(line.cells[0].mark.tone).toBe('?');
  });
});
