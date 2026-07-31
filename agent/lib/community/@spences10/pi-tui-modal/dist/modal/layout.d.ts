import { SettingsList, type Focusable, type OverlayOptions, type SelectListTheme, type SettingItem, type SettingsListTheme } from '@earendil-works/pi-tui';
import type { ModalBorderStyle, ModalColor, ModalMetadata, ModalOptions, ModalStyle, ModalText, ModalTheme } from './types.js';
export declare const default_overlay_options: OverlayOptions;
export declare const default_modal_style: Required<ModalStyle>;
export type BorderCharacters = {
    top_left: string;
    top: string;
    top_right: string;
    left: string;
    right: string;
    bottom_left: string;
    bottom: string;
    bottom_right: string;
};
export declare const border_characters: Record<Exclude<ModalBorderStyle, 'line' | 'none'>, BorderCharacters>;
export declare function normalize_text(value: ModalText | undefined): string[];
export declare function parse_size_value(value: unknown, total: number): number | undefined;
export declare function get_vertical_margin(margin: OverlayOptions['margin']): number;
export declare function get_terminal_rows(tui: {
    terminal?: {
        rows?: number;
    };
}): number;
export declare function get_border_line_count(style: ModalStyle | undefined): number;
export declare function count_text_lines(value: ModalText | undefined, width: number): number;
export declare function get_modal_body_line_budget(tui: {
    terminal?: {
        rows?: number;
    };
}, options: ModalOptions, body_width?: number): number;
export declare function fit_visible_items(item_count: number, preferred: number, body_line_budget: number): number;
export declare function set_component_max_visible(component: unknown, max_visible: number): void;
export declare function normalize_metadata(value: ModalMetadata | undefined, item: SettingItem | undefined): string[];
export declare function make_select_theme(theme: ModalTheme): SelectListTheme;
export declare function value_color(value: string): ModalColor;
export type SettingsListInternals = {
    items: SettingItem[];
    filteredItems: SettingItem[];
    selectedIndex: number;
    searchEnabled: boolean;
    searchInput?: {
        getValue(): string;
    };
};
export declare function get_selected_setting(list: SettingsList): SettingItem | undefined;
export declare function has_active_settings_search(list: SettingsList): boolean;
export declare function cycle_setting_value(item: SettingItem | undefined, direction: -1 | 1): string | undefined;
export declare function make_settings_theme(theme: ModalTheme): SettingsListTheme;
export declare function is_focusable(value: unknown): value is Focusable;
