# Changelog

## v1.3.0 (2026-04-27)

### Critical fix — connector wedge auto-recovery (bug #19)

The 1.2.x line could wedge into a permanent `"Can not re-use ImapFlow instance"` state — every subsequent tool call failing the same way until the user manually restarted the MCP. Two paths into this state were observed: parallel tool calls fighting for the shared client, and extended serial use over hours where the IMAP socket eventually drops and the client lands in a closed-not-yet-rebuilt state.

The root cause was that `ensureConnected()` would call `connect()` on a closed `ImapFlow` instance — and `imapflow` throws "Can not re-use ImapFlow instance" rather than reopening the socket. The connector then surfaced that error verbatim and stayed wedged.

- **`doConnect()` now rebuilds the underlying `ImapFlow` instance** before calling `connect()` whenever the existing instance is no longer `usable`. This handles the long-session decay path and the post-close revival path uniformly.
- **New `withRetry()` wrapper** around every IMAP-using public method. If an in-flight operation fails because the instance is wedged (matches "Can not re-use", "not connected", "connection closed", "connection ended", or "socket closed"), the wrapper force-rebuilds the client and retries the operation exactly once. Other errors propagate immediately. Callers no longer see the wedge.
- **`check_config`** auto-heals as a side effect: it already calls `ensureConnected()`, which now rebuilds dead clients.

### Move/delete count verification (bug #20)

Field reports observed destination folders growing by more than the source dropped — strong-suggestion of retry double-counting or non-atomic MOVE under timeout. To make any drift visible, both `move_messages` and `delete_messages` now capture mailbox totals before and after the operation and surface the deltas in the response.

- **`move_messages`** returns a `counts` object with `{ expected, sourceBefore, sourceAfter, sourceDelta, destBefore, destAfter, destDelta }`, plus a `countWarning` string when either delta differs from `expected` by more than 5 (the tolerance accounts for newly arriving mail).
- **`delete_messages`** returns the same shape minus the destination fields.
- New optional **`verifyCounts: boolean`** parameter (default `true`). Disable when chaining many moves to save 4 STATUS round-trips per call.

### `auto_organize` — time budget + partial progress

Previously, `auto_organize` would silently die at the MCP-client 60s wall and leave callers no way to know which rules ran. Now:

- New optional **`timeBudgetMs`** parameter (default `50000` — leaves 10s headroom under the typical 60s wall).
- When the budget is exhausted, remaining rules are returned with **`ruleStatus: "pending"`** instead of being dropped. Each rule result also carries `ruleStatus` (`completed` | `pending` | `failed`) and an `error` string on failure.
- Response now includes a **`progress`** object: `{ rulesTotal, rulesCompleted, rulesPending, rulesFailed, durationMs, stoppedReason }`. Callers can chain follow-up calls with just the pending rules.

### Notes

- **Non-breaking minor release.** `EmailMessage` and tool input/output shapes remain backwards compatible; new fields (`counts`, `countWarning`, `progress`, `ruleStatus`) are additive.
- Tests rewritten and expanded — now 51 (up from 43). New cases cover the dead-client retry path, count-verification reporting, and the auto-organize budget + pending mechanism.

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.2.0...v1.3.0

---

## v1.2.0 (2026-04-26)

### Critical fixes (data integrity)

The previous releases shipped four mutator methods (`mark_as_read`, `move_messages`, `delete_messages`, `set_flags`) that **silently ignored their `messageIds` parameter** and operated on every message in the target mailbox via an internal `search(['ALL'])` call. Combined with timeouts on large mailboxes, this could leave a destination folder full of duplicates while the source mailbox stayed unchanged. All four are fixed in this release.

- **`move_messages`, `delete_messages`, `set_flags`, `mark_as_read`**: now operate only on the supplied UIDs. Empty `messageIds` is a no-op success; invalid UIDs return a structured `invalid_input` error.
- **`move_messages` is now idempotent**: before moving, the destination is checked for matching `Message-ID` headers. Already-present messages are reported as `skipped` rather than copied again.
- **`get_mailboxes`**: returns a flat array (`{ path, name, delimiter, flags, specialUse }`). The previous version returned a tree with cyclic `parent`/`children` references that crashed `JSON.stringify` on any nested folder structure.
- **New tool `get_mailbox_stats`**: returns `{ total, unread, recent }` for any mailbox so callers can ground themselves on inbox size before designing rules.

### Breaking changes

- **`EmailMessage.id` is now an IMAP UID (string)**, not the RFC822 `Message-ID` header. The new `rfc822MessageId` field carries the old value when available, and a typed `uid: number` field is also exposed. Any caller that cached pre-1.2 IDs must re-fetch.
- **`get_mailboxes` shape changed** from a nested object tree to a flat array of `MailboxInfo`.
- **Mutator return shapes changed** to expose `affected`/`moved`/`skipped`/`deleted` counts and optional `skippedDetails` / `wouldAffect` previews.
- **`IcloudMailError` is now returned as a successful tool response with `status: 'error'` and a structured `error` payload**, instead of being thrown as `MCP error -32603`. Callers that branched on `error.code === -32603` need to inspect `result.error.kind` instead. `McpError` is still thrown for protocol-level problems (missing config, invalid params, unknown tool).

### New behavior

- **Persistent connection with auto-reconnect**. Every tool call goes through `ensureConnected()`, which re-authenticates if the IMAP socket dropped. Removes the brittle "call `check_config` between operations" workaround.
- **`metadataOnly` / `bodyPreview`** options on `get_messages` and `search_messages`. `metadataOnly` skips body and attachment parsing entirely (envelope + flags only); `bodyPreview` truncates the body and omits attachments.
- **`dryRun`** option on `move_messages` and `delete_messages` returns previews of affected messages without performing the mutation.
- **Structured errors**. `IcloudMailError` instances expose `kind` (`auth | network | rate_limit | not_found | invalid_input | server`) and `retryable` so callers can act intelligently on failures.
- **`check_config`** now actively probes the connection (via `ensureConnected()`) rather than reflecting a stale flag.

### Internal

- **Library swap**: `imap@0.8.19` (unmaintained since 2021) replaced with `imapflow@1.3.x`. UID-first by default; native `messageMove` / `messageDelete` / `messageFlagsAdd` / `messageFlagsRemove`.
- **Tests rewritten** against `imapflow`'s surface. New cases assert that mutators are called with the supplied UIDs and never invoke a whole-mailbox range — these would have caught the entire pre-1.2 bug family.

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.1.1...v1.2.0

---

## v1.1.1 (2025-08-17)

### Testing Infrastructure

- **Test Suite**: Added comprehensive test coverage with Vitest framework
  - Core client functionality tests
  - Type definition validation tests
  - Server configuration tests
- **Testing Scripts**: Added `test`, `test:ui`, and `test:run` commands
- **Documentation**: Enhanced README with detailed testing section

### Code Quality Improvements

- **Test Coverage**: 29 tests across 3 test files covering core functionality
- **Development Experience**: Added Vitest UI for interactive test development

### Technical Details

- Added Vitest and @vitest/ui dependencies
- Implemented proper mocking for external dependencies (IMAP, SMTP)
- Test isolation and cleanup for reliable test execution
- Real-world scenario testing reflecting actual usage patterns

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.1.0...v1.1.1

---

## v1.1.0 (2025-08-12)

### New Features

- **search_messages**: Advanced email search with multiple criteria (query text, date range, sender filtering)
- **delete_messages**: Bulk message deletion functionality with proper flag handling
- **set_flags**: Message flag management (add/remove flags like \\Seen, \\Flagged)
- **download_attachment**: Download specific attachments from messages with base64 encoding
- **auto_organize**: Intelligent email organization with customizable rules based on sender and subject

### Improvements

- Enhanced type safety with proper TypeScript interfaces
- Improved error handling across all new functions
- Better code organization with reusable components
- Consistent API design patterns

### Technical Details

- Added `SearchOptions` and `OrganizationRule` interfaces
- Implemented comprehensive IMAP search criteria handling
- Enhanced attachment processing with proper content type detection
- Dry-run capability for organization testing

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.0.2...v1.1.0

---

## v1.0.2 (2025-08-13)

### Documentation Improvements

- Reorganized README.md with collapsible sections for better readability
- Added comprehensive documentation for mailbox deletion functionality
- Improved tool documentation structure and examples
- Enhanced usage examples with categorized sections

### Technical Changes

- Simplified documentation structure for easier navigation
- Better organization of available tools and usage examples

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.0.1...v1.0.2

---

## v1.0.1 (2025-08-13)

### New Features

- Added `delete_mailbox` tool for safe mailbox deletion
- System mailbox protection (INBOX, Sent, Trash, Drafts, Junk)
- Enhanced error handling with descriptive messages

### Improvements

- Added ESLint and Prettier for code quality
- Updated all dependencies to latest versions
- Enhanced build process with esbuild integration

### Technical Changes

- Applied consistent code formatting
- Improved build scripts and configuration
- Enhanced input validation for mailbox operations

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.0.0...v1.0.1

---

## v1.0.0 (2025-07-22)

This is the initial release of iCloud Mail MCP Server.

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/commits/v1.0.0
