// Preload for subprocess tests: any network call fails the process with exit 99.
globalThis.fetch = (async (input: unknown) => {
    process.stderr.write(`FETCH_TRAP ${String((input as { toString(): string })?.toString?.() ?? input)}\n`);
    process.exit(99);
}) as unknown as typeof fetch;
