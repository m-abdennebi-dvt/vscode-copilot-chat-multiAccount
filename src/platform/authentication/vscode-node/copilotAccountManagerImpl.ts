/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { authentication, AuthenticationSession } from 'vscode';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { AuthProviderId } from '../../configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ILogService } from '../../log/common/logService';
import { CopilotAccount, ICopilotAccountManager } from '../common/copilotAccountManager';
import { GITHUB_SCOPE_USER_EMAIL } from '../common/authentication';
import { getSessionForAccount } from './session';

const ACTIVE_ACCOUNT_ID_KEY = 'copilot.multiAccount.activeAccountId';

export class CopilotAccountManager extends Disposable implements ICopilotAccountManager {
	declare readonly _serviceBrand: undefined;

	private static readonly PROVIDERS: AuthProviderId[] = [
		AuthProviderId.GitHub,
		AuthProviderId.GitHubEnterprise,
	];

	private readonly _onDidChangeAccounts = this._register(new Emitter<void>());
	readonly onDidChangeAccounts: Event<void> = this._onDidChangeAccounts.event;

	private readonly _onDidChangeActiveAccount = this._register(new Emitter<CopilotAccount | undefined>());
	readonly onDidChangeActiveAccount: Event<CopilotAccount | undefined> = this._onDidChangeActiveAccount.event;

	private _accounts: CopilotAccount[] = [];
	private _activeAccount: CopilotAccount | undefined;

	get accounts(): readonly CopilotAccount[] {
		return this._accounts;
	}

	get activeAccount(): CopilotAccount | undefined {
		return this._activeAccount;
	}

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(authentication.onDidChangeSessions(e => {
			if (e.provider.id === AuthProviderId.GitHub ||
				e.provider.id === AuthProviderId.GitHubEnterprise) {
				void this.refreshAccounts();
			}
		}));
		void this.refreshAccounts();
	}

	async refreshAccounts(): Promise<void> {
		const results = await Promise.all(
			CopilotAccountManager.PROVIDERS.map(async providerId => {
				try {
					const vsAccounts = await authentication.getAccounts(providerId);
					return vsAccounts.map(a => ({ id: a.id, label: a.label, providerId }));
				} catch (err) {
					this._log.warn(`[CopilotAccountManager] Failed to enumerate provider '${providerId}': ${err}`);
					return [];
				}
			})
		);

		const seen = new Set<string>();
		const newAccounts: CopilotAccount[] = [];
		for (const batch of results) {
			for (const a of batch) {
				const key = `${a.providerId}:${a.id}`;
				if (!seen.has(key)) {
					seen.add(key);
					newAccounts.push(a);
				}
			}
		}

		const oldIds = new Set(this._accounts.map(a => `${a.providerId}:${a.id}`));
		const newIds = new Set(newAccounts.map(a => `${a.providerId}:${a.id}`));
		const listChanged = oldIds.size !== newIds.size || [...newIds].some(id => !oldIds.has(id));

		this._accounts = newAccounts;

		// Restore or validate the persisted active account
		const persistedId = this._extensionContext.globalState.get<string>(ACTIVE_ACCOUNT_ID_KEY);
		const persistedAccount = persistedId
			? this._accounts.find(a => a.id === persistedId)
			: undefined;

		if (persistedAccount) {
			this._activeAccount = persistedAccount;
		} else if (this._activeAccount && !this._accounts.find(a => a.id === this._activeAccount!.id)) {
			// Active account disappeared — reset to first available
			this._activeAccount = this._accounts[0];
			await this._persistActiveAccountId(this._activeAccount?.id);
			this._onDidChangeActiveAccount.fire(this._activeAccount);
		} else if (!this._activeAccount && this._accounts.length > 0) {
			this._activeAccount = this._accounts[0];
			await this._persistActiveAccountId(this._activeAccount.id);
		}

		if (listChanged) {
			this._onDidChangeAccounts.fire();
		}
	}

	async setActiveAccount(accountId: string): Promise<void> {
		if (accountId === this._activeAccount?.id) {
			return;
		}
		const account = this._accounts.find(a => a.id === accountId);
		if (!account) {
			throw new Error(`[CopilotAccountManager] Unknown account id: '${accountId}'`);
		}
		this._activeAccount = account;
		await this._persistActiveAccountId(accountId);
		this._onDidChangeActiveAccount.fire(this._activeAccount);
	}

	async getSessionForActiveAccount(): Promise<AuthenticationSession | undefined> {
		const account = this._activeAccount;
		if (!account) {
			return undefined;
		}
		const scopes = GITHUB_SCOPE_USER_EMAIL;
		return getSessionForAccount(account.providerId, { id: account.id, label: account.label }, scopes, { silent: true });
	}

	private _persistActiveAccountId(id: string | undefined): Thenable<void> {
		return this._extensionContext.globalState.update(ACTIVE_ACCOUNT_ID_KEY, id);
	}
}
