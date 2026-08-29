import express from "express";
import http from "node:http";
import brovsbroModule from "./apps/brovsbro/app.cjs";
import { createMinecraftApp } from "./apps/minecraft/app.js";

const { createBrovsbroApp } = brovsbroModule;

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);

app.get("/health", (_req, res) => res.json({ ok: true }));

const { router: brovsbroRouter, attachSocket } = createBrovsbroApp();
app.use("/brovsbro", brovsbroRouter);
attachSocket(server);

app.use("/minecraft", createMinecraftApp());

app.get("/", (_req, res) => {
  res.type("text/plain").send("overlay-hub is running. See /brovsbro, /minecraft.");
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`overlay-hub listening on ${port}`);
});
