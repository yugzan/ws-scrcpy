import { ManagerClient } from './ManagerClient';
import { ControlMessage } from '../controlMessage/ControlMessage';
import DeviceMessage from '../googDevice/DeviceMessage';
import VideoSettings from '../VideoSettings';
import ScreenInfo from '../ScreenInfo';
import Util from '../Util';
import { DisplayInfo } from '../DisplayInfo';
import { ParamsStream } from '../../types/ParamsStream';

const DEVICE_NAME_FIELD_LENGTH = 64;
const MAGIC_BYTES_INITIAL = Util.stringToUtf8ByteArray('scrcpy_initial');

export type ClientsStats = {
    deviceName: string;
    clientId: number;
};

export type DisplayCombinedInfo = {
    displayInfo: DisplayInfo;
    videoSettings?: VideoSettings;
    screenInfo?: ScreenInfo;
    connectionCount: number;
};

interface StreamReceiverEvents {
    video: ArrayBuffer;
    deviceMessage: DeviceMessage;
    displayInfo: DisplayCombinedInfo[];
    clientsStats: ClientsStats;
    encoders: string[];
    connected: void;
    disconnected: CloseEvent;
    reconnecting: { attempt: number; delay: number };
}

const TAG = '[StreamReceiver]';
// 斷線自動重連的退避時間：1s、2s、4s、8s，上限 10s
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 10000;
// 回到前景後，若 ws 看似 OPEN 但這段時間內沒有收到任何資料，視為半開連線，強制重連
const STALE_CHECK_DELAY = 3000;

export class StreamReceiver<P extends ParamsStream> extends ManagerClient<ParamsStream, StreamReceiverEvents> {
    private events: ControlMessage[] = [];
    private encodersSet: Set<string> = new Set<string>();
    private clientId = -1;
    private deviceName = '';
    private readonly displayInfoMap: Map<number, DisplayInfo> = new Map();
    private readonly connectionCountMap: Map<number, number> = new Map();
    private readonly screenInfoMap: Map<number, ScreenInfo> = new Map();
    private readonly videoSettingsMap: Map<number, VideoSettings> = new Map();
    private hasInitialInfo = false;
    private autoReconnect = false;
    private stopped = false;
    private reconnectAttempt = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private staleCheckTimer?: ReturnType<typeof setTimeout>;
    private lastMessageAt = 0;
    private everOpened = false;

    constructor(params: P) {
        super(params);
        this.openNewConnection();
        if (this.ws) {
            this.ws.binaryType = 'arraybuffer';
        }
    }

    private handleInitialInfo(data: ArrayBuffer): void {
        let offset = MAGIC_BYTES_INITIAL.length;
        let nameBytes = new Uint8Array(data, offset, DEVICE_NAME_FIELD_LENGTH);
        offset += DEVICE_NAME_FIELD_LENGTH;
        let rest: Buffer = Buffer.from(new Uint8Array(data, offset));
        const displaysCount = rest.readInt32BE(0);
        this.displayInfoMap.clear();
        this.connectionCountMap.clear();
        this.screenInfoMap.clear();
        this.videoSettingsMap.clear();
        rest = rest.slice(4);
        for (let i = 0; i < displaysCount; i++) {
            const displayInfoBuffer = rest.slice(0, DisplayInfo.BUFFER_LENGTH);
            const displayInfo = DisplayInfo.fromBuffer(displayInfoBuffer);
            const { displayId } = displayInfo;
            this.displayInfoMap.set(displayId, displayInfo);
            rest = rest.slice(DisplayInfo.BUFFER_LENGTH);
            this.connectionCountMap.set(displayId, rest.readInt32BE(0));
            rest = rest.slice(4);
            const screenInfoBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (screenInfoBytesCount) {
                this.screenInfoMap.set(displayId, ScreenInfo.fromBuffer(rest.slice(0, screenInfoBytesCount)));
                rest = rest.slice(screenInfoBytesCount);
            }
            const videoSettingsBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (videoSettingsBytesCount) {
                this.videoSettingsMap.set(displayId, VideoSettings.fromBuffer(rest.slice(0, videoSettingsBytesCount)));
                rest = rest.slice(videoSettingsBytesCount);
            }
        }
        this.encodersSet.clear();
        const encodersCount = rest.readInt32BE(0);
        rest = rest.slice(4);
        for (let i = 0; i < encodersCount; i++) {
            const nameLength = rest.readInt32BE(0);
            rest = rest.slice(4);
            const nameBytes = rest.slice(0, nameLength);
            rest = rest.slice(nameLength);
            const name = Util.utf8ByteArrayToString(nameBytes);
            this.encodersSet.add(name);
        }
        this.clientId = rest.readInt32BE(0);
        nameBytes = Util.filterTrailingZeroes(nameBytes);
        this.deviceName = Util.utf8ByteArrayToString(nameBytes);
        this.hasInitialInfo = true;
        this.triggerInitialInfoEvents();
    }

    private static EqualArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0, l = a.length; i < l; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    protected buildDirectWebSocketUrl(): URL {
        const localUrl = super.buildDirectWebSocketUrl();
        if (this.supportMultiplexing()) {
            return localUrl;
        }
        localUrl.searchParams.set('udid', this.params.udid);
        return localUrl;
    }

    /**
     * 啟用斷線自動重連（行動瀏覽器切到背景、關螢幕時常把 WebSocket 斷掉）。
     * 啟用後，非主動 stop() 造成的斷線不會發出 'disconnected'，而是發出 'reconnecting' 並以退避時間重連；
     * 回到前景時立即重連，或在連線看似存活卻收不到資料時強制重連。
     */
    public setAutoReconnect(enabled: boolean): void {
        if (this.autoReconnect === enabled) {
            return;
        }
        this.autoReconnect = enabled;
        if (enabled) {
            document.addEventListener('visibilitychange', this.onForeground);
            window.addEventListener('pageshow', this.onForeground);
            window.addEventListener('online', this.onForeground);
        } else {
            this.removeForegroundListeners();
            this.clearTimers();
        }
    }

    private removeForegroundListeners(): void {
        document.removeEventListener('visibilitychange', this.onForeground);
        window.removeEventListener('pageshow', this.onForeground);
        window.removeEventListener('online', this.onForeground);
    }

    private clearTimers(): void {
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.staleCheckTimer !== undefined) {
            clearTimeout(this.staleCheckTimer);
            this.staleCheckTimer = undefined;
        }
    }

    private onForeground = (): void => {
        if (!this.autoReconnect || this.stopped || document.visibilityState === 'hidden') {
            return;
        }
        const ws = this.ws;
        if (!ws || ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
            // 斷線中：不等退避計時，立刻重連
            this.reconnectNow();
            return;
        }
        if (ws.readyState !== ws.OPEN) {
            return;
        }
        // 連線看似存活：確認回到前景後確實還有資料進來
        const since = Date.now();
        if (this.staleCheckTimer !== undefined) {
            clearTimeout(this.staleCheckTimer);
        }
        this.staleCheckTimer = setTimeout(() => {
            this.staleCheckTimer = undefined;
            if (this.stopped || this.ws !== ws || ws.readyState !== ws.OPEN) {
                return;
            }
            if (this.lastMessageAt < since) {
                console.warn(TAG, `No data for ${STALE_CHECK_DELAY} ms after returning to foreground. Reconnecting.`);
                this.dropConnection();
                this.reconnectNow();
            }
        }, STALE_CHECK_DELAY);
    };

    private dropConnection(): void {
        const ws = this.ws;
        // 先解除參照，舊連線之後的 close 事件會被 onSocketClose 忽略
        this.ws = undefined;
        if (ws) {
            try {
                ws.close();
            } catch (error) {
                console.error(TAG, error);
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== undefined) {
            return;
        }
        const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_DELAY);
        this.reconnectAttempt++;
        console.log(TAG, `Reconnecting in ${delay} ms (attempt ${this.reconnectAttempt}).`);
        this.emit('reconnecting', { attempt: this.reconnectAttempt, delay });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.reconnect();
        }, delay);
    }

    private reconnectNow(): void {
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        } else {
            // 沒有排程中的重連（例如偵測到半開連線），仍需通知上層重置播放器
            this.emit('reconnecting', { attempt: this.reconnectAttempt, delay: 0 });
        }
        this.reconnect();
    }

    private reconnect(): void {
        if (this.stopped) {
            return;
        }
        // 重連期間累積的控制事件（觸控、按鍵）不重送，避免延遲後誤觸
        this.events.length = 0;
        const ws = this.openNewConnection();
        ws.binaryType = 'arraybuffer';
    }

    protected onSocketClose(ev: CloseEvent): void {
        if (this.ws && ev.target && ev.target !== this.ws) {
            // 已被新連線取代的舊連線
            return;
        }
        console.log(`${TAG}. WS closed: ${ev.code} ${ev.reason}`);
        if (this.autoReconnect && !this.stopped) {
            this.scheduleReconnect();
            return;
        }
        this.emit('disconnected', ev);
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (this.ws && event.target && event.target !== this.ws) {
            return;
        }
        this.lastMessageAt = Date.now();
        this.reconnectAttempt = 0;
        if (event.data instanceof ArrayBuffer) {
            // works only because MAGIC_BYTES_INITIAL and MAGIC_BYTES_MESSAGE have same length
            if (event.data.byteLength > MAGIC_BYTES_INITIAL.length) {
                const magicBytes = new Uint8Array(event.data, 0, MAGIC_BYTES_INITIAL.length);
                if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_INITIAL)) {
                    this.handleInitialInfo(event.data);
                    return;
                }
                if (StreamReceiver.EqualArrays(magicBytes, DeviceMessage.MAGIC_BYTES_MESSAGE)) {
                    const message = DeviceMessage.fromBuffer(event.data);
                    this.emit('deviceMessage', message);
                    return;
                }
            }

            this.emit('video', new Uint8Array(event.data));
        }
    }

    protected onSocketOpen(event: Event): void {
        if (this.ws && event.target && event.target !== this.ws) {
            return;
        }
        this.everOpened = true;
        this.emit('connected', void 0);
        let e = this.events.shift();
        while (e) {
            this.sendEvent(e);
            e = this.events.shift();
        }
    }

    public sendEvent(event: ControlMessage): void {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(event.toBuffer());
        } else if (this.autoReconnect && this.everOpened) {
            // 曾連上後又斷線（重連中）：丟棄控制事件，不在重連後補送，避免延遲誤觸
            return;
        } else {
            this.events.push(event);
        }
    }

    public stop(): void {
        this.stopped = true;
        this.clearTimers();
        this.removeForegroundListeners();
        const ws = this.ws;
        if (ws && ws.readyState === ws.OPEN) {
            ws.close();
        } else if (this.autoReconnect) {
            if (ws && ws.readyState === ws.CONNECTING) {
                // 重連中的連線：關閉後會觸發 close 事件 → 'disconnected'
                ws.close();
            } else {
                // 已無存活連線，不會再有 close 事件，直接通知上層清理
                this.emit('disconnected', new CloseEvent('close', { code: 1000, reason: 'stopped' }));
            }
        }
        this.events.length = 0;
    }

    public getEncoders(): string[] {
        return Array.from(this.encodersSet.values());
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public triggerInitialInfoEvents(): void {
        if (this.hasInitialInfo) {
            const encoders = this.getEncoders();
            this.emit('encoders', encoders);
            const { clientId, deviceName } = this;
            this.emit('clientsStats', { clientId, deviceName });
            const infoArray: DisplayCombinedInfo[] = [];
            this.displayInfoMap.forEach((displayInfo: DisplayInfo, displayId: number) => {
                const connectionCount = this.connectionCountMap.get(displayId) || 0;
                infoArray.push({
                    displayInfo,
                    videoSettings: this.videoSettingsMap.get(displayId),
                    screenInfo: this.screenInfoMap.get(displayId),
                    connectionCount,
                });
            });
            this.emit('displayInfo', infoArray);
        }
    }

    public getDisplayInfo(displayId: number): DisplayInfo | undefined {
        return this.displayInfoMap.get(displayId);
    }
}
