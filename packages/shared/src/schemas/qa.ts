import { z } from 'zod';

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;
