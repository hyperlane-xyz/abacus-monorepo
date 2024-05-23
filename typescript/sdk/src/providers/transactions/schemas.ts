import { z } from 'zod';

import { ZHash } from '../../metadata/customZodTypes.js';

export const BigNumberSchema = z.string();

export const PopulatedTransactionSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: BigNumberSchema.optional(),
  chainId: z.number(),
});

export const CallDataSchema = z.object({
  to: ZHash,
  data: z.string(),
  value: BigNumberSchema.optional(),
});
