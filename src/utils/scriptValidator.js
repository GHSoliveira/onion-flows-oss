/**
 * AST-level validator for user-provided scripts (flow scriptNode).
 *
 * The previous defense was a regex word blocklist — trivially bypassed via
 * `this.constructor.constructor('return process')()`, computed property
 * access (`obj['proc'+'ess']`), prototype walking, and so on.
 *
 * This validator parses the script with acorn and walks the AST rejecting
 * any construct that can reach the host environment from inside a vm
 * context. It runs before the script reaches the runtime; failures throw
 * with a human-readable reason so the flow editor can show a precise error.
 *
 * Combined with `vm.runInNewContext` and a strict context object, the
 * remaining attack surface is whatever a determined attacker can do with
 * pure-language primitives — Math, JSON, etc. That is acceptable.
 *
 * Blocked at parse time:
 *   - Identifiers that name escape vectors: constructor, __proto__,
 *     __defineGetter__, __defineSetter__, prototype, globalThis, global,
 *     window, self, eval, Function, AsyncFunction, GeneratorFunction,
 *     process, require, import, arguments
 *   - Member expressions whose property is one of those names
 *   - Computed member expressions whose key is a non-literal (you can't
 *     do `obj[someVar]` because someVar could spell a forbidden name)
 *   - WithStatement (legacy, defeats lexical scope)
 *   - TaggedTemplateExpression (lets you smuggle code through `Function`
 *     via tag.constructor)
 *   - NewExpression whose callee resolves to Function-like
 *   - Spread/import meta / async-generator features that aren't useful
 *     for flow scripts but expand surface
 */
import { Parser } from 'acorn';

const FORBIDDEN_NAMES = new Set([
  'constructor',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'prototype',
  'globalThis',
  'global',
  'window',
  'self',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'process',
  'require',
  'arguments',
  'Reflect',
  'Proxy',
  'Atomics',
  'SharedArrayBuffer'
]);

const FORBIDDEN_NODE_TYPES = new Set([
  'WithStatement',
  'TaggedTemplateExpression',
  'ImportExpression',
  'MetaProperty', // import.meta, new.target
  'YieldExpression',
  'AwaitExpression',
  'DebuggerStatement'
]);

const checkIdentifier = (name) => {
  if (typeof name !== 'string') return false;
  return FORBIDDEN_NAMES.has(name);
};

const walk = (node, ctx) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, ctx);
    return;
  }
  if (typeof node.type !== 'string') return;

  if (FORBIDDEN_NODE_TYPES.has(node.type)) {
    throw new Error(`Construção não permitida: ${node.type}`);
  }

  switch (node.type) {
    case 'Identifier':
      if (checkIdentifier(node.name)) {
        throw new Error(`Identificador proibido: ${node.name}`);
      }
      break;
    case 'MemberExpression':
      if (node.computed) {
        // obj[expr] is only allowed if expr is a Literal string/number we can validate now.
        if (node.property.type !== 'Literal' || (typeof node.property.value !== 'string' && typeof node.property.value !== 'number')) {
          throw new Error('Acesso por colchete só permite literais string/number');
        }
        if (typeof node.property.value === 'string' && checkIdentifier(node.property.value)) {
          throw new Error(`Propriedade proibida: ${node.property.value}`);
        }
      } else {
        if (node.property.type === 'Identifier' && checkIdentifier(node.property.name)) {
          throw new Error(`Propriedade proibida: .${node.property.name}`);
        }
      }
      walk(node.object, ctx);
      // property já validada acima
      return;
    case 'Property':
      // Em ObjectExpression: { constructor: 1 } seria suspeito mas inofensivo
      // como key; ainda assim bloqueamos para reduzir confusão.
      if (!node.computed && node.key?.type === 'Identifier' && checkIdentifier(node.key.name)) {
        throw new Error(`Chave proibida: ${node.key.name}`);
      }
      break;
    case 'NewExpression':
      // new Function(...) e similares
      if (node.callee?.type === 'Identifier' && checkIdentifier(node.callee.name)) {
        throw new Error(`Construtor proibido: new ${node.callee.name}`);
      }
      break;
    case 'CallExpression':
      // eval(...) ou Function(...)
      if (node.callee?.type === 'Identifier' && checkIdentifier(node.callee.name)) {
        throw new Error(`Chamada proibida: ${node.callee.name}()`);
      }
      break;
    default:
      break;
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'type') continue;
    walk(node[key], ctx);
  }
};

/**
 * Validates a user script. Throws `Error` if the script contains forbidden
 * constructs; returns `true` on success.
 */
export const validateScript = (source) => {
  const code = String(source || '');
  if (!code.trim()) return true;

  let ast;
  try {
    ast = Parser.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: false,
      allowImportExportEverywhere: false
    });
  } catch (error) {
    throw new Error(`Sintaxe inválida: ${error.message}`);
  }

  walk(ast, {});
  return true;
};
