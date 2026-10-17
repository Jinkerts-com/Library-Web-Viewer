// Bun --preload used by subprocess tests: makes the error reporter used by generateThumbnail's
// own error handling throw, to prove that reporting failure cannot turn a skip into an item error.
export {};
const original = console.error;
console.error = ((...args: unknown[]) => {
    if (String(args[0]).startsWith("Error processing thumbnail")) throw new Error("injected reporter failure");
    return original.apply(console, args as []);
}) as typeof console.error;
