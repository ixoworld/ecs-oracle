import {
  Controller,
  Get,
  Param,
  Headers,
  UnauthorizedException,
  NotFoundException,
  Logger,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DataVaultService } from './data-vault.service';

/**
 * Controller for secure data vault retrieval
 *
 * Frontend fetches data from this endpoint after receiving a dataHandle
 * from an AG-UI tool call.
 */
@Controller('data-vault')
export class DataVaultController {
  private readonly logger = new Logger(DataVaultController.name);

  constructor(private readonly dataVaultService: DataVaultService) {}

  /**
   * Retrieve data by handle ID
   *
   * Requires:
   * - x-user-did header (validated by auth middleware)
   * - x-data-token header (one-time access token)
   */
  @Get(':handleId')
  async retrieveData(
    @Param('handleId') handleId: string,
    @Headers('x-user-did') userDid: string,
    @Headers('x-data-token') accessToken: string,
    @Res() res: Response,
  ): Promise<void> {
    this.logger.log(
      `Data fetch request for handle ${handleId} from user ${userDid?.slice(-8) ?? 'unknown'}`,
    );

    if (!userDid) {
      throw new UnauthorizedException('User DID required');
    }

    if (!accessToken) {
      throw new UnauthorizedException('Data access token required');
    }

    // Validate access token
    const isValidToken = await this.dataVaultService.validateAccessToken(handleId, accessToken);
    if (!isValidToken) {
      throw new UnauthorizedException('Invalid access token');
    }

    // Retrieve data AND metadata from Redis
    const result = await this.dataVaultService.retrieveWithMetadata(handleId, userDid);

    if (!result) {
      throw new NotFoundException('Data not found or expired');
    }

    // TODO: For very large datasets (>10MB), consider implementing streaming:
    // - Use NDJSON streaming format
    // - Or pagination with ?limit=10000&offset=0
    // - Or binary formats like Parquet/Arrow for DuckDB-WASM efficiency
    // This would require frontend changes to handle chunked responses.

    // Stream response for better memory efficiency
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Data-Row-Count', result.data.length.toString());

    // Return both data and metadata (frontend needs metadata for local caching)
    res.json({
      success: true,
      handleId,
      rowCount: result.data.length,
      data: result.data,
      metadata: result.metadata,
    });
  }

}
