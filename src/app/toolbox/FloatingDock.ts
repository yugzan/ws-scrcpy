import '../../style/floatingdock.css';
import { ToolBoxElement } from './ToolBoxElement';

export type DockItem = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    element: ToolBoxElement<any>;
    caption: string;
};

export type DockGroups = {
    // Always visible once the dock is opened.
    primary: DockItem[];
    // Collapsed behind the "More" toggle.
    secondary: DockItem[];
    // Rendered at the very end of the "More" section, visually separated
    // (e.g. Power), so it is never hit by accident.
    guarded: DockItem[];
};

type StoredPosition = {
    side: 'left' | 'right';
    // Vertical position of the ball centre as a fraction of the viewport height
    y: number;
};

const BALL_SIZE = 48;
const EDGE_GAP = 8;
const DRAG_THRESHOLD = 6;
const DEFAULT_POSITION: StoredPosition = { side: 'right', y: 0.4 };

/**
 * A draggable floating button ("assistive touch" style) that replaces the
 * classic side panel of control buttons. It is built entirely out of
 * position:fixed elements inside a `display: contents` holder, so the holder
 * occupies no space in the layout and the video can use the whole viewport.
 *
 * Touches on the dock never reach the device: the interaction handler only
 * forwards events whose target is the video's touch canvas, and while the
 * dock is open a transparent scrim catches taps outside of it.
 */
export class FloatingDock {
    private readonly holder: HTMLElement;
    private readonly ball: HTMLButtonElement;
    private readonly panel: HTMLElement;
    private readonly moreToggle: HTMLButtonElement;
    private readonly moreSection: HTMLElement;
    private position: StoredPosition;
    private opened = false;
    private drag?: {
        pointerId: number;
        startX: number;
        startY: number;
        offsetX: number;
        offsetY: number;
        moved: boolean;
    };

    constructor(private readonly storageKey: string, groups: DockGroups) {
        this.position = FloatingDock.loadPosition(storageKey);

        const holder = document.createElement('div');
        holder.className = 'floating-dock';

        const scrim = document.createElement('div');
        scrim.className = 'fab-scrim';
        scrim.addEventListener('pointerdown', this.onScrimPointerDown);
        holder.appendChild(scrim);

        const ball = document.createElement('button');
        ball.className = 'fab-ball';
        ball.type = 'button';
        ball.title = '控制選單';
        ball.setAttribute('aria-label', '控制選單');
        ball.setAttribute('aria-expanded', 'false');
        ball.setAttribute('aria-haspopup', 'true');
        const glyph = document.createElement('span');
        glyph.className = 'fab-glyph';
        ball.appendChild(glyph);
        ball.addEventListener('pointerdown', this.onBallPointerDown);
        ball.addEventListener('pointermove', this.onBallPointerMove);
        ball.addEventListener('pointerup', this.onBallPointerUp);
        ball.addEventListener('pointercancel', this.onBallPointerCancel);
        ball.addEventListener('keydown', this.onBallKeyDown);
        ball.addEventListener('contextmenu', FloatingDock.preventDefault);
        holder.appendChild(ball);

        const panel = document.createElement('div');
        panel.className = 'fab-panel';
        panel.setAttribute('role', 'menu');
        panel.addEventListener('contextmenu', FloatingDock.preventDefault);

        const primary = FloatingDock.createSection('fab-grid fab-primary', groups.primary);
        panel.appendChild(primary);

        const moreToggle = document.createElement('button');
        moreToggle.type = 'button';
        moreToggle.className = 'fab-more-toggle';
        moreToggle.setAttribute('aria-expanded', 'false');
        moreToggle.innerHTML = '<span>更多</span><span class="fab-chevron" aria-hidden="true"></span>';
        moreToggle.addEventListener('click', this.onMoreToggle);
        panel.appendChild(moreToggle);

        const moreSection = document.createElement('div');
        moreSection.className = 'fab-more';
        moreSection.appendChild(FloatingDock.createSection('fab-grid fab-secondary', groups.secondary));
        if (groups.guarded.length) {
            moreSection.appendChild(FloatingDock.createSection('fab-grid fab-guarded', groups.guarded));
        }
        panel.appendChild(moreSection);
        holder.appendChild(panel);

        this.holder = holder;
        this.ball = ball;
        this.panel = panel;
        this.moreToggle = moreToggle;
        this.moreSection = moreSection;

        window.addEventListener('resize', this.onWindowResize);
        // iOS Safari ignores `user-scalable=no`; block its pinch-zoom gesture
        document.addEventListener('gesturestart', FloatingDock.preventDefault);
        this.applyPosition();
    }

    private static preventDefault = (event: Event): void => {
        event.preventDefault();
    };

    private static createSection(className: string, items: DockItem[]): HTMLElement {
        const section = document.createElement('div');
        // `control-wrapper` keeps the existing checkbox/label styling working
        section.className = `${className} control-wrapper`;
        items.forEach(({ element, caption }) => {
            const all: HTMLElement[] = element.getAllElements();
            all.forEach((el) => {
                section.appendChild(el);
            });
            // The visible control is the last element (button, or label of a checkbox)
            const visible = all[all.length - 1];
            if (visible) {
                visible.classList.add('fab-item');
                const span = document.createElement('span');
                span.className = 'fab-caption';
                span.textContent = caption;
                visible.appendChild(span);
            }
        });
        return section;
    }

    private static loadPosition(key: string): StoredPosition {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (
                    parsed &&
                    (parsed.side === 'left' || parsed.side === 'right') &&
                    typeof parsed.y === 'number' &&
                    Number.isFinite(parsed.y)
                ) {
                    return { side: parsed.side, y: Math.min(1, Math.max(0, parsed.y)) };
                }
            }
        } catch (error) {
            // storage may be unavailable (private mode, blocked site data)
        }
        return { ...DEFAULT_POSITION };
    }

    private savePosition(): void {
        try {
            window.localStorage.setItem(this.storageKey, JSON.stringify(this.position));
        } catch (error) {
            // ignore, the position simply won't be remembered
        }
    }

    public getElement(): HTMLElement {
        return this.holder;
    }

    public isOpen(): boolean {
        return this.opened;
    }

    public open(): void {
        if (this.opened) {
            return;
        }
        this.opened = true;
        this.holder.classList.add('open');
        this.ball.setAttribute('aria-expanded', 'true');
        this.layoutPanel();
    }

    public close(): void {
        if (!this.opened) {
            return;
        }
        this.opened = false;
        this.holder.classList.remove('open');
        this.ball.setAttribute('aria-expanded', 'false');
        this.setMoreOpen(false);
    }

    public toggle(): void {
        if (this.opened) {
            this.close();
        } else {
            this.open();
        }
    }

    public release(): void {
        window.removeEventListener('resize', this.onWindowResize);
        document.removeEventListener('gesturestart', FloatingDock.preventDefault);
        this.holder.remove();
    }

    private setMoreOpen(value: boolean): void {
        this.holder.classList.toggle('more-open', value);
        this.moreToggle.setAttribute('aria-expanded', value ? 'true' : 'false');
        if (this.opened) {
            this.layoutPanel();
        }
    }

    private onMoreToggle = (): void => {
        this.setMoreOpen(!this.holder.classList.contains('more-open'));
    };

    private onScrimPointerDown = (event: PointerEvent): void => {
        // swallow the tap: closing the menu must not also tap the game
        event.preventDefault();
        event.stopPropagation();
        this.close();
    };

    private onBallKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            this.close();
        }
    };

    private onBallPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const rect = this.ball.getBoundingClientRect();
        this.drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            moved: false,
        };
        try {
            this.ball.setPointerCapture(event.pointerId);
        } catch (error) {
            // not critical
        }
        this.ball.classList.add('pressed');
    };

    private onBallPointerMove = (event: PointerEvent): void => {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        if (!drag.moved) {
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
                return;
            }
            drag.moved = true;
            this.close();
            this.holder.classList.add('dragging');
        }
        const { innerWidth, innerHeight } = window;
        const left = Math.min(innerWidth - BALL_SIZE, Math.max(0, event.clientX - drag.offsetX));
        const top = Math.min(innerHeight - BALL_SIZE, Math.max(0, event.clientY - drag.offsetY));
        this.ball.style.left = `${left}px`;
        this.ball.style.top = `${top}px`;
    };

    private onBallPointerUp = (event: PointerEvent): void => {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        this.drag = undefined;
        this.ball.classList.remove('pressed');
        if (!drag.moved) {
            this.toggle();
            return;
        }
        this.holder.classList.remove('dragging');
        const rect = this.ball.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const height = window.innerHeight || 1;
        this.position = {
            side: centerX < window.innerWidth / 2 ? 'left' : 'right',
            y: Math.min(1, Math.max(0, centerY / height)),
        };
        this.savePosition();
        this.applyPosition();
    };

    private onBallPointerCancel = (): void => {
        this.drag = undefined;
        this.ball.classList.remove('pressed');
        this.holder.classList.remove('dragging');
        this.applyPosition();
    };

    private onWindowResize = (): void => {
        this.applyPosition();
    };

    private applyPosition(): void {
        const { innerWidth, innerHeight } = window;
        const minTop = EDGE_GAP;
        const maxTop = Math.max(minTop, innerHeight - BALL_SIZE - EDGE_GAP);
        const top = Math.min(maxTop, Math.max(minTop, this.position.y * innerHeight - BALL_SIZE / 2));
        const left = this.position.side === 'left' ? EDGE_GAP : innerWidth - BALL_SIZE - EDGE_GAP;
        this.ball.style.left = `${Math.max(0, left)}px`;
        this.ball.style.top = `${top}px`;
        this.holder.dataset.side = this.position.side;
        if (this.opened) {
            this.layoutPanel();
        }
    }

    private layoutPanel(): void {
        const { innerWidth, innerHeight } = window;
        const ballRect = this.ball.getBoundingClientRect();
        const panel = this.panel;
        // measure with the current content
        panel.style.maxHeight = `${innerHeight - 2 * EDGE_GAP}px`;
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        let left: number;
        if (this.position.side === 'right') {
            left = ballRect.left - width - EDGE_GAP;
            if (left < EDGE_GAP) {
                left = Math.max(EDGE_GAP, innerWidth - width - EDGE_GAP);
            }
        } else {
            left = ballRect.right + EDGE_GAP;
            if (left + width > innerWidth - EDGE_GAP) {
                left = EDGE_GAP;
            }
        }
        let top = ballRect.top + ballRect.height / 2 - height / 2;
        top = Math.min(innerHeight - height - EDGE_GAP, Math.max(EDGE_GAP, top));
        panel.style.left = `${Math.max(EDGE_GAP, left)}px`;
        panel.style.top = `${Math.max(EDGE_GAP, top)}px`;
        this.moreSection.setAttribute('aria-hidden', this.holder.classList.contains('more-open') ? 'false' : 'true');
    }
}
