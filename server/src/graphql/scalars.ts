import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

/**
 * Custom scalars matching CI-Server's `DateTime` and `JSON`.
 *
 * `DateTime` — ISO-8601 UTC string on the wire; resolvers may return a `Date` or a
 * string. `JSON` — an arbitrary JSON value passed through untouched.
 */
export const DateTimeScalar = new GraphQLScalarType<Date | null, string>({
  name: 'DateTime',
  description: 'An ISO-8601 UTC date-time string.',
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return new Date(value).toISOString();
    throw new TypeError('DateTime must serialize a Date or ISO string');
  },
  parseValue(value) {
    if (typeof value !== 'string') throw new TypeError('DateTime must be an ISO string');
    return new Date(value);
  },
  parseLiteral(ast) {
    return ast.kind === Kind.STRING ? new Date(ast.value) : null;
  },
});

// Recursively turn a GraphQL literal AST node into a plain JS value (for inline JSON).
function parseJsonLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(parseJsonLiteral);
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f) => [f.name.value, parseJsonLiteral(f.value)]));
    default:
      return null;
  }
}

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'An arbitrary JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseJsonLiteral,
});
