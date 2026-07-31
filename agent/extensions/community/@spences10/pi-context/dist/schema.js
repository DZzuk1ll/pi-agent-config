import { SQLITE_CONNECTION_PRAGMAS, SQLITE_PERSISTENT_PRAGMAS, with_sqlite_transaction, } from '@spences10/pi-sqlite-core';
import { readFileSync } from 'node:fs';
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const LATEST_CONTEXT_SCHEMA_VERSION = 1;
const PERSISTENT_PRAGMAS = SQLITE_PERSISTENT_PRAGMAS;
const CONNECTION_PRAGMAS = SQLITE_CONNECTION_PRAGMAS;
const MIGRATIONS = {
    1: SCHEMA,
};
function get_user_version(db) {
    const row = db.prepare('PRAGMA user_version').get();
    return row.user_version;
}
export function apply_schema(db) {
    db.exec(PERSISTENT_PRAGMAS);
    db.exec(CONNECTION_PRAGMAS);
    const current_version = get_user_version(db);
    if (current_version > LATEST_CONTEXT_SCHEMA_VERSION) {
        db.close();
        throw new Error(`Context database schema version ${current_version} is newer than supported version ${LATEST_CONTEXT_SCHEMA_VERSION}`);
    }
    for (let next_version = current_version + 1; next_version <= LATEST_CONTEXT_SCHEMA_VERSION; next_version++) {
        const migration = MIGRATIONS[next_version];
        if (!migration) {
            db.close();
            throw new Error(`Missing context migration for schema version ${next_version}`);
        }
        try {
            with_sqlite_transaction(db, () => {
                db.exec(migration);
                db.exec(`PRAGMA user_version = ${next_version}`);
            }, { operation: 'Apply context schema migration', retry: false });
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
}
//# sourceMappingURL=schema.js.map