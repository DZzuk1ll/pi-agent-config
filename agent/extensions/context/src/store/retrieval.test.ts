import { describe, expect, it } from 'vitest';
import { create_context_store } from '../../test/support.js';
import type { ContextStore } from '../store.js';
import {
	context_store_chunk_summary,
	context_store_get,
} from './retrieval.js';
import { requirePresent } from "../../../_shared/runtime/require-present.ts";


function create_store(): ContextStore {
	return create_context_store(
		{ max_bytes: 10 },
		'pi-context-retrieval-',
	);
}

describe('context store retrieval helpers', () => {
	it('summarizes chunks and resolves numeric chunk references', () => {
		const store = create_store();
		const stored = store.store({
			text: `needle-retrieval\n${'x '.repeat(5000)}`,
			tool_name: 'bash',
		});

		const summary = context_store_chunk_summary(
			store,
			requirePresent(stored).source_id,
		);
		expect(summary?.chunk_count).toBe(requirePresent(stored).chunk_count);
		expect(summary?.first_chunk_id).toBe(requirePresent(stored).first_chunk_id);

		const first = context_store_get(store, requirePresent(stored).source_id, '1');
		expect(first).toHaveLength(1);
		expect(requirePresent(first[0]).id).toBe(requirePresent(stored).first_chunk_id);
	});
});
