import express from "express";
import { validateToken } from "./auth.js";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/me", async (req, res) => {
  const claims = await validateToken(req);
  if (!claims) return res.status(401).json({ error: "Unauthorized" });
  res.json({ oid: claims.oid, name: claims.name });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API listening on ${port}`));
