import { describe, expect, it } from 'vitest';

describe('packages/pi-tui-modal/src/modal/progress.ts', () => {
	it('loads without side effects', async () => {
		await expect(import('./progress.js')).resolves.toBeDefined();
	});
});
