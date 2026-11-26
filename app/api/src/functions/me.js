import { app } from "@azure/functions";
import { validateToken } from "../auth.js";

app.http("me", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "me",
  handler: async (req) => {
    const claims = await validateToken(req);
    if (!claims) {
      return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    return {
      status: 200,
      body: JSON.stringify({ oid: claims.oid, name: claims.name }),
    };
  },
});
