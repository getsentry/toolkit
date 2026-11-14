import { UserInputError } from "../errors";

/**
 * A command ran and failed: a missing resource, a rejected value, an API
 * error. Runners throw it with the command's own message, which the agent
 * reads to fix the call. Any other error a runner throws is a bug.
 */
export class CommandFailedError extends UserInputError {
  constructor(command: string, message: string) {
    super(`\`${command}\` failed: ${message}`);
    this.name = "CommandFailedError";
  }
}
