import { readFileSync } from 'fs';
import { resolve } from 'path';
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

await run(config);
