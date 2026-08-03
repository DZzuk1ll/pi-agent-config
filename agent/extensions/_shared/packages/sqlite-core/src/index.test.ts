import { describe, expect, it } from "vitest";
import { SqliteBusyError, is_sqlite_busy, sqlite_pragmas, with_sqlite_busy_retry, with_sqlite_transaction } from "./index.ts";

const busy = { code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" };

describe("personal sqlite core", () => {
	it("builds pragmas and retries busy work", () => {
		expect(sqlite_pragmas({ foreign_keys: false, busy_timeout_ms: 10 }).connection).toBe("PRAGMA busy_timeout = 10;");
		expect(is_sqlite_busy(busy)).toBe(true);
		let attempts = 0;
		expect(with_sqlite_busy_retry(() => {
			attempts++;
			if (attempts < 3) throw busy;
			return "ok";
		}, { attempts: 3, delay_ms: 0 })).toBe("ok");
		expect(() => with_sqlite_busy_retry(() => { throw busy; }, { attempts: 1, delay_ms: 0, operation: "Write" })).toThrow(SqliteBusyError);
	});

	it("commits successful transactions and rolls back failures", () => {
		const sql: string[] = [];
		const db = { exec(statement: string) { sql.push(statement); } };
		expect(with_sqlite_transaction(db, () => 42, { immediate: true })).toBe(42);
		expect(sql).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
		sql.length = 0;
		expect(() => with_sqlite_transaction(db, () => { throw new Error("fail"); }, { retry: false })).toThrow("fail");
		expect(sql).toEqual(["BEGIN", "ROLLBACK"]);
	});
});
