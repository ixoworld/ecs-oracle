import { MemoryEngineService, SessionManagerService } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { Module } from '@nestjs/common';
import { NoopMemoryEngineService } from '../memory-engine/noop-memory-engine.service';
import { MessagesModule } from '../messages/messages.module';
import { UcanModule } from '../ucan/ucan.module';
import { CheckpointStorageSyncModule } from '../user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.module';
import { UserMatrixSqliteSyncService } from '../user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { SessionHistoryProcessor } from './session-history-processor.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [MessagesModule, CheckpointStorageSyncModule, UcanModule],
  controllers: [SessionsController],
  providers: [
    SessionsService,
    SessionHistoryProcessor,
    {
      provide: MemoryEngineService,
      useFactory: () => new NoopMemoryEngineService(),
    },
    {
      provide: SessionManagerService,
      useFactory: (syncService: UserMatrixSqliteSyncService) => {
        return new SessionManagerService(
          syncService,
          MatrixManager.getInstance(),
          undefined,
        );
      },
      inject: [UserMatrixSqliteSyncService],
    },
  ],
  exports: [SessionsService, SessionHistoryProcessor],
})
export class SessionsModule {}
