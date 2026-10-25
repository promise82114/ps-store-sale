import { createHash } from 'node:crypto';
import { Kind, parse, print, visit } from 'graphql';

// Match the current Store client's sortAST + legacy GraphQL print algorithm.
// This parses text only; downloaded JavaScript is never executed.
const sorted = (items = [], key) => [...items].sort((a, b) => {
  const left = key(a), right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const name = node => node.name?.value ?? '';
const directives = node => ({ ...node, directives: sorted(node.directives, name) });

// The Store's bundled printer keeps field arguments on one line and includes a
// final newline. Newer graphql-js printers wrap long fields, changing the hash.
function storePrint(ast) {
  const join = (items, separator = '') => (items ?? []).filter(Boolean).join(separator);
  const wrap = (before, value, after = '') => value ? before + value + after : '';
  const reducers = {
    Name: node => node.value,
    Variable: node => '$' + node.name,
    Document: node => join(node.definitions, '\n\n') + '\n',
    OperationDefinition: node => join([node.operation,
      node.name + wrap('(', join(node.variableDefinitions, ', '), ')'),
      join(node.directives, ' '), node.selectionSet], ' '),
    VariableDefinition: node => node.variable + ': ' + node.type + wrap(' = ', node.defaultValue),
    SelectionSet: node => '{\n' + join(node.selections, '\n').replace(/^/gm, '  ') + '\n}',
    Field: node => join([wrap('', node.alias, ': ') + node.name + wrap('(', join(node.arguments, ', '), ')'),
      join(node.directives, ' '), node.selectionSet], ' '),
    Argument: node => node.name + ': ' + node.value,
    FragmentSpread: node => '...' + node.name + wrap(' ', join(node.directives, ' ')),
    FragmentDefinition: node => 'fragment ' + node.name + ' on ' + node.typeCondition + ' ' + node.selectionSet,
    NamedType: node => node.name,
    ListType: node => '[' + node.type + ']',
    NonNullType: node => node.type + '!',
  };
  return visit(ast, { leave(node) {
    if (!reducers[node.kind]) throw new Error('QUERY_UNAVAILABLE');
    return reducers[node.kind](node);
  } });
}

export function publicDefinitions(source) {
  const result = [];
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    let text;
    try { text = JSON.parse(match[0]); } catch { continue; }
    if (!/^\s*(query categoryGridRetrieve\s*\(|fragment (priceFragment|personalizedMetaFragment)\s+on\s)/.test(text)) continue;
    try { result.push(...parse(text).definitions); } catch { /* Not a complete template. */ }
  }
  return result;
}

export function buildQuery(definitions) {
  const required = ['categoryGridRetrieve', 'priceFragment', 'personalizedMetaFragment'];
  const selected = required.map(value => {
    const matches = definitions.filter(definition => name(definition) === value);
    const unique = new Map(matches.map(definition => [print(definition), definition]));
    if (unique.size !== 1) throw new Error('QUERY_UNAVAILABLE');
    return [...unique.values()][0];
  });
  const ast = { kind: Kind.DOCUMENT, definitions: selected };
  const typed = visit(ast, {
    SelectionSet(node, key, parent) {
      if (parent?.kind === Kind.OPERATION_DEFINITION || node.selections.some(selection =>
        selection.kind === Kind.FIELD && selection.name.value.startsWith('__'))) return;
      return { ...node, selections: [...node.selections, {
        kind: Kind.FIELD, name: { kind: Kind.NAME, value: '__typename' },
      }] };
    },
  });
  const canonical = visit(typed, {
    Document: node => ({ ...node, definitions: sorted(node.definitions, item => `${item.kind}:${name(item)}`) }),
    OperationDefinition: node => ({ ...node, variableDefinitions: sorted(node.variableDefinitions, item => item.variable.name.value) }),
    SelectionSet: node => ({ ...node, selections: sorted(node.selections, item => `${item.kind}:${name(item)}`) }),
    Field: node => ({ ...node, arguments: sorted(node.arguments, name) }),
    FragmentSpread: directives,
    InlineFragment: directives,
    FragmentDefinition: directives,
    Directive: node => ({ ...node, arguments: sorted(node.arguments, name) }),
  });
  const document = storePrint(canonical);
  return { document, sha256Hash: createHash('sha256').update(document).digest('hex') };
}
