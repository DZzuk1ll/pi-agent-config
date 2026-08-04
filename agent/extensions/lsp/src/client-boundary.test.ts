import { describe, expect, it } from 'vitest';
import { isLspDiagnostic } from './client.js';

const diagnostic = {
	range: {
		start: { line: 0, character: 1 },
		end: { line: 0, character: 2 },
	},
	severity: 1,
	message: 'problem',
};

describe('LSP diagnostic boundary', () => {
	it('accepts valid diagnostics', () => {
		expect(isLspDiagnostic(diagnostic)).toBe(true);
	});

	it('rejects coerced severity and invalid positions', () => {
		expect(isLspDiagnostic({ ...diagnostic, severity: '1' })).toBe(false);
		expect(isLspDiagnostic({ ...diagnostic, range: { ...diagnostic.range, start: { line: '0', character: 1 } } })).toBe(false);
		expect(isLspDiagnostic({ ...diagnostic, range: { ...diagnostic.range, start: { line: Number.NaN, character: 1 } } })).toBe(false);
	});
});
