import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
