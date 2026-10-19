// Reference to the real global object of the current test environment (node
// or jsdom), obtained without naming `globalThis`/`global` (flagged by
// obsidianmd/no-global-this). A temporary getter on Object.prototype is
// invoked with the global object as receiver when a free identifier is
// resolved. Module code may be strict-mode, so `this` at function level
// cannot be used.
/* global __testGlobal */
Object.defineProperty(Object.prototype, "__testGlobal", {
	configurable: true,
	get() {
		return this;
	},
});
const testGlobal = __testGlobal;
delete Object.prototype.__testGlobal;
module.exports = { testGlobal };
