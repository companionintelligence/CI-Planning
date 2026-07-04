import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

/**
 * Custom scalars matching CI-Server's `DateTime` and `JSON`.
 *
 * `DateTime` — ISO-8601 UTC string on the wire; resolvers may return a `Date` or a
 * string. `JSON` — an arbitrary JSON value passed through untouched.
 *
 * INPUT coercion (parseValue/parseLiteral) returns a normalized ISO-8601 **string**, not
 * a `Date`. Every downstream service in this app stores time as ISO-string TEXT columns
 * and builds raw column objects, so a `Date` reaching a text column throws better-sqlite3's
 * "can only bind numbers, strings, bigints, buffers, and null" (a latent 500 on any
 * `DateTime` input — e.g. TaskType `dueAt`/`completedAt`, TimeBlockType `startAt`/`endAt`).
 * Normalizing to a string here is the single, leak-proof fix; resolvers receive a string
 * they can hand straight to a service. Validation is preserved (a bad ISO still throws).
 */
// Validate an ISO string, throwing (not returning Invalid Date) so a bad input surfaces
// as a GraphQL error, and return it normalized to a canonical UTC ISO-8601 string.
function toIsoString(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new TypeError(`DateTime is not a valid ISO-8601 string: ${input}`);
  return d.toISOString();
}

export const DateTimeScalar = new GraphQLScalarType<Date | string, string>({
  name: 'DateTime',
  description: 'An ISO-8601 UTC date-time string.',
  serialize(value) {
    const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) throw new TypeError('DateTime must serialize a valid Date or ISO string');
    return d.toISOString();
  },
  parseValue(value) {
    if (typeof value !== 'string') throw new TypeError('DateTime must be an ISO string');
    return toIsoString(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new TypeError('DateTime must be provided as a string literal');
    return toIsoString(ast.value);
  },
});

// Recursively turn a GraphQL literal AST node into a plain JS value (for inline JSON).
// Throws on an AST kind JSON can't represent rather than silently coercing it to null.
// `variables` resolves `$var` literals nested inside a JSON literal.
function parseJsonLiteral(ast: ValueNode, variables?: Record<string, unknown> | null): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map((v) => parseJsonLiteral(v, variables));
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f) => [f.name.value, parseJsonLiteral(f.value, variables)]));
    case Kind.VARIABLE:
      return variables ? variables[ast.name.value] : undefined;
    default:
      throw new TypeError(`JSON cannot represent a literal of kind ${(ast as { kind: string }).kind}`);
  }
}

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'An arbitrary JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast, variables) => parseJsonLiteral(ast, variables),
});
