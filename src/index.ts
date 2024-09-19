import { config } from "./config";
import { ClientWrapper } from "./discord/client";
import logger from "./logger";

const wrapped = new ClientWrapper(config);

wrapped
  .login()
  .then(() => {
    logger.info("Bot started successfully");

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      try {
        await wrapped.destroy();
        logger.info("Bot has been successfully shut down");
      } catch (error) {
        logger.error("Error during shutdown:", error);
      }
      process.exit();
    };

    ["SIGTERM", "SIGINT", "SIGHUP"].forEach((signal) =>
      process.on(signal, () => gracefulShutdown(signal))
    );
  })
  .catch((error) => {
    logger.error("Failed to start the bot:", error);
    process.exit(1);
  });
