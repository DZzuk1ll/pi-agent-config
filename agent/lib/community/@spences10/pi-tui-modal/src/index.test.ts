import { describe, expect, it } from 'vitest';

describe('packages/pi-tui-modal/src/index.ts', () => {
	it('loads without side effects', async () => {
		await expect(import('./index.js')).resolves.toBeDefined();
	});
});
