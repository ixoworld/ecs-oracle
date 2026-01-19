import { createSingleton } from './singleton-factory';
import { DataAnalysisService } from './data-analysis.service';

/**
 * Singleton accessor for DataAnalysisService
 *
 * This allows non-NestJS modules (like the graph agents) to access
 * the DataAnalysisService instance that was created by the NestJS DI container.
 *
 * Usage:
 * 1. DataVaultModule initializes and calls setDataAnalysisInstance()
 * 2. Graph agents call getDataAnalysisInstance() to access the service
 */

const dataAnalysisSingleton = createSingleton<DataAnalysisService>('DataAnalysis');

/**
 * Set the DataAnalysis service instance (called from NestJS module)
 */
export const setDataAnalysisInstance = dataAnalysisSingleton.setInstance;

/**
 * Get the DataAnalysis service instance (called from anywhere)
 * Returns null if not initialized
 */
export const getDataAnalysisInstance = dataAnalysisSingleton.getInstance;

/**
 * Check if DataAnalysis is available
 */
export const isDataAnalysisAvailable = dataAnalysisSingleton.isAvailable;
