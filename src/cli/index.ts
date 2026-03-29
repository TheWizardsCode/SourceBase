#!/usr/bin/env node

const packageJson = {
  version: "0.1.0",
};

interface Command {
  name: string;
  description: string;
  usage: string;
}

const commands: Command[] = [
  {
    name: "add",
    description: "Add a URL to the database",
    usage: "sb add [--verbose] [--format console|ndjson|webhook] [--webhook-url <url>] [--channel-id <id>] [--message-id <id>] [--author-id <id>] <url> [<url2> ...]",
  },
  {
    name: "queue",
    description: "Queue a URL for later processing",
    usage: "sb queue [--verbose] [--channel-id <id>] [--message-id <id>] [--author-id <id>] <url> [<url2> ...]",
  },
  {
    name: "search",
    description: "Perform semantic search on indexed content",
    usage: "sb search [--limit N] [--format table|json|urls-only] <query>",
  },
  {
    name: "stats",
    description: "Display database statistics",
    usage: "sb stats [--format table|json] [--raw]",
  },
];

function showHelp(): void {
  console.log(`Usage: sb <command> [options]

Commands:`);
  
  const maxNameLength = Math.max(...commands.map(cmd => cmd.name.length));
  
  for (const cmd of commands) {
    const padding = " ".repeat(maxNameLength - cmd.name.length + 2);
    console.log(`  ${cmd.name}${padding}${cmd.description}`);
  }
  
  console.log(`
Options:
  --help      Show this help message
  --version   Show version information
  --verbose   Enable verbose output (JSON logging)

Progress Output Formats (add command):
  --format, -f <format>  Progress output format (default: auto)
                         - console: Human-friendly TTY output
                         - ndjson:  One JSON line per event
                         - webhook: POST events to webhook URL
                         - auto:    console in TTY, ndjson otherwise
  --ndjson               Shorthand for --format ndjson
  --webhook-url <url>    Webhook URL (required when format=webhook)

Context Flags (for bot integration):
  --channel-id <id>      Discord channel ID to associate with the operation
  --message-id <id>      Discord message ID to associate with the operation
  --author-id <id>       Discord author ID to associate with the operation

Examples:
  sb add https://example.com/article
  sb add --verbose https://example.com/article
  sb add --format ndjson https://example.com/article | jq .
  sb add --format webhook --webhook-url https://example.com/hook https://example.com/article
  sb queue https://example.com/article
  sb search "machine learning"
  sb search --limit 10 "neural networks"
  sb search --format json "artificial intelligence"
  sb search --format urls-only "web development" | xargs -I {} curl {}
  sb stats
  sb stats --format json
  sb stats --raw`);
}

function showVersion(): void {
  console.log(`sb version ${packageJson.version}`);
}

function showUnknownCommandError(command: string): void {
  console.error(`Error: Unknown command "${command}"`);
  console.error(`Run 'sb --help' for usage information.`);
}

async function validateConfig(): Promise<boolean> {
  try {
    // Dynamically import config to catch validation errors
    const { cliConfig: config } = await import("../config/cli.js");
    // Access DATABASE_URL to ensure it's loaded
    const _ = config.DATABASE_URL;
    return true;
  } catch (error) {
    if (error instanceof Error) {
      // Display the error message - it may be multi-line with detailed instructions
      console.error("Error: Configuration validation failed\n");
      console.error(error.message);
      console.error("\nRun 'sb --help' for more information.");
    } else {
      console.error("Error: Configuration validation failed");
      console.error("Please ensure all required environment variables are set.");
      console.error("Run 'sb --help' for more information.");
    }
    return false;
  }
}

interface CliContext {
  channelId?: string;
  messageId?: string;
  authorId?: string;
}

interface ParsedArgs {
  command: string | null;
  commandArgs: string[];
  verbose: boolean;
  format?: string;
  webhookUrl?: string;
  context: CliContext;
}

function parseArgs(args: string[]): ParsedArgs {
  const globalFlags = new Set(["--help", "-h", "--version", "-v", "--verbose", "--ndjson"]);

  let verbose = false;
  let format: string | undefined;
  let webhookUrl: string | undefined;
  let ndjson = false;
  const context: CliContext = {};
  const remainingArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--format" || arg === "-f") {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        i++;
        format = args[i];
      } else {
        // --format has no value, don't consume it so command validation can handle it
        remainingArgs.push(arg);
      }
    } else if (arg === "--webhook-url") {
      i++;
      if (i < args.length) {
        webhookUrl = args[i];
      }
    } else if (arg === "--ndjson") {
      ndjson = true;
    } else if (arg === "--channel-id") {
      i++;
      if (i < args.length) {
        context.channelId = args[i];
      }
    } else if (arg === "--message-id") {
      i++;
      if (i < args.length) {
        context.messageId = args[i];
      }
    } else if (arg === "--author-id") {
      i++;
      if (i < args.length) {
        context.authorId = args[i];
      }
    } else if (!globalFlags.has(arg)) {
      remainingArgs.push(arg);
    }
  }

  // --ndjson flag is a shorthand for --format ndjson
  if (ndjson && !format) {
    format = "ndjson";
  }

  const command = remainingArgs.length > 0 ? remainingArgs[0] : null;
  const commandArgs = remainingArgs.slice(1);

  return { command, commandArgs, verbose, format, webhookUrl, context };
}

function validateWebhookUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Error: --webhook-url must be a valid HTTP or HTTPS URL";
    }
    return undefined;
  } catch {
    return `Error: --webhook-url is not a valid URL: ${url}`;
  }
}

async function main(): Promise<number> {
  const allArgs = process.argv.slice(2);
  
  if (allArgs.length === 0) {
    showHelp();
    return 2; // Invalid args
  }
  
  // Handle global flags immediately (before command parsing)
  if (allArgs[0] === "--help" || allArgs[0] === "-h") {
    showHelp();
    return 0;
  }
  
  if (allArgs[0] === "--version" || allArgs[0] === "-v") {
    showVersion();
    return 0;
  }
  
  // Parse args to extract flags and get command
  const { command, commandArgs, verbose, format, webhookUrl, context } = parseArgs(allArgs);
  
  // Validate webhook URL if provided
  const webhookUrlError = validateWebhookUrl(webhookUrl);
  if (webhookUrlError) {
    console.error(webhookUrlError);
    return 2;
  }
  
  if (!command) {
    showHelp();
    return 2; // Invalid args
  }
  
  // Route to commands
  const knownCommands = commands.map(cmd => cmd.name);
  
  if (!knownCommands.includes(command)) {
    showUnknownCommandError(command);
    return 2; // Invalid args
  }
  
  // Command routing
  switch (command) {
    case "add":
      if (commandArgs.length === 0) {
        console.error("Error: 'add' command requires at least one URL argument");
        console.error("Usage: sb add [--verbose] [--format console|ndjson|webhook] [--webhook-url <url>] [--channel-id <id>] [--message-id <id>] [--author-id <id>] <url> [<url2> ...]");
        console.error("\nOptions:");
        console.error("  --verbose         Enable verbose output");
        console.error("  --format, -f      Output format: console, ndjson, webhook (default: auto)");
        console.error("  --ndjson          Shorthand for --format ndjson");
        console.error("  --webhook-url     Webhook URL for webhook format");
        console.error("  --channel-id      Discord channel ID for context");
        console.error("  --message-id      Discord message ID for context");
        console.error("  --author-id       Discord author ID for context");
        return 2;
      }
      // Validate format if provided
      const validFormats = ["console", "ndjson", "webhook", "auto"];
      if (format && !validFormats.includes(format)) {
        console.error(`Error: Invalid format "${format}". Valid options: ${validFormats.join(", ")}`);
        return 2;
      }
      // Validate configuration before executing command
      if (!(await validateConfig())) {
        return 1; // Error
      }
      const { addCommand } = await import("./commands/add.js");
      const { exitCode } = await addCommand(commandArgs, { 
        verbose, 
        format: format as "console" | "ndjson" | "webhook" | "auto" | undefined, 
        webhookUrl,
        context
      });
      return exitCode;
    case "queue":
      if (commandArgs.length === 0) {
        console.error("Error: 'queue' command requires at least one URL argument");
        console.error("Usage: sb queue [--verbose] [--channel-id <id>] [--message-id <id>] [--author-id <id>] <url> [<url2> ...]");
        console.error("\nOptions:");
        console.error("  --verbose         Enable verbose output");
        console.error("  --channel-id      Discord channel ID for context");
        console.error("  --message-id      Discord message ID for context");
        console.error("  --author-id       Discord author ID for context");
        return 2;
      }
      // Validate configuration before executing command
      if (!(await validateConfig())) {
        return 1; // Error
      }
      const { queueCommand } = await import("./commands/queue.js");
      const { exitCode: queueExitCode } = await queueCommand(commandArgs, { verbose, context });
      return queueExitCode;
    case "search": {
      // Validate format if provided (extracted by parseArgs)
      if (format) {
        if (!["table", "json", "urls-only"].includes(format)) {
          console.error(`Error: Invalid format "${format}". Valid options: table, json, urls-only`);
          return 2;
        }
      }
      
      // Parse and validate search args before config validation
      // to return exit code 2 for invalid arguments
      let searchLimit: number | undefined;
      let searchFormat: string | undefined;
      let searchQueryArgs: string[] = [];
      
      let i = 0;
      while (i < commandArgs.length) {
        const arg = commandArgs[i];
        
        if (arg === "--limit" || arg === "-l") {
          i++;
          const nextArg = commandArgs[i];
          if (!nextArg || nextArg.startsWith("-")) {
            console.error("Error: --limit requires a value");
            return 2;
          }
          const limit = parseInt(nextArg, 10);
          if (isNaN(limit) || limit < 1 || limit > 20) {
            console.error("Error: --limit must be between 1 and 20");
            return 2;
          }
          searchLimit = limit;
        } else if (arg === "--format" || arg === "-f") {
          i++;
          const nextArg = commandArgs[i];
          if (!nextArg || nextArg.startsWith("-")) {
            console.error("Error: --format requires a value");
            return 2;
          }
          if (!["table", "json", "urls-only"].includes(nextArg)) {
            console.error(`Error: Invalid format "${nextArg}". Valid options: table, json, urls-only`);
            return 2;
          }
          searchFormat = nextArg;
        } else if (arg === "--verbose" || arg === "-v") {
          // Valid flag, skip
        } else if (!arg.startsWith("-")) {
          searchQueryArgs.push(arg);
        } else {
          console.error(`Error: Unknown option "${arg}"`);
          return 2;
        }
        i++;
      }
      
      if (searchQueryArgs.length === 0) {
        console.error("Error: 'search' command requires a query argument");
        console.error("Usage: sb search [options] <query>");
        console.error("\nOptions:");
        console.error("  --limit, -l N     Number of results (1-20, default: 5)");
        console.error("  --format, -f      Output format: table, json, urls-only (default: table)");
        return 2;
      }
      
      // Validate configuration before executing command
      if (!(await validateConfig())) {
        return 1; // Error
      }
      const { searchCommand } = await import("./commands/search.js");
      const { exitCode: searchExitCode } = await searchCommand(commandArgs);
      return searchExitCode;
    }
    case "stats": {
      // Validate format if provided (extracted by parseArgs)
      if (format) {
        if (!["table", "json"].includes(format)) {
          console.error(`Error: Invalid format "${format}". Valid options: table, json`);
          return 2;
        }
      }
      
      // Parse and validate stats args before config validation
      // to return exit code 2 for invalid arguments
      let i = 0;
      while (i < commandArgs.length) {
        const arg = commandArgs[i];
        
        if (arg === "--format" || arg === "-f") {
          i++;
          const nextArg = commandArgs[i];
          if (!nextArg || nextArg.startsWith("-")) {
            console.error("Error: --format requires a value");
            return 2;
          }
          if (!["table", "json"].includes(nextArg)) {
            console.error(`Error: Invalid format "${nextArg}". Valid options: table, json`);
            return 2;
          }
        } else if (arg === "--raw" || arg === "-r") {
          // Valid flag, skip
        } else {
          console.error(`Error: Unknown option "${arg}"`);
          return 2;
        }
        i++;
      }
      
      // Validate configuration before executing command
      if (!(await validateConfig())) {
        return 1; // Error
      }
      const { statsCommand } = await import("./commands/stats.js");
      const { exitCode: statsExitCode } = await statsCommand(commandArgs);
      return statsExitCode;
    }
    default:
      showUnknownCommandError(command);
      return 2;
  }
}

main()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error("Unexpected error:", error);
    process.exit(1);
  });
