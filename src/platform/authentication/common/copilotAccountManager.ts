/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationSession } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { AuthProviderId } from '../../configuration/common/configurationService';

/** Un compte GitHub connu de VS Code, agrégé sur les deux providers. */
export interface CopilotAccount {
	/** Identifiant STABLE fourni par VS Code (account.id). Clé de persistance et de bascule. */
	readonly id: string;
	/** Provider d'origine : distingue dotcom du SSO Enterprise. */
	readonly providerId: AuthProviderId;
	/** Libellé affichable (username ou email). NE PAS utiliser comme identifiant. */
	readonly label: string;
	/** Compte utilisable par Copilot ? false si authentifié mais sans licence (voir étape 3). */
	readonly hasCopilotAccess?: boolean;
}

export const ICopilotAccountManager =
	createServiceIdentifier<ICopilotAccountManager>('ICopilotAccountManager');

export interface ICopilotAccountManager {
	readonly _serviceBrand: undefined;

	/** Fire quand la liste des comptes change (login/logout d'un provider). */
	readonly onDidChangeAccounts: Event<void>;

	/** Fire UNIQUEMENT lors d'une bascule volontaire de compte actif. */
	readonly onDidChangeActiveAccount: Event<CopilotAccount | undefined>;

	/** Instantané courant de la liste unifiée des comptes. */
	readonly accounts: readonly CopilotAccount[];

	/** Le compte actif, ou undefined si aucun compte connecté. */
	readonly activeAccount: CopilotAccount | undefined;

	/** Re-scanne les deux providers et met à jour {@link accounts}. */
	refreshAccounts(): Promise<void>;

	/** Définit le compte actif par id. No-op si déjà actif. Persiste l'id. */
	setActiveAccount(accountId: string): Promise<void>;

	/**
	 * Session OAuth du compte actif (silencieuse). undefined si indisponible.
	 * NE MINT PAS de token Copilot — c'est le rôle du token manager (étape 3).
	 */
	getSessionForActiveAccount(): Promise<AuthenticationSession | undefined>;
}
