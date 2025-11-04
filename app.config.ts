import 'dotenv/config';

export default {
  expo: {
    name: "TradeFlash Expo",
    slug: "tradeflash-expo",
    scheme: "tradeflash",
    version: "1.0.0",
    orientation: "portrait",
    sdkVersion: "52.0.0",
    extra: {
      API_BASE: process.env.API_BASE ?? "http://127.0.0.1:8080",
      WS_URL: process.env.WS_URL ?? "ws://127.0.0.1:8080/ws"
    }
  }
};

