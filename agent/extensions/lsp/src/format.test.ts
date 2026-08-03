import { describe, expect, it } from 'vitest';
import {
	format_diagnostics,
	format_hover,
} from './format.js';

const range = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 1 },
};

describe('lsp format helpers', () => {
	it('formats diagnostics compactly', () => {
		expect(
			format_diagnostics('/tmp/file.ts', [
				{
					range,
					severity: 1,
					source: 'ts',
					code: 2322,
					message: 'Type mismatch',
				},
			]),
		).toContain('1:1 error [ts] (2322): Type mismatch');
	});

	it('formats empty hover results consistently', () => {
		expect(format_hover(null)).toBe('No hover info.');
		expect(format_hover({ contents: { value: ' docs ' } })).toBe(
			'docs',
		);
	});

});
