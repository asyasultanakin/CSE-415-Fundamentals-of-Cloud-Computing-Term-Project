import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

export async function handler(event) {
  for (const record of event.Records) {
    // Key format: uploads/{userId}/{photoId}
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const parts = key.split("/");
    if (parts.length !== 3 || parts[0] !== "uploads") {
      console.log("Skipping unexpected key:", key);
      continue;
    }
    const [, userId, photoId] = parts;
    const sizeBytes = record.s3.object.size;

    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { userId, photoId },
      UpdateExpression: "SET #s = :s, sizeBytes = :b, processedAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "PROCESSED",
        ":b": sizeBytes,
        ":t": new Date().toISOString(),
      },
    }));

    console.log(`Marked ${userId}/${photoId} as PROCESSED (${sizeBytes} bytes)`);
  }
}
