import express from "express";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateToken } from "./auth.js";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const BUCKET = process.env.BUCKET_NAME;
const TABLE  = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION ?? "eu-north-1";

const s3  = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/me", async (req, res) => {
  const claims = await validateToken(req);
  if (!claims) return res.status(401).json({ error: "Unauthorized" });
  res.json({ oid: claims.oid, name: claims.name });
});

app.post("/api/photos/upload-url", async (req, res) => {
  const claims = await validateToken(req);
  if (!claims) return res.status(401).json({ error: "Unauthorized" });

  const { contentType, size } = req.body ?? {};
  if (!ALLOWED_TYPES.includes(contentType)) {
    return res.status(400).json({ error: "Unsupported file type" });
  }
  if (!size || size > MAX_BYTES) {
    return res.status(400).json({ error: "File too large (max 10 MB)" });
  }

  const userId  = claims.oid;
  const photoId = randomUUID();
  const s3Key   = `uploads/${userId}/${photoId}`;

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      userId,
      photoId,
      status:    "PENDING",
      s3Key,
      createdAt: new Date().toISOString(),
    },
  }));

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: contentType }),
    { expiresIn: 300 }
  );

  res.json({ uploadUrl, photoId });
});

app.get("/api/photos", async (req, res) => {
  const claims = await validateToken(req);
  if (!claims) return res.status(401).json({ error: "Unauthorized" });

  const userId = claims.oid;

  const result = await ddb.send(new QueryCommand({
    TableName:                TABLE,
    KeyConditionExpression:   "userId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
    ScanIndexForward:         false,
  }));

  const photos = await Promise.all((result.Items ?? []).map(async (item) => {
    const viewUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: item.s3Key }),
      { expiresIn: 3600 }
    );
    return { ...item, viewUrl };
  }));

  res.json({ photos });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API listening on ${port}`));
