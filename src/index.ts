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
  groupId: string;
  user: string;
  password: string;
}

export const Config: Schema<Config> = Schema.object({
  groupId: Schema.string().description("群号").default(""),
  user: Schema.string().description("ServerQuery用户名").default(""),
  password: Schema.string().description("ServerQuery密码").default(""),
});

export function apply(ctx: Context, config: Config) {
  const logger = new Logger("teamspeak");
  const bot = ctx.bots[0];
  let instance: TeamSpeak | null;

  const joinListener = (e: ClientConnectEvent) => {
    if (e.client.type === ClientType.ServerQuery) return;
    bot.sendMessage(config.groupId, `${e.client.nickname} 进入了TS.`);
  };

  const closeListener = async () => {
    logger.info("disconnected, trying to reconnect...");
    await instance.reconnect(-1, 1000);
    logger.info("reconnected!");
  };

  ctx
    .command("ts", "谁在ts上?")
    .alias("谁在ts")
    .action(async ({ session }) => {
      if (!instance) return;
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

  ctx.on("ready", async () => {
    if (instance) return;

    try {
      instance = await TeamSpeak.connect({
        host: "localhost",
        protocol: QueryProtocol.RAW, //optional
        queryport: 10011, //optional
        serverport: 9987,
        username: config.user,
        password: config.password,
        nickname: "TSBot",
      });

      instance.on("clientconnect", joinListener);
      instance.on("close", closeListener);
    } catch (error) {
      logger.error(error);
    }
  });

  ctx.on("dispose", () => {
    if (!instance) return;
    instance.removeAllListeners();
    instance.quit();
  });
}
