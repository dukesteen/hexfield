#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineSrc = path.join(repoRoot, 'packages/engine/src');
const bannedGlobals = new Set([
  'Date',
  'document',
  'window',
  'process',
  'setTimeout',
  'setInterval',
]);

function expressionChain(node, sourceFile) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionChain(node.expression, sourceFile)}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = node.argumentExpression;
    const name = ts.isStringLiteral(argument) ? argument.text : argument.getText(sourceFile);
    return `${expressionChain(node.expression, sourceFile)}.${name}`;
  }
  return '';
}

function isMathExpression(node, sourceFile) {
  const chain = expressionChain(node, sourceFile);
  return chain === 'Math' || chain === 'globalThis.Math';
}

function hasMathRandomBinding(pattern) {
  if (!ts.isObjectBindingPattern(pattern)) return false;
  return pattern.elements.some((element) => {
    const propertyName = element.propertyName ?? element.name;
    return ts.isIdentifier(propertyName) && propertyName.text === 'random';
  });
}

function lineAt(tree, node) {
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
}

function checkSource(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  function add(node, name) {
    violations.push(`${file}:${lineAt(tree, node)}: banned ${name}`);
  }
  function visit(node) {
    if (ts.isIdentifier(node) && bannedGlobals.has(node.text)) add(node, node.text);

    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'random' && isMathExpression(node.expression, tree)) {
        add(node, 'Math.random');
      }
      if (
        node.name.text === 'now' &&
        ['performance', 'globalThis.performance'].includes(expressionChain(node.expression, tree))
      ) {
        add(node, 'performance.now');
      }
      if (
        node.name.text === 'crypto' &&
        ['globalThis', 'window'].includes(expressionChain(node.expression, tree))
      ) {
        add(node, 'crypto');
      }
      if (expressionChain(node.expression, tree) === 'crypto') add(node, 'crypto');
    }

    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'random' &&
      isMathExpression(node.expression, tree)
    ) {
      add(node, 'Math.random');
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isMathExpression(node.initializer, tree) &&
      hasMathRandomBinding(node.name)
    ) {
      add(node, 'Math.random');
    }

    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
}

async function sourceFiles(root) {
  const found = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['__tests__', 'test', 'tests'].includes(entry.name)) await walk(file);
        } else if (
          /\.[cm]?[jt]sx?$/.test(entry.name) &&
          !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry.name)
        ) {
          found.push(file);
        }
      }),
    );
  }
  await walk(root);
  return found;
}

async function scan(root) {
  const files = await sourceFiles(root);
  const results = await Promise.all(
    files.map(async (file) =>
      checkSource(await readFile(file, 'utf8'), path.relative(repoRoot, file)),
    ),
  );
  return results.flat();
}

async function selfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cp2p-purity-'));
  const sourceRoot = path.join(tempRoot, 'src');
  try {
    await mkdir(path.join(sourceRoot, '__tests__'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'test'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'tests'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'fixtures'), { recursive: true });
    await writeFile(
      path.join(sourceRoot, 'clean.ts'),
      "// Math.random() and document\nconst text = 'Date and setTimeout';\n",
    );
    await writeFile(path.join(sourceRoot, 'clean.test.ts'), 'Math.random();\n');
    await writeFile(path.join(sourceRoot, '__tests__', 'ignored.ts'), 'Math.random();\n');
    await writeFile(path.join(sourceRoot, 'test', 'ignored.ts'), 'Math.random();\n');
    await writeFile(path.join(sourceRoot, 'tests', 'ignored.ts'), 'Math.random();\n');
    await writeFile(path.join(sourceRoot, 'fixtures', 'compiled.ts'), 'Math.random();\n');
    await writeFile(
      path.join(sourceRoot, 'violations.ts'),
      [
        'const roll = Math.random;',
        "const bracketRoll = Math['random'];",
        'const { random } = Math;',
        'const { random: dice } = globalThis.Math;',
        'const globalRoll = globalThis.Math.random;',
        'const stamp = new Date();',
        'const fromTemplate = `${Math.random()}`;',
        'document.title = String(performance.now());',
        'setTimeout(() => {}, 1);',
        'crypto.getRandomValues(new Uint8Array(1));',
      ].join('\n'),
    );

    const violations = await scan(sourceRoot);
    const expected = ['Math.random', 'Date', 'document', 'performance.now', 'setTimeout', 'crypto'];
    for (const banned of expected) {
      if (!violations.some((item) => item.endsWith(`banned ${banned}`))) {
        throw new Error(`filesystem self-test did not detect ${banned}`);
      }
    }
    for (const pathFragment of ['__tests__', '/test/', '/tests/', 'clean.test.ts']) {
      if (violations.some((item) => item.includes(pathFragment))) {
        throw new Error(`test exclusion self-test scanned ${pathFragment}`);
      }
    }
    if (!violations.some((item) => item.includes('fixtures/compiled.ts'))) {
      throw new Error('production fixture directory was incorrectly excluded from scan');
    }
    if (!violations.some((item) => item.endsWith('violations.ts:2: banned Math.random'))) {
      throw new Error('bracket access line was not reported');
    }
    if (!violations.some((item) => item.endsWith('violations.ts:3: banned Math.random'))) {
      throw new Error('Math.random destructuring line was not reported');
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  await selfTest();
  const violations = await scan(engineSrc);
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Engine purity check passed.');
  }
} catch (error) {
  console.error(`Engine purity checker failed: ${String(error)}`);
  process.exitCode = 1;
}
