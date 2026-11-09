import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Forward rejected promises from async handlers to Express' error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
