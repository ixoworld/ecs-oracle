import { createSingleton } from './singleton-factory';
import { DataVaultQueryService } from './query.service';

/**
 * Singleton accessor for DataVaultQueryService
 *
 * This allows non-NestJS modules (like the graph agents) to access
 * the DataVaultQueryService instance that was created by the NestJS DI container.
 *
 * Usage:
 * 1. DataVaultModule initializes and calls setDataVaultQueryInstance()
 * 2. Graph agents call getDataVaultQueryInstance() to access the service
 * 3. Use with createOracleRetrievalTools() to create LangChain tools
 */

const queryServiceSingleton = createSingleton<DataVaultQueryService>('DataVaultQuery');

/**
 * Set the DataVaultQuery service instance (called from NestJS module)
 */
export const setDataVaultQueryInstance = queryServiceSingleton.setInstance;

/**
 * Get the DataVaultQuery service instance (called from anywhere)
 * Returns null if not initialized
 */
export const getDataVaultQueryInstance = queryServiceSingleton.getInstance;

/**
 * Check if DataVaultQueryService is available
 */
export const isDataVaultQueryAvailable = queryServiceSingleton.isAvailable;
