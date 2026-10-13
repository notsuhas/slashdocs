import { expect, it } from "vitest";
import { APIError } from "@/api";
import { adminAccessError } from "./admin-access";
it("recognizes expired and revoked access without treating outages as revocation", () => {
  for (const status of [401, 403])
    expect(adminAccessError(new APIError(status, "denied", "Denied"))?.status).toBe(
      status,
    );
  for (const error of [
    new APIError(500, "internal", "Outage"),
    new Error("offline"),
    null,
  ])
    expect(adminAccessError(error)).toBeUndefined();
});
