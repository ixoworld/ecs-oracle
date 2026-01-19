# DataVault with Intelligent Data Analysis

This module implements an intelligent data offloading system that uses a sub-agent to analyze MCP responses and provide semantic understanding with **intelligent path-based extraction**.

## Overview

When MCP tools return large datasets, the system:

1. **Strategic Sampling**: Takes strategic samples (first 1KB, middle chunks, last 500 bytes)
2. **Sub-Agent Analysis**: Uses a cheap model (Claude Haiku) to analyze samples and provide:
   - Semantic description (what the data represents)
   - Data type classification (timeseries, tabular, hierarchical, etc.)
   - **Extraction paths** (where to find data arrays in response)
   - **Preservation paths** (what metadata to keep inline for LLM)
   - Visualization recommendations for AG-UI
   - Data quality insights
   - Metadata enhancements
3. **Intelligent Extraction**: Extracts data using paths from sub-agent (no hardcoded field names!)
4. **DataVault Storage**: Stores extracted data with enriched metadata
5. **LLM Context**: Returns preserved metadata + vault references (~2-5k tokens) instead of full data (~200k tokens)

## Architecture

```
MCP Tool Response (200k tokens)
    ↓
Strategic Sampling (3KB samples)
    ↓
Data Analysis Sub-Agent (Haiku)
    ↓
Returns: Paths + Semantics
  - dataExtractionPaths: ["payload.transactions"]
  - preserveInlinePaths: ["status", "meta"]
  - semanticDescription: "what it means"
    ↓
Intelligent Path-Based Extraction (no hardcoded fields!)
    ↓
DataVault Storage + Enhanced Metadata
    ↓
LLM sees: Preserved Context + Metadata (2-5k tokens) + Semantics
    ↓
Frontend fetches full data when needed
```

## Key Components

### 1. Data Analysis Sub-Agent
**File**: `graph/agents/data-analysis-agent.ts`

A specialized sub-agent using Claude Haiku (~$0.0001 per call, 150-350ms latency) to analyze data samples.

**What it receives:**
- Strategic samples from MCP response
- Context (tool name, args, user query)
- Basic metadata (size, row count)

**What it returns:**
```typescript
{
  semanticDescription: "Personal expense transactions over a year",
  dataType: "timeseries",
  offloadRecommendation: "offload_all",
  visualizationSuggestions: ["create_data_table", "create_line_chart"],
  qualityInsights: ["ISO date format", "5 categories detected"],
  metadataEnhancements: { dateRange: {...}, topCategories: [...] },
  dataExtractionPaths: ["response.data.transactions"],  // NEW!
  preserveInlinePaths: ["status", "meta", "summary"]     // NEW!
}
```

### 2. Data Analysis Service
**File**: `data-vault/data-analysis.service.ts`

Manages sub-agent invocation and strategic sampling logic.

**Key methods:**
- `analyzeData(request)` - Main analysis entry point
- `createStrategicSamples(data)` - Extract samples from large data
- `extractBasicMetadata(data)` - Get size, row count, structure

**Caching (TODO):**
- MCP tools typically return consistent structures
- Cache key: `${toolName}:${hash(toolArgs)}` → `DataAnalysisResult`
- TTL: 24 hours
- Expected hit rate: 80-90% after first invocation

### 3. MCP Tool Wrapper
**File**: `data-vault/mcp-tool-wrapper.ts`

Wraps MCP tools to intercept large responses and trigger analysis.

**Flow:**
1. MCP tool returns large data
2. Check if offload needed (`shouldOffload`)
3. Create strategic samples
4. Call sub-agent for analysis
5. Store in vault with semantic analysis
6. Return enriched metadata to LLM

### 4. DataVault Service
**File**: `data-vault/data-vault.service.ts`

Stores data and generates metadata with semantic enrichment.

**Enhanced metadata now includes:**
```typescript
{
  handleId: "vault-abc-123",
  fetchToken: "xyz-789",
  sourceTool: "database__query",
  schema: [...],
  rowCount: 1000,
  sampleRows: [...],
  columnStats: [...],
  semantics: {
    description: "What this data represents",
    dataType: "timeseries",
    suggestedVisualizations: ["create_line_chart"],
    visualizationRationale: "Why these viz fit",
    qualityInsights: ["ISO dates", "5 categories"],
    enhancements: { dateRange: {...} }
  },
  _dataOffloaded: true,
  _note: "Instructions for LLM..."
}
```

## Usage

### Setting up in main agent

```typescript
import { DataVaultService } from './data-vault/data-vault.service';
import { DataAnalysisService } from './data-vault/data-analysis.service';
import { wrapMCPToolsWithDataVault } from './data-vault/mcp-tool-wrapper';

// In your agent initialization
const dataVaultService = // ... injected via DI
const dataAnalysisService = new DataAnalysisService();

// Wrap MCP tools before passing to agent
const mcpTools = await getMCPTools();
const wrappedTools = wrapMCPToolsWithDataVault(mcpTools, {
  userDid: 'did:ixo:abc123',
  sessionId: 'session-xyz',
  dataVault: dataVaultService,
  dataAnalysis: dataAnalysisService,
  userQuery: 'Show me my transaction history', // Optional but recommended
});

// Use wrappedTools in your agent
const agent = createAgent({ tools: wrappedTools });
```

### Using the factory pattern

```typescript
import { createMCPToolWrapper } from './data-vault/mcp-tool-wrapper';

// Create wrapper function (once per app)
const wrapMCPTools = createMCPToolWrapper(
  dataVaultService,
  dataAnalysisService
);

// Use per request
const wrappedTools = wrapMCPTools(
  mcpTools,
  userDid,
  sessionId,
  userQuery // optional
);
```

## Cost Analysis

### Without Sub-Agent (Old Approach)
- MCP returns 200k tokens → All sent to LLM
- Cost per request: ~$0.60 (200k tokens × $3/M)
- No semantic understanding
- Manual visualization decisions

### With Sub-Agent (New Approach)
- MCP returns 200k tokens → Samples (3KB) sent to sub-agent
- Sub-agent cost: ~$0.0001 (Haiku analyzing 3KB)
- Metadata to LLM: ~3k tokens
- Cost per request: ~$0.01 (3k tokens × $3/M) + $0.0001
- **Savings: 98%**
- **Bonus: Semantic understanding + viz recommendations**

### Caching Benefits
With caching (TODO):
- First call: $0.01 + $0.0001 = $0.0101
- Subsequent calls (cache hit): $0.01 (no sub-agent call)
- Expected hit rate: 80-90%
- **Average cost per request: ~$0.0102** (98.3% cheaper than old approach)

## Performance

- **Sub-agent latency**: 150-350ms
- **Strategic sampling**: <10ms (just slicing strings)
- **Total overhead**: ~200-400ms per large response
- **Acceptable tradeoff** for 98% cost reduction + semantic enrichment

## Future Enhancements (TODOs)

### 1. Caching Layer
**Location**: `data-analysis.service.ts` (lines 17-21, 72-79, 97-106)

Implement caching to avoid re-analyzing identical MCP tool response structures:

```typescript
// Cache key structure
const cacheKey = `${toolName}:${hash(toolArgs)}`;

// Cache storage options
// Option A: Redis (distributed, persistent)
// Option B: In-memory Map (fast, single-instance)
// Option C: Database (persistent, queryable)

// TTL: 24 hours (structures rarely change)
```

**Expected impact:**
- 80-90% cache hit rate after warm-up
- Sub-agent calls reduced by 80-90%
- Response time improved by ~200ms on cache hits

### 2. Adaptive Sampling
Currently uses fixed sampling strategy. Could adapt based on:
- Data size (larger data → more samples)
- Data complexity (nested structures → targeted sampling)
- Previous analysis results (focus on interesting regions)

### 3. Multi-Model Support
- Allow configuration of different models for analysis
- Use even cheaper models for simple data (e.g., Haiku vs Opus)
- Use more powerful models for complex structures

### 4. Analysis Result Streaming
For very large datasets, stream analysis results as they're generated rather than waiting for complete analysis.

## Configuration

Environment variables (see `data-vault.module.ts`):

```bash
# DataVault thresholds
DATA_VAULT_MAX_INLINE_ROWS=100        # Rows before offload
DATA_VAULT_MAX_INLINE_TOKENS=10000    # Tokens before offload
DATA_VAULT_MAX_INLINE_BYTES=51200     # Bytes before offload (50KB)

# Cache TTL
DATA_VAULT_TTL_MS=1800000              # 30 minutes
DATA_VAULT_GRACE_PERIOD_MS=300000      # 5 minutes
```

## Monitoring

Key metrics to track:
- Sub-agent invocation count
- Sub-agent latency (p50, p95, p99)
- Cache hit rate (when implemented)
- Average metadata size
- Data offload rate (% of MCP calls triggering offload)
- Cost per request

## Testing

TODO: Add tests for:
- Strategic sampling logic
- Sub-agent response parsing
- Error handling (sub-agent failures)
- Metadata enrichment
- Cache operations (when implemented)

## References

- **Main PR Discussion**: [Link to PR or issue]
- **Strategic Sampling Inspiration**: Claude's own file handling approach
- **Cost Analysis**: Based on Anthropic/OpenRouter pricing as of Dec 2024
