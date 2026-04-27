#!/usr/bin/env node

import { build } from 'esbuild';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: projectRoot,
      ...options,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

async function buildBundle() {
  console.log('[BUILD] Building bundle with esbuild...');

  try {
    await build({
      entryPoints: [path.join(projectRoot, 'src/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: path.join(projectRoot, 'dist/index.js'),
      external: [
        'imapflow',
        'mailparser',
        'nodemailer',
        'zod',
        '@modelcontextprotocol/sdk',
      ],
      minify: true,
      sourcemap: false,
    });

    console.log('[SUCCESS] Bundle created successfully');
  } catch (error) {
    console.error('[ERROR] Bundle build failed:', error);
    throw error;
  }
}

async function buildTypes() {
  console.log('[TYPES] Generating type definitions...');

  try {
    await runCommand('npx', ['tsc', '--emitDeclarationOnly']);
    console.log('[SUCCESS] Type definitions generated successfully');
  } catch (error) {
    console.error('[ERROR] Type generation failed:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('[START] Starting build process...');

    // Run builds in parallel for faster execution
    await Promise.all([buildBundle(), buildTypes()]);

    console.log('[DONE] Build completed successfully!');
  } catch (error) {
    console.error('[FAILED] Build failed:', error);
    process.exit(1);
  }
}

main();
