import { Injectable, Logger } from '@nestjs/common';
import { createDataAnalysisAgent } from '../graph/agents/data-analysis-agent';

/**
 * Request for data analysis sub-agent
 */
export interface DataAnalysisRequest {
  /** Strategic samples from the MCP response */
  samples: DataSamples;
  /** Context about the MCP tool */
  context: {
    toolName: string;
    toolArgs?: Record<string, unknown>;
    userQuery?: string;
  };
  /** Basic metadata */
  metadata: {
    totalSizeBytes: number;
    estimatedRows?: number;
    isArray: boolean;
    topLevelKeys?: string[];
  };
}

/**
 * Strategic samples taken from MCP response
 */
export interface DataSamples {
  /** First ~1KB of the response */
  firstChunk: string;
  /** Middle samples (if data is large enough) */
  middleChunks: string[];
  /** Last ~500 bytes of the response */
  lastChunk: string;
  /** Sample strategy used */
  strategy: 'full' | 'strategic_sampling';
}

/**
 * Offload recommendation from analysis
 */
export type OffloadRecommendation =
  | 'offload_all'
  | 'offload_array'
  | 'keep_inline'
  | 'aggregate_first';

/**
 * Data type classification
 */
export type DataTypeClassification =
  | 'timeseries'
  | 'tabular'
  | 'hierarchical'
  | 'geospatial'
  | 'text'
  | 'mixed';

/**
 * Result from data analysis sub-agent
 */
export interface DataAnalysisResult {
  /** Human-readable description of what this data represents */
  semanticDescription: string;
  /** Classification of data structure */
  dataType: DataTypeClassification;
  /** Whether to offload to vault */
  offloadRecommendation: OffloadRecommendation;
  /** Reasoning for offload decision */
  offloadReason: string;
  /** Suggested AG-UI visualization tools */
  visualizationSuggestions: string[];
  /** Why these visualizations fit */
  visualizationRationale: string;
  /** Data quality notes */
  qualityInsights: string[];
  /** Additional metadata to include in vault */
  metadataEnhancements: Record<string, unknown>;
  /** JSON paths to main data arrays to extract (e.g., ["data.transactions", "results"]) */
  dataExtractionPaths: string[];
  /** JSON paths to preserve inline (e.g., ["meta", "pagination"]) */
  preserveInlinePaths: string[];
}

/**
 * Data Analysis Service
 *
 * Provides intelligent analysis of MCP responses using a sub-agent.
 * Uses strategic sampling to understand data semantics without processing entire datasets.
 */
@Injectable()
export class DataAnalysisService {
  private readonly logger = new Logger(DataAnalysisService.name);
  // TODO: Add caching layer - MCP tools typically return consistent structures
  // Cache key: `${toolName}:${hash(toolArgs)}` -> DataAnalysisResult
  // TTL: 24 hours (structures rarely change)
  // This would reduce sub-agent calls by ~80-90% after first invocation per tool+args combo

  /**
   * Analyze MCP response using strategic sampling and sub-agent
   */
  async analyzeData(request: DataAnalysisRequest): Promise<DataAnalysisResult> {
    const startTime = Date.now();

    try {
      // TODO: Check cache first
      // const cacheKey = this.buildCacheKey(request.context.toolName, request.context.toolArgs);
      // const cached = await this.checkCache(cacheKey);
      // if (cached) {
      //   this.logger.log(`Cache hit for ${request.context.toolName}`);
      //   return cached;
      // }

      this.logger.log(`Analysis starting: tool=${request.context.toolName} size=${(request.metadata.totalSizeBytes / 1024).toFixed(2)}KB rows=${request.metadata.estimatedRows || 'unknown'}`);

      // Create sub-agent instance
      const agent = await createDataAnalysisAgent();

      // Build analysis prompt with samples and context
      const analysisPrompt = this.buildAnalysisPrompt(request);


      // Validate agent has model
      if (!agent.model || typeof agent.model === 'string') {
        throw new Error('Agent model is not properly initialized');
      }

      // Call the model with system prompt + user prompt
      const response = await agent.model.invoke([
        { role: 'system' as const, content: agent.systemPrompt },
        { role: 'user' as const, content: analysisPrompt },
      ]);

      // Parse response - handle different return types from LangChain
      let textContent: string;

      if (typeof response === 'string') {
        textContent = response;
      } else if (
        response &&
        typeof response === 'object' &&
        'content' in response
      ) {
        const content = (response as any).content;
        textContent =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.text)
                  .join('')
              : String(content);
      } else {
        textContent = String(response);
      }

      const result = this.parseAnalysisResponse(textContent);

      const duration = Date.now() - startTime;
      this.logger.log(`Analysis complete: ${result.offloadRecommendation} ${result.dataType} (${duration}ms)`);

      // TODO: Store in cache
      // await this.storeInCache(cacheKey, result);

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to analyze data from ${request.context.toolName}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Create strategic samples from MCP response data
   */
  createStrategicSamples(data: unknown): DataSamples {
    const jsonStr = JSON.stringify(data);
    const totalBytes = jsonStr.length;

    // For small data (<5KB), include everything
    if (totalBytes <= 5 * 1024) {
      return {
        firstChunk: jsonStr,
        middleChunks: [],
        lastChunk: '',
        strategy: 'full',
      };
    }

    // Strategic sampling for large data
    const firstChunk = jsonStr.slice(0, 1024); // First 1KB
    const lastChunk = jsonStr.slice(-500); // Last 500 bytes

    // Take 2-3 middle samples
    const middleChunks: string[] = [];
    const quarterPoint = Math.floor(totalBytes * 0.25);
    const halfPoint = Math.floor(totalBytes * 0.5);
    const threeQuarterPoint = Math.floor(totalBytes * 0.75);

    middleChunks.push(jsonStr.slice(quarterPoint, quarterPoint + 512));
    middleChunks.push(jsonStr.slice(halfPoint, halfPoint + 512));
    middleChunks.push(
      jsonStr.slice(threeQuarterPoint, threeQuarterPoint + 512),
    );

    return {
      firstChunk,
      middleChunks,
      lastChunk,
      strategy: 'strategic_sampling',
    };
  }

  /**
   * Extract basic metadata before analysis
   */
  extractBasicMetadata(data: unknown): {
    totalSizeBytes: number;
    estimatedRows?: number;
    isArray: boolean;
    topLevelKeys?: string[];
  } {
    const jsonStr = JSON.stringify(data);
    const isArray = Array.isArray(data);

    return {
      totalSizeBytes: jsonStr.length,
      estimatedRows: isArray ? data.length : undefined,
      isArray,
      topLevelKeys:
        !isArray && typeof data === 'object' && data !== null
          ? Object.keys(data)
          : undefined,
    };
  }

  /**
   * Build analysis prompt for sub-agent
   */
  private buildAnalysisPrompt(request: DataAnalysisRequest): string {
    const { samples, context, metadata } = request;

    let prompt = `# Analyze this MCP response data

## Context
- **Tool**: ${context.toolName}
- **Tool Arguments**: ${JSON.stringify(context.toolArgs || {}, null, 2)}
${context.userQuery ? `- **User Query**: ${context.userQuery}` : ''}

## Metadata
- **Total Size**: ${(metadata.totalSizeBytes / 1024).toFixed(2)} KB
- **Structure**: ${metadata.isArray ? `Array with ${metadata.estimatedRows} items` : `Object with keys: ${metadata.topLevelKeys?.join(', ')}`}

## Data Samples

`;

    if (samples.strategy === 'full') {
      prompt += `**Full Data** (small enough to include entirely):\n\`\`\`json\n${samples.firstChunk}\n\`\`\`\n`;
    } else {
      prompt += `**First 1KB:**\n\`\`\`json\n${samples.firstChunk}\n\`\`\`\n\n`;

      if (samples.middleChunks.length > 0) {
        samples.middleChunks.forEach((chunk, i) => {
          prompt += `**Middle Sample ${i + 1}:**\n\`\`\`json\n${chunk}\n\`\`\`\n\n`;
        });
      }

      prompt += `**Last 500 bytes:**\n\`\`\`json\n${samples.lastChunk}\n\`\`\`\n`;
    }

    prompt += `\n\nAnalyze these samples and provide your structured analysis in JSON format.`;

    return prompt;
  }

  /**
   * Parse sub-agent response
   */
  private parseAnalysisResponse(content: string): DataAnalysisResult {
    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    let jsonStr = jsonMatch ? jsonMatch[1] : content;

    // Strip // comments from JSON (LLM sometimes adds them despite instructions)
    jsonStr = jsonStr.replace(/\/\/[^\n]*/g, '');
    // Remove trailing commas before } or ]
    jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');

    try {
      const parsed = JSON.parse(jsonStr);

      // Validate required fields
      if (
        !parsed.semanticDescription ||
        !parsed.offloadRecommendation ||
        !Array.isArray(parsed.dataExtractionPaths) ||
        !Array.isArray(parsed.preserveInlinePaths)
      ) {
        throw new Error(
          'Missing required fields in analysis response: semanticDescription, offloadRecommendation, dataExtractionPaths, preserveInlinePaths',
        );
      }

      return parsed as DataAnalysisResult;
    } catch (error) {
      this.logger.error('Failed to parse sub-agent response:', error);
      this.logger.debug('Raw response:', content);
      throw error;
    }
  }

  // TODO: Implement caching methods
  // private buildCacheKey(toolName: string, toolArgs?: Record<string, unknown>): string {
  //   const argsHash = toolArgs ? createHash('md5').update(JSON.stringify(toolArgs)).digest('hex') : 'no-args';
  //   return `data-analysis:${toolName}:${argsHash}`;
  // }
  //
  // private async checkCache(key: string): Promise<DataAnalysisResult | null> {
  //   // Implement with Redis, in-memory cache, or database
  //   return null;
  // }
  //
  // private async storeInCache(key: string, result: DataAnalysisResult): Promise<void> {
  //   // Store with 24h TTL
  // }
}
