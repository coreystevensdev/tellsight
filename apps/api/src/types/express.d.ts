// Global augmentation for Express Request.
//
// The auth middleware populates `req.user` on every authenticated route.
// Before this augmentation, ~27 handler sites cast `req` to a local type
// just to reach `user`, one false invariant repeated across the codebase.
// Declaring `user` on the global Express.Request interface once means every
// handler sees `req.user` directly (typed as optional, matching runtime
// reality).
//
// Callers that need `user` to exist use `requireUser(req)` from
// `lib/requireUser.ts`, it checks the invariant and throws a ProgrammerError
// (500) if auth middleware didn't run. Honest about the fact that the type
// is only guaranteed downstream of specific middleware.
//
// Why `namespace Express`, not `declare module 'express-serve-static-core'`:
// @types/express-serve-static-core declares a global `Express` namespace at
// the top level, and its module-level `Request<>` type extends
// `Express.Request`. Augmenting the namespace is how types for request-level
// properties are added in the Express ecosystem.

import type { JwtPayload, SubscriptionTier } from 'shared/types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      subscriptionTier?: SubscriptionTier;
    }
  }
}

export {};
