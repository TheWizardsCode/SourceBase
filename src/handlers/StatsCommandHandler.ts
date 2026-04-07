import type { CommandInteraction } from "discord.js";
import type { SlashCommandHandler } from "../interfaces/command-handler.js";

const DEFAULT_UNAVAILABLE_MESSAGE = "Stats functionality temporarily unavailable - CLI has been extracted to openBrain repository.";

export interface StatsCommandHandlerDependencies {
  unavailableMessage?: string;
}

export class StatsCommandHandler implements SlashCommandHandler {
  private readonly unavailableMessage: string;

  constructor(dependencies: StatsCommandHandlerDependencies = {}) {
    this.unavailableMessage = dependencies.unavailableMessage ?? DEFAULT_UNAVAILABLE_MESSAGE;
  }

  async handleCommand(command: CommandInteraction): Promise<boolean> {
    if (command.commandName !== "stats") {
      return false;
    }

    await command.reply(this.unavailableMessage);
    return true;
  }
}
