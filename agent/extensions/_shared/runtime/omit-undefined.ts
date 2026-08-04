type UndefinedKeys<T extends object> = {
	[K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

export type WithoutUndefined<T extends object> =
	& { -readonly [K in Exclude<keyof T, UndefinedKeys<T>>]: MutableArray<T[K]> }
	& { -readonly [K in UndefinedKeys<T>]?: MutableArray<Exclude<T[K], undefined>> };

type MutableArray<T> = T extends readonly unknown[] ? [...T] : T;

type OptionalUndefinedInput<T extends object> = {
	[K in keyof T]: Record<never, never> extends Pick<T, K> ? T[K] | undefined : T[K];
};

/** Clone an options/DTO object while truly omitting keys whose value is undefined. */
export function omitUndefined<const T extends object>(value: T): WithoutUndefined<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as WithoutUndefined<T>;
}

/** Build a known DTO while accepting undefined only for keys that are actually optional. */
export function omitUndefinedAs<T extends object>(value: OptionalUndefinedInput<T>): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}
