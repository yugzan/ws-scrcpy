/**
 * Display-only preferences of the device list (home page).
 *
 * adb can list the same device under several serials, e.g. a redroid
 * container shows up both as `127.0.0.1:5555` (TCP) and `emulator-5554`.
 * Serials listed here are still tracked as usual, they are only rendered as
 * compact cards inside a collapsed "other connections" group.
 *
 * Override per browser (no rebuild needed), from the devtools console:
 *   localStorage.setItem('device_list::secondary_udids', JSON.stringify(['emulator-5554']))
 * Use '[]' to show every device as a main card, removeItem() to restore defaults.
 */
export const DEFAULT_SECONDARY_UDIDS: readonly string[] = ['emulator-5554'];

// Player used by the main "enter" button of a device card
export const PREFERRED_PLAYER_CODE_NAME = 'mse';

const SECONDARY_UDIDS_STORAGE_KEY = 'device_list::secondary_udids';

export function getSecondaryUdids(): readonly string[] {
    try {
        const raw = window.localStorage.getItem(SECONDARY_UDIDS_STORAGE_KEY);
        if (raw !== null) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter((item): item is string => typeof item === 'string');
            }
        }
    } catch (error) {
        // storage unavailable or malformed value: fall back to defaults
    }
    return DEFAULT_SECONDARY_UDIDS;
}

export function isSecondaryDevice(udid: string): boolean {
    return getSecondaryUdids().includes(udid);
}
