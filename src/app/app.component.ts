import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzBadgeModule } from 'ng-zorro-antd/badge';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDividerModule } from 'ng-zorro-antd/divider';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { METER_TEMPLATES, PoetryStoreService } from './services/poetry-store.service';
import type { LineView } from './models/poem.models';
import { VirtualListComponent } from './shared/virtual-list.component';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    NzAlertModule,
    NzBadgeModule,
    NzButtonModule,
    NzDividerModule,
    NzEmptyModule,
    NzInputModule,
    NzProgressModule,
    NzSelectModule,
    NzSwitchModule,
    NzTabsModule,
    NzTagModule,
    NzToolTipModule,
    VirtualListComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly store = inject(PoetryStoreService);
  readonly templates = METER_TEMPLATES;

  private readonly meterList = viewChild<VirtualListComponent<LineView>>('meterList');
  private readonly diffList = viewChild<VirtualListComponent<unknown>>('diffList');

  readonly selectedCell = computed(() => this.store.selectedCellView());
  readonly totalErrors = computed(() => (this.store.confirmedIssues() ?? []).filter((issue) => issue.level === 'error').length);
  readonly totalWarnings = computed(() => (this.store.confirmedIssues() ?? []).filter((issue) => issue.level === 'warning').length);
  readonly checkedRate = computed(() => this.store.liveMarkedRate());

  readonly runState = computed(() => this.store.runState());
  readonly stale = computed(() => this.store.analysisStale());
  readonly confirmedRevision = computed(() => this.store.published()?.revision.slice(-6) ?? '');

  readonly meterItemHeight = 118;
  readonly diffItemHeight = 96;
  readonly issueItemHeight = 62;

  constructor() {
    // 键盘巡校时把选中句滚入视口
    effect(() => {
      const line = this.store.selectedLine();
      this.meterList()?.ensureIndexVisible(line);
    });
    effect(() => {
      const row = this.store.currentDiffRowIndex();
      if (row >= 0) this.diffList()?.ensureIndexVisible(row);
    });
  }

  batchPercent(): number {
    const state = this.runState();
    if (!state) return 0;
    const done = state.confirmedCounts.reduce((sum, value) => sum + value, 0);
    const total = state.totalCounts.reduce((sum, value) => sum + value, 0);
    return total === 0 ? 0 : Math.round((done / total) * 100);
  }

  batchDoneLines(): number {
    return this.runState()?.confirmedCounts.reduce((sum, value) => sum + value, 0) ?? 0;
  }

  batchTotalLines(): number {
    return this.runState()?.totalCounts.reduce((sum, value) => sum + value, 0) ?? 0;
  }

  setTone(tone: '平' | '仄' | '中' | '?'): void {
    this.store.setMark({ tone });
  }

  updateSource(source: string): void {
    this.store.setMark({ basis: source });
  }

  updateVersionSource(source: string): void {
    this.store.updateVersionSource(source);
  }

  trackTemplate(index: number, item: (typeof METER_TEMPLATES)[number]): string {
    return item.id;
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const inTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.getAttribute('contenteditable') === 'true';
    const command = event.ctrlKey || event.metaKey;

    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.store.redo() : this.store.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.store.redo();
      return;
    }
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.store.toast.set('内容已保存在本机');
      return;
    }
    if (inTextEntry) return;

    const views = this.store.lineViews();
    const lineLength = (index: number) => views[index]?.liveChars.length ?? 1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = Math.max(0, this.store.selectedPosition() - 1);
      this.store.selectCell(this.store.selectedLine(), next);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = Math.min(Math.max(0, lineLength(this.store.selectedLine()) - 1), this.store.selectedPosition() + 1);
      this.store.selectCell(this.store.selectedLine(), next);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, this.store.selectedLine() - 1);
      this.store.selectCell(next, Math.min(this.store.selectedPosition(), Math.max(0, lineLength(next) - 1)));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.min(views.length - 1, this.store.selectedLine() + 1);
      this.store.selectCell(next, Math.min(this.store.selectedPosition(), Math.max(0, lineLength(next) - 1)));
    } else if (event.key === '1') {
      this.setTone('平');
    } else if (event.key === '2') {
      this.setTone('仄');
    } else if (event.key === '3') {
      this.setTone('中');
    } else if (event.key === ' ') {
      event.preventDefault();
      this.store.togglePause();
    } else if (event.key.toLowerCase() === 'r') {
      this.store.cycleRhyme();
    }
  }
}
