# Adding E2E Tests and Evaluation for a Tool

After building a tool (see [adding-a-tool.md](adding-a-tool.md)), you need two things to verify it works end-to-end with the AI:

1. **Ground truth script** -- calls the backend API directly (no LLM) to record expected results
2. **Evaluation config** -- sends natural language questions to the AI agent and compares its answers against ground truth

Both run via yarn commands from the project root.

---

## Step 1: Create the ground truth script

The ground truth script bypasses the AI entirely. It calls your backend API with known parameters and records the expected results. This is the source of truth.

Create `scripts/e2e-<tool-name>.ts`:

```typescript
import {createSign} from 'crypto';
import {writeFileSync} from 'fs';

const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';

interface TestCase {
  id: string;
  question: string;
  type: string;
  apiParams: Record<string, unknown>;
  count: number;
}

const testCases: TestCase[] = [
  {
    id: 'T1',
    question: 'total items',
    type: 'default',
    apiParams: {},
    count: 0, // filled by the script
  },
  {
    id: 'T2',
    question: 'filtered items with category X',
    type: 'categoryX',
    apiParams: {category: 'X'},
    count: 0,
  },
];

async function fetchCount(params: Record<string, unknown>, token: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/your-api-endpoint`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify(params),
  });
  const data = await res.json();
  return data.totalCount;
}

async function run(): Promise<void> {
  if (!JWT_PRIVATE_KEY) {
    console.error('JWT_PRIVATE_KEY required. Source the .env first.');
    process.exit(1);
  }

  const token = createToken(); // reuse JWT helper

  for (const tc of testCases) {
    tc.count = await fetchCount(tc.apiParams, token);
    console.log(`${tc.id}: ${tc.question} = ${tc.count}`);
  }

  writeFileSync(
    'e2e-<tool-name>-results.json',
    JSON.stringify({results: testCases}, null, 2)
  );
  console.log('Written to e2e-<tool-name>-results.json');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

### Ground truth file format

The evaluation script expects this shape:

```typescript
{
  results: Array<{
    id: string;       // unique test case ID
    question: string; // natural language question (or question fragment)
    type: string;     // category for type-correctness checks
    count: number;    // expected count from the API
  }>
}
```

### Add a yarn command

In `package.json`, add a command for your tool's ground truth script. Follow the naming convention `e2e:<tool-name>`:

```json
"e2e:my-new-tool": "bash -c 'set -a && source .env && set +a && ts-node --transpile-only scripts/e2e-my-new-tool.ts'"
```

Run it:

```bash
yarn e2e:my-new-tool
```

Output lands in `e2e-my-new-tool-results.json` (already gitignored by the `e2e-*-results.json` pattern).

---

## Step 2: Add an evaluation config

Instead of writing a separate evaluation script, add a `ToolEvalConfig` to `scripts/evaluate-agent.ts`. This reuses all shared infrastructure: JWT auth, WebSocket sessions, isolated/session modes, bleed detection, and reporting.

### The ToolEvalConfig interface

```typescript
interface ToolEvalConfig {
  name: string;                // identifier used in --tool= flag
  groundTruthFile: string;     // path to the e2e results JSON
  reportFile: string;          // where to write the evaluation report
  expectedToolName: string;    // the tool name the LLM should call

  // How to build the full question from a ground truth entry
  buildQuestion: (tc: GroundTruthEntry) => string;

  // Extract the expected numeric value from a ground truth entry
  extractExpectedValue: (tc: GroundTruthEntry) => number | null;

  // Parse the actual value from the LLM's text response
  extractActualValue: (assistantText: string) => number | null;

  // Check if the LLM chose the correct type/category
  checkTypeCorrect: (toolInput: Record<string, unknown> | null, expected: string) => boolean;

  // Multi-question session sequences for bleed testing
  sessionSequences: SessionSequence[];

  // Parameter keys to check for bleeding between questions
  bleedSuspectKeys: string[];
}
```

### Example: adding a config for a "stock_price" tool

```typescript
const stockPriceConfig: ToolEvalConfig = {
  name: 'stock_price',
  groundTruthFile: 'e2e-stock-price-results.json',
  reportFile: 'stock-price-report.json',
  expectedToolName: 'get_stock_price',

  buildQuestion: (tc) => tc.question,

  extractExpectedValue: (tc) => (typeof tc.count === 'number' ? tc.count : null),

  extractActualValue: (assistantText) => {
    const match = assistantText.match(/\*\*(\d[\d,]*\.?\d*)\*\*/);
    if (match) return parseFloat(match[1].replace(/,/g, ''));
    const fallback = assistantText.match(/(\d[\d,]*\.?\d*)\s+(?:USD|dollars?)/i);
    return fallback ? parseFloat(fallback[1].replace(/,/g, '')) : null;
  },

  checkTypeCorrect: (toolInput, expected) => {
    const actual = (toolInput?.market as string) ?? 'NYSE';
    return actual === expected;
  },

  sessionSequences: [
    {
      id: 'SEQ1',
      name: 'Ticker switch test',
      questions: [
        {id: 'S1', question: 'What is the current price of AAPL?', type: 'NYSE', expectedCount: 175},
        {id: 'S2', question: 'What is the current price of TSLA?', type: 'NASDAQ', expectedCount: 245},
      ],
    },
  ],

  bleedSuspectKeys: ['ticker', 'market', 'timeframe'],
};
```

### Register it

Add to the `TOOL_CONFIGS` map in `evaluate-agent.ts`:

```typescript
const TOOL_CONFIGS: Record<string, ToolEvalConfig> = {
  stock_price: stockPriceConfig,
};
```

### Run it

```bash
yarn evaluate --tool=stock_price --mode=both
```

Output lands in `stock-price-report.json`.

---

## Step 3: Design session sequences for bleed testing

Session sequences send multiple questions through a single WebSocket connection. This tests whether the LLM carries forward parameters from previous questions.

### What to test

| Pattern | Risk |
|---------|------|
| Type switching (category A then B, market X then Y) | LLM keeps the previous type |
| Filtered then unfiltered | LLM keeps the filter from the first question |
| Different values for the same parameter | LLM uses the previous value |
| Baseline then specific | LLM adds parameters that weren't requested |

### How bleed detection works

After each question (except the first in a sequence), the evaluator compares the current `toolInput` with the previous question's `toolInput`. If a parameter value matches the previous question but isn't mentioned in the current question's text, it's flagged as a bleed.

The `bleedSuspectKeys` array tells the detector which parameters to check. Only include keys where bleeding is plausible -- no need to list every parameter.

---

## Step 4: Interpret the report

The report JSON includes both isolated and session results:

| Field | Meaning |
|-------|---------|
| `toolCalled: false` | LLM answered without calling the tool (hallucination) |
| `countMatch: false` | LLM called the tool but returned the wrong count |
| `typeCorrect: false` | LLM chose the wrong type/category parameter |
| `bleedDetected: [...]` | Parameters from a previous question leaked into this one |
| `error` | WebSocket or timeout error |

### Common failure patterns

**LLM stops calling the tool after the first question in a session:**
The conversation context must include native `tool_use`/`tool_result` message pairs. Without this, the LLM sees only user/assistant text and stops invoking tools.

**Counts are consistently off by a small amount:**
Check if the ground truth has drifted. Re-run `yarn e2e:<tool-name>` to refresh, then re-evaluate.

**Bleed detected on every sequence:**
Add stateless instructions to the tool description:
```
"MANDATORY: Each tool call is independent. Do NOT carry forward parameters from previous calls."
```

---

## Checklist

- [ ] Ground truth script in `scripts/e2e-<tool-name>.ts`
- [ ] Yarn command `e2e:<tool-name>` in `package.json`
- [ ] Ground truth JSON generated: `e2e-<tool-name>-results.json`
- [ ] `ToolEvalConfig` added to `evaluate-agent.ts`
- [ ] Registered in `TOOL_CONFIGS`
- [ ] Session sequences cover type switching and parameter bleeding
- [ ] `yarn evaluate --tool=<tool-name> --mode=both` passes

## Related docs

- [adding-a-tool.md](adding-a-tool.md) -- how to define, implement, and register a tool
