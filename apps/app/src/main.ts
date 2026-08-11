import { getSubscriptionUrlByNetwork } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import {
  loadEncryptionKey,
  setupClaimSigningMnemonics,
} from '@ixo/oracles-chain-client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Cache } from 'cache-manager';
import helmet from 'helmet';
import { readFileSync } from 'node:fs';
import { totalmem, freemem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { AppModule } from './app.module';
import { type ENV, isRedisEnabled } from './config';
import { UcanService } from './ucan/ucan.service';
import { EditorMatrixClient } from './graph/agents/editor/editor-mx';
import { initModelPricingCache } from './graph/llm-provider';
import { SecretsService } from './secrets/secrets.service';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { UserPreferencesService } from './user-preferences/user-preferences.service';

// --- Event-loop + memory monitor ------------------------------------------
// Every 5s, logs one line with:
//   • Event loop:   max / p99 / mean lag. >1000ms = same condition that
//                   trips the production liveness probe (1s timeout × 3
//                   failures = SIGKILL).
//   • V8 heap:      heapUsed / heapTotal / heapLimit (the --max-old-space-size
//                   ceiling). V8 throws fatal "JS heap out of memory" near
//                   100% of heapLimit.
//   • rss:          Resident set — what the kernel cgroup-OOM-killer watches.
//   • external:     C++ side of V8 (includes arrayBuffers + native objects
//                   like sqlite handles, Olm sessions held by JS).
//   • arrayBuffers: Subset of external — typed-array / Buffer memory. If
//                   external is high but arrayBuffers is low, the pressure
//                   is from native modules; if arrayBuffers is high it's
//                   from JS-managed buffers (MCP responses, message
//                   decryption staging, etc.).
//   • sysFree/sysTotal: cgroup-aware view of container memory (Node ≥16
//                   honours the cgroup limit).
// Logged at WARN when:
//   - event-loop max ≥ 1000ms (liveness probe at imminent risk)
//   - heapUsed ≥ 80% of heapLimit (V8 OOM risk)
//   - rss      ≥ 90% of sysTotal  (kernel OOM risk)
// Otherwise LOG so we get a continuous trail for post-mortems.
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 50 });
eventLoopMonitor.enable();

// Read cgroup-v2 CPU stats. Returns undefined on non-Linux or pre-v2 hosts
// (e.g. local Mac dev) so the monitor still works everywhere.
type CgroupCpuStat = {
  usageUsec: number;
  nrThrottled: number;
  throttledUsec: number;
};
const readCgroupCpuStat = (): CgroupCpuStat | undefined => {
  try {
    const raw = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
    const out: Partial<CgroupCpuStat> = {};
    for (const line of raw.split('\n')) {
      const [k, v] = line.split(' ');
      if (k === 'usage_usec') out.usageUsec = Number(v);
      else if (k === 'nr_throttled') out.nrThrottled = Number(v);
      else if (k === 'throttled_usec') out.throttledUsec = Number(v);
    }
    if (out.usageUsec === undefined) return undefined;
    return {
      usageUsec: out.usageUsec,
      nrThrottled: out.nrThrottled ?? 0,
      throttledUsec: out.throttledUsec ?? 0,
    };
  } catch {
    return undefined;
  }
};
// cgroup-v2 quota: "<max|quota_us> <period_us>". If first token is "max"
// the cgroup is unconstrained; otherwise quota/period = guaranteed cores.
const readCgroupCpuMax = (): number | undefined => {
  try {
    const raw = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const [quota, period] = raw.split(/\s+/);
    if (quota === 'max') return undefined;
    const q = Number(quota);
    const p = Number(period);
    if (!q || !p) return undefined;
    return q / p;
  } catch {
    return undefined;
  }
};
const cpuQuotaCores = readCgroupCpuMax();
let prevCpuUsage = process.cpuUsage();
let prevWallNs = process.hrtime.bigint();
let prevCgStat = readCgroupCpuStat();

setInterval(() => {
  const max = Math.round(eventLoopMonitor.max / 1e6);
  const p99 = Math.round(eventLoopMonitor.percentile(99) / 1e6);
  const mean = Math.round(eventLoopMonitor.mean / 1e6);
  eventLoopMonitor.reset();

  const mem = process.memoryUsage();
  const heapLimit = getHeapStatistics().heap_size_limit;
  const sysTotal = totalmem();
  const sysFree = freemem();
  const mb = (n: number): number => Math.round(n / 1024 / 1024);
  const heapPct = Math.round((mem.heapUsed / heapLimit) * 100);
  const rssPct = Math.round((mem.rss / sysTotal) * 100);

  // CPU sample. Two views:
  //   procCpu = process.cpuUsage() delta / wall time   (cores used by Node)
  //   cgCpu   = cgroup cpu.stat usage_usec delta / wall (cores used by the
  //             whole pod cgroup — same as `kubectl top pod` numerator)
  // throttled* fields only appear on Linux cgroup-v2. On Mac they're absent.
  const nowCpu = process.cpuUsage();
  const nowWall = process.hrtime.bigint();
  const nowCg = readCgroupCpuStat();
  const wallUs = Number(nowWall - prevWallNs) / 1000;
  const procCpuUs =
    nowCpu.user - prevCpuUsage.user + (nowCpu.system - prevCpuUsage.system);
  const procCpuCores = wallUs > 0 ? procCpuUs / wallUs : 0;
  let cgCpuCores: number | undefined;
  let throttledMs = 0;
  let nrThrottled = 0;
  if (nowCg && prevCgStat) {
    cgCpuCores =
      wallUs > 0 ? (nowCg.usageUsec - prevCgStat.usageUsec) / wallUs : 0;
    throttledMs = Math.round(
      (nowCg.throttledUsec - prevCgStat.throttledUsec) / 1000,
    );
    nrThrottled = nowCg.nrThrottled - prevCgStat.nrThrottled;
  }
  prevCpuUsage = nowCpu;
  prevWallNs = nowWall;
  prevCgStat = nowCg;

  const cpuQuotaStr = cpuQuotaCores ? `/${cpuQuotaCores.toFixed(2)}c` : '';
  const cgCpuStr =
    cgCpuCores !== undefined
      ? ` cg=${cgCpuCores.toFixed(2)}c${cpuQuotaStr}`
      : '';
  const throttleStr =
    throttledMs > 0 || nrThrottled > 0
      ? ` THROTTLED=${throttledMs}ms×${nrThrottled}`
      : '';

  const line =
    `[lag] max=${max}ms p99=${p99}ms mean=${mean}ms | ` +
    `cpu proc=${procCpuCores.toFixed(2)}c${cgCpuStr}${throttleStr} | ` +
    `heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}/${mb(heapLimit)}MB (${heapPct}%) ` +
    `rss=${mb(mem.rss)}MB (${rssPct}% of cgroup) ` +
    `external=${mb(mem.external)}MB arrBuf=${mb(mem.arrayBuffers)}MB ` +
    `sysFree=${mb(sysFree)}/${mb(sysTotal)}MB`;

  if (max >= 1000 || heapPct >= 80 || rssPct >= 90 || throttledMs > 0) {
    Logger.warn(line, 'EventLoopMonitor');
  } else {
    Logger.log(line, 'EventLoopMonitor');
  }
}, 5000).unref();
// --------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  // await migrate();

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<ENV>);
  const port = configService.get<number>('PORT', 3000); // Default to 3000 if PORT not set

  // Security Headers
  app.use(helmet());

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*', // Configure as needed
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-matrix-access-token',
      'x-matrix-homeserver',
      'x-did',
      'x-request-id',
      'x-timezone',
      'x-user-did',
      'x-data-token',
      'x-ucan-delegation',
      'x-auth-type',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Data-Row-Count'],
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that do not have any decorators
      transform: true, // Automatically transform payloads to DTO instances
    }),
  );

  // Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('API Boilerplate')
    .setDescription('The API description for the boilerplate')
    // set json docs link
    .setExternalDoc('OpenAPI JSON', '/docs/json')
    .setVersion('1.0')
    // Define the Matrix access token header as an API key security scheme
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-matrix-access-token',
        description: "User's Matrix access token (Required for most endpoints)",
      },
      'matrix-token',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-matrix-homeserver',
        description: "User's Matrix homeserver domain (e.g. devmx.ixo.earth)",
      },
      'matrix-homeserver',
    )
    .addSecurityRequirements('matrix-token')
    .addSecurityRequirements('matrix-homeserver')
    // Remove the duplicate global parameters
    .build();
  const document = SwaggerModule.createDocument(app, config);

  // Serve Swagger JSON at the specified URL
  app.use('/docs/json', (req, res) => {
    res.json(document);
  });

  SwaggerModule.setup('docs', app, document, {
    // explorer: true,
    // customSiteTitle: 'API Documentation',
    swaggerUrl: '/docs/json',
  });

  const matrixManager = MatrixManager.getInstance();

  registerGracefulShutdown({ app, matrixManager });

  // SecretsService is a manual singleton (not @Injectable) because it's accessed from
  // LangGraph agent code outside NestJS DI. Pass the cache manager here at bootstrap.
  const cache = app.get<Cache>(CACHE_MANAGER);
  SecretsService.getInstance().setCacheManager(cache);
  UserPreferencesService.getInstance().setCacheManager(cache);

  // Load per-model pricing from provider APIs (non-blocking)
  initModelPricingCache().catch((err) =>
    Logger.warn('Failed to init model pricing cache', err),
  );

  // Fire Matrix init in background (don't await — let server start for health checks).
  // MessagesService.onModuleInit defers its listener until this completes.
  Logger.log('Initializing MatrixManager (background)...');
  try {
    await matrixManager.init();
    Logger.log('MatrixManager initialized successfully');
    Logger.log(`Oracle: ${matrixManager.getClient()?.userId}`);

    // Initialize non-critical services after Matrix is ready
    const editorMatrixClient = EditorMatrixClient.getInstance();
    editorMatrixClient.init().catch((error) => {
      Logger.error('Failed to initialize EditorMatrixClient:', error);
      Logger.warn('Editor functionality may be limited until sync completes');
    });
    Logger.log('EditorMatrixClient initialization started in background...');

    const matrixAccountRoomId = configService.get('MATRIX_ACCOUNT_ROOM_ID');
    // still run setupClaimSigningMnemonics even if DISABLE_CREDITS as need it for ucan signing
    Logger.log('Setting up claim signing mnemonics...');
    Logger.log(`Matrix account room id: ${matrixAccountRoomId}`);
    const signingMnemonic = await setupClaimSigningMnemonics({
      matrixRoomId: matrixAccountRoomId,
      matrixAccessToken: configService.getOrThrow(
        'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
      ),
      walletMnemonic: configService.getOrThrow('SECP_MNEMONIC'),
      pin: configService.getOrThrow('MATRIX_VALUE_PIN'),
      signerDid: configService.getOrThrow('ORACLE_DID'),
      network: configService.getOrThrow('NETWORK'),
    });
    Logger.log('Claim signing mnemonics setup complete');

    if (signingMnemonic) {
      const ucanService = app.get(UcanService);
      ucanService.setSigningMnemonic(
        signingMnemonic,
        configService.getOrThrow('ORACLE_DID'),
      );
    }

    // Load P-256 encryption key for user secrets
    if (matrixAccountRoomId) {
      Logger.log('Loading P-256 encryption key...');
      const encryptionKeyResult = await loadEncryptionKey({
        matrixRoomId: matrixAccountRoomId,
        matrixAccessToken: configService.getOrThrow(
          'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
        ),
        pin: configService.getOrThrow('MATRIX_VALUE_PIN'),
        signerDid: configService.getOrThrow('ORACLE_DID'),
      });
      if (encryptionKeyResult) {
        SecretsService.getInstance().setEncryptionKey(
          encryptionKeyResult.privateJwk,
        );
        Logger.log('P-256 encryption key loaded successfully');
      } else {
        Logger.warn(
          'No P-256 encryption key found. User secrets will be unavailable. ' +
            'Run "oracles-cli setup-encryption-key" to provision one.',
        );
      }
    }
  } catch (error) {
    Logger.error('Failed to initialize MatrixManager:', error);
  }

  // Server starts immediately — health checks pass while Matrix syncs in background
  await app.listen(port, '0.0.0.0');
  Logger.log(`Application is running on: ${await app.getUrl()}`);
  Logger.log(`Swagger UI available at: ${await app.getUrl()}/docs`);
  Logger.log(
    `subscription: ${configService.get('SUBSCRIPTION_URL') ?? getSubscriptionUrlByNetwork(configService.getOrThrow('NETWORK'))}`,
  );
  Logger.log(
    `Credits disabled: ${configService.get('DISABLE_CREDITS')}. type: ${typeof configService.get('DISABLE_CREDITS')}`,
  );

  if (!isRedisEnabled()) {
    Logger.warn('--- Redis is NOT configured (REDIS_URL not set) ---');
    Logger.warn('The following features are disabled:');
    Logger.warn('  • TasksModule (BullMQ job queues / scheduled tasks)');
    Logger.warn('  • TokenLimiter (credit/token tracking)');
    Logger.warn('  • ClaimProcessingService (on-chain credit claims)');
    Logger.warn('  • RedisService (direct Redis client)');
    Logger.warn('Set REDIS_URL to enable these features.');
  }
}

function registerGracefulShutdown({
  app,
  matrixManager,
}: {
  app: INestApplication;
  matrixManager: MatrixManager;
}): void {
  const context = 'Bootstrap';

  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    Logger.log(`${signal} received, starting graceful shutdown...`, context);

    try {
      // Step 1: Upload checkpoints to Matrix
      try {
        const userMatrixSqliteSyncService = app.get(
          UserMatrixSqliteSyncService,
        );
        Logger.log(
          'Uploading checkpoint to Matrix storage task started',
          context,
        );
        await userMatrixSqliteSyncService.uploadCheckpointToMatrixStorageTask();
        Logger.log(
          'Uploading checkpoint to Matrix storage task complete',
          context,
        );
      } catch (error) {
        Logger.warn(
          'Failed to upload checkpoint during shutdown (continuing anyway)',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      // Step 2: Close Nest application
      try {
        Logger.log('Stopping Nest application...', context);
        await app.close();
        Logger.log('Nest application stopped', context);
      } catch (error) {
        Logger.error(
          'Error stopping Nest application',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      // Step 3: Shutdown MatrixManager
      try {
        Logger.log('Stopping MatrixManager client...', context);
        await matrixManager.shutdown();
        Logger.log('MatrixManager client stopped', context);
      } catch (error) {
        Logger.error(
          'Error stopping MatrixManager',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      // Step 4: Destroy EditorMatrixClient
      try {
        Logger.log('Stopping EditorMatrixClient...', context);
        await EditorMatrixClient.destroy();
        Logger.log('EditorMatrixClient stopped', context);
      } catch (error) {
        Logger.error(
          'Error stopping EditorMatrixClient',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      Logger.log('Graceful shutdown complete', context);
      process.exit(0);
    } catch (error) {
      Logger.error(
        'Error during graceful shutdown',
        error instanceof Error ? error.stack : String(error),
        context,
      );
      process.exit(1);
    }
  };

  ['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.once(signal, () => void gracefulShutdown(signal as NodeJS.Signals));
  });
}

// Handle unhandled promise rejections
process.on(
  'unhandledRejection',
  (reason: unknown, promise: Promise<unknown>) => {
    const context = 'UnhandledRejection';
    Logger.error(
      `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      reason instanceof Error ? reason.stack : String(reason),
      context,
    );
    // Log the promise for debugging (but don't log the full promise object as it may be circular)
    Logger.error(`Promise: ${String(promise)}`, context);
    // Don't exit - let the server continue running, but log the error
  },
);

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  const context = 'UncaughtException';
  Logger.error(`Uncaught Exception: ${error.message}`, error.stack, context);
  // For uncaught exceptions, we should exit gracefully
  // But give it a moment to log and clean up
  setTimeout(() => {
    Logger.error('Exiting due to uncaught exception', context);
    process.exit(1);
  }, 1000);
});

// Wrap bootstrap in try-catch to handle initialization errors
bootstrap().catch((error) => {
  Logger.error(
    'Failed to start application',
    error instanceof Error ? error.stack : String(error),
    'Bootstrap',
  );
  process.exit(1);
});
