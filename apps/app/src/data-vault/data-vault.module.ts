import { Global, Logger, Module } from '@nestjs/common';
import { DataVaultService } from './data-vault.service';
import { DataAnalysisService } from './data-analysis.service';
import { DataVaultQueryService } from './query.service';
import { DataVaultController } from './data-vault.controller';
import { setDataVaultInstance } from './data-vault.singleton';
import { setDataAnalysisInstance } from './data-analysis.singleton';
import { setDataVaultQueryInstance } from './query.singleton';

@Global()
@Module({
  providers: [
    {
      provide: DataVaultService,
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
          Logger.error('REDIS_URL is required for DataVault', 'DataVaultModule');
          throw new Error('REDIS_URL environment variable is required for DataVault');
        }

        // Use environment variables for configuration
        // Note: TTL values are now in SECONDS (not milliseconds) for Redis compatibility
        const service = new DataVaultService({
          redisUrl,
          maxInlineRows: parseInt(
            process.env.DATA_VAULT_MAX_INLINE_ROWS ?? '100',
            10,
          ),
          maxInlineTokens: parseInt(
            process.env.DATA_VAULT_MAX_INLINE_TOKENS ?? '10000',
            10,
          ),
          maxInlineBytes: parseInt(
            process.env.DATA_VAULT_MAX_INLINE_BYTES ?? '51200',
            10,
          ),
          ttlSeconds: parseInt(
            process.env.DATA_VAULT_TTL_SECONDS ?? String(30 * 60),
            10,
          ),
          gracePeriodSeconds: parseInt(
            process.env.DATA_VAULT_GRACE_PERIOD_SECONDS ?? String(5 * 60),
            10,
          ),
        });
        // Register singleton for non-DI access
        setDataVaultInstance(service);
        return service;
      },
    },
    {
      provide: DataAnalysisService,
      useFactory: () => {
        const service = new DataAnalysisService();
        // Register singleton for non-DI access
        setDataAnalysisInstance(service);
        return service;
      },
    },
    {
      provide: DataVaultQueryService,
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
          Logger.error('REDIS_URL is required for DataVaultQueryService', 'DataVaultModule');
          throw new Error('REDIS_URL environment variable is required for DataVaultQueryService');
        }

        const service = new DataVaultQueryService({
          redisUrl,
        });
        // Register singleton for non-DI access
        setDataVaultQueryInstance(service);
        return service;
      },
    },
  ],
  controllers: [DataVaultController],
  exports: [DataVaultService, DataAnalysisService, DataVaultQueryService],
})
export class DataVaultModule {}
