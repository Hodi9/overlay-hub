import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import brovsbroModule from "./apps/brovsbro/app.cjs";
import { createMinecraftApp } from "./apps/minecraft/app.js";
import { createGearApp } from "./apps/gear/app.js";
import { createGearBfApp } from "./apps/gear-bf/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createBrovsbroApp } = brovsbroModule;

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);

app.get("/health", (_req, res) => res.json({ ok: true }));

const { router: brovsbroRouter, attachSocket } = createBrovsbroApp();
app.use("/brovsbro", brovsbroRouter);
attachSocket(server);

app.use("/minecraft", createMinecraftApp());
app.use("/gear", createGearApp());
app.use("/gear-bf", createGearBfApp());

app.use(express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`overlay-hub listening on ${port}`);
});
