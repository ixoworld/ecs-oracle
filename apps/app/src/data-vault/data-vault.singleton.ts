import { createSingleton } from './singleton-factory';
import { DataVaultService } from './data-vault.service';

/**
 * Singleton accessor for DataVaultService
 *
 * This allows non-NestJS modules (like the graph agents) to access
 * the DataVaultService instance that was created by the NestJS DI container.
 *
 * Usage:
 * 1. DataVaultModule initializes and calls setDataVaultInstance()
 * 2. Graph agents call getDataVaultInstance() to access the service
 */

const dataVaultSingleton = createSingleton<DataVaultService>('DataVault');

/**
 * Set the DataVault service instance (called from NestJS module)
 */
export const setDataVaultInstance = dataVaultSingleton.setInstance;

/**
 * Get the DataVault service instance (called from anywhere)
 * Returns null if not initialized
 */
export const getDataVaultInstance = dataVaultSingleton.getInstance;

/**
 * Check if DataVault is available
 */
export const isDataVaultAvailable = dataVaultSingleton.isAvailable;
