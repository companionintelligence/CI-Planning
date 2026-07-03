import type { ApolloServerPlugin } from '@apollo/server';
import {
  GraphQLError,
  Kind,
  type DocumentNode,
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
function countFields(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  seenFragments: Set<string>,
): number {
  let cost = 0;
  for (const node of selectionSet.selections) {
    if (node.kind === Kind.FIELD) {
      cost += 1;
      if (node.selectionSet) cost += countFields(node.selectionSet, fragments, seenFragments);
    } else if (node.kind === Kind.INLINE_FRAGMENT) {
      if (node.selectionSet) cost += countFields(node.selectionSet, fragments, seenFragments);
    } else if (node.kind === Kind.FRAGMENT_SPREAD) {
      const name = node.name.value;
      if (seenFragments.has(name)) continue; // guard against cyclic fragment spreads
      const frag = fragments.get(name);
      if (frag) {
        seenFragments.add(name);
        cost += countFields(frag.selectionSet, fragments, seenFragments);
      }
    }
  }
  return cost;
}

function estimateComplexity(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  let total = 0;
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      total += countFields(def.selectionSet, fragments, new Set());
    }
  }
  return total;
}

// `getMaxComplexity` is read per request (not captured once) so the limit can be changed
// at runtime — e.g. config flips in tests — without rebuilding the server.
export function complexityPlugin(getMaxComplexity: () => number): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ document }) {
          const maxComplexity = getMaxComplexity();
          const complexity = estimateComplexity(document);
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
