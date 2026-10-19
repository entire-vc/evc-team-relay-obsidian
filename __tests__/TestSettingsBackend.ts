import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import { MockClock } from "./mocks/MockClock";
import { SettingsScope, Settings } from "../src/SettingsPersistence";
import { NotificationDispatcher } from "../src/notifiers/NotificationDispatcher";

interface TestData {
	foo: string;
	count: number;
}

/**
 * A simple in-memory storage adapter for testing purposes.
 * Implements the PluginDataFile interface expected by SettingsPersistence.
 */
export class MemoryStorageAdapter<T> {
	private data: T | null = null;

	async loadData(): Promise<T | null> {
		return this.data;
	}

	async saveData(data: T): Promise<void> {
		this.data = data;
	}
}

describe("SettingsScope", () => {
	let mockTime: MockClock;
	let storage: MemoryStorageAdapter<Record<string, any>>;
	let settings: Settings<Record<string, any>>;
	let listener: Mock;

	beforeEach(async () => {
		// Initialize the mock time provider and post office for simulating time-based events
		mockTime = new MockClock();
		NotificationDispatcher.shutdown();
		// @ts-ignore - accessing private constructor for testing
		NotificationDispatcher["current"] = new NotificationDispatcher(mockTime);
		NotificationDispatcher["_shutDown"] = false;

		// Set up the in-memory storage and settings instance
		storage = new MemoryStorageAdapter();
		settings = new Settings(storage, {});
		await settings.hydrate();

		// Set up a mock listener function for subscription testing
		listener = jest.fn();
	});

	test("returns empty object when path does not exist", () => {
		/**
		 * Tests that the SettingsScope returns an empty object when the specified path is not found in the settings.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		expect(namespaced.readValue()).toEqual({});
	});

	test("handles slash-separated paths", async () => {
		/**
		 * Tests that the SettingsScope correctly handles paths separated by slashes `/`.
		 * Sets a value at a deeply nested path and verifies that it is stored correctly within the settings.
		 */
		const nested = new SettingsScope(settings, "deeply/nested/path");
		await nested.writeValue({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			deeply: {
				nested: {
					path: { foo: "test", count: 1 },
				},
			},
		});
	});

	test("sets and gets nested value", async () => {
		/**
		 * Tests setting and retrieving a nested value within the settings.
		 * Verifies that the data is correctly stored and can be retrieved via the SettingsScope instance.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		const testData: TestData = {
			foo: "bar",
			count: 42,
		};

		await namespaced.writeValue(testData);
		mockTime.setTime(mockTime.now() + 30);

		expect(namespaced.readValue()).toEqual(testData);
		expect(settings.snapshot()).toEqual({
			test: {
				path: testData,
			},
		});
	});

	test("handles multiple nested paths", async () => {
		/**
		 * Tests setting values at multiple nested paths within the settings.
		 * Verifies that each path maintains its own data, and the settings object reflects both changes.
		 */
		const path1 = new SettingsScope(settings, "a/b/c");
		const path2 = new SettingsScope(settings, "a/b/d");

		await path1.writeValue({ foo: "path1", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		await path2.writeValue({ foo: "path2", count: 2 });
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			a: {
				b: {
					c: { foo: "path1", count: 1 },
					d: { foo: "path2", count: 2 },
				},
			},
		});
	});

	test("updates nested value", async () => {
		/**
		 * Tests updating an existing nested value within the settings.
		 * Uses the update method to modify a specific property and verifies the change.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		await namespaced.writeValue({ foo: "initial", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		await namespaced.mutateValue((current) => ({
			...current,
			count: current.count + 1,
		}));
		mockTime.setTime(mockTime.now() + 30);

		expect(namespaced.readValue()).toEqual({
			foo: "initial",
			count: 2,
		});
	});

	test("parentScope returns parent namespace", async () => {
		/**
		 * Tests retrieving the parent namespace of a SettingsScope instance.
		 * Verifies that changes in the child are reflected in the parent's data.
		 */
		const child = new SettingsScope(settings, "parent/child");
		const parent = child.parentScope();

		await child.writeValue({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		expect(parent.readValue()).toEqual({
			child: { foo: "test", count: 1 },
		});
	});

	test("childScope returns child namespace", async () => {
		/**
		 * Tests retrieving a child namespace from a parent SettingsScope instance.
		 * Verifies that the child can set values that are stored under the parent path.
		 */
		const parent = new SettingsScope(settings, "parent");
		const child = parent.childScope<TestData>("child");

		await child.writeValue({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			parent: {
				child: { foo: "test", count: 1 },
			},
		});
	});

	test("exists returns true for existing path", async () => {
		/**
		 * Tests the exists method to confirm it returns true when the path exists in the settings.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		await namespaced.writeValue({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		expect(namespaced.hasValue()).toBe(true);
	});

	test("exists returns false for non-existing path", () => {
		/**
		 * Tests the exists method to confirm it returns false when the path does not exist in the settings.
		 */
		const namespaced = new SettingsScope(settings, "non/existing/path");

		expect(namespaced.hasValue()).toBe(false);
	});

	test("delete removes value", async () => {
		/**
		 * Tests the delete method to ensure it removes the specified value from the settings.
		 * Verifies that after deletion, exists returns false and get returns an empty object.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		await namespaced.writeValue({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		await namespaced.delete();
		mockTime.setTime(mockTime.now() + 30);

		expect(namespaced.hasValue()).toBe(false);
		expect(namespaced.readValue()).toEqual({});
	});

	test("notifies listeners on set with array pattern match", async () => {
		/**
		 * Tests that listeners subscribed to a SettingsScope instance are notified upon setting a new value.
		 * Verifies that the listener function is called with the updated value.
		 */
		const namespaced = new SettingsScope(
			settings,
			"test/[guid=123]/settings",
		);
		namespaced.subscribe(listener);

		console.log(namespaced.readValue());

		await namespaced.writeValue({
			foo: "new",
			count: 2,
		});
		mockTime.setTime(mockTime.now() + 30);

		// Called once upon subscription and once after setting a new value
		expect(listener).toHaveBeenCalledTimes(2);
		expect(namespaced.readValue()).toEqual({
			foo: "new",
			count: 2,
		});
	});
	test("notifies listeners on set with pattern match", async () => {
		/**
		 * Tests that listeners subscribed to a SettingsScope instance are notified upon setting a new value.
		 * Verifies that the listener function is called with the updated value.
		 */
		const namespaced = new SettingsScope(settings, "(debugging)");
		namespaced.subscribe(listener);

		console.log(namespaced.readValue());

		await namespaced.writeValue({
			debugging: true,
		});
		mockTime.setTime(mockTime.now() + 30);

		await namespaced.writeValue({
			debugging: false,
		});
		mockTime.setTime(mockTime.now() + 30);
		// Called once upon subscription and once after setting a new value
		expect(listener).toHaveBeenCalledTimes(3);
		expect(namespaced.readValue()).toEqual({
			debugging: false,
		});
	});

	test("unsubscribe stops notifications", async () => {
		/**
		 * Tests that unsubscribing a listener stops it from receiving further notifications.
		 * Verifies by setting a new value after unsubscribing and checking that the listener is not called again.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		const unsubscribe = namespaced.subscribe(listener);
		unsubscribe();

		await namespaced.writeValue({
			foo: "new",
			count: 42,
		});
		mockTime.setTime(mockTime.now() + 30);

		// Only called once upon initial subscription
		expect(listener).toHaveBeenCalledTimes(1);
	});

	test("handles pattern matching syntax for array items", async () => {
		/**
		 * Tests that SettingsScope can handle array item selection using pattern matching syntax.
		 * Sets a value in an array where items are matched based on a key-value pair.
		 * Verifies that the data is stored correctly within the array.
		 */
		const listItem = new SettingsScope(settings, "folders/[guid=123]");

		const itemSettings = listItem.childScope<{ foo: string; count: number }>(
			"settings",
		);

		// Clear any existing data
		await settings.mutate(() => ({}));

		// Set the new value and wait for it to be processed
		await itemSettings.writeValue({ foo: "test", count: 1 });
		await settings.persist();

		// Force update notification
		await settings.mutate((current) => ({ ...current }));
		mockTime.setTime(mockTime.now() + 30);

		// Now check both the raw settings and the namespaced view
		expect(settings.snapshot()).toEqual({
			folders: [{ guid: "123", settings: { foo: "test", count: 1 } }],
		});

		const result = itemSettings.readValue();
		expect(result).toEqual({
			foo: "test",
			count: 1,
		});

		const itemSettingsDirect = new SettingsScope(
			settings,
			"folders/[guid=123]/settings",
		);
		const directResult = itemSettingsDirect.readValue();
		expect(directResult).toEqual({
			foo: "test",
			count: 1,
		});
	});

	test("updates existing array item when using pattern matching", async () => {
		/**
		 * Tests updating an existing item within an array using pattern matching syntax.
		 * Ensures that the correct item is updated and others remain unchanged.
		 */
		// Clear any existing data
		await settings.mutate(() => ({}));

		// Set up initial state
		await settings.mutate(() => ({
			folders: [
				{ guid: "123", settings: { foo: "initial", count: 0 } },
				{ guid: "456", settings: { foo: "other", count: 2 } },
			],
		}));
		await settings.persist();
		mockTime.setTime(mockTime.now() + 30);

		const listItem = new SettingsScope(
			settings,
			"folders/[guid=123]/settings",
		);

		// Update the item and wait for processing
		await listItem.writeValue({ foo: "updated", count: 1 });
		await settings.persist();

		// Force update notification
		await settings.mutate((current) => ({ ...current }));
		mockTime.setTime(mockTime.now() + 30);

		// Check both raw settings and namespaced view
		expect(settings.snapshot()).toEqual({
			folders: [
				{ guid: "123", settings: { foo: "updated", count: 1 } },
				{ guid: "456", settings: { foo: "other", count: 2 } },
			],
		});

		const result = listItem.readValue();
		expect(result).toEqual({
			foo: "updated",
			count: 1,
		});
	});

	test("deletes array item when using pattern matching", async () => {
		/**
		 * Tests deleting an item from an array using pattern matching syntax.
		 * Verifies that the correct item is removed and others remain unaffected.
		 */
		await settings.mutate((current) => ({
			...current,
			folders: [
				{ guid: "123", foo: "test", count: 1 },
				{ guid: "456", foo: "other", count: 2 },
			],
		}));
		mockTime.setTime(mockTime.now() + 30);

		const listItem = new SettingsScope(settings, "folders/[guid=123]");

		await listItem.delete();
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			folders: [{ guid: "456", foo: "other", count: 2 }],
		});
	});

	test("handles current level wildcard pattern matching", async () => {
		/**
		 * Tests that SettingsScope can handle wildcard pattern matching at the current level.
		 * Retrieves all keys that match the wildcard pattern and verifies the result.
		 */
		await settings.mutate((current) => ({
			...current,
			"test-1": 3,
			"test-2": 4,
			other: 5,
		}));
		mockTime.setTime(mockTime.now() + 30);

		const testSettings = new SettingsScope(settings, "(test-*)");
		expect(testSettings.readValue()).toEqual({
			"test-1": 3,
			"test-2": 4,
		});
	});

	test("sets values using wildcard pattern matching", async () => {
		/**
		 * Tests setting values using wildcard pattern matching.
		 * Verifies that the intended keys are set while others remain unchanged.
		 */
		const testSettings = new SettingsScope(settings, "(feature-*)");
		await testSettings.writeValue({
			"feature-1": true,
			"feature-2": false,
			"not-matching": "should be ignored",
		});
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			"feature-1": true,
			"feature-2": false,
		});
	});

	test("childScope with pattern matching", async () => {
		/**
		 * Tests retrieving a child SettingsScope when the parent uses pattern matching.
		 * Ensures that child paths are correctly resolved and can set values.
		 */
		const parent = new SettingsScope(settings, "parent/*");
		const child = parent.childScope<TestData>("child");

		await child.writeValue({ foo: "value", count: 10 });
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			parent: {
				"*": {
					child: { foo: "value", count: 10 },
				},
			},
		});
	});

	test("throws error when setting undefined value", async () => {
		/**
		 * Tests that an error is thrown when attempting to set an undefined value.
		 */
		const namespaced = new SettingsScope(settings, "test/path");

		await expect(
			namespaced.writeValue(undefined as unknown as TestData),
		).rejects.toThrow("refusing to store an undefined value");
	});

	test("destroyed SettingsScope throws error on use", () => {
		/**
		 * Tests that a destroyed SettingsScope instance throws an error when methods are called.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		namespaced.destroy();

		expect(() => namespaced.readValue()).toThrow("settings instance was already destroyed");
		expect(() => namespaced.writeValue({ foo: "test", count: 1 })).rejects.toThrow(
			"settings instance was already destroyed",
		);
		expect(() => namespaced.hasValue()).toThrow("settings instance was already destroyed");
		expect(() => namespaced.delete()).rejects.toThrow(
			"settings instance was already destroyed",
		);
		expect(() => namespaced.subscribe(listener)).toThrow(
			"settings instance was already destroyed",
		);
	});

	test("handles empty settings object", () => {
		/**
		 * Tests that SettingsScope can handle an empty settings object without errors.
		 */
		const emptySettings = new SettingsScope(settings, "empty/path");
		expect(emptySettings.readValue()).toEqual({});
	});

	test("flush forces update", async () => {
		/**
		 * Tests the flush method, which forces an update notification to listeners.
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		namespaced.subscribe(listener);

		await namespaced.forceNotify();
		mockTime.setTime(mockTime.now() + 30);

		// Called once upon subscription and once after flush
		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("scopePath returns correct path", () => {
		/**
		 * Tests that scopePath returns the accurate path string used by the SettingsScope.
		 */
		const namespaced = new SettingsScope(settings, "some/nested/path");
		expect(namespaced.scopePath()).toEqual("some/nested/path");
	});

	test("does not overwrite existing settings when setting new namespace", async () => {
		/**
		 * Tests that setting a new SettingsScope does not overwrite unrelated existing settings.
		 */
		await settings.mutate(() => ({
			existing: {
				data: true,
			},
		}));
		mockTime.setTime(mockTime.now() + 30);

		const namespaced = new SettingsScope(settings, "new/namespace");
		await namespaced.writeValue({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.now() + 30);

		expect(settings.snapshot()).toEqual({
			existing: {
				data: true,
			},
			new: {
				namespace: {
					foo: "test",
					count: 1,
				},
			},
		});
	});

	test("updates listeners when settings change externally", async () => {
		/**
		 * Tests that listeners are notified when the underlying settings change externally (not through the SettingsScope instance).
		 */
		const namespaced = new SettingsScope(settings, "test/path");
		namespaced.subscribe(listener);

		await settings.mutate((current) => ({
			...current,
			test: {
				path: { foo: "external", count: 99 },
			},
		}));
		mockTime.setTime(mockTime.now() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(namespaced.readValue()).toEqual({
			foo: "external",
			count: 99,
		});
	});
});
