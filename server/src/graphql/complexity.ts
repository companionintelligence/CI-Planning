import type { ApolloServerPlugin } from '@apollo/server';
import {
  GraphQLError,
  Kind,
  type DocumentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type FragmentDefinitionNode,
} from 'graphql';
import { logger } from '../lib/logger.js';

/**
 * Query-complexity limiter — same purpose as CI-Server's `ComplexityPlugin` (bound a
 * query's cost BEFORE execution so a hostile/expensive query is rejected), implemented
 * directly on the `graphql` package this module imports — i.e. the exact instance Apollo
 * uses.
 *
 * Why not `graphql-query-complexity` (CI-Server's lib)? It is a dual-package (CJS+ESM)
 * module; in this ESM app it resolves a SECOND copy of `graphql`, tripping graphql-js's
 * "Duplicate graphql modules cannot be used at the same time" guard at runtime. Using
 * `graphql` directly guarantees a single instance in every environment (tsx + vitest).
 *
 * Cost model: one point per selected field, summed recursively over the operation with
 * fragments expanded — equivalent to graphql-query-complexity's
 * `simpleEstimator({ defaultComplexity: 1 })`. Per-field custom weights (their
 * `fieldExtensionsEstimator`) can be layered in later; no field defines one yet.
 */
// `activeSpreads` is the current fragment-spread PATH (a recursion stack): a name is
// added before descending and removed after, so a genuine cycle (A→…→A) is bounded while
// a fragment legitimately spread more than once — in siblings or repeated — is still
// counted each time (a single never-cleared "seen" set would undercount and let a query
// bypass the limiter by duplicating expensive selections via one fragment).
function countFields(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  activeSpreads: Set<string>,
): number {
  let cost = 0;
  for (const node of selectionSet.selections) {
    if (node.kind === Kind.FIELD) {
      cost += 1;
      if (node.selectionSet) cost += countFields(node.selectionSet, fragments, activeSpreads);
    } else if (node.kind === Kind.INLINE_FRAGMENT) {
      if (node.selectionSet) cost += countFields(node.selectionSet, fragments, activeSpreads);
    } else if (node.kind === Kind.FRAGMENT_SPREAD) {
      const name = node.name.value;
      if (activeSpreads.has(name)) continue; // cycle: this fragment is already on the path
      const frag = fragments.get(name);
      if (frag) {
        activeSpreads.add(name);
        cost += countFields(frag.selectionSet, fragments, activeSpreads);
        activeSpreads.delete(name); // pop — a later/sibling spread of the same fragment still counts
      }
    }
  }
  return cost;
}

// Cost only the operation Apollo actually resolved (didResolveOperation gives us the one
// selected via operationName) — NOT every operation definition in the document, which
// would over-count a multi-operation request and reject otherwise-valid queries.
function estimateComplexity(operation: OperationDefinitionNode, document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  return countFields(operation.selectionSet, fragments, new Set());
}

// `getMaxComplexity` is read per request (not captured once) so the limit can be changed
// at runtime — e.g. config flips in tests — without rebuilding the server.
export function complexityPlugin(getMaxComplexity: () => number): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ operation, document }) {
          if (!operation) return; // no resolved operation to cost (shouldn't happen post-resolve)
          const maxComplexity = getMaxComplexity();
          const complexity = estimateComplexity(operation, document);
          if (complexity > maxComplexity) {
            throw new GraphQLError(
              `Query is too complex: ${complexity}. Maximum allowed complexity: ${maxComplexity}`,
              { extensions: { code: 'BAD_REQUEST', http: { status: 400 } } },
            );
          }
          logger.debug('GraphQL query complexity', { complexity });
        },
      };
    },
  };
}
