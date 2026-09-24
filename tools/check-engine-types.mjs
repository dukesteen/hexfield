#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = path.join(repoRoot, 'packages/engine');
const fixtureDir = await mkdtemp(path.join(engineRoot, 'src/typecheck-fixture-'));
const fixture = path.join(fixtureDir, 'ambient-globals.ts');

try {
  await writeFile(fixture, 'document.title;\nprocess.pid;\n');

  const configFile = ts.findConfigFile(
    engineRoot,
    (file) => ts.sys.fileExists(file),
    'tsconfig.json',
  );
  if (!configFile) throw new Error('Engine TypeScript configuration is missing');

  const config = ts.readConfigFile(configFile, (file) => ts.sys.readFile(file));
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, engineRoot);
  if (parsed.errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => repoRoot,
        getNewLine: () => '\n',
      }),
    );
  }
  if (!parsed.fileNames.includes(fixture)) {
    throw new Error('Engine production configuration does not include the source fixture');
  }

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.file?.fileName === fixture);
  for (const name of ['document', 'process']) {
    if (
      !diagnostics.some((item) =>
        ts
          .flattenDiagnosticMessageText(item.messageText, '\n')
          .includes(`Cannot find name '${name}'`),
      )
    ) {
      throw new Error(`Engine production types unexpectedly allow ${name}`);
    }
  }

  console.log('Engine production types reject document and process.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}
