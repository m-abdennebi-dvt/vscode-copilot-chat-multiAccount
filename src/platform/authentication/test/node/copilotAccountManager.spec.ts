/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';

// --- Hoisted mocks -----------------------------------------------------------

const mockGetAccounts = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

// Create emitter for managing session change events in tests
let mockOnDidChangeSessionsEmitter: Emitter<{ provider: { id: string } }>;

vi.mock('vscode', () => ({
	authentication: {
		getAccounts: mockGetAccounts,
		getSession: mockGetSession,
		get onDidChangeSessions() {
			return mockOnDidChangeSessionsEmitter.event;
		},
	},
}));

// Import AFTER mocks so modules pick up the mocked vscode.
import { CopilotAccountManager } from '../../vscode-node/copilotAccountManagerImpl';
import { TestLogService } from '../../../testing/common/testLogService';
import { MockExtensionContext } from '../../../test/node/extensionContext';

// --- Helpers -----------------------------------------------------------------

function makeAccount(id: string, label: string) {
	return { id, label };
}

function makeSession(id: string, label: string, accessToken = `token-${id}`) {
	return { id, label: { label }, accessToken, scopes: ['user:email'] };
}

function createManager(context = new MockExtensionContext()) {
	const log = new TestLogService();
	// CopilotAccountManager constructor uses @decorator injection, but we can
	// also instantiate it directly by passing the dependencies as plain args
	// using a lightweight DI shim via the class constructor.
	// Since the class uses decorator-based DI we instantiate via the public
	// constructor directly, relying on the parameter order matching the
	// @Inject decorators.
	const mgr = new (CopilotAccountManager as any)(context, log) as CopilotAccountManager;
	return { mgr, context };
}

// --- Tests -------------------------------------------------------------------

describe('CopilotAccountManager', () => {
	let disposables: DisposableStore;

	beforeEach(() => {
		mockOnDidChangeSessionsEmitter = new Emitter<{ provider: { id: string } }>();
		disposables = new DisposableStore();
		mockGetAccounts.mockReset();
		mockGetSession.mockReset();
	});

	afterEach(() => {
		disposables.dispose();
	});

	// S1-V14: 2 github accounts + 1 github-enterprise → 3 accounts
	test('enumerates 2 github + 1 github-enterprise accounts (S1-V14)', async () => {
		mockGetAccounts.mockImplementation(async (providerId: string) => {
			if (providerId === 'github') {
				return [makeAccount('u1', 'alice'), makeAccount('u2', 'bob')];
			}
			if (providerId === 'github-enterprise') {
				return [makeAccount('e1', 'corp-user')];
			}
			return [];
		});

		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		expect(mgr.accounts).toHaveLength(3);
		const providers = mgr.accounts.map(a => a.providerId);
		expect(providers).toContain('github');
		expect(providers).toContain('github-enterprise');
	});

	// S1-V14: provider error is tolerated — other accounts still listed
	test('tolerates github-enterprise provider failure (S1-V14)', async () => {
		const warnSpy: string[] = [];
		mockGetAccounts.mockImplementation(async (providerId: string) => {
			if (providerId === 'github') {
				return [makeAccount('u1', 'alice')];
			}
			throw new Error('SSO not configured');
		});

		const log = new TestLogService();
		const original = log.warn.bind(log);
		log.warn = (msg: string) => { warnSpy.push(msg); original(msg); };

		const ctx = new MockExtensionContext();
		const mgr = new (CopilotAccountManager as any)(ctx, log) as CopilotAccountManager;
		disposables.add(mgr);
		await mgr.refreshAccounts();

		// github accounts still present
		expect(mgr.accounts).toHaveLength(1);
		expect(mgr.accounts[0].providerId).toBe('github');
		// A warning was logged
		expect(warnSpy.some(w => w.includes('github-enterprise'))).toBe(true);
	});

	// S1-V15: setActiveAccount with unknown id throws
	test('setActiveAccount throws for unknown id (S1-V15)', async () => {
		mockGetAccounts.mockResolvedValue([makeAccount('u1', 'alice')]);
		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		await expect(mgr.setActiveAccount('unknown-id')).rejects.toThrow();
	});

	// S1-V15: setActiveAccount is idempotent — no fire if already active
	test('setActiveAccount is idempotent (S1-V15)', async () => {
		mockGetAccounts.mockImplementation(async (p: string) =>
			p === 'github' ? [makeAccount('u1', 'alice')] : []
		);
		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		const fired: unknown[] = [];
		disposables.add(mgr.onDidChangeActiveAccount(e => fired.push(e)));

		// Already active after refresh
		await mgr.setActiveAccount('u1');
		expect(fired).toHaveLength(0);
	});

	// S1-V15: setActiveAccount fires event and persists
	test('setActiveAccount fires onDidChangeActiveAccount and persists id (S1-V15)', async () => {
		mockGetAccounts.mockImplementation(async (p: string) => {
			if (p === 'github') { return [makeAccount('u1', 'alice'), makeAccount('u2', 'bob')]; }
			return [];
		});
		const { mgr, context } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		const fired: unknown[] = [];
		disposables.add(mgr.onDidChangeActiveAccount(e => fired.push(e)));

		await mgr.setActiveAccount('u2');

		expect(fired).toHaveLength(1);
		expect((fired[0] as any).id).toBe('u2');
		expect(context.globalState.get('copilot.multiAccount.activeAccountId')).toBe('u2');
	});

	// S1-V16: persisted account disappears → rebascule + fire
	test('lost persisted account triggers reset and fires event (S1-V16)', async () => {
		// First refresh: 2 accounts
		mockGetAccounts.mockImplementation(async (p: string) =>
			p === 'github' ? [makeAccount('u1', 'alice'), makeAccount('u2', 'bob')] : []
		);
		const ctx = new MockExtensionContext();
		// Pre-seed globalState as if u2 was active
		await ctx.globalState.update('copilot.multiAccount.activeAccountId', 'u2');

		const log = new TestLogService();
		const mgr = new (CopilotAccountManager as any)(ctx, log) as CopilotAccountManager;
		disposables.add(mgr);
		await mgr.refreshAccounts();
		expect(mgr.activeAccount?.id).toBe('u2');

		// Second refresh: u2 is gone
		mockGetAccounts.mockImplementation(async (p: string) =>
			p === 'github' ? [makeAccount('u1', 'alice')] : []
		);
		const fired: unknown[] = [];
		disposables.add(mgr.onDidChangeActiveAccount(e => fired.push(e)));

		await mgr.refreshAccounts();

		expect(fired).toHaveLength(1);
		// Bascule sur le premier compte disponible
		expect(mgr.activeAccount?.id).toBe('u1');
	});

	// S1-V17: getSessionForActiveAccount uses {account, silent:true} WITHOUT clearSessionPreference
	test('getSessionForActiveAccount calls getSession with account+silent, no clearSessionPreference (S1-V17)', async () => {
		mockGetAccounts.mockImplementation(async (p: string) =>
			p === 'github' ? [makeAccount('u1', 'alice')] : []
		);
		mockGetSession.mockResolvedValue(makeSession('u1', 'alice'));

		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		const session = await mgr.getSessionForActiveAccount();
		expect(session).toBeDefined();
		expect(session?.accessToken).toBe('token-u1');

		// Verify getSession was called with {account, silent: true}
		expect(mockGetSession).toHaveBeenCalledTimes(1);
		const [, , opts] = mockGetSession.mock.calls[0];
		expect(opts).toMatchObject({ account: { id: 'u1', label: 'alice' }, silent: true });
		// MUST NOT contain clearSessionPreference
		expect(Object.prototype.hasOwnProperty.call(opts, 'clearSessionPreference')).toBe(false);
	});

	// getSessionForActiveAccount returns undefined when no active account
	test('getSessionForActiveAccount returns undefined when no accounts (S1-V17)', async () => {
		mockGetAccounts.mockResolvedValue([]);
		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		const session = await mgr.getSessionForActiveAccount();
		expect(session).toBeUndefined();
		expect(mockGetSession).not.toHaveBeenCalled();
	});

	// onDidChangeSessions triggers refreshAccounts
	test('onDidChangeSessions on github triggers refreshAccounts', async () => {
		const calls: string[] = [];
		mockGetAccounts.mockImplementation(async (p: string) => {
			calls.push(p);
			return [];
		});

		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();
		const callsBefore = calls.length;

		mockOnDidChangeSessionsEmitter.fire({ provider: { id: 'github' } });
		// Give the async refresh a tick
		await new Promise(r => setTimeout(r, 0));

		expect(calls.length).toBeGreaterThan(callsBefore);
	});

	// Deduplication: same account.id on 2 providers → only one entry per provider:id pair
	test('deduplicates by providerId:id composite key', async () => {
		// Same account id appears on both providers (edge case)
		mockGetAccounts.mockImplementation(async () => [makeAccount('shared-id', 'shared')]);

		const { mgr } = createManager();
		disposables.add(mgr);
		await mgr.refreshAccounts();

		// 2 providers × 1 account each = 2, but if same provider+id it deduplicates
		// In this case provider ids are different so both are kept
		expect(mgr.accounts).toHaveLength(2);
		const keys = new Set(mgr.accounts.map(a => `${a.providerId}:${a.id}`));
		expect(keys.size).toBe(2);
	});
});
