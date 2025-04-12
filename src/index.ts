import { Context, Schema, Logger } from "koishi";
import {
  TeamSpeak,
  QueryProtocol,
  ClientConnectEvent,
  ClientType,
  TeamSpeakChannel,
} from "ts3-nodejs-library";

export const name = "teamspeak";

export interface Config {
  groups: string[];
  host: string;
  port: number;
  user: string;
  password: string;
  reconnectAttempts: number;
  reconnectTimeout: number;
  queryTimeout: number;
  debug: boolean;
}

export const Config: Schema<Config> = Schema.object({
  groups: Schema.array(Schema.string())
    .description("监听TS通知的群")
    .default([]),
  host: Schema.string().description("服务器IP").default("localhost"),
  port: Schema.number().description("服务器端口").default(10011),
  user: Schema.string().description("ServerQuery用户名").default(""),
  password: Schema.string().description("ServerQuery密码").default(""),
  reconnectAttempts: Schema.number().description("重连尝试次数").default(3),
  reconnectTimeout: Schema.number()
    .description("重连超时时间(毫秒)")
    .default(10000),
  queryTimeout: Schema.number().description("查询超时时间(毫秒)").default(3000),
  debug: Schema.boolean().description("是否开启调试").default(false),
});

export function apply(ctx: Context, config: Config) {
  const logger = new Logger("teamspeak");
  const bot = ctx.bots[0];
  let instance: TeamSpeak | null;
  let connecting = false;

  const onClientJoin = (e: ClientConnectEvent) => {
    if (e.client.type === ClientType.ServerQuery) return;

    config.groups.forEach((groupId) => {
      bot.sendMessage(groupId, `${e.client.nickname} 进入了TS.`);
    });
  };

  const onReady = async () => {
    logger.info("connected!");
  };

  const onConnectionClose = async (e: Error) => {
    logger.warn("disconnected", JSON.stringify(e));
    logger.info("trying to reconnect...");
    await reconnect();
  };

  // 添加一个超时控制的Promise包装器
  const withTimeout = async (promise, timeout, errorMessage) => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMessage)), timeout);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer);
      return result;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };

  // 检查连接状态并在需要时重连
  const checkConnection = async (): Promise<boolean> => {
    if (connecting) {
      logger.info("Connection is in progress, waiting...");
      return false;
    }

    if (!instance) {
      logger.info("No active connection, reconnecting...");
      return await reconnect();
    }

    try {
      // 简单的连接状态检查，用一个轻量查询测试连接
      await withTimeout(
        instance.whoami(),
        config.queryTimeout,
        "Connection check timed out"
      );
      return true;
    } catch (error) {
      logger.warn(`Connection check failed: ${error.message}`);
      return await reconnect();
    }
  };

  const reconnect = async (): Promise<boolean> => {
    if (connecting) return false;

    connecting = true;
    let attempts = 0;

    try {
      // 清理现有连接
      if (instance) {
        try {
          instance.removeAllListeners();
          await instance.quit();
        } catch (e) {
          logger.warn("Error while closing previous connection", e);
        }
        instance = null;
      }

      // 尝试重连
      while (attempts < config.reconnectAttempts) {
        attempts++;
        logger.info(
          `Reconnection attempt ${attempts}/${config.reconnectAttempts}`
        );

        try {
          instance = await withTimeout(
            TeamSpeak.connect({
              host: config.host,
              protocol: QueryProtocol.RAW,
              queryport: config.port,
              serverport: 9987,
              username: config.user,
              password: config.password,
              nickname: "TSBot",
              keepAlive: true,
              keepAliveTimeout: 60,
            }),
            config.reconnectTimeout,
            "Connection attempt timed out"
          );

          // 重新绑定事件
          instance.on("ready", onReady);
          instance.on("clientconnect", onClientJoin);
          instance.on("error", onConnectionClose);
          instance.on("close", onConnectionClose);
          if (config.debug) {
            instance.on("debug", (msg) => {
              logger.info(`${msg.type}: ${msg.data}`);
            });
          }

          logger.info("Successfully reconnected!");
          connecting = false;
          return true;
        } catch (error) {
          logger.error(`Reconnection attempt failed: ${error.message}`);

          if (attempts < config.reconnectAttempts) {
            // 等待一段时间再尝试
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }

      logger.error(
        `Failed to reconnect after ${config.reconnectAttempts} attempts`
      );
      connecting = false;
      return false;
    } catch (e) {
      logger.error("Unexpected error during reconnection", e);
      connecting = false;
      return false;
    }
  };

  const connect = async () => {
    try {
      return await reconnect();
    } catch (error) {
      logger.error("Initial connection failed", error);
      return false;
    }
  };

  const disconnected = () => {
    if (!instance) return;
    instance.removeAllListeners();
    instance.quit();
    instance = null;
  };

  // 添加重试执行函数，在连接失败时会尝试重连并重新执行
  const executeWithRetry = async (operation, maxRetries = 2) => {
    let retries = 0;

    while (retries <= maxRetries) {
      try {
        // 先检查连接
        if (!(await checkConnection())) {
          if (retries >= maxRetries) {
            return { success: false, error: "无法连接到TeamSpeak服务器" };
          }
          retries++;
          continue;
        }

        // 执行操作
        const result = await withTimeout(
          operation(),
          config.queryTimeout,
          "操作超时"
        );
        return { success: true, data: result };
      } catch (error) {
        logger.warn(
          `操作失败 (尝试 ${retries + 1}/${maxRetries + 1}): ${error.message}`
        );

        if (retries >= maxRetries) {
          return { success: false, error: error.message };
        }

        // 可能是连接问题，尝试重连
        await reconnect();
        retries++;
      }
    }
  };

  ctx
    .command("ts", "谁在ts上?")
    .alias("谁在ts")
    .option("group", "-g")
    .action(async ({ session, options }) => {
      // 使用新的重试执行函数来获取客户端列表
      const result = await executeWithRetry(async () => {
        const clients = await instance.clientList({
          clientType: ClientType.Regular,
        });

        if (!clients.length) return "没有人.";

        const channelMap = new Map<TeamSpeakChannel, string[]>();
        for (const c of clients) {
          const channel = await instance.getChannelById(c.cid);
          channelMap.set(
            channel,
            (channelMap.get(channel) || []).concat([c.nickname])
          );
        }

        const channelArray = Array.from(channelMap.keys());
        channelArray.sort((a, b) => a.order - b.order);

        let message = "";
        for (const ch of channelArray) {
          message += `${ch.name}:\r\n`;
          message += "    " + channelMap.get(ch).join(", ") + "\r\n";
        }
        return message;
      });

      if (!result.success) {
        return `获取TS信息失败: ${result.error}`;
      }

      return result.data;
    });

  ctx.on("ready", async () => {
    connect();
  });

  ctx.on("dispose", () => {
    disconnected();
  });
}
