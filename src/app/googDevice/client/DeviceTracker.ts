import '../../../style/devicelist.css';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { SERVER_PORT } from '../../../common/Constants';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { StreamClientScrcpy } from './StreamClientScrcpy';
import SvgImage from '../../ui/SvgImage';
import { html } from '../../ui/HtmlTag';
import Util from '../../Util';
import { Attribute } from '../../Attribute';
import { DeviceState } from '../../../common/DeviceState';
import { Message } from '../../../types/Message';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';
import { isSecondaryDevice, PREFERRED_PLAYER_CODE_NAME } from '../DeviceListPrefs';

type Field = keyof GoogDeviceDescriptor | ((descriptor: GoogDeviceDescriptor) => string);
type DescriptionColumn = { title: string; field: Field };

const DESC_COLUMNS: DescriptionColumn[] = [
    {
        title: 'Net Interface',
        field: 'interfaces',
    },
    {
        title: 'Server PID',
        field: 'pid',
    },
];

export class DeviceTracker extends BaseDeviceTracker<GoogDeviceDescriptor, never> {
    public static readonly ACTION = ACTION.GOOG_DEVICE_LIST;
    public static readonly CREATE_DIRECT_LINKS = true;
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();
    protected static tools: Set<Tool> = new Set();
    protected tableId = 'goog_device_list';
    // UI state that must survive the full re-render on every tracker update
    private static openDetails: Set<string> = new Set();
    private static openSecondaryGroups: Set<string> = new Set();

    public static start(hostItem: HostItem): DeviceTracker {
        const url = this.buildUrlForTracker(hostItem).toString();
        let instance = this.instancesByUrl.get(url);
        if (!instance) {
            instance = new DeviceTracker(hostItem, url);
        }
        return instance;
    }

    public static getInstance(hostItem: HostItem): DeviceTracker {
        return this.start(hostItem);
    }

    protected constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.buildDeviceTable();
        DeviceTracker.ensureListHeader();
        this.openNewConnection();
    }

    private static ensureListHeader(): void {
        const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
        if (!holder || holder.querySelector(':scope > .list-header')) {
            return;
        }
        const header = html`<header class="list-header">
            <h1 class="list-title">Droid</h1>
            <p class="list-hint">點「進入畫面」就能看到並操作裝置</p>
        </header>`.content;
        holder.insertBefore(header, holder.firstChild);
    }

    protected onSocketOpen(): void {
        // nothing here;
    }

    protected setIdAndHostName(id: string, hostName: string): void {
        super.setIdAndHostName(id, hostName);
        for (const value of DeviceTracker.instancesByUrl.values()) {
            if (value.id === id && value !== this) {
                console.warn(
                    `Tracker with url: "${this.url}" has the same id(${this.id}) as tracker with url "${value.url}"`,
                );
                console.warn(`This tracker will shut down`);
                this.destroy();
            }
        }
    }

    onInterfaceSelected = (event: Event): void => {
        const selectElement = event.currentTarget as HTMLSelectElement;
        const option = selectElement.selectedOptions[0];
        const url = decodeURI(option.getAttribute(Attribute.URL) || '');
        const name = option.getAttribute(Attribute.NAME) || '';
        const fullName = decodeURIComponent(selectElement.getAttribute(Attribute.FULL_NAME) || '');
        const udid = selectElement.getAttribute(Attribute.UDID) || '';
        this.updateLink({ url, name, fullName, udid, store: true });
    };

    private updateLink(params: { url: string; name: string; fullName: string; udid: string; store: boolean }): void {
        const { url, name, fullName, udid, store } = params;
        const playerTds = document.getElementsByName(
            encodeURIComponent(`${DeviceTracker.AttributePrefixPlayerFor}${fullName}`),
        );
        if (typeof udid !== 'string') {
            return;
        }
        if (store) {
            const localStorageKey = DeviceTracker.getLocalStorageKey(fullName || '');
            if (localStorage && name) {
                localStorage.setItem(localStorageKey, name);
            }
        }
        const action = ACTION.STREAM_SCRCPY;
        this.updatePrimaryLink(fullName, udid, url);
        playerTds.forEach((item) => {
            item.innerHTML = '';
            const playerFullName = item.getAttribute(DeviceTracker.AttributePlayerFullName);
            const playerCodeName = item.getAttribute(DeviceTracker.AttributePlayerCodeName);
            if (!playerFullName || !playerCodeName) {
                return;
            }
            const link = DeviceTracker.buildLink(
                {
                    action,
                    udid,
                    player: decodeURIComponent(playerCodeName),
                    ws: url,
                    fitToScreen: true,
                },
                decodeURIComponent(playerFullName),
                this.params,
            );
            item.appendChild(link);
        });
    }

    onActionButtonClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLButtonElement;
        const udid = button.getAttribute(Attribute.UDID);
        const pidString = button.getAttribute(Attribute.PID) || '';
        const command = button.getAttribute(Attribute.COMMAND) as string;
        const pid = parseInt(pidString, 10);
        const data: Message = {
            id: this.getNextId(),
            type: command,
            data: {
                udid: typeof udid === 'string' ? udid : undefined,
                pid: isNaN(pid) ? undefined : pid,
            },
        };

        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    };

    private static getPrimaryId(fullName: string): string {
        return `device_primary_${fullName}`;
    }

    private static rememberOpen(set: Set<string>, key: string, open: boolean): void {
        if (open) {
            set.add(key);
        } else {
            set.delete(key);
        }
    }

    // Main action of a card while there is no stream link (yet)
    private static fillPrimaryPlaceholder(
        holder: HTMLElement,
        device: GoogDeviceDescriptor,
        isActive: boolean,
        hasPid: boolean,
        onClick: (event: MouseEvent) => void,
    ): void {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'primary-action';
        if (!isActive) {
            button.disabled = true;
            button.textContent = '裝置離線';
        } else if (!hasPid) {
            button.classList.add('start-server');
            button.textContent = '啟動串流服務';
            button.setAttribute(Attribute.UDID, device.udid);
            button.setAttribute(Attribute.PID, '-1');
            button.setAttribute(Attribute.COMMAND, ControlCenterCommand.START_SERVER);
            button.onclick = onClick;
        } else {
            button.disabled = true;
            button.textContent = '準備中…';
        }
        holder.appendChild(button);
    }

    // The one-tap "enter" button: preferred player, fit to screen, same tab
    private updatePrimaryLink(fullName: string, udid: string, ws: string): void {
        const holder = document.getElementById(DeviceTracker.getPrimaryId(fullName));
        if (!holder) {
            return;
        }
        const players = StreamClientScrcpy.getPlayers();
        const player = players.find((item) => item.playerCodeName === PREFERRED_PLAYER_CODE_NAME) || players[0];
        if (!player) {
            return;
        }
        const link = DeviceTracker.buildLink(
            {
                action: ACTION.STREAM_SCRCPY,
                udid,
                player: player.playerCodeName,
                ws,
                fitToScreen: true,
            },
            '',
            this.params,
        );
        link.removeAttribute('target');
        // 同分頁開啟（加到主畫面時不跳出 App）。app 只在載入時讀 hash，
        // 只改 hash 不會重新載入頁面，所以要主動 reload
        link.addEventListener('click', (event) => {
            event.preventDefault();
            window.location.href = link.href;
            window.location.reload();
        });
        link.className = 'primary-action';
        link.innerHTML = '<span>進入畫面</span><span class="primary-arrow" aria-hidden="true"></span>';
        link.title = `${player.playerFullName} · fit to screen`;
        holder.innerHTML = '';
        holder.appendChild(link);
    }

    // Collapsed group that holds duplicate/secondary serials (see DeviceListPrefs)
    private getOrCreateSecondaryGroup(tbody: Element): Element {
        const existing = tbody.querySelector(':scope > details.device-secondary-group');
        if (existing) {
            return existing;
        }
        const key = this.elementId;
        const group = document.createElement('details');
        group.className = 'device-secondary-group';
        group.open = DeviceTracker.openSecondaryGroups.has(key);
        group.addEventListener('toggle', () => {
            DeviceTracker.rememberOpen(DeviceTracker.openSecondaryGroups, key, group.open);
        });
        const summary = document.createElement('summary');
        summary.innerHTML = '<span>其他連線</span><span class="device-secondary-count"></span>';
        group.appendChild(summary);
        tbody.appendChild(group);
        return group;
    }

    private static getLocalStorageKey(udid: string): string {
        return `device_list::${udid}::interface`;
    }

    protected static createUrl(params: ParamsDeviceTracker, udid = ''): URL {
        const secure = !!params.secure;
        const hostname = params.hostname || location.hostname;
        const port = typeof params.port === 'number' ? params.port : secure ? 443 : 80;
        const pathname = params.pathname || location.pathname;
        const urlObject = this.buildUrl({ ...params, secure, hostname, port, pathname });
        if (udid) {
            urlObject.searchParams.set('action', ACTION.PROXY_ADB);
            urlObject.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            urlObject.searchParams.set('udid', udid);
        }
        return urlObject;
    }

    protected static createInterfaceOption(name: string, url: string): HTMLOptionElement {
        const optionElement = document.createElement('option');
        optionElement.setAttribute(Attribute.URL, url);
        optionElement.setAttribute(Attribute.NAME, name);
        optionElement.innerText = `proxy over adb`;
        return optionElement;
    }

    private static titleToClassName(title: string): string {
        return title.toLowerCase().replace(/\s/g, '_');
    }

    protected buildDeviceRow(tbody: Element, device: GoogDeviceDescriptor): void {
        let selectedInterfaceUrl = '';
        let selectedInterfaceName = '';
        const blockClass = 'desc-block';
        const fullName = `${this.id}_${Util.escapeUdid(device.udid)}`;
        const isActive = device.state === DeviceState.DEVICE;
        let hasPid = false;
        const servicesId = `device_services_${fullName}`;
        const primaryId = DeviceTracker.getPrimaryId(fullName);
        const secondary = isSecondaryDevice(device.udid);
        const stateLabel = isActive ? '線上' : device.state === DeviceState.DISCONNECTED ? '離線' : device.state;
        const manufacturer = device['ro.product.manufacturer'] || '';
        const model = device['ro.product.model'] || device.udid;
        const row = html`<div class="device ${isActive ? 'active' : 'not-active'} ${secondary ? 'secondary' : ''}">
            <div class="device-header">
                <div class="device-status">
                    <span class="device-state" title="State: ${device.state}"></span>
                    <span class="device-state-label">${stateLabel}</span>
                </div>
                <div class="device-name">
                    <span class="device-manufacturer">${manufacturer}</span>
                    <span class="device-model">${model}</span>
                </div>
                <div class="device-meta">
                    <span class="device-version">
                        <span class="release-version">Android ${device['ro.build.version.release']}</span>
                        <span class="sdk-version">SDK ${device['ro.build.version.sdk']}</span>
                    </span>
                    <span class="device-serial">${device.udid}</span>
                </div>
            </div>
            <div id="${primaryId}" class="device-primary"></div>
            <details class="device-more">
                <summary>其他播放器與工具</summary>
                <div id="${servicesId}" class="services"></div>
            </details>
        </div>`.content;
        const details = row.querySelector('details.device-more') as HTMLDetailsElement | null;
        if (details) {
            details.open = DeviceTracker.openDetails.has(fullName);
            details.addEventListener('toggle', () => {
                DeviceTracker.rememberOpen(DeviceTracker.openDetails, fullName, details.open);
            });
        }
        const services = row.getElementById(servicesId);
        if (!services) {
            return;
        }

        DeviceTracker.tools.forEach((tool) => {
            const entry = tool.createEntryForDeviceList(device, blockClass, this.params);
            if (entry) {
                if (Array.isArray(entry)) {
                    entry.forEach((item) => {
                        item && services.appendChild(item);
                    });
                } else {
                    services.appendChild(entry);
                }
            }
        });

        const streamEntry = StreamClientScrcpy.createEntryForDeviceList(device, blockClass, fullName, this.params);
        streamEntry && services.appendChild(streamEntry);

        DESC_COLUMNS.forEach((item) => {
            const { title } = item;
            const fieldName = item.field;
            let value: string;
            if (typeof item.field === 'string') {
                value = '' + device[item.field];
            } else {
                value = item.field(device);
            }
            const td = document.createElement('div');
            td.classList.add(DeviceTracker.titleToClassName(title), blockClass);
            services.appendChild(td);
            if (fieldName === 'pid') {
                hasPid = value !== '-1';
                // patch：server 執行中時不顯示「停止 server」按鈕（server 端也已停用 kill_server）
                if (hasPid) {
                    return;
                }
                const actionButton = document.createElement('button');
                actionButton.className = 'action-button kill-server-button';
                actionButton.setAttribute(Attribute.UDID, device.udid);
                actionButton.setAttribute(Attribute.PID, value);
                let command: string;
                if (isActive) {
                    actionButton.classList.add('active');
                    actionButton.onclick = this.onActionButtonClick;
                    if (hasPid) {
                        command = ControlCenterCommand.KILL_SERVER;
                        actionButton.title = 'Kill server';
                        actionButton.appendChild(SvgImage.create(SvgImage.Icon.CANCEL));
                    } else {
                        command = ControlCenterCommand.START_SERVER;
                        actionButton.title = 'Start server';
                        actionButton.appendChild(SvgImage.create(SvgImage.Icon.REFRESH));
                    }
                    actionButton.setAttribute(Attribute.COMMAND, command);
                } else {
                    const timestamp = device['last.update.timestamp'];
                    if (timestamp) {
                        const date = new Date(timestamp);
                        actionButton.title = `Last update on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
                    } else {
                        actionButton.title = `Not active`;
                    }
                    actionButton.appendChild(SvgImage.create(SvgImage.Icon.OFFLINE));
                }
                const span = document.createElement('span');
                span.innerText = value;
                actionButton.appendChild(span);
                td.appendChild(actionButton);
            } else if (fieldName === 'interfaces') {
                const proxyInterfaceUrl = DeviceTracker.createUrl(this.params, device.udid).toString();
                const proxyInterfaceName = 'proxy';
                const localStorageKey = DeviceTracker.getLocalStorageKey(fullName);
                const lastSelected = localStorage && localStorage.getItem(localStorageKey);
                const selectElement = document.createElement('select');
                selectElement.setAttribute(Attribute.UDID, device.udid);
                selectElement.setAttribute(Attribute.FULL_NAME, fullName);
                selectElement.setAttribute(
                    'name',
                    encodeURIComponent(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`),
                );
                /// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
                device.interfaces.forEach((value) => {
                    const params = {
                        ...this.params,
                        secure: false,
                        hostname: value.ipv4,
                        port: SERVER_PORT,
                    };
                    const url = DeviceTracker.createUrl(params).toString();
                    const optionElement = DeviceTracker.createInterfaceOption(value.name, url);
                    optionElement.innerText = `${value.name}: ${value.ipv4}`;
                    selectElement.appendChild(optionElement);
                    if (lastSelected) {
                        if (lastSelected === value.name || !selectedInterfaceName) {
                            optionElement.selected = true;
                            selectedInterfaceUrl = url;
                            selectedInterfaceName = value.name;
                        }
                    } else if (device['wifi.interface'] === value.name) {
                        optionElement.selected = true;
                    }
                });
                /// #else
                selectedInterfaceUrl = proxyInterfaceUrl;
                selectedInterfaceName = proxyInterfaceName;
                td.classList.add('hidden');
                /// #endif
                if (isActive) {
                    const adbProxyOption = DeviceTracker.createInterfaceOption(proxyInterfaceName, proxyInterfaceUrl);
                    if (lastSelected === proxyInterfaceName || !selectedInterfaceName) {
                        adbProxyOption.selected = true;
                        selectedInterfaceUrl = proxyInterfaceUrl;
                        selectedInterfaceName = proxyInterfaceName;
                    }
                    selectElement.appendChild(adbProxyOption);
                    const actionButton = document.createElement('button');
                    actionButton.className = 'action-button update-interfaces-button active';
                    actionButton.title = `Update information`;
                    actionButton.appendChild(SvgImage.create(SvgImage.Icon.REFRESH));
                    actionButton.setAttribute(Attribute.UDID, device.udid);
                    actionButton.setAttribute(Attribute.COMMAND, ControlCenterCommand.UPDATE_INTERFACES);
                    actionButton.onclick = this.onActionButtonClick;
                    td.appendChild(actionButton);
                }
                selectElement.onchange = this.onInterfaceSelected;
                td.appendChild(selectElement);
            } else {
                td.innerText = value;
            }
        });

        if (DeviceTracker.CREATE_DIRECT_LINKS) {
            const name = `${DeviceTracker.AttributePrefixPlayerFor}${fullName}`;
            StreamClientScrcpy.getPlayers().forEach((playerClass) => {
                const { playerCodeName, playerFullName } = playerClass;
                const playerTd = document.createElement('div');
                playerTd.classList.add(blockClass);
                playerTd.setAttribute('name', encodeURIComponent(name));
                playerTd.setAttribute(DeviceTracker.AttributePlayerFullName, encodeURIComponent(playerFullName));
                playerTd.setAttribute(DeviceTracker.AttributePlayerCodeName, encodeURIComponent(playerCodeName));
                services.appendChild(playerTd);
            });
        }

        const primary = row.getElementById(primaryId);
        if (primary) {
            DeviceTracker.fillPrimaryPlaceholder(primary, device, isActive, hasPid, this.onActionButtonClick);
        }

        const parent = secondary ? this.getOrCreateSecondaryGroup(tbody) : tbody;
        parent.appendChild(row);
        if (secondary) {
            const counter = parent.querySelector('.device-secondary-count');
            if (counter) {
                counter.textContent = `${parent.querySelectorAll('.device').length}`;
            }
        }
        if (DeviceTracker.CREATE_DIRECT_LINKS && hasPid && selectedInterfaceUrl) {
            this.updateLink({
                url: selectedInterfaceUrl,
                name: selectedInterfaceName,
                fullName,
                udid: device.udid,
                store: false,
            });
        }
    }

    protected getChannelCode(): string {
        return ChannelCode.GTRC;
    }

    public destroy(): void {
        super.destroy();
        DeviceTracker.instancesByUrl.delete(this.url.toString());
        if (!DeviceTracker.instancesByUrl.size) {
            const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
            if (holder && holder.parentElement) {
                holder.parentElement.removeChild(holder);
            }
        }
    }
}
