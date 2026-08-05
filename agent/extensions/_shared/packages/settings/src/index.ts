import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

export const MyPiSettingsFileSchema = Type.Object({
	version: Type.Literal(1, { default: 1 }),
	extensions: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Record(Type.String(), Type.Boolean(), { default: {} })),
	}, { additionalProperties: false, default: { enabled: {} } })),
	mcp: Type.Optional(Type.Object({ policy: Type.Optional(Type.Unknown()) }, { additionalProperties: false })),
	codingPreferences: Type.Optional(Type.Unknown()),
	promptPresets: Type.Optional(Type.Object({
		global: Type.Optional(Type.Unknown()),
		state: Type.Optional(Type.Unknown()),
	}, { additionalProperties: false })),
	trust: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { default: {} })),
	packages: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { default: {} })),
}, { additionalProperties: false });

export type MyPiSettingsFile = Static<typeof MyPiSettingsFileSchema>;

export function get_settings_path(): string {
	return join(getAgentDir(), 'my-pi-settings.json');
}

function default_settings(): MyPiSettingsFile {
	return {
		version: 1,
		extensions: { enabled: {} },
		trust: {},
		packages: {},
	};
}

function as_record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function read_settings_record(): Record<string, unknown> {
	const path = get_settings_path();
	if (!existsSync(path)) return { version: 1 };
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Invalid settings object in '${path}'.`);
	}
	return parsed as Record<string, unknown>;
}

export function read_settings(): MyPiSettingsFile {
	try {
		const parsed = read_settings_record();
		const defaulted = Value.Default(MyPiSettingsFileSchema, Value.Clone(parsed));
		const cleaned = Value.Clean(MyPiSettingsFileSchema, defaulted);
		return Value.Check(MyPiSettingsFileSchema, cleaned) ? cleaned : default_settings();
	} catch {
		return default_settings();
	}
}

function write_settings_record(settings: Record<string, unknown>): void {
	const path = get_settings_path();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp-${Date.now()}`;
	writeFileSync(
		tmp,
		`${JSON.stringify(settings, null, '\t')}\n`,
		{ mode: 0o600 },
	);
	renameSync(tmp, path);
}

export function write_settings(settings: MyPiSettingsFile): void {
	write_settings_record({ ...settings, version: 1 });
}

export function extract_input_strings(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value))
		return value.flatMap(extract_input_strings);
	if (!value || typeof value !== 'object') return [];
	return Object.values(value as Record<string, unknown>).flatMap(
		extract_input_strings,
	);
}

export function read_package_settings(name: string): unknown {
	try {
		return as_record(read_settings_record().packages)[name];
	} catch {
		return undefined;
	}
}

export function write_package_settings(
	name: string,
	value: unknown,
): void {
	const settings = read_settings_record();
	write_settings_record({
		...settings,
		packages: { ...as_record(settings.packages), [name]: value },
	});
}

export function read_trust_settings(name: string): unknown {
	try {
		return as_record(read_settings_record().trust)[name];
	} catch {
		return undefined;
	}
}

export function write_trust_settings(
	name: string,
	value: unknown,
): void {
	const settings = read_settings_record();
	write_settings_record({
		...settings,
		trust: { ...as_record(settings.trust), [name]: value },
	});
}
