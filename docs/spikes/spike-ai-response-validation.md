# Spike: AI Response Reliability and Validation

> **Status: spike. Almost none of it shipped.** Reviewed 2026-09-11.
>
> **Shipped.** Structured output with a response schema, which §1 argues for, exists — but as `AIProvider.generateStructured`, implemented for Vertex only, not as the Zod pipeline below. Zod is not a dependency of this package.
>
> **Superseded.** §3's logging wrapper is superseded by `src/shared/logger.ts` and [docs/logging.md](../logging.md), which solve the same problem differently: one JSON object per line with a fixed key set, no wrapper around the provider call. The model id in §7 is retired.
>
> **Still open, and this is most of the document.** §1 schema validation is [ADR-002](../../adrs/ADR-002-response-validation.md), §7 observability is [ADR-003](../../adrs/ADR-003-llm-observability.md), §8 guardrails are [ADR-004](../../adrs/ADR-004-bedrock-guardrails.md) — all three recorded 2026-04-02 and all three still `proposed`. §2 sanity checks, §4 hallucination detection and §6 the pre-deployment checklist have no ADR and no code.
>
> **One warning if you arrived here searching for observability.** §7 specifies CloudWatch alarms and a particular vendor's collector, for a single-cloud deployment. This package is provider-agnostic and emits no telemetry at all: it writes log lines and nothing else. Taking §7 as the current design would be a mistake — it is a proposal for a deployment nobody built.
>
> Nothing below this block has been changed.


## Context

The team needs to validate AI responses for accuracy, detect hallucinations, and ensure tool calls are being made correctly.

From the meeting:
- The proof of concept returned inaccurate data
- The API was providing inaccurate data (not hallucination, but bad source)
- Need to distinguish between AI errors and data source errors
- Team needs confidence that AI is using tools correctly

We need to understand:
- How to test that AI calls the right tools
- How to validate structured output
- How to detect when AI is hallucinating vs using bad data
- How to log and observe AI behavior for debugging

---

## Error Classification Framework

### Distinguishing Error Sources

| Error Type | Description | Detection Method | Example |
|------------|-------------|------------------|---------|
| **AI Hallucination** | Model fabricates data not in context or tools | Cross-reference with tool results; semantic entropy | Made-up entity name "Nonexistent Corp" |
| **Data Source Error** | Tool returns incorrect but real-looking data | Compare against known ground truth; sanity checks | API returns wrong coordinates for a city |
| **Tool Selection Error** | Model calls wrong tool or skips required tool | Audit tool call sequence; compare with expected | Uses search API when weather API was needed |
| **Tool Input Error** | Model passes malformed/incorrect parameters | Schema validation on tool inputs | Passes full name instead of required ID code |
| **Response Format Error** | Output doesn't match expected schema | Zod/JSON schema validation | Missing required `temperature` field |
| **Reasoning Error** | Model misinterprets tool results | LLM-as-judge evaluation; human review | Adds values instead of averaging them |

### Error Source Decision Tree

```
Is the response format valid?
+-- No -> Response Format Error
+-- Yes -> Did the model call the expected tools?
         +-- No -> Tool Selection Error
         +-- Yes -> Were tool inputs valid?
                  +-- No -> Tool Input Error
                  +-- Yes -> Does tool output match ground truth?
                           +-- No -> Data Source Error
                           +-- Yes -> Does AI response match tool output?
                                    +-- No -> AI Hallucination or Reasoning Error
                                    +-- Yes -> Response is valid
```

---

## 1. Schema Validation with Zod

### Response Validation

```typescript
import {z} from 'zod';

const WeatherResponseSchema = z.object({
  success: z.boolean(),
  weather: z
    .object({
      location: z.string().min(1),
      temperature: z.number().min(-90).max(60),
      units: z.enum(['celsius', 'fahrenheit']),
      conditions: z.string(),
      humidity: z.number().min(0).max(100),
      windSpeed: z.number().min(0).max(500),
    })
    .optional(),
  error: z.string().optional(),
});

type WeatherResponse = z.infer<typeof WeatherResponseSchema>;

function validateWeatherResponse(response: unknown): {
  success: boolean;
  data?: WeatherResponse;
  errors?: z.ZodError;
} {
  const result = WeatherResponseSchema.safeParse(response);
  if (result.success) {
    return {success: true, data: result.data};
  }
  return {success: false, errors: result.error};
}
```

### Tool Input Validation

```typescript
const WeatherToolInputSchema = z.object({
  location: z.string().min(1),
  units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
});

const SearchToolInputSchema = z.object({
  query: z.string().min(1),
  filters: z
    .object({
      category: z.string().optional(),
      minScore: z.number().positive().optional(),
      maxResults: z.number().positive().optional(),
    })
    .optional(),
});

function validateToolInput(toolName: string, input: unknown): {valid: boolean; errors?: string[]} {
  const schemas: Record<string, z.ZodSchema> = {
    get_weather: WeatherToolInputSchema,
    search_database: SearchToolInputSchema,
  };

  const schema = schemas[toolName];
  if (!schema) {
    return {valid: false, errors: [`Unknown tool: ${toolName}`]};
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return {valid: true};
  }

  return {
    valid: false,
    errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
  };
}
```

---

## 2. Sanity Checks for Domain Data

```typescript
interface SanityCheckResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
}

function sanityCheckWeather(weather: {temperature: number; humidity: number; windSpeed: number}): SanityCheckResult {
  const checks: SanityCheckResult['checks'] = [];

  checks.push({
    name: 'temperature_range',
    passed: weather.temperature >= -90 && weather.temperature <= 60,
    message:
      weather.temperature < -90 || weather.temperature > 60
        ? `Temperature ${weather.temperature} is outside realistic range`
        : undefined,
  });

  checks.push({
    name: 'humidity_range',
    passed: weather.humidity >= 0 && weather.humidity <= 100,
    message:
      weather.humidity < 0 || weather.humidity > 100
        ? `Humidity ${weather.humidity}% is outside valid range`
        : undefined,
  });

  checks.push({
    name: 'wind_speed_range',
    passed: weather.windSpeed >= 0 && weather.windSpeed <= 500,
    message:
      weather.windSpeed > 500
        ? `Wind speed ${weather.windSpeed} exceeds realistic maximum`
        : undefined,
  });

  return {
    passed: checks.every(c => c.passed),
    checks,
  };
}
```

---

## 3. Logging Wrapper for AI Calls

```typescript
import {randomUUID} from 'crypto';

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  inputValid: boolean;
  inputErrors?: string[];
}

interface AICallLog {
  id: string;
  timestamp: Date;
  userId?: string;
  sessionId?: string;

  // Request
  userMessage: string;
  systemPrompt: string;
  modelId: string;
  temperature: number;

  // Tool Usage
  toolsCalled: ToolCall[];
  expectedTools?: string[];
  toolSelectionCorrect?: boolean;

  // Response
  rawResponse: string;
  parsedResponse?: unknown;
  validationResult: {
    schemaValid: boolean;
    sanityChecksPassed: boolean;
    errors: string[];
  };

  // Metrics
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;

  // Classification
  errorType?: 'hallucination' | 'data_error' | 'tool_error' | 'format_error' | 'none';
  confidenceScore?: number;
}

class AICallLogger {
  private logs: AICallLog[] = [];

  async loggedAICall<T>(
    params: {
      userMessage: string;
      systemPrompt: string;
      modelId: string;
      temperature: number;
      userId?: string;
      sessionId?: string;
      expectedTools?: string[];
    },
    aiCall: () => Promise<{
      response: string;
      toolsCalled: ToolCall[];
      inputTokens: number;
      outputTokens: number;
    }>,
    validator: (response: string) => {schemaValid: boolean; sanityChecksPassed: boolean; errors: string[]; parsed?: T}
  ): Promise<{response: T | null; log: AICallLog}> {
    const startTime = Date.now();
    const log: AICallLog = {
      id: randomUUID(),
      timestamp: new Date(),
      userId: params.userId,
      sessionId: params.sessionId,
      userMessage: params.userMessage,
      systemPrompt: params.systemPrompt,
      modelId: params.modelId,
      temperature: params.temperature,
      expectedTools: params.expectedTools,
      toolsCalled: [],
      rawResponse: '',
      validationResult: {schemaValid: false, sanityChecksPassed: false, errors: []},
      totalDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    try {
      const result = await aiCall();
      log.rawResponse = result.response;
      log.toolsCalled = result.toolsCalled;
      log.inputTokens = result.inputTokens;
      log.outputTokens = result.outputTokens;

      if (params.expectedTools) {
        const calledToolNames = result.toolsCalled.map(t => t.name);
        log.toolSelectionCorrect = params.expectedTools.every(t => calledToolNames.includes(t));
      }

      const validation = validator(result.response);
      log.validationResult = validation;
      log.parsedResponse = validation.parsed;

      log.errorType = this.classifyError(log);

      log.totalDurationMs = Date.now() - startTime;
      this.logs.push(log);

      return {
        response: validation.parsed ?? null,
        log,
      };
    } catch (error) {
      log.totalDurationMs = Date.now() - startTime;
      log.validationResult.errors.push((error as Error).message);
      log.errorType = 'tool_error';
      this.logs.push(log);

      return {response: null, log};
    }
  }

  private classifyError(log: AICallLog): AICallLog['errorType'] {
    if (log.validationResult.schemaValid && log.validationResult.sanityChecksPassed && log.toolSelectionCorrect !== false) {
      return 'none';
    }

    if (!log.validationResult.schemaValid) {
      return 'format_error';
    }

    if (log.toolSelectionCorrect === false || log.toolsCalled.some(t => !t.inputValid)) {
      return 'tool_error';
    }

    const toolsReturnedData = log.toolsCalled.every(t => t.output !== null && t.output !== undefined);
    if (toolsReturnedData && !log.validationResult.sanityChecksPassed) {
      return 'hallucination';
    }

    return 'data_error';
  }

  getRecentLogs(count = 100): AICallLog[] {
    return this.logs.slice(-count);
  }

  getErrorSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const log of this.logs) {
      const type = log.errorType ?? 'unknown';
      summary[type] = (summary[type] ?? 0) + 1;
    }
    return summary;
  }

  exportForAnalysis(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}

export const aiLogger = new AICallLogger();
```

---

## 4. Hallucination Detection Techniques

### Technique 1: Cross-Reference with Tool Results

```typescript
interface HallucinationCheck {
  field: string;
  aiValue: unknown;
  toolValue: unknown;
  matches: boolean;
  confidence: number;
}

function detectHallucinations(
  aiResponse: Record<string, unknown>,
  toolResults: Record<string, unknown>,
  fieldMappings: Array<{aiPath: string; toolPath: string}>
): HallucinationCheck[] {
  const checks: HallucinationCheck[] = [];

  for (const mapping of fieldMappings) {
    const aiValue = getNestedValue(aiResponse, mapping.aiPath);
    const toolValue = getNestedValue(toolResults, mapping.toolPath);

    const matches = deepEqual(aiValue, toolValue);
    const confidence = matches ? 1.0 : calculateSimilarity(aiValue, toolValue);

    checks.push({
      field: mapping.aiPath,
      aiValue,
      toolValue,
      matches,
      confidence,
    });
  }

  return checks;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((acc: unknown, part) => (acc as Record<string, unknown>)?.[part], obj);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function calculateSimilarity(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    const max = Math.max(Math.abs(a), Math.abs(b));
    return max === 0 ? 1.0 : 1.0 - Math.abs(a - b) / max;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    return 1.0 - distance / maxLen;
  }
  return deepEqual(a, b) ? 1.0 : 0.0;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[b.length][a.length];
}
```

### Technique 2: Self-Consistency Check

```typescript
async function selfConsistencyCheck(
  prompt: string,
  generateResponse: (prompt: string, temperature: number) => Promise<string>,
  numSamples = 3,
  temperature = 0.7
): Promise<{consistent: boolean; responses: string[]; agreement: number}> {
  const responses: string[] = [];

  for (let i = 0; i < numSamples; i++) {
    const response = await generateResponse(prompt, temperature);
    responses.push(response);
  }

  const agreements = calculatePairwiseAgreement(responses);
  const avgAgreement = agreements.reduce((a, b) => a + b, 0) / agreements.length;

  return {
    consistent: avgAgreement > 0.8,
    responses,
    agreement: avgAgreement,
  };
}

function calculatePairwiseAgreement(responses: string[]): number[] {
  const agreements: number[] = [];
  for (let i = 0; i < responses.length; i++) {
    for (let j = i + 1; j < responses.length; j++) {
      agreements.push(calculateSimilarity(responses[i], responses[j]));
    }
  }
  return agreements;
}
```

### Technique 3: Known Facts Database

```typescript
interface KnownFact {
  entity: string;
  attribute: string;
  value: unknown;
  source: string;
  lastVerified: Date;
}

class FactChecker {
  private facts: Map<string, KnownFact> = new Map();

  addFact(fact: KnownFact): void {
    const key = `${fact.entity}:${fact.attribute}`;
    this.facts.set(key, fact);
  }

  checkFact(entity: string, attribute: string, claimedValue: unknown): {
    verified: boolean;
    knownValue?: unknown;
    source?: string;
  } {
    const key = `${entity}:${attribute}`;
    const fact = this.facts.get(key);

    if (!fact) {
      return {verified: false};
    }

    const matches = deepEqual(fact.value, claimedValue) || calculateSimilarity(fact.value, claimedValue) > 0.9;

    return {
      verified: matches,
      knownValue: fact.value,
      source: fact.source,
    };
  }
}

// Pre-populate with known reference data
const factChecker = new FactChecker();
factChecker.addFact({
  entity: 'Berlin',
  attribute: 'country',
  value: 'Germany',
  source: 'Reference database',
  lastVerified: new Date(),
});
factChecker.addFact({
  entity: 'Berlin',
  attribute: 'coordinates',
  value: [13.405, 52.52],
  source: 'Reference database',
  lastVerified: new Date(),
});
```

---

## 5. Testing Strategy

### Unit Tests for Tool Execution

```typescript
import {describe, it, expect} from 'vitest';

describe('Tool Execution', () => {
  it('validates weather tool input schema', () => {
    const validInput = {location: 'Berlin', units: 'celsius'};
    const invalidInput = {location: ''};

    expect(validateToolInput('get_weather', validInput).valid).toBe(true);
    expect(validateToolInput('get_weather', invalidInput).valid).toBe(false);
  });

  it('rejects tool input with out-of-range values', () => {
    const input = {
      query: 'test',
      filters: {
        minScore: -5, // Invalid: negative score
      },
    };

    const result = validateToolInput('search_database', input);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expect.stringContaining('minScore'));
  });
});
```

### Integration Tests with Mock Provider

```typescript
import {describe, it, expect} from 'vitest';

const mockToolResponses: Record<string, unknown> = {
  get_weather: {
    location: 'Berlin',
    temperature: 18,
    units: 'celsius',
    conditions: 'Partly cloudy',
    humidity: 65,
    windSpeed: 12,
  },
};

describe('AI Response Validation', () => {
  it('passes validation for correct weather response', () => {
    const response = {
      success: true,
      weather: {
        location: 'Berlin',
        temperature: 18,
        units: 'celsius',
        conditions: 'Partly cloudy',
        humidity: 65,
        windSpeed: 12,
      },
    };

    const result = validateWeatherResponse(response);
    expect(result.success).toBe(true);
  });

  it('fails validation for impossible temperature', () => {
    const response = {
      success: true,
      weather: {
        location: 'Berlin',
        temperature: 100, // Impossible celsius temperature
        units: 'celsius',
        conditions: 'Clear',
        humidity: 50,
        windSpeed: 10,
      },
    };

    const result = validateWeatherResponse(response);
    expect(result.success).toBe(false);
  });

  it('detects hallucination when AI value differs from tool result', () => {
    const aiResponse = {
      weather: {temperature: 35},
    };
    const toolResult = {
      temperature: 18,
    };

    const checks = detectHallucinations(aiResponse, {weather: toolResult}, [{aiPath: 'weather.temperature', toolPath: 'temperature'}]);

    expect(checks[0].matches).toBe(false);
    expect(checks[0].confidence).toBeLessThan(0.9);
  });
});
```

### Regression Tests for Known Scenarios

```typescript
interface TestScenario {
  name: string;
  userMessage: string;
  expectedTools: string[];
  expectedOutputFields: string[];
  groundTruth?: Record<string, unknown>;
}

const regressionScenarios: TestScenario[] = [
  {
    name: 'Berlin weather lookup',
    userMessage: 'What is the weather in Berlin?',
    expectedTools: ['get_weather'],
    expectedOutputFields: ['weather.temperature', 'weather.conditions'],
    groundTruth: {
      'weather.temperature': {min: -30, max: 45},
      'weather.humidity': {min: 0, max: 100},
    },
  },
  {
    name: 'Database search with filters',
    userMessage: 'Search for items in category electronics with score above 4',
    expectedTools: ['search_database'],
    expectedOutputFields: ['results', 'totalCount'],
  },
];

describe('Regression Tests', () => {
  for (const scenario of regressionScenarios) {
    it(scenario.name, async () => {
      const result = await runAIScenario(scenario.userMessage);

      const calledTools = result.log.toolsCalled.map(t => t.name);
      for (const expected of scenario.expectedTools) {
        expect(calledTools).toContain(expected);
      }

      if (scenario.groundTruth && result.response) {
        for (const [path, bounds] of Object.entries(scenario.groundTruth)) {
          const value = getNestedValue(result.response as Record<string, unknown>, path) as number;
          const {min, max} = bounds as {min: number; max: number};
          expect(value).toBeGreaterThanOrEqual(min);
          expect(value).toBeLessThanOrEqual(max);
        }
      }
    });
  }
});
```

---

## 6. Pre-Deployment Validation Checklist

```typescript
interface ValidationChecklistItem {
  category: string;
  check: string;
  automated: boolean;
  passed?: boolean;
  notes?: string;
}

const preDeploymentChecklist: ValidationChecklistItem[] = [
  // Schema Validation
  {category: 'Schema', check: 'All response types have Zod schemas defined', automated: true},
  {category: 'Schema', check: 'Tool input schemas validate all required fields', automated: true},

  // Tool Calling
  {category: 'Tools', check: 'All expected tools are called for test queries', automated: true},
  {category: 'Tools', check: 'Tool selection accuracy > 95% on test set', automated: true},
  {category: 'Tools', check: 'Tool input validation catches malformed requests', automated: true},

  // Sanity Checks
  {category: 'Sanity', check: 'Response values pass range checks', automated: true},

  // Hallucination Detection
  {category: 'Hallucination', check: 'AI responses match tool outputs for key fields', automated: true},
  {category: 'Hallucination', check: 'Self-consistency check passes (3 samples, >80% agreement)', automated: true},
  {category: 'Hallucination', check: 'Known facts verification passes', automated: true},

  // Error Handling
  {category: 'Errors', check: 'Invalid inputs return appropriate error messages', automated: true},
  {category: 'Errors', check: 'Tool failures are handled gracefully', automated: true},
  {category: 'Errors', check: 'Error classification correctly identifies error type', automated: true},

  // Observability
  {category: 'Observability', check: 'All AI calls are logged with full context', automated: true},
  {category: 'Observability', check: 'Tool call latency is tracked', automated: true},
  {category: 'Observability', check: 'Token usage is recorded', automated: true},

  // Manual Checks
  {category: 'Manual', check: 'Sample responses reviewed by domain expert', automated: false},
  {category: 'Manual', check: 'Edge cases tested (empty results, timeouts)', automated: false},
  {category: 'Manual', check: 'Error messages are user-friendly', automated: false},
];
```

---

## 7. Observability Stack (AWS + Dash0)

### CloudWatch Logs

**Pros:**
- Native AWS integration
- No additional infrastructure
- Works with existing IAM
- Pay per use pricing

**Integration:**

```typescript
import {CloudWatchLogs, PutLogEventsCommand} from '@aws-sdk/client-cloudwatch-logs';

const cloudwatch = new CloudWatchLogs({region: 'eu-west-1'});

async function logToCloudWatch(log: AICallLog): Promise<void> {
  await cloudwatch.send(
    new PutLogEventsCommand({
      logGroupName: '/hal-engine/ai-calls',
      logStreamName: `${new Date().toISOString().split('T')[0]}`,
      logEvents: [
        {
          timestamp: Date.now(),
          message: JSON.stringify({
            ...log,
            userMessage: log.userMessage.substring(0, 100),
          }),
        },
      ],
    })
  );
}
```

### CloudWatch Metrics

Track custom metrics for AI performance:

```typescript
import {CloudWatch, PutMetricDataCommand} from '@aws-sdk/client-cloudwatch';

const cloudwatchMetrics = new CloudWatch({region: 'eu-west-1'});

async function recordAIMetrics(log: AICallLog): Promise<void> {
  await cloudwatchMetrics.send(
    new PutMetricDataCommand({
      Namespace: 'HalEngine/AI',
      MetricData: [
        {
          MetricName: 'ResponseLatency',
          Value: log.totalDurationMs,
          Unit: 'Milliseconds',
          Dimensions: [{Name: 'ModelId', Value: log.modelId}],
        },
        {
          MetricName: 'InputTokens',
          Value: log.inputTokens,
          Unit: 'Count',
          Dimensions: [{Name: 'ModelId', Value: log.modelId}],
        },
        {
          MetricName: 'OutputTokens',
          Value: log.outputTokens,
          Unit: 'Count',
          Dimensions: [{Name: 'ModelId', Value: log.modelId}],
        },
        {
          MetricName: 'ValidationErrors',
          Value: log.errorType === 'none' ? 0 : 1,
          Unit: 'Count',
          Dimensions: [{Name: 'ErrorType', Value: log.errorType ?? 'unknown'}],
        },
      ],
    })
  );
}
```

### CloudWatch Alarms

Set up alerts for anomalies:

```typescript
import {CloudWatch, PutMetricAlarmCommand} from '@aws-sdk/client-cloudwatch';

await cloudwatchMetrics.send(
  new PutMetricAlarmCommand({
    AlarmName: 'HalEngine-HighErrorRate',
    MetricName: 'ValidationErrors',
    Namespace: 'HalEngine/AI',
    Statistic: 'Sum',
    Period: 300,
    EvaluationPeriods: 2,
    Threshold: 10,
    ComparisonOperator: 'GreaterThanThreshold',
    AlarmActions: [process.env.SNS_ALERT_TOPIC_ARN],
  })
);

await cloudwatchMetrics.send(
  new PutMetricAlarmCommand({
    AlarmName: 'HalEngine-HighLatency',
    MetricName: 'ResponseLatency',
    Namespace: 'HalEngine/AI',
    Statistic: 'Average',
    Period: 300,
    EvaluationPeriods: 2,
    Threshold: 30000,
    ComparisonOperator: 'GreaterThanThreshold',
    AlarmActions: [process.env.SNS_ALERT_TOPIC_ARN],
  })
);
```

### CloudWatch Insights Queries

Useful queries for debugging:

```sql
-- Find all hallucination errors
fields @timestamp, @message
| filter errorType = 'hallucination'
| sort @timestamp desc
| limit 100

-- Analyze error distribution
fields errorType
| stats count(*) by errorType

-- Find slow responses
fields @timestamp, totalDurationMs, modelId
| filter totalDurationMs > 10000
| sort totalDurationMs desc
| limit 50

-- Token usage by model
fields modelId, inputTokens, outputTokens
| stats sum(inputTokens) as totalInput, sum(outputTokens) as totalOutput by modelId
```

### Dash0 with OpenLLMetry (Recommended for LLM Observability)

Dash0 is OpenTelemetry-native and integrates with OpenLLMetry for LLM-specific observability including 50+ LLM providers.

**Installation:**

```bash
npm install @traceloop/node-server-sdk
```

**Integration:**

```typescript
import * as traceloop from '@traceloop/node-server-sdk';

traceloop.initialize({
  baseUrl: process.env.DASH0_OTEL_ENDPOINT,
  apiKey: process.env.DASH0_API_KEY,
  appName: 'hal-engine',
  disableBatch: false,
});
```

**Manual Spans for Tool Calls:**

```typescript
import {trace, SpanKind, SpanStatusCode} from '@opentelemetry/api';

const tracer = trace.getTracer('hal-engine');

async function tracedToolExecution(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  return tracer.startActiveSpan(
    `tool.${toolName}`,
    {kind: SpanKind.INTERNAL},
    async span => {
      try {
        span.setAttribute('tool.name', toolName);
        span.setAttribute('tool.input', JSON.stringify(input));

        const result = await executeTool(toolName, input);

        span.setAttribute('tool.success', true);
        span.setStatus({code: SpanStatusCode.OK});
        return result;
      } catch (error) {
        span.setAttribute('tool.success', false);
        span.setStatus({code: SpanStatusCode.ERROR, message: (error as Error).message});
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
```

**Custom Attributes for AI Validation:**

```typescript
import {trace} from '@opentelemetry/api';

function recordValidationResult(log: AICallLog): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('ai.validation.schema_valid', log.validationResult.schemaValid);
    span.setAttribute('ai.validation.sanity_passed', log.validationResult.sanityChecksPassed);
    span.setAttribute('ai.error_type', log.errorType ?? 'none');
    span.setAttribute('ai.tokens.input', log.inputTokens);
    span.setAttribute('ai.tokens.output', log.outputTokens);
    span.setAttribute('ai.tools_called', log.toolsCalled.map(t => t.name).join(','));
  }
}
```

**Dash0 Benefits for LLM Observability:**

| Feature | Benefit |
|---------|---------|
| OpenTelemetry native | Works with existing OTel instrumentation |
| LLM-specific traces | Automatic capture of tokens, latency, model params |
| 50+ integrations | Supports Bedrock, OpenAI, Anthropic, etc. |
| No hallucination risk | AI features are behind-the-scenes, safe |
| PromQL support | Query metrics using standard PromQL |

---

## 8. AWS Bedrock Guardrails

### Configuration

```typescript
import {BedrockClient, CreateGuardrailCommand} from '@aws-sdk/client-bedrock';

const bedrockClient = new BedrockClient({region: 'eu-west-1'});

const guardrail = await bedrockClient.send(
  new CreateGuardrailCommand({
    name: 'hal-engine-guardrail',
    description: 'Content filtering for hal-engine',
    contentPolicyConfig: {
      filtersConfig: [
        {type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH'},
        {type: 'INSULTS', inputStrength: 'HIGH', outputStrength: 'HIGH'},
        {type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH'},
        {type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM'},
        {type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH'},
        {type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE'},
      ],
    },
    blockedInputMessaging: 'Your request contains content that cannot be processed.',
    blockedOutputsMessaging: 'The response was filtered due to content policy.',
  })
);
```

### Using with Converse API

```typescript
const response = await client.send(
  new ConverseCommand({
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    messages,
    guardrailConfig: {
      guardrailIdentifier: guardrail.guardrailId,
      guardrailVersion: 'DRAFT',
      trace: 'enabled',
    },
  })
);

if (response.stopReason === 'guardrail_intervened') {
  console.log('Content was filtered by guardrail');
}
```

---

## References

### Validation & Schema
- [Zod Documentation](https://zod.dev/)
- [zod-gpt GitHub](https://github.com/dzhng/zod-gpt)
- [Structured Outputs Guide](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms)

### Hallucination Detection
- [LLM Hallucination Detection Techniques](https://www.deepchecks.com/llm-hallucination-detection-and-mitigation-best-techniques/)
- [Datadog LLM-as-Judge](https://www.datadoghq.com/blog/ai/llm-hallucination-detection/)
- [AWS RAG Hallucination Detection](https://aws.amazon.com/blogs/machine-learning/detect-hallucinations-for-rag-based-systems/)
- [5 Techniques for Detecting Hallucinations](https://galileo.ai/blog/5-techniques-for-detecting-llm-hallucinations)

### Testing
- [Langfuse Testing Guide](https://langfuse.com/blog/2025-10-21-testing-llm-applications)
- [DeepEval Framework](https://github.com/confident-ai/deepeval)
- [LangChain Testing Docs](https://docs.langchain.com/oss/python/langchain/test)
- [Mocking LLM Responses](https://medium.com/@vuongngo/effective-practices-for-mocking-llm-responses-during-the-software-development-lifecycle-73f726c3f994)

### Observability
- [Dash0 Documentation](https://www.dash0.com/)
- [OpenLLMetry Dash0 Integration](https://www.traceloop.com/docs/openllmetry/integrations/dash0)
- [OpenTelemetry LLM Observability](https://opentelemetry.io/blog/2024/llm-observability/)
- [CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/WhatIsCloudWatchLogs.html)
- [CloudWatch Metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/working_with_metrics.html)
- [AWS X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/aws-xray.html)

### AWS Bedrock
- [Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
- [Content Filters Configuration](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-content-filters.html)
- [ApplyGuardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)

### Tool Evaluation
- [Anthropic Tool Evaluation Guide](https://platform.claude.com/docs/en/test-and-evaluate/eval-tool)
- [Anthropic Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)

---

## Conclusion

Key recommendations:

1. **Validation Strategy**: Use Zod for schema validation + domain-specific sanity checks
2. **Hallucination Detection**: Cross-reference AI output with tool results; use self-consistency checks
3. **Error Classification**: Implement the decision tree to distinguish AI errors from data errors
4. **Testing**: Unit tests for tools, integration tests with mocked responses, regression tests for known scenarios
5. **Observability**: Use Dash0 with OpenLLMetry for LLM-specific tracing; CloudWatch for AWS-native metrics and alarms
6. **Guardrails**: Enable AWS Bedrock guardrails for content filtering

Next steps:
1. Implement Zod schemas for all response types
2. Add sanity checks for tool results
3. Set up logging infrastructure
4. Create regression test suite with ground truth data
