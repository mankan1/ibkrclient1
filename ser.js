import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
app.use("/ib", createProxyMiddleware({
  target: "https://127.0.0.1:5000/v1/api",
  changeOrigin: true,
  secure: false,         // accept self-signed cert
  pathRewrite: { "^/ib": "" }
}));

app.listen(8080, () => console.log("Proxy on http://localhost:8080"));
