import { importJWK, SignJWT, jwtVerify } from "jose";
import { z } from "zod";
const jwkSchema = z
  .object({
    kty: z.string(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
    d: z.string().optional(),
  })
  .passthrough();
const capabilitySchema = z.object({
  aud: z.enum(["render", "print"]),
  document_id: z.string().regex(/^doc_[a-z2-7]+$/),
  version_id: z.string().regex(/^ver_[a-z2-7]+$/),
  object_key: z.string().min(1),
  exp: z.number().int(),
  access_revision: z.number().int().optional(),
});
export type RenderCapability = z.infer<typeof capabilitySchema>;
export async function signRenderCapability(
  privateKey: string,
  capability: RenderCapability,
): Promise<string> {
  const key = await importJWK(jwkSchema.parse(JSON.parse(privateKey)), "EdDSA");
  return new SignJWT(capability)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .sign(key);
}
export async function verifyRenderCapability(
  publicKey: string,
  token: string,
  audience: "render" | "print",
): Promise<RenderCapability> {
  const key = await importJWK(jwkSchema.parse(JSON.parse(publicKey)), "EdDSA");
  const { payload } = await jwtVerify(token, key, { algorithms: ["EdDSA"], audience });
  return capabilitySchema.parse(payload);
}
