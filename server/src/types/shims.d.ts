// Ambient module shims for packages that ship without type declarations.
declare module '@koa/cors' {
  import type { Middleware } from 'koa';
  interface CorsOptions {
    origin?: string | ((ctx: unknown) => string);
    allowMethods?: string | string[];
    exposeHeaders?: string | string[];
    allowHeaders?: string | string[];
    maxAge?: string | number;
    credentials?: boolean | ((ctx: unknown) => boolean);
    keepHeadersOnError?: boolean;
  }
  function cors(options?: CorsOptions): Middleware;
  export default cors;
}
