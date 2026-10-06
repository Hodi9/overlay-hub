import express from "express";
import { createSubathonApp } from "./subathon/app.js";
const app = express(); app.use("/x", createSubathonApp()); app.listen(3994);
