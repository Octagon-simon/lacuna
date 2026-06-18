#!/usr/bin/env node
// Generates lacuna.schema.json from the Zod ConfigSchema so editors give completion + hover
// docs in .lacuna.json. Run after `tsc` (it imports the compiled schema from dist).
// Single source of truth: every key + description comes from src/lib/config.ts.
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ConfigSchema } from '../dist/lib/config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const schema = zodToJsonSchema(ConfigSchema, {
  name: 'LacunaConfig',
  $refStrategy: 'none',          // inline everything — simpler for editors
  target: 'jsonSchema7',
})

// zodToJsonSchema wraps the object under definitions[name] + a $ref; unwrap to a flat,
// self-contained schema and add editor-facing metadata + the $schema dialect.
const config = schema.definitions?.LacunaConfig ?? schema
const out = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://raw.githubusercontent.com/Octagon-simon/lacuna/main/lacuna.schema.json',
  title: 'Lacuna config (.lacuna.json)',
  description: 'Configuration for the lacuna CLI. See https://github.com/Octagon-simon/lacuna',
  ...config,
  // Allow the $schema reference key in the user's config without a validation warning.
  properties: { $schema: { type: 'string', description: 'JSON Schema reference for editor completion.' }, ...(config.properties ?? {}) },
}

writeFileSync(join(root, 'lacuna.schema.json'), JSON.stringify(out, null, 2) + '\n')
console.log('Wrote lacuna.schema.json')
