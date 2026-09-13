# Every spelling a reader copies

```typescript
const a = {location: "us-central1"};
const b = {location: `us-central1`};
const c = {region: 'US-EAST-1'};
const d = {location: process.env.LOCATION ?? 'us-central1'};
```

```yaml
location: us-central1
```

```bash
export AWS_DEFAULT_REGION=us-east-1
export GOOGLE_CLOUD_LOCATION=us-central1
AWS_REGION="us-east-1"
```

An indented code block, with no fence at all:

    const e = {location: 'us-central1'};
