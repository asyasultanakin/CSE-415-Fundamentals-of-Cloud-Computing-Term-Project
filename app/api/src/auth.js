import { createRemoteJWKSet, jwtVerify } from "jose";

const TENANT_ID = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;

const JWKS = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`)
);

export async function validateToken(req) {
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      audience: `api://${CLIENT_ID}`,
    });

    const scopes = (payload.scp ?? "").split(" ");
    if (!scopes.includes("access_as_user")) return null;

    return payload;
  } catch {
    return null;
  }
}
