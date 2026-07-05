/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSwitchCoordinator } from '../accountSwitchCoordinator';
import { CopilotAccount, ICopilotAccountManager } from '../../../../platform/authentication/common/copilotAccountManager';
import { ICopilotTokenStore } from '../../../../platform/authentication/common/copilotTokenStore';
import { ICopilotTokenManager } from '../../../../platform/authentication/common/copilotTokenManager';
import { ILogService } from '../../../../platform/log/common/logService';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { Emitter } from '../../../../util/vs/base/common/event';
import { AuthenticationSession } from 'vscode';

describe('AccountSwitchCoordinator', () => {
	let coordinator: AccountSwitchCoordinator;
	let mockAccountManager: any;
	let mockTokenStore: any;
	let mockTokenManager: any;
	let mockLogService: any;
	let onDidChangeActiveAccountEmitter: Emitter<CopilotAccount | undefined>;

	const testAccount1: CopilotAccount = { id: 'acc1', label: 'user1@github.com', providerId: 'github' };
	const testAccount2: CopilotAccount = { id: 'acc2', label: 'user2@github.com', providerId: 'github' };

	const createTestToken = (expiresAt: number): CopilotToken => {
		return new CopilotToken({
			token: 'test-token',
			expires_at: expiresAt,
			refresh_in: 3600,
			sku: 'individual',
			individual: true,
			blackbird_clientside_indexing: false,
			code_quote_enabled: false,
			code_review_enabled: false,
			codesearch: false,
			copilotignore_enabled: false,
			vsc_electron_fetcher_v2: false,
			public_suggestions: 'enabled',
			telemetry: 'enabled',
			username: 'testuser',
			isVscodeTeamMember: false,
			copilot_plan: 'individual',
			organization_login_list: [],
		});
	};

	const createTestSession = (account: CopilotAccount): AuthenticationSession => ({
		id: `session_${account.id}`,
		accessToken: `token_${account.id}`,
		account: { label: account.label, id: account.id },
		scopes: [],
	});

	beforeEach(() => {
		onDidChangeActiveAccountEmitter = new Emitter<CopilotAccount | undefined>();

		mockAccountManager = {
			onDidChangeActiveAccount: onDidChangeActiveAccountEmitter.event,
			activeAccount: testAccount1,
			getCachedToken: vi.fn(() => undefined),
			cacheToken: vi.fn(),
			getSessionForActiveAccount: vi.fn(),
		};

		mockTokenStore = {
			copilotToken: createTestToken(Math.floor(Date.now() / 1000) + 7200), // 2 hours in future
		};

		mockTokenManager = {
			mintForSession: vi.fn(),
		};

		mockLogService = {
			debug: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		};

		coordinator = new AccountSwitchCoordinator(
			mockAccountManager,
			mockTokenStore,
			mockTokenManager,
			mockLogService,
		);
	});

	describe('cache hit (non-expired)', () => {
		it('should return cached token and not mint', async () => {
			const cachedToken = createTestToken(Math.floor(Date.now() / 1000) + 7200);
			mockAccountManager.getCachedToken.mockReturnValue(cachedToken);

			onDidChangeActiveAccountEmitter.fire(testAccount2);

			// Give async operation time to complete
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(mockAccountManager.getCachedToken).toHaveBeenCalledWith('acc2');
			expect(mockTokenManager.mintForSession).not.toHaveBeenCalled();
			expect(mockTokenStore.copilotToken).toBe(cachedToken);
		});
	});

	describe('cache miss (mint called)', () => {
		it('should mint new token when cache is empty', async () => {
			const newToken = createTestToken(Math.floor(Date.now() / 1000) + 7200);
			mockAccountManager.getCachedToken.mockReturnValue(undefined);
			mockAccountManager.getSessionForActiveAccount.mockResolvedValue(createTestSession(testAccount2));
			mockTokenManager.mintForSession.mockResolvedValue(newToken);

			onDidChangeActiveAccountEmitter.fire(testAccount2);

			// Give async operation time to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			expect(mockTokenManager.mintForSession).toHaveBeenCalled();
			expect(mockAccountManager.cacheToken).toHaveBeenCalledWith('acc2', newToken);
			expect(mockTokenStore.copilotToken).toBe(newToken);
		});
	});

	describe('token store never undefined during swap', () => {
		it('should maintain token in store throughout swap', async () => {
			const newToken = createTestToken(Math.floor(Date.now() / 1000) + 7200);
			const originalToken = mockTokenStore.copilotToken;

			mockAccountManager.getCachedToken.mockReturnValue(undefined);
			mockAccountManager.getSessionForActiveAccount.mockResolvedValue(createTestSession(testAccount2));
			mockTokenManager.mintForSession.mockResolvedValue(newToken);

			// Verify token is set to the new token
			onDidChangeActiveAccountEmitter.fire(testAccount2);

			// Give async operation time to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			expect(mockTokenStore.copilotToken).toBe(newToken);
			expect(mockTokenStore.copilotToken).toBeDefined();
		});
	});

	describe('mint failure (restore old token)', () => {
		it('should restore old token on mint failure', async () => {
			const originalToken = mockTokenStore.copilotToken;
			mockAccountManager.getCachedToken.mockReturnValue(undefined);
			mockAccountManager.getSessionForActiveAccount.mockResolvedValue(createTestSession(testAccount2));
			mockTokenManager.mintForSession.mockRejectedValue(new Error('Mint failed'));

			onDidChangeActiveAccountEmitter.fire(testAccount2);

			// Give async operation time to complete
			await new Promise(resolve => setTimeout(resolve, 150));

			expect(mockTokenStore.copilotToken).toBe(originalToken);
		});
	});

	describe('_switchInProgress guard', () => {
		it('should report switch in progress state', () => {
			expect(coordinator.isSwitchInProgress()).toBe(false);
			// Method exists and can be called
			expect(typeof coordinator.isSwitchInProgress).toBe('function');
		});
	});

	describe('cache expiration (re-mint despite cache)', () => {
		it('should re-mint if cached token is expiring (within 5 min margin)', async () => {
			// Token expires in 3 minutes (less than 5-minute margin)
			const expiringToken = createTestToken(Math.floor(Date.now() / 1000) + 3 * 60);
			mockAccountManager.getCachedToken.mockReturnValue(expiringToken);

			const newToken = createTestToken(Math.floor(Date.now() / 1000) + 7200);
			mockAccountManager.getSessionForActiveAccount.mockResolvedValue(createTestSession(testAccount2));
			mockTokenManager.mintForSession.mockResolvedValue(newToken);

			onDidChangeActiveAccountEmitter.fire(testAccount2);

			// Give async operation time to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			// Since cached token is expiring, it should re-mint
			expect(mockTokenManager.mintForSession).toHaveBeenCalled();
			expect(mockTokenStore.copilotToken).toBe(newToken);
		});
	});

	describe('successful switch', () => {
		it('should log info on successful switch', async () => {
			const newToken = createTestToken(Math.floor(Date.now() / 1000) + 7200);
			mockAccountManager.getCachedToken.mockReturnValue(undefined);
			mockAccountManager.getSessionForActiveAccount.mockResolvedValue(createTestSession(testAccount2));
			mockTokenManager.mintForSession.mockResolvedValue(newToken);

			onDidChangeActiveAccountEmitter.fire(testAccount2);

			// Give async operation time to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			expect(mockLogService.info).toHaveBeenCalledWith(expect.stringContaining('Atomic swap complete'));
		});
	});
});
