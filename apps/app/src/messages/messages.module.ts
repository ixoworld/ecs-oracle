import { MemoryEngineService, SessionManagerService } from '@ixo/common';
import { Module } from '@nestjs/common';
import { MainAgentGraph } from 'src/graph';
// SseService is provided globally by SseModule, no need to import or provide here.
import { MatrixManager } from '@ixo/matrix';
import { ChannelMemoryModule } from 'src/channel-memory/channel-memory.module';
import { isRedisEnabled } from 'src/config';
import { NoopMemoryEngineService } from 'src/memory-engine/noop-memory-engine.service';
import { TasksModule } from 'src/tasks/tasks.module';
import { UcanModule } from 'src/ucan/ucan.module';
import { CheckpointStorageSyncModule } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.module';
import { UserMatrixSqliteSyncService } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { FileProcessingService } from './file-processing.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [
    CheckpointStorageSyncModule,
    ChannelMemoryModule,
    // TasksModule requires Redis for BullMQ job queues
    ...(isRedisEnabled() ? [TasksModule] : []),
    UcanModule,
  ],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    FileProcessingService,
    MainAgentGraph,
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
  exports: [MessagesService, MemoryEngineService, SessionManagerService],
})
export class MessagesModule {}
