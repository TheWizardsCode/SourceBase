import { ThreadChannel, type Message } from "discord.js";
import { Logger } from "../logger.js";
import { botConfig as config } from "../config/bot.js";
import { formatProgressMessage } from "../formatters/progress.js";
import { buildCliErrorReport } from "../discord/utils.js";
import { postCliErrorReport } from "../discord/cli-error-report.js";
import { ProgressPresenter } from "../presenters/progress.js";
import {
  runAddCommand,
  CliRunnerError,
  type AddResult,
} from "./cli-runner.js";
import {
  createThreadForMessage,
  formatThreadName,
} from "./threads.js";
import {
  sendGeneratedSummary,
  buildOpenBrainItemLink,
} from "./summaries.js";
import { sendWithFallback } from "../presenters/QueuePresenter.js";
import {
  addReaction,
  removeReaction,
  CLI_UNAVAILABLE_MESSAGE,
  PROCESSING_REACTION,
  SUCCESS_REACTION,
  FAILURE_REACTION,
} from "./utils.js";

/**
 * Dependencies required for URL processing
 */
export interface ProcessUrlDependencies {
  logger?: Logger;
  sendSummaryOnInsert?: boolean;
}

// Default no-op logger for backward compatibility
const noopLogger = new Logger("error");
// Override to make it truly no-op
(noopLogger as any).shouldLog = () => false;

/**
 * Process a URL with threaded progress updates
 * Creates a thread and sends progress events as they occur
 */
export async function processUrlWithProgress(
  message: Message,
  url: string,
  deps?: ProcessUrlDependencies
): Promise<void> {
  const { logger = noopLogger, sendSummaryOnInsert = true } = deps || {};

  logger.info("Starting URL processing", { messageId: message.id, url });

  let thread: ThreadChannel | null = null;

  // Add processing reaction to indicate the bot is working
  await addReaction(message, PROCESSING_REACTION, logger);

  try {
    // Try to create a thread for progress updates with robust fallbacks
    thread = await createThreadForMessage(
      message,
      formatThreadName(url),
      60,
      logger
    );

    if (thread) {
      logger.info("Created thread for URL processing", {
        messageId: message.id,
        threadId: thread.id,
        url,
      });
    }
  } catch (error) {
    // Thread creation failed, log and continue without thread
    logger.warn("Failed to create thread for progress updates", {
      messageId: message.id,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    logger.info("Starting CLI add command", { messageId: message.id, url });

    // Run the add command with progress tracking
    const addGenerator = runAddCommand(url, {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    });

    let eventCount = 0;
    let finalResult: AddResult | undefined;
    // Capture last non-empty message text emitted by CLI progress events. The
    // CLI may emit a short final error wrapper (e.g. {"error":"add_failed"})
    // while earlier progress events contain the underlying application error
    // (for example a DB schema error). Record the last observed event.message
    // so it can be included in diagnostic reports.
    let lastEventMessageDetail: string | undefined;

    // ProgressPresenter manages status message state and lifecycle. Create
    // a single instance per URL processing session so it can track phase
    // deduplication and terminal suppression across the event stream.
    const presenter = new ProgressPresenter(thread, message, logger);

    // Process progress events using manual iteration to capture return value
    logger.info("Waiting for CLI progress events...", { messageId: message.id, url });

    while (true) {
      const iteration = await addGenerator.next();

      if (iteration.done) {
        // Generator completed - capture the return value
        finalResult = iteration.value;
        logger.info("CLI generator completed", {
          messageId: message.id,
          url,
          eventCount,
          hasResult: !!finalResult,
        });
        break;
      }

      // Process yielded progress event
      const event = iteration.value;
      eventCount++;
      // Keep track of the last non-empty message coming from progress events.
      if (event && typeof event.message === "string" && event.message.trim() !== "") {
        lastEventMessageDetail = event.message;
      }
      logger.info("Received CLI progress event", {
        messageId: message.id,
        url,
        phase: event.phase,
        eventCount,
      });

      try {
        await presenter.handleProgressEvent(event);
      } catch (err) {
        // Defensive fallback: if the presenter fails for any reason, log and
        // attempt a minimal inline post so users still see progress.
        logger.warn(
          "ProgressPresenter.handleProgressEvent failed; falling back to inline posting",
          {
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          }
        );

        // Build a safe progress message (wrap title/url in backticks)
        const progressMsg = formatProgressMessage(event);
        const safeProgressMsg = (() => {
          try {
            if (event.title) return progressMsg.replace(event.title, `\`${event.title}\``);
            if (event.url) return progressMsg.replace(event.url, `\`${event.url}\``);
            return progressMsg;
          } catch {
            return progressMsg;
          }
        })();

        try {
          // Use presenters-level sendWithFallback to centralise posting
          // semantics. Pass the presenter's lastPostedMessage when available
          // so edits are attempted before creating new follow-ups.
          await sendWithFallback(thread ?? message, safeProgressMsg, logger, undefined);
        } catch (err2) {
          // sendWithFallback is defensive and logs; still handle unexpected throws
          logger.warn("Failed to post progress update via fallback path", {
            messageId: message.id,
            error: err2 instanceof Error ? err2.message : String(err2),
          });
        }
      }
    }

    // Retrieve presenter state for final result handling
    const lastPhase = presenter.getLastPhase();
    let lastPostedMessage: any = presenter.getLastPostedMessage();

    if (finalResult) {
      await handleProcessingResult(message, thread, finalResult, {
        logger,
        sendSummaryOnInsert,
        lastPhase,
        lastPostedMessage,
        presenter,
        url,
        lastEventMessageDetail,
      });
    } else {
      await handleNoResult(message, thread, { logger, url });
    }
  } catch (error) {
    await handleProcessingError(message, thread, url, error, logger);
  }
}

/**
 * Handle successful processing result
 */
async function handleProcessingResult(
  message: Message,
  thread: ThreadChannel | null,
  finalResult: AddResult,
  params: {
    logger: Logger;
    sendSummaryOnInsert: boolean;
    lastPhase: string | null;
    lastPostedMessage: any;
    presenter: ProgressPresenter;
    url: string;
    // Optional last observed CLI progress event message (useful when stderr
    // contains only a generic wrapper). This provides the underlying error
    // detail emitted earlier in the event stream.
    lastEventMessageDetail?: string;
  }
): Promise<void> {
  const {
    logger,
    sendSummaryOnInsert,
    lastPhase,
    lastPostedMessage,
    presenter,
    url,
  } = params;

  logger.info("CLI processing complete", {
    messageId: message.id,
    url,
    success: finalResult.success,
    title: finalResult.title,
    error: finalResult.error,
  });

  if (finalResult.success) {
    await handleSuccess(message, thread, finalResult, {
      logger,
      sendSummaryOnInsert,
      lastPhase,
      lastPostedMessage,
      presenter,
      url,
    });
  } else {
    await handleFailure(message, thread, finalResult, { logger, url, lastEventMessageDetail: params.lastEventMessageDetail });
  }
}

/**
 * Handle successful addition
 */
async function handleSuccess(
  message: Message,
  thread: ThreadChannel | null,
  finalResult: AddResult,
  params: {
    logger: Logger;
    sendSummaryOnInsert: boolean;
    lastPhase: string | null;
    lastPostedMessage: any;
    presenter: ProgressPresenter;
    url: string;
  }
): Promise<void> {
  const {
    logger,
    sendSummaryOnInsert,
    lastPhase,
    lastPostedMessage: initialLastPostedMessage,
    presenter,
    url,
  } = params;

  // Use a mutable local variable to track the last posted message
  let lastPostedMessage = initialLastPostedMessage;

  await removeReaction(message, PROCESSING_REACTION, logger);
  await addReaction(message, SUCCESS_REACTION, logger);

  const displayName = finalResult.title ? `\`${finalResult.title}\`` : `\`${url}\``;
  let successMsg = `✅ Added: ${displayName}`;
  const itemId = finalResult?.id;
  const itemLink =
    itemId !== undefined
      ? buildOpenBrainItemLink(itemId, finalResult?.url || url)
      : undefined;
  if (itemLink) {
    successMsg = `✅ Added: ${displayName} — OpenBrain item: <${itemLink}>`;
  }

  let summaryTargetThread: ThreadChannel | null = thread;
  const alreadyCompleted = lastPhase === "completed";

  if (!alreadyCompleted) {
    // Post a final success message if the completed phase wasn't already
    // observed via progress events.
    if (thread) {
      // Use presenters-level sendWithFallback which centralises the send/edit/channel.send
      // fallback semantics and structured logging.
      const posted = await sendWithFallback(thread, successMsg, logger, lastPostedMessage);
      lastPostedMessage = posted ?? lastPostedMessage;
      if (!posted) summaryTargetThread = null;
    } else {
      const posted = await sendWithFallback(message, successMsg, logger, lastPostedMessage);
      lastPostedMessage = posted ?? lastPostedMessage;
    }
  } else {
    // completed phase was already posted; try to append item link to
    // the last posted message, or fall back to posting the link.
    if (itemId !== undefined) {
      try {
        // Prefer using the presenter's appendItemLink() helper which will
        // attempt to edit the last posted message or post a follow-up when
        // editing is not possible.
        await presenter.appendItemLink(itemLink!, itemId, successMsg);
      } catch (err) {
        logger.warn("ProgressPresenter.appendItemLink failed; falling back to inline posting", {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
        const appended = `\n\nOpenBrain item: <${itemLink}>\nItem ID: ${itemId}`;
          // Use the presenters helper to attempt edit then channel send. If the
          // helper cannot post we log via its structured logger and continue.
          const contentToSend = (lastPostedMessage && typeof lastPostedMessage.content === "string" ? lastPostedMessage.content : successMsg) + appended;
          await sendWithFallback(thread ?? message, contentToSend, logger, lastPostedMessage);
      }
    } else {
      logger.debug(
        "Skipping duplicate final success message because completed event was already posted",
        { messageId: message.id, url }
      );
    }
  }

  await sendGeneratedSummary(message, summaryTargetThread, finalResult, {
    sendSummaryOnInsert,
    logger,
    progressPresenter: presenter,
  });

  if (summaryTargetThread) {
    try {
      await summaryTargetThread.setArchived(true);
    } catch (error) {
      logger.warn("Failed to archive thread after summary posting", {
        threadId: summaryTargetThread.id,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Handle failed addition
 */
async function handleFailure(
  message: Message,
  thread: ThreadChannel | null,
  finalResult: AddResult,
  params: { logger: Logger; url: string; lastEventMessageDetail?: string }
): Promise<void> {
  const { logger, url, lastEventMessageDetail } = params;

  await removeReaction(message, PROCESSING_REACTION, logger);
  await addReaction(message, FAILURE_REACTION, logger);

  const displayUrl = `\`${url}\``;
  const errorBody = finalResult?.error || CLI_UNAVAILABLE_MESSAGE;
  const errorMsg = `❌ Failed to add ${displayUrl}\n\n${errorBody}`;

  if (!finalResult?.success && (finalResult?.exitCode !== undefined || finalResult?.stderr)) {
    await handleCliError(message, thread, finalResult, { logger, url, errorMsg, lastEventMessageDetail });
  } else {
    await sendErrorMessage(message, thread, errorMsg, logger);
  }
}

/**
 * Handle CLI error with detailed reporting
 */
async function handleCliError(
  message: Message,
  thread: ThreadChannel | null,
  finalResult: AddResult,
  params: { logger: Logger; url: string; errorMsg: string; lastEventMessageDetail?: string }
): Promise<void> {
  const { logger, url, errorMsg, lastEventMessageDetail } = params;

  try {
    const cmd = `add --format ndjson ${url}`;
    // If the CLI emitted a more specific error earlier in the event stream
    // (for example, a DB schema error included in an event.message), prefer
    // including that detail in the diagnostic report. finalResult.stderr may
    // contain a generic wrapper like {"error":"add_failed"} that is not
    // actionable on its own.
    const underlyingErrorDetail = lastEventMessageDetail || finalResult?.error;
    const report = buildCliErrorReport({
      command: cmd,
      args: [],
      exitCode: finalResult?.exitCode,
      error: underlyingErrorDetail,
      stderr: finalResult?.stderr,
      note: "Observed during processing of user-submitted URL",
    });

    if (thread) {
      try {
        await postCliErrorReport(
          thread,
          report,
          "⚠️ CLI error encountered during processing. See attached diagnostic report."
        );
        // Prefer presenters-level helper for posting fallback text so that
        // edit/reply/channel fallback semantics and structured logging are
        // consistent across the codebase.
        await sendWithFallback(thread, errorMsg, logger);
        await thread.setArchived(true).catch(() => {});
      } catch (sendError) {
        logger.warn(
          "Failed to send CLI error report to thread; falling back to channel reply",
          {
            threadId: thread.id,
            error: sendError instanceof Error ? sendError.message : String(sendError),
          }
        );
          try {
            await postCliErrorReport(
              message,
              report,
              "⚠️ CLI error encountered during processing. See attached diagnostic report."
            );
            await sendWithFallback(message, errorMsg, logger);
          } catch (replyError) {
            logger.warn("Failed to send fallback CLI error report reply", {
              messageId: message.id,
              error: replyError instanceof Error ? replyError.message : String(replyError),
            });
          }
      }
    } else {
      const t = await createThreadForMessage(
        message,
        `CLI error: ${new URL(url).hostname}`,
        60,
        logger
      );
      if (t) {
        try {
          await postCliErrorReport(
            t,
            report,
            "⚠️ CLI error encountered during processing. See attached diagnostic report."
          );
          await sendWithFallback(t, errorMsg, logger);
          await t.setArchived(true).catch(() => {});
        } catch (threadErr) {
          logger.warn(
            "Failed to send CLI error report to created thread; falling back to reply",
            {
              messageId: message.id,
              threadId: t.id,
              error: threadErr instanceof Error ? threadErr.message : String(threadErr),
            }
          );
            try {
              await postCliErrorReport(
                message,
                report,
                "⚠️ CLI error encountered during processing. See attached diagnostic report."
              );
              await sendWithFallback(message, errorMsg, logger);
            } catch (replyError) {
              logger.warn("Failed to reply with CLI error report", {
                messageId: message.id,
                error: replyError instanceof Error ? replyError.message : String(replyError),
              });
            }
        }
      } else {
          try {
            await postCliErrorReport(
              message,
              report,
              "⚠️ CLI error encountered during processing. See attached diagnostic report."
            );
            await sendWithFallback(message, errorMsg, logger);
          } catch (replyError) {
            logger.warn("Failed to reply with CLI error report (no thread available)", {
              messageId: message.id,
              error: replyError instanceof Error ? replyError.message : String(replyError),
            });
          }
      }
    }
  } catch (err) {
    logger.warn("Error while attempting to post CLI error report", {
      error: err instanceof Error ? err.message : String(err),
    });
    await sendErrorMessage(message, thread, errorMsg, logger);
  }
}

/**
 * Send error message to thread or channel
 */
async function sendErrorMessage(
  message: Message,
  thread: ThreadChannel | null,
  errorMsg: string,
  logger: Logger
): Promise<void> {
  if (thread) {
    try {
      await sendWithFallback(thread, errorMsg, logger);
      await thread.setArchived(true);
    } catch (error) {
      logger.warn(
        "Failed to send final error message to thread; falling back to channel reply",
        {
          threadId: thread.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
        try {
          await sendWithFallback(message, errorMsg, logger);
        } catch (err) {
          logger.warn("Failed to send fallback error reply to channel", {
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
    }
  } else {
    await sendWithFallback(message, errorMsg, logger);
  }
}

/**
 * Handle case where CLI returns no result
 */
async function handleNoResult(
  message: Message,
  thread: ThreadChannel | null,
  params: { logger: Logger; url: string }
): Promise<void> {
  const { logger, url } = params;

  logger.error("CLI generator did not return a result", {
    messageId: message.id,
    url,
  });

  try {
    await removeReaction(message, PROCESSING_REACTION, logger);
    await addReaction(message, FAILURE_REACTION, logger);
  } catch {
    // ignore reaction failures
  }

  try {
    await sendWithFallback(message, "❌ Failed to add URL: internal error while processing the request. The CLI did not return a result.", logger);
  } catch (err) {
    logger.warn("Failed to send fallback error reply when CLI returned no result", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle processing error (exception thrown)
 */
async function handleProcessingError(
  message: Message,
  thread: ThreadChannel | null,
  url: string,
  error: unknown,
  logger: Logger
): Promise<void> {
  logger.error("Exception during URL processing", {
    messageId: message.id,
    url,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  // Handle CLI errors
  if (error instanceof CliRunnerError) {
    logger.error("CLI error during URL processing", {
      messageId: message.id,
      url,
      exitCode: error.exitCode,
      stderr: error.stderr,
    });
  }

  // Remove processing reaction and add failure reaction
  await removeReaction(message, PROCESSING_REACTION, logger);
  await addReaction(message, FAILURE_REACTION, logger);

  const errorMsg = `❌ Failed to add URL\n\n${CLI_UNAVAILABLE_MESSAGE}`;

  // If this was a CLI-specific error, attempt to create/post a detailed
  // diagnostic report in the thread (or create a new thread) so maintainers
  // have actionable debugging information (command, exit code, stderr).
  if (error instanceof CliRunnerError) {
    try {
      const cmd = `add --format ndjson ${url}`;
      const report = buildCliErrorReport({
        command: cmd,
        args: [],
        exitCode: error.exitCode,
        stderr: error.stderr,
        spawnError: error.message,
        note: "Observed during processing of user-submitted URL",
      });

      // Try to send to existing thread
      if (thread) {
        try {
          await postCliErrorReport(thread, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
          await sendWithFallback(thread, errorMsg, logger);
          await thread.setArchived(true).catch(() => {});
        } catch (sendError) {
          logger.error("Failed to send CLI error report to thread", {
            threadId: thread.id,
            error: sendError instanceof Error ? sendError.message : String(sendError),
          });
          // Fallback to channel reply
          try {
            await postCliErrorReport(message, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
            await sendWithFallback(message, errorMsg, logger);
          } catch (replyError) {
            logger.error("Failed to reply with CLI error report", {
              messageId: message.id,
              error: replyError instanceof Error ? replyError.message : String(replyError),
            });
          }
        }
      } else if (typeof message.startThread === "function") {
        // Try to create a dedicated thread for the error report
        try {
          const t = await message.startThread({
            name: `CLI error: ${new URL(url).hostname}`,
            autoArchiveDuration: 60,
          });
          await postCliErrorReport(t, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
          await sendWithFallback(t, errorMsg, logger);
          await t.setArchived(true).catch(() => {});
        } catch (threadErr) {
          logger.warn("Failed to create thread for CLI error report; falling back to reply", {
            messageId: message.id,
            error: threadErr instanceof Error ? threadErr.message : String(threadErr),
          });
            try {
              await postCliErrorReport(message, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
              await sendWithFallback(message, errorMsg, logger);
            } catch (replyError) {
              logger.error("Failed to reply with CLI error report", {
                messageId: message.id,
                error: replyError instanceof Error ? replyError.message : String(replyError),
              });
            }
        }
      } else {
        // Last resort - reply in channel
        try {
          await postCliErrorReport(message, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
          await sendWithFallback(message, errorMsg, logger);
        } catch (replyError) {
          logger.error("Failed to reply with CLI error report (no thread available)", {
            messageId: message.id,
            error: replyError instanceof Error ? replyError.message : String(replyError),
          });
        }
      }
    } catch (err) {
      logger.warn("Error while attempting to post CLI error report", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Send a user-facing brief error message to the thread or channel
  if (thread) {
    try {
      await sendWithFallback(thread, errorMsg, logger);
      await thread.setArchived(true);
    } catch (sendError) {
      logger.error("Failed to send error message to thread", {
        threadId: thread.id,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
  } else {
    await sendWithFallback(message, errorMsg, logger);
  }
}
