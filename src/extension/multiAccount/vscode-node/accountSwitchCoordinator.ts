/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICopilotAccountManager, CopilotAccount } from '../../../platform/authentication/common/copilotAccountManager';
import { ICopilotTokenStore } from '../../../platform/authentication/common/copilotTokenStore';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Coordinates atomic account switching with:
 * - mint-before-swap: get NEW token before releasing OLD token
 * - token cache for instant re-switch (5-min margin)
 * - _switchInProgress guard to prevent _handleAuthChangeEvent interference
 */
export class AccountSwitchCoordinator extends Disposable {
	private _previousAccount: CopilotAccount | undefined;
	private _switchInProgress = false;

	constructor(
		@ICopilotAccountManager private readonly _accountManager: ICopilotAccountManager,
		@ICopilotTokenStore private readonly _tokenStore: ICopilotTokenStore,
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
		@ILogService private readonly _log: ILogService,
	) {
		super();

		// Listen to voluntary account switches
		this._register(
			this._accountManager.onDidChangeActiveAccount(account => {
				// Fire and forget, but handle errors silently to avoid unhandled rejections
				this._onSwitch(account).catch(e => {
					this._log.debug(`[AccountSwitchCoordinator] Switch error handled: ${e}`);
				});
			})
		);

		// Store initial active account
		this._previousAccount = this._accountManager.activeAccount;
	}

	private async _onSwitch(newAccount: CopilotAccount | undefined): Promise<void> {
		if (!newAccount) {
			this._log.debug('[AccountSwitchCoordinator] Account switched to undefined');
			return;
		}

		this._switchInProgress = true;
		try {
			const oldToken = this._tokenStore.copilotToken;
			this._log.info(`[AccountSwitchCoordinator] Starting atomic switch from ${this._previousAccount?.label} to ${newAccount.label}`);

			// Try cache first (5-min margin)
			let newToken = this._accountManager.getCachedToken(newAccount.id);
			if (newToken && !this._isTokenExpiring(newToken)) {
				this._log.debug(`[AccountSwitchCoordinator] Cache hit for ${newAccount.label}, reusing token`);
			} else {
				// Cache miss or expiring — mint new token
				this._log.debug(`[AccountSwitchCoordinator] Cache miss or expiring for ${newAccount.label}, minting new token`);
				const session = await this._accountManager.getSessionForActiveAccount();
				if (!session) {
					throw new Error(`[AccountSwitchCoordinator] No session available for ${newAccount.label}`);
				}

				try {
					newToken = await (this._tokenManager as any).mintForSession(session);
					this._accountManager.cacheToken(newAccount.id, newToken);
					this._log.debug(`[AccountSwitchCoordinator] Minted and cached token for ${newAccount.label}`);
				} catch (error) {
					this._log.error(`[AccountSwitchCoordinator] Failed to mint token for ${newAccount.label}: ${error}`);
					// Restore previous token (don't purge)
					if (oldToken) {
						this._tokenStore.copilotToken = oldToken;
					}
					throw error;
				}
			}

			// Atomic swap: assign new token
			this._tokenStore.copilotToken = newToken;
			this._previousAccount = newAccount;
			this._log.info(`[AccountSwitchCoordinator] Atomic swap complete for ${newAccount.label}`);

		} finally {
			this._switchInProgress = false;
		}
	}

	private _isTokenExpiring(token: any): boolean {
		// 5 minutes margin before actual expiration
		const expiresAt = token.expiresAt * 1000; // Convert to milliseconds
		const now = Date.now();
		const fiveMinutesMs = 5 * 60 * 1000;
		return expiresAt - now < fiveMinutesMs;
	}

	isSwitchInProgress(): boolean {
		return this._switchInProgress;
	}
}
