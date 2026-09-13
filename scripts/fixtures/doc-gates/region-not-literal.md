# Shapes that name no region

```typescript
interface Config {
  region: string;
  location?: string | undefined;
}
const fromEnv = {region: process.env.AWS_REGION};
```
