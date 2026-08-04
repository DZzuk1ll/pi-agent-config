/** Return a value known to be present, or fail at the violated invariant. */
export function requirePresent<T>(value: T): NonNullable<T> {
	if (value === undefined || value === null) {
		throw new Error("Invariant violation: expected a present value");
	}
	return value;
}
