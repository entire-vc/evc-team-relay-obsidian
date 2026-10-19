# OAuth Component Tests

This directory contains comprehensive unit tests for the OAuth authentication system in the relay-obsidian-plugin.

## Test Files

### 1. OAuthCallbackServer.test.ts
Tests for the local HTTP callback server that receives OAuth redirects.

**Coverage:**
- P1: Server starts on random port
- P2: Server stops cleanly
- P3: Callback with code+state resolves correctly
- P4: Callback without code rejects
- P5: Timeout triggers rejection
- P6: Double stop doesn't crash

**Additional edge cases:**
- waitForCallback() fails if server not started
- Callback without state rejects
- Multiple callbacks only resolve first one
- Stop during waitForCallback cleans up

### 2. OAuthHandler.test.ts
Tests for OAuth flow orchestration with mocked dependencies.

**Coverage:**
- P7: prepareOAuthFlow calls authorize endpoint correctly
- P8: prepareOAuthFlow error stops callback server
- P9: prepareOAuthFlow without authorize_url in response
- P10: waitForCallbackAndExchange parses response correctly
- P11: waitForCallbackAndExchange includes refresh_token
- P12: waitForCallbackAndExchange handles callback error
- P13: completeOAuthFlow chains prepare+browser+exchange
- P14: URL normalization (trailing slashes)
- P15: Cleanup on error

**Additional tests:**
- Exchange API error handling
- Fails if prepareOAuthFlow not called first
- Opens browser with correct URL
- destroy() can be called multiple times

### 3. RelayOnPremAuthProvider.test.ts
Tests for the main authentication provider with mocked fetch and localStorage.

**Coverage:**
- P16: loginWithPassword success flow
- P17: loginWithPassword error clears auth
- P18: loginWithOAuth2 stores refresh_token (regression test)
- P19: loginWithOAuth2 error clears auth
- P20: refreshToken with refresh_token
- P21: refreshToken without refresh_token (legacy)
- P22: refreshToken error clears auth
- P23: restoreAuth with valid token
- P24: restoreAuth with expired token + refresh
- P25: restoreAuth with expired + no refresh clears
- P26: restoreAuth with corrupted data
- P27: isTokenValid 5-minute buffer
- P28: logout success
- P29: logout network error still clears
- P30: persistAuth saves correctly

**Additional tests:**
- Saves auth to localStorage on success
- Opens browser with window.open
- Throws if no active session on refresh
- URL normalization for trailing slashes

### 4. RelayOnPremAuthStore.test.ts
Tests for localStorage persistence layer.

**Coverage:**
- P31: save and load roundtrip
- P32: Key format: evc-team-relay_onprem_auth_{vault}_{server}
- P33: clear removes data
- P34: clearAll removes all servers for vault
- P35: localStorage unavailable uses fallback
- P36: JSON parse error returns null
- P37: Singleton pattern per vault
- P38: getStoredServerIds lists servers

**Additional tests:**
- Load returns null if data incomplete
- Different vaults have separate storage
- Different servers have separate storage
- Clear specific server doesn't affect others
- ClearAll doesn't affect other vaults
- hasAuthData returns correct values
- RefreshToken field handling

## Test Statistics

- **Total Tests**: 70
- **Test Suites**: 4
- **All Passing**: ✅

## Running Tests

Run all OAuth tests:
```bash
npm test -- __tests__/auth
```

Run specific test file:
```bash
npm test -- __tests__/auth/OAuthCallbackServer.test.ts
```

Run specific test:
```bash
npm test -- __tests__/auth/OAuthCallbackServer.test.ts -t "P1"
```

## Mocking Strategy

### customFetch
Mocked at module level to avoid actual HTTP requests:
```typescript
jest.mock("../../src/platformFetch");
```

### localStorage
Mocked using Map to simulate browser storage:
```typescript
const mockStorage = new Map<string, string>();
Object.defineProperty(global, "window", {
  value: {
    localStorage: {
      getItem: (key: string) => mockStorage.get(key) ?? null,
      setItem: (key: string, value: string) => mockStorage.set(key, value),
      // ...
    }
  }
});
```

### OAuthCallbackServer (for OAuthHandler tests)
Mocked to avoid starting real HTTP servers:
```typescript
jest.mock("../../src/auth/OAuthCallbackServer");
```

### OAuthHandler (for RelayOnPremAuthProvider tests)
Mocked to avoid complex OAuth flow in unit tests:
```typescript
jest.mock("../../src/auth/OAuthHandler");
```

## Test Patterns

### Async/Await
All async operations use async/await:
```typescript
test("example", async () => {
  const result = await asyncOperation();
  expect(result).toBe(expected);
});
```

### Promise Rejection
Rejection tests use `expect().rejects.toThrow()`:
```typescript
await expect(operation()).rejects.toThrow("error message");
```

### Cleanup
Tests clean up after themselves:
```typescript
afterEach(() => {
  server.stop();
  mockStorage.clear();
});
```

## Notes

- OAuthCallbackServer tests use real Node.js HTTP module for integration testing
- All other components use mocked dependencies for fast, isolated unit tests
- localStorage fallback behavior is tested for Obsidian mobile compatibility
- URL normalization is tested to prevent double-slash issues in API calls
- Token expiration buffer (5 minutes) is tested to ensure tokens are refreshed proactively
