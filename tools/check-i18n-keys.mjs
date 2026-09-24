import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = new URL('../apps/web/src/', import.meta.url);
const locales = new URL('../apps/web/src/i18n/locales/en/', import.meta.url);
const namespaceNames = ['common', 'game', 'lobby', 'rules', 'log', 'editor'];
const dynamicKeys = JSON.parse(
  readFileSync(new URL('../apps/web/src/i18n/dynamic-keys.json', import.meta.url), 'utf8'),
);

function flatten(value, prefix = '', result = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') result.add(path);
    else if (child && typeof child === 'object' && !Array.isArray(child))
      flatten(child, path, result);
    else throw new Error(`Invalid translation value at ${path}`);
  }
  return result;
}

const translations = new Map(
  namespaceNames.map((namespace) => [
    namespace,
    flatten(JSON.parse(readFileSync(new URL(`${namespace}.json`, locales), 'utf8'))),
  ]),
);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /(?:\.test|\.spec|\.gen)\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

const used = new Set(dynamicKeys);
const errors = [];

function addKey(key, location) {
  const colon = key.indexOf(':');
  if (colon <= 0 || colon === key.length - 1) {
    errors.push(`${location}: translation key must include a namespace: ${key}`);
    return;
  }
  const namespace = key.slice(0, colon);
  const name = key.slice(colon + 1);
  const entries = translations.get(namespace);
  if (!entries) {
    errors.push(`${location}: unknown translation namespace: ${namespace}`);
    return;
  }
  if (!entries.has(name) && !(entries.has(`${name}_one`) && entries.has(`${name}_other`))) {
    errors.push(`${location}: missing English translation: ${key}`);
  }
  used.add(key);
}

for (const file of sourceFiles(root.pathname)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const location = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return `${relative(process.cwd(), file)}:${line}`;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : '';
      if (name === 't' && node.arguments.length > 0) {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          addKey(first.text, location(first));
        }
      }
    }
    if (ts.isJsxAttribute(node) && node.name.text === 'i18nKey' && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) addKey(node.initializer.text, location(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const key of dynamicKeys) addKey(key, 'dynamic-keys.json');

for (const [namespace, entries] of translations) {
  for (const key of entries) {
    const base = key.replace(/_(?:zero|one|two|few|many|other)$/, '');
    if (!used.has(`${namespace}:${key}`) && !used.has(`${namespace}:${base}`)) {
      process.stderr.write(`Unused English translation: ${namespace}:${key}\n`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked ${used.size} translation keys across ${namespaceNames.length} namespaces.\n`,
  );
}
