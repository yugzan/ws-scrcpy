import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import SvgImage from '../../ui/SvgImage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';
import { DockItem, FloatingDock } from '../../toolbox/FloatingDock';

const BUTTONS = [
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
    {
        title: 'Back',
        code: KeyEvent.KEYCODE_BACK,
        icon: SvgImage.Icon.BACK,
    },
    {
        title: 'Home',
        code: KeyEvent.KEYCODE_HOME,
        icon: SvgImage.Icon.HOME,
    },
    {
        title: 'Overview',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: SvgImage.Icon.OVERVIEW,
    },
];

// Short labels shown under the icons in the floating dock
const CAPTIONS: Record<number, string> = {
    [KeyEvent.KEYCODE_POWER]: '電源',
    [KeyEvent.KEYCODE_VOLUME_UP]: '音量＋',
    [KeyEvent.KEYCODE_VOLUME_DOWN]: '音量－',
    [KeyEvent.KEYCODE_BACK]: '返回',
    [KeyEvent.KEYCODE_HOME]: '主畫面',
    [KeyEvent.KEYCODE_APP_SWITCH]: '多工',
};

export interface GoogToolBoxOptions {
    // Start with keyboard capture enabled instead of requiring the user to tick
    // the "Capture keyboard" checkbox first.
    captureKeyboard?: boolean;
}

export class GoogToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[], private readonly dock: FloatingDock) {
        super(list, dock.getElement());
    }

    public getDock(): FloatingDock {
        return this.dock;
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        moreBox?: HTMLElement,
        options: GoogToolBoxOptions = {},
    ): GoogToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.code) {
                return;
            }
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };
        const buttons: Map<number, ToolBoxButton> = new Map();
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                code: item.code,
            });
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            buttons.set(item.code, button);
            return button;
        });
        const item = (code: number): DockItem => {
            const element = buttons.get(code) as ToolBoxButton;
            return { element, caption: CAPTIONS[code] || element.title };
        };

        const secondary: DockItem[] = [];
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
            secondary.push({ element: screenshot, caption: '截圖' });
        }

        const fullscreen = new ToolBoxButton('Fullscreen Mode', SvgImage.Icon.FULL_SCREEN);
        fullscreen.addEventListener('click', () => {
            GoogToolBox.toggleFullscreen(player);
        });
        elements.push(fullscreen);

        const keyboard = new ToolBoxCheckbox(
            'Capture keyboard',
            SvgImage.Icon.KEYBOARD,
            `capture_keyboard_${udid}_${playerName}`,
        );
        keyboard.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.setHandleKeyboardEvents(element.checked);
        });
        if (options.captureKeyboard) {
            keyboard.getElement().checked = true;
            client.setHandleKeyboardEvents(true);
        }
        elements.push(keyboard);
        secondary.push({ element: keyboard, caption: '鍵盤' });

        if (moreBox) {
            const displayId = player.getVideoSettings().displayId;
            const id = `show_more_${udid}_${playerName}_${displayId}`;
            const more = new ToolBoxCheckbox('More', SvgImage.Icon.MORE, id);
            more.addEventListener('click', (_, el) => {
                const element = el.getElement();
                moreBox.style.display = element.checked ? 'block' : 'none';
            });
            elements.unshift(more);
            secondary.push({ element: more, caption: '設定' });
        }

        const exit = new ToolBoxButton('Device list', SvgImage.Icon.MENU);
        exit.addEventListener('click', () => {
            // full navigation (not a hash change) so the stream is torn down
            location.assign(`${location.pathname}${location.search}`);
        });
        elements.push(exit);
        secondary.push({ element: exit, caption: '裝置列表' });

        const dock = new FloatingDock(`floating_dock::${udid}`, {
            primary: [
                item(KeyEvent.KEYCODE_BACK),
                item(KeyEvent.KEYCODE_HOME),
                item(KeyEvent.KEYCODE_APP_SWITCH),
                item(KeyEvent.KEYCODE_VOLUME_UP),
                item(KeyEvent.KEYCODE_VOLUME_DOWN),
                { element: fullscreen, caption: '全螢幕' },
            ],
            secondary,
            // Power sits alone at the end of the "More" section: two taps away
            // and separated from everything else, so it is hard to hit by accident.
            guarded: [item(KeyEvent.KEYCODE_POWER)],
        });
        return new GoogToolBox(elements, dock);
    }

    private static toggleFullscreen(player: BasePlayer): void {
        type FsDocument = Document & {
            webkitFullscreenElement?: Element | null;
            webkitExitFullscreen?: () => void;
        };
        type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
        const doc = document as FsDocument;
        try {
            if (doc.fullscreenElement || doc.webkitFullscreenElement) {
                if (doc.exitFullscreen) {
                    doc.exitFullscreen().catch(() => undefined);
                } else if (doc.webkitExitFullscreen) {
                    doc.webkitExitFullscreen();
                }
                return;
            }
            // Fullscreen the whole page (not only the video) so the floating
            // dock stays reachable while in fullscreen.
            const root = (document.documentElement || player.getParent()) as FsElement;
            if (root.requestFullscreen) {
                root.requestFullscreen({ navigationUI: 'hide' }).catch(() => GoogToolBox.showFullscreenHint());
            } else if (root.webkitRequestFullscreen) {
                root.webkitRequestFullscreen();
            } else {
                GoogToolBox.showFullscreenHint();
            }
        } catch (error) {
            GoogToolBox.showFullscreenHint();
        }
    }

    private static showFullscreenHint(): void {
        // iPhone Safari has no element fullscreen; the installed web app is.
        const id = 'fullscreen_hint';
        if (document.getElementById(id)) {
            return;
        }
        const hint = document.createElement('div');
        hint.id = id;
        hint.className = 'fab-toast';
        hint.setAttribute('role', 'status');
        hint.textContent = '此瀏覽器不支援全螢幕。請用「分享 → 加入主畫面」，從主畫面圖示開啟即為全螢幕。';
        document.body.appendChild(hint);
        setTimeout(() => hint.remove(), 5000);
    }
}
