// Creates (or reuses) an AnythingLLM API key for the eval harness and writes it to eval/.key
// Run:  node eval/setup-key.mjs        (from the repo root)
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../server/index.js"));

const { ApiKey } = require("../server/models/apiKeys");

const NAME = "eval-harness";

const existing = await ApiKey.get({ name: NAME });
let secret;
if (existing) {
  secret = existing.secret;
  console.log("reusing existing eval-harness key");
} else {
  const { apiKey, error } = await ApiKey.create(null, NAME);
  if (error) throw new Error(error);
  secret = apiKey.secret;
  console.log("created new eval-harness key");
}

await writeFile(join(here, ".key"), secret + "\n", "utf8");
console.log("wrote eval/.key");
process.exit(0);
