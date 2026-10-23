import { z } from "zod";
import { agentModelSchema } from "./agent-defaults";
import { maxImages, outgoingImageSchema } from "./composer";

/** Private first-message payload. Only its opaque key appears in the board. */
export const automationLaunchSchema = z.strictObject({
  operationId: z.string().min(1).max(200),
  model: agentModelSchema,
  clientMessageId: z.string().min(1).max(200),
  images: z.array(outgoingImageSchema).max(maxImages).optional(),
});
export type AutomationLaunch = z.infer<typeof automationLaunchSchema>;
