/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ICopilotAccountManager } from '../../../platform/authentication/common/copilotAccountManager';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

export class MultiAccountDebugContribution extends Disposable {
	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this._register(vscode.commands.registerCommand('github.copilot.debug.showAccounts', () => {
			this.showDebugAccounts();
		}));
	}

	private async showDebugAccounts(): Promise<void> {
		try {
			const accountManager = this.instantiationService.invokeFunction((accessor) => accessor.get(ICopilotAccountManager));
			await accountManager.refreshAccounts();
			const accounts = accountManager.accounts;
			const activeAccount = accountManager.activeAccount;

			const accountsList = accounts
				.map((acc: typeof accounts[0]) => {
					const isActive = activeAccount && acc.id === activeAccount.id && acc.providerId === activeAccount.providerId;
					const marker = isActive ? ' ✓ [ACTIVE]' : '';
					return `${acc.label} (${acc.providerId}:${acc.id})${marker}`;
				})
				.join('\n');

			const message = accounts.length === 0
				? 'No Copilot accounts found'
				: `Found ${accounts.length} Copilot accounts:\n\n${accountsList}`;

			await vscode.window.showInformationMessage(message, { modal: true });
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			await vscode.window.showErrorMessage(`Failed to fetch accounts: ${errorMessage}`);
		}
	}
}
