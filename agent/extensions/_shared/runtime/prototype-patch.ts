export type PrototypeMethod = (this: any, ...args: any[]) => any;

interface PatchLayer {
	name: string;
	order: number;
	token: symbol;
	wrap?: (next: PrototypeMethod) => PrototypeMethod;
	override?: PrototypeMethod;
}

interface PatchEntry {
	original: PrototypeMethod;
	current: PrototypeMethod;
	layers: Map<string, PatchLayer>;
}

interface PatchStore {
	targets: WeakMap<object, Map<PropertyKey, PatchEntry>>;
	warnings: Set<string>;
}

const STORE_KEY = Symbol.for("@personal-pi/prototype-patch-registry:v1");

function store(): PatchStore {
	const existing = Reflect.get(globalThis, STORE_KEY);
	if (existing) return existing as PatchStore;
	const created: PatchStore = { targets: new WeakMap(), warnings: new Set() };
	Reflect.set(globalThis, STORE_KEY, created);
	return created;
}

function warnOnce(key: string, message: string): void {
	const warnings = store().warnings;
	if (warnings.has(key)) return;
	warnings.add(key);
	console.warn(message);
}

function rebuild(target: object, method: PropertyKey, entry: PatchEntry): void {
	let current = entry.original;
	const layers = [...entry.layers.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	for (const layer of layers) current = layer.override ?? layer.wrap?.(current) ?? current;
	entry.current = current;
	Reflect.set(target, method, current);
}

export interface PrototypePatchOptions {
	name: string;
	order?: number;
	wrap?: (next: PrototypeMethod) => PrototypeMethod;
	override?: PrototypeMethod;
	warningKey?: string;
}

/** Install or replace a named prototype method layer. The disposer is reload-safe. */
export function registerPrototypePatch(
	target: object,
	method: PropertyKey,
	options: PrototypePatchOptions,
): () => void {
	if (!options.wrap && !options.override) throw new Error(`Prototype patch '${options.name}' has no implementation`);
	const registry = store();
	let methods = registry.targets.get(target);
	if (!methods) {
		methods = new Map();
		registry.targets.set(target, methods);
	}
	let entry = methods.get(method);
	if (!entry) {
		const original = Reflect.get(target, method);
		if (typeof original !== "function") {
			const targetName = Reflect.get(target, "constructor")?.name ?? "prototype";
			warnOnce(
				options.warningKey ?? `${targetName}.${String(method)}`,
				`[prototype-patch] ${targetName}.${String(method)} is unavailable; skipped '${options.name}'.`,
			);
			return () => {};
		}
		entry = { original, current: original, layers: new Map() };
		methods.set(method, entry);
	}
	const token = Symbol(options.name);
	entry.layers.set(options.name, { ...options, order: options.order ?? 0, token });
	rebuild(target, method, entry);
	return () => {
		const currentEntry = methods?.get(method);
		if (!currentEntry || currentEntry.layers.get(options.name)?.token !== token) return;
		currentEntry.layers.delete(options.name);
		if (currentEntry.layers.size > 0) rebuild(target, method, currentEntry);
		else {
			Reflect.set(target, method, currentEntry.original);
			methods?.delete(method);
		}
	};
}
