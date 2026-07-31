import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { type TUI } from '@earendil-works/pi-tui';
import type { ConfirmModalOptions, InputModalOptions, ModalBody, ModalControls, ModalLayout, ModalOptions, ModalTheme, PickerModalOptions, SettingsModalOptions, TextModalOptions } from './types.js';
type ModalCommandContext = {
    ui: Pick<ExtensionCommandContext['ui'], 'custom' | 'notify'>;
};
export declare function show_modal<T>(ctx: ModalCommandContext, options: ModalOptions, create_body: (controls: ModalControls<T>, theme: ModalTheme, layout: ModalLayout, tui: TUI) => ModalBody): Promise<T>;
export declare function show_picker_modal(ctx: ModalCommandContext, options: PickerModalOptions): Promise<string | undefined>;
export declare function show_text_modal(ctx: ModalCommandContext, options: TextModalOptions): Promise<void>;
export declare function show_command_output_modal(ctx: ModalCommandContext, options: TextModalOptions): Promise<void>;
export declare function show_input_modal(ctx: ModalCommandContext, options: InputModalOptions): Promise<string | undefined>;
export declare function show_confirm_modal(ctx: ModalCommandContext, options: ConfirmModalOptions): Promise<boolean>;
export declare function show_settings_modal(ctx: ModalCommandContext, options: SettingsModalOptions): Promise<void>;
export {};
