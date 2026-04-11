import type { ChatInputCommandInteraction, Message } from "discord.js";

export interface MessageCommandHandler {
  handleMessage(message: Message): Promise<boolean>;
}

export interface SlashCommandHandler {
  handleCommand(command: ChatInputCommandInteraction): Promise<boolean>;
}
