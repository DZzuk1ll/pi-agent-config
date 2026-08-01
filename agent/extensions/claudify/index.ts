import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerClaudify from "./extensions/index.ts";
import registerSpinner from "./extensions/spinner.ts";

/** Register the transcript/UI customization before its coordinated spinner. */
export default function claudify(pi: ExtensionAPI): void {
	registerClaudify(pi);
	registerSpinner(pi);
}
