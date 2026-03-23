import { readFileSync } from 'fs';
import { resolve, basename } from 'path';
import { run } from './runner.js';

const configPath = process.argv[2] || 'config.json';

let config;
try {
  config = JSON.parse(readFileSync(resolve(configPath), 'utf-8'));
} catch (err) {
  console.error(`Error reading config file: ${configPath}`);
  console.error(err.message);
  process.exit(1);
}

// Derive config name from filename if not explicitly set
if (!config.name) {
  config.name = basename(configPath, '.json');
}

await run(config);
