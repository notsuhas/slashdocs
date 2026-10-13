import { APIError } from "@/api";
export function adminAccessError(error: unknown): APIError | undefined {
  if (error instanceof APIError && (error.status === 401 || error.status === 403))
    return error;
  return undefined;
}
