// Bun --preload used by subprocess tests: makes only [VERBOSE] console output throw, so
// execution-path verbose logging fails deterministically while normal output still works.
export {};
const original = console.log;
console.log = ((...args: unknown[]) => {
    if (args[0] === "[VERBOSE]") throw new Error("injected verbose output failure");
    return original.apply(console, args as []);
}) as typeof console.log;
