import {
  AfterViewInit,
  Component,
  ElementRef,
  TemplateRef,
  ViewChild,
  computed,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

/**
 * 固定行高的轻量虚拟列表：两千句只渲染视口附近的行，
 * 输入时变更检测不再遍历整篇字格。
 */
@Component({
  selector: 'app-virtual-list',
  imports: [NgTemplateOutlet],
  template: `
    <div class="virtual-viewport" #viewport (scroll)="onScroll()">
      <div class="virtual-spacer" [style.height.px]="totalHeight()">
        @if (itemHeight() > 0 && itemTemplate()) {
          @for (item of visible(); track $index) {
            <div
              class="virtual-item"
              [style.height.px]="itemHeight()"
              [style.transform]="'translateY(' + (startIndex() * itemHeight() + $index * itemHeight()) + 'px)'"
            >
              <ng-container
                [ngTemplateOutlet]="itemTemplate()!"
                [ngTemplateOutletContext]="{ $implicit: item, index: startIndex() + $index }"
              ></ng-container>
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; height: 100%; }
      .virtual-viewport { position: relative; height: 100%; overflow-y: auto; overscroll-behavior: contain; }
      .virtual-spacer { position: relative; width: 100%; }
      .virtual-item { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
    `,
  ],
})
export class VirtualListComponent<T> implements AfterViewInit {
  readonly items = input<T[]>([]);
  readonly itemHeight = input(0);
  readonly itemTemplate = input<TemplateRef<unknown> | null>(null);
  readonly overscan = input(8);

  @ViewChild('viewport', { static: true }) viewportRef?: ElementRef<HTMLElement>;

  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(600);
  private resizeObserver: ResizeObserver | null = null;

  readonly totalHeight = computed(() => this.items().length * this.itemHeight());
  readonly startIndex = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / this.itemHeight()) - this.overscan()),
  );
  readonly endIndex = computed(() =>
    Math.min(
      this.items().length,
      Math.ceil((this.scrollTop() + this.viewportHeight()) / this.itemHeight()) + this.overscan(),
    ),
  );
  readonly visible = computed(() => this.items().slice(this.startIndex(), this.endIndex()));

  ngAfterViewInit(): void {
    this.measure();
    const el = this.viewportRef?.nativeElement;
    if (el && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(el);
    }
  }

  onScroll(): void {
    this.scrollTop.set(this.viewportRef?.nativeElement.scrollTop ?? 0);
  }

  ensureIndexVisible(index: number): void {
    const viewport = this.viewportRef?.nativeElement;
    const height = this.itemHeight();
    // 必填 input 在极早的 effect 阶段可能尚未绑定，此时无需滚动
    if (!viewport || !height) return;
    const top = index * height;
    const bottom = top + height;
    if (top < viewport.scrollTop) {
      viewport.scrollTo({ top });
    } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: bottom - viewport.clientHeight });
    }
  }

  private measure(): void {
    const el = this.viewportRef?.nativeElement;
    if (el) this.viewportHeight.set(Math.max(el.clientHeight, 200));
  }
}
