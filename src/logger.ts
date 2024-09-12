import winston from "winston";
import { format } from "winston";
import colors from "colors";

const { combine, timestamp, printf } = format;

const customFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let coloredLevel = level;
  switch (level) {
    case "error":
      coloredLevel = colors.red(level);
      break;
    case "warn":
      coloredLevel = colors.yellow(level);
      break;
    case "info":
      coloredLevel = colors.green(level);
      break;
    case "debug":
      coloredLevel = colors.blue(level);
      break;
  }

  const timestampStr = colors.cyan(`[${timestamp}]`);
  const metadataStr = Object.keys(metadata).length
    ? colors.gray(JSON.stringify(metadata))
    : "";

  return `${timestampStr} ${coloredLevel}: ${colors.white(
    message
  )} ${metadataStr}`;
});

const logger = winston.createLogger({
  level: "debug",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), customFormat),
  transports: [new winston.transports.Console()],
});

export default logger;
